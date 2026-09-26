import type {
    IpcMainEvent,
    IpcMainInvokeEvent,
} from 'electron';
import { BrowserWindow } from 'electron';
import { access } from 'node:fs/promises';
import { withTimeout } from 'es-toolkit/promise';
import { isAbsolute } from 'path';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
} from '@contracts/docxExport';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';
import type {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
} from '@electron/features/documents/contract';
import {
    attachSerializedPdfPersistencePort,
    registerDocumentRevisionEventBridge,
    registerDocumentRevisionInvalidationEffects,
} from '@electron/features/documents/public';
import {
    appendOptionalDocumentArg,
    decodePdfRevisionOptions,
} from '@contracts/documentsPersistenceSchemas';
import type {
    IPdfSerializedSaveOptions, IWorkingCopyBackingStatus,  
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    decodeTypedStagedArtifact,
    type ITypedStagedArtifact,
} from '@contracts/stagedArtifacts';
import {
    requireSessionId,
    type TSessionId,
} from '@contracts/shared';
import {
    decodeBoundedArray,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
    decodeUint8ArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    beginDocxExportStream,
    cancelDocxExportStream,
    commitDocxExportStream,
    writeDocxExportStreamChunk,
} from '@electron/features/documents/main/docxExportStream';
import {
    allowOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { requireManagedWorkingCopyPath } from '@electron/file-access/workingCopyCreation';
import { createLogger } from '@electron/utils/createLogger';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { getErrorMessage } from '@electron/utils/error';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    revokeManagedTempFileHandlesForSender,
    createManagedTempFileHandle,
    releaseManagedTempFileHandle,
} from '@electron/features/documents/main/managedTempFileHandles';
import {
    cancelMainOperationsForOwner,
    type TMainOperationOwnerEndEvent,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER} from '@electron/features/documents/public/maxRendererFileOpenTokensPerSender';

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
    handleSaveDocxAs,
    handleSavePdfAs,
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
    handlePdfOpeningGeometry,
    handlePdfPageLabelRanges,
    handlePdfNativePageSizes,
} from '@electron/features/documents/main/nativePdfMetadata';
import {
    beginPdfEmbeddedShapeIndex,
    readPdfEmbeddedShapeIndexChunk,
    releasePdfEmbeddedShapeIndex,
} from '@electron/features/documents/main/pdfEmbeddedShapeIndex';
import {parsePdfAnnotations} from '@electron/features/documents/main/pdfAnnotationParse';
import {
    handleFileWrite,
    handleFileWriteDocx,
    handleReplaceWorkingCopyFromPath,
} from '@electron/features/documents/main/documentFileWriteHandlers';
import {
    handleAnalyzePdfConformance,
    handleValidatePdfPath,
} from '@electron/features/documents/main/documentPdfValidationHandlers';
import {
    handleCancelPdfPrint,
    handlePrintPdfData,
    handlePrintPdfPath,
} from '@electron/features/documents/main/print';
import { cleanupWorkingCopy } from '@electron/file-access/workingCopyCleanup';
import { discardOcrResultsForDocument } from '@electron/features/ocr/public/index';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import {
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
} from '@electron/recentFiles';
import {
    allowRevealPaths,
    removeAllowedOpenPath,
    removeAllowedRevealPath,
} from '@electron/file-access/openPathCapabilities';
import {
    setMenuDocumentState,
    setMenuTabCount,
    updateRecentFilesMenu,
} from '@electron/menu';
import {
    getWorkingCopyBackingStatus,
    onWorkingCopyBackingStatusChanged,
} from '@electron/features/documents/main/workingCopyBackingStatus';

