import type {
    InjectionKey,
    Ref,
} from 'vue';
import {
    pdfDocumentAnnotationsKey,
    pdfDocumentSessionSlotKey,
    usePageContextMenu,
} from '@app/modules/pdf-viewer/public';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { useAnnotationContextMenu } from '@app/modules/workspace-shell/composables/useAnnotationContextMenu';
import { useViewAnnotationTool } from '@app/modules/workspace-shell/composables/useViewAnnotationTool';
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
import { beginOpenSurfaceWithPageShape } from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runDetached } from '@app/utils/asyncGuard';
import { requirePageNumber } from '@contracts/pageNumbers';
import { useWorkspaceDocumentDriverBinding } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    createDocumentPageSourceSearchBackend,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import { useDocumentSearchSession } from '@app/modules/workspace-shell/composables/useDocumentSearchSession';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';
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
    // The tab's view seeds this mount: a cold or restored tab returns there.
    const initialViewState = documentView.viewState.value;
    const preserveInitialStateForFirstSource = documentView.restored
        || (controller.snapshot.value.phase === 'presented' && documentView.toolbarSnapshot.value.initialVisualReady);
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
    // What this view shows of the document: its page, zoom, panels and selection.
    const view = useWorkspaceViewerShellState(initialViewState, openSurface);
    const {
        pdfViewerRef,
        documentViewerRef,
        currentPage,
        totalPages,
        pdfDocument,
    } = view;
    // Saves capture before clearing; page mutations own their page remapping.
    watch(pdfSrc, (source, previous) => {
        const identity = openSurface.snapshot.value.identity;
        if (!saveService.isAnySaveAdmitted.value || !source || !previous || !identity || document.isOpeningDocument.value) {
            return;
        }
        beginOpenSurfaceWithPageShape(openSurface, {
            documentId: identity.documentId,
            documentRevision: String(documentRevisionToken.value ?? identity.documentRevision),
            provisional: true,
        }, documentView.captureReadingAnchor() ?? currentPage.value, null);
    }, {flush: 'sync'});

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
    // The document's page operations as this view starts them: on its
    // selection and page context menu, extracting next to its tab.
    const pageOps = {
        ...document.pageOps,
        ...document.pageOps.forView({
            selectedThumbnailPages: view.selectedThumbnailPages,
            setSelectedThumbnailPages: view.setSelectedThumbnailPages,
            selectedPageSelection: view.selectedPageSelection,
            setSelectedPageSelection: view.setSelectedPageSelection,
            pageContextMenu: pageContextMenu.pageContextMenu,
            closePageContextMenu: pageContextMenu.closePageContextMenu,
            emitOpenInNewTab: deps.emitOpenInNewTab,
        }),
    };
    // The document's print with this view's selection and page.
    const viewPrint = {
        ...print,
        handlePrint: () => print.handlePrint({
            selectedPages: view.selectedThumbnailPages.value,
            pageSelection: view.selectedPageSelection.value,
        }),
        handlePrintCurrentPage: () => print.handlePrintCurrentPage(
            documentViewerRef.value?.getCurrentPage?.() ?? currentPage.value,
        ),
    };

    const bookmarkNavigationIntentVersion = ref(0);
    // The page a new navigation command steps from: the in-flight target
    // while one is pending, so held paging keys compose.
    const navigationPage = computed(() => {
        const ticket = openSurface.navigationTicket.value;
        if (!ticket) {
            return currentPage.value;
        }
        return 'page' in ticket.request.target
            ? ticket.request.target.page
            : openSurface.viewportSession.value.requestedPage;
    });
    // Automation's navigation-idle: the surface names a settled page and no
    // navigation is in flight.
    watch([
        currentPage,
        () => openSurface.navigationTicket.value,
    ], ([page, ticket], [previousPage, previousTicket]) => {
        if (ticket || (page === previousPage && !previousTicket)) {
            return;
        }
        emitAutomationEvent('navigation-idle', {
            navigationSource: previousTicket?.request.source ?? null,
            page,
            previousPage,
            tabId,
            totalPages: totalPages.value,
        });
    }, {flush: 'post'});
    // This view's annotation context menu and annotation tool: one per view,
    // like its page context menu and selection.
    const annotationContextMenu = useAnnotationContextMenu();
    const annotationToolState = useViewAnnotationTool({
        pdfViewerRef,
        dragMode: view.dragMode,
        annotationKeepActive: annotations.annotationKeepActive,
        closeAnnotationContextMenu: annotationContextMenu.closeAnnotationContextMenu,
    });
    const {
        annotationTool,
        handleAnnotationToolChange,
    } = annotationToolState;
    // Drag mode leaves this view's tool and text selection; hiding its
    // bookmarks ends the document's bookmark editing.
    watch(view.dragMode, (enabled) => {
        if (enabled) {
            window.getSelection()?.removeAllRanges();
            annotationTool.value = 'none';
        }
    });
    watch(() => view.showSidebar.value && view.sidebarTab.value === 'bookmarks', (showsBookmarks) => {
        if (!showsBookmarks) {
            metadata.bookmarkState.bookmarkEditMode.value = false;
        }
    });
    const navigation = useWorkspaceViewState({
        fitMode: view.fitMode,
        zoomMode: view.zoomMode,
        zoom: view.zoom,
        dragMode: view.dragMode,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        annotationTool,
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
        annotationTool,
        annotationActiveCommentStableKey: annotations.annotationActiveCommentStableKey,
        annotationContextMenu: annotationContextMenu.annotationContextMenu,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        dragMode: view.dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu: annotationContextMenu.closeAnnotationContextMenu,
        showAnnotationContextMenu: annotationContextMenu.showAnnotationContextMenu,
        handleAnnotationToolChange,
        // A note opens in this view.
        openAnnotationNoteWindow: comment => annotations.openAnnotationNoteWindow(comment, tabId),
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
        documentViewerRef: view.documentViewerRef,
        viewRotation: view.viewRotation,
        // The source shown: a DjVu, or the working copy a PDF opened from (which
        // Save As does not change), committed with its pages in one step.
        documentSourceKey: computed(() => (file.isDjvuMode.value ? file.djvuSourcePath.value : null)
            ?? file.openedWorkingCopyPath.value ?? pdfSrc.value),
    });
    // Conversion reopens the same reading session as a PDF. Its view seed
    // survives the source reset, and cancellation withdraws the unused seed.
    watch(() => file.conversionState.value.isConverting, (converting, _previous, onCleanup) => {
        if (converting) {
            documentView.captureReadingAnchor();
            onCleanup(viewerDefaults.seedViewForSource({
                zoom: view.zoom.value,
                zoomMode: view.zoomMode.value,
                continuousScroll: view.continuousScroll.value,
                viewMode: view.viewMode.value,
                viewRotation: view.viewRotation.value,
            }, null));
        }
    }, {flush: 'sync'});

    const imageCommandGuard = {
        category: 'user-visible-operation',
        scope: 'workspace',
        message: 'Failed to insert image',
    } as const;
    usePageShortcuts({
        isActive: computed(() => isActive.value && !document.isMoving.value),
        hasInteractiveDocument: computed(() => Boolean(pdfSrc.value ?? file.djvuSourcePath.value)),
        pdfSrc,
        canPrint: computed(() => (
            driver.activeDocumentDriver.value?.capabilities.print === true
            && (file.hasPdf.value || document.sourceCapabilities.value.directImageExport)
        )),
        canSave: saveService.canSave,
        annotationTool,
        pdfViewerRef,
        annotationContextMenuVisible: computed(() => annotationContextMenu.annotationContextMenu.value.visible),
        pageContextMenuVisible: computed(() => pageContextMenu.pageContextMenu.value.visible),
        closeAnnotationContextMenu: annotationContextMenu.closeAnnotationContextMenu,
        closePageContextMenu: pageContextMenu.closePageContextMenu,
        openSearch: search.openSearch,
        handleAnnotationToolChange,
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
        handlePrint: viewPrint.handlePrint,
        handleToggleSidebar: () => {
            view.showSidebar.value = !view.showSidebar.value;
        },
        handleInsertImageFromFile: () => void runDetached(djvuProjection.handleInsertImageFromFile, imageCommandGuard),
        handlePasteImageFromClipboard: () => void runDetached(djvuProjection.handlePasteImageFromClipboard, imageCommandGuard),
        handlePasteImageFile: file => void runDetached(() => djvuProjection.runEdit(() => pdfViewerRef.value?.startImagePlacement(file, {
            pageNumber: requirePageNumber(currentPage.value),
            pageX: 0.5,
            pageY: 0.5,
        })), imageCommandGuard),
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
        void runDetached(() => viewer.captureRegionToClipboard(), {
            category: 'user-visible-operation',
            scope: 'workspace',
            message: 'Failed to capture PDF region',
        });
    }
    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr',
        isOpen: boolean,
    ) {
        view.handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            document.docx.clearDocxExportError();
        }
    }

    const djvuProjection = useDjvuProjectionActions({
        isDjvuMode: file.isDjvuMode,
        documentRef: originalPath,
        openSurface,
        ensureProjection: file.ensureDjvuPdfProjection,
        saveAs: save.handleSaveAs,
        exportDocx: languages => document.docxExport.handleExportDocx(languages, () => view.openDropdown('ocr')),
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
        function handleLoadError(error: unknown) {
            if (error === null || error === undefined) {
                file.pdfError.value = null;
                file.pdfFailurePresentation.value = null;
                return;
            }
            const presentation = failure.describeOpenFailure(error);
            file.pdfFailurePresentation.value = presentation;
            file.pdfError.value = presentation.description;
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
            annotationTool,
            authorName: computed(() => appSettings.value.authorName),
            continuousScroll: view.continuousScroll,
            currentResultNavigationId: search.currentResultNavigationId,
            currentSearchMatch: computed(() => searchShown.value ? search.currentResult.value : null),
            documentSourceCurrentResultIndex: computed(() => (
                searchShown.value ? sourceSearch.currentResultIndex.value : -1
            )),
            documentSourceSearchResults: computed(() => searchShown.value ? sourceSearch.results.value : []),
            dragMode: view.dragMode,
            isAnySaving: saveService.isAnySaving,
            isInteractionActive: isActive,
            mountPresentation: options.mountPresentation,
            isRenderActive: options.isRenderActive,
            isWorkspaceLayoutResizing: options.isWorkspaceLayoutResizing,
            pageMatches: computed(() => searchShown.value ? search.pageMatches.value : hiddenSearchPageMatches),
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
            onAnnotationContextMenu: annotationActions.handleViewerAnnotationContextMenu,
            onAnnotationModified: annotationActions.handleAnnotationModified,
            onAnnotationFailure: failure.reportAnnotationFailure,
            onAnnotationOpenNote: annotationActions.handleOpenAnnotationNote,
            onAnnotationSetting: annotations.handleAnnotationSettingChange,
            onAnnotationState: annotations.handleAnnotationState,
            onAnnotationToolAutoReset: annotationToolState.handleAnnotationToolAutoReset,
            onAnnotationToolCancel: () => { void annotationToolState.handleAnnotationToolCancel(); },
            onDocumentUpdate: (value) => { pdfDocument.value = value as typeof pdfDocument.value; },
            onInitialVisualPending: options.onInitialVisualPending,
            onInitialVisualReady: options.onInitialVisualReady,
            onLoadError: handleLoadError,
            onLoading: (value) => { view.isLoading.value = value; },
            onShapeContextMenu: annotationActions.handleShapeContextMenu,
            onSourceCapabilitiesUpdate: (capabilities) => {
                if (driver.activeDocumentDriver.value) {
                    document.sourceCapabilities.value = capabilities;
                }
            },
            onPageSourceUpdate: (source) => { view.documentPageSource.value = source; },
            onTotalPagesUpdate: (value) => {
                // A source being replaced reports no pages before its successor counts them.
                if ((driver.activeDocumentDriver.value || value === 0) && !(value === 0 && pdfSrc.value)) {
                    totalPages.value = value;
                }
            },
            onZoomStateUpdate: view.setZoomState,
        });
    }

    const detachDocumentView = inject(documentViewDetachKey, null);
    const detachAndOpen = async (open: (workspace: IWorkspaceExpose) => Promise<boolean>) => {
        await detachDocumentView?.(tabId, open);
    };
    // Opening another file in a view of a shared document detaches only this
    // view (T4); the document stays with its other views, asking nothing. A
    // hidden, unmounted view still shows it. A tab loading the document's own
    // file, as a restored or cold tab does when shown, loads it for all views.
    const sharesViews = computed(() => controller.views.value.size > 1);
    function openInOwnDocument(open: (workspace: IWorkspaceExpose) => Promise<boolean>) {
        void detachAndOpen(open);
        return Promise.resolve<TDocumentOpenOutcome>({status: 'cancelled'});
    }
    const fileOps = usePageFileOperations({
        tabId,
        pdfSrc,
        hasDocument: document.hasOpenDocument,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy: document.history.isHistoryBusy,
        isExportingDocx: document.docx.isExportingDocx,
        isAnyAnnotationNoteSaving: annotations.isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress: controller.operationLease.isBusy,
        hasSaveFailure: saveService.hasSaveFailure,
        annotationNoteWindows: annotations.annotationNoteWindows,
        hasPendingUnsavedChanges: computed(() => !sharesViews.value && save.hasPendingUnsavedChanges.value),
        annotationDirty: annotations.annotationDirty,
        isDirty: file.isDirty,
        recoveryDirtyBaseline: file.recoveryDirtyBaseline,
        pageLabelsDirty: metadata.pageLabelState.pageLabelsDirty,
        bookmarksDirty: metadata.bookmarkState.bookmarksDirty,
        persistAllAnnotationNotes: annotations.persistAllAnnotationNotes,
        handleSave: save.handleSave,
        pickFileToOpen: file.pickFileToOpen,
        openFile: result => (sharesViews.value
            ? openInOwnDocument(workspace => (result ? workspace.handleOpenFileWithResult(result) : workspace.handleOpenFileFromUi()))
            : file.openFileWithViewerLifecycle(result)),
        openFileDirect: path => (sharesViews.value && (path !== controller.snapshot.value.identity.originalPath || save.hasPendingUnsavedChanges.value)
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectWithPersist(path))
            : file.openFileDirectWithViewerLifecycle(path)),
        openFileDirectBatch: paths => (sharesViews.value
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectBatchWithPersist(paths))
            : file.openFileDirectBatchWithViewerLifecycle(paths)),
        runDocumentOpen: (request, run) => document.views.runDocumentOpen(viewContext, request, run),
        closeFile: file.closeFileWithViewerLifecycle,
        closeAllDropdowns: view.closeAllDropdowns,
        emitOpenInNewTab: deps.emitOpenInNewTab,
    });
    const viewContext = {
        document,
        tabId,
        detachAndOpen,
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
        pageOps,
        print: viewPrint,
        fileOps,
        annotationContextMenu,
        closeAnnotationContextMenu: annotationContextMenu.closeAnnotationContextMenu,
        annotationTool,
        annotationToolState,
        scanCleanup,
        scanCleanupSourceSha256,
        annotationActions,
        // The annotations this view's viewer has selected.
        selectedAnnotations: computed(() => pdfViewerRef.value?.selectedAnnotations ?? []),
        statusBar,
        viewerDefaults,
        crop,
        handleCaptureRegion,
        handleDropdownOpen,
        djvuProjection,
        bindDocumentView,
    };
    // The document resets this view's panels when its source changes and
    // keeps it on its page through its reloads.
    onScopeDispose(document.views.attachView(viewContext));
    provideDocumentContext(document);
    provideDocumentViewContext(viewContext);
    // The viewer this workspace mounts shows the document's one PDF.js
    // document and edits its one annotation store.
    provide(pdfDocumentSessionSlotKey, document.pdfDocumentSessionSlot);
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
