import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    normalizeMarkerRect,
    markerRectIoU,
    isTextMarkupSubtype,
} from '@app/composables/pdf/pdfAnnotationUtils';

export function computeSummaryStableKey(params: {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
}) {
    if (params.annotationId) {
        return `ann:${params.pageIndex}:${params.annotationId}`;
    }
    if (params.uid) {
        return `uid:${params.pageIndex}:${params.uid}`;
    }
    return `src:${params.source}:${params.pageIndex}:${params.id}`;
}

export function toCanonicalStableKey(summary: Pick<IAnnotationCommentSummary, 'id' | 'pageIndex' | 'source' | 'uid' | 'annotationId'>) {
    return computeSummaryStableKey({
        id: summary.id,
        pageIndex: summary.pageIndex,
        source: summary.source,
        uid: summary.uid,
        annotationId: summary.annotationId,
    });
}

export function normalizeSummaryStableKey(summary: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}

export function compareAnnotationComments(a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) {
    if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex;
    }

    const sortIndexA = typeof a.sortIndex === 'number' ? a.sortIndex : null;
    const sortIndexB = typeof b.sortIndex === 'number' ? b.sortIndex : null;
    if (sortIndexA !== null && sortIndexB !== null && sortIndexA !== sortIndexB) {
        return sortIndexA - sortIndexB;
    }
    if (sortIndexA !== null && sortIndexB === null) {
        return -1;
    }
    if (sortIndexA === null && sortIndexB !== null) {
        return 1;
    }

    const aTime = a.modifiedAt ?? 0;
    const bTime = b.modifiedAt ?? 0;
    if (aTime !== bTime) {
        return bTime - aTime;
    }
    return a.stableKey.localeCompare(b.stableKey);
}

export function areTextMarkupCommentsLikelySame(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (!isTextMarkupSubtype(left.subtype) || !isTextMarkupSubtype(right.subtype)) {
        return false;
    }

    const iou = markerRectIoU(left.markerRect, right.markerRect);
    if (iou >= 0.46) {
        return true;
    }

    const leftRect = normalizeMarkerRect(left.markerRect);
    const rightRect = normalizeMarkerRect(right.markerRect);
    if (!leftRect || !rightRect) {
        return false;
    }

    const leftCenterX = leftRect.left + leftRect.width / 2;
    const leftCenterY = leftRect.top + leftRect.height / 2;
    const rightCenterX = rightRect.left + rightRect.width / 2;
    const rightCenterY = rightRect.top + rightRect.height / 2;
    const dx = leftCenterX - rightCenterX;
    const dy = leftCenterY - rightCenterY;
    const centerDistance = Math.hypot(dx, dy);

    const leftArea = leftRect.width * leftRect.height;
    const rightArea = rightRect.width * rightRect.height;
    const largerArea = Math.max(leftArea, rightArea);
    const smallerArea = Math.max(1e-6, Math.min(leftArea, rightArea));
    const areaRatio = largerArea / smallerArea;

    return centerDistance <= 0.045 && areaRatio <= 2.8;
}

export function commentsAreSameLogicalAnnotation(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid;
    }

    if (left.annotationId && right.annotationId === null) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (right.annotationId && left.annotationId === null) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (left.uid && !right.uid) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    if (right.uid && !left.uid) {
        const rightHasText = right.text.trim().length > 0;
        const leftHasText = left.text.trim().length > 0;
        const textCompatible = !leftHasText || !rightHasText || left.text.trim() === right.text.trim();
        return textCompatible && areTextMarkupCommentsLikelySame(left, right);
    }

    return (
        left.id === right.id
        && left.source === right.source
    ) || areTextMarkupCommentsLikelySame(left, right);
}

export function commentMergePriority(comment: IAnnotationCommentSummary) {
    let score = 0;
    if (comment.annotationId) {
        score += 110;
    }
    if (comment.uid) {
        score += 55;
    }
    if (comment.source === 'editor') {
        score += 22;
    }
    if (comment.text.trim()) {
        score += 12;
    }
    if (comment.hasNote) {
        score += 8;
    }
    if (comment.modifiedAt) {
        score += 5;
    }
    if (comment.markerRect) {
        score += 3;
    }
    return score;
}

