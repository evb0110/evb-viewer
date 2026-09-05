import type { PDFDocument } from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import {
    getPdfDictContents,
    getPdfDictSubtype,
    getPdfStringValue,
} from '@app/utils/pdfDict';
import {
    normalizeAnnotationSubtypeToken,
    normalizeComparableText,
} from '@app/utils/textNormalization';
import {
    readPdfRectFromDict,
    tryResolvePdfLibPageView,
} from '@pdf-core';
import { parsePdfAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { getPdfPopupDict } from '@app/modules/pdf-viewer/annotations/pdf-refs/getPdfPopupDict';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';

function toPdfLibRef(ref: ReturnType<typeof parsePdfAnnotationRef>) {
    return ref ? PDFRef.of(ref.objectNumber, ref.generationNumber) : null;
}

function getPdfDictAuthor(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('T')));
}

function parseAnnotationRefFromStableKey(stableKey: string | null | undefined) {
    return toPdfLibRef(parsePdfAnnotationStableKeyRef(stableKey)?.ref ?? null);
}

function isNoteLikeAnnotationSubtype(
    subtype: string | null | undefined,
) {
    const normalized = normalizeAnnotationSubtypeToken(subtype);
    return (
        normalized === 'text'
        || normalized === 'freetext'
        || normalized === 'typewriter'
        || normalized === 'note'
    );
}

function resolveCommentPdfRef(comment: IAnnotationCommentSummary) {
    return (
        toPdfLibRef(parsePdfAnnotationRef(comment.annotationId ?? comment.id))
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
    );
}

function findCommentRefByGeneratedId(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const generated = comment.id.match(/^pdf-(\d+)-(\d+)$/);
    if (!generated) {
        return null;
    }
    const pageNumber = Number(generated[1]);
    const annotationIndex = Number(generated[2]);
    if (!Number.isInteger(pageNumber) || !Number.isInteger(annotationIndex)) {
        return null;
    }
    if (pageNumber !== comment.pageNumber || annotationIndex < 0) {
        return null;
    }
    if (pageNumber < 1 || pageNumber > doc.getPageCount()) {
        return null;
    }

    const pageIndex = pageNumber - 1;
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annotationIndex >= annots.size()) {
        return null;
    }
    const value = annots.get(annotationIndex);
    return value instanceof PDFRef ? value : null;
}

function refsEqualByTag(left: PDFRef | null, right: PDFRef | null) {
    if (!left || !right) {
        return false;
    }
    return left.toString() === right.toString();
}

function getAnnotationRelatedRef(dict: PDFDict, key: 'Parent' | 'Popup') {
    const value = dict.get(PDFName.of(key));
    return value instanceof PDFRef ? value : null;
}

function annotationHasRelatedRef(
    dict: PDFDict,
    ref: PDFRef | null,
) {
    return refsEqualByTag(getAnnotationRelatedRef(dict, 'Parent'), ref)
        || refsEqualByTag(getAnnotationRelatedRef(dict, 'Popup'), ref);
}

function canResolveExplicitRefOnPage(
    doc: PDFDocument,
    page: ReturnType<PDFDocument['getPages']>[number],
    explicitRef: PDFRef,
) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) {
        return false;
    }

    const explicitTag = explicitRef.toString();
    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (value instanceof PDFRef && value.toString() === explicitTag) {
            return true;
        }
    }

    const explicitDict = doc.context.lookupMaybe(explicitRef, PDFDict);
    if (!explicitDict) {
        return false;
    }

    const explicitParent = getAnnotationRelatedRef(explicitDict, 'Parent');
    const explicitPopup = getAnnotationRelatedRef(explicitDict, 'Popup');

    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (!(value instanceof PDFRef)) {
            continue;
        }
        if (refsEqualByTag(value, explicitParent) || refsEqualByTag(value, explicitPopup)) {
            return true;
        }

        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (!dict) {
            continue;
        }

        if (annotationHasRelatedRef(dict, explicitRef)) {
            return true;
        }
    }

    return false;
}

type TPdfPage = ReturnType<PDFDocument['getPages']>[number];

interface IAnnotationCandidate {
    ref: PDFRef;
    dict: PDFDict;
    subtype: string;
}

interface ICommentMatchTarget {
    subtype: string;
    text: string;
    author: string;
    rect: {
        left: number;
        top: number;
        width: number;
        height: number;
    } | null;
    pageView: number[];
    pageRotation: ReturnType<typeof normalizePageRotation>;
}

interface IScoredMatch {
    ref: PDFRef;
    score: number;
}

interface IScoringResult {
    bestMatch: IScoredMatch | null;
    secondBestScore: number;
    noteLikeRefs: PDFRef[];
}

function collectPageAnnotationCandidates(doc: PDFDocument, annots: PDFArray): IAnnotationCandidate[] {
    const candidates: IAnnotationCandidate[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (!(value instanceof PDFRef)) {
            continue;
        }
        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (!dict) {
            continue;
        }
        const subtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(dict));
        if (subtype === 'popup') {
            continue;
        }
        candidates.push({
            ref: value,
            dict,
            subtype,
        });
    }
    return candidates;
}