import {
    handleFileSaveStructured,
    handleOptimizePdfForInteraction,
    handleRepairPdfSave,
} from '@electron/features/documents/main/workingCopySave';
import { handleOptimizePdfAsCopy } from '@electron/features/documents/main/handleOptimizePdfAsCopy';
import {
    handleNativePdfMutationsApplyToWorkingCopy,
    handleCommitStagedPdfNativeMutations,
    handleNativeNoteChangesSave,
    handleNativeNoteTextSave,
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

interface IRendererFileOpenToken {expiresAtMs: number;}
interface IRendererFileOpenRequest {
    filePath: string;
    token: string;
}

const RENDERER_FILE_OPEN_TOKEN_TTL_MS = 5 * 60 * 1000;
const RENDERER_FILE_OPEN_PATH_CHECK_TIMEOUT_MS = 5_000;
const RENDERER_FILE_OPEN_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const logger = createLogger('documents-ipc');
const rendererFileOpenTokens = new Map<number, Map<string, IRendererFileOpenToken>>();
const rendererFileOpenTokenCleanupSenders = new Set<number>();

function requireDocumentRef(value: unknown) {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

function senderContext(event: IpcMainInvokeEvent) {
    return {
        sender: event.sender,
        senderId: event.sender.id,
    };
}


function pruneRendererFileOpenTokens(senderId: number, now = Date.now()) {
    const tokens = rendererFileOpenTokens.get(senderId);
    if (!tokens) {
        return;
    }

    for (const [
        token,
        grant,
    ] of tokens.entries()) {
        if (grant.expiresAtMs <= now) {
            tokens.delete(token);
        }
    }

    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
}

function registerDocumentsSenderCleanup(event: Pick<IpcMainInvokeEvent, 'sender'>, senderId: number) {
    if (rendererFileOpenTokenCleanupSenders.has(senderId)) {
        return;
    }

    rendererFileOpenTokenCleanupSenders.add(senderId);
    const cleanup = (lifecycleEvent: TMainOperationOwnerEndEvent, reason: string) => {
        rendererFileOpenTokens.delete(senderId);
        cancelMainOperationsForOwner(senderId, reason, lifecycleEvent);
        revokeManagedTempFileHandlesForSender(senderId);
        rendererFileOpenTokenCleanupSenders.delete(senderId);
    };
    const stop = onSenderLifetimeEnd(event.sender, (end) => {
        stop();
        if (end === 'destroyed') cleanup('destroyed', 'Renderer destroyed');
        else if (end === 'render-process-gone') cleanup('renderProcessGone', 'Renderer process gone');
        else cleanup('mainFrameNavigation', 'Renderer main frame navigated');
    }, {navigation: true});
}

function consumeRendererFileOpenToken(senderId: number, token: string) {
    pruneRendererFileOpenTokens(senderId);
    const tokens = rendererFileOpenTokens.get(senderId);
    const grant = tokens?.get(token);
    if (!tokens || !grant || grant.expiresAtMs <= Date.now()) {
        tokens?.delete(token);
        return false;
    }

    tokens.delete(token);
    if (tokens.size === 0) {
        rendererFileOpenTokens.delete(senderId);
    }
    return true;
}

function hasRendererFileOpenToken(senderId: number, token: string) {
    pruneRendererFileOpenTokens(senderId);
    const tokens = rendererFileOpenTokens.get(senderId);
    const grant = tokens?.get(token);
    if (!tokens || !grant || grant.expiresAtMs <= Date.now()) {
        tokens?.delete(token);
        return false;
    }
    return true;
}

function registerRendererFileOpenTokens(
    event: IpcMainInvokeEvent,
    requestedTokens: string[],
) {
    const normalizedTokens = requestedTokens.map(token => token.trim());
    if (
        normalizedTokens.length === 0
        || normalizedTokens.length > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
        || normalizedTokens.some(token => !RENDERER_FILE_OPEN_TOKEN_PATTERN.test(token))
        || new Set(normalizedTokens).size !== normalizedTokens.length
    ) {
        return false;
    }

    const senderId = event.sender.id;
    const tokens = rendererFileOpenTokens.get(senderId) ?? new Map<string, IRendererFileOpenToken>();
    pruneRendererFileOpenTokens(senderId);
    const newTokenCount = normalizedTokens.filter(token => !tokens.has(token)).length;
    if (tokens.size + newTokenCount > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER) {
        return false;
    }

    const expiresAtMs = Date.now() + RENDERER_FILE_OPEN_TOKEN_TTL_MS;
    for (const token of normalizedTokens) {
        tokens.delete(token);
        tokens.set(token, {expiresAtMs});
    }
    rendererFileOpenTokens.set(senderId, tokens);
    registerDocumentsSenderCleanup(event, senderId);
    return true;
}

function isValidRendererFileOpenBatch(requests: IRendererFileOpenRequest[]) {
    return requests.length > 0
        && requests.length <= MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
        && requests.every(request =>
            isAbsolute(request.filePath)
            && RENDERER_FILE_OPEN_TOKEN_PATTERN.test(request.token))
        && new Set(requests.map(request => request.token)).size === requests.length;
}

function decodeRendererFileOpenRequest(value: unknown): IRendererFileOpenRequest {
    if (!isRecord(value) || typeof value.filePath !== 'string' || typeof value.token !== 'string') {
        throw new Error('request must carry string filePath and token');
    }
    return {
        filePath: value.filePath,
        token: value.token.trim(),
    };
}

function decodeStagedSerializedPdfArgs(args: readonly unknown[]) {
    const stagedOutput = decodeTypedStagedArtifact(args[1]);
    if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
    return [
        requireSessionId(decodeStringArg(args, 0, 'sessionId')),
        stagedOutput,
    ];
}

function decodeSessionIdArgs(args: readonly unknown[]) {
    return [requireSessionId(decodeStringArg(args, 0, 'sessionId'))];
}

/** Argument decoders for the channels outside the platform-feature specs. */
export const DOCUMENTS_DIRECT_ARG_DECODERS: Record<string, {decodeArgs: (args: readonly unknown[]) => unknown[]}> = {
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {decodeArgs: args => [decodeStringArg(args, 0, 'token')]},
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {decodeArgs: args => [decodeStringArrayArg(args, 0, 'tokens')]},
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {decodeArgs: args => [decodeRendererFileOpenRequest(args[0])]},
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {decodeArgs: args => [decodeBoundedArray(args[0], 'requests', {
        allowEmpty: true,
        maxItems: 4_096,
    }).map(decodeRendererFileOpenRequest)]},
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {decodeArgs: args => appendOptionalDocumentArg([
        requireDocumentRef(decodeStringArg(args, 0, 'path')),
        decodeSafeIntegerArg(args, 1, 'totalBytes'),
    ], decodePdfRevisionOptions(args[2]))},
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: {decodeArgs: decodeStagedSerializedPdfArgs},
    [DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf]: {decodeArgs: decodeStagedSerializedPdfArgs},
    [DOCX_EXPORT_STREAM_CHANNELS.begin]: {decodeArgs: args => [decodeStringArg(args, 0, 'filePath')]},
    [DOCX_EXPORT_STREAM_CHANNELS.writeChunk]: {decodeArgs: (args) => {
        const chunk = decodeUint8ArrayArg(args, 1, 'chunk', DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES);
        if (chunk.byteLength === 0) {
            throw new Error('chunk must not be empty');
        }
        return [
            requireSessionId(decodeStringArg(args, 0, 'sessionId')),
            chunk,
        ];
    }},
    [DOCX_EXPORT_STREAM_CHANNELS.commit]: {decodeArgs: decodeSessionIdArgs},
    [DOCX_EXPORT_STREAM_CHANNELS.cancel]: {decodeArgs: decodeSessionIdArgs},
};

async function isValidRendererFileOpenPath(filePath: string) {
    if (!isSupportedOpenPath(filePath)) {
        return false;
    }
    try {
        await withTimeout(() => access(filePath), RENDERER_FILE_OPEN_PATH_CHECK_TIMEOUT_MS);
        return true;
    } catch {
        return false;
    }
}

async function requireWorkingCopySourcePath(
    context: {
        sender: IpcMainInvokeEvent['sender'];
        senderId: number;
    },
    sourcePath: string,
): Promise<TOpenPath> {
    try {
        return requireOpenPath(sourcePath, context.sender);
    } catch {
        return requireManagedWorkingCopyPath(sourcePath, context.senderId);
    }
}

export const documentsMainBindings = {
    openDocumentDialog: context => handleOpenPdfDialog({
        ...context,
        parentWindow: BrowserWindow.fromWebContents(context.sender),
    }),
    openCombineDialog: context => handleOpenCombineDialog({
        ...context,
        parentWindow: BrowserWindow.fromWebContents(context.sender),
    }),
    openFolderDialog: context => handleOpenFolderDialog({
        ...context,
        parentWindow: BrowserWindow.fromWebContents(context.sender),
    }),
    openImageDialog: context => handleOpenImageDialog({
        ...context,
        parentWindow: BrowserWindow.fromWebContents(context.sender),
    }),
    openDocumentDirect: (context, filePath, password) => password === undefined
        ? handleOpenPdfDirect(context, filePath)
        : handleOpenPdfDirect(context, filePath, password),
    openDocumentDirectBatch: (context, filePaths, requestId, batchOptions) =>
        handleOpenPdfDirectBatch(context, filePaths, requestId, batchOptions),
    cancelOpenDocumentDirectBatch: (context, requestId) =>
        handleCancelOpenDocumentDirectBatch(context, requestId),
    createWorkingCopyFromData: (context, fileName, data, originalPath, password) =>
        handleCreateWorkingCopyFromData(context, fileName, data, originalPath, password)
            .then(result => requireDocumentRef(result)),
    createWorkingCopyFromPath: async (context, sourcePath, originalPath, password) => {
        const trustedSourcePath = await requireWorkingCopySourcePath(context, sourcePath);
        return handleCreateWorkingCopyFromPath(context, trustedSourcePath, originalPath, password)
            .then(result => requireDocumentRef(result));
    },
    parsePdfAnnotations: (context, filePath, options) =>
        parsePdfAnnotations(context, filePath, options),
    cleanupFile: async (context, workingPath) => {
        if (await cleanupWorkingCopy(workingPath, context.senderId)) {
            await discardOcrResultsForDocument(requireDocumentRef(workingPath));
        }
    },
    readFile: (context, filePath) =>
        handleFileRead(context, filePath),
    readPdfPageLabelRanges: (context, filePath) =>
        handlePdfPageLabelRanges(context, filePath),
    statFile: (context, filePath) =>
        handleFileStat(context, filePath),
    readFileRange: (context, filePath, offset, length) =>
        handleFileReadRange(context, filePath, offset, length),
    createManagedTempFileHandle: (context, filePath) =>
        createManagedTempFileHandle(context, filePath),
    releaseManagedTempFileHandle: (context, leaseId) =>
        releaseManagedTempFileHandle(context, leaseId),
    getPdfOpeningGeometry: (context, filePath) =>
        handlePdfOpeningGeometry(context, filePath),
    getPdfNativePageSizes: (context, filePath, options) =>
        handlePdfNativePageSizes(context, filePath, options),
    beginPdfEmbeddedShapeIndex: (context, filePath, options) =>
        beginPdfEmbeddedShapeIndex(context, filePath, options),
    readPdfEmbeddedShapeIndexChunk: (context, sessionId, offset, options) =>
        readPdfEmbeddedShapeIndexChunk(context, sessionId, offset, options),
    releasePdfEmbeddedShapeIndex: (context, sessionId) =>
        releasePdfEmbeddedShapeIndex(context, sessionId),
    readTextFile: (context, filePath) =>
        handleFileReadText(context, filePath),
    fileExists: (context, filePath) =>
        handleFileExists(context, filePath),
    getDocumentRevision: (context, filePath) =>
        getWorkingCopyRevision(filePath, context.senderId),
    getWorkingCopyBackingStatus: (context, filePath) =>
        getWorkingCopyBackingStatus(context.senderId, filePath),
    savePdfAs: (context, workingPath, saveOptions, revisionOptions) =>
        handleSavePdfAs({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }, workingPath, saveOptions, revisionOptions),
    savePdfDialog: (context, suggestedName) =>
        handleSavePdfDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }, suggestedName),
    saveDocxAs: (context, workingPath) =>
        handleSaveDocxAs({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }, workingPath),
    writeFile: (context, filePath, data, revisionOptions) =>
        handleFileWrite(context, filePath, data, revisionOptions),
    replaceWorkingCopyFromPath: (context, workingPath, sourcePath, revisionOptions) =>
        handleReplaceWorkingCopyFromPath(context, workingPath, sourcePath, revisionOptions),
    writeDocxFile: (context, filePath, data) =>
        handleFileWriteDocx(context, filePath, data),
    saveFileStructured: (context, workingPath, revisionOptions) =>
        handleFileSaveStructured(context, workingPath, revisionOptions),
    repairPdf: (context, workingPath, revisionOptions) =>
        handleRepairPdfSave(context, workingPath, revisionOptions),
    optimizePdfForInteraction: (context, workingPath, revisionOptions) =>
        handleOptimizePdfForInteraction(context, workingPath, revisionOptions),
    optimizePdfAsCopy: (context, workingPath, optimizeOptions, requestId, revisionOptions) =>
        handleOptimizePdfAsCopy({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }, workingPath, optimizeOptions, requestId, revisionOptions),
    savePdfNoteTextUpdates: (context, workingPath, updates, modifiedAt, revisionOptions) =>
        handleNativeNoteTextSave(context, workingPath, updates, modifiedAt, revisionOptions),
    savePdfNoteChanges: (context, workingPath, changes, modifiedAt, revisionOptions) =>
        handleNativeNoteChangesSave(context, workingPath, changes, modifiedAt, revisionOptions),
    applyPdfNativeMutationsToWorkingCopy: (
        context,
        workingPath,
        mutations,
        modifiedAt,
        revisionOptions,
    ) => handleNativePdfMutationsApplyToWorkingCopy(
        context,
        workingPath,
        mutations,
        modifiedAt,
        revisionOptions,
    ),
    commitStagedPdfNativeMutations: (context, workingPath, stagedOutput, revisionOptions) =>
        handleCommitStagedPdfNativeMutations(context, workingPath, stagedOutput, revisionOptions),
    cloneStagedPdfNativeMutationToWorkingCopy: (context, stagedOutput, originalPath) =>
        handleCloneStagedPdfNativeMutationToWorkingCopy(context, stagedOutput, originalPath)
            .then(result => requireDocumentRef(result)),
    replaceWorkingCopyFromStagedPdfNativeMutation: (context, workingPath, stagedOutput, revisionOptions) =>
        handleReplaceWorkingCopyFromStagedPdfNativeMutation(
            context,
            workingPath,
            stagedOutput,
            revisionOptions,
        ),
    analyzePdfConformance: (context, filePath, options) =>
        handleAnalyzePdfConformance(context, filePath, options),
    validatePdfPath: (context, filePath, options) =>
        handleValidatePdfPath(context, filePath, options),
    printPdfData: (context, data, fileName, options) => {
        registerDocumentsSenderCleanup({sender: context.sender}, context.senderId);
        return handlePrintPdfData({
            onNativePrintDialogOpened: requestId => context.sender.send(
                DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened,
                {requestId},
            ),
            senderId: context.senderId,
            window: BrowserWindow.fromWebContents(context.sender),
        }, data, fileName, options);
    },
    cancelPdfPrint: (context, requestId) =>
        handleCancelPdfPrint(context, requestId),
    printPdfPath: (context, filePath, fileName, options) => {
        registerDocumentsSenderCleanup({sender: context.sender}, context.senderId);
        return handlePrintPdfPath({
            onNativePrintDialogOpened: requestId => context.sender.send(
                DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened,
                {requestId},
            ),
            senderId: context.senderId,
            window: BrowserWindow.fromWebContents(context.sender),
        }, filePath, fileName, options);
    },
    getRecentFiles: async (context) => {
        const files = await getRecentFiles();
        allowRevealPaths(files.map(file => file.originalPath), context.sender);
        return files;
    },
    removeRecentFile: async (originalPath) => {
        await removeRecentFile(originalPath);
        removeAllowedOpenPath(originalPath);
        removeAllowedRevealPath(originalPath);
        updateRecentFilesMenu();
    },
    clearRecentFiles: async () => {
        const files = await getRecentFiles();
        await clearRecentFiles();
        for (const file of files) {
            removeAllowedOpenPath(file.originalPath);
            removeAllowedRevealPath(file.originalPath);
        }
        updateRecentFilesMenu();
    },
    setWindowTitle: (context, title) => {
        handleSetWindowTitle({
            senderId: context.senderId,
            window: BrowserWindow.fromWebContents(context.sender),
        }, title);
        return undefined;
    },
    showItemInFolder: (context, filePath) =>
        handleShowItemInFolder({owner: context.sender}, filePath),
    setMenuDocumentState: (context, state) => {
        const window = BrowserWindow.fromWebContents(context.sender);
        if (window) setMenuDocumentState(window.id, state);
    },
    setMenuTabCount: (context, tabCount) => {
        const window = BrowserWindow.fromWebContents(context.sender);
        if (window) setMenuTabCount(window.id, tabCount);
    },
} satisfies
    TFeatureMainBindings<typeof DOCUMENT_PICKER_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_OPEN_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_WORKING_COPY_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_FILES_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_PDF_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE, IpcMainInvokeEvent>
    & TFeatureMainBindings<typeof DOCUMENT_MENU_PLATFORM_FEATURE, IpcMainInvokeEvent>;

