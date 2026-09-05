import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
} from '@app/types/annotations';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';
import {
    asAnnotationId,
    deriveAnnotationId,
    type AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export interface IComputeSummaryStableKeyParams {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
    annotationName?: string | null;
}

type TAnnotationCommentMatchInput = Pick<
    IAnnotationCommentSummary,
    'appAnnotationId' | 'stableKey' | 'annotationName' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'
>;

export function computeSummaryStableKey(params: IComputeSummaryStableKeyParams): TAnnotationStableKey {
    const annotationName = params.annotationName?.trim();
    if (annotationName) {
        return `nm:${annotationName}`;
    }
    // The canonical identity has one external binding. Keep summary keys in
    // the same two-arm shape even while PDF.js still exposes its legacy ids.
    const annotationId = params.annotationId?.trim();
    const uid = params.uid?.trim();
    const externalId = annotationId?.length
        ? annotationId
        : uid?.length
            ? uid
            : `${params.source}:${params.id}`;
    return `ann:${params.pageIndex}:${externalId}`;
}

/** Canonical command/UI identity. Stable keys remain serializer/DOM bindings. */
export function annotationIdForSummary(summary: TAnnotationCommentMatchInput): AnnotationId {
    if (summary.appAnnotationId) {
        return asAnnotationId(summary.appAnnotationId);
    }
    const explicitExternalIdentity = summary.annotationName
        ?? summary.annotationId
        ?? summary.uid
        ?? summary.id;
    return deriveAnnotationId(
        'legacy-annotation-summary-binding',
        `${summary.source}:${summary.pageIndex}:${explicitExternalIdentity}`,
    );
}

function toCanonicalStableKey(
    summary: Pick<IAnnotationCommentSummary, 'id' | 'pageIndex' | 'source' | 'uid' | 'annotationId' | 'annotationName'>,
) {
    return computeSummaryStableKey({
        id: summary.id,
        pageIndex: summary.pageIndex,
        source: summary.source,
        ...(summary.uid !== undefined ? {uid: summary.uid} : {}),
        ...(summary.annotationId !== undefined ? {annotationId: summary.annotationId} : {}),
        ...(summary.annotationName !== undefined ? {annotationName: summary.annotationName} : {}),
    });
}

function normalizeSummaryStableKey(summary: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}

function normalizedPdfRef(value: string | null | undefined) {
    return normalizePdfJsAnnotationId(value) ?? null;
}

export function annotationCommentsMatch(left: TAnnotationCommentMatchInput, right: TAnnotationCommentMatchInput) {
    if (left.appAnnotationId || right.appAnnotationId) {
        return Boolean(left.appAnnotationId && left.appAnnotationId === right.appAnnotationId);
    }
    if (left.annotationName && right.annotationName) {
        return left.annotationName === right.annotationName;
    }
    if (left.annotationId || right.annotationId) {
        return Boolean(
            normalizedPdfRef(left.annotationId)
            && normalizedPdfRef(left.annotationId) === normalizedPdfRef(right.annotationId)
            && left.pageIndex === right.pageIndex,
        );
    }
    if (left.uid || right.uid) {
        return Boolean(left.uid && left.uid === right.uid && left.pageIndex === right.pageIndex);
    }
    return left.id === right.id && left.pageIndex === right.pageIndex && left.source === right.source;
}

function commentMergePriority(comment: IAnnotationCommentSummary) {
    if (comment.appAnnotationId) {
        return 5;
    }
    if (comment.annotationName) {
        return 4;
    }
    if (comment.annotationId) {
        return 3;
    }
    if (comment.uid) {
        return 2;
    }
    return 1;
}

function selectPreferredAnnotationComment(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    const identityDelta = commentMergePriority(left) - commentMergePriority(right);
    if (identityDelta !== 0) {
        return identityDelta > 0 ? left : right;
    }
    const revisionDelta = (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0);
    if (revisionDelta !== 0) {
        return revisionDelta > 0 ? left : right;
    }
    if (left.text.trim().length !== right.text.trim().length) {
        return left.text.trim().length > right.text.trim().length ? left : right;
    }
    return left;
}

function mergeCommentSummaries(existing: IAnnotationCommentSummary, incoming: IAnnotationCommentSummary) {
    if (!annotationCommentsMatch(existing, incoming)) {
        throw new Error('Cannot merge annotation summaries without an exact identity binding');
    }
    const preferred = selectPreferredAnnotationComment(existing, incoming);
    const fallback = preferred === existing ? incoming : existing;
    const appAnnotationId = preferred.appAnnotationId ?? fallback.appAnnotationId;
    const annotationName = preferred.annotationName ?? fallback.annotationName;
    const displayText = preferred.displayText ?? fallback.displayText;
    const previewText = preferred.previewText ?? fallback.previewText;
    const kindLabel = preferred.kindLabel ?? fallback.kindLabel;
    const createdAt = preferred.createdAt ?? fallback.createdAt;
    const markerRect = preferred.markerRect ?? fallback.markerRect;
    const merged: IAnnotationCommentSummary = {
        ...fallback,
        ...preferred,
        annotationId: preferred.annotationId ?? fallback.annotationId,
        uid: preferred.uid ?? fallback.uid,
        text: preferred.text.trim() ? preferred.text : fallback.text,
        author: preferred.author ?? fallback.author,
        modifiedAt: Math.max(preferred.modifiedAt ?? 0, fallback.modifiedAt ?? 0) || null,
        color: preferred.color ?? fallback.color,
        hasNote: preferred.hasNote === true || fallback.hasNote === true,
        ...(appAnnotationId ? {appAnnotationId} : {}),
        ...(annotationName !== undefined ? {annotationName} : {}),
        ...(displayText !== undefined ? {displayText} : {}),
        ...(previewText !== undefined ? {previewText} : {}),
        ...(kindLabel !== undefined ? {kindLabel} : {}),
        ...(createdAt !== undefined ? {createdAt} : {}),
        ...(markerRect !== undefined ? {markerRect} : {}),
    };
    return normalizeSummaryStableKey(merged);
}

export function dedupeAnnotationCommentSummaries(comments: IAnnotationCommentSummary[]) {
    const merged: IAnnotationCommentSummary[] = [];
    for (const comment of comments.map(normalizeSummaryStableKey)) {
        const index = merged.findIndex(candidate => annotationCommentsMatch(candidate, comment));
        if (index === -1) merged.push(comment);
        else merged[index] = mergeCommentSummaries(merged[index]!, comment);
    }
    return merged.sort(compareAnnotationCommentSummaries);
}
