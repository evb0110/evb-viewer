import type {
    InjectionKey,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import {
    useOcrTextContent,
    usePageContextMenu,
    usePdfHistory,
} from '@app/modules/pdf-viewer/public';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import { useUnencryptedSaveNotice } from '@app/modules/workspace-shell/composables/useUnencryptedSaveNotice';
import { useShutdownSaveFlushReporting } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useDocumentWorkspaceOptimizeDialog } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog';
import { useDocumentWorkspaceScanCleanupSurface } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import { useScanCleanupSourceSha256 } from '@app/modules/scan-cleanup/public/workspace';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';
import { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { usePageShortcuts } from '@app/modules/workspace-shell/composables/usePageShortcuts';
import { useWorkspaceCrop } from '@app/modules/workspace-shell/composables/useWorkspaceCrop';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import { resolveWorkspaceViewerViewMode } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { getDocumentPdfCapability } from '@app/utils/platformDocuments';
import { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';
import { useDocxExport } from '@app/composables/useDocxExport';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import { useMetadataSession } from '@app/modules/workspace-shell/composables/useMetadataSession';
import type {
    IWorkspaceDocumentController,
    IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { describeOpenResult } from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';
import { createPrintableSourceDataResolver } from '@app/modules/workspace-shell/composables/createPrintableSourceDataResolver';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runDetached } from '@app/utils/asyncGuard';
import {
    useWorkspaceDocumentDriver,
    useWorkspaceDocumentDriverBinding,
    type IWorkspaceDriverPrintRequest,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    createDocumentPageSourceSearchBackend,
    type IDocumentOpenSurfaceSession,
    type IDocumentSourceCapabilities,
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
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/public/runtime';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

interface IDocumentContextDeps {
    tabId: string;
    isActive: Ref<boolean>;
    controller: IWorkspaceDocumentController;
    initialViewState: ITabViewSessionState | null;
    openSurface: IDocumentOpenSurfaceSession;
    preserveInitialStateForFirstSource: boolean;
    /** Runs a user open as the tab controller's open transaction. */
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
 * The per-tab document context: the tab controller, the open surface, the
 * document file and viewer state, and the feature sessions built on them.
 * DocumentWorkspace creates it once and provides it; features inject it.
 */
export const createDocumentContext = (deps: IDocumentContextDeps) => {
    const {
        isActive,
        controller,
        openSurface,
    } = deps;
    const { t } = useTypedI18n();
    const toast = useToast();
    const openingTransaction = computed(() => {
        const transaction = controller.snapshot.value.activeTransaction;
        return transaction && transaction.kind !== 'close' ? transaction : null;
    });
    const isOpeningDocument = computed(() => openingTransaction.value !== null);
    const pendingDocumentPath = computed(() => openingTransaction.value?.target?.originalPath ?? null);
    const pendingDjvuDocumentOpen = computed(() => openingTransaction.value?.target?.isDjvu === true);
    // Every workspace failure that reaches the user goes through this one
    // surface, so save, annotation, and open failures share one toast path.
    const failure = useWorkspaceFailureSurface();
    const file = useWorkspaceFileLifecycleController({
        createViewerLifecycleHooks: context => driver.createLifecycleHooks(context),
        openSurface,
        failureSurface: failure,
    });
    const {
        workingCopyPath,
        documentRevisionToken,
        originalPath,
        pdfData,
        pdfSrc,
    } = file;
    const view = useWorkspaceViewerShellState(deps.initialViewState);
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
        initialSidebarWidth: deps.initialViewState?.sidebarWidth,
    });
    const {
        settings: appSettings,
        save: saveSettings,
        updateSetting,
    } = useSettings();
    const sourceCapabilities = ref<IDocumentSourceCapabilities>({
        annotations: false,
        directImageExport: false,
        outline: false,
        pageEdits: false,
        search: false,
        text: false,
    });
    const isSaving = ref(false);
    const isSavingAs = ref(false);
    const isHistoryBusy = ref(false);
    const lease = controller.operationLease;
    let operationQueueFeedbackShown = false;
    async function runExclusive<T>(kind: TDocumentOperationKind, operation: () => Promise<T>) {
        if (lease.activeKind.value === 'page-operation' && !operationQueueFeedbackShown) {
            operationQueueFeedbackShown = true;
            toast.add({
                color: 'info',
                title: t('notifications.documentBusyTitle'),
                description: t('notifications.switchingAfterPageProcessing'),
            });
        }
        try {
            return await lease.runExclusive(kind, operation);
        } finally {
            if (!lease.isBusy.value) {
                operationQueueFeedbackShown = false;
            }
        }
    }

    const metadata = useMetadataSession({
        pdfDocument,
        totalPages,
        workingCopyPath,
        documentRevisionToken,
        markDirty: file.markDirty,
        setWorkspaceCommandSink: file.setWorkspaceCommandSink,
    });
    const {
        pageLabelState, bookmarkState, workspaceUndoTimeline, 
    } = metadata;
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
        documentSession: controller,
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
    const { clearCache: clearOcrCache } = useOcrTextContent();

    const annotations = useWorkspaceAnnotationSession({
        pdfViewerRef,
        pdfDocument,
        dragMode: view.dragMode,
    });
    const hasPendingUnsavedChanges = computed(() => (
        annotations.hasUnsavedAnnotationChanges.value
        || file.isDirty.value
        || pageLabelState.pageLabelsDirty.value
        || bookmarkState.bookmarksDirty.value
    ));

    const unencryptedSaveNotice = useUnencryptedSaveNotice();
    const saveService = usePageSaveOrchestration({
        failureSurface: failure,
        pdfData,
        pdfDocument,
        pdfViewerRef,
        openSurface,
        workingCopyPath,
        originalPath,
        documentSessionKey: computed(() => controller.snapshot.value.identity.documentSessionKey),
        documentRevisionToken,
        wasEncrypted: file.wasEncrypted,
        unencryptedSaveNotice: {
            request: unencryptedSaveNotice.requestUnencryptedSaveNotice,
            suppress: computed(() => appSettings.value.suppressUnencryptedSaveNotice === true),
            updateSuppress: () => updateSetting('suppressUnencryptedSaveNotice', true),
            resetSuppress: () => {
                appSettings.value = {
                    ...appSettings.value,
                    suppressUnencryptedSaveNotice: false,
                };
            },
            flushSettings: saveSettings,
        },
        totalPages,
        pageLabelsDirty: pageLabelState.pageLabelsDirty,
        pageLabelRanges: pageLabelState.pageLabelRanges,
        bookmarksDirty: bookmarkState.bookmarksDirty,
        bookmarkItems: bookmarkState.bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty: annotations.annotationDirty,
        annotationNoteWindowsCount: computed(() => annotations.annotationNoteWindows.value.length),
        pendingEmbeddedAnnotationDeleteCount: annotations.pendingEmbeddedAnnotationDeleteCount,
        hasAnnotationChanges: annotations.hasAnnotationChanges,
        markAnnotationSaved: annotations.markAnnotationSaved,
        getAnnotationSaveStateToken: annotations.getAnnotationSaveStateToken,
        markPageLabelsSaved: pageLabelState.markPageLabelsSaved,
        getPageLabelsSaveStateToken: pageLabelState.getPageLabelsRevision,
        markBookmarksSaved: bookmarkState.markBookmarksSaved,
        getBookmarksSaveStateToken: bookmarkState.getBookmarksRevision,
        isDirty: file.isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath: path => getDocumentPdfCapability().validatePdfPath(path, {purpose: 'save'}),
        saveFile: file.saveFile,
        repairWorkingCopy: file.repairWorkingCopy,
        optimizeWorkingCopy: file.optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy: file.optimizeWorkingCopyAsCopy,
        saveWorkingCopy: file.saveWorkingCopy,
        trySavePdfNativeMutations: file.trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates: file.trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs: file.saveWorkingCopyAs,
        optimizePdfOnSaveAs: computed(() => appSettings.value.optimizePdfOnSaveAs),
        persistAllAnnotationNotes: annotations.persistAllAnnotationNotes,
        loadRecentFiles: () => {
            void file.loadRecentFiles();
        },
        currentPage,
        resetSearchCache: search.resetSearchCache,
        runWithDocumentOperationLease: runExclusive,
    });
    const driver = useWorkspaceDocumentDriver({
        djvuSourcePath: file.djvuSourcePath,
        isDjvuMode: file.isDjvuMode,
        pdfSrc,
        workingCopyPath,
        save: {
            save: saveService.handleSave,
            saveAs: saveService.handleSaveAs,
            saveAsDjvuProjection: () => file.ensureDjvuPdfProjection('save-as-pdf'),
        },
        pendingDocumentPath: pendingDocumentPath,
        pendingDocumentSize: computed(() => openSurface.snapshot.value.openingPageGeometry?.size ?? null),
    });
    const activeDriver = driver.activeDocumentDriver;
    watch(activeDriver, (active) => {
        if (active?.view.defaultSourceCapabilities) {
            sourceCapabilities.value = active.view.defaultSourceCapabilities;
        } else if (!active) {
            sourceCapabilities.value = {
                annotations: false,
                directImageExport: false,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            };
        }
    }, {immediate: true});
    const saveThroughDriver = (action: 'save' | 'save-as') => (
        activeDriver.value?.operations.save.execute(action) ?? Promise.resolve(false)
    );
    useShutdownSaveFlushReporting({
        workingCopyPath,
        hasPendingUnsavedChanges,
        requiresInteractiveDestination: file.requiresSaveAsOnFirstSave,
        saveForExternalRead: saveService.saveForExternalRead,
        flushAdditionalState: async () => {
            await saveSettings();
            await flushScanCleanupDocumentPreferencesStore();
            await flushScanCleanupPreferencesStore();
        },
    });
    async function ensureWorkingCopyFreshForRead() {
        return !hasPendingUnsavedChanges.value || saveService.saveForExternalRead();
    }
    const save = {
        canSave: saveService.canSave,
        isAnySaving: saveService.isAnySaving,
        hasSaveFailure: saveService.hasSaveFailure,
        isSaving,
        isSavingAs,
        hasPendingUnsavedChanges,
        handleSave: () => saveThroughDriver('save'),
        handleSaveAs: () => saveThroughDriver('save-as'),
        handleRepairSave: saveService.handleRepairSave,
        handleOptimizePdfForInteraction: saveService.handleOptimizePdfForInteraction,
        optimizeDialog: useDocumentWorkspaceOptimizeDialog({
            handleOptimizePdfAsCopy: saveService.handleOptimizePdfAsCopy,
            getLastFailurePresentation: failure.getLastFailurePresentation,
        }),
        createRecoverySnapshotBytes: saveService.createRecoverySnapshotBytes,
        ensureWorkingCopyFreshForRead,
    };

    const docx = useDocxExport();
    let docxExportCancellationVersion = 0;
    function cancelDocxExport() {
        docxExportCancellationVersion += 1;
        docx.cancelDocxExport();
    }
    async function handleExportDocx(selectedLanguages?: string[]) {
        if (docx.isExportingDocx.value) {
            cancelDocxExport();
            return;
        }
        const cancellationVersion = docxExportCancellationVersion;
        const exported = await runExclusive('docx-export', () => docx.exportDocx({
            workingCopyPath: workingCopyPath.value,
            documentRevisionToken: documentRevisionToken.value,
            pdfDocument: pdfDocument.value,
            ...(selectedLanguages === undefined ? {} : {selectedLanguages}),
        }));
        if (!exported && cancellationVersion === docxExportCancellationVersion) {
            view.openDropdown('ocr');
        }
    }
    const exportWorkflow = useWorkspaceExport({
        workingCopyPath,
        exportTargets: {
            imageTarget: computed(() => activeDriver.value?.operations.export.imageTarget ?? null),
            multiPageTiffTarget: computed(() => activeDriver.value?.operations.export.multiPageTiffTarget ?? null),
        },
        documentRevisionToken,
        totalPages,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease: runExclusive,
    });
    const docxExport = {
        error: docx.docxExportError,
        isExporting: docx.isExportingDocx,
        handleExportDocx,
        cancel: cancelDocxExport,
    };

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
        canUndoHistory: workspaceUndoTimeline.canUndoTimeline,
        canRedoHistory: workspaceUndoTimeline.canRedoTimeline,
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
    const pdfHistory = usePdfHistory({
        pdfDocument,
        pdfViewerRef,
        openSurface,
        currentPage,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy,
        canUndo: navigation.canUndo,
        canRedo: navigation.canRedo,
        nextUndoSource: workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: workspaceUndoTimeline.nextRedoSource,
        workingCopyPath,
        resetSearchCache: search.resetSearchCache,
        clearOcrCache: path => clearOcrCache(path),
        undoHistory: workspaceUndoTimeline.undoTimeline,
        redoHistory: workspaceUndoTimeline.redoTimeline,
    });
    // Search over a non-PDF page source (DjVu), shown by the source sidebar.
    const sourceSearch = useDocumentSearchSession({
        backend: computed(() => createDocumentPageSourceSearchBackend(view.documentPageSource.value)),
        documentRevision: documentRevisionToken,
        onNavigate: match => navigation.handleGoToPage(match.pageIndex + 1, {navigationSource: 'search'}),
    });
    const history = {
        isHistoryBusy,
        canUndo: navigation.canUndo,
        canRedo: navigation.canRedo,
        handleUndo: () => runExclusive('history', () => pdfHistory.handleUndo()),
        handleRedo: () => runExclusive('history', () => pdfHistory.handleRedo()),
    };
    const hasOpenDocument = computed(() => (
        file.hasPdf.value
        || (
            activeDriver.value?.capabilities.closeableDocument === true
            && activeDriver.value.source.path !== null
        )
    ));
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
        hasDocument: hasOpenDocument,
        pdfSrc,
        pdfData,
        originalPath: computed(() => pendingDocumentPath.value ?? originalPath.value),
        workingCopyPath,
        effectiveZoom: view.effectiveZoom,
        knownFileSizeBytes: file.djvuSourceSizeBytes,
        canSave: saveService.canSave,
        hasSaveFailure: saveService.hasSaveFailure,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy,
        handleSave: save.handleSave,
    });
    const pageOps = usePageOpsHandlers({
        workingCopyPath,
        documentRevisionToken,
        pageLabels: pageLabelState.pageLabels,
        pageLabelRanges: pageLabelState.pageLabelRanges,
        pageLabelsResolved: pageLabelState.pageLabelsResolved,
        bookmarkItems: bookmarkState.bookmarkItems,
        bookmarksResolved: bookmarkState.bookmarksResolved,
        currentPage,
        totalPages,
        selectedThumbnailPages: view.selectedThumbnailPages,
        setSelectedThumbnailPages: view.setSelectedThumbnailPages,
        selectedPageSelection: view.selectedPageSelection,
        setSelectedPageSelection: view.setSelectedPageSelection,
        invalidateThumbnailPages: view.requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu: pageContextMenu.pageContextMenu,
        closePageContextMenu: pageContextMenu.closePageContextMenu,
        onExportPages: (pages) => {
            void exportWorkflow.handleExportImages(pages);
        },
        canMutatePages: computed(() => sourceCapabilities.value.pageEdits),
        onExtractedDocument: deps.emitOpenInNewTab,
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation: saveService.createPageMutationWriterSave({
            currentPage,
            waitForPdfReload: pdfHistory.waitForPdfReload,
            loadPdfFromPath: file.loadPdfFromPath,
        }),
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
        // Page operations already hold the document-operation lease. The save
        // must keep the save queue, but cannot try to acquire that lease again.
        ensureWorkingCopyFreshForRead: async () => (
            !hasPendingUnsavedChanges.value
            || saveService.saveForExternalReadWithinDocumentOperationLease()
        ),
        preparePdfReloadWaiter: pdfHistory.preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache: search.resetSearchCache,
        runWithDocumentOperationLease: runExclusive,
    });
    const fileOps = usePageFileOperations({
        tabId: deps.tabId,
        pdfSrc,
        hasDocument: hasOpenDocument,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy,
        isExportingDocx: docx.isExportingDocx,
        isAnyAnnotationNoteSaving: annotations.isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress: lease.isBusy,
        hasSaveFailure: saveService.hasSaveFailure,
        annotationNoteWindows: annotations.annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty: annotations.annotationDirty,
        isDirty: file.isDirty,
        recoveryDirtyBaseline: file.recoveryDirtyBaseline,
        pageLabelsDirty: pageLabelState.pageLabelsDirty,
        bookmarksDirty: bookmarkState.bookmarksDirty,
        persistAllAnnotationNotes: annotations.persistAllAnnotationNotes,
        handleSave: save.handleSave,
        pickFileToOpen: file.pickFileToOpen,
        openFile: file.openFileWithViewerLifecycle,
        openFileDirect: file.openFileDirectWithViewerLifecycle,
        openFileDirectBatch: file.openFileDirectBatchWithViewerLifecycle,
        runDocumentOpen: deps.runDocumentOpen,
        closeFile: file.closeFileWithViewerLifecycle,
        closeAllDropdowns: view.closeAllDropdowns,
        emitOpenInNewTab: deps.emitOpenInNewTab,
    });

    const getPrintableSourceData = createPrintableSourceDataResolver({
        hasPendingUnsavedChanges,
        pdfData,
        pdfViewerRef,
        source: {getSourcePdfData: saveService.getSourcePdfData},
        workingCopyPath,
        originalPath,
        documentRevisionToken,
        runWithDocumentOperationLease: runExclusive,
    });
    async function getQuickPrintPageMetrics() {
        const viewer = pdfViewerRef.value;
        const total = totalPages.value;
        if (!viewer || total <= 0) {
            return null;
        }
        const samplePages = uniq([
            1,
            clamp(currentPage.value, 1, total),
            Math.max(1, Math.ceil(total / 2)),
            total,
        ]).sort((left, right) => left - right);
        for (const pageNumber of samplePages) {
            await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
        }
        const metrics = viewer.getPageMetricsSnapshot?.() ?? [];
        const sampledMetrics = samplePages.flatMap((pageNumber) => {
            const metric = metrics[pageNumber - 1] ?? null;
            return metric
                && Number.isFinite(metric.width) && metric.width > 0
                && Number.isFinite(metric.height) && metric.height > 0
                ? [metric]
                : [];
        });
        return sampledMetrics.length === samplePages.length ? sampledMetrics : null;
    }
    const print = useWorkspacePrint({
        totalPages,
        currentPage,
        selectedPages: view.selectedThumbnailPages,
        selectedPageSelection: view.selectedPageSelection,
        sourcePdf: pdfSrc,
        workingCopyPath,
        printPath: computed(() => activeDriver.value?.operations.print.path ?? null),
        fileName: file.fileName,
        hasPendingUnsavedChanges,
        hasPendingPrintSerializationChanges: annotations.hasUnsavedAnnotationChanges,
        getCurrentPrintPage: () => documentViewerRef.value?.getCurrentPage?.() ?? currentPage.value,
        getQuickPrintPageMetrics,
        isDriverOwnedQuickPrint: () => activeDriver.value?.canPreparePrint === true,
        ensurePrintReady: async () => (
            !annotations.hasOpenAnnotationNotes.value || annotations.persistAllAnnotationNotes()
        ),
        ensureWorkingCopyFreshForRead,
        getLastFailurePresentation: failure.getLastFailurePresentation,
        getPrintableSourceData,
        renderLoadedPdfPagesForBrowserPrint: async (
            targetDocument: IBrowserPrintDocument,
            pageNumbers: number[],
            options?: { signal?: AbortSignal },
        ) => {
            const viewer = pdfViewerRef.value;
            if (!viewer?.renderLoadedPdfPagesForBrowserPrint) {
                throw new Error('Loaded PDF printing is unavailable');
            }
            await viewer.renderLoadedPdfPagesForBrowserPrint(
                targetDocument,
                pageNumbers.map(pageNumber => requirePageNumber(pageNumber, totalPages.value)),
                options,
            );
        },
        preparePrintSource: (
            payload: IWorkspaceDriverPrintRequest,
            options?: {
                onNativePrintHandoffStart?: () => void;
                signal?: AbortSignal
            },
        ) => activeDriver.value?.run({
            kind: 'prepare-print',
            request: payload,
            fileName: file.fileName.value,
            sourceCapabilities: sourceCapabilities.value,
            ...(options?.onNativePrintHandoffStart === undefined
                ? {}
                : {onNativePrintHandoffStart: options.onNativePrintHandoffStart}),
            ...(options?.signal === undefined ? {} : {signal: options.signal}),
        }) ?? Promise.resolve({
            status: 'unavailable' as const,
            capability: 'print' as const,
        }),
    });

    const viewerCapabilities = computed(() => activeDriver.value?.capabilities);
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
        preserveInitialStateForFirstSource: deps.preserveInitialStateForFirstSource,
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
            && (file.hasPdf.value || sourceCapabilities.value.directImageExport)
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
        void runDetached(() => viewer.captureRegionToClipboard(), {
            category: 'user-visible-operation',
            scope: 'workspace',
            message: 'Failed to capture PDF region',
        });
    }
    // A split restore reopens its payload as the tab's open transaction.
    async function openSplitPayloadResult(result: TOpenFileResult) {
        const opened: {outcome: TDocumentOpenOutcome} = {outcome: {status: 'cancelled'}};
        const presented = await deps.runDocumentOpen(describeOpenResult(result), async () => {
            opened.outcome = await file.openFileWithViewerLifecycle(result);
            return didOpenDocument(opened.outcome);
        });
        return presented || !didOpenDocument(opened.outcome) ? opened.outcome : {status: 'cancelled' as const};
    }
    const splitPayload = useWorkspaceSplitPayload({
        pdfSrc,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        currentPage,
        totalPages,
        fileName: file.fileName,
        originalPath,
        workingCopyPath,
        hasPendingTabChanges: hasPendingUnsavedChanges,
        requiresSaveAsOnFirstSave: file.requiresSaveAsOnFirstSave,
        pdfViewerRef,
        documentViewerRef,
        pdfData,
        openFileWithViewerLifecycle: openSplitPayloadResult,
        waitForPdfReload: pdfHistory.waitForPdfReload,
        loadPdfFromPath: file.loadPdfFromPath,
        documentRevisionToken,
        getNativeSaveTransactionOptions: saveService.getNativeSaveTransactionOptions,
        runWithDocumentOperationLease: runExclusive,
    });
    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        view.handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            docx.clearDocxExportError();
        }
    }

    const djvuProjection = useDjvuProjectionActions({
        isDjvuMode: file.isDjvuMode,
        currentPage,
        documentViewerRef,
        ensureProjection: file.ensureDjvuPdfProjection,
        saveAs: save.handleSaveAs,
        exportDocx: handleExportDocx,
        isExportingDocx: docx.isExportingDocx,
        cancelExportDocx: cancelDocxExport,
        handleDropdownOpen,
        insertImageFromFile: annotationActions.insertImageFromFile,
        pasteImageFromClipboard: annotationActions.pasteImageFromClipboard,
        createQuickNote: annotationActions.handleQuickNoteAction,
    });

    const {handleOcrComplete} = useWorkspaceDocumentLifecycleEffects({
        currentPage,
        totalPages,
        pdfDocument,
        pdfViewerRef,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        showSettings: view.showSettings,
        emitOpenSettings: deps.emitOpenSettings,
        pdfSrc,
        workingCopyPath,
        documentRevisionInfo: file.documentRevisionInfo,
        documentRevisionToken,
        pdfError: file.pdfError,
        dragMode: view.dragMode,
        showSidebar: view.showSidebar,
        sidebarTab: view.sidebarTab,
        annotationTool: annotations.annotationTool,
        annotationComments: annotations.annotationComments,
        markAnnotationCommentsLoading: annotations.markAnnotationCommentsLoading,
        clearAnnotationComments: annotations.clearAnnotationComments,
        annotationActiveCommentStableKey: annotations.annotationActiveCommentStableKey,
        annotationEditorState: annotations.annotationEditorState,
        bookmarkItems: bookmarkState.bookmarkItems,
        bookmarksDirty: bookmarkState.bookmarksDirty,
        bookmarkEditMode: bookmarkState.bookmarkEditMode,
        consumePreservedSourceReloadMetadata: metadata.consumePreservedSourceReloadMetadata,
        navigationTicket: computed(() => openSurface.navigationTicket.value),
        pageLabels: pageLabelState.pageLabels,
        pageLabelRanges: pageLabelState.pageLabelRanges,
        pageLabelsDirty: pageLabelState.pageLabelsDirty,
        resetAnnotationTracking: annotations.resetAnnotationTracking,
        resetSearchCache: search.resetSearchCache,
        closeSearch: search.closeSearch,
        closeAnnotationContextMenu: annotations.closeAnnotationContextMenu,
        closePageContextMenu: pageContextMenu.closePageContextMenu,
        closeAllAnnotationNotes: annotations.closeAllAnnotationNotes,
        loadRecentFiles: () => {
            void file.loadRecentFiles();
        },
        clearOcrCache,
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
        waitForPdfReload: pdfHistory.waitForPdfReload,
        runWithDocumentOperationLease: runExclusive,
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
            pendingDocumentPath: pendingDocumentPath,
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
            onRasterSchedulerUpdate: (scheduler) => { view.pdfRasterScheduler.value = scheduler; },
            onEffectiveZoomUpdate: (value) => { view.effectiveZoom.value = value; },
            onInitialVisualPending: options.onInitialVisualPending,
            onInitialVisualReady: options.onInitialVisualReady,
            onLoadError: handleLoadError,
            onLoading: (value) => { view.isLoading.value = value; },
            onNavigationFeedbackPageUpdate: (value) => { options.navigationFeedbackPage.value = value; },
            onShapeContextMenu: annotationActions.handleShapeContextMenu,
            onSourceCapabilitiesUpdate: (capabilities) => {
                if (activeDriver.value) {
                    sourceCapabilities.value = capabilities;
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

    return {
        tabId: deps.tabId,
        controller,
        openSurface,
        isOpeningDocument,
        pendingDjvuDocumentOpen,
        isActive,
        sourceCapabilities,
        failure,
        runExclusive,
        file,
        view,
        search,
        sourceSearch,
        driver,
        bindDocumentView,
        viewerCapabilities,
        metadata,
        bookmarkNavigationIntentVersion,
        pageContextMenu,
        scanCleanup,
        scanCleanupSourceSha256,
        annotations,
        annotationActions,
        save,
        exportWorkflow,
        docxExport,
        navigation,
        history,
        statusBar,
        pageOps,
        fileOps,
        print,
        crop,
        splitPayload,
        viewerDefaults,
        handleCaptureRegion,
        djvuProjection,
        handleOcrComplete,
    };
};
export type TDocumentContext = ReturnType<typeof createDocumentContext>;

const documentContextKey: InjectionKey<TDocumentContext> = Symbol('documentContext');

export const provideDocumentContext = (context: TDocumentContext) => {
    provide(documentContextKey, context);
};

export const useDocumentContext = () => {
    const context = inject(documentContextKey);
    if (!context) {
        throw new Error('useDocumentContext needs a DocumentWorkspace ancestor.');
    }
    return context;
};