/**
 * Registers what the platform-feature specs do not describe: renderer
 * file-open grants, the streamed PDF and DOCX saves, and main-originated
 * document events.
 */
export function registerDocumentsDirectIpc(
    registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent>,
    eventRegistrar: {on: (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => void},
) {
    const backingStatusPump = createIpcProgressPump<IWorkingCopyBackingStatus>({
        channel: DOCUMENTS_EVENT_CHANNELS.workingCopyBackingStatusChanged,
        getTarget: () => null,
        getKey: status => status.documentRef,
        isTerminal: status => status.state !== 'materializing',
        intervalMs: 250,
        onError: error => {
            logger.debug(`Failed to send working-copy backing status: ${getErrorMessage(error)}`);
        },
    });
    onWorkingCopyBackingStatusChanged((statusEvent) => {
        const windows = BrowserWindow.getAllWindows().filter(window => (
            statusEvent.ownerWebContentsId === undefined
            || window.webContents.id === statusEvent.ownerWebContentsId
        ));
        backingStatusPump.enqueue(statusEvent.status, {
            isDestroyed: () => windows.every(window => window.webContents.isDestroyed()),
            send: (channel, status) => {
                for (const window of windows) {
                    if (!window.webContents.isDestroyed()) {
                        window.webContents.send(channel, status);
                    }
                }
            },
        });
    });
    registerDocumentRevisionEventBridge();
    registerDocumentRevisionInvalidationEffects();

    registrar.handle(DOCX_EXPORT_STREAM_CHANNELS.begin, (event, filePath: string) =>
        beginDocxExportStream(senderContext(event), filePath));
    registrar.handle(DOCX_EXPORT_STREAM_CHANNELS.writeChunk, (event, sessionId: TSessionId, chunk: Uint8Array) =>
        writeDocxExportStreamChunk(senderContext(event), sessionId, chunk));
    registrar.handle(DOCX_EXPORT_STREAM_CHANNELS.commit, (event, sessionId: TSessionId) =>
        commitDocxExportStream(senderContext(event), sessionId));
    registrar.handle(DOCX_EXPORT_STREAM_CHANNELS.cancel, (event, sessionId: TSessionId) =>
        cancelDocxExportStream(senderContext(event), sessionId));
    registrar.handle(DOCUMENTS_CHANNELS.fileSavePdfDataBegin, (
        event,
        workingPath: TDocumentRef,
        totalBytes: number,
        options?: IPdfSerializedSaveOptions,
    ) => beginSerializedPdfSaveToOriginal(senderContext(event), workingPath, totalBytes, options));
    registrar.handle(DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf, (
        event,
        sessionId: TSessionId,
        stagedOutput: ITypedStagedArtifact,
    ) => commitStagedSerializedPdf(senderContext(event), sessionId, stagedOutput));
    registrar.handle(DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf, (
        event,
        sessionId: TSessionId,
        stagedOutput: ITypedStagedArtifact,
    ) => cancelStagedSerializedPdf(senderContext(event), sessionId, stagedOutput));
    registrar.handle(DOCUMENTS_CHANNELS.registerRendererFileOpenToken, (event, token: string) =>
        registerRendererFileOpenTokens(event, [token]));
    registrar.handle(DOCUMENTS_CHANNELS.registerRendererFileOpenTokens, registerRendererFileOpenTokens);
    registrar.handle(DOCUMENTS_CHANNELS.allowRendererFileOpen, async (event, request: IRendererFileOpenRequest) => {
        if (!consumeRendererFileOpenToken(event.sender.id, request.token)) {
            return false;
        }
        if (!request.filePath.trim() || !isAbsolute(request.filePath) || !await isValidRendererFileOpenPath(request.filePath)) {
            return false;
        }
        return allowOpenPath(request.filePath, event.sender) !== null;
    });
    registrar.handle(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch, async (event, requests: IRendererFileOpenRequest[]) => {
        const senderId = event.sender.id;
        if (!isValidRendererFileOpenBatch(requests) || requests.some(request => !hasRendererFileOpenToken(senderId, request.token))) {
            return false;
        }
        const validPaths = await Promise.all(requests.map(request => isValidRendererFileOpenPath(request.filePath)));
        if (validPaths.some(isValid => !isValid)) {
            return false;
        }

        for (const request of requests) {
            consumeRendererFileOpenToken(senderId, request.token);
        }
        return requests.every(request => allowOpenPath(request.filePath, event.sender) !== null);
    });
    eventRegistrar.on(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event: IpcMainEvent, sessionId: unknown) => {
        try {
            void attachSerializedPdfPersistencePort(event, sessionId);
        } catch (error) {
            logger.warn(`[ipc] rejected ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`);
        }
    });
}
