import type {
    InjectionKey,
    Ref,
} from 'vue';
import {
    pdfDocumentAnnotationsKey,
    usePageContextMenu,
} from '@app/modules/pdf-viewer/public';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { useDocumentWorkspaceScanCleanupSurface } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import { useScanCleanupSourceSha256 } from '@app/modules/scan-cleanup/public/workspace';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';
import { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import { usePageShortcuts } from '@app/modules/workspace-shell/composables/usePageShortcuts';
import { useWorkspaceCrop } from '@app/modules/workspace-shell/composables/useWorkspaceCrop';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import { resolveWorkspaceViewerViewMode } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';
import type {
    IWorkspaceDocumentController,
    IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runDetached } from '@app/utils/asyncGuard';
import { useWorkspaceDocumentDriverBinding } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    createDocumentPageSourceSearchBackend,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import { useDocumentSearchSession } from '@app/modules/workspace-shell/composables/useDocumentSearchSession';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { getErrorMessage } from '@app/utils/error';
import { isPdfjsAssetVersionMismatch } from '@app/utils/isPdfjsAssetVersionMismatch';
import { copyTextToClipboard } from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkspaceViewerUpdateHandlers } from '@app/modules/workspace-shell/viewers/createWorkspaceViewerUpdateHandlers';
import { createWorkspacePageNavigationFence } from '@app/modules/workspace-shell/viewers/createWorkspacePageNavigationFence';
import {
    provideDocumentContext,
    useDocumentContextRegistry,
} from '@app/modules/workspace-shell/documentContext';

interface IDocumentViewContextDeps {
    tabId: string;
    controller: IWorkspaceDocumentController;
    isActive: Ref<boolean>;
    openSurface: IDocumentOpenSurfaceSession;
    /** Runs a user open as the document controller's open transaction in this view. */
    runDocumentOpen: (request: IWorkspaceOpenRequest, run: () => Promise<boolean>) => Promise<boolean>;
    emitOpenInNewTab: (result: TDocumentRef | TOpenFileResult) => void;
    emitOpenSettings: () => void;
}
interface IDocumentViewBindingOptions {
    mountPresentation: Ref<boolean>;
    isRenderActive: Ref<boolean>;
    isWorkspaceLayoutResizing: Ref<boolean>;
    navigationFeedbackPage: Ref<number | null>;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
}

/**
 * One tab's view of a document: its open surface, page, zoom and panels,
 * navigation, shortcuts and viewer binding. DocumentWorkspace creates it for
 * the document its tab views, which lives in a DocumentSessionHost; it lends
 * the document a port and provides both contexts to the workspace.
 */
