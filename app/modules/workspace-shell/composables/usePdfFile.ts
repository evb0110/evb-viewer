import {tryOnScopeDispose} from '@vueuse/core';
import {registerBrowserDocumentDependencyReader} from '@app/platform/browserWindowTabs';
import { useOcrTextContent } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { createDocumentConformance } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { createDocumentHistory } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import {
    createDocumentOpenFlow,
    type ICreateDocumentOpenFlowDeps,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { createDocumentPersistence } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistence';
import {
    createDocumentSessionState,
    createEpochGuard,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';


export const usePdfFile = (options: Pick<ICreateDocumentOpenFlowDeps, 'admitOpeningSource'> = {}) => {
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
        pdfReloadSrc,
        pdfSrc,
        pendingDjvu,
        requiresSaveAsOnFirstSave,
        recoveryDirtyBaseline,
        wasEncrypted,
        resetForClose,
        workingCopyPath,
        openedWorkingCopyPath,
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
    const {
        canRedo,
        canUndo,
        cleanupPreviousWorkingCopy,
        clearHistory,
        ensureHistoryBaselineForMutation,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        getHistoryDebugState,
        readDocumentDependencies,
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
        applyLoadedPdfState: (...args) => documentOpenFlow.applyLoadedPdfState(...args),
        clearPdfConformanceProfile,
        clearOcrCache,
        deferPdfConformanceProfile,
        documentFiles: getDocumentFilesCapability,
        documentWorkingCopy: getDocumentWorkingCopyCapability,
        getOpenEpoch: () => openEpoch.current(),
        isCurrentOpenEpoch: token => openEpoch.isCurrent(token),
        readPdfStateFromPath: (...args) => documentOpenFlow.readPdfStateFromPath(...args),
        toPdfBlob: (...args) => documentOpenFlow.toPdfBlob(...args),
    });
    if (!isElectron.value) {
        const readDependencies = () => [
            workingCopyPath.value,
            originalPath.value,
            ...readDocumentDependencies(),
        ].flatMap(ref => ref ? [ref] : []);
        tryOnScopeDispose(registerBrowserDocumentDependencyReader(readDependencies));
    }
    const documentOpenFlow: ReturnType<typeof createDocumentOpenFlow> = createDocumentOpenFlow(sessionState, {
        cleanupAbandonedWorkingCopy: path => getDocumentWorkingCopyCapability().cleanupFile(path),
        clearPdfConformanceProfile,
        cleanupPreviousWorkingCopy,
        deferPdfConformanceProfile,
        ensureHistoryBaselineForMutation,
        incrementSessionVersion,
        loadEpoch,
        openEpoch,
        pushHistorySnapshot,
        resetHistory,
        syncDirtyFromHistory,
        t,
        ...options,
    });
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
        refreshDocumentRevisionToken: documentOpenFlow.refreshDocumentRevisionToken,
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

    async function closeFile() {
        openEpoch.invalidate();
        loadEpoch.invalidate();
        const pathsToCleanup = [...new Set([
            workingCopyPath.value,
            openedWorkingCopyPath.value,
        ].flatMap(path => path ? [path] : []))];

        // M4.3: Clear OCR cache for the current file before closing
        pathsToCleanup.forEach(path => clearOcrCache(path));

        resetForClose();
        clearPdfConformanceProfile();
        incrementSessionVersion();
        clearHistory();
        await Promise.all(pathsToCleanup.map(path =>
            getDocumentWorkingCopyCapability().cleanupFile(path).catch((cleanupError: unknown) => {
                BrowserLogger.warn(
                    'pdf-file',
                    'Failed to cleanup closed working copy',
                    {
                        path,
                        error: cleanupError,
                    },
                );
            }),
        ));
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
        pdfReloadSrc,
        pdfData,
        pdfRasterDisplayProfile,
        workingCopyPath,
        openedWorkingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
        originalPath,
        requiresSaveAsOnFirstSave,
        recoveryDirtyBaseline,
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
