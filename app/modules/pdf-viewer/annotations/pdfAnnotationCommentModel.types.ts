import type {Ref} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';

export interface IPdfAnnotationCommentModel {
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    emitCommentsForSidebar: (
        comments: readonly IAnnotationCommentSummary[],
    ) => void;
    upsertComment(comment: IAnnotationCommentSummary): void;
    toTextMarkupSubtype(comment: IAnnotationCommentSummary): TMarkupSubtype | null;
    updateCachedColor(comment: IAnnotationCommentSummary, color: string, options?: { colorEdited?: boolean }): void;
    withTransientNoteCreationTimestamp(comment: IAnnotationCommentSummary): IAnnotationCommentSummary;
    markLocallyDeleted(comment: IAnnotationCommentSummary): void;
    restoreLocally(comment: IAnnotationCommentSummary): void;
    applyFromSync(comments: IAnnotationCommentSummary[]): IAnnotationCommentSummary[];
    isGracePreservedEditorOnlyComment(comment: IAnnotationCommentSummary): boolean;
    handleMarkerMove(
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        options?: {
            markEditorPending?: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                markerRect: IAnnotationMarkerRect,
            ) => void;
            markModified?: () => void;
        },
    ): boolean;
    getSnapshot(): IAnnotationCommentSummary[];
    removeFromInternalCache(stableKey: string): void;
    clearPendingMarkerMoves(): void;
    clearProjection(): void;
    handleSourceChanged(next: unknown, previous: unknown, options?: { syncAnnotationComments?: () => void | Promise<void> }): void;
}
