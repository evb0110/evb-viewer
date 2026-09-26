import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    TFitMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IDocumentViewerExpose,
    IScrollToPageOptions,
    TPdfSidebarTab,
} from '@app/modules/pdf-viewer/public';
import type {
    IDocumentNavigationRequest,
    IDocumentNavigationTicket,
} from '@app/modules/document-viewer/public';
import {
    createPdfPageNavigationRequest,
    isAuthoringAnnotationTool,
} from '@app/modules/pdf-viewer/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IWorkspaceViewStateDeps {
    fitMode: Ref<TFitMode>;
    zoomMode: Ref<TZoomMode>;
    zoom: Ref<number>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    appAnnotationUndoDepth: Ref<number>;
    hasOpenAnnotationNotes: Ref<boolean>;
    canUndoHistory: Ref<boolean>;
    canRedoHistory: Ref<boolean>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    invalidateBookmarkNavigationRequests?: (() => void) | undefined;
    requestPageNavigation?: ((request: IDocumentNavigationRequest) => IDocumentNavigationTicket | null) | undefined;
    documentViewerRef: Ref<IDocumentViewerExpose | null>;
}

export const useWorkspaceViewState = (deps: IWorkspaceViewStateDeps) => {
    const isFitWidthActive = computed(
        () => deps.zoomMode.value === 'fit-width',
    );
    const isFitHeightActive = computed(
        () => deps.zoomMode.value === 'fit-height',
    );
    // App-routed PDF.js commands are undoable before live storage fingerprinting
    // necessarily reports a dirty annotation state.
    const hasAppAnnotationHistoryUndoState = computed(() => (
        deps.annotationEditorState.value.hasAppAnnotationUndoHistory === true
        || deps.annotationEditorState.value.hasAppAnnotationRedoHistory === true
    ));
    const isAnnotationUndoContext = computed(
        () => isAuthoringAnnotationTool(deps.annotationTool.value)
            || hasAppAnnotationHistoryUndoState.value
            || deps.annotationEditorState.value.hasSomethingToRedo
            || deps.appAnnotationUndoDepth.value > 0,
    );
    const annotationCursorMode = computed(() => {
        if (deps.hasOpenAnnotationNotes.value) {
            return true;
        }

        if (deps.dragMode.value) {
            return false;
        }

        // In text-select mode we still want existing PDF annotations and
        // overlay-managed drawings to remain interactable/selectable. Hand tool
        // is the only state that should fully disable annotation interaction.
        return true;
    });
    const canUndoAnnotation = computed(() => (
        deps.annotationEditorState.value.hasAppAnnotationUndoHistory === true
        || deps.appAnnotationUndoDepth.value > 0
    ));
    const canRedoAnnotation = computed(() => (
        deps.annotationEditorState.value.hasAppAnnotationRedoHistory === true
    ));
    // The workspace command stack is the sole undo/redo authority. Annotation
    // state remains exposed for context-sensitive UI, never as a second route.
    const canUndo = computed(() => deps.canUndoHistory.value);
    const canRedo = computed(() => deps.canRedoHistory.value);

    function handleFitMode(mode: TFitMode) {
        // Fit is a viewport-state intent, not a navigation cancellation. The
        // viewer authority must preserve the current/pending semantic page
        // while the new geometry is computed; cancelling here sampled the old
        // scroll layout and could silently move page 2 to page 3.
        deps.zoom.value = 1;
        deps.fitMode.value = mode;
        deps.zoomMode.value = mode === 'height' ? 'fit-height' : 'fit-width';
    }

    function enableDragMode() {
        deps.dragMode.value = true;
        if (deps.annotationTool.value !== 'none') {
            deps.annotationTool.value = 'none';
        }
    }

    function normalizeNavigationPage(page: number) {
        const requestedPage = Number.isFinite(page) ? Math.trunc(page) : deps.currentPage.value;
        const positivePage = Math.max(requestedPage, 1);
        if (deps.totalPages.value <= 0) {
            // Metadata is the sole clamp authority. Keep the raw positive
            // command while an opening session has no authoritative pageCount.
            return positivePage;
        }
        return Math.min(positivePage, Math.max(1, Math.trunc(deps.totalPages.value)));
    }

    function handleGoToPage(page: number, options?: IScrollToPageOptions) {
        const targetPage = normalizeNavigationPage(page);
        const wasAlreadyCurrentPage = deps.currentPage.value === targetPage;
        const hasExplicitScrollTarget = options !== undefined;
        const pendingNavigationTargetPage = deps.documentViewerRef.value?.getPendingNavigationTargetPage?.() ?? null;
        const hasConflictingPendingNavigation = pendingNavigationTargetPage !== null
            && pendingNavigationTargetPage !== targetPage;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-go-to-page] requested=${page}`, {
            requestedPage: page,
            targetPage,
            wasAlreadyCurrentPage,
            hasExplicitScrollTarget,
            pendingNavigationTargetPage,
            hasConflictingPendingNavigation,
            hasViewer: Boolean(deps.documentViewerRef.value),
            sidebarOpen: deps.showSidebar.value,
            sidebarTab: deps.sidebarTab.value,
            dragMode: deps.dragMode.value,
            annotationTool: deps.annotationTool.value,
        });
        logPdfRenderTrace('workspace-go-to-page', {
            requestedPage: page,
            targetPage,
            currentPageBefore: deps.currentPage.value,
            wasAlreadyCurrentPage,
            hasExplicitScrollTarget,
            pendingNavigationTargetPage,
            hasConflictingPendingNavigation,
            hasViewer: Boolean(deps.documentViewerRef.value),
        });
        // Workspace commands are user intent, not a current-page projection.
        // Forward same-page commands as well: the semantic page can remain
        // current while its virtual slot or canvas has been evicted, and an
        // active thumbnail / First Page replay must be able to heal that state.
        if (options?.navigationSource !== 'bookmark') {
            deps.invalidateBookmarkNavigationRequests?.();
        }
        // The host-owned viewport session exists before the async viewer ref.
        // Persist intent there so chassis mounting cannot replace it with a
        // stale page prop while the document is still opening.
        const request = createPdfPageNavigationRequest(targetPage, options);
        if (deps.requestPageNavigation) {
            deps.requestPageNavigation(request);
        } else {
            deps.documentViewerRef.value?.scrollToPage(targetPage, options);
        }
    }

    return {
        isFitWidthActive,
        isFitHeightActive,
        isAnnotationUndoContext,
        annotationCursorMode,
        canUndoAnnotation,
        canRedoAnnotation,
        canUndo,
        canRedo,
        handleFitMode,
        enableDragMode,
        handleGoToPage,
    };
};
