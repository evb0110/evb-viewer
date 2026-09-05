import type { TDjvuPdfExportStrategy } from '@contracts/electronApiDjvu';
import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { usePdfFile } from '@app/modules/workspace-shell/composables/usePdfFile';
import { useDjvu } from '@app/composables/useDjvu';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { TPdfProjectionReason } from '@app/utils/document-viewer/session/documentSession';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TDocumentDirectOpenOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import type { TWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';

interface IUseWorkspaceFileLifecycleControllerOptions {
    analyticsDocumentScope?: IAnalyticsDocumentScope | undefined;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
    failureSurface?: TWorkspaceFailureSurface | undefined;
}

function createWorkspaceFileSwitch(deps: {
    workingCopyPath: Ref<TDocumentRef | null>;
    viewerLifecycleHooks: IWorkspaceViewerLifecycleHooks[];
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef, options?: TDocumentDirectOpenOptions) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    finalizeOpen: (outcome: TDocumentOpenOutcome) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void;
}) {
    let lifecycleGeneration = 0;

    function markOutcomeStale(outcome: TDocumentOpenOutcome): TDocumentOpenOutcome {
        return 'result' in outcome
            ? {
                status: 'stale',
                result: outcome.result,
            }
            : outcome;
    }

    async function openWithViewerLifecycle(
        openDocument: () => Promise<TDocumentOpenOutcome>,
    ) {
        const generation = ++lifecycleGeneration;
        const previousWorkingCopyPath = deps.workingCopyPath.value;
        for (const hooks of deps.viewerLifecycleHooks) {
            await hooks.beforeOpen?.();
        }
        const preparedOutcome = await openDocument();
        if (generation !== lifecycleGeneration) {
            return markOutcomeStale(preparedOutcome);
        }
        const outcome = await deps.finalizeOpen(preparedOutcome);
        if (generation !== lifecycleGeneration) {
            return markOutcomeStale(outcome);
        }
        for (const hooks of deps.viewerLifecycleHooks) {
            await hooks.afterOpen?.(outcome, { previousWorkingCopyPath });
            if (generation !== lifecycleGeneration) {
                return markOutcomeStale(outcome);
            }
        }
        return outcome;
    }

    async function closeFileWithViewerLifecycle() {
        const generation = ++lifecycleGeneration;
        for (const hooks of deps.viewerLifecycleHooks) {
            await hooks.beforeClose?.();
        }
        if (generation === lifecycleGeneration) {
            deps.closeFile();
            // Source watchers own derived navigation, toolbar, and chassis
            // cleanup; let them observe the empty source before close commits.
            await nextTick();
        }
    }

    return {
        pickFileToOpen: deps.pickFileToOpen,
        openFileWithViewerLifecycle: (preSelected?: TOpenFileResult) => openWithViewerLifecycle(
            () => deps.openFile(preSelected),
        ),
        openFileDirectWithViewerLifecycle: (path: TDocumentRef, options?: TDocumentDirectOpenOptions) => openWithViewerLifecycle(
            () => deps.openFileDirect(path, options),
        ),
        openFileDirectBatchWithViewerLifecycle: (paths: TDocumentRef[]) => openWithViewerLifecycle(
            () => deps.openFileDirectBatch(paths),
        ),
        closeFileWithViewerLifecycle,
    };
}

