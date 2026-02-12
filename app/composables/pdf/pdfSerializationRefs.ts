import type {PDFDocument} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectIoU } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getPdfStringValue,
    getPdfDictSubtype,
    getPdfDictContents,
    normalizeMarkerRectFromDict,
} from '@app/utils/pdf-dict';
import {
    normalizeAnnotationSubtypeToken,
    normalizeComparableText,
} from '@app/utils/text-normalization';

function getPdfDictAuthor(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('T')));
}

export function getPdfPopupDict(doc: PDFDocument, dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const popupValue = dict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFDict) {
        return popupValue;
    }
    if (popupValue instanceof PDFRef) {
        return doc.context.lookupMaybe(popupValue, PDFDict) ?? null;
    }
    return null;
}

export function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(/^(\d+)R(?:(\d+))?$/i);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isInteger(generationNumber)
        || generationNumber < 0
    ) {
        return null;
    }

    return PDFRef.of(objectNumber, generationNumber);
}

function parseAnnotationRefFromStableKey(stableKey: string | null | undefined) {
    if (!stableKey) {
        return null;
    }
    const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/i);
    if (!match?.[1]) {
        return null;
    }
    return parsePdfJsAnnotationRef(match[1]);
}

function resolveCommentPdfRef(comment: IAnnotationCommentSummary) {
    return (
        parsePdfJsAnnotationRef(comment.annotationId ?? comment.id)
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

    const pageIndex = Math.max(0, Math.min(pageNumber - 1, doc.getPageCount() - 1));
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

export function resolveCommentPdfRefInDocument(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const explicitRef = resolveCommentPdfRef(comment);
    if (explicitRef) {
        return explicitRef;
    }

    const byGeneratedId = findCommentRefByGeneratedId(doc, comment);
    if (byGeneratedId) {
        return byGeneratedId;
    }

    const pageIndex = Math.max(0, Math.min(comment.pageIndex, doc.getPageCount() - 1));
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }

    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annots.size() === 0) {
        return null;
    }

    const pageSize = page.getSize();
    const pageWidth = pageSize.width;
    const pageHeight = pageSize.height;
    const commentSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
    const commentText = normalizeComparableText(comment.text);
    const commentAuthor = normalizeComparableText(comment.author);
    const commentRect = comment.markerRect
        ? {
            left: Math.max(0, Math.min(1, comment.markerRect.left)),
            top: Math.max(0, Math.min(1, comment.markerRect.top)),
            width: Math.max(0, Math.min(1, comment.markerRect.width)),
            height: Math.max(0, Math.min(1, comment.markerRect.height)),
        }
        : null;

    let bestMatch: {
        ref: PDFRef;
        score: number;
    } | null = null;

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

        const popupDict = getPdfPopupDict(doc, dict);
        const candidateText = normalizeComparableText(
            getPdfDictContents(dict) || getPdfDictContents(popupDict),
        );
        const candidateAuthor = normalizeComparableText(
            getPdfDictAuthor(dict) || getPdfDictAuthor(popupDict),
        );
        const candidateRect = normalizeMarkerRectFromDict(dict, pageWidth, pageHeight);

        let score = 0;
        if (commentSubtype) {
            if (commentSubtype === subtype) {
                score += 5;
            } else if (
                (commentSubtype === 'text' && subtype === 'freetext')
                || (commentSubtype === 'freetext' && subtype === 'text')
            ) {
                score += 2;
            } else {
                score -= 1.5;
            }
        }

        if (commentText) {
            if (candidateText === commentText) {
                score += 6;
            } else if (
                candidateText.length > 0
                && (candidateText.includes(commentText) || commentText.includes(candidateText))
            ) {
                score += 3;
            } else {
                score -= 1;
            }
        } else if (!candidateText) {
            score += 0.5;
        }

        if (commentAuthor && candidateAuthor && commentAuthor === candidateAuthor) {
            score += 1;
        }

        const rectIoU = markerRectIoU(commentRect, candidateRect);
        if (rectIoU > 0) {
            score += rectIoU * 8;
        } else if (commentRect) {
            score -= 0.2;
        }

        if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
                ref: value,
                score,
            };
        }
    }

    return bestMatch && bestMatch.score >= 2 ? bestMatch.ref : null;
}
