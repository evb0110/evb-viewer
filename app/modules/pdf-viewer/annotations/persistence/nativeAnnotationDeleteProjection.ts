import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { parsePdfAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';
import type { IPdfNativeAnnotationDelete } from '@contracts/electronApiDocuments';
import { parsePageIndex } from '@contracts/pageNumbers';
import { isReplayableEditorOnlyFreeTextNote } from '@app/modules/pdf-viewer/annotations/persistence/nativeFreeTextNoteProjection';
import type { INativePdfMutationBuildResult } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

function parseAnnotationRefFromStableKey(stableKey: string) {
    return parsePdfAnnotationStableKeyRef(stableKey)?.ref ?? null;
}

function resolveNativeAnnotationDeleteRef(comment: IAnnotationCommentSummary) {
    return parseAnnotationRefFromStableKey(comment.stableKey)
        ?? parsePdfAnnotationRef(comment.annotationId)
        ?? parsePdfAnnotationRef(comment.uid)
        ?? parsePdfAnnotationRef(comment.id);
}

export function getNativeAnnotationDeleteCommentTargetKey(
    comment: IAnnotationCommentSummary,
) {
    const pageIndex = parsePageIndex(comment.pageIndex);
    if (pageIndex === null) {
        return null;
    }
    const targetRef = resolveNativeAnnotationDeleteRef(comment);
    if (targetRef && targetRef.generationNumber <= 65_535) {
        return `ref:${pageIndex}:${targetRef.objectNumber}:${targetRef.generationNumber}`;
    }
    const stableKey = comment.stableKey?.trim();
    if (stableKey && isReplayableEditorOnlyFreeTextNote(comment)) {
        return `stable:${pageIndex}:${stableKey}`;
    }
    return null;
}

export function getNativeAnnotationDeleteRequestTargetKey(
    request: IPdfNativeAnnotationDelete,
) {
    if (
        request.objectNumber !== undefined
        && request.generationNumber !== undefined
    ) {
        return `ref:${request.pageIndex}:${request.objectNumber}:${request.generationNumber}`;
    }
    const stableKey = request.stableKey?.trim();
    return stableKey ? `stable:${request.pageIndex}:${stableKey}` : null;
}

/** Reachable only through a native-append grant whose annotation route is loaded-source. */
export function projectNativeAnnotationDeletes(
    opts: {pendingDeletes: readonly IAnnotationCommentSummary[]},
): INativePdfMutationBuildResult<IPdfNativeAnnotationDelete[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native annotation delete fast path',
                reason,
                details,
            }],
        };
    };

    const deletesByRef = new Map<string, IPdfNativeAnnotationDelete>();
    const deletesByStableKey = new Map<string, IPdfNativeAnnotationDelete>();
    for (const comment of opts.pendingDeletes) {
        const targetRef = resolveNativeAnnotationDeleteRef(comment);
        const stableKey = comment.stableKey?.trim();
        const pageIndex = parsePageIndex(comment.pageIndex);
        if (
            !targetRef
            && stableKey
            && isReplayableEditorOnlyFreeTextNote(comment)
        ) {
            if (pageIndex === null) {
                return skip('pending-delete-not-native-eligible', {stableKey});
            }
            const existing = deletesByStableKey.get(stableKey);
            if (existing) {
                if (existing.pageIndex !== pageIndex) {
                    return skip('conflicting-native-delete-pages', {stableKey});
                }
                continue;
            }
            deletesByStableKey.set(stableKey, {
                pageIndex,
                stableKey,
                createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
                    ? Math.trunc(comment.createdAt)
                    : null,
            });
            continue;
        }
        if (
            !targetRef
            || targetRef.generationNumber > 65_535
            || pageIndex === null
        ) {
            return skip('pending-delete-not-native-eligible', {
                stableKey: comment.stableKey,
                source: comment.source,
                subtype: comment.subtype ?? null,
                annotationId: comment.annotationId ?? null,
                targetRef,
            });
        }

        const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        const deleteRequest = {
            pageIndex,
            objectNumber: targetRef.objectNumber,
            generationNumber: targetRef.generationNumber,
        };
        const existing = deletesByRef.get(refKey);
        if (existing) {
            if (existing.pageIndex !== deleteRequest.pageIndex) {
                return skip('conflicting-native-delete-pages', {
                    stableKey: comment.stableKey,
                    objectNumber: targetRef.objectNumber,
                    generationNumber: targetRef.generationNumber,
                });
            }
            continue;
        }
        deletesByRef.set(refKey, deleteRequest);
    }

    return {
        value: [
            ...Array.from(deletesByRef.values()),
            ...Array.from(deletesByStableKey.values()),
        ],
        skipEvents: [],
    };
}
