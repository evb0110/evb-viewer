import { useAnalytics } from '@app/composables/useAnalytics';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import { useOcrTextContent } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { createDocumentConformance } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { createDocumentHistory } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { createDocumentPersistence } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistence';
import {
    createDocumentSessionState,
    createEpochGuard,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { TWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';

let nextPdfFileAnalyticsScopeIndex = 0;

export interface IUsePdfFileOptions {
    analyticsDocumentScope?: IAnalyticsDocumentScope | undefined;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
    failureSurface?: TWorkspaceFailureSurface | undefined;
}

export const usePdfFile = (options: IUsePdfFileOptions = {}) => {
    const analytics = useAnalytics();
    const analyticsDocumentScope = options.analyticsDocumentScope
        ?? analytics.createDocumentScope(`pdf-file:${++nextPdfFileAnalyticsScopeIndex}`, { activate: true });
    const { t } = useTypedI18n();

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const { isDesktopRuntime } = useRuntimeEnvironment();
    const sessionState = createDocumentSessionState({isDesktopRuntime});
    const {
        error,
        failurePresentation,
        fileName,
        isDirty,
        isElectron,
        lastSaveMode,
        openBatchProgress,
        originalPath,
        pdfConformanceAnalysisState,
        pdfConformanceProfile,
        pdfData,
        pdfRasterDisplayProfile,
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
        pdfReloadSrc,
        pdfSrc,
        pendingDjvu,
        requiresSaveAsOnFirstSave,
        wasEncrypted,
        resetForClose,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
    } = sessionState;
    const loadEpoch = createEpochGuard();
    const openEpoch = createEpochGuard();
    const {
        clearPdfConformanceProfile,
        deferPdfConformanceProfile,
        notifyPdfInitialVisualReady,
        shouldForceSaveAsForWorkingCopy,
    } = createDocumentConformance(sessionState);
    const documentOpenFlowRef: { current: ReturnType<typeof createDocumentOpenFlow> | null } = {current: null};
    function getDocumentOpenFlow() {
        if (!documentOpenFlowRef.current) {
            throw new Error('Document open flow is not initialized');
        }
        return documentOpenFlowRef.current;
    }

    const {
        canRedo,
        canUndo,
        cleanupPreviousWorkingCopy,
        clearHistory,
        ensureHistoryBaselineForMutation,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        getHistoryDebugState,
        incrementSessionVersion,
        markCurrentHistoryEntryClean,
        pushHistorySnapshot,
        redo,
        reloadWorkingCopyIntoHistory,
        resetHistory,
        setWorkspaceCommandSink,
        syncDirtyFromHistory,
        undo,
    } = createDocumentHistory(sessionState, {
        applyLoadedPdfState: (...args) => getDocumentOpenFlow().applyLoadedPdfState(...args),
        clearPdfConformanceProfile,
        clearOcrCache,
        deferPdfConformanceProfile,
        documentFiles: getDocumentFilesCapability,
        documentWorkingCopy: getDocumentWorkingCopyCapability,
        getOpenEpoch: () => openEpoch.current(),
        isCurrentOpenEpoch: token => openEpoch.isCurrent(token),
        readPdfStateFromPath: (...args) => getDocumentOpenFlow().readPdfStateFromPath(...args),
        toPdfBlob: (...args) => getDocumentOpenFlow().toPdfBlob(...args),
    });
    const documentOpenFlow = createDocumentOpenFlow(sessionState, {
        analytics,
        analyticsDocumentScope,
        cleanupAbandonedWorkingCopy: path => getDocumentWorkingCopyCapability().cleanupFile(path),
        clearPdfConformanceProfile,
        cleanupPreviousWorkingCopy,
        deferPdfConformanceProfile,
        ensureHistoryBaselineForMutation,
        incrementSessionVersion,
        loadEpoch,
        openSurface: options.openSurface,
        ...(options.failureSurface?.reportOpenFailure
            ? {reportOpenFailure: options.failureSurface.reportOpenFailure}
            : {}),
        openEpoch,
        pushHistorySnapshot,
        resetHistory,
        syncDirtyFromHistory,
        t,
    });
    documentOpenFlowRef.current = documentOpenFlow;
    const {
        loadPdfFromData,
        loadPdfFromPath,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        pickFileToOpen,
        readPdfStateFromPath,
        toPdfBlob,
    } = documentOpenFlow;
    const {
        persistPdfDataSilently,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
        saveWorkingCopy,
        saveWorkingCopyAs,
        trySaveEmbeddedNoteTextUpdates,
        trySavePdfNativeMutations,
    } = createDocumentPersistence(sessionState, {
        deferPdfConformanceProfile,
        ensureHistoryBaselineForMutation,
        getHistoryDebugState,
        markCurrentHistoryEntryClean,
        pushHistorySnapshot,
        readPdfStateFromPath,
        shouldForceSaveAsForWorkingCopy,
        t,
        toPdfBlob,
    });

    function closeFile() {
        openEpoch.invalidate();
        loadEpoch.invalidate();
        const pathToCleanup = workingCopyPath.value;

        // M4.3: Clear OCR cache for the current file before closing
        if (pathToCleanup) {
            clearOcrCache(pathToCleanup);
        }

        resetForClose();
        clearPdfConformanceProfile();
        analyticsDocumentScope.clear();
        incrementSessionVersion();
        clearHistory();
        if (pathToCleanup) {
            getDocumentWorkingCopyCapability().cleanupFile(pathToCleanup).catch((cleanupError: unknown) => {
                BrowserLogger.warn(
                    'pdf-file',
                    'Failed to cleanup closed working copy',
                    {
                        path: pathToCleanup,
                        error: cleanupError,
                    },
                );
            });
        }
    }

    function markDirty() {
        BrowserLogger.debug('workspace', 'File dirty flag set', () => ({
            isDirty: isDirty.value,
            ...getHistoryDebugState(),
            stack: new Error().stack?.split('\n').slice(1, 6),
        }));
        isDirty.value = true;
    }

    const documentFiles = getDocumentFilesCapability();

    return {
        pdfSrc,
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
        pdfReloadSrc,
        pdfData,
        pdfRasterDisplayProfile,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        originalPath,
        requiresSaveAsOnFirstSave,
        wasEncrypted,
        fileName,
        error,
        failurePresentation,
        isDirty,
        pdfConformanceAnalysisState,
        pdfConformanceProfile,
        lastSaveMode,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        notifyPdfInitialVisualReady,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        saveFile,
        ...(typeof documentFiles.repairPdf === 'function' ? { repairWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfForInteraction === 'function' ? { optimizeWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfAsCopy === 'function' ? { optimizeWorkingCopyAsCopy } : {}),
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        closeFile,
        markDirty,
        canUndo,
        canRedo,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        setWorkspaceCommandSink,
        undo,
        redo,
    };
};
