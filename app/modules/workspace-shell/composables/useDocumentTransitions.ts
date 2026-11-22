import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
} from '@app/types/annotations';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/public';

export interface IDocumentTransitionDeps {
    /** Empties every view of the document: its pages, panels and tool. */
    clearViews: () => void;
    annotationComments: Readonly<Ref<readonly IAnnotationCommentSummary[]>>;
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
    consumePreservedSourceReloadMetadata?: (() => boolean) | undefined;
}

export const useDocumentTransitions = (deps: IDocumentTransitionDeps) => {
    const {
        clearViews,
        annotationComments,
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
        consumePreservedSourceReloadMetadata,
    } = deps;

    // Empties every view of the outgoing document before its successor is
    // published, or when a close clears it. The PDF document session owns
    // the document and destroys it once its renders have settled.
    function resetDocumentPresentation() {
        clearViews();
        resetSearchCache();
        closeSearch();
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

    // Each published source of the same document resets what tracked the
    // previous one; a page operation's reload keeps its metadata.
    function resetForPublishedSource(isReload: boolean) {
        logPdfRenderTrace('workspace-document-transition-source-changed', {isReload});
        resetAnnotationTracking();
        if (!isReload || consumePreservedSourceReloadMetadata?.() !== true) {
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
        }
        bookmarkEditMode.value = false;
        closeContextMenus();
    }

    // A Save As or an optimized copy moves the document to another working copy.
    function dismissWorkingPathState() {
        annotationActiveCommentStableKey.value = null;
        closeContextMenus();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    }

    watch(annotationComments, comments => {
        if (
            annotationActiveCommentStableKey.value
            && !comments.some(comment => annotationIdForSummary(comment) === annotationActiveCommentStableKey.value)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    });

    return {
        resetDocumentPresentation,
        resetForPublishedSource,
        dismissWorkingPathState,
    };
};
