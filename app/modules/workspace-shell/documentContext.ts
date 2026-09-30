import type { InjectionKey } from 'vue';
import { uniq } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import {
    createPdfDocumentAnnotations,
    useOcrTextContent,
    usePageContextMenu,
    usePdfHistory,
    type IPdfDocument,
    type IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import { useUnencryptedSaveNotice } from '@app/modules/workspace-shell/composables/useUnencryptedSaveNotice';
import { useShutdownSaveFlushReporting } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useDocumentWorkspaceOptimizeDialog } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { requirePageNumber } from '@contracts/pageNumbers';
import { getDocumentPdfCapability } from '@app/utils/platformDocuments';
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
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import {
    useWorkspaceDocumentDriver,
    type IWorkspaceDriverPrintRequest,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentSourceCapabilities,
    type TDocumentSidebarTab,
} from '@app/modules/document-viewer/public';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import {
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/public/runtime';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import {
    createDocumentViews,
    type TViewShellState,
} from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

interface IDocumentContextDeps {controller: IWorkspaceDocumentController;}

/**
 * One document's context: the controller, the working copy and its
 * lifecycle, metadata, annotations, save, history, page and file operations,
 * print and export. DocumentSessionHost creates it once per document, outside
 * any tab's mount, so it outlives the views that show it. Each mounted view
 * attaches a port; commands that need a page, a selection or a viewer run in
 * the view whose tab is in use.
 */