export function mergeCommentSummaries(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const existingText = existing.text.trim();
    const text = existingText.length > 0
        ? existing.text
        : incoming.text;

    const author = existing.author?.trim()
        ? existing.author
        : incoming.author;

    const kindLabel = (() => {
        if (existing.kindLabel?.trim() && existing.subtype !== 'Highlight') {
            return existing.kindLabel;
        }
        if (incoming.kindLabel?.trim() && incoming.subtype !== 'Highlight') {
            return incoming.kindLabel;
        }
        return existing.kindLabel?.trim()
            ? existing.kindLabel
            : incoming.kindLabel;
    })();

    const modifiedAt = (() => {
        const existingTs = existing.modifiedAt ?? null;
        const incomingTs = incoming.modifiedAt ?? null;
        if (existingTs && incomingTs) {
            return Math.max(existingTs, incomingTs);
        }
        return existingTs ?? incomingTs;
    })();

    const source = existing.source === 'editor'
        ? 'editor'
        : incoming.source;
    const existingSortIndex = typeof existing.sortIndex === 'number' ? existing.sortIndex : null;
    const incomingSortIndex = typeof incoming.sortIndex === 'number' ? incoming.sortIndex : null;
    const sortIndex = (
        existingSortIndex !== null && incomingSortIndex !== null
            ? Math.min(existingSortIndex, incomingSortIndex)
            : (existingSortIndex ?? incomingSortIndex)
    );
    const hasNote = Boolean(existing.hasNote || incoming.hasNote);
    const subtype = (() => {
        const existingSubtype = existing.subtype ?? null;
        const incomingSubtype = incoming.subtype ?? null;
        if (existingSubtype && existingSubtype !== 'Highlight') {
            return existingSubtype;
        }
        if (incomingSubtype && incomingSubtype !== 'Highlight') {
            return incomingSubtype;
        }
        return existingSubtype ?? incomingSubtype;
    })();

    return {
        ...existing,
        text,
        author,
        kindLabel,
        modifiedAt,
        sortIndex,
        annotationId: existing.annotationId ?? incoming.annotationId,
        uid: existing.uid ?? incoming.uid,
        subtype,
        color: existing.color ?? incoming.color,
        source,
        hasNote,
        markerRect: existing.markerRect ?? incoming.markerRect ?? null,
    };
}

export function mergeDuplicateCommentSummary(
    primary: IAnnotationCommentSummary,
    secondary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const merged = mergeCommentSummaries(primary, secondary);
    const annotationId = primary.annotationId ?? secondary.annotationId ?? null;
    const uid = primary.uid ?? secondary.uid ?? null;
    const markerRect = normalizeMarkerRect(primary.markerRect)
        ?? normalizeMarkerRect(secondary.markerRect)
        ?? null;
    const source: IAnnotationCommentSummary['source'] = (
        primary.source === 'editor' || secondary.source === 'editor'
            ? 'editor'
            : 'pdf'
    );
    const primarySortIndex = typeof primary.sortIndex === 'number' ? primary.sortIndex : null;
    const secondarySortIndex = typeof secondary.sortIndex === 'number' ? secondary.sortIndex : null;
    const sortIndex = (
        primarySortIndex !== null && secondarySortIndex !== null
            ? Math.min(primarySortIndex, secondarySortIndex)
            : (primarySortIndex ?? secondarySortIndex)
    );

    const id = annotationId
        ? (
            primary.annotationId
                ? primary.id
                : secondary.id
        )
        : (
            uid
                ? (primary.uid ? primary.id : secondary.id)
                : merged.id
        );

    const normalized: IAnnotationCommentSummary = {
        ...merged,
        id,
        sortIndex,
        annotationId,
        uid,
        source,
        markerRect,
    };
    return normalizeSummaryStableKey(normalized);
}

export function dedupeAnnotationCommentSummaries(comments: IAnnotationCommentSummary[]) {
    const sorted = comments
        .map(comment => normalizeSummaryStableKey(comment))
        .sort((left, right) => {
            const priorityDelta = commentMergePriority(right) - commentMergePriority(left);
            if (priorityDelta !== 0) {
                return priorityDelta;
            }
            const leftTs = left.modifiedAt ?? 0;
            const rightTs = right.modifiedAt ?? 0;
            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }
            return left.stableKey.localeCompare(right.stableKey);
        });

    const merged: IAnnotationCommentSummary[] = [];
    for (const candidate of sorted) {
        const existingIndex = merged.findIndex(existing => commentsAreSameLogicalAnnotation(existing, candidate));
        if (existingIndex === -1) {
            merged.push(candidate);
            continue;
        }
        const primary = merged[existingIndex];
        if (!primary) {
            merged.push(candidate);
            continue;
        }
        merged[existingIndex] = mergeDuplicateCommentSummary(primary, candidate);
    }

    return merged.sort(compareAnnotationComments);
}

export function commentsMatchForEditorLookup(
    left: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
    right: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
) {
    if (left.stableKey && right.stableKey && left.stableKey === right.stableKey) {
        return true;
    }
    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId && left.pageIndex === right.pageIndex;
    }
    if (left.uid && right.uid) {
        return left.uid === right.uid && left.pageIndex === right.pageIndex;
    }
    return (
        left.id === right.id
        && left.pageIndex === right.pageIndex
        && left.source === right.source
    );
}

export function getSummaryMemoryKeys(summary: Pick<IAnnotationCommentSummary, 'stableKey' | 'pageIndex' | 'annotationId' | 'uid' | 'id'>) {
    const keys = new Set<string>();
    if (summary.stableKey) {
        keys.add(`stable:${summary.stableKey}`);
    }
    if (summary.annotationId) {
        keys.add(`ann:${summary.pageIndex}:${summary.annotationId}`);
        keys.add(`ann:any:${summary.annotationId}`);
    }
    if (summary.uid) {
        keys.add(`uid:${summary.pageIndex}:${summary.uid}`);
        keys.add(`uid:any:${summary.uid}`);
    }
    if (summary.id) {
        keys.add(`id:${summary.pageIndex}:${summary.id}`);
        keys.add(`id:any:${summary.id}`);
    }
    return Array.from(keys);
}
