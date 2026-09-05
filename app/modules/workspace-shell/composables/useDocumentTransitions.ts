import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/public';

export interface IDocumentTransitionDeps {
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    pdfError: Ref<unknown>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    pdfDocument: Ref<unknown | null>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
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
    pdfViewerRef: Ref<{clearShapes: () => void;} | null>;
    resetAnnotationTracking: () => void;
    resetSearchCache: () => void;
    closeSearch: () => void;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeAllAnnotationNotes: (opts?: { saveIfDirty?: boolean }) => Promise<boolean>;
    loadRecentFiles: () => void;
    consumePreservedSourceReloadMetadata?: (() => boolean) | undefined;
    hasPendingProgrammaticPageNavigation?: (() => boolean) | undefined;
    clearProgrammaticPageNavigation?: (() => void) | undefined;
}

interface IDestroyablePdfDocument { destroy?: () => Promise<void> }

type TBookmarkSidebarSnapshot = readonly [boolean, TPdfSidebarTab];
type TDjvuSourceSnapshot = readonly [boolean, TDocumentRef | null];

function isDestroyablePdfDocument(value: unknown): value is IDestroyablePdfDocument {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const { destroy } = value as { destroy?: unknown };
    return destroy === undefined || typeof destroy === 'function';
}

export const useDocumentTransitions = (deps: IDocumentTransitionDeps) => {
    const {
        pdfSrc,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        pdfDocument,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
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
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
        consumePreservedSourceReloadMetadata,
        hasPendingProgrammaticPageNavigation,
        clearProgrammaticPageNavigation,
    } = deps;

    watch(
        () => [
            showSidebar.value,
            sidebarTab.value,
        ] as const,
        (snapshot: TBookmarkSidebarSnapshot) => {
            const isOpen = snapshot[0];
            const tab = snapshot[1];

            if (!isOpen || tab !== 'bookmarks') {
                bookmarkEditMode.value = false;
            }
        },
    );

    watch(dragMode, (enabled: boolean) => {
        if (enabled) {
            window.getSelection()?.removeAllRanges();
            if (annotationTool.value !== 'none') {
                annotationTool.value = 'none';
            }
        }
    });

    watch(pdfSrc, (newSrc, oldSrc) => {
        if (newSrc && newSrc !== oldSrc) {
            const isReload = Boolean(oldSrc);
            const pendingProgrammaticNavigation = hasPendingProgrammaticPageNavigation?.() === true;
            logPdfRenderTrace('workspace-document-transition-source-changed', {
                isReload,
                pendingProgrammaticNavigation,
                currentPageBefore: currentPage.value,
            });
            // A user command issued during the open transition owns the page
            // model until the viewer settles it; resetting here would echo
            // page 1 back into the navigation controller and discard the
            // queued intent.
            if (!pendingProgrammaticNavigation) {
                currentPage.value = 1;
            }
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
            closeAnnotationContextMenu();
            closePageContextMenu();
        }
        if (!newSrc) {
            const previousDocument = isDestroyablePdfDocument(pdfDocument.value) ? pdfDocument.value : null;
            clearProgrammaticPageNavigation?.();
            currentPage.value = 1;
            totalPages.value = 0;
            pdfDocument.value = null;
            showSidebar.value = false;
            if (previousDocument?.destroy) {
                previousDocument.destroy().catch((error) => {
                    BrowserLogger.debug(
                        'pdf-document',
                        'PDF document destroy rejected during close',
                        error,
                    );
                });
            }
            resetSearchCache();
            closeSearch();
            annotationTool.value = 'none';
            clearAnnotationComments();
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

    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }

        if (nextPath) {
            loadRecentFiles();
        }

        annotationActiveCommentStableKey.value = null;
        closeAnnotationContextMenu();
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