export const createDocumentContext = (deps: IDocumentContextDeps) => {
    const {controller} = deps;
    const { t } = useTypedI18n();
    const toast = useToast();
    const openingTransaction = computed(() => {
        const transaction = controller.snapshot.value.activeTransaction;
        return transaction && transaction.kind !== 'close' ? transaction : null;
    });
    const isOpeningDocument = computed(() => openingTransaction.value !== null);
    const pendingDocumentPath = computed(() => openingTransaction.value?.target?.originalPath ?? null);
    const pendingDjvuDocumentOpen = computed(() => openingTransaction.value?.target?.isDjvu === true);
    const views = createDocumentViews();
    const {
        viewPorts, commandView, commandViewRef, loadedView,
    } = views;
    const idleOpenSurface = createDocumentOpenSurfaceSession();
    const commandOpenSurface = {
        get snapshot() {
            return (commandView.value?.openSurface ?? idleOpenSurface).snapshot;
        },
        get viewportSession() {
            return (commandView.value?.openSurface ?? idleOpenSurface).viewportSession;
        },
        get navigationTicket() {
            return (commandView.value?.openSurface ?? idleOpenSurface).navigationTicket;
        },
    };
    const pdfViewerRef = commandViewRef<IPdfViewerExpose | null>(port => port.view.pdfViewerRef, null);
    const documentViewerRef = computed(() => commandView.value?.view.documentViewerRef.value ?? null);
    const currentPage = commandViewRef(port => port.view.currentPage, 1);
    const totalPages = commandViewRef(port => port.view.totalPages, 0);
    const pdfDocument = commandViewRef<IPdfDocument | null>(port => port.view.pdfDocument, null);
    const viewPort = {
        dragMode: commandViewRef(port => port.view.dragMode, false),
        showSidebar: commandViewRef(port => port.view.showSidebar, false),
        sidebarTab: commandViewRef<TDocumentSidebarTab>(port => port.view.sidebarTab, 'thumbnails'),
        selectedThumbnailPages: commandViewRef<number[]>(port => port.view.selectedThumbnailPages, []),
        selectedPageSelection: commandViewRef<TPageSelection | null>(port => port.view.selectedPageSelection, null),
        setSelectedThumbnailPages: (pages: number[]) => commandView.value?.view.setSelectedThumbnailPages(pages),
        setSelectedPageSelection: (selection: TPageSelection) => commandView.value?.view.setSelectedPageSelection(selection),
        requestThumbnailInvalidation: (...args: Parameters<TViewShellState['requestThumbnailInvalidation']>) => (
            commandView.value?.view.requestThumbnailInvalidation(...args)
        ),
        closeAllDropdowns: () => commandView.value?.view.closeAllDropdowns(),
        openDropdown: (...args: Parameters<TViewShellState['openDropdown']>) => commandView.value?.view.openDropdown(...args),
    };
    const idlePageContextMenu = usePageContextMenu().pageContextMenu;
    const pageContextMenu = {
        pageContextMenu: computed(() => commandView.value?.pageContextMenu.pageContextMenu.value ?? idlePageContextMenu.value),
        closePageContextMenu: () => commandView.value?.pageContextMenu.closePageContextMenu(),
    };
    // A document source change resets every view's search, not only the one in use.
    function resetSearchCaches() {
        for (const port of viewPorts.value.values()) {
            port.search.resetSearchCache();
        }
    }
    function closeSearches() {
        for (const port of viewPorts.value.values()) {
            port.search.closeSearch();
        }
    }
    function runDocumentOpen(request: IWorkspaceOpenRequest, run: () => Promise<boolean>) {
        const port = commandView.value;
        return port ? port.runDocumentOpen(request, run) : controller.runOpen(request, run);
    }
    function emitOpenInNewTab(result: TDocumentRef | TOpenFileResult) {
        commandView.value?.emitOpenInNewTab(result);
    }
    // Every workspace failure that reaches the user goes through this one
    // surface, so save, annotation, and open failures share one toast path.
    const failure = useWorkspaceFailureSurface();
    const file = useWorkspaceFileLifecycleController({
        createViewerLifecycleHooks: context => driver.createLifecycleHooks(context),
        getOpenSurface: () => commandView.value?.openSurface ?? null,
        failureSurface: failure,
    });
    const {
        workingCopyPath,
        documentRevisionToken,
        originalPath,
        pdfData,
        pdfSrc,
    } = file;
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
    const commandCanUndo = computed(() => commandView.value?.navigation.canUndo.value ?? false);
    const commandCanRedo = computed(() => commandView.value?.navigation.canRedo.value ?? false);
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
        pdfDocument: computed(() => loadedView.value?.view.pdfDocument.value ?? null),
        totalPages: computed(() => loadedView.value?.view.totalPages.value ?? 0),
        workingCopyPath,
        documentRevisionToken,
        markDirty: file.markDirty,
        setWorkspaceCommandSink: file.setWorkspaceCommandSink,
    });
    const {
        pageLabelState, bookmarkState, workspaceUndoTimeline, 
    } = metadata;
    // One canonical annotation store, history and draft set for every view.
    const pdfDocumentAnnotations = createPdfDocumentAnnotations({
        workingCopyPath,
        source: pdfSrc,
        documentRevisionToken,
    });
    const { clearCache: clearOcrCache } = useOcrTextContent();

    const annotations = useWorkspaceAnnotationSession({
        views,
        pdfDocument,
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
        openSurface: commandOpenSurface,
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
        resetSearchCache: resetSearchCaches,
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
        pendingDocumentSize: computed(() => commandOpenSurface.snapshot.value.openingPageGeometry?.size ?? null),
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
            viewPort.openDropdown('ocr');
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

    const pdfHistory = usePdfHistory({
        pdfDocument,
        pdfViewerRef,
        openSurface: commandOpenSurface,
        currentPage,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy,
        canUndo: commandCanUndo,
        canRedo: commandCanRedo,
        nextUndoSource: workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: workspaceUndoTimeline.nextRedoSource,
        workingCopyPath,
        resetSearchCache: resetSearchCaches,
        clearOcrCache: path => clearOcrCache(path),
        undoHistory: workspaceUndoTimeline.undoTimeline,
        redoHistory: workspaceUndoTimeline.redoTimeline,
    });
    const history = {
        isHistoryBusy,
        canUndo: commandCanUndo,
        canRedo: commandCanRedo,
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
    const preparePageOperationWorkingCopy = saveService.createPageMutationWriterSave({
        currentPage,
        waitForPdfReload: pdfHistory.waitForPdfReload,
        loadPdfFromPath: file.loadPdfFromPath,
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
        selectedThumbnailPages: viewPort.selectedThumbnailPages,
        setSelectedThumbnailPages: viewPort.setSelectedThumbnailPages,
        selectedPageSelection: viewPort.selectedPageSelection,
        setSelectedPageSelection: viewPort.setSelectedPageSelection,
        invalidateThumbnailPages: viewPort.requestThumbnailInvalidation,
        pdfViewerRef,
        pageContextMenu: pageContextMenu.pageContextMenu,
        closePageContextMenu: pageContextMenu.closePageContextMenu,
        onExportPages: (pages) => {
            void exportWorkflow.handleExportImages(pages);
        },
        canMutatePages: computed(() => sourceCapabilities.value.pageEdits),
        onExtractedDocument: emitOpenInNewTab,
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation: preparePageOperationWorkingCopy,
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
        // Page operations already own the lease. Preparing their input must
        // leave the original and the user's Save/Discard decision untouched.
        ensureWorkingCopyFreshForRead: preparePageOperationWorkingCopy,
        preparePdfReloadWaiter: pdfHistory.preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache: resetSearchCaches,
        runWithDocumentOperationLease: runExclusive,
    });
    // Opening another file in a view of a shared document detaches only that
    // view (T4); the document stays with its other views, asking nothing. A
    // hidden, unmounted view still shows it. A tab loading the document's own
    // file, as a restored or cold tab does when shown, loads it for all views.
    const sharesViews = computed(() => controller.views.value.size > 1);
    function openInOwnDocument(open: (workspace: IWorkspaceExpose) => Promise<boolean>) {
        void commandView.value?.detachAndOpen(open);
        return Promise.resolve<TDocumentOpenOutcome>({status: 'cancelled'});
    }
    const fileOps = usePageFileOperations({
        get tabId() {
            return commandView.value?.tabId;
        },
        pdfSrc,
        hasDocument: hasOpenDocument,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy,
        isExportingDocx: docx.isExportingDocx,
        isAnyAnnotationNoteSaving: annotations.isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress: lease.isBusy,
        hasSaveFailure: saveService.hasSaveFailure,
        annotationNoteWindows: annotations.annotationNoteWindows,
        hasPendingUnsavedChanges: computed(() => !sharesViews.value && hasPendingUnsavedChanges.value),
        annotationDirty: annotations.annotationDirty,
        isDirty: file.isDirty,
        recoveryDirtyBaseline: file.recoveryDirtyBaseline,
        pageLabelsDirty: pageLabelState.pageLabelsDirty,
        bookmarksDirty: bookmarkState.bookmarksDirty,
        persistAllAnnotationNotes: annotations.persistAllAnnotationNotes,
        handleSave: save.handleSave,
        pickFileToOpen: file.pickFileToOpen,
        openFile: result => (sharesViews.value
            ? openInOwnDocument(workspace => (result ? workspace.handleOpenFileWithResult(result) : workspace.handleOpenFileFromUi()))
            : file.openFileWithViewerLifecycle(result)),
        openFileDirect: path => (sharesViews.value && path !== controller.snapshot.value.identity.originalPath
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectWithPersist(path))
            : file.openFileDirectWithViewerLifecycle(path)),
        openFileDirectBatch: paths => (sharesViews.value
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectBatchWithPersist(paths))
            : file.openFileDirectBatchWithViewerLifecycle(paths)),
        runDocumentOpen: runDocumentOpen,
        closeFile: file.closeFileWithViewerLifecycle,
        closeAllDropdowns: viewPort.closeAllDropdowns,
        emitOpenInNewTab,
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
        selectedPages: viewPort.selectedThumbnailPages,
        selectedPageSelection: viewPort.selectedPageSelection,
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
    // A split restore reopens its payload as the tab's open transaction.
    async function openSplitPayloadResult(result: TOpenFileResult) {
        const opened: {outcome: TDocumentOpenOutcome} = {outcome: {status: 'cancelled'}};
        const presented = await runDocumentOpen(describeOpenResult(result), async () => {
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

    const {handleOcrComplete} = useWorkspaceDocumentLifecycleEffects({
        currentPage,
        totalPages,
        pdfDocument,
        pdfViewerRef,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        pdfSrc,
        workingCopyPath,
        documentRevisionInfo: file.documentRevisionInfo,
        documentRevisionToken,
        pdfError: file.pdfError,
        dragMode: viewPort.dragMode,
        showSidebar: viewPort.showSidebar,
        sidebarTab: viewPort.sidebarTab,
        annotationTool: views.annotationTools,
        annotationComments: annotations.annotationComments,
        markAnnotationCommentsLoading: annotations.markAnnotationCommentsLoading,
        clearAnnotationComments: annotations.clearAnnotationComments,
        annotationActiveCommentStableKey: annotations.annotationActiveCommentStableKey,
        annotationEditorState: annotations.annotationEditorState,
        bookmarkItems: bookmarkState.bookmarkItems,
        bookmarksDirty: bookmarkState.bookmarksDirty,
        bookmarkEditMode: bookmarkState.bookmarkEditMode,
        consumePreservedSourceReloadMetadata: metadata.consumePreservedSourceReloadMetadata,
        navigationTicket: computed(() => commandOpenSurface.navigationTicket.value),
        pageLabels: pageLabelState.pageLabels,
        pageLabelRanges: pageLabelState.pageLabelRanges,
        pageLabelsDirty: pageLabelState.pageLabelsDirty,
        resetAnnotationTracking: annotations.resetAnnotationTracking,
        resetSearchCache: resetSearchCaches,
        closeSearch: closeSearches,
        closeAnnotationContextMenu: views.closeAnnotationContextMenus,
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

    return {
        controller,
        isOpeningDocument,
        pendingDocumentPath,
        pendingDjvuDocumentOpen,
        sourceCapabilities,
        failure,
        file,
        totalPages,
        pdfDocument,
        driver,
        viewerCapabilities,
        metadata,
        annotations,
        pdfDocumentAnnotations,
        saveService,
        save,
        exportWorkflow,
        docx,
        docxExport,
        history,
        hasOpenDocument,
        pageOps,
        fileOps,
        print,
        splitPayload,
        handleOcrComplete,
        views,
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

type TDocumentContextRegistry = Map<IWorkspaceDocumentController, TDocumentContext>;
const documentContextRegistryKey: InjectionKey<TDocumentContextRegistry> = Symbol('documentContextRegistry');

/** The document contexts the editor panes host, by controller; views find theirs here. */
export const provideDocumentContextRegistry = () => {
    const registry: TDocumentContextRegistry = shallowReactive(new Map());
    provide(documentContextRegistryKey, registry);
    return registry;
};

export const useDocumentContextRegistry = () => {
    const registry = inject(documentContextRegistryKey);
    if (!registry) {
        throw new Error('A document context needs an EditorPanesHost ancestor.');
    }
    return registry;
};
