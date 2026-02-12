import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    computeSummaryStableKey,
    toCanonicalStableKey,
    normalizeSummaryStableKey,
    compareAnnotationComments,
    areTextMarkupCommentsLikelySame,
    commentsAreSameLogicalAnnotation,
    commentMergePriority,
    mergeCommentSummaries,
    mergeDuplicateCommentSummary,
    dedupeAnnotationCommentSummaries,
    commentsMatchForEditorLookup,
    getSummaryMemoryKeys,
} from '@app/composables/pdf/annotationIdentityMatching';

export {
    computeSummaryStableKey,
    toCanonicalStableKey,
    normalizeSummaryStableKey,
    compareAnnotationComments,
    areTextMarkupCommentsLikelySame,
    commentsAreSameLogicalAnnotation,
    commentMergePriority,
    mergeCommentSummaries,
    mergeDuplicateCommentSummary,
    dedupeAnnotationCommentSummaries,
    commentsMatchForEditorLookup,
    getSummaryMemoryKeys,
} from '@app/composables/pdf/annotationIdentityMatching';

interface ISummaryMemoryEntry {
    text: string;
    modifiedAt: number | null;
    author: string | null;
    kindLabel: string | null;
    subtype: string | null;
    color: string | null;
    markerRect: IAnnotationMarkerRect | null;
}

export function useAnnotationCommentIdentity(
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>,
) {
    const editorRuntimeIds = new WeakMap<IPdfjsEditor, string>();
    let editorRuntimeIdCounter = 0;
    const commentSummaryMemory = new Map<string, ISummaryMemoryEntry>();

    function getEditorRuntimeId(editor: IPdfjsEditor, pageIndex: number) {
        let runtimeId = editorRuntimeIds.get(editor);
        if (!runtimeId) {
            editorRuntimeIdCounter += 1;
            runtimeId = `runtime-${pageIndex}-${editorRuntimeIdCounter}`;
            editorRuntimeIds.set(editor, runtimeId);
        }
        return runtimeId;
    }

    function getEditorIdentity(editor: IPdfjsEditor, pageIndex: number) {
        const rawEditorId = typeof editor.id === 'string' || typeof editor.id === 'number'
            ? String(editor.id)
            : '';
        return editor.uid
            ?? editor.annotationElementId
            ?? (rawEditorId ? `editor:${pageIndex}:${rawEditorId}` : null)
            ?? getEditorRuntimeId(editor, pageIndex);
    }

    function getEditorPendingKey(editor: IPdfjsEditor, pageIndex: number) {
        return `p${pageIndex}:${getEditorIdentity(editor, pageIndex)}`;
    }

    function toSummaryKey(summary: IAnnotationCommentSummary) {
        return summary.stableKey;
    }

    function rememberSummaryText(summary: IAnnotationCommentSummary) {
        const text = summary.text.trim();
        if (!text) {
            return;
        }
        const payload: ISummaryMemoryEntry = {
            text: summary.text,
            modifiedAt: summary.modifiedAt ?? null,
            author: summary.author ?? null,
            kindLabel: summary.kindLabel ?? null,
            subtype: summary.subtype ?? null,
            color: summary.color ?? null,
            markerRect: summary.markerRect ?? null,
        };
        getSummaryMemoryKeys(summary).forEach((key) => {
            commentSummaryMemory.set(key, payload);
        });
    }

    function forgetSummaryText(summary: IAnnotationCommentSummary) {
        getSummaryMemoryKeys(summary).forEach((key) => {
            commentSummaryMemory.delete(key);
        });
    }

    function hydrateSummaryFromMemory(summary: IAnnotationCommentSummary) {
        if (summary.text.trim()) {
            return summary;
        }
        if (summary.hasNote) {
            return summary;
        }

        for (const key of getSummaryMemoryKeys(summary)) {
            const cached = commentSummaryMemory.get(key);
            if (!cached || !cached.text.trim()) {
                continue;
            }
            return {
                ...summary,
                text: cached.text,
                modifiedAt: summary.modifiedAt ?? cached.modifiedAt,
                author: summary.author ?? cached.author,
                kindLabel: summary.kindLabel ?? cached.kindLabel,
                subtype: summary.subtype ?? cached.subtype,
                color: summary.color ?? cached.color,
                markerRect: summary.markerRect ?? cached.markerRect,
            };
        }

        return summary;
    }

    function findCommentByStableKey(stableKey: string) {
        return annotationCommentsCache.value.find(comment => comment.stableKey === stableKey) ?? null;
    }

    function findCommentByAnnotationId(annotationId: string | null | undefined, pageNumber: number | null = null) {
        const normalized = (annotationId ?? '').trim();
        if (!normalized) {
            return null;
        }

        if (Number.isFinite(pageNumber)) {
            const byPage = annotationCommentsCache.value.find(comment => (
                comment.annotationId === normalized
                && comment.pageNumber === pageNumber
            ));
            if (byPage) {
                return byPage;
            }
        }

        return annotationCommentsCache.value.find(comment => comment.annotationId === normalized) ?? null;
    }

    function resolveCommentFromCache(comment: IAnnotationCommentSummary) {
        const direct = findCommentByStableKey(comment.stableKey);
        if (direct) {
            return direct;
        }
        return annotationCommentsCache.value.find(candidate => commentsMatchForEditorLookup(candidate, comment)) ?? null;
    }

    function clearMemory() {
        commentSummaryMemory.clear();
    }

    return {
        getEditorRuntimeId,
        getEditorIdentity,
        getEditorPendingKey,
        computeSummaryStableKey,
        toCanonicalStableKey,
        normalizeSummaryStableKey,
        compareAnnotationComments,
        dedupeAnnotationCommentSummaries,
        commentMergePriority,
        mergeDuplicateCommentSummary,
        mergeCommentSummaries,
        commentsAreSameLogicalAnnotation,
        areTextMarkupCommentsLikelySame,
        toSummaryKey,
        rememberSummaryText,
        hydrateSummaryFromMemory,
        forgetSummaryText,
        getSummaryMemoryKeys,
        commentsMatchForEditorLookup,
        resolveCommentFromCache,
        findCommentByStableKey,
        findCommentByAnnotationId,
        clearMemory,
    };
}
