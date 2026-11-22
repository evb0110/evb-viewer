import {
    useOcrTextContent, type IPdfSourceJob, type TPdfSourceJobIntent,
} from '@app/modules/pdf-viewer/public';
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
    type TDocumentFileRecord,
} from '@app/modules/workspace-shell/composables/document-session/documentSessionState';

export interface IPdfFileOptions extends IHistoryRevisionSwapOptions {
    /** The document controller whose record this file session reads and writes. */
    document: TDocumentFileRecord;
    /** Admits each published PDF source to the document's PDF session. */
    admitPdfSource: (intent: TPdfSourceJobIntent) => IPdfSourceJob;
    /** Empties the views of the document a new one replaces. */
    resetDocumentPresentation: () => void;
    /** Dismisses what belonged to the working copy a Save As or an optimized copy moved from. */
    dismissWorkingPathState: () => void;
}

export const usePdfFile = (options: IPdfFileOptions) => {
    const { t } = useTypedI18n();

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const { isDesktopRuntime } = useRuntimeEnvironment();
    const sessionState = createDocumentSessionState({
        isDesktopRuntime,
        document: options.document,
        admitPdfSource: options.admitPdfSource,
    });
    const {
        isDirty,
        workingCopyPath,
        openedWorkingCopyPath,
    } = sessionState;
    // A file open, a replay or a close is current while the controller's open transaction is the one it started under.
    // A close is not an open: work that began before it stays current through its Cancel.
    const readOpenTransactionId = () => {
        const transaction = options.document.snapshot.value.activeTransaction;
        return transaction?.kind === 'close' ? null : transaction?.id ?? null;
    };
    const {
        clearPdfConformanceProfile,
        deferPdfConformanceProfile,
        notifyPdfInitialVisualReady,
        shouldForceSaveAsForWorkingCopy,
    } = createDocumentConformance(sessionState);
    const history = createDocumentHistory(sessionState, {
        ...options,
        applyLoadedPdfState: (...args) => documentOpenFlow.applyLoadedPdfState(...args),
        clearOcrCache,
        documentFiles: getDocumentFilesCapability,
        documentWorkingCopy: getDocumentWorkingCopyCapability,
        readOpenTransactionId,
        readDocumentSessionKey: () => options.document.snapshot.value.identity.documentSessionKey,
        readPdfStateFromPath: (...args) => documentOpenFlow.readPdfStateFromPath(...args),
    });
    const documentOpenFlow: ReturnType<typeof createDocumentOpenFlow> = createDocumentOpenFlow(sessionState, {
        cleanupAbandonedWorkingCopy: path => getDocumentWorkingCopyCapability().cleanupFile(path),
        clearPdfConformanceProfile,
        cleanupPreviousWorkingCopy: history.cleanupPreviousWorkingCopy,
        deferPdfConformanceProfile,
        resetCommandSink: history.resetCommandSink,
        readOpenTransactionId,
        resetDocumentPresentation: options.resetDocumentPresentation,
        resetHistory: history.resetHistory,
        syncDirtyFromHistory: history.syncDirtyFromHistory,
        t,
    });
    const persistence = createDocumentPersistence(sessionState, {
        onWorkingCopyMoved: options.dismissWorkingPathState,
        refreshDocumentRevisionToken: documentOpenFlow.refreshDocumentRevisionToken,
        deferPdfConformanceProfile,
        captureHistoryCleanState: history.captureHistoryCleanState,
        readPdfStateFromPath: documentOpenFlow.readPdfStateFromPath,
        shouldForceSaveAsForWorkingCopy,
        t,
        toPdfBlob: documentOpenFlow.toPdfBlob,
    });

    function clearDocumentHistory() {
        history.resetCommandSink();
        history.clearHistory();
    }

    // Every clear of a shown PDF source empties its views with it.
    async function closeFile() {
        const pathsToCleanup = [...new Set([
            workingCopyPath.value,
            openedWorkingCopyPath.value,
        ].flatMap(path => path ? [path] : []))];

        // M4.3: Clear OCR cache for the current file before closing
        pathsToCleanup.forEach(path => clearOcrCache(path));

        if (sessionState.pdfSrc.value) options.resetDocumentPresentation();
        const cleared = sessionState.resetForClose();
        clearPdfConformanceProfile();
        clearDocumentHistory();
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
        return cleared;
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
        ensureHistoryBaselineForMutation: history.ensureHistoryBaselineForMutation,
        reloadWorkingCopyRevision: history.reloadWorkingCopyRevision,
        reloadWorkingCopyIntoHistory: history.reloadWorkingCopyIntoHistory,
        mapHistoryPage: history.mapHistoryPage,
        fileHistoryMutationVersion: history.fileHistoryMutationVersion,
        setWorkspaceCommandSink: history.setWorkspaceCommandSink,
        ...(typeof documentFiles.repairPdf === 'function' ? { repairWorkingCopy: persistence.repairWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfForInteraction === 'function' ? { optimizeWorkingCopy: persistence.optimizeWorkingCopy } : {}),
        ...(typeof documentFiles.optimizePdfAsCopy === 'function' ? { optimizeWorkingCopyAsCopy: persistence.optimizeWorkingCopyAsCopy } : {}),
        saveWorkingCopy: persistence.saveWorkingCopy,
        trySavePdfNativeMutations: persistence.trySavePdfNativeMutations,
        saveWorkingCopyAs: persistence.saveWorkingCopyAs,
        closeFile,
        clearDocumentHistory,
        markDirty,
    };
};
