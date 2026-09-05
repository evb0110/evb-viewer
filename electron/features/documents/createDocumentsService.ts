import {
    handleCancelOpenDocumentDirectBatch,
    handleOpenCombineDialog,
    handleOpenFolderDialog,
    handleOpenImageDialog,
    handleOpenPdfDialog,
    handleOpenPdfDirect,
    handleOpenPdfDirectBatch,
} from '@electron/features/documents/main/documentOpenHandlers';
import {
    handleBeginSavePdfDataAs,
    handleSaveDocxAs,
    handleSavePdfAs,
    handleSavePdfDataAs,
    handleSavePdfDialog,
} from '@electron/features/documents/main/documentSaveDialogHandlers';
import {
    handleSetWindowTitle,
    handleShowItemInFolder,
} from '@electron/features/documents/main/documentWindowHandlers';
import {
    handleCreateWorkingCopyFromData,
    handleCreateWorkingCopyFromPath,
} from '@electron/features/documents/main/documentWorkingCopyHandlers';
import {
    handleFileExists,
    handleFileRead,
    handleFileReadRange,
    handleFileReadText,
    handleFileStat,
} from '@electron/features/documents/main/documentFileReadHandlers';
import {
    handleCancelPdfNativePagePreview,
    handlePdfOpeningGeometry,
    handlePdfNativePagePreview,
    handlePdfNativePageSizes,
} from '@electron/features/documents/main/nativePdfPreview';
import {
    beginPdfAnnotationIndex,
    cancelPdfAnnotationIndex,
    readPdfAnnotationIndexChunk,
    releasePdfAnnotationIndex,
} from '@electron/features/documents/main/pdfAnnotationIndex';
import {
    beginPdfEmbeddedShapeIndex,
    cancelPdfEmbeddedShapeIndex,
    readPdfEmbeddedShapeIndexChunk,
    releasePdfEmbeddedShapeIndex,
} from '@electron/features/documents/main/pdfEmbeddedShapeIndex';
import {
    beginPdfAnnotationParse,
    cancelPdfAnnotationParse,
    parsePdfAnnotations,
    readPdfAnnotationParseChunk,
    releasePdfAnnotationParse,
} from '@electron/features/documents/main/pdfAnnotationParse';
import {
    handleFileWrite,
    handleFileWriteDocx,
    handleReplaceWorkingCopyFromPath,
} from '@electron/features/documents/main/documentFileWriteHandlers';
import {
    handleAnalyzePdfConformance,
    handleValidatePdfData,
    handleValidatePdfPath,
} from '@electron/features/documents/main/documentPdfValidationHandlers';
import { handleCleanupOcrTemp } from '@electron/features/documents/main/handleCleanupOcrTemp';
import {
    handleCancelPdfPrint,
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
} from '@electron/features/documents/main/print';
import { cleanupWorkingCopy } from '@electron/file-access/workingCopyCleanup';
import {
    handleFileSaveStructured,
    handleOptimizePdfForInteraction,
    handleRepairPdfSave,
    handleResyncWorkingCopy,
    handleSerializedPdfSave,
} from '@electron/features/documents/main/workingCopySave';
import { handleOptimizePdfAsCopy } from '@electron/features/documents/main/handleOptimizePdfAsCopy';
import {
    handleNativePdfMutationsApplyToWorkingCopy,
    handleCommitStagedPdfNativeMutations,
    handleNativeNoteChangesSave,
    handleNativeNoteTextSave,
    handleNativePdfMutationsSave,
} from '@electron/features/documents/main/nativePdfMutationSaveHandlers';
import {
    handleCloneStagedPdfNativeMutationToWorkingCopy,
    handleReplaceWorkingCopyFromStagedPdfNativeMutation,
} from '@electron/features/documents/main/stagedPdfNativeMutationHandlers';
import {
    beginSerializedPdfSaveToOriginal,
    cancelStagedSerializedPdf,
    commitStagedSerializedPdf,
} from '@electron/features/documents/main/serializedPdfPersistence';
import {
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
    removeRecentFileIfMissing,
} from '@electron/recentFiles';
import {
    allowRevealPaths,
    removeAllowedOpenPath,
    removeAllowedRevealPath,
} from '@electron/file-access/openPathCapabilities';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import {
    getWorkingCopyBackingEntry,
    normalizePathForLookup,
    type TWorkingCopyBackingErrorCode,
    type TWorkingCopyBackingState,
} from '@electron/file-access/workingCopyStore';
import {
    onWorkingCopyMaterializationProgress,
    type IWorkingCopyMaterializationProgress,
} from '@electron/file-access/workingCopyMaterialization';
import {
    setMenuDocumentState,
    setMenuTabCount,
    updateRecentFilesMenu,
} from '@electron/menu';
import { createLogger } from '@electron/utils/createLogger';
import type { IDocumentsService } from '@electron/features/documents/documentsService';
import type {
    IWorkingCopyBackingFailure,
    IWorkingCopyBackingStatus,
    TWorkingCopyBackingStatusState,
} from '@contracts/electronApiDocuments';
import {
    createManagedTempFileHandle,
    releaseManagedTempFileHandle,
} from '@electron/features/documents/main/managedTempFileHandles';

