import type {
    IpcMainEvent,
    IpcMainInvokeEvent,
} from 'electron';
import { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type {
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from '@contracts/ipcMain';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PLATFORM_FEATURES,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    DOCUMENTS_EVENT_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createDocumentsService} from '@electron/features/documents/createDocumentsService';
import type {
    IDocumentsDialogContext,
    IDocumentsSenderIdContext,
    IDocumentsService,
    IDocumentsWebContentsContext,
} from '@electron/features/documents/documentsService';
import { attachSerializedPdfPersistencePort } from '@electron/features/documents/public';
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
import { getErrorMessage } from '@electron/utils/error';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';
import type { IWorkingCopyBackingStatus } from '@contracts/electronApiDocuments';
import {revokeManagedTempFileHandlesForSender} from '@electron/features/documents/main/managedTempFileHandles';
import {cancelMainOperationsForOwner} from '@electron/operation-lifecycle/mainOperationLifecycle';

interface IRendererFileOpenToken {expiresAtMs: number;}
interface IDocumentsIpcEventRegistrar {on: (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => void;}
interface IRegisterDocumentsIpcAdapterOptions {eventRegistrar?: IDocumentsIpcEventRegistrar;}
type TDocumentsIpcRegistrar = IIpcMainRegistrar<IDocumentsInvokeMap, IpcMainInvokeEvent>;
type TDocumentsIpcChannel = Extract<keyof IDocumentsInvokeMap, string>;
type TDocumentsIpcArgs<TChannel extends TDocumentsIpcChannel> = IDocumentsInvokeMap[TChannel]['args'];

const RENDERER_FILE_OPEN_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER = 128;
const RENDERER_FILE_OPEN_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const logger = createLogger('documents-ipc-adapter');
const rendererFileOpenTokens = new Map<number, Map<string, IRendererFileOpenToken>>();
const rendererFileOpenTokenCleanupSenders = new Set<number>();

function getDistinctDocumentsChannelValues() {
    return [...new Set<string>([
        ...Object.values(DOCUMENTS_CHANNELS),
        ...DOCUMENT_PLATFORM_FEATURES.flatMap(feature =>
            [...feature.invokeChannelSet]),
    ])];
}

export function assertDocumentsIpcSingleRegistrationInvariant(registrations: readonly string[]) {
    const expectedChannels = getDistinctDocumentsChannelValues();
    const expectedChannelSet = new Set(expectedChannels);
    const registrationCounts = new Map<string, number>();
    for (const channel of registrations) {
        registrationCounts.set(channel, (registrationCounts.get(channel) ?? 0) + 1);
    }

    const unexpectedChannels = [...registrationCounts.keys()].filter(channel => !expectedChannelSet.has(channel));
    if (unexpectedChannels.length > 0) {
        throw new Error(`Unexpected documents IPC channel registration: ${unexpectedChannels.join(', ')}`);
    }

    const duplicateChannels = [...registrationCounts.entries()]
        .filter(([
            ,
            count,
        ]) => count > 1)
        .map(([channel]) => channel);
    if (duplicateChannels.length > 0) {
        throw new Error(`Duplicate documents IPC channel registration: ${duplicateChannels.join(', ')}`);
    }

    const missingChannels = expectedChannels.filter(channel => !registrationCounts.has(channel));
    if (missingChannels.length > 0) {
        throw new Error(`Missing documents IPC channel registration: ${missingChannels.join(', ')}`);
    }
}

function getSenderId(event: IpcMainInvokeEvent) {
    return event.sender.id;
}

function createWebContentsContext(event: IpcMainInvokeEvent): IDocumentsWebContentsContext {
    return {
        sender: event.sender,
        senderId: getSenderId(event),
    };
}

function createSenderIdContext(event: IpcMainInvokeEvent): IDocumentsSenderIdContext {
    return {
        sender: event.sender,
        senderId: getSenderId(event),
    };
}

function createDialogContext(event: IpcMainInvokeEvent): IDocumentsDialogContext {
    return {
        ...createWebContentsContext(event),
        parentWindow: BrowserWindow.fromWebContents(event.sender),
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
    const cleanup = () => {
        event.sender.removeListener('destroyed', cleanup);
        event.sender.removeListener('render-process-gone', cleanup);
        event.sender.removeListener('did-start-navigation', handleNavigation);
        rendererFileOpenTokens.delete(senderId);
        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');
        revokeManagedTempFileHandlesForSender(senderId);
        rendererFileOpenTokenCleanupSenders.delete(senderId);
    };
    const handleNavigation = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup();
        }
    };
    event.sender.once('destroyed', cleanup);
    event.sender.once('render-process-gone', cleanup);
    event.sender.on('did-start-navigation', handleNavigation);
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
    tokensPayload: unknown,
) {
    const normalizedTokens = Array.isArray(tokensPayload)
        ? tokensPayload.map((token: unknown) => typeof token === 'string' ? token.trim() : '')
        : [];
    if (
        normalizedTokens.length === 0
        || normalizedTokens.length > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
        || normalizedTokens.some(token => !RENDERER_FILE_OPEN_TOKEN_PATTERN.test(token))
        || new Set(normalizedTokens).size !== normalizedTokens.length
    ) {
        return false;
    }

    const senderId = getSenderId(event);
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

function parseRendererFileOpenBatchRequests(requestsPayload: unknown) {
    if (
        !Array.isArray(requestsPayload)
        || requestsPayload.length === 0
        || requestsPayload.length > MAX_RENDERER_FILE_OPEN_TOKENS_PER_SENDER
    ) {
        return null;
    }

    const requests = requestsPayload.map((request: unknown) => {
        const filePath = isRecord(request) ? request.filePath : '';
        const token = isRecord(request) ? request.token : '';
        return {
            filePath: typeof filePath === 'string' ? filePath.trim() : '',
            token: typeof token === 'string' ? token.trim() : '',
        };
    });
    if (
        requests.some(request =>
            !request.filePath
            || !isAbsolute(request.filePath)
            || !RENDERER_FILE_OPEN_TOKEN_PATTERN.test(request.token))
        || new Set(requests.map(request => request.token)).size !== requests.length
    ) {
        return null;
    }
    return requests;
}

function isValidRendererFileOpenPath(filePath: string) {
    return existsSync(filePath) && isSupportedOpenPath(filePath);
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

export function registerDocumentsIpcAdapter(
    registrar: TDocumentsIpcRegistrar,
    service: IDocumentsService = createDocumentsService(),
    options: IRegisterDocumentsIpcAdapterOptions = {},
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
    service.onWorkingCopyBackingStatusChanged?.((statusEvent) => {
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
    const registeredChannels: string[] = [];
    const register = <TChannel extends TDocumentsIpcChannel>(
        channel: TChannel,
        handler: TIpcMainInvokeHandler<
            IDocumentsInvokeMap[TChannel]['args'],
            IDocumentsInvokeMap[TChannel]['result'],
            IpcMainInvokeEvent
        >,
    ) => {
        registeredChannels.push(channel);
        registrar.handle(channel, handler);
    };
    const registerRawEvent = (
        channel: typeof DOCUMENTS_CHANNELS.fileSavePdfDataPort,
        handler: (event: IpcMainEvent, ...args: unknown[]) => void,
    ) => {
        if (!options.eventRegistrar) {
            throw new Error(`Documents IPC event registrar is required for ${channel}`);
        }
        registeredChannels.push(channel);
        options.eventRegistrar.on(channel, handler);
    };

    const featureRegistrar = {handle: (channel: string, handler: TIpcMainInvokeHandler<
        unknown[],
        unknown,
        IpcMainInvokeEvent
    >) => {
        registeredChannels.push(channel);
        registrar.handle(channel as never, handler as never);
    }};
    const featureBindings = {
        openDocumentDialog: context => service.openDocumentDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openCombineDialog: context => service.openCombineDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openFolderDialog: context => service.openFolderDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openImageDialog: context => service.openImageDialog({
            ...context,
            parentWindow: BrowserWindow.fromWebContents(context.sender),
        }),
        openDocumentDirect: (context, filePath, password) => password === undefined
            ? service.openDocumentDirect(context, filePath)
            : service.openDocumentDirect(context, filePath, password),
        openDocumentDirectBatch: (context, filePaths, requestId, batchOptions) =>
            service.openDocumentDirectBatch(context, filePaths, requestId, batchOptions),
        cancelOpenDocumentDirectBatch: (context, requestId) =>
            service.cancelOpenDocumentDirectBatch(context, requestId),
        createWorkingCopyFromData: (context, fileName, data, originalPath, password) =>
            service.createWorkingCopyFromData(context, fileName, data, originalPath, password),
        createWorkingCopyFromPath: async (context, sourcePath, originalPath, password) => {
            const trustedSourcePath = await requireWorkingCopySourcePath(context, sourcePath);
            return service.createWorkingCopyFromPath(context, trustedSourcePath, originalPath, password);
        },
        parsePdfAnnotations: (context, filePath, options) =>
            service.parsePdfAnnotations(context, filePath, options),
        cleanupFile: (context, workingPath) =>
            service.cleanupFile(context, workingPath).then(() => undefined),
        cleanupOcrTemp: (context, filePath) =>
            service.cleanupOcrTemp(context, filePath).then(() => undefined),
        readFile: (context, filePath) =>
            service.readFile(context, filePath),
        statFile: (context, filePath) =>
            service.statFile(context, filePath),
        readFileRange: (context, filePath, offset, length) =>
            service.readFileRange(context, filePath, offset, length),
        createManagedTempFileHandle: (context, filePath) =>
            service.createManagedTempFileHandle(context, filePath),
        releaseManagedTempFileHandle: (context, leaseId) =>
            service.releaseManagedTempFileHandle(context, leaseId),
        getPdfOpeningGeometry: (context, filePath) =>
            service.getPdfOpeningGeometry(context, filePath),
        getPdfNativePageSizes: (context, filePath) =>
            service.getPdfNativePageSizes(context, filePath),
        cancelPdfNativePagePreview: (context, requestId) =>
            service.cancelPdfNativePagePreview(context, requestId),
        renderPdfNativePagePreview: (context, filePath, pageNumber, previewOptions) =>
            service.renderPdfNativePagePreview(context, filePath, pageNumber, previewOptions),
        beginPdfAnnotationIndex: (context, filePath, options) =>
            service.beginPdfAnnotationIndex(context, filePath, options),
        readPdfAnnotationIndexChunk: (context, sessionId, offset, options) =>
            service.readPdfAnnotationIndexChunk(context, sessionId, offset, options),
        releasePdfAnnotationIndex: (context, sessionId) =>
            service.releasePdfAnnotationIndex(context, sessionId),
        cancelPdfAnnotationIndex: (context, sessionId) =>
            service.cancelPdfAnnotationIndex(context, sessionId),
        beginPdfAnnotationParse: (context, filePath, options) =>
            service.beginPdfAnnotationParse(context, filePath, options),
        readPdfAnnotationParseChunk: (context, sessionId, offset, options) =>
            service.readPdfAnnotationParseChunk(context, sessionId, offset, options),
        releasePdfAnnotationParse: (context, sessionId) =>
            service.releasePdfAnnotationParse(context, sessionId),
        cancelPdfAnnotationParse: (context, sessionId) =>
            service.cancelPdfAnnotationParse(context, sessionId),
        beginPdfEmbeddedShapeIndex: (context, filePath, options) =>
            service.beginPdfEmbeddedShapeIndex(context, filePath, options),
        readPdfEmbeddedShapeIndexChunk: (context, sessionId, offset, options) =>
            service.readPdfEmbeddedShapeIndexChunk(context, sessionId, offset, options),
        releasePdfEmbeddedShapeIndex: (context, sessionId) =>
            service.releasePdfEmbeddedShapeIndex(context, sessionId),
        cancelPdfEmbeddedShapeIndex: (context, sessionId) =>
            service.cancelPdfEmbeddedShapeIndex(context, sessionId),
        readTextFile: (context, filePath) =>
            service.readTextFile(context, filePath),
        fileExists: (context, filePath) =>
            service.fileExists(context, filePath),
        getDocumentRevision: (context, filePath) =>
            service.getDocumentRevision(context, filePath),
        getWorkingCopyBackingStatus: (context, filePath) =>
            service.getWorkingCopyBackingStatus(context, filePath),
        savePdfAs: (context, workingPath, saveOptions, revisionOptions) =>
            service.savePdfAs({
                ...context,
                parentWindow: BrowserWindow.fromWebContents(context.sender),
            }, workingPath, saveOptions, revisionOptions),
        savePdfDialog: (context, suggestedName) =>
            service.savePdfDialog({
                ...context,
                parentWindow: BrowserWindow.fromWebContents(context.sender),
            }, suggestedName),
        saveDocxAs: (context, workingPath) =>
            service.saveDocxAs({
                ...context,
                parentWindow: BrowserWindow.fromWebContents(context.sender),
            }, workingPath),
        writeFile: (context, filePath, data, revisionOptions) =>
            service.writeFile(context, filePath, data, revisionOptions),
        replaceWorkingCopyFromPath: (context, workingPath, sourcePath, revisionOptions) =>
            service.replaceWorkingCopyFromPath(context, workingPath, sourcePath, revisionOptions),
        writeDocxFile: (context, filePath, data) =>
            service.writeDocxFile(context, filePath, data),
        saveFileStructured: (context, workingPath, revisionOptions) =>
            service.saveFileStructured(context, workingPath, revisionOptions),
        resyncWorkingCopy: (context, workingPath) =>
            service.resyncWorkingCopy(context, workingPath),
        repairPdf: (context, workingPath, revisionOptions) =>
            service.repairPdf(context, workingPath, revisionOptions),
        optimizePdfForInteraction: (context, workingPath, revisionOptions) =>
            service.optimizePdfForInteraction(context, workingPath, revisionOptions),
        optimizePdfAsCopy: (context, workingPath, optimizeOptions, requestId, revisionOptions) =>
            service.optimizePdfAsCopy({
                ...context,
                parentWindow: BrowserWindow.fromWebContents(context.sender),
            }, workingPath, optimizeOptions, requestId, revisionOptions),
        savePdfNoteTextUpdates: (context, workingPath, updates, modifiedAt, revisionOptions) =>
            service.savePdfNoteTextUpdates(context, workingPath, updates, modifiedAt, revisionOptions),
        savePdfNoteChanges: (context, workingPath, changes, modifiedAt, revisionOptions) =>
            service.savePdfNoteChanges(context, workingPath, changes, modifiedAt, revisionOptions),
        savePdfNativeMutations: (context, workingPath, mutations, modifiedAt, revisionOptions) =>
            service.savePdfNativeMutations(context, workingPath, mutations, modifiedAt, revisionOptions),
        applyPdfNativeMutationsToWorkingCopy: (
            context,
            workingPath,
            mutations,
            modifiedAt,
            revisionOptions,
        ) => service.applyPdfNativeMutationsToWorkingCopy(
            context,
            workingPath,
            mutations,
            modifiedAt,
            revisionOptions,
        ),
        commitStagedPdfNativeMutations: (context, workingPath, stagedOutput, revisionOptions) =>
            service.commitStagedPdfNativeMutations(context, workingPath, stagedOutput, revisionOptions),
        cloneStagedPdfNativeMutationToWorkingCopy: (context, stagedOutput, originalPath) =>
            service.cloneStagedPdfNativeMutationToWorkingCopy(context, stagedOutput, originalPath),
        replaceWorkingCopyFromStagedPdfNativeMutation: (context, workingPath, stagedOutput, revisionOptions) =>
            service.replaceWorkingCopyFromStagedPdfNativeMutation(
                context,
                workingPath,
                stagedOutput,
                revisionOptions,
            ),
        analyzePdfConformance: (context, filePath, options) =>
            service.analyzePdfConformance(context, filePath, options),
        validatePdfData: (data, fileName) =>
            service.validatePdfData(data, fileName),
        validatePdfPath: (context, filePath, options) =>
            service.validatePdfPath(context, filePath, options),
        openPdfInDefaultAppData: (data, fileName) =>
            service.openPdfInDefaultAppData(data, fileName),
        openPdfInDefaultAppPath: (context, filePath, fileName) =>
            service.openPdfInDefaultAppPath(context, filePath, fileName),
        printPdfData: (context, data, fileName, options) => {
            registerDocumentsSenderCleanup({sender: context.sender}, context.senderId);
            return service.printPdfData({
                onNativePrintDialogOpened: requestId => context.sender.send(
                    DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened,
                    {requestId},
                ),
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, data, fileName, options);
        },
        cancelPdfPrint: (context, requestId) =>
            service.cancelPdfPrint(context, requestId),
        printPdfPath: (context, filePath, fileName, options) => {
            registerDocumentsSenderCleanup({sender: context.sender}, context.senderId);
            return service.printPdfPath({
                onNativePrintDialogOpened: requestId => context.sender.send(
                    DOCUMENTS_EVENT_CHANNELS.nativePrintDialogOpened,
                    {requestId},
                ),
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, filePath, fileName, options);
        },
        getRecentFiles: context => service.getRecentFiles(context),
        removeRecentFile: async (originalPath) => {
            await service.removeRecentFile(originalPath);
            return undefined;
        },
        removeRecentFileIfMissing: originalPath =>
            service.removeRecentFileIfMissing(originalPath),
        clearRecentFiles: async () => {
            await service.clearRecentFiles();
            return undefined;
        },
        setWindowTitle: (context, title) => {
            service.setWindowTitle({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, title);
            return undefined;
        },
        showItemInFolder: (context, filePath) =>
            service.showItemInFolder({owner: context.sender}, filePath),
        setMenuDocumentState: (context, state) => {
            service.setMenuDocumentState({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, state);
            return undefined;
        },
        setMenuTabCount: (context, tabCount) => {
            service.setMenuTabCount({
                senderId: context.senderId,
                window: BrowserWindow.fromWebContents(context.sender),
            }, tabCount);
            return undefined;
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
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_PICKER_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_OPEN_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_WORKING_COPY_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_FILES_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_PDF_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_RECENT_FILES_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_WINDOW_PLATFORM_FEATURE, featureBindings);
    registerPlatformFeatureHandlers(featureRegistrar as never, DOCUMENT_MENU_PLATFORM_FEATURE, featureBindings);

    featureRegistrar.handle(
        DOCUMENTS_CHANNELS.fileWriteDocxStreamBegin,
        (event, filePath) => beginDocxExportStream(createSenderIdContext(event), filePath),
    );
    featureRegistrar.handle(
        DOCUMENTS_CHANNELS.fileWriteDocxStreamChunk,
        (event, sessionId, chunk) => writeDocxExportStreamChunk(
            createSenderIdContext(event),
            sessionId,
            chunk,
        ),
    );
    featureRegistrar.handle(
        DOCUMENTS_CHANNELS.fileWriteDocxStreamCommit,
        (event, sessionId) => commitDocxExportStream(
            createSenderIdContext(event),
            sessionId,
        ),
    );
    featureRegistrar.handle(
        DOCUMENTS_CHANNELS.fileWriteDocxStreamCancel,
        (event, sessionId) => cancelDocxExportStream(
            createSenderIdContext(event),
            sessionId,
        ),
    );

    register(DOCUMENTS_CHANNELS.savePdfDataAs, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            data,
            options,
            serializedSaveOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfDataAs>
    ) =>
        service.savePdfDataAs(createDialogContext(event), workingPath, data, options, serializedSaveOptions));
    register(DOCUMENTS_CHANNELS.savePdfDataAsBegin, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            totalBytes,
            options,
            serializedSaveOptions,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.savePdfDataAsBegin>
    ) =>
        service.beginSavePdfDataAs(createDialogContext(event), workingPath, totalBytes, options, serializedSaveOptions));
    register(DOCUMENTS_CHANNELS.fileSavePdfData, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            data,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfData>
    ) =>
        service.savePdfData(createSenderIdContext(event), workingPath, data, options));
    register(DOCUMENTS_CHANNELS.fileSavePdfDataBegin, (
        event: IpcMainInvokeEvent,
        ...[
            workingPath,
            totalBytes,
            options,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileSavePdfDataBegin>
    ) =>
        service.beginSavePdfData(createWebContentsContext(event), workingPath, totalBytes, options));
    register(DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf, (
        event: IpcMainInvokeEvent,
        ...[
            sessionId,
            stagedOutput,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf>
    ) => service.commitStagedSerializedPdf(
        createSenderIdContext(event),
        sessionId,
        stagedOutput,
    ));
    register(DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf, (
        event: IpcMainInvokeEvent,
        ...[
            sessionId,
            stagedOutput,
        ]: TDocumentsIpcArgs<typeof DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf>
    ) => service.cancelStagedSerializedPdf(
        createSenderIdContext(event),
        sessionId,
        stagedOutput,
    ));
    register(DOCUMENTS_CHANNELS.registerRendererFileOpenToken, (event: IpcMainInvokeEvent, token: unknown) => {
        const normalizedToken = typeof token === 'string' ? token.trim() : '';
        return registerRendererFileOpenTokens(event, [normalizedToken]);
    });
    register(DOCUMENTS_CHANNELS.registerRendererFileOpenTokens, registerRendererFileOpenTokens);
    register(DOCUMENTS_CHANNELS.allowRendererFileOpen, (event: IpcMainInvokeEvent, request: unknown) => {
        const senderId = getSenderId(event);
        const filePath = isRecord(request) ? request.filePath : '';
        const token = isRecord(request) ? request.token : '';
        if (typeof token !== 'string' || !consumeRendererFileOpenToken(senderId, token)) {
            return false;
        }

        const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!normalizedPath || !isAbsolute(normalizedPath) || !isValidRendererFileOpenPath(normalizedPath)) {
            return false;
        }

        return allowOpenPath(normalizedPath, event.sender) !== null;
    });
    register(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch, (event: IpcMainInvokeEvent, requestsPayload: unknown) => {
        const senderId = getSenderId(event);
        const requests = parseRendererFileOpenBatchRequests(requestsPayload);
        if (
            !requests
            || requests.some(request => !hasRendererFileOpenToken(senderId, request.token))
            || requests.some(request => !isValidRendererFileOpenPath(request.filePath))
        ) {
            return false;
        }

        for (const request of requests) {
            consumeRendererFileOpenToken(senderId, request.token);
        }
        return requests.every(request => allowOpenPath(request.filePath, event.sender) !== null);
    });
    registerRawEvent(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event: IpcMainEvent, sessionId: unknown) => {
        try {
            attachSerializedPdfPersistencePort(event, sessionId);
        } catch (error) {
            logger.warn(`[ipc] rejected ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`);
        }
    });
    assertDocumentsIpcSingleRegistrationInvariant(registeredChannels);
}