export const useWorkspaceFileLifecycleController = (
    options: IUseWorkspaceFileLifecycleControllerOptions = {},
) => {
    const {
        pdfSrc,
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
        pdfReloadSrc,
        pdfData,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        originalPath,
        requiresSaveAsOnFirstSave,
        fileName,
        isDirty,
        pdfConformanceAnalysisState,
        pdfConformanceProfile,
        pdfRasterDisplayProfile,
        lastSaveMode,
        error: pdfError,
        failurePresentation: pdfFailurePresentation,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        wasEncrypted,
        notifyPdfInitialVisualReady,
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        closeFile,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        canUndo: canUndoFile,
        canRedo: canRedoFile,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        setWorkspaceCommandSink,
        undo,
        redo,
    } = usePdfFile({
        analyticsDocumentScope: options.analyticsDocumentScope,
        openSurface: options.openSurface,
        failureSurface: options.failureSurface,
    });

    const {
        isDjvuMode,
        djvuSourcePath,
        conversionState,
        isLoadingPages: djvuIsLoadingPages,
        loadingProgress: djvuLoadingProgress,
        showBanner: djvuShowBanner,
        showConvertDialog,
        sourceError: djvuError,
        openingPath: djvuOpeningPath,
        sourceSizeBytes: djvuSourceSizeBytes,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf: djvuConvertToPdf,
        ensurePdfProjectionForAction: ensureDjvuPdfProjectionForAction,
        cancelActiveJobs: cancelDjvuJobs,
        cleanupDjvuTemp,
        captureDjvuActivation,
        exitDjvuMode,
        openConvertDialog,
        dismissBanner: djvuDismissBanner,
    } = useDjvu({openSurface: options.openSurface});

    const {
        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        removeRecentFileIfMissing,
        clearRecentFiles,
    } = useRecentFiles();

    async function commitPendingDjvuOpen(outcome: TDocumentOpenOutcome) {
        BrowserLogger.info('djvu-open-transaction', 'Finalize requested', {
            status: outcome.status,
            resultKind: 'result' in outcome ? outcome.result.kind : null,
            resultPath: 'result' in outcome ? outcome.result.originalPath : null,
            pendingPath: pendingDjvu.value,
        });
        if (outcome.status !== 'prepared') {
            return outcome;
        }
        if (outcome.result.kind !== 'djvu') {
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
        BrowserLogger.info('djvu-open-transaction', 'Pending command consumed', {
            reason: 'activation-owner-acquired',
            djvuPath,
        });
        try {
            const activated = await openDjvuFile(djvuPath, {
                closeActiveDocument: closeFile,
                setOriginalPath: (path) => {
                    originalPath.value = path;
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
            const message = error instanceof Error ? error.message : String(error);
            pdfError.value = message;
            BrowserLogger.error('djvu-open-transaction', 'Activation failed', {
                reason: 'open-djvu-threw',
                djvuPath,
                error: message,
            }, {
                code: 'RENDERER_DJVU_OPERATION_FAILED',
                context: {},
            });
            return {
                status: 'failed',
                error: message,
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
        return {
            status: 'opened',
            result: outcome.result,
        } satisfies TDocumentOpenOutcome;
    }

    const {
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    } = createWorkspaceFileSwitch({
        workingCopyPath,
        viewerLifecycleHooks: createWorkspaceViewerLifecycleHooks({
            cleanupDjvuTemp,
            captureDjvuActivation,
            exitDjvuMode,
            invalidatePendingDjvuOpen,
            isDjvuMode,
            workingCopyPath,
        }),
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        finalizeOpen: commitPendingDjvuOpen,
        closeFile,
    });

    function handleDjvuConvert(
        subsample: number,
        preserveBookmarks: boolean,
        pdfStrategy: TDjvuPdfExportStrategy,
    ) {
        return djvuConvertToPdf(subsample, preserveBookmarks, pdfStrategy, openFileDirectWithViewerLifecycle);
    }

    function ensureDjvuPdfProjection(
        reason: TPdfProjectionReason,
        signal: AbortSignal,
    ) {
        return ensureDjvuPdfProjectionForAction(reason, openFileDirectWithViewerLifecycle, signal);
    }

    function handleDjvuCancel() {
        if (djvuSourcePath.value) {
            void cancelDjvuJobs();
        }
    }

    function initFromStorage() {
        if (import.meta.dev) {
            BrowserLogger.debug('workspace', 'Electron API available', isElectron.value);
        }

        void loadRecentFiles();
    }

    const hasPdf = computed(() => !!pdfSrc.value);

    return {
        pdfSrc,
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
        pdfReloadSrc,
        pdfData,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        originalPath,
        requiresSaveAsOnFirstSave,
        wasEncrypted,
        fileName,
        isDirty,
        pdfConformanceAnalysisState,
        pdfConformanceProfile,
        pdfRasterDisplayProfile,
        lastSaveMode,
        pdfError,
        pdfFailurePresentation,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        notifyPdfInitialVisualReady,
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        closeFile,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        canUndoFile,
        canRedoFile,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        setWorkspaceCommandSink,
        undo,
        redo,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        showConvertDialog,
        djvuError,
        djvuOpeningPath,
        djvuSourceSizeBytes,
        openDjvuFile,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        ensureDjvuPdfProjection,
        handleDjvuCancel,

        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        removeRecentFileIfMissing,
        clearRecentFiles,

        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,

        hasPdf,
        initFromStorage,
    };
};