function buildCommentMatchTarget(comment: IAnnotationCommentSummary, page: TPdfPage): ICommentMatchTarget | null {
    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        return null;
    }
    return {
        subtype: normalizeAnnotationSubtypeToken(comment.subtype),
        text: normalizeComparableText(comment.text),
        author: normalizeComparableText(comment.author),
        rect: comment.markerRect
            ? {
                left: clamp(comment.markerRect.left, 0, 1),
                top: clamp(comment.markerRect.top, 0, 1),
                width: clamp(comment.markerRect.width, 0, 1),
                height: clamp(comment.markerRect.height, 0, 1),
            }
            : null,
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
    };
}

function scoreSubtypeMatch(commentSubtype: string, candidateSubtype: string) {
    if (!commentSubtype) {
        return 0;
    }
    if (commentSubtype === candidateSubtype) {
        return 5;
    }
    if (
        (commentSubtype === 'text' && candidateSubtype === 'freetext')
        || (commentSubtype === 'freetext' && candidateSubtype === 'text')
    ) {
        return 2;
    }
    return -1.5;
}

function scoreTextMatch(commentText: string, candidateText: string) {
    if (commentText) {
        if (candidateText === commentText) {
            return 6;
        }
        if (
            candidateText.length > 0
            && (candidateText.includes(commentText) || commentText.includes(candidateText))
        ) {
            return 3;
        }
        return -1;
    }
    if (!candidateText) {
        return 0.5;
    }
    return 0;
}

function scoreGeometryMatch(
    commentRect: ICommentMatchTarget['rect'],
    candidateRect: ReturnType<typeof toMarkerRectFromPdfRect>,
) {
    const rectIoU = markerRectIoU(commentRect, candidateRect);
    if (rectIoU > 0) {
        return rectIoU * 8;
    }
    if (commentRect) {
        return -0.2;
    }
    return 0;
}

function scoreCandidateAgainstTarget(
    doc: PDFDocument,
    candidate: IAnnotationCandidate,
    target: ICommentMatchTarget,
) {
    const popupDict = getPdfPopupDict(doc, candidate.dict);
    const candidateText = normalizeComparableText(
        getPdfDictContents(candidate.dict) || getPdfDictContents(popupDict),
    );
    const candidateAuthor = normalizeComparableText(
        getPdfDictAuthor(candidate.dict) || getPdfDictAuthor(popupDict),
    );
    const candidateRect = toMarkerRectFromPdfRect(
        readPdfRectFromDict(candidate.dict),
        target.pageView,
        target.pageRotation,
    );

    let score = scoreSubtypeMatch(target.subtype, candidate.subtype);
    score += scoreTextMatch(target.text, candidateText);
    if (target.author && candidateAuthor && target.author === candidateAuthor) {
        score += 1;
    }
    score += scoreGeometryMatch(target.rect, candidateRect);
    return score;
}

function selectScoredAnnotationMatch(
    doc: PDFDocument,
    candidates: IAnnotationCandidate[],
    target: ICommentMatchTarget,
): IScoringResult {
    let bestMatch: IScoredMatch | null = null;
    let secondBestScore = Number.NEGATIVE_INFINITY;
    const noteLikeRefs: PDFRef[] = [];

    for (const candidate of candidates) {
        if (isNoteLikeAnnotationSubtype(candidate.subtype)) {
            noteLikeRefs.push(candidate.ref);
        }

        const score = scoreCandidateAgainstTarget(doc, candidate, target);

        if (!bestMatch || score > bestMatch.score) {
            if (bestMatch) {
                secondBestScore = Math.max(secondBestScore, bestMatch.score);
            }
            bestMatch = {
                ref: candidate.ref,
                score,
            };
            continue;
        }
        secondBestScore = Math.max(secondBestScore, score);
    }

    return {
        bestMatch,
        secondBestScore,
        noteLikeRefs,
    };
}

function selectFinalRefFromScoredMatch(
    comment: IAnnotationCommentSummary,
    scoring: IScoringResult,
) {
    const {
        bestMatch,
        secondBestScore,
        noteLikeRefs,
    } = scoring;

    if (bestMatch && bestMatch.score >= 2) {
        return bestMatch.ref;
    }

    const isEditorWithoutExplicitRef = comment.source === 'editor' && !comment.annotationId;
    if (!isEditorWithoutExplicitRef) {
        return null;
    }

    if (noteLikeRefs.length === 1) {
        return noteLikeRefs[0] ?? null;
    }

    if (
        bestMatch
        && bestMatch.score >= 0.5
        && (
            secondBestScore === Number.NEGATIVE_INFINITY
            || (bestMatch.score - secondBestScore) >= 1.5
        )
    ) {
        return bestMatch.ref;
    }

    return null;
}

export function resolveCommentPdfRefInDocument(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const pageIndex = clamp(comment.pageIndex, 0, doc.getPageCount() - 1);
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }

    const explicitRef = resolveCommentPdfRef(comment);
    if (explicitRef && canResolveExplicitRefOnPage(doc, page, explicitRef)) {
        return explicitRef;
    }

    const byGeneratedId = findCommentRefByGeneratedId(doc, comment);
    if (byGeneratedId) {
        return byGeneratedId;
    }

    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annots.size() === 0) {
        return null;
    }

    const target = buildCommentMatchTarget(comment, page);
    if (!target) {
        return null;
    }

    const candidates = collectPageAnnotationCandidates(doc, annots);
    const scoring = selectScoredAnnotationMatch(doc, candidates, target);
    return selectFinalRefFromScoredMatch(comment, scoring);
}
