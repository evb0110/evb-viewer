import type { InjectionKey } from 'vue';
import {crashCheckpointBeforeSaveKey} from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import {hasElectronAPI} from '@app/utils/platform';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    createPdfDocumentAnnotations,
    createPdfSourceDataReader,
    createPdfDocumentSessionSlot,
    useOcrTextContent,
    usePdfHistory,
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
import { createPrintableSourceDataResolver } from '@app/modules/workspace-shell/composables/createPrintableSourceDataResolver';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import {
    useWorkspaceDocumentDriver,
    type IWorkspaceDriverPrintRequest,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IDocumentSourceCapabilities } from '@app/modules/document-viewer/public';
import { EMPTY_SOURCE_CAPABILITIES } from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';
import {
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/public/runtime';
import { createDocumentViews } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import { createReadingViewLifecycleHooks } from '@app/modules/workspace-shell/document-sessions/recentReadingView';

/**
 * One document's context: the controller, the working copy and its
 * lifecycle, metadata, annotations, save, history, page operations, print and
 * export. DocumentSessionHost creates it once per document, outside any tab's
 * mount, so it outlives the views that show it. Each mounted view attaches a
 * port; no view is the document's. A command that needs a page or a
 * selection takes it from the view that starts it, and every view keeps its
 * own place through what the document does.
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
    const pdfViewerRef = views.pdfViewer;
    const pdfDocument = views.presentedPdfDocument;
    const totalPages = views.reportedPageCount;
    // A document source change resets every view's search.
    const resetSearchCaches = () => views.forEachView(port => port.search.resetSearchCache());
    // Save and annotation failures reach the user through this surface; an
    // open's failure is told by the tab's document session.
    const failure = useWorkspaceFailureSurface();
    const file = useWorkspaceFileLifecycleController({
        documentAnnotations: () => pdfDocumentAnnotations,
        prepareHistoryRevisionSwap: (revision, delta) => prepareDocumentViewsForHistorySwap(views, totalPages.value, revision, delta),
        createViewerLifecycleHooks: context => [createReadingViewLifecycleHooks(controller)].concat(driver.createLifecycleHooks(context)),
        // The opens the document starts itself (a converted DjVu, a moved
        // tab's restore) are of documents with one view at most.
        getOpenSurface: () => views.soleView.value?.openSurface ?? null,
        runDocumentOpen: (request, run) => views.runDocumentOpen(views.soleView.value, request, run),
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
    const pdfDocumentSessionSlot = createPdfDocumentSessionSlot({
        documentRevisionToken: file.documentRevisionToken,
        workingCopyPath: file.workingCopyPath,
        admitOpeningSource: file.admitOpeningSource,
        src: file.pdfSrc,
        reloadSrc: file.pdfReloadSrc,
        documentLifecycleKey: computed(() => file.originalPath.value ?? pendingDocumentPath.value),
    });

    const metadata = useMetadataSession({
        pdfDocument,
        totalPages,
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
    // What a viewer's commit for save does: every view's open text editors.
    const commitPdfEditors = async () => {
        await pdfDocumentAnnotations.commitPendingDraftsForSave();
        await nextTick();
    };
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
                commitEditorsForSave: commitPdfEditors,
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
                preparePostSaveReload: () => views.prepareReload(undefined, false),
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
    // A failed export opens the OCR panel of the view that started it.
    async function handleExportDocx(selectedLanguages?: string[], onFailed?: () => void) {
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
            onFailed?.();
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
        prepareReload: views.prepareReload,
        isAnySaving: saveService.isAnySaving,
        prepareHistory: pdfDocumentAnnotations.commitPendingDraftsForSave,
        mapHistoryPage: file.mapHistoryPage,
        canUndo: metadata.workspaceUndoTimeline.canUndoTimeline,
        canRedo: metadata.workspaceUndoTimeline.canRedoTimeline,
        nextUndoSource: metadata.workspaceUndoTimeline.nextUndoSource,
        nextRedoSource: metadata.workspaceUndoTimeline.nextRedoSource,
        workingCopyPath: file.workingCopyPath,
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
        waitForPdfReload: () => views.prepareReload().promise,
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
        commitPdfEditors,
        // The rotation changes the geometry the views share; each previews it.
        beginPageRotationPreview: async (pages, rotationDelta) => {
            if (pdfDocumentSessionSlot.session.value?.beginPageMutationRotationPreview(pages, rotationDelta)) {
                await nextTick();
            }
        },
        // Every view shows this document's thumbnails.
        invalidateThumbnailPages: (...args) => views.forEachView(port => port.view.requestThumbnailInvalidation(...args)),
        onExportPages: pages => void exportWorkflow.handleExportImages(pages),
        canMutatePages: computed(() => sourceCapabilities.value.pageEdits),
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
        sourcePdf: file.pdfSrc,
        workingCopyPath: file.workingCopyPath,
        printPath: computed(() => driver.activeDocumentDriver.value?.operations.print.path ?? null),
        fileName: file.fileName,
        hasPendingUnsavedChanges,
        hasPendingPrintSerializationChanges: annotations.hasUnsavedAnnotationChanges,
        ensurePrintReady: async () => (
            !annotations.hasOpenAnnotationNotes.value || annotations.persistAllAnnotationNotes()
        ),
        ...printableSource,
        // Prints the pages of the PDF.js document the document's session holds.
        renderLoadedPdfPagesForBrowserPrint: async (
            targetDocument: IBrowserPrintDocument,
            pageNumbers: number[],
            options?: { signal?: AbortSignal },
        ) => {
            const loadedDocument = pdfDocumentSessionSlot.session.value?.document.value;
            if (!loadedDocument) {
                throw new Error('Missing loaded PDF document');
            }
            const { renderPdfDocumentPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
            await renderPdfDocumentPagesForBrowserPrint(
                targetDocument,
                loadedDocument,
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
        totalPages,
        fileName: file.fileName,
        originalPath: file.originalPath,
        workingCopyPath: file.workingCopyPath,
        hasPendingTabChanges: hasPendingUnsavedChanges,
        requiresSaveAsOnFirstSave: file.requiresSaveAsOnFirstSave,
        pdfViewerRef,
        pdfData: file.pdfData,
        // A split restore reopens its payload as the tab's open transaction.
        openFileWithViewerLifecycle: file.openFileInDocumentTransaction,
        prepareViewReload: views.prepareViewReload,
        loadPdfFromPath: file.loadPdfFromPath,
        documentRevisionToken: file.documentRevisionToken,
        getNativeSaveTransactionOptions: saveService.getNativeSaveTransactionOptions,
        runWithDocumentOperationLease: runExclusive,
    });

    const {ocr} = useWorkspaceDocumentLifecycleEffects({
        documentAnnotations: pdfDocumentAnnotations,
        totalPages,
        // The OCR panel opens in the toolbar of the active tab.
        ocrCurrentPage: () => [...views.viewPorts.value.values()].find(port => port.isActive.value)?.view.currentPage.value ?? 1,
        views,
        isDjvuMode: file.isDjvuMode,
        djvuSourcePath: file.djvuSourcePath,
        pdfSrc: file.pdfSrc,
        workingCopyPath: file.workingCopyPath,
        documentRevisionInfo: file.documentRevisionInfo,
        documentRevisionToken: file.documentRevisionToken,
        pdfError: file.pdfError,
        clearViews: () => views.forEachView((port) => {
            port.view.totalPages.value = 0;
            port.view.pdfDocument.value = null;
            port.view.showSidebar.value = false;
            port.annotationTool.value = 'none';
        }),
        annotationComments: annotations.annotationComments,
        markAnnotationCommentsLoading: annotations.markAnnotationCommentsLoading,
        clearAnnotationComments: annotations.clearAnnotationComments,
        annotationActiveCommentStableKey: annotations.annotationActiveCommentStableKey,
        annotationEditorState: annotations.annotationEditorState,
        metadata,
        resetAnnotationTracking: annotations.resetAnnotationTracking,
        resetSearchCache: resetSearchCaches,
        closeSearch: () => views.forEachView(port => port.search.closeSearch()),
        closeContextMenus: () => views.forEachView((port) => {
            port.closeAnnotationContextMenu();
            port.pageContextMenu.closePageContextMenu();
        }),
        closeAllAnnotationNotes: annotations.closeAllAnnotationNotes,
        loadRecentFiles: () => void file.loadRecentFiles(),
        // OCR waits for document writers; a background recovery copy only reads.
        isBusy: computed(() => controller.operationLease.isForegroundBusy.value || saveService.isAnySaving.value),
        clearOcrCache,
        ensureHistoryBaselineForMutation: file.ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory: file.reloadWorkingCopyIntoHistory,
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
        pdfDocumentSessionSlot,
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
