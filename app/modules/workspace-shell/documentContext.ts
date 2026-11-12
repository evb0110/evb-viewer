import type { InjectionKey } from 'vue';
import {crashCheckpointBeforeSaveKey} from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import {hasElectronAPI} from '@app/utils/platform';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import { uniq } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import {
    createPdfDocumentAnnotations,
    createPdfReloadWaiter,
    createPdfSourceDataReader,
    resolvePdfReloadPage,
    createPdfDocumentSessionSlot,
    useOcrTextContent,
    usePageContextMenu,
    usePdfHistory,
    type IPdfDocument,
    type IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import { useWorkspaceSaveService } from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';
import { useUnencryptedSaveNotice } from '@app/modules/workspace-shell/composables/useUnencryptedSaveNotice';
import { useShutdownSaveFlushReporting } from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { useDocumentWorkspaceOptimizeDialog } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog';
import { useWorkspaceExport } from '@app/modules/workspace-shell/composables/useWorkspaceExport';
import { useWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import { useWorkspaceFileLifecycleController } from '@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController';
import { useWorkspaceAnnotationSession } from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import { prepareDocumentViewsForHistorySwap } from '@app/modules/workspace-shell/document-sessions/prepareDocumentViewsForRevisionSwap';
import { usePageOpsHandlers } from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    getDocumentFilesCapability,
    getDocumentPdfCapability,
} from '@app/utils/platformDocuments';
import { useDocxExport } from '@app/composables/useDocxExport';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import { useMetadataSession } from '@app/modules/workspace-shell/composables/useMetadataSession';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
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
import { EMPTY_SOURCE_CAPABILITIES } from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';
import {
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/public/runtime';
import {
    createDocumentViews,
    type TViewShellState,
} from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    createReadingViewLifecycleHooks,
    registerViewInUse,
} from '@app/modules/workspace-shell/document-sessions/recentReadingView';

/**
 * One document's context: the controller, the working copy and its
 * lifecycle, metadata, annotations, save, history, page and file operations,
 * print and export. DocumentSessionHost creates it once per document, outside
 * any tab's mount, so it outlives the views that show it. Each mounted view
 * attaches a port; commands that need a page, a selection or a viewer run in
 * the view whose tab is in use.
 */
export const createDocumentContext = ({controller}: {controller: IWorkspaceDocumentController}) => {
    const { t } = useTypedI18n();
    const openingTransaction = computed(() => {
        const transaction = controller.snapshot.value.activeTransaction;
        return transaction && transaction.kind !== 'close' ? transaction : null;
    });
    const isMoving = computed(() => controller.operationLease.activeKind.value === 'tab-transfer');
    const isOpeningDocument = computed(() => openingTransaction.value !== null);
    const pendingDocumentPath = computed(() => openingTransaction.value?.target?.originalPath ?? null);
    const pendingDjvuDocumentOpen = computed(() => openingTransaction.value?.target?.isDjvu === true);
    const views = createDocumentViews(controller);
    const {
        viewPorts, commandView, commandViewRef, loadedView, runDocumentOpen,
    } = views;
    const idleOpenSurface = createDocumentOpenSurfaceSession();
    const commandOpenSurface = {
        snapshot: commandViewRef(port => port.openSurface.snapshot, idleOpenSurface.snapshot.value),
        viewportSession: commandViewRef(port => port.openSurface.viewportSession, idleOpenSurface.viewportSession.value),
    };
    const pdfViewerRef = commandViewRef<IPdfViewerExpose | null>(port => port.view.pdfViewerRef, null);
    const documentViewerRef = commandViewRef(port => port.view.documentViewerRef, null);
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
        // Every view shows this document's thumbnails, not only the one acting.
        requestThumbnailInvalidation: (...args: Parameters<TViewShellState['requestThumbnailInvalidation']>) => (
            viewPorts.value.forEach(port => port.view.requestThumbnailInvalidation(...args))
        ),
        closeAllDropdowns: () => commandView.value?.view.closeAllDropdowns(),
        openDropdown: (...args: Parameters<TViewShellState['openDropdown']>) => commandView.value?.view.openDropdown(...args),
    };
    const pageContextMenu = commandViewRef(port => port.pageContextMenu.pageContextMenu, usePageContextMenu().pageContextMenu.value);
    const closePageContextMenu = () => commandView.value?.pageContextMenu.closePageContextMenu();
    // A document source change resets every view's search, not only the one in use.
    const resetSearchCaches = () => viewPorts.value.forEach(port => port.search.resetSearchCache());
    registerViewInUse(controller, () => views.commandTabId.value);
    // Save and annotation failures reach the user through this surface; an
    // open's failure is told by the tab's document session.
    const failure = useWorkspaceFailureSurface();
    const file = useWorkspaceFileLifecycleController({
        documentAnnotations: () => pdfDocumentAnnotations,
        prepareHistoryRevisionSwap: (revision, delta) => prepareDocumentViewsForHistorySwap(views, pdfViewerRef.value, totalPages.value, revision, delta),
        createViewerLifecycleHooks: context => [createReadingViewLifecycleHooks(controller)].concat(driver.createLifecycleHooks(context)),
        getOpenSurface: () => commandView.value?.openSurface ?? null,
        runDocumentOpen,
        document: controller,
    });
    const {
        settings: appSettings,
        save: saveSettings,
        updateSetting,
    } = useSettings();
    const sourceCapabilities = ref<IDocumentSourceCapabilities>(EMPTY_SOURCE_CAPABILITIES);
    const isSaving = ref(false);
    const isSavingAs = ref(false);
    const runExclusive = controller.operationLease.runExclusive;

    const metadata = useMetadataSession({
        pdfDocument: computed(() => loadedView.value?.view.pdfDocument.value ?? null),
        totalPages: computed(() => loadedView.value?.view.totalPages.value ?? 0),
        workingCopyPath: file.workingCopyPath,
        documentRevisionToken: file.documentRevisionToken,
        markDirty: file.markDirty,
        setWorkspaceCommandSink: file.setWorkspaceCommandSink,
    });
    const persistCrashCheckpoint = inject(crashCheckpointBeforeSaveKey, null);
    const pdfDocumentAnnotations = createPdfDocumentAnnotations({
        workingCopyPath: file.workingCopyPath,
        source: file.pdfSrc,
        documentRevisionToken: file.documentRevisionToken,
        documentSession: file.fileHistorySessionVersion,
        protectTextBoxDraft: hasElectronAPI() ? async (assertCurrent) => {
            const target = controller.snapshot.value.identity;
            try {
                if (!persistCrashCheckpoint) throw new Error('Recovery protection is unavailable for the text transaction');
                await persistCrashCheckpoint(target.workingCopyPath, assertCurrent);
            } catch (cause) {
                if ((cause instanceof DOMException && cause.name === 'AbortError') || controller.snapshot.value.identity.documentInstanceId !== target.documentInstanceId || (!controller.snapshot.value.dirty && pdfDocumentAnnotations.textBoxDrafts.size === 0)) throw new DOMException('The text transaction was cancelled', 'AbortError');
                const message = getErrorMessage(cause);
                const presentation = {
                    failure: getFailureReceipt(cause) ?? BrowserLogger.error('annotations', 'Failed to protect a text draft', cause, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'}),
                    title: t('errors.workspace.recoveryProtectionTitle'),
                    description: t('errors.workspace.recoveryProtectionDescription', {
                        fileName: file.fileName.value ?? target.workingCopyPath ?? target.documentInstanceId ?? '',
                        message,
                    }),
                    technicalDetails: message,
                };
                failure.reportFailure(presentation);
                throw Object.assign(cause instanceof Error ? cause : new Error(message), presentation);
            }
        } : undefined,
    });
    const { clearCache: clearOcrCache } = useOcrTextContent();

    const annotations = useWorkspaceAnnotationSession({
        views,
        pdfDocument,
        reportNoteFailure: failure.reportNoteFailure,
    });
    const hasPendingUnsavedChanges = computed(() => (
        pdfViewerRef.value?.hasCanonicalAnnotationChanges?.() === true
        || annotations.annotationNoteWindows.value.some(note => note.dirty)
        || file.isDirty.value
        // Set with the working copy, before history reports a restored document dirty.
        || file.recoveryDirtyBaseline.value
        || metadata.pageLabelState.pageLabelsDirty.value
        || metadata.bookmarkState.bookmarksDirty.value
    ));

    // This is authored state, including edits made while already dirty and drafts
    // outside the store. Parsed clean annotations are projections of the bytes.
    controller.bindMutationFrontier({
        read: () => JSON.stringify({
            revision: file.documentRevisionToken.value,
            annotations: pdfDocumentAnnotations.application.value.store.dirtyEntities().map(entity => [
                entity.identity.id,
                entity.revision,
                entity.deleted,
            ]),
            textBoxDrafts: [...pdfDocumentAnnotations.textBoxDrafts],
            noteDrafts: annotations.getAnnotationNoteDraftsChangeSignature(),
            metadata: metadata.captureRecovery(),
            operation: controller.operationLease.activeKind.value,
        }),
        isDirty: () => hasPendingUnsavedChanges.value,
        prepare: async (assertCurrent) => {
            await pdfDocumentAnnotations.commitPendingDraftsForSave().then(assertCurrent);
            if (!await annotations.persistAllAnnotationNotes()) throw new Error(t('tabs.transferErrors.restoreFailed'));
        },
        close: async (assertCurrent) => {
            await file.handleDjvuCancel();
            // No await separates the final authored-state check from clearing the
            // source. The ordinary close's admission and view hooks belong to its UI.
            assertCurrent();
            await file.closeFile();
        },
    });

    const unencryptedSaveNotice = useUnencryptedSaveNotice();
    const getSourcePdfData = createPdfSourceDataReader({
        pdfData: file.pdfData,
        workingCopyPath: file.workingCopyPath,
        documentRevisionToken: file.documentRevisionToken,
    });
    const saveService = {
        getSourcePdfData,
        ...useWorkspaceSaveService({
            status: {
                isSaving,
                isSavingAs,
            },
            document: {
                sessionKey: computed(() => controller.snapshot.value.identity.documentSessionKey),
                workingCopyPath: file.workingCopyPath,
                originalPath: file.originalPath,
                revisionToken: file.documentRevisionToken,
                wasEncrypted: file.wasEncrypted,
            },
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
            hasPendingUnsavedChanges,
            optimizePdfOnSaveAs: computed(() => appSettings.value.optimizePdfOnSaveAs),
            annotations: {
                dirty: annotations.annotationDirty,
                markSaved: annotations.markAnnotationSaved,
                getSaveStateToken: annotations.getAnnotationSaveStateToken,
                hasChanges: annotations.hasAnnotationChanges,
                hasPendingDeletes: () => annotations.pendingEmbeddedAnnotationDeleteCount.value > 0,
                openNoteCount: computed(() => annotations.annotationNoteWindows.value.length),
                persistOpenNotes: annotations.persistAllAnnotationNotes,
                getNoteFailurePresentation: annotations.getAnnotationNoteFailurePresentation,
            },
            metadata: {
                totalPages,
                pageLabelsDirty: metadata.pageLabelState.pageLabelsDirty,
                pageLabelRanges: metadata.pageLabelState.pageLabelRanges,
                bookmarksDirty: metadata.bookmarkState.bookmarksDirty,
                bookmarkItems: metadata.bookmarkState.bookmarkItems,
                untitledBookmarkLabel: t('bookmarks.untitled'),
                markPageLabelsSaved: metadata.pageLabelState.markPageLabelsSaved,
                getPageLabelsSaveStateToken: metadata.pageLabelState.getPageLabelsRevision,
                markBookmarksSaved: metadata.bookmarkState.markBookmarksSaved,
                getBookmarksSaveStateToken: metadata.bookmarkState.getBookmarksRevision,
            },
            pdf: {
                document: pdfDocument,
                viewer: pdfViewerRef,
                commitEditorsForSave: () => pdfViewerRef.value?.commitPdfEditorsForSave?.() ?? Promise.resolve(),
                runSaveTransaction: request => pdfViewerRef.value?.runSaveTransaction(request)
                    ?? Promise.reject(new Error('Missing PDF viewer save transaction')),
                getSourceData: getSourcePdfData,
            },
            persistence: {
                validatePdfPath: path => getDocumentPdfCapability().validatePdfPath(path, {purpose: 'save'}),
                saveWorkingCopy: file.saveWorkingCopy,
                saveAs: file.saveWorkingCopyAs,
                ...(file.repairWorkingCopy ? {repairWorkingCopy: file.repairWorkingCopy} : {}),
                ...(file.optimizeWorkingCopy ? {optimizeWorkingCopy: file.optimizeWorkingCopy} : {}),
                ...(file.optimizeWorkingCopyAsCopy ? {optimizeWorkingCopyAsCopy: file.optimizeWorkingCopyAsCopy} : {}),
                trySavePdfNativeMutations: file.trySavePdfNativeMutations,
                getWorkingCopySize: async path => (await getDocumentFilesCapability().statFile(path)).size,
            },
            shapes: {
                hasChanges: () => hasViewerShapeChanges(pdfViewerRef.value),
                hasManagedShapes: () => (pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
            },
            lifecycle: {
                loadRecentFiles: () => void file.loadRecentFiles(),
                preparePostSaveReload: () => createPdfReloadWaiter({
                    pdfDocument,
                    pdfViewerRef,
                    openSurface: commandOpenSurface,
                    resetSearchCache: resetSearchCaches,
                    pageToRestore: resolvePdfReloadPage(currentPage.value),
                    restoreScroll: false,
                }),
            },
            runWithDocumentOperationLease: runExclusive,
            failureSurface: failure,
        }),
    };
    const driver = useWorkspaceDocumentDriver({
        djvuSourcePath: file.djvuSourcePath,
        isDjvuMode: file.isDjvuMode,
        pdfSrc: file.pdfSrc,
        workingCopyPath: file.workingCopyPath,
        save: {
            save: saveService.handleSave,
            saveAs: saveService.handleSaveAs,
            saveAsDjvuProjection: () => file.ensureDjvuPdfProjection('save-as-pdf'),
        },
        pendingDocumentPath: pendingDocumentPath,
        pendingDocumentSize: computed(() => commandOpenSurface.snapshot.value.openingPageGeometry?.size ?? null),
    });
    watch(driver.activeDocumentDriver, (active) => {
        if (active?.view.defaultSourceCapabilities) {
            sourceCapabilities.value = active.view.defaultSourceCapabilities;
        } else if (!active) {
            sourceCapabilities.value = EMPTY_SOURCE_CAPABILITIES;
        }
    }, {immediate: true});
    useShutdownSaveFlushReporting({
        workingCopyPath: file.workingCopyPath,
        hasPendingUnsavedChanges,
        flushAdditionalState: async () => {
            await saveSettings();
            await flushScanCleanupDocumentPreferencesStore();
            await flushScanCleanupPreferencesStore();
        },
    });
    const save = {
        ...saveService,
        canSave: computed(() => !isMoving.value && saveService.canSave.value),
        isSaving,
        isSavingAs,
        hasPendingUnsavedChanges,
        // An agent's Save learns the revision it committed, not whichever is current afterwards.
        handleSave: driver.handleSave,
        handleSaveAs: driver.handleSaveAs,
        optimizeDialog: useDocumentWorkspaceOptimizeDialog({handleOptimizePdfAsCopy: saveService.handleOptimizePdfAsCopy}),
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
            workingCopyPath: file.workingCopyPath.value,
            documentRevisionToken: file.documentRevisionToken.value,
            pdfDocument: pdfDocument.value,
            ...(selectedLanguages === undefined ? {} : {selectedLanguages}),
        }));
        if (!exported && cancellationVersion === docxExportCancellationVersion) {
            viewPort.openDropdown('ocr');
        }
    }
    const exportWorkflow = useWorkspaceExport({
        workingCopyPath: file.workingCopyPath,
        exportTargets: {
            imageTarget: computed(() => driver.activeDocumentDriver.value?.operations.export.imageTarget ?? null),
            multiPageTiffTarget: computed(() => driver.activeDocumentDriver.value?.operations.export.multiPageTiffTarget ?? null),
        },
        documentRevisionToken: file.documentRevisionToken,
        totalPages,
        ensureWorkingCopyFreshForRead: saveService.saveForExternalRead,
        runWithDocumentOperationLease: runExclusive,
    });

    const pdfHistory = usePdfHistory({
        documentRevisionToken: file.documentRevisionToken,
        runWithDocumentOperationLease: runExclusive,
        isHistoryBusy: computed(() => controller.operationLease.activeKind.value === 'history'),
        pdfDocument,
        pdfViewerRef,
        openSurface: commandOpenSurface,
        currentPage,
        isAnySaving: saveService.isAnySaving,
        prepareHistory: pdfDocumentAnnotations.commitPendingDraftsForSave,
        mapHistoryPage: file.mapHistoryPage,
        canUndo: metadata.workspaceUndoTimeline.canUndoTimeline,
        canRedo: metadata.workspaceUndoTimeline.canRedoTimeline,
        nextUndoSource: metadata.workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: metadata.workspaceUndoTimeline.nextRedoSource,
        workingCopyPath: file.workingCopyPath,
        resetSearchCache: resetSearchCaches,
        clearOcrCache,
        undoHistory: metadata.workspaceUndoTimeline.undoTimeline,
        redoHistory: metadata.workspaceUndoTimeline.redoTimeline,
    });
    const hasOpenDocument = computed(() => (
        file.hasPdf.value
        || (
            driver.activeDocumentDriver.value?.capabilities.closeableDocument === true
            && driver.activeDocumentDriver.value.source.path !== null
        )
    ));
    const preparePageOperationWorkingCopy = () => metadata.runWithPreservedMetadataReload(saveService.createPageMutationWriterSave({
        currentPage,
        waitForPdfReload: pdfHistory.waitForPdfReload,
        reloadWorkingCopyRevision: file.reloadWorkingCopyRevision,
    }));
    const pageOps = usePageOpsHandlers({
        workingCopyPath: file.workingCopyPath,
        documentRevisionToken: file.documentRevisionToken,
        pageLabels: metadata.pageLabelState.pageLabels,
        pageLabelRanges: metadata.pageLabelState.pageLabelRanges,
        pageLabelsResolved: metadata.pageLabelState.pageLabelsResolved,
        whenPageLabelsSettled: metadata.pageLabelState.whenPageLabelsSettled,
        bookmarkItems: metadata.bookmarkState.bookmarkItems,
        bookmarksResolved: metadata.bookmarkState.bookmarksResolved,
        views,
        totalPages,
        selectedThumbnailPages: viewPort.selectedThumbnailPages,
        setSelectedThumbnailPages: viewPort.setSelectedThumbnailPages,
        selectedPageSelection: viewPort.selectedPageSelection,
        setSelectedPageSelection: viewPort.setSelectedPageSelection,
        invalidateThumbnailPages: viewPort.requestThumbnailInvalidation,
        pageContextMenu,
        closePageContextMenu,
        onExportPages: pages => void exportWorkflow.handleExportImages(pages),
        canMutatePages: computed(() => sourceCapabilities.value.pageEdits),
        onExtractedDocument: result => commandView.value?.emitOpenInNewTab(result),
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation: preparePageOperationWorkingCopy,
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
        // Page operations already own the lease. Preparing their input must
        // leave the original and the user's Save/Discard decision untouched.
        ensureWorkingCopyFreshForRead: preparePageOperationWorkingCopy,
        clearOcrCache,
        resetSearchCache: resetSearchCaches,
        runWithDocumentOperationLease: (kind, operation) => runExclusive(kind, () => metadata.runWithPreservedMetadataReload(operation)),
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
        pdfSrc: file.pdfSrc,
        hasDocument: hasOpenDocument,
        isAnySaving: saveService.isAnySaving,
        isHistoryBusy: pdfHistory.isHistoryBusy,
        isExportingDocx: docx.isExportingDocx,
        isAnyAnnotationNoteSaving: annotations.isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress: controller.operationLease.isBusy,
        hasSaveFailure: saveService.hasSaveFailure,
        annotationNoteWindows: annotations.annotationNoteWindows,
        hasPendingUnsavedChanges: computed(() => !sharesViews.value && hasPendingUnsavedChanges.value),
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
        openFileDirect: path => (sharesViews.value && (path !== controller.snapshot.value.identity.originalPath || hasPendingUnsavedChanges.value)
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectWithPersist(path))
            : file.openFileDirectWithViewerLifecycle(path)),
        openFileDirectBatch: paths => (sharesViews.value
            ? openInOwnDocument(workspace => workspace.handleOpenFileDirectBatchWithPersist(paths))
            : file.openFileDirectBatchWithViewerLifecycle(paths)),
        runDocumentOpen,
        closeFile: file.closeFileWithViewerLifecycle,
        closeAllDropdowns: viewPort.closeAllDropdowns,
        emitOpenInNewTab: result => commandView.value?.emitOpenInNewTab(result),
    });

    const printableSource = createPrintableSourceDataResolver({
        hasPendingUnsavedChanges,
        pdfViewerRef,
        save: saveService,
        workingCopyPath: file.workingCopyPath,
        originalPath: file.originalPath,
        documentRevisionToken: file.documentRevisionToken,
        runWithDocumentOperationLease: runExclusive,
    });
    const print = useWorkspacePrint({
        totalPages,
        currentPage,
        selectedPages: viewPort.selectedThumbnailPages,
        selectedPageSelection: viewPort.selectedPageSelection,
        sourcePdf: file.pdfSrc,
        workingCopyPath: file.workingCopyPath,
        printPath: computed(() => driver.activeDocumentDriver.value?.operations.print.path ?? null),
        fileName: file.fileName,
        hasPendingUnsavedChanges,
        hasPendingPrintSerializationChanges: annotations.hasUnsavedAnnotationChanges,
        getCurrentPrintPage: () => documentViewerRef.value?.getCurrentPage?.() ?? currentPage.value,
        getQuickPrintPageMetrics: async () => {
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
        },
        isDriverOwnedQuickPrint: () => driver.activeDocumentDriver.value?.canPreparePrint === true,
        ensurePrintReady: async () => (
            !annotations.hasOpenAnnotationNotes.value || annotations.persistAllAnnotationNotes()
        ),
        ...printableSource,
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
        ) => driver.activeDocumentDriver.value?.run({
            kind: 'prepare-print',
            request: payload,
            fileName: file.fileName.value,
            sourceCapabilities: sourceCapabilities.value,
            ...options,
        }) ?? Promise.resolve({
            status: 'unavailable' as const,
            capability: 'print' as const,
        }),
    });

    const splitPayload = useWorkspaceSplitPayload({
        pdfSrc: file.pdfSrc,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        currentPage,
        totalPages,
        fileName: file.fileName,
        originalPath: file.originalPath,
        workingCopyPath: file.workingCopyPath,
        hasPendingTabChanges: hasPendingUnsavedChanges,
        requiresSaveAsOnFirstSave: file.requiresSaveAsOnFirstSave,
        pdfViewerRef,
        documentViewerRef,
        pdfData: file.pdfData,
        // A split restore reopens its payload as the tab's open transaction.
        openFileWithViewerLifecycle: file.openFileInDocumentTransaction,
        preparePdfReloadWaiter: pdfHistory.preparePdfReloadWaiter,
        loadPdfFromPath: file.loadPdfFromPath,
        documentRevisionToken: file.documentRevisionToken,
        getNativeSaveTransactionOptions: saveService.getNativeSaveTransactionOptions,
        runWithDocumentOperationLease: runExclusive,
    });

    const {ocr} = useWorkspaceDocumentLifecycleEffects({
        documentAnnotations: pdfDocumentAnnotations,
        currentPage,
        totalPages,
        pdfDocument,
        views,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        pdfSrc: file.pdfSrc,
        workingCopyPath: file.workingCopyPath,
        documentRevisionInfo: file.documentRevisionInfo,
        documentRevisionToken: file.documentRevisionToken,
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
        metadata,
        navigationTicket: commandViewRef(port => port.openSurface.navigationTicket, null),
        resetAnnotationTracking: annotations.resetAnnotationTracking,
        resetSearchCache: resetSearchCaches,
        closeSearch: () => viewPorts.value.forEach(port => port.search.closeSearch()),
        closeAnnotationContextMenu: views.closeAnnotationContextMenus,
        closePageContextMenu,
        closeAllAnnotationNotes: annotations.closeAllAnnotationNotes,
        loadRecentFiles: () => void file.loadRecentFiles(),
        // OCR waits for document writers; a background recovery copy only reads.
        isBusy: computed(() => controller.operationLease.isForegroundBusy.value || saveService.isAnySaving.value),
        clearOcrCache,
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter: pdfHistory.preparePdfReloadWaiter,
        runWithDocumentOperationLease: runExclusive,
    });

    return {
        controller,
        isMoving,
        isOpeningDocument,
        pendingDocumentPath,
        pendingDjvuDocumentOpen,
        sourceCapabilities,
        failure,
        file,
        driver,
        viewerCapabilities: computed(() => driver.activeDocumentDriver.value?.capabilities),
        metadata,
        annotations,
        pdfDocumentAnnotations,
        pdfDocumentSessionSlot: createPdfDocumentSessionSlot({
            documentRevisionToken: file.documentRevisionToken,
            workingCopyPath: file.workingCopyPath,
            admitOpeningSource: file.admitOpeningSource,
            src: file.pdfSrc,
            reloadSrc: file.pdfReloadSrc,
            documentLifecycleKey: computed(() => file.originalPath.value ?? pendingDocumentPath.value),
        }),
        saveService,
        save,
        exportWorkflow,
        docx,
        docxExport: {
            error: docx.docxExportError,
            isExporting: docx.isExportingDocx,
            handleExportDocx,
            cancel: cancelDocxExport,
        },
        history: pdfHistory,
        hasOpenDocument,
        pageOps,
        fileOps,
        print,
        splitPayload,
        ocr,
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