const logger = createLogger('documents-service');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

interface IWorkingCopyBackingStatusDispatch {
    ownerWebContentsId?: number;
    registrationId: number;
    status: IWorkingCopyBackingStatus;
}

type TDocumentsServiceArgs<TMethod extends keyof IDocumentsService> =
    IDocumentsService[TMethod] extends (...args: infer TArgs) => unknown ? TArgs : never;

function toRendererBackingState(state: TWorkingCopyBackingState): TWorkingCopyBackingStatusState {
    return state === 'lazy-original' || state === 'materializing'
        ? state
        : 'materialized';
}

function toBackingFailure(
    code: TWorkingCopyBackingErrorCode | undefined,
): IWorkingCopyBackingFailure | null {
    if (!code) {
        return null;
    }
    return {
        code,
        retryable: code === 'WORKING_COPY_MATERIALIZATION_CANCELLED'
            || code === 'WORKING_COPY_MATERIALIZATION_FAILED'
            || code === 'WORKING_COPY_MATERIALIZATION_NO_SPACE'
            || code === 'WORKING_COPY_MATERIALIZATION_VERIFICATION_FAILED',
    };
}

function toProgressStatus(
    progress: IWorkingCopyMaterializationProgress,
): IWorkingCopyBackingStatus {
    return {
        documentRef: progress.documentRef,
        failure: toBackingFailure(progress.errorCode),
        progress: progress.status === 'completed'
            ? 1
            : Math.min(1, Math.max(0, progress.percent / 100)),
        state: progress.status === 'completed'
            ? 'materialized'
            : progress.status === 'running'
                ? 'materializing'
                : 'lazy-original',
    };
}

