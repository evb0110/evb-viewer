import {tryOnScopeDispose} from '@vueuse/core';
import {registerBrowserDocumentDependencyReader} from '@app/platform/browserWindowTabs';
import { useOcrTextContent } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { createDocumentConformance } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import type { IHistoryRevisionSwapOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createDocumentHistory } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import { createDocumentOpenFlow } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import { createDocumentPersistence } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistence';
import {
    createDocumentSessionState,
    createEpochGuard,
    type TDocumentFileRecord,
} from '@app/modules/workspace-shell/composables/document-session/documentSessionState';

export interface IPdfFileOptions extends IHistoryRevisionSwapOptions {
    /** The document controller whose record this file session reads and writes. */
    document: TDocumentFileRecord;
}

export const usePdfFile = (options: IPdfFileOptions) => {
    const { t } = useTypedI18n();

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const { isDesktopRuntime } = useRuntimeEnvironment();
    const sessionState = createDocumentSessionState({
        isDesktopRuntime,
        document: options.document,
    });
    const {
        isDirty,
        originalPath,
        workingCopyPath,
        openedWorkingCopyPath,
    } = sessionState;
    const loadEpoch = createEpochGuard();
    const openEpoch = createEpochGuard();
    const {
        clearPdfConformanceProfile,
        deferPdfConformanceProfile,
        notifyPdfInitialVisualReady,
        shouldForceSaveAsForWorkingCopy,
    } = createDocumentConformance(sessionState);
    const history = createDocumentHistory(sessionState, {
        ...options,
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
    if (!sessionState.isElectron.value) {
        const readDependencies = () => [
            workingCopyPath.value,
            originalPath.value,
            ...history.readDocumentDependencies(),
        ].flatMap(ref => ref ? [ref] : []);
        tryOnScopeDispose(registerBrowserDocumentDependencyReader(readDependencies));
    }
    const documentOpenFlow: ReturnType<typeof createDocumentOpenFlow> = createDocumentOpenFlow(sessionState, {
        cleanupAbandonedWorkingCopy: path => getDocumentWorkingCopyCapability().cleanupFile(path),
        clearPdfConformanceProfile,
        cleanupPreviousWorkingCopy: history.cleanupPreviousWorkingCopy,
        deferPdfConformanceProfile,
        ensureHistoryBaselineForMutation: history.ensureHistoryBaselineForMutation,
        incrementSessionVersion: history.incrementSessionVersion,
        loadEpoch,
        openEpoch,
        pushHistorySnapshot: history.pushHistorySnapshot,
        resetHistory: history.resetHistory,
        syncDirtyFromHistory: history.syncDirtyFromHistory,
        t,
    });
    const persistence = createDocumentPersistence(sessionState, {
        refreshDocumentRevisionToken: documentOpenFlow.refreshDocumentRevisionToken,
        deferPdfConformanceProfile,
        ensureHistoryBaselineForMutation: history.ensureHistoryBaselineForMutation,
        captureHistoryCleanState: history.captureHistoryCleanState,
        pushHistorySnapshot: history.pushHistorySnapshot,
        readPdfStateFromPath: documentOpenFlow.readPdfStateFromPath,
        shouldForceSaveAsForWorkingCopy,
        t,
        toPdfBlob: documentOpenFlow.toPdfBlob,
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

        sessionState.resetForClose();
        clearPdfConformanceProfile();
        history.incrementSessionVersion();
        history.clearHistory();
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
            ...history.getHistoryDebugState(),
            stack: new Error().stack?.split('\n').slice(1, 6),
        }));
        isDirty.value = true;
    }

    const documentFiles = getDocumentFilesCapability();

    return {
        ...sessionState,
        notifyPdfInitialVisualReady,
        pickFileToOpen: documentOpenFlow.pickFileToOpen,
        openFile: documentOpenFlow.openFile,
        openFileDirect: documentOpenFlow.openFileDirect,
        openFileDirectBatch: documentOpenFlow.openFileDirectBatch,
        loadPdfFromPath: documentOpenFlow.loadPdfFromPath,
        loadPdfFromData: documentOpenFlow.loadPdfFromData,
        ensureHistoryBaselineForMutation: history.ensureHistoryBaselineForMutation,
        reloadWorkingCopyRevision: history.reloadWorkingCopyRevision,
        reloadWorkingCopyIntoHistory: history.reloadWorkingCopyIntoHistory,
        mapHistoryPage: history.mapHistoryPage,
        fileHistoryMutationVersion: history.fileHistoryMutationVersion,
        fileHistorySessionVersion: history.fileHistorySessionVersion,
        setWorkspaceCommandSink: history.setWorkspaceCommandSink,
        persistPdfDataSilently: persistence.persistPdfDataSilently,
        ...(typeof documentFiles.repairPdf === 'function' ? { repairWorkingCopy: persistence.repairWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfForInteraction === 'function' ? { optimizeWorkingCopy: persistence.optimizeWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfAsCopy === 'function' ? { optimizeWorkingCopyAsCopy: persistence.optimizeWorkingCopyAsCopy } : {}),
        saveWorkingCopy: persistence.saveWorkingCopy,
        trySavePdfNativeMutations: persistence.trySavePdfNativeMutations,
        saveWorkingCopyAs: persistence.saveWorkingCopyAs,
        closeFile,
        markDirty,
    };
};
