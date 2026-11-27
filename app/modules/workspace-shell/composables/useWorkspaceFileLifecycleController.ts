import {tryOnScopeDispose} from '@vueuse/core';
import type {TDjvuPdfExportStrategy} from '@contracts/electronApiDjvu';
import type {Ref} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {usePdfFile, type IPdfFileOptions} from '@app/modules/workspace-shell/composables/usePdfFile';
import {useDjvu} from '@app/composables/useDjvu';
import {useRecentFiles} from '@app/composables/useRecentFiles';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {IWorkspaceViewerLifecycleHooks} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import type {TPdfProjectionReason, IDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';
import {didOpenDocument, isOpenFileResultOfKind, type TDocumentOpenOutcome} from '@app/types/documentOpenOutcome';
import type {IPdfRasterDisplayProfileOpenOptions} from '@app/types/pdfRasterDisplayProfile';
import {describeDocumentTarget, describeOpenResult} from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';
import type {
    IWorkspaceDocumentController,
    IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {IDocumentDirectOpenOptions} from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import {isDjvuOpenResult} from '@app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt';
import {describeDocumentOpenFailure} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';

interface IUseWorkspaceFileLifecycleControllerOptions extends IPdfFileOptions {
    createViewerLifecycleHooks?: () => IWorkspaceViewerLifecycleHooks[];
    /** The surface of the view that runs an open; read when the open runs. */
    getOpenSurface?: (() => IDocumentOpenSurfaceSession | null) | undefined;
    /** Runs an open as the document's open transaction, which ends when the viewer presents it. */
    runDocumentOpen: (request: IWorkspaceOpenRequest, run: () => Promise<TDocumentOpenOutcome>) => Promise<boolean>;
    document: Pick<IWorkspaceDocumentController, 'assign' | 'file' | 'commitFile' | 'snapshot' | 'setOpeningLabel'>;
}

function createWorkspaceFileSwitch(deps: {
    /** The controller's state: an open runs under its transaction, a close under its document instance too. */
    readDocument: () => IWorkspaceDocumentController['snapshot']['value'];
    workingCopyPath: Ref<TDocumentRef | null>;
    getViewerLifecycleHooks: () => IWorkspaceViewerLifecycleHooks[];
    onPendingOpenSuperseded: () => void;
    cancelActiveDjvuWork: () => Promise<void>;
    shouldReleaseActiveDjvu: (previousWorkingCopyPath: TDocumentRef | null) => boolean;
    onActiveDjvuSourceReleased: () => void;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef, options?: IDocumentDirectOpenOptions) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    finalizeOpen: (outcome: TDocumentOpenOutcome, openTransactionId: string | undefined) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void | Promise<void>;
}) {
    function markOutcomeStale(outcome: TDocumentOpenOutcome): TDocumentOpenOutcome {
        return 'result' in outcome
            ? {
                  status: 'stale',
                  result: outcome.result,
              }
            : outcome;
    }

    async function openWithViewerLifecycle(openDocument: () => Promise<TDocumentOpenOutcome>) {
        const claim = deps.readDocument().activeTransaction?.id;
        const isCurrent = () => deps.readDocument().activeTransaction?.id === claim;
        const previousWorkingCopyPath = deps.workingCopyPath.value;
        deps.onPendingOpenSuperseded();
        for (const hooks of deps.getViewerLifecycleHooks()) {
            await hooks.beforeOpen?.();
        }
        if (!isCurrent()) {
            return {status: 'cancelled'} satisfies TDocumentOpenOutcome;
        }
        const preparedOutcome = await openDocument();
        if (!isCurrent()) {
            return markOutcomeStale(preparedOutcome);
        }
        const outcome = await deps.finalizeOpen(preparedOutcome, claim);
        if (!isCurrent()) {
            return markOutcomeStale(outcome);
        }
        if (
            didOpenDocument(outcome) &&
            isOpenFileResultOfKind(outcome.result, 'pdf') &&
            deps.shouldReleaseActiveDjvu(previousWorkingCopyPath)
        ) {
            deps.onActiveDjvuSourceReleased();
        }
        for (const hooks of deps.getViewerLifecycleHooks()) {
            await hooks.afterOpen?.(outcome, {previousWorkingCopyPath});
            if (!isCurrent()) {
                return markOutcomeStale(outcome);
            }
        }
        return outcome;
    }

    async function closeFileWithViewerLifecycle() {
        const {identity, activeTransaction: initialTransaction} = deps.readDocument();
        // Only another document's commit replaces the instance; a claim alone does not.
        const isSameDocument = () => deps.readDocument().identity.documentInstanceId === identity.documentInstanceId;
        const hasNewerOpenClaim = () => {
            const currentTransaction = deps.readDocument().activeTransaction;
            return currentTransaction !== null && currentTransaction.kind !== 'close' && currentTransaction.id !== initialTransaction?.id;
        };
        deps.onPendingOpenSuperseded();
        await deps.cancelActiveDjvuWork();
        if (!isSameDocument()) {
            return;
        }
        for (const hooks of deps.getViewerLifecycleHooks()) {
            await hooks.beforeClose?.();
            if (!isSameDocument()) {
                return;
            }
        }
        if (!hasNewerOpenClaim()) {
            deps.onPendingOpenSuperseded();
        }
        deps.onActiveDjvuSourceReleased();
        await deps.closeFile();
    }

    return {
        openFileWithViewerLifecycle: (preSelected?: TOpenFileResult) => openWithViewerLifecycle(() => deps.openFile(preSelected)),
        openFileDirectWithViewerLifecycle: (path: TDocumentRef, options?: IDocumentDirectOpenOptions) =>
            openWithViewerLifecycle(() => deps.openFileDirect(path, options)),
        openFileDirectBatchWithViewerLifecycle: (paths: TDocumentRef[]) => openWithViewerLifecycle(() => deps.openFileDirectBatch(paths)),
        closeFileWithViewerLifecycle,
    };
}

export const useWorkspaceFileLifecycleController = (options: IUseWorkspaceFileLifecycleControllerOptions) => {
    const {t} = useTypedI18n();
    const getViewerLifecycleHooks = () => options.createViewerLifecycleHooks?.() ?? [];
    // An open's admitted source, before any page of it is drawn.
    async function admitOpeningSource(source: TDocumentRef, pageCount: () => Promise<number | null>) {
        for (const hooks of getViewerLifecycleHooks()) {
            await hooks.beforeSourcePresented?.(source, pageCount);
        }
    }
    const pdfFile = usePdfFile(options);
    const {
        pdfSrc,
        workingCopyPath,
        documentRevisionInfo,
        originalPath,
        recoveryDirtyBaseline,
        error: pdfError,
        failurePresentation: pdfFailurePresentation,
        isElectron,
        pendingDjvu,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    } = pdfFile;

    const djvu = useDjvu({
        getOpenSurface: options.getOpenSurface,
        // Names the document's file for its tabs, which open it when shown.
        assignDocument: options.document.assign,
    });
    const isDjvuMode = computed(() => djvu.source.value.isDjvuMode);
    const djvuSourcePath = computed(() => djvu.source.value.sourcePath);
    const djvuError = computed(() => djvu.source.value.sourceError);
    const djvuOpeningPath = computed(() => djvu.source.value.openingPath);
    const djvuSourceSizeBytes = computed(() => djvu.source.value.sourceSizeBytes);
    const conversionState = djvu.conversionState;

    const djvuShowBanner = ref(true);
    const showConvertDialog = ref(false);

    function openConvertDialog() {
        if (!isDjvuMode.value) {
            return;
        }
        showConvertDialog.value = true;
    }

    function setConvertDialogOpen(open: boolean) {
        showConvertDialog.value = open && isDjvuMode.value;
    }

    function djvuDismissBanner() {
        djvuShowBanner.value = false;
    }

    function releaseActiveDjvuSource() {
        showConvertDialog.value = false;
        djvu.releaseActiveSource();
    }

    let djvuProjectionAbortController = new AbortController();

    function cancelDjvuProjection() {
        djvuProjectionAbortController.abort();
    }

    function getDjvuProjectionSignal() {
        if (djvuProjectionAbortController.signal.aborted) {
            djvuProjectionAbortController = new AbortController();
        }
        return djvuProjectionAbortController.signal;
    }

    tryOnScopeDispose(cancelDjvuProjection);

    const {loadRecentFiles} = useRecentFiles();

    async function commitPendingDjvuOpen(outcome: TDocumentOpenOutcome, openTransactionId: string | undefined) {
        BrowserLogger.info('djvu-open-transaction', 'Finalize requested', {
            status: outcome.status,
            resultKind: 'result' in outcome ? outcome.result.kind : null,
            resultPath: 'result' in outcome ? outcome.result.originalPath : null,
            pendingPath: pendingDjvu.value,
        });
        if (outcome.status !== 'prepared') {
            return outcome;
        }
        if (!isDjvuOpenResult(outcome.result)) {
            return {
                status: 'failed',
                error: 'Only DjVu opens may require activation',
            } satisfies TDocumentOpenOutcome;
        }
        const djvuPath = outcome.result.originalPath;
        if (pendingDjvu.value !== djvuPath) {
            BrowserLogger.warn('djvu-open-transaction', 'Finalize rejected', {
                reason: 'pending-path-mismatch',
                djvuPath,
                pendingPath: pendingDjvu.value,
            });
            return {
                status: 'stale',
                result: outcome.result,
            } satisfies TDocumentOpenOutcome;
        }
        pendingDjvu.value = null;
        djvuShowBanner.value = true;
        BrowserLogger.info('djvu-open-transaction', 'Pending command consumed', {
            reason: 'activation-owner-acquired',
            djvuPath,
        });
        try {
            const activated = await djvu.openDjvuFile(djvuPath, {
                // After main accepts the DjVu and before its pages are shown.
                closeActiveDocument: async (pageCount) => {
                    await closeFile();
                    return admitOpeningSource(djvuPath, () => Promise.resolve(pageCount));
                },
                setOriginalPath: (path) => {
                    options.document.commitFile(
                        {
                            originalPath: path,
                            isDjvu: true,
                        },
                        openTransactionId,
                    );
                },
            });
            BrowserLogger.info('djvu-open-transaction', 'Activation returned', {
                activated,
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
            });
            if (!activated) {
                return {
                    status: 'stale',
                    result: outcome.result,
                } satisfies TDocumentOpenOutcome;
            }
        } catch (error) {
            // useDjvu already recorded the failure; its receipt is reused.
            const presentation = describeDocumentOpenFailure(error, t);
            pdfFailurePresentation.value = presentation;
            pdfError.value = presentation.description;
            return {
                status: 'failed',
                error: presentation.description,
            } satisfies TDocumentOpenOutcome;
        }
        if (!isDjvuMode.value || djvuSourcePath.value !== djvuPath) {
            BrowserLogger.warn('djvu-open-transaction', 'Activation state rejected', {
                reason: !isDjvuMode.value ? 'djvu-mode-inactive' : 'source-path-mismatch',
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
            });
            return {
                status: 'stale',
                result: outcome.result,
            } satisfies TDocumentOpenOutcome;
        }
        BrowserLogger.info('djvu-open-transaction', 'Finalize committed', {
            reason: 'source-active',
            djvuPath,
        });
        // The activated page source reaches the screen in each view's renderer.
        return {
            status: 'opened',
            result: outcome.result,
            presentation: null,
        } satisfies TDocumentOpenOutcome;
    }

    // Cancel and Close stop the document's conversion the same way, and a
    // close waits until it has stopped before releasing the source.
    async function handleDjvuCancel() {
        cancelDjvuProjection();
        if (djvuSourcePath.value) {
            await djvu.cancelActiveJobs();
        }
    }

    const {
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    } = createWorkspaceFileSwitch({
        readDocument: () => options.document.snapshot.value,
        workingCopyPath,
        getViewerLifecycleHooks,
        onPendingOpenSuperseded: djvu.supersedePendingOpen,
        cancelActiveDjvuWork: handleDjvuCancel,
        shouldReleaseActiveDjvu: (previousWorkingCopyPath) => isDjvuMode.value && workingCopyPath.value !== previousWorkingCopyPath,
        onActiveDjvuSourceReleased: releaseActiveDjvuSource,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        finalizeOpen: commitPendingDjvuOpen,
        closeFile,
    });

    // An open the workspace starts on its own (a converted DjVu, a split
    // restore) ends with the document's open transaction, once the viewer
    // presents the document, so what waits for it sees a live document.
    async function openInDocumentTransaction(
        request: IWorkspaceOpenRequest,
        open: () => Promise<TDocumentOpenOutcome>,
    ): Promise<TDocumentOpenOutcome> {
        const opened: {outcome: TDocumentOpenOutcome} = {outcome: {status: 'cancelled'}};
        const presented = await options.runDocumentOpen(request, async () => (opened.outcome = await open()));
        return presented || !didOpenDocument(opened.outcome) ? opened.outcome : {status: 'cancelled'};
    }

    // A moved tab's document: it brings its own view.
    function openFileInDocumentTransaction(result: TOpenFileResult, transactionId?: string) {
        return openInDocumentTransaction(
            {
                ...describeOpenResult(result),
                carriesView: true,
                transactionId,
            },
            () => openFileWithViewerLifecycle(result),
        );
    }

    // Conversion restores the retained reading view before returning focus.
    function openConvertedDjvuPdf(path: TDocumentRef, openOptions?: IPdfRasterDisplayProfileOpenOptions) {
        return openInDocumentTransaction(
            {
                kind: 'restore',
                target: describeDocumentTarget(path),
            },
            () => openFileDirectWithViewerLifecycle(path, openOptions),
        );
    }

    function handleDjvuConvert(subsample: number, preserveBookmarks: boolean, pdfStrategy: TDjvuPdfExportStrategy) {
        return djvu.convertToPdf(subsample, preserveBookmarks, pdfStrategy, openConvertedDjvuPdf);
    }

    function ensureDjvuPdfProjection(reason: TPdfProjectionReason) {
        return djvu.ensurePdfProjectionForAction(reason, openConvertedDjvuPdf, getDjvuProjectionSignal());
    }

    function initFromStorage() {
        if (import.meta.dev) {
            BrowserLogger.debug('workspace', 'Electron API available', isElectron.value);
        }

        void loadRecentFiles();
    }

    const hasPdf = computed(() => !!pdfSrc.value);
    const documentKey = computed(() => originalPath.value ?? documentRevisionInfo.value?.documentRef ?? workingCopyPath.value);

    return {
        fileName: pdfFile.fileName,
        isDirty: pdfFile.isDirty,
        originalPath,
        pdfData: pdfFile.pdfData,
        pdfRasterDisplayProfile: pdfFile.pdfRasterDisplayProfile,
        pdfReloadSrc: pdfFile.pdfReloadSrc,
        pdfSrc,
        publishPdfSource: pdfFile.publishPdfSource,
        requiresSaveAsOnFirstSave: pdfFile.requiresSaveAsOnFirstSave,
        recoveryDirtyBaseline,
        wasEncrypted: pdfFile.wasEncrypted,
        workingCopyPath,
        openedWorkingCopyPath: pdfFile.openedWorkingCopyPath,
        documentRevisionInfo,
        documentRevisionToken: pdfFile.documentRevisionToken,
        notifyPdfInitialVisualReady: pdfFile.notifyPdfInitialVisualReady,
        pickFileToOpen: pdfFile.pickFileToOpen,
        ensureHistoryBaselineForMutation: pdfFile.ensureHistoryBaselineForMutation,
        reloadWorkingCopyRevision: pdfFile.reloadWorkingCopyRevision,
        reloadWorkingCopyIntoHistory: pdfFile.reloadWorkingCopyIntoHistory,
        mapHistoryPage: pdfFile.mapHistoryPage,
        setWorkspaceCommandSink: pdfFile.setWorkspaceCommandSink,
        ...(pdfFile.repairWorkingCopy ? {repairWorkingCopy: pdfFile.repairWorkingCopy} : {}),
        ...(pdfFile.optimizeWorkingCopy ? {optimizeWorkingCopy: pdfFile.optimizeWorkingCopy} : {}),
        ...(pdfFile.optimizeWorkingCopyAsCopy ? {optimizeWorkingCopyAsCopy: pdfFile.optimizeWorkingCopyAsCopy} : {}),
        saveWorkingCopy: pdfFile.saveWorkingCopy,
        trySavePdfNativeMutations: pdfFile.trySavePdfNativeMutations,
        saveWorkingCopyAs: pdfFile.saveWorkingCopyAs,
        closeFile,
        markDirty: pdfFile.markDirty,

        admitOpeningSource: (source: TDocumentRef, pageCount: () => Promise<number | null>) =>
            recoveryDirtyBaseline.value ? Promise.resolve() : admitOpeningSource(source, pageCount),
        pdfError,
        pdfFailurePresentation,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuShowBanner,
        showConvertDialog,
        djvuError,
        djvuOpeningPath,
        djvuSourceSizeBytes,
        openConvertDialog,
        setConvertDialogOpen,
        djvuDismissBanner,
        handleDjvuConvert,
        ensureDjvuPdfProjection,
        handleDjvuCancel,

        loadRecentFiles,

        openFileWithViewerLifecycle,
        openFileInDocumentTransaction,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,

        hasPdf,
        documentKey,
        initFromStorage,
    };
};