export function createDocumentsService(): IDocumentsService {
    const backingStatusListeners = new Set<(event: IWorkingCopyBackingStatusDispatch) => void>();
    const latestBackingStatus = new Map<string, {
        registrationId: number;
        status: IWorkingCopyBackingStatus;
    }>();
    function publishBackingStatus(dispatch: IWorkingCopyBackingStatusDispatch) {
        const key = normalizePathForLookup(dispatch.status.documentRef) || dispatch.status.documentRef;
        const previous = latestBackingStatus.get(key);
        const status = previous?.registrationId === dispatch.registrationId
            ? {
                ...dispatch.status,
                progress: Math.max(previous.status.progress, dispatch.status.progress),
            }
            : dispatch.status;
        const nextDispatch = {
            ...dispatch,
            status,
        };
        latestBackingStatus.set(key, {
            registrationId: dispatch.registrationId,
            status,
        });
        for (const listener of backingStatusListeners) {
            listener(nextDispatch);
        }
    }

    onWorkingCopyMaterializationProgress((progress) => {
        const entry = getWorkingCopyBackingEntry(progress.documentRef);
        if (!entry) {
            return;
        }
        publishBackingStatus({
            ...(entry.ownerWebContentsId === undefined
                ? {}
                : {ownerWebContentsId: entry.ownerWebContentsId}),
            registrationId: entry.registrationId,
            status: toProgressStatus(progress),
        });
    });

    const service: IDocumentsService = {
        openDocumentDialog: handleOpenPdfDialog,
        openCombineDialog: (...args: TDocumentsServiceArgs<'openCombineDialog'>) => handleOpenCombineDialog(...args),
        openFolderDialog: (...args: TDocumentsServiceArgs<'openFolderDialog'>) => handleOpenFolderDialog(...args),
        openImageDialog: (...args: TDocumentsServiceArgs<'openImageDialog'>) => handleOpenImageDialog(...args),
        openDocumentDirect: handleOpenPdfDirect,
        openDocumentDirectBatch: handleOpenPdfDirectBatch,
        cancelOpenDocumentDirectBatch: handleCancelOpenDocumentDirectBatch,
        createWorkingCopyFromData: (...args: TDocumentsServiceArgs<'createWorkingCopyFromData'>) =>
            handleCreateWorkingCopyFromData(...args),
        createWorkingCopyFromPath: (...args: TDocumentsServiceArgs<'createWorkingCopyFromPath'>) =>
            handleCreateWorkingCopyFromPath(...args),
        parsePdfAnnotations: (...args: TDocumentsServiceArgs<'parsePdfAnnotations'>) =>
            parsePdfAnnotations(...args),
        savePdfAs: (...args: TDocumentsServiceArgs<'savePdfAs'>) => handleSavePdfAs(...args),
        savePdfDataAs: (...args: TDocumentsServiceArgs<'savePdfDataAs'>) => handleSavePdfDataAs(...args),
        beginSavePdfDataAs: (...args: TDocumentsServiceArgs<'beginSavePdfDataAs'>) =>
            handleBeginSavePdfDataAs(...args),
        savePdfDialog: (...args: TDocumentsServiceArgs<'savePdfDialog'>) => handleSavePdfDialog(...args),
        saveDocxAs: (...args: TDocumentsServiceArgs<'saveDocxAs'>) => handleSaveDocxAs(...args),
        readFile: (...args: TDocumentsServiceArgs<'readFile'>) => handleFileRead(...args),
        statFile: (...args: TDocumentsServiceArgs<'statFile'>) => handleFileStat(...args),
        readFileRange: (...args: TDocumentsServiceArgs<'readFileRange'>) => handleFileReadRange(...args),
        createManagedTempFileHandle: (...args: TDocumentsServiceArgs<'createManagedTempFileHandle'>) =>
            createManagedTempFileHandle(...args),
        releaseManagedTempFileHandle: (...args: TDocumentsServiceArgs<'releaseManagedTempFileHandle'>) =>
            releaseManagedTempFileHandle(...args),
        getPdfOpeningGeometry: (...args: TDocumentsServiceArgs<'getPdfOpeningGeometry'>) =>
            handlePdfOpeningGeometry(...args),
        getPdfNativePageSizes: (...args: TDocumentsServiceArgs<'getPdfNativePageSizes'>) =>
            handlePdfNativePageSizes(...args),
        cancelPdfNativePagePreview: (...args: TDocumentsServiceArgs<'cancelPdfNativePagePreview'>) =>
            handleCancelPdfNativePagePreview(...args),
        renderPdfNativePagePreview: (...args: TDocumentsServiceArgs<'renderPdfNativePagePreview'>) =>
            handlePdfNativePagePreview(...args),
        beginPdfAnnotationIndex: (...args: TDocumentsServiceArgs<'beginPdfAnnotationIndex'>) =>
            beginPdfAnnotationIndex(...args),
        readPdfAnnotationIndexChunk: (...args: TDocumentsServiceArgs<'readPdfAnnotationIndexChunk'>) =>
            readPdfAnnotationIndexChunk(...args),
        releasePdfAnnotationIndex: (...args: TDocumentsServiceArgs<'releasePdfAnnotationIndex'>) =>
            releasePdfAnnotationIndex(...args),
        cancelPdfAnnotationIndex: (...args: TDocumentsServiceArgs<'cancelPdfAnnotationIndex'>) =>
            cancelPdfAnnotationIndex(...args),
        beginPdfAnnotationParse: (...args: TDocumentsServiceArgs<'beginPdfAnnotationParse'>) =>
            beginPdfAnnotationParse(...args),
        readPdfAnnotationParseChunk: (...args: TDocumentsServiceArgs<'readPdfAnnotationParseChunk'>) =>
            readPdfAnnotationParseChunk(...args),
        releasePdfAnnotationParse: (...args: TDocumentsServiceArgs<'releasePdfAnnotationParse'>) =>
            releasePdfAnnotationParse(...args),
        cancelPdfAnnotationParse: (...args: TDocumentsServiceArgs<'cancelPdfAnnotationParse'>) =>
            cancelPdfAnnotationParse(...args),
        beginPdfEmbeddedShapeIndex: (...args: TDocumentsServiceArgs<'beginPdfEmbeddedShapeIndex'>) =>
            beginPdfEmbeddedShapeIndex(...args),
        readPdfEmbeddedShapeIndexChunk: (...args: TDocumentsServiceArgs<'readPdfEmbeddedShapeIndexChunk'>) =>
            readPdfEmbeddedShapeIndexChunk(...args),
        releasePdfEmbeddedShapeIndex: (...args: TDocumentsServiceArgs<'releasePdfEmbeddedShapeIndex'>) =>
            releasePdfEmbeddedShapeIndex(...args),
        cancelPdfEmbeddedShapeIndex: (...args: TDocumentsServiceArgs<'cancelPdfEmbeddedShapeIndex'>) =>
            cancelPdfEmbeddedShapeIndex(...args),
        readTextFile: (...args: TDocumentsServiceArgs<'readTextFile'>) => handleFileReadText(...args),
        fileExists: (...args: TDocumentsServiceArgs<'fileExists'>) => handleFileExists(...args),
        getDocumentRevision: (...args: TDocumentsServiceArgs<'getDocumentRevision'>) => {
            const [
                context,
                filePath,
            ] = args;
            return getWorkingCopyRevision(filePath, context.senderId);
        },
        getWorkingCopyBackingStatus: (
            ...args: TDocumentsServiceArgs<'getWorkingCopyBackingStatus'>
        ) => {
            const [
                context,
                filePath,
            ] = args;
            const entry = getWorkingCopyBackingEntry(filePath, context.senderId);
            if (!entry) {
                return null;
            }
            const state = toRendererBackingState(entry.backingState);
            const key = normalizePathForLookup(filePath) || filePath;
            const latestStatus = latestBackingStatus.get(key);
            return {
                documentRef: filePath,
                failure: toBackingFailure(entry.sourceBackingErrorCode),
                progress: state === 'materialized'
                    ? 1
                    : latestStatus?.registrationId === entry.registrationId
                        ? latestStatus.status.progress
                        : 0,
                state,
            };
        },
        onWorkingCopyBackingStatusChanged: (listener) => {
            backingStatusListeners.add(listener);
            return () => {
                backingStatusListeners.delete(listener);
            };
        },
        analyzePdfConformance: (...args: TDocumentsServiceArgs<'analyzePdfConformance'>) =>
            handleAnalyzePdfConformance(...args),
        validatePdfData: (...args: TDocumentsServiceArgs<'validatePdfData'>) => handleValidatePdfData(...args),
        validatePdfPath: (...args: TDocumentsServiceArgs<'validatePdfPath'>) => handleValidatePdfPath(...args),
        openPdfInDefaultAppData: (...args: TDocumentsServiceArgs<'openPdfInDefaultAppData'>) =>
            handleOpenPdfInDefaultAppData(...args),
        openPdfInDefaultAppPath: (...args: TDocumentsServiceArgs<'openPdfInDefaultAppPath'>) =>
            handleOpenPdfInDefaultAppPath(...args),
        printPdfData: (...args: TDocumentsServiceArgs<'printPdfData'>) => handlePrintPdfData(...args),
        cancelPdfPrint: (...args: TDocumentsServiceArgs<'cancelPdfPrint'>) => handleCancelPdfPrint(...args),
        printPdfPath: (...args: TDocumentsServiceArgs<'printPdfPath'>) => handlePrintPdfPath(...args),
        writeFile: (...args: TDocumentsServiceArgs<'writeFile'>) => handleFileWrite(...args),
        replaceWorkingCopyFromPath: (...args: TDocumentsServiceArgs<'replaceWorkingCopyFromPath'>) =>
            handleReplaceWorkingCopyFromPath(...args),
        writeDocxFile: (...args: TDocumentsServiceArgs<'writeDocxFile'>) => handleFileWriteDocx(...args),
        saveFileStructured: (...args: TDocumentsServiceArgs<'saveFileStructured'>) =>
            handleFileSaveStructured(...args),
        resyncWorkingCopy: (...args: TDocumentsServiceArgs<'resyncWorkingCopy'>) =>
            handleResyncWorkingCopy(...args),
        repairPdf: (...args: TDocumentsServiceArgs<'repairPdf'>) => handleRepairPdfSave(...args),
        optimizePdfForInteraction: (...args: TDocumentsServiceArgs<'optimizePdfForInteraction'>) =>
            handleOptimizePdfForInteraction(...args),
        optimizePdfAsCopy: (...args: TDocumentsServiceArgs<'optimizePdfAsCopy'>) =>
            handleOptimizePdfAsCopy(...args),
        savePdfData: (...args: TDocumentsServiceArgs<'savePdfData'>) => handleSerializedPdfSave(...args),
        savePdfNoteTextUpdates: (...args: TDocumentsServiceArgs<'savePdfNoteTextUpdates'>) =>
            handleNativeNoteTextSave(...args),
        savePdfNoteChanges: (...args: TDocumentsServiceArgs<'savePdfNoteChanges'>) =>
            handleNativeNoteChangesSave(...args),
        savePdfNativeMutations: (...args: TDocumentsServiceArgs<'savePdfNativeMutations'>) =>
            handleNativePdfMutationsSave(...args),
        applyPdfNativeMutationsToWorkingCopy: (...args: TDocumentsServiceArgs<'applyPdfNativeMutationsToWorkingCopy'>) =>
            handleNativePdfMutationsApplyToWorkingCopy(...args),
        commitStagedPdfNativeMutations: (...args: TDocumentsServiceArgs<'commitStagedPdfNativeMutations'>) =>
            handleCommitStagedPdfNativeMutations(...args),
        cloneStagedPdfNativeMutationToWorkingCopy: (...args: TDocumentsServiceArgs<'cloneStagedPdfNativeMutationToWorkingCopy'>) =>
            handleCloneStagedPdfNativeMutationToWorkingCopy(...args),
        replaceWorkingCopyFromStagedPdfNativeMutation: (...args: TDocumentsServiceArgs<'replaceWorkingCopyFromStagedPdfNativeMutation'>) =>
            handleReplaceWorkingCopyFromStagedPdfNativeMutation(...args),
        beginSavePdfData: (...args: TDocumentsServiceArgs<'beginSavePdfData'>) =>
            beginSerializedPdfSaveToOriginal(...args),
        commitStagedSerializedPdf: (...args: TDocumentsServiceArgs<'commitStagedSerializedPdf'>) =>
            commitStagedSerializedPdf(...args),
        cancelStagedSerializedPdf: (...args: TDocumentsServiceArgs<'cancelStagedSerializedPdf'>) =>
            cancelStagedSerializedPdf(...args),
        cleanupFile: (...args: TDocumentsServiceArgs<'cleanupFile'>) => {
            const [
                context,
                workingPath,
            ] = args;
            return cleanupWorkingCopy(workingPath, context.senderId);
        },
        cleanupOcrTemp: (...args: TDocumentsServiceArgs<'cleanupOcrTemp'>) => handleCleanupOcrTemp(...args),
        setWindowTitle: (...args: TDocumentsServiceArgs<'setWindowTitle'>) => handleSetWindowTitle(...args),
        showItemInFolder: (...args: TDocumentsServiceArgs<'showItemInFolder'>) => handleShowItemInFolder(...args),
        setMenuDocumentState: (...args: TDocumentsServiceArgs<'setMenuDocumentState'>) => {
            const [
                context,
                state,
            ] = args;
            if (!context.window) {
                return;
            }

            setMenuDocumentState(context.window.id, state);
        },
        setMenuTabCount: (...args: TDocumentsServiceArgs<'setMenuTabCount'>) => {
            const [
                context,
                tabCount,
            ] = args;
            if (!context.window) {
                return;
            }

            setMenuTabCount(context.window.id, tabCount);
        },
        getRecentFiles: async (...args: TDocumentsServiceArgs<'getRecentFiles'>) => {
            const [context] = args;
            const startedAt = Date.now();
            const files = await getRecentFiles();
            allowRevealPaths(files.map(file => file.originalPath), context.sender);
            if (STARTUP_TRACE_ENABLED) {
                logger.info(`[startup] IPC recentFiles:get resolved (${files.length} file(s), +${Date.now() - startedAt}ms)`);
            }
            return files;
        },
        removeRecentFile: async (...args: TDocumentsServiceArgs<'removeRecentFile'>) => {
            const [originalPath] = args;
            await removeRecentFile(originalPath);
            removeAllowedOpenPath(originalPath);
            removeAllowedRevealPath(originalPath);
            updateRecentFilesMenu();
        },
        removeRecentFileIfMissing: async (...args: TDocumentsServiceArgs<'removeRecentFileIfMissing'>) => {
            const [originalPath] = args;
            const removed = await removeRecentFileIfMissing(originalPath);
            if (removed) {
                removeAllowedOpenPath(originalPath);
                removeAllowedRevealPath(originalPath);
                updateRecentFilesMenu();
            }
            return removed;
        },
        clearRecentFiles: async () => {
            const files = await getRecentFiles();
            await clearRecentFiles();
            files.forEach(file => {
                removeAllowedOpenPath(file.originalPath);
                removeAllowedRevealPath(file.originalPath);
            });
            updateRecentFilesMenu();
        },
    };

    return service;
}
