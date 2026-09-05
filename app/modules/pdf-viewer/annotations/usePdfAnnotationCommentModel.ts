import type {Ref} from 'vue';
import {isNoteEligibleComment} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligibleComment';
import {compareAnnotationCommentSummaries} from '@app/utils/pdfAnnotationComments';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import {parseMarkupSubtype} from '@contracts/annotations';
import type {IPdfAnnotationCommentModel} from '@app/modules/pdf-viewer/annotations/pdfAnnotationCommentModel.types';

interface IUsePdfAnnotationCommentModelOptions {
    isAnySaving: Ref<boolean>;
    annotationProjection: Ref<IAnnotationCommentSummary[]>;
    ingestSummaries: (comments: readonly IAnnotationCommentSummary[]) => void;
    getShapeAnnotationCommentSummaries: () => IAnnotationCommentSummary[];
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    shouldSuppressSidebarComment?: (comment: IAnnotationCommentSummary) => boolean;
}

function toPdfTextMarkupSubtype(comment: IAnnotationCommentSummary): TMarkupSubtype | null {
    return parseMarkupSubtype(comment.subtype);
}

function cloneSnapshot(comment: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...comment,
        markerRect: comment.markerRect ? {...comment.markerRect} : comment.markerRect,
        ...(comment.replies
            ? {replies: comment.replies.map(reply => ({...reply}))}
            : {}),
    };
}

/**
 * Projection adapter only. AnnotationApplication owns every semantic mutation;
 * this adapter sorts/emits immutable DTOs and translates legacy ingress.
 */
export const usePdfAnnotationCommentModel = (options: IUsePdfAnnotationCommentModelOptions): IPdfAnnotationCommentModel => {
    const activeCommentStableKey = ref<string | null>(null);
    const annotationCommentsCache = options.annotationProjection;

    function emitCommentsForSidebar(
        comments: readonly IAnnotationCommentSummary[],
        emitOptions: {includeShapes?: boolean} = {},
    ) {
        const visible = comments.filter(comment => !options.shouldSuppressSidebarComment?.(comment));
        const projected = emitOptions.includeShapes === false
            ? visible
            : [
                ...visible,
                ...options.getShapeAnnotationCommentSummaries(),
            ];
        options.emitAnnotationComments(projected.map(cloneSnapshot).sort(compareAnnotationCommentSummaries));
    }

    function upsertComment(comment: IAnnotationCommentSummary) {
        options.ingestSummaries([comment]);
    }

    function updateCachedColor() {
        // The caller commits color through AnnotationApplication. Store
        // subscription emits the resulting immutable projection.
    }

    function withTransientNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
        if (comment.source !== 'editor' || !isNoteEligibleComment(comment)) {
            return comment;
        }
        return {
            ...comment,
            hasNote: true,
            createdAt: comment.createdAt ?? Date.now(),
        };
    }

    function applyFromSync(comments: IAnnotationCommentSummary[]) {
        options.ingestSummaries(comments);
        return annotationCommentsCache.value.map(cloneSnapshot);
    }

    function handleMarkerMove(
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        moveOptions: {
            markEditorPending?: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                markerRect: IAnnotationMarkerRect,
            ) => void;
            markModified?: () => void;
        } = {},
    ) {
        const current = annotationCommentsCache.value.find(candidate => (
            candidate.appAnnotationId === comment.appAnnotationId
        ));
        if (!current) {
            return false;
        }
        const updated = {
            ...current,
            markerRect: {...markerRect},
            modifiedAt: Date.now(),
        };
        moveOptions.markEditorPending?.(updated, current, markerRect);
        moveOptions.markModified?.();
        return true;
    }

    function getSnapshot() {
        return annotationCommentsCache.value.map(cloneSnapshot);
    }

    function clearProjection() {
        options.annotationProjection.value = [];
        options.emitAnnotationComments([]);
    }

    function handleSourceChanged(
        nextSource: unknown,
        previousSource: unknown,
        sourceOptions: {syncAnnotationComments?: () => void | Promise<void>} = {},
    ) {
        if (nextSource === previousSource) {
            return;
        }
        activeCommentStableKey.value = null;
        clearProjection();
        if (!nextSource) {
            return;
        }
        void sourceOptions.syncAnnotationComments?.();
    }

    return {
        annotationCommentsCache,
        activeCommentStableKey,
        emitCommentsForSidebar,
        upsertComment,
        toTextMarkupSubtype: toPdfTextMarkupSubtype,
        updateCachedColor,
        withTransientNoteCreationTimestamp,
        markLocallyDeleted: () => undefined,
        restoreLocally: () => undefined,
        applyFromSync,
        isGracePreservedEditorOnlyComment: () => false,
        handleMarkerMove,
        getSnapshot,
        removeFromInternalCache: () => undefined,
        clearPendingMarkerMoves: () => undefined,
        clearProjection,
        handleSourceChanged,
    };
};
