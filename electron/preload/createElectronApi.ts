import type {
    IpcRenderer,
    webUtils,
} from 'electron';
import type { IElectronAPI } from '@contracts/electronApi';
import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformManifest';
import type {
    IDocumentsFileIoCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { IDocxExportFileCapability } from '@contracts/docxExport';
import {
    decodeDebugLogEntry,
    type TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import type {
    TWindowCloseDecision,
    TWindowCloseUnavailableReason,
    TWindowCloseRequestHandler,
} from '@contracts/systemPlatformFeature';
import { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
import { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
import { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
import { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';
import { SYSTEM_PLATFORM_FEATURE } from '@contracts/systemPlatformFeature';
import { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import { getDebugLogMessages } from '@electron/preload/debugLogBuffer';
import {createDocumentsPreloadClient} from '@electron/features/documents/createDocumentsPreloadClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {
    createCodecIpcInvoker,
    createPlatformFeaturePreloadClient,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';
import { getErrorMessage } from '@electron/utils/error';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    type IPreloadDiagnosticsApi,
    type ICoreEventMap,
    type IShutdownSaveFlushRequest,
    type IShutdownSaveFlushResult,
    decodeWindowCloseRequest,
} from '@electron/platform-ipc/coreContract';

const preloadStartupStart = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

function tracePreloadStartup(stage: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    console.info(
        `[${iso}] [startup][preload] ${stage} (+${now - preloadStartupStart}ms from preload-api-init)`
        + stringifyDetails(details),
    );
}

async function invokeWithStartupTrace<T>(label: string, invoke: () => Promise<T>) {
    const startedAt = Date.now();
    tracePreloadStartup(`${label}:start`);
    try {
        const result = await invoke();
        tracePreloadStartup(`${label}:ok`, {durationMs: Date.now() - startedAt});
        return result;
    } catch (error) {
        tracePreloadStartup(`${label}:error`, {
            durationMs: Date.now() - startedAt,
            error: getErrorMessage(error),
        });
        throw error;
    }
}

interface IElectronSystemMemoryInfo {
    fileBacked?: number | undefined;
    free: number;
    purgeable?: number | undefined;
    total: number;
}

function normalizeMemoryKilobytes(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

export function decodeSystemMemoryInfo(memoryInfo: IElectronSystemMemoryInfo) {
    const total = Number(memoryInfo.total);
    const free = Number(memoryInfo.free);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
        return null;
    }

    const reclaimable = normalizeMemoryKilobytes(memoryInfo.fileBacked)
        + normalizeMemoryKilobytes(memoryInfo.purgeable);
    const available = Math.min(total, free + reclaimable);

    return {
        availableBytes: Math.round(available * 1024),
        totalBytes: Math.round(total * 1024),
        freeBytes: Math.round(free * 1024),
    };
}

function readSystemMemoryInfo() {
    if (typeof process.getSystemMemoryInfo !== 'function') {
        return null;
    }
    try {
        return decodeSystemMemoryInfo(process.getSystemMemoryInfo());
    } catch {
        return null;
    }
}

interface ICreateElectronApiOptions {
    diagnosticsPolicy?: IPreloadDiagnosticsApi['startupPolicy'];
    resourceProfile?: IHostResourceProfileSnapshot | null;
    waitForDocumentOpenDirect?: (path: string) => Promise<void>;
}

export function createElectronApi(
    ipcRenderer: IpcRenderer,
    electronWebUtils: typeof webUtils,
    options: ICreateElectronApiOptions = {},
): IElectronAPI & {diagnostics: IPreloadDiagnosticsApi;} {
    const invokeDocuments = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS);
    const eventSubscriber = createTypedIpcEventSubscriber<ICoreEventMap>(ipcRenderer);
    const baseDocuments = createDocumentsPreloadClient(ipcRenderer);
    const pageOps = createPlatformFeaturePreloadClient(ipcRenderer, PAGE_OPS_PLATFORM_FEATURE);
    const imageExport = createPlatformFeaturePreloadClient(ipcRenderer, IMAGE_EXPORT_PLATFORM_FEATURE);
    const ocr = createPlatformFeaturePreloadClient(ipcRenderer, OCR_PLATFORM_FEATURE);
    const settingsIpc = createPlatformFeaturePreloadClient(ipcRenderer, SETTINGS_PLATFORM_FEATURE);
    const updatesIpc = createPlatformFeaturePreloadClient(ipcRenderer, UPDATES_PLATFORM_FEATURE);
    const hostIpc = createPlatformFeaturePreloadClient(ipcRenderer, HOST_PLATFORM_FEATURE, {getResourceProfile: () => options.resourceProfile ?? null});
    const systemIpc = createPlatformFeaturePreloadClient(
        ipcRenderer,
        SYSTEM_PLATFORM_FEATURE,
        {getMemoryInfo: readSystemMemoryInfo},
    );
    const windowTabsIpc = createPlatformFeaturePreloadClient(ipcRenderer, WINDOW_TABS_PLATFORM_FEATURE);
    const shutdownSaveFlushCallbacks = new Set<() => Promise<{
        dirtyWorkingCopyPaths?: string[];
        flushedWorkingCopyPaths?: string[];
    }> | {
        dirtyWorkingCopyPaths?: string[];
        flushedWorkingCopyPaths?: string[];
    }>();
    const windowCloseCallbacks = new Set<TWindowCloseRequestHandler>();
    const pendingRendererFileOpenAllows = new Map<string, {
        token: string;
        promise: Promise<boolean>;
    }>();

    function createRendererFileOpenAllow(filePath: string, rendererFileOpenToken = globalThis.crypto.randomUUID()) {
        const allowPromise = invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            rendererFileOpenToken,
        )
            .then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
                filePath,
                token: rendererFileOpenToken,
            }))
            .finally(() => {
                const pending = pendingRendererFileOpenAllows.get(filePath);
                if (pending?.token === rendererFileOpenToken) {
                    pendingRendererFileOpenAllows.delete(filePath);
                }
            });
        pendingRendererFileOpenAllows.set(filePath, {
            token: rendererFileOpenToken,
            promise: allowPromise,
        });
        return allowPromise;
    }

    function allowRendererFileOpen(filePath: string) {
        return createRendererFileOpenAllow(filePath);
    }

    function allowRendererFileOpenBatch(filePaths: string[]) {
        const uniqueFilePaths = [...new Set(filePaths.filter(Boolean))];
        if (uniqueFilePaths.length === 0) {
            return Promise.resolve(true);
        }
        const requests = uniqueFilePaths.map(filePath => ({
            filePath,
            token: globalThis.crypto.randomUUID(),
        }));
        const allowPromise = invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
            requests.map(request => request.token),
        )
            .then(registered => registered && invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch, requests))
            .finally(() => {
                for (const request of requests) {
                    const pending = pendingRendererFileOpenAllows.get(request.filePath);
                    if (pending?.token === request.token) {
                        pendingRendererFileOpenAllows.delete(request.filePath);
                    }
                }
            });
        for (const request of requests) {
            pendingRendererFileOpenAllows.set(request.filePath, {
                token: request.token,
                promise: allowPromise,
            });
        }
        return allowPromise;
    }

    function observeRendererFileOpenGrant(promise: Promise<boolean>, details: Record<string, unknown>) {
        promise.catch((error: unknown) => {
            tracePreloadStartup('renderer-file-open-grant:error', {
                ...details,
                error: getErrorMessage(error),
            });
            console.warn('Failed to authorize renderer file-open capability', {
                ...details,
                error: getErrorMessage(error),
            });
        });
    }

    const openDocumentDirect = async (path: string, password?: string) => {
        const pendingAllow = pendingRendererFileOpenAllows.get(path)?.promise;
        if (pendingAllow && !await pendingAllow) {
            return null;
        }
        await options.waitForDocumentOpenDirect?.(path);
        return password === undefined
            ? baseDocuments.openDocumentDirect(path)
            : baseDocuments.openDocumentDirect(path, password);
    };
    const openDocumentDirectBatch = async (
        paths: string[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => {
        const allowed = await Promise.all(paths.map(async (path) => {
            const pendingAllow = pendingRendererFileOpenAllows.get(path)?.promise;
            return pendingAllow === undefined || await pendingAllow;
        }));
        if (allowed.some(result => !result)) {
            return null;
        }
        return options === undefined
            ? baseDocuments.openDocumentDirectBatch(paths, requestId)
            : baseDocuments.openDocumentDirectBatch(paths, requestId, options);
    };

    const extractPathsForFiles = (files: File[]) => files
        .map(file => electronWebUtils.getPathForFile(file))
        .filter(filePath => filePath.length > 0);

    const getPathForFile = (file: File) => {
        const filePath = electronWebUtils.getPathForFile(file);
        if (filePath) {
            observeRendererFileOpenGrant(allowRendererFileOpen(filePath), { filePath });
        }
        return filePath;
    };
    const getPathsForFiles = (files: File[]) => {
        const filePaths = extractPathsForFiles(files);
        observeRendererFileOpenGrant(allowRendererFileOpenBatch(filePaths), { fileCount: filePaths.length });
        return filePaths;
    };
    const registerFilesForOpen = async (files: File[]) => {
        const filePaths = extractPathsForFiles(files);
        const allowed = await allowRendererFileOpenBatch(filePaths);
        return allowed ? filePaths : [];
    };

    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest, (_event, payload: IShutdownSaveFlushRequest) => {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        if (!requestId) {
            return;
        }
        void (async () => {
            const dirtyWorkingCopyPaths = new Set<string>();
            const flushedWorkingCopyPaths = new Set<string>();
            const errors: string[] = [];
            const callbacks = Array.from(shutdownSaveFlushCallbacks);

            for (const callback of callbacks) {
                try {
                    const result = await callback();
                    for (const path of result.dirtyWorkingCopyPaths ?? []) {
                        if (path) {
                            dirtyWorkingCopyPaths.add(path);
                        }
                    }
                    for (const path of result.flushedWorkingCopyPaths ?? []) {
                        if (path) {
                            flushedWorkingCopyPaths.add(path);
                        }
                    }
                } catch (error) {
                    errors.push(getErrorMessage(error));
                }
            }

            const response: IShutdownSaveFlushResult = {
                callbackCount: callbacks.length,
                requestId,
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                ...(callbacks.length === 0
                    ? {error: 'No shutdown save-flush handler is registered.'}
                    : errors.length > 0 ? {error: errors.join('; ')} : {}),
            };
            ipcRenderer.send(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, response);
        })();
    });

    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.windowCloseRequest, (_event, payload: unknown) => {
        const request = decodeWindowCloseRequest(payload);
        if (!request) {
            return;
        }

        void (async () => {
            const callbacks = Array.from(windowCloseCallbacks);
            const callback = callbacks.length === 1 ? callbacks[0] : undefined;
            let response: {
                requestId: string;
                decision?: TWindowCloseDecision;
                status?: 'unavailable';
                reason?: TWindowCloseUnavailableReason;
            };
            if (callback) {
                try {
                    const candidate = await callback(request);
                    if (candidate === 'save' || candidate === 'discard' || candidate === 'cancel') {
                        response = {
                            decision: candidate,
                            requestId: request.requestId,
                        };
                    } else {
                        response = {
                            requestId: request.requestId,
                            status: 'unavailable',
                            reason: 'invalid-decision',
                        };
                    }
                } catch (error) {
                    console.warn(`[preload] Window close decision failed: ${getErrorMessage(error)}`);
                    response = {
                        requestId: request.requestId,
                        status: 'unavailable',
                        reason: 'handler-error',
                    };
                }
            } else {
                console.warn(`[preload] Window close decision unavailable; callback count: ${callbacks.length}`);
                response = {
                    requestId: request.requestId,
                    status: 'unavailable',
                    reason: callbacks.length === 0 ? 'no-handler' : 'multiple-handlers',
                };
            }

            try {
                ipcRenderer.send(CORE_IPC_SEND_CHANNELS.windowCloseResponse, response);
            } catch (error) {
                console.warn(`[preload] Window close response failed: ${getErrorMessage(error)}`);
            }
        })();
    });

    const documentPicker = createPlatformFeaturePreloadClient(
        ipcRenderer,
        DOCUMENT_PICKER_PLATFORM_FEATURE,
        {
            getPathForFile,
            getPathsForFiles,
            registerFilesForOpen,
            ...(baseDocuments.openFolderDialogStructured
                ? {openFolderDialogStructured: baseDocuments.openFolderDialogStructured}
                : {}),
            ...(baseDocuments.createCombinedPdfFromFiles
                ? {createCombinedPdfFromFiles: baseDocuments.createCombinedPdfFromFiles}
                : {}),
        },
    ) satisfies IDocumentsPickerCapability;
    const recentFilesIpc = createPlatformFeaturePreloadClient(
        ipcRenderer,
        DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    );
    const recentFiles = {
        ...recentFilesIpc,
        get: () => invokeWithStartupTrace('recentFiles:get', recentFilesIpc.get),
    };
    const documentRecentFiles = {recentFiles} satisfies IDocumentsRecentFilesCapability;
    const documentWindow = createPlatformFeaturePreloadClient(
        ipcRenderer,
        DOCUMENT_WINDOW_PLATFORM_FEATURE,
        baseDocuments.showItemInFolderStructured
            ? {showItemInFolderStructured: baseDocuments.showItemInFolderStructured}
            : {},
    ) satisfies IDocumentsWindowCapability;
    const documentMenu = createPlatformFeaturePreloadClient(
        ipcRenderer,
        DOCUMENT_MENU_PLATFORM_FEATURE,
    );
    const documentOpenFeature = createPlatformFeaturePreloadClient(
        ipcRenderer,
        DOCUMENT_OPEN_PLATFORM_FEATURE,
    );
    const documentOpen = {
        openDocumentDirect,
        openDocumentDirectBatch,
        cancelOpenDocumentDirectBatch: baseDocuments.cancelOpenDocumentDirectBatch
            ?? documentOpenFeature.cancelOpenDocumentDirectBatch!,
        onOpenDocumentDirectBatchProgress: documentOpenFeature.onOpenDocumentDirectBatchProgress,
    } satisfies IDocumentsOpenCapability;
    const documentWorkingCopy = {
        createWorkingCopyFromData: baseDocuments.createWorkingCopyFromData,
        createWorkingCopyFromPath: baseDocuments.createWorkingCopyFromPath,
        parsePdfAnnotations: baseDocuments.parsePdfAnnotations,
        cleanupFile: baseDocuments.cleanupFile,
        cleanupOcrTemp: baseDocuments.cleanupOcrTemp,
    } satisfies IDocumentsWorkingCopyCapability;
    const optionalDocumentFileMethods = {
        ...(baseDocuments.createManagedTempFileHandle
            ? {createManagedTempFileHandle: baseDocuments.createManagedTempFileHandle}
            : {}),
        ...(baseDocuments.releaseManagedTempFileHandle
            ? {releaseManagedTempFileHandle: baseDocuments.releaseManagedTempFileHandle}
            : {}),
        ...(baseDocuments.repairPdf ? {repairPdf: baseDocuments.repairPdf} : {}),
        ...(baseDocuments.optimizePdfForInteraction ? {optimizePdfForInteraction: baseDocuments.optimizePdfForInteraction} : {}),
        ...(baseDocuments.optimizePdfAsCopy ? {optimizePdfAsCopy: baseDocuments.optimizePdfAsCopy} : {}),
        ...(baseDocuments.savePdfNoteTextUpdates ? {savePdfNoteTextUpdates: baseDocuments.savePdfNoteTextUpdates} : {}),
        ...(baseDocuments.savePdfNoteChanges ? {savePdfNoteChanges: baseDocuments.savePdfNoteChanges} : {}),
        ...(baseDocuments.savePdfNativeMutations ? {savePdfNativeMutations: baseDocuments.savePdfNativeMutations} : {}),
        ...(baseDocuments.applyPdfNativeMutationsToWorkingCopy
            ? {applyPdfNativeMutationsToWorkingCopy: baseDocuments.applyPdfNativeMutationsToWorkingCopy}
            : {}),
        ...(baseDocuments.commitStagedPdfNativeMutations
            ? {commitStagedPdfNativeMutations: baseDocuments.commitStagedPdfNativeMutations}
            : {}),
        ...(baseDocuments.cloneStagedPdfNativeMutationToWorkingCopy
            ? {cloneStagedPdfNativeMutationToWorkingCopy: baseDocuments.cloneStagedPdfNativeMutationToWorkingCopy}
            : {}),
        ...(baseDocuments.replaceWorkingCopyFromStagedPdfNativeMutation
            ? {replaceWorkingCopyFromStagedPdfNativeMutation: baseDocuments.replaceWorkingCopyFromStagedPdfNativeMutation}
            : {}),
        ...(baseDocuments.getPdfNativePageSizes
            ? {getPdfNativePageSizes: baseDocuments.getPdfNativePageSizes}
            : {}),
        ...(baseDocuments.getPdfOpeningGeometry
            ? {getPdfOpeningGeometry: baseDocuments.getPdfOpeningGeometry}
            : {}),
        ...(baseDocuments.cancelPdfNativePagePreview
            ? {cancelPdfNativePagePreview: baseDocuments.cancelPdfNativePagePreview}
            : {}),
        ...(baseDocuments.renderPdfNativePagePreview
            ? {renderPdfNativePagePreview: baseDocuments.renderPdfNativePagePreview}
            : {}),
        ...(baseDocuments.beginPdfAnnotationIndex
            ? {beginPdfAnnotationIndex: baseDocuments.beginPdfAnnotationIndex}
            : {}),
        ...(baseDocuments.readPdfAnnotationIndexChunk
            ? {readPdfAnnotationIndexChunk: baseDocuments.readPdfAnnotationIndexChunk}
            : {}),
        ...(baseDocuments.releasePdfAnnotationIndex
            ? {releasePdfAnnotationIndex: baseDocuments.releasePdfAnnotationIndex}
            : {}),
        ...(baseDocuments.cancelPdfAnnotationIndex
            ? {cancelPdfAnnotationIndex: baseDocuments.cancelPdfAnnotationIndex}
            : {}),
        ...(baseDocuments.beginPdfAnnotationParse
            ? {beginPdfAnnotationParse: baseDocuments.beginPdfAnnotationParse}
            : {}),
        ...(baseDocuments.readPdfAnnotationParseChunk
            ? {readPdfAnnotationParseChunk: baseDocuments.readPdfAnnotationParseChunk}
            : {}),
        ...(baseDocuments.releasePdfAnnotationParse
            ? {releasePdfAnnotationParse: baseDocuments.releasePdfAnnotationParse}
            : {}),
        ...(baseDocuments.cancelPdfAnnotationParse
            ? {cancelPdfAnnotationParse: baseDocuments.cancelPdfAnnotationParse}
            : {}),
        ...(baseDocuments.beginPdfEmbeddedShapeIndex
            ? {beginPdfEmbeddedShapeIndex: baseDocuments.beginPdfEmbeddedShapeIndex}
            : {}),
        ...(baseDocuments.readPdfEmbeddedShapeIndexChunk
            ? {readPdfEmbeddedShapeIndexChunk: baseDocuments.readPdfEmbeddedShapeIndexChunk}
            : {}),
        ...(baseDocuments.releasePdfEmbeddedShapeIndex
            ? {releasePdfEmbeddedShapeIndex: baseDocuments.releasePdfEmbeddedShapeIndex}
            : {}),
        ...(baseDocuments.cancelPdfEmbeddedShapeIndex
            ? {cancelPdfEmbeddedShapeIndex: baseDocuments.cancelPdfEmbeddedShapeIndex}
            : {}),
        ...(baseDocuments.getWorkingCopyBackingStatus
            ? {getWorkingCopyBackingStatus: baseDocuments.getWorkingCopyBackingStatus}
            : {}),
        ...(baseDocuments.onWorkingCopyBackingStatusChanged
            ? {onWorkingCopyBackingStatusChanged: baseDocuments.onWorkingCopyBackingStatusChanged}
            : {}),
    };
    const documentFiles = {
        readFile: baseDocuments.readFile,
        statFile: baseDocuments.statFile,
        readFileRange: baseDocuments.readFileRange,
        readFileChunks: baseDocuments.readFileChunks,
        readTextFile: baseDocuments.readTextFile,
        fileExists: baseDocuments.fileExists,
        getDocumentRevision: baseDocuments.getDocumentRevision,
        onDocumentRevisionChanged: baseDocuments.onDocumentRevisionChanged,
        savePdfAs: baseDocuments.savePdfAs,
        savePdfDataAs: baseDocuments.savePdfDataAs,
        savePdfDialog: baseDocuments.savePdfDialog,
        saveDocxAs: baseDocuments.saveDocxAs,
        writeFile: baseDocuments.writeFile,
        replaceWorkingCopyFromPath: baseDocuments.replaceWorkingCopyFromPath,
        writeDocxFile: baseDocuments.writeDocxFile,
        saveFileStructured: baseDocuments.saveFileStructured,
        ...(baseDocuments.resyncWorkingCopy ? {resyncWorkingCopy: baseDocuments.resyncWorkingCopy} : {}),
        savePdfData: baseDocuments.savePdfData,
        savePdfDataChunks: baseDocuments.savePdfDataChunks,
        ...optionalDocumentFileMethods,
        writeDocxFileChunks: baseDocuments.writeDocxFileChunks,
    } satisfies IDocumentsFileIoCapability & IDocxExportFileCapability;
    const documentPdf = {
        analyzePdfConformance: baseDocuments.analyzePdfConformance,
        validatePdfData: baseDocuments.validatePdfData,
        validatePdfPath: baseDocuments.validatePdfPath,
        openPdfInDefaultAppData: baseDocuments.openPdfInDefaultAppData,
        openPdfInDefaultAppPath: baseDocuments.openPdfInDefaultAppPath,
        printPdfData: baseDocuments.printPdfData,
        ...(baseDocuments.cancelPdfPrint
            ? {cancelPdfPrint: baseDocuments.cancelPdfPrint}
            : {}),
        printPdfPath: baseDocuments.printPdfPath,
        ...(baseDocuments.onNativePrintDialogOpened
            ? {onNativePrintDialogOpened: baseDocuments.onNativePrintDialogOpened}
            : {}),
    } satisfies IDocumentsPdfCapability;
    const api = {
        manifest: ELECTRON_PLATFORM_MANIFEST,
        documentPicker,
        documentOpen,
        documentWorkingCopy,
        documentFiles,
        documentPdf,
        documentRecentFiles,
        documentWindow,
        documentMenu,
        pageOps,
        imageExport,

        ocr,
        scanCleanup: createPlatformFeaturePreloadClient(ipcRenderer, SCAN_CLEANUP_PLATFORM_FEATURE),

        search: createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE),

        djvu: createPlatformFeaturePreloadClient(ipcRenderer, DJVU_PLATFORM_FEATURE),

        settings: {
            ...settingsIpc,
            get: () => invokeWithStartupTrace(
                'settings:get',
                settingsIpc.get,
            ),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            onDebugLog: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(CORE_IPC_EVENT_CHANNELS.debugLog, decodeDebugLogEntry, callback),
            rendererLog: (entry) => ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, entry),
        },

        diagnostics: {
            startupPolicy: options.diagnosticsPolicy ?? Object.freeze({mode: 'unknown'}),
            sendRecord: (record: DiagnosticRecord, suppressedCount = 0) => {
                ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererDiagnostic, record, suppressedCount);
            },
            onDebugLog: (callback) => eventSubscriber.onDecodedPayload(
                CORE_IPC_EVENT_CHANNELS.debugLog,
                decodeDebugLogEntry,
                callback,
            ),
        },

        system: {
            ...systemIpc,
            onShutdownSaveFlushRequest: (callback) => {
                shutdownSaveFlushCallbacks.add(callback);
                return () => {
                    shutdownSaveFlushCallbacks.delete(callback);
                };
            },
            onWindowCloseRequest: (callback) => {
                windowCloseCallbacks.add(callback);
                return () => {
                    windowCloseCallbacks.delete(callback);
                };
            },
        },

        updates: {
            ...updatesIpc,
            onMenuCheckForUpdates: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates, callback),
        },

        shell: createPlatformFeaturePreloadClient(ipcRenderer, SHELL_PLATFORM_FEATURE),

        host: hostIpc,

        agent: createPlatformFeaturePreloadClient(ipcRenderer, AGENT_PLATFORM_FEATURE),

        windowTabs: {
            ...windowTabsIpc,
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send(CORE_IPC_CHANNELS.rendererReady);
            },
            claimPendingExternalOpenPaths: () => invokeWithStartupTrace(
                'app:claimPendingExternalOpenPaths',
                windowTabsIpc.claimPendingExternalOpenPaths,
            ),
        },
    } satisfies IElectronAPI & {diagnostics: IPreloadDiagnosticsApi;};

    return api;
}
