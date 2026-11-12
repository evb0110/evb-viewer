import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/public';

export interface IDocumentTransitionDeps {
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    pdfError: Ref<unknown>;
    /** Empties every view of the document: its pages, panels and tool. */
    clearViews: () => void;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationCommentsLoading: () => void;
    clearAnnotationComments: () => void;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    bookmarkItems: Ref<unknown[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkEditMode: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<unknown[]>;
    pageLabelsDirty: Ref<boolean>;
    resetAnnotationTracking: () => void;
    resetSearchCache: () => void;
    closeSearch: () => void;
    closeContextMenus: () => void;
    closeAllAnnotationNotes: (opts?: { saveIfDirty?: boolean }) => Promise<boolean>;
    loadRecentFiles: () => void;
    consumePreservedSourceReloadMetadata?: (() => boolean) | undefined;
}

type TDjvuSourceSnapshot = readonly [boolean, TDocumentRef | null];

export const useDocumentTransitions = (deps: IDocumentTransitionDeps) => {
    const {
        pdfSrc,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        clearViews,
        annotationComments,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeContextMenus,
        closeAllAnnotationNotes,
        loadRecentFiles,
        consumePreservedSourceReloadMetadata,
    } = deps;

    watch(pdfSrc, (newSrc, oldSrc) => {
        if (newSrc && newSrc !== oldSrc) {
            const isReload = Boolean(oldSrc);
            logPdfRenderTrace('workspace-document-transition-source-changed', {isReload});
            resetAnnotationTracking();
            markAnnotationCommentsLoading();
            if (!isReload) {
                clearAnnotationComments();
            }
            const didPreserveMetadata = isReload && consumePreservedSourceReloadMetadata?.() === true;
            if (!didPreserveMetadata) {
                bookmarkItems.value = [];
                bookmarksDirty.value = false;
            }
            bookmarkEditMode.value = false;
            closeContextMenus();
        }
        if (!newSrc) {
            // The PDF document session owns the document and destroys it once
            // its renders have settled.
            clearViews();
            resetSearchCache();
            closeSearch();
            clearAnnotationComments();
            annotationActiveCommentStableKey.value = null;
            pageLabels.value = null;
            pageLabelRanges.value = [];
            pageLabelsDirty.value = false;
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
            bookmarkEditMode.value = false;
            closeContextMenus();
            void closeAllAnnotationNotes({ saveIfDirty: false });
            resetAnnotationTracking();
            annotationEditorState.value = {
                isEditing: false,
                isEmpty: true,
                hasSomethingToUndo: false,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
            };
        }

    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }

        if (nextPath) {
            loadRecentFiles();
        }

        annotationActiveCommentStableKey.value = null;
        closeContextMenus();
        clearAnnotationComments();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    });

    watch(
        () => [
            isDjvuMode.value,
            djvuSourcePath.value,
        ] as const,
        (nextSnapshot: TDjvuSourceSnapshot, previousSnapshot: TDjvuSourceSnapshot) => {
            const nextIsDjvuMode = nextSnapshot[0];
            const nextDjvuSourcePath = nextSnapshot[1];
            const previousIsDjvuMode = previousSnapshot[0];
            const previousDjvuSourcePath = previousSnapshot[1];

            if (
                nextIsDjvuMode
                && nextDjvuSourcePath
                && (
                    nextDjvuSourcePath !== previousDjvuSourcePath
                    || nextIsDjvuMode !== previousIsDjvuMode
                )
            ) {
                loadRecentFiles();
            }
        },
    );

    watch(annotationComments, comments => {
        if (
            annotationActiveCommentStableKey.value
            && !comments.some(comment => annotationIdForSummary(comment) === annotationActiveCommentStableKey.value)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    });
};