export const createDocumentViewContext = (deps: IDocumentViewContextDeps) => {
    const {
        tabId,
        controller,
        isActive,
        openSurface,
    } = deps;
    const documentView = controller.getView(tabId);
    const hostedDocument = useDocumentContextRegistry().get(controller);
    if (!documentView || !hostedDocument) {
        throw new Error(`Tab ${tabId} mounted a workspace for a document it does not view or that is not hosted`);
    }
    const document = hostedDocument;
    // The tab's retained view (page, zoom, sidebar) seeds this mount; a cold tab
    // comes back where it was.
    const initialViewState = documentView.viewState.value;
    const preserveInitialStateForFirstSource = controller.snapshot.value.phase === 'presented'
        && documentView.toolbarSnapshot.value.initialVisualReady;
    const { t } = useTypedI18n();
    const {
        file,
        annotations,
        metadata,
        saveService,
        save,
        failure,
        driver,
        print,
    } = document;
    const {
        workingCopyPath,
        documentRevisionToken,
        originalPath,
        pdfData,
        pdfSrc,
    } = file;
    // This view's own PDF.js document and page count; the document reads them
    // through the view whose tab is in use and never writes another view's.
    const view = useWorkspaceViewerShellState(initialViewState);
    const {
        pdfViewerRef,
        documentViewerRef,
        currentPage,
        totalPages,
        pdfDocument,
    } = view;
    const search = useWorkspaceSearchSidebar({
        workingCopyPath,
        documentRevisionToken,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        dragMode: view.dragMode,
        totalPages,
        initialSidebarWidth: initialViewState?.sidebarWidth,
    });
    const { settings: appSettings } = useSettings();

    watch(
        () => ({
            viewer: pdfViewerRef.value,
            setCommandSink: pdfViewerRef.value?.setWorkspaceCommandSink,
        }),
        (current, previous) => {
            if (
                previous?.viewer
                && (previous.viewer !== current.viewer || previous.setCommandSink !== current.setCommandSink)
            ) {
                previous.setCommandSink?.(null);
            }
            current.setCommandSink?.(metadata.workspaceCommandSink);
        },
        {
            flush: 'post',
            immediate: true,
        },
    );
    const scanCleanup = useDocumentWorkspaceScanCleanupSurface({
        documentSession: document.controller,
        documentView,
        closeAllDropdowns: view.closeAllDropdowns,
        readDocumentKey: () => file.documentKey.value,
        readSourceSha256: () => scanCleanupSourceSha256.value,
    });
    const scanCleanupSourceSha256 = useScanCleanupSourceSha256({
        enabled: computed(() => isActive.value && scanCleanup.surfaceMode.value === 'scan-cleanup'),
        sourcePath: workingCopyPath,
        documentRevision: documentRevisionToken,
    });
    const pageContextMenu = usePageContextMenu();

    const bookmarkNavigationIntentVersion = ref(0);
    const {
        consumePageUpdate: consumeViewerCurrentPageUpdate,
        navigationPage,
    } = createWorkspacePageNavigationFence({
        currentPage,
        openSurface,
    });
    const navigation = useWorkspaceViewState({
        fitMode: view.fitMode,
        zoomMode: view.zoomMode,
        zoom: view.zoom,
        dragMode: view.dragMode,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        annotationTool: annotations.annotationTool,
        annotationEditorState: annotations.annotationEditorState,
        appAnnotationUndoDepth: annotations.appAnnotationUndoDepth,
        hasOpenAnnotationNotes: annotations.hasOpenAnnotationNotes,
        canUndoHistory: metadata.workspaceUndoTimeline.canUndoTimeline,
        canRedoHistory: metadata.workspaceUndoTimeline.canRedoTimeline,
        currentPage,
        totalPages,
        invalidateBookmarkNavigationRequests: () => {
            bookmarkNavigationIntentVersion.value += 1;
            logPdfRenderTrace('workspace-bookmark-navigation-invalidated', {
                version: bookmarkNavigationIntentVersion.value,
                currentPage: currentPage.value,
                pendingNavigationPage: navigationPage.value,
            });
        },
        requestPageNavigation: request => openSurface.navigate(request),
        documentViewerRef,
    });
    // Search over a non-PDF page source (DjVu), shown by the source sidebar.
    const sourceSearch = useDocumentSearchSession({
        backend: computed(() => createDocumentPageSourceSearchBackend(view.documentPageSource.value)),
        documentRevision: documentRevisionToken,
        onNavigate: match => navigation.handleGoToPage(match.pageIndex + 1, {navigationSource: 'search'}),
    });
    const annotationActions = usePageAnnotationActions({
        pdfViewerRef,
        annotationTool: annotations.annotationTool,
        annotationActiveCommentStableKey: annotations.annotationActiveCommentStableKey,
        annotationContextMenu: annotations.annotationContextMenu,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        dragMode: view.dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu: annotations.closeAnnotationContextMenu,
        showAnnotationContextMenu: annotations.showAnnotationContextMenu,
        handleAnnotationToolChange: annotations.handleAnnotationToolChange,
        openAnnotationNoteWindow: annotations.openAnnotationNoteWindow,
        removeAnnotationNoteWindow: annotations.removeAnnotationNoteWindow,
        setAnnotationNoteWindowError: annotations.setAnnotationNoteWindowError,
        isSameAnnotationComment: annotations.isSameAnnotationComment,
        annotationNoteWindows: annotations.annotationNoteWindows,
        invalidateThumbnailPages: view.requestThumbnailInvalidation,
        getAnnotationCommentsSnapshot: () => annotations.annotationComments.value,
        getAnnotationCommentsStatusSnapshot: () => annotations.annotationCommentsStatus.value,
        discardAnnotationNote: annotations.discardAnnotationNote,
        handleAnnotationModified: annotations.handleAnnotationModified,
    });

    const statusBar = usePageStatusBar({
        hasDocument: document.hasOpenDocument,
        pdfSrc,
        pdfData,
        originalPath: computed(() => document.pendingDocumentPath.value ?? originalPath.value),
        workingCopyPath,
        effectiveZoom: view.effectiveZoom,
        knownFileSizeBytes: file.djvuSourceSizeBytes,
        canSave: saveService.canSave,
        hasSaveFailure: saveService.hasSaveFailure,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy: document.history.isHistoryBusy,
        handleSave: save.handleSave,
    });

    const activeDriver = driver.activeDocumentDriver;
    const viewerCapabilities = document.viewerCapabilities;
    const viewerDefaults = useWorkspaceViewerDefaults({
        appSettings,
        annotationSettings: annotations.annotationSettings,
        viewMode: view.viewMode,
        continuousScroll: view.continuousScroll,
        fitMode: view.fitMode,
        zoom: view.zoom,
        effectiveZoom: view.effectiveZoom,
        zoomMode: view.zoomMode,
        pdfSrc,
        preserveInitialStateForFirstSource,
        documentSourceKey: computed(() => {
            if (file.isDjvuMode.value && file.djvuSourcePath.value) {
                return `djvu:${file.djvuSourcePath.value}`;
            }
            return workingCopyPath.value ? `pdf:${workingCopyPath.value}` : pdfSrc.value;
        }),
    });
    usePageShortcuts({
        isActive,
        hasInteractiveDocument: computed(() => Boolean(pdfSrc.value ?? file.djvuSourcePath.value)),
        pdfSrc,
        canPrint: computed(() => (
            activeDriver.value?.capabilities.print === true
            && (file.hasPdf.value || document.sourceCapabilities.value.directImageExport)
        )),
        canSave: saveService.canSave,
        annotationTool: annotations.annotationTool,
        pdfViewerRef,
        annotationContextMenuVisible: computed(() => annotations.annotationContextMenu.value.visible),
        pageContextMenuVisible: computed(() => pageContextMenu.pageContextMenu.value.visible),
        closeAnnotationContextMenu: annotations.closeAnnotationContextMenu,
        closePageContextMenu: pageContextMenu.closePageContextMenu,
        openSearch: search.openSearch,
        handleAnnotationToolChange: annotations.handleAnnotationToolChange,
        handleZoomIn: viewerDefaults.handleZoomIn,
        handleZoomOut: viewerDefaults.handleZoomOut,
        handleActualSize: viewerDefaults.handleActualSize,
        handleFitMode: navigation.handleFitMode,
        navigationPage,
        totalPages,
        viewMode: computed(() => resolveWorkspaceViewerViewMode(viewerCapabilities.value, view.viewMode.value)),
        handleGoToPage: navigation.handleGoToPage,
        handleSave: () => {
            void runDetached(save.handleSave, {
                category: 'user-visible-operation',
                scope: 'workspace',
                message: 'Failed to save document',
            });
        },
        handlePrint: () => {
            void runDetached(() => Promise.resolve(print.handlePrint()), {
                category: 'user-visible-operation',
                scope: 'workspace',
                message: 'Failed to print document',
            });
        },
        handleToggleSidebar: () => {
            view.showSidebar.value = !view.showSidebar.value;
        },
    });
    const crop = useWorkspaceCrop({
        pdfViewerRef,
        workingCopyPath,
    });
    function handleCaptureRegion() {
        const viewer = pdfViewerRef.value;
        if (!viewer || file.isDjvuMode.value) {
            return;
        }
        void runDetached(async () => {
            if (await save.ensureWorkingCopyFreshForRead()) {
                await viewer.captureRegionToClipboard();
            }
        }, {
            category: 'user-visible-operation',
            scope: 'workspace',
            message: 'Failed to capture PDF region',
        });
    }
    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        view.handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            document.docx.clearDocxExportError();
        }
    }

    const djvuProjection = useDjvuProjectionActions({
        isDjvuMode: file.isDjvuMode,
        currentPage,
        documentViewerRef,
        ensureProjection: file.ensureDjvuPdfProjection,
        saveAs: save.handleSaveAs,
        exportDocx: document.docxExport.handleExportDocx,
        isExportingDocx: document.docxExport.isExporting,
        cancelExportDocx: document.docxExport.cancel,
        handleDropdownOpen,
        insertImageFromFile: annotationActions.insertImageFromFile,
        pasteImageFromClipboard: annotationActions.pasteImageFromClipboard,
        createQuickNote: annotationActions.handleQuickNoteAction,
    });

    watch(view.showSettings, (value) => {
        if (!value) {
            return;
        }
        deps.emitOpenSettings();
        view.showSettings.value = false;
    });

    function bindDocumentView(options: IDocumentViewBindingOptions) {
        const hiddenSearchPageMatches = new Map<number, IPdfPageMatches>();
        const searchShown = computed(() => isActive.value && view.showSidebar.value);
        const {
            handleCurrentPage,
            handleTotalPages,
        } = createWorkspaceViewerUpdateHandlers({
            tabId: deps.tabId,
            pdfSrc,
            currentPage,
            totalPages,
            showSidebar: view.showSidebar,
            sidebarTab: view.sidebarTab,
            isLoading: view.isLoading,
            continuousScroll: view.continuousScroll,
            fitMode: view.fitMode,
            viewMode: view.viewMode,
            zoom: view.zoom,
            viewerRef: documentViewerRef,
            consumePageUpdate: consumeViewerCurrentPageUpdate,
        });
        function handleLoadError(error: unknown) {
            if (error === null || error === undefined) {
                file.pdfError.value = null;
                file.pdfFailurePresentation.value = null;
                return;
            }
            const message = getErrorMessage(error).trim();
            const hasPdfjsAssetMismatch = isPdfjsAssetVersionMismatch(message);
            file.pdfError.value = message || t('errors.file.open');
            const receipt = getFailureReceipt(error) ?? BrowserLogger.error('pdf', 'PDF rendering failed', error, {code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'});
            file.pdfFailurePresentation.value = {
                failure: receipt,
                title: t('errors.file.open'),
                description: hasPdfjsAssetMismatch
                    ? t('errors.file.pdfjsAssetMismatch')
                    : t('errors.file.openDescription'),
                ...(message ? {technicalDetails: message} : {}),
                ...(hasPdfjsAssetMismatch
                    ? {actions: [{
                        label: t('errors.file.pdfjsAssetRepairAction'),
                        onClick: () => {
                            void copyTextToClipboard('pnpm install --frozen-lockfile').then((copied) => {
                                failure.presentCopyFeedback(copied);
                            });
                        },
                    }]}
                    : {}),
            };
        }
        function handleAnnotationComments(comments: IAnnotationCommentSummary[]) {
            if (
                annotations.annotationCommentsStatus.value === 'loading'
                && annotations.annotationComments.value.length > 0
                && comments.length === 0
                && view.isLoading.value
            ) {
                return;
            }
            annotations.applyAnnotationComments(comments);
        }
        return useWorkspaceDocumentDriverBinding({
            activeDocumentDriver: driver.mountedDocumentDriver,
            annotationCursorMode: navigation.annotationCursorMode,
            annotationKeepActive: annotations.annotationKeepActive,
            annotationSettings: annotations.annotationSettings,
            annotationTool: annotations.annotationTool,
            authorName: computed(() => appSettings.value.authorName),
            continuousScroll: view.continuousScroll,
            currentResultNavigationId: search.currentResultNavigationId,
            currentSearchMatch: computed(() => searchShown.value ? search.currentResult.value : null),
            documentSourceCurrentResultIndex: computed(() => (
                searchShown.value ? sourceSearch.currentResultIndex.value : -1
            )),
            documentSourceSearchResults: computed(() => searchShown.value ? sourceSearch.results.value : []),
            currentPage,
            dragMode: view.dragMode,
            isAnySaving: saveService.isAnySaving,
            isInteractionActive: isActive,
            mountPresentation: options.mountPresentation,
            isRenderActive: options.isRenderActive,
            isWorkspaceLayoutResizing: options.isWorkspaceLayoutResizing,
            pageMatches: computed(() => searchShown.value ? search.pageMatches.value : hiddenSearchPageMatches),
            pdfReloadSrc: file.pdfReloadSrc,
            pdfRasterDisplayProfile: file.pdfRasterDisplayProfile,
            pdfSrc,
            pendingDocumentPath: document.pendingDocumentPath,
            pdfViewerRef,
            djvuViewerRef: view.djvuViewerRef,
            sourcePdfData: pdfData,
            viewMode: view.viewMode,
            viewRotation: view.viewRotation,
            workingCopyPath,
            originalPath,
            documentRevisionToken,
            zoomState: view.zoomState,
            onAnnotationCommentClick: annotationActions.handleAnnotationCommentClick,
            onAnnotationComments: handleAnnotationComments,
            onAnnotationInventory: annotations.applyAnnotationInventory,
            onAnnotationEnrichmentState: annotations.applyAnnotationEnrichmentState,
            onAnnotationContextMenu: annotationActions.handleViewerAnnotationContextMenu,
            onAnnotationModified: annotationActions.handleAnnotationModified,
            onAnnotationFailure: failure.reportAnnotationFailure,
            onAnnotationOpenNote: annotationActions.handleOpenAnnotationNote,
            onAnnotationSetting: annotations.handleAnnotationSettingChange,
            onAnnotationState: annotations.handleAnnotationState,
            onAnnotationToolAutoReset: annotations.handleAnnotationToolAutoReset,
            onAnnotationToolCancel: annotations.handleAnnotationToolCancel,
            onCurrentPageUpdate: handleCurrentPage,
            onDocumentUpdate: (value) => { pdfDocument.value = value as typeof pdfDocument.value; },
            onEffectiveZoomUpdate: (value) => { view.effectiveZoom.value = value; },
            onInitialVisualPending: options.onInitialVisualPending,
            onInitialVisualReady: options.onInitialVisualReady,
            onLoadError: handleLoadError,
            onLoading: (value) => { view.isLoading.value = value; },
            onNavigationFeedbackPageUpdate: (value) => { options.navigationFeedbackPage.value = value; },
            onShapeContextMenu: annotationActions.handleShapeContextMenu,
            onSourceCapabilitiesUpdate: (capabilities) => {
                if (activeDriver.value) {
                    document.sourceCapabilities.value = capabilities;
                }
            },
            onPageSourceUpdate: (source) => { view.documentPageSource.value = source; },
            onTotalPagesUpdate: (value) => {
                if (activeDriver.value || value === 0) {
                    handleTotalPages(value);
                }
            },
            onZoomStateUpdate: view.setZoomState,
        });
    }

    const detachDocumentView = inject(documentViewDetachKey, null);
    const viewContext = {
        document,
        tabId,
        detachAndOpen: async (open: (workspace: IWorkspaceExpose) => Promise<boolean>) => {
            await detachDocumentView?.(tabId, open);
        },
        documentView,
        initialViewState,
        preserveInitialStateForFirstSource,
        openSurface,
        isActive,
        runDocumentOpen: deps.runDocumentOpen,
        emitOpenInNewTab: deps.emitOpenInNewTab,
        view,
        search,
        sourceSearch,
        navigation,
        bookmarkNavigationIntentVersion,
        pageContextMenu,
        scanCleanup,
        scanCleanupSourceSha256,
        annotationActions,
        statusBar,
        viewerDefaults,
        crop,
        handleCaptureRegion,
        handleDropdownOpen,
        djvuProjection,
        bindDocumentView,
    };
    // The document runs its commands in this view while its tab is the one
    // in use, and resets this view's panels when its source changes.
    onScopeDispose(document.attachView(viewContext));
    provideDocumentContext(document);
    provideDocumentViewContext(viewContext);
    // The viewer this workspace mounts edits the document's one annotation store.
    provide(pdfDocumentAnnotationsKey, document.pdfDocumentAnnotations);
    return viewContext;
};
export type TDocumentViewContext = ReturnType<typeof createDocumentViewContext>;

const documentViewContextKey: InjectionKey<TDocumentViewContext> = Symbol('documentViewContext');

/** The shell's way to give a tab that shares its document one of its own, then open there. */
export type TDocumentViewDetach = (
    tabId: string,
    open: (workspace: IWorkspaceExpose) => Promise<boolean>,
) => Promise<void>;
export const documentViewDetachKey: InjectionKey<TDocumentViewDetach> = Symbol('documentViewDetach');

export const provideDocumentViewContext = (context: TDocumentViewContext) => {
    provide(documentViewContextKey, context);
};

export const useDocumentViewContext = () => {
    const context = inject(documentViewContextKey);
    if (!context) {
        throw new Error('useDocumentViewContext needs a DocumentWorkspace ancestor.');
    }
    return context;
};
