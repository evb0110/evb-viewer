import {
    watch,
    type Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';
import { STORAGE_KEYS } from '@app/constants/storage-keys';
import { BrowserLogger } from '@app/utils/browser-logger';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

export interface IDocumentTransitionDeps {
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<string | null>;
    pdfError: Ref<unknown>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationKeepActive: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    annotationPlacingPageNote: Ref<boolean>;
    bookmarkItems: Ref<unknown[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkEditMode: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<unknown[]>;
    pageLabelsDirty: Ref<boolean>;
    pdfViewerRef: Ref<{
        clearShapes: () => void;
        cancelCommentPlacement: () => void 
    } | null>;
    resetAnnotationTracking: () => void;
    resetSearchCache: () => void;
    closeSearch: () => void;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeAllAnnotationNotes: (opts?: { saveIfDirty?: boolean }) => Promise<boolean>;
    loadRecentFiles: () => void;
}

export const useDocumentTransitions = (deps: IDocumentTransitionDeps) => {
    const {
        pdfSrc,
        workingCopyPath,
        pdfError,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationKeepActive,
        annotationTool,
        annotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    } = deps;

    watch(pdfError, (err) => {
        if (err) {
            BrowserLogger.error('pdf', 'PDF Error', err);
        }
    });

    watch(annotationKeepActive, (value) => {
        if (typeof window === 'undefined') {
            return;
        }
        window.localStorage.setItem(STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE, value ? '1' : '0');
    });

    watch(
        () => [
            showSidebar.value,
            sidebarTab.value,
        ] as const,
        ([
            isOpen,
            tab,
        ]) => {
            if (!isOpen || tab !== 'bookmarks') {
                bookmarkEditMode.value = false;
            }
        },
    );

    watch(dragMode, (enabled) => {
        if (enabled) {
            window.getSelection()?.removeAllRanges();
            if (annotationTool.value !== 'none') {
                annotationTool.value = 'none';
            }
            pdfViewerRef.value?.cancelCommentPlacement();
            annotationPlacingPageNote.value = false;
        }
    });

    watch(pdfSrc, (newSrc, oldSrc) => {
        if (newSrc && newSrc !== oldSrc) {
            resetAnnotationTracking();
            annotationComments.value = [];
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
            bookmarkEditMode.value = false;
            closeAnnotationContextMenu();
            closePageContextMenu();
            void closeAllAnnotationNotes({ saveIfDirty: false });
        }
        if (!newSrc) {
            resetSearchCache();
            closeSearch();
            annotationTool.value = 'none';
            annotationComments.value = [];
            annotationActiveCommentStableKey.value = null;
            pageLabels.value = null;
            pageLabelRanges.value = [];
            pageLabelsDirty.value = false;
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
            bookmarkEditMode.value = false;
            pdfViewerRef.value?.clearShapes();
            closeAnnotationContextMenu();
            closePageContextMenu();
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

        if (newSrc && !oldSrc) {
            loadRecentFiles();
        }
    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }
        annotationActiveCommentStableKey.value = null;
        closeAnnotationContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    });

    watch(annotationComments, (comments) => {
        if (
            annotationActiveCommentStableKey.value
            && !comments.some(comment => comment.stableKey === annotationActiveCommentStableKey.value)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    });
};
