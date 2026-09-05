import type { IpcRenderer } from 'electron';
import {
    decodeDocumentRevisionChangedEvent,
    type IDocumentRevisionChangedEvent,
} from '@contracts/documentRevision';
import type {
    IDocumentsFileCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentChunkReadOptions,
    IPdfDataPrintOptions,
    IWorkingCopyBackingStatus,
    IPdfNativePagePreviewOptions,
    IPdfNativeStagedCommitOptions,
    IPdfOptimizeOptions,
    IPdfPathPrintOptions,
    IPdfSaveAsOptions,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import {
    decodeOptionalPdfDataPrintOptions,
    decodeOptionalPdfPathPrintOptions,
} from '@contracts/pdfPathPrintOptions';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
    type IDocxExportFileCapability,
    type IDocxExportStreamBeginResult,
    type TDocxExportChunkSource,
} from '@contracts/docxExport';
import {
    decodeWorkingCopyBackingStatus,
    isPdfOptimizePreset,
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
} from '@contracts/electronApiDocuments';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
} from '@pdf-core/nativePdfMutationPolicy';
import {appendPdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfIdentityBindings';
import { isRecord } from '@contracts/runtimeGuards';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceCancelFrame,
    createPdfPersistenceChunkFrame,
    createPdfPersistenceCompleteFrame,
    getPdfPersistenceErrorMessage,
    isSerializedPdfPersistenceLimits,
    parsePdfPersistenceMainToPreloadFrame,
    type IPdfPersistenceErrorFrame,
} from '@contracts/documentPersistenceFrames';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
    type IDocumentFilesInvokeMap,
    type IDocumentOpenInvokeMap,
    type IDocumentPdfInvokeMap,
    type IDocumentWorkingCopyInvokeMap,
} from '@contracts/documentsPlatformFeature';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import * as workingCopyPassword from '@electron/features/documents/appendWorkingCopyPassword';
import {
    createCodecIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';
import {createNativePrintDialogOpenedSubscriber} from '@electron/features/documents/createNativePrintDialogOpenedSubscriber';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertPdfIndexChunkOptions,
    assertPdfSerializedSaveOptions,
    assertPdfSidecarChunkOffset,
    assertOptionalFileName,
    assertWorkingCopyFileName,
    assertWriteData,
} from '@electron/features/documents/preloadShared';
import {createPdfAnnotationParsePreloadMethods} from '@electron/features/documents/createPdfAnnotationParsePreloadMethods';
type TDocumentsPreloadFileClient = Omit<
    IDocumentsFileCapability,
    keyof IDocumentsPickerCapability
    | keyof IDocumentsRecentFilesCapability
    | keyof IDocumentsWindowCapability
>;
type TDocumentsFileIpcRenderer = Pick<IpcRenderer, 'invoke' | 'postMessage'>
    & Partial<Pick<IpcRenderer, 'on' | 'removeListener'>>;
const PDF_PERSISTENCE_CHUNK_BYTES = PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES;
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS;
const PDF_PERSISTENCE_RESULT_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS;
const LONG_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
const DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL = {
    [DOCUMENTS_CHANNELS.openDocumentDirectBatch]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfOpeningGeometry]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfNativePageSizes]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfNativePagePreview]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfAnnotationIndexBegin]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.parsePdfAnnotations]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfAnnotationParseBegin]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfEmbeddedShapeIndexBegin]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.pdfValidatePath]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileRepairPdf]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileCloneStagedPdfNativeMutationToWorkingCopy]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromStagedPdfNativeMutation]: LONG_NATIVE_IPC_TIMEOUT_MS,
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: LONG_NATIVE_IPC_TIMEOUT_MS,
} as const;
interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
    staged?: {
        sessionId: string;
        stagedOutput: ITypedStagedArtifact;
    };
}
interface IDocumentsFileEventMap {
    [DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onDocumentRevisionChanged]:
    IDocumentRevisionChangedEvent;
    [DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onWorkingCopyBackingStatusChanged]:
    IWorkingCopyBackingStatus;
}

type TDocumentChunkSource = Parameters<IDocumentsFileCapability['savePdfDataChunks']>[2];

class PdfPersistenceError extends Error {
    readonly code: IPdfPersistenceErrorFrame['code'];
    readonly phase: IPdfPersistenceErrorFrame['phase'];
    readonly retryable: boolean;
    readonly expected: boolean;
    readonly seq: number | undefined;

    constructor(payload: IPdfPersistenceErrorFrame) {
        super(getPdfPersistenceErrorMessage(payload));
        this.name = 'PdfPersistenceError';
        this.code = payload.code;
        this.phase = payload.phase;
        this.retryable = payload.retryable;
        this.expected = payload.expected;
        this.seq = payload.seq;
    }
}

function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

function assertPdfSaveAsOptions(value: unknown, label: string): IPdfSaveAsOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (value.optimizeLossless !== undefined && typeof value.optimizeLossless !== 'boolean') {
        throw new TypeError(`${label}.optimizeLossless must be a boolean`);
    }

    return value.optimizeLossless === true
        ? { optimizeLossless: true }
        : undefined;
}

function isVerifyBytesBeforeCommit(
    value: unknown,
): value is NonNullable<IPdfSerializedCommitCallbacks['verifyBytesBeforeCommit']> {
    return typeof value === 'function';
}

function isVerifyPathBeforeCommit(
    value: unknown,
): value is NonNullable<IPdfSerializedCommitCallbacks['verifyPathBeforeCommit']> {
    return typeof value === 'function';
}

function isAssertBeforeCommit(
    value: unknown,
): value is NonNullable<IPdfSerializedCommitCallbacks['assertBeforeCommit']> {
    return typeof value === 'function';
}

function assertPdfSerializedCommitCallbacks(
    value: unknown,
    label: string,
): IPdfSerializedCommitCallbacks | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (
        !isRecord(value)
        || (value.verifyBytesBeforeCommit !== undefined
            && !isVerifyBytesBeforeCommit(value.verifyBytesBeforeCommit))
        || (value.verifyPathBeforeCommit !== undefined
            && !isVerifyPathBeforeCommit(value.verifyPathBeforeCommit))
        || (value.assertBeforeCommit !== undefined
            && !isAssertBeforeCommit(value.assertBeforeCommit))
    ) {
        throw new TypeError(`${label} must contain only persistence commit callbacks`);
    }
    const verifyBytesBeforeCommit = value.verifyBytesBeforeCommit;
    const verifyPathBeforeCommit = value.verifyPathBeforeCommit;
    const assertBeforeCommit = value.assertBeforeCommit;
    return {
        ...(isVerifyBytesBeforeCommit(verifyBytesBeforeCommit)
            ? {verifyBytesBeforeCommit}
            : {}),
        ...(isVerifyPathBeforeCommit(verifyPathBeforeCommit)
            ? {verifyPathBeforeCommit}
            : {}),
        ...(isAssertBeforeCommit(assertBeforeCommit)
            ? {assertBeforeCommit}
            : {}),
    };
}

function assertPdfNativeStagedCommitOptions(value: unknown, label: string): IPdfNativeStagedCommitOptions {
    return appendPdfNativeAnnotationIdentityBindings(assertPdfSerializedSaveOptions(value, label), value, label);
}
function assertPdfOptimizeOptions(value: unknown, label: string): IPdfOptimizeOptions {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!isPdfOptimizePreset(value.preset)) {
        throw new TypeError(`${label}.preset is invalid`);
    }

    return { preset: value.preset };
}

function assertPdfNativePagePreviewOptions(
    value: unknown,
    label: string,
): IPdfNativePagePreviewOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (
        value.targetWidthPx !== undefined
        && (
            typeof value.targetWidthPx !== 'number'
            || !Number.isFinite(value.targetWidthPx)
            || value.targetWidthPx < 1
        )
    ) {
        throw new TypeError(`${label}.targetWidthPx must be a positive finite number`);
    }
    if (
        value.previewRequestId !== undefined
        && (
            typeof value.previewRequestId !== 'string'
            || value.previewRequestId.trim().length === 0
        )
    ) {
        throw new TypeError(`${label}.previewRequestId must be a non-empty string`);
    }

    const previewRequestId = typeof value.previewRequestId === 'string'
        ? value.previewRequestId.trim()
        : undefined;
    const normalized = {
        ...(value.targetWidthPx === undefined ? {} : {targetWidthPx: Math.trunc(value.targetWidthPx)}),
        ...(previewRequestId === undefined ? {} : {previewRequestId}),
    } satisfies IPdfNativePagePreviewOptions;

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function assertPersistenceData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    return value;
}
function assertDocxExportChunk(value: unknown) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new Error('writeDocxFileChunks chunks must yield non-empty Uint8Array values');
    }
    if (value.byteLength > DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES) {
        throw new Error(
            `writeDocxFileChunks chunk exceeds maximum size (${DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES} bytes)`,
        );
    }
    return value;
}
function createDocxExportFileCapability(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
): IDocxExportFileCapability {
    const invoke = async <TResult>(channel: string, ...args: unknown[]) => await ipcRenderer.invoke(channel, ...args) as TResult;
    const writeDocxFileChunks = async (path: Parameters<IDocxExportFileCapability['writeDocxFileChunks']>[0], chunks: TDocxExportChunkSource, signal?: AbortSignal) => {
        const checkedPath = assertAbsolutePath(path, 'writeDocxFileChunks.path'); throwIfAborted(signal);
        const beginResult = await invoke<IDocxExportStreamBeginResult>(
            DOCX_EXPORT_STREAM_CHANNELS.begin,
            checkedPath,
        );
        if (
            !beginResult
                || typeof beginResult.sessionId !== 'string'
                || beginResult.sessionId.trim().length === 0
        ) {
            throw new Error('Invalid DOCX stream begin response');
        }
        const sessionId = beginResult.sessionId;
        let wroteChunk = false;
        let cancelPromise: Promise<boolean> | null = null;
        const cancelSession = () => cancelPromise ??= invoke<boolean>(
            DOCX_EXPORT_STREAM_CHANNELS.cancel,
            sessionId,
        ).catch(() => false);
        const handleAbort = () => { void cancelSession(); };
        signal?.addEventListener('abort', handleAbort, {once: true});
        try {
            throwIfAborted(signal);
            for await (const chunk of chunks) {
                throwIfAborted(signal);
                const checkedChunk = assertDocxExportChunk(chunk);
                await invoke(
                    DOCX_EXPORT_STREAM_CHANNELS.writeChunk,
                    sessionId,
                    checkedChunk,
                );
                throwIfAborted(signal);
                wroteChunk = true;
            }
            throwIfAborted(signal);
            if (!wroteChunk) {
                throw new Error('writeDocxFileChunks requires at least one chunk');
            }
            const committed = await invoke<boolean>(
                DOCX_EXPORT_STREAM_CHANNELS.commit,
                sessionId,
            );
            if (committed !== true) {
                throw new Error('DOCX stream commit was not accepted');
            }
            return true;
        } catch (error) {
            await cancelSession();
            throw error;
        } finally { signal?.removeEventListener('abort', handleAbort); }
    };
    return {writeDocxFileChunks};
}

function assertPositiveSafeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function getChunkReadSize(options: IDocumentChunkReadOptions | undefined) {
    const chunkBytes = options?.chunkBytes ?? PDF_PERSISTENCE_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > PDF_PERSISTENCE_CHUNK_BYTES) {
        throw new Error(`readFileChunks.options.chunkBytes must be an integer between 1 and ${PDF_PERSISTENCE_CHUNK_BYTES}`);
    }
    return chunkBytes;
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

function getTightTransferChunk(chunk: Uint8Array, fieldName: string) {
    const checkedChunk = assertPersistenceData(chunk, fieldName);
    return checkedChunk.byteOffset === 0 && checkedChunk.byteLength === checkedChunk.buffer.byteLength
        ? checkedChunk
        : checkedChunk.slice();
}

async function* iterateDocumentChunks(chunks: TDocumentChunkSource) {
    for await (const chunk of chunks) {
        yield chunk;
    }
}

function* iterateUint8ArrayChunks(data: Uint8Array) {
    for (let offset = 0; offset < data.byteLength; offset += PDF_PERSISTENCE_CHUNK_BYTES) {
        const end = Math.min(offset + PDF_PERSISTENCE_CHUNK_BYTES, data.byteLength);
        yield data.slice(offset, end);
    }
}

function assertPersistenceProtocolLimits(value: unknown) {
    if (isRecord(value) && typeof value.sessionId === 'string' && value.protocolVersion === undefined) {
        return {
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
            maxChunkBytes: PDF_PERSISTENCE_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            ackTimeoutMs: PDF_PERSISTENCE_ACK_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_RESULT_TIMEOUT_MS,
        };
    }
    if (!isSerializedPdfPersistenceLimits(value)) {
        throw new Error('Unsupported PDF persistence protocol');
    }
    return value;
}

interface IPersistencePortDeferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
    settled: boolean;
    timer: ReturnType<typeof setTimeout>;
}

class PdfPersistencePortLifecycle {
    private readonly trackedPromises: Array<Promise<unknown>> = [];
    private readonly acknowledgements = new Map<number, IPersistencePortDeferred<undefined>>();
    private readonly ready: IPersistencePortDeferred<undefined>;
    private readonly result: IPersistencePortDeferred<ISerializedPdfPersistencePortResult>;
    private aborted = false;

    public constructor(private readonly port: MessagePort) {
        this.ready = this.createDeferred<undefined>(
            PDF_PERSISTENCE_READY_TIMEOUT_MS,
            'PDF persistence port did not become ready',
        );
        this.result = this.createDeferred<ISerializedPdfPersistencePortResult>(
            PDF_PERSISTENCE_RESULT_TIMEOUT_MS,
            'PDF persistence port did not return a final result',
        );
        port.addEventListener('message', this.handleMessage);
    }

    public waitUntilReady() {
        return this.ready.promise;
    }

    public waitForAcknowledgement(seq: number) {
        if (this.aborted) {
            const promise = Promise.reject(new Error('PDF persistence port lifecycle was aborted'));
            void promise.catch(() => undefined);
            this.trackedPromises.push(promise);
            return promise;
        }
        const acknowledgement = this.createDeferred<undefined>(
            PDF_PERSISTENCE_ACK_TIMEOUT_MS,
            `PDF persistence chunk ${seq} was not acknowledged`,
        );
        this.acknowledgements.set(seq, acknowledgement);
        return acknowledgement.promise;
    }

    public waitForResult() {
        return this.result.promise;
    }

    public abort(error: unknown) {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.port.removeEventListener('message', this.handleMessage);
        this.rejectDeferred(this.ready, error);
        this.rejectDeferred(this.result, error);
        for (const acknowledgement of this.acknowledgements.values()) {
            this.rejectDeferred(acknowledgement, error);
        }
        this.acknowledgements.clear();
    }

    public async drain() {
        await Promise.allSettled(this.trackedPromises);
    }

    private readonly handleMessage = (event: MessageEvent<unknown>) => {
        const payload = parsePdfPersistenceMainToPreloadFrame(event.data);
        if (!payload) {
            return;
        }
        if (payload.type === 'ready') {
            this.resolveDeferred(this.ready, undefined);
            return;
        }
        if (payload.type === 'ack') {
            const acknowledgement = this.acknowledgements.get(payload.seq);
            if (acknowledgement) {
                this.acknowledgements.delete(payload.seq);
                this.resolveDeferred(acknowledgement, undefined);
            }
            return;
        }
        if (payload.type === 'result') {
            this.resolveDeferred(this.result, {
                path: payload.path,
                validation: payload.validation,
            });
            return;
        }
        if (payload.type === 'staged') {
            this.resolveDeferred(this.result, {
                path: null,
                validation: payload.validation,
                staged: {
                    sessionId: payload.sessionId,
                    stagedOutput: payload.stagedOutput,
                },
            });
            return;
        }
        this.abort(new PdfPersistenceError(payload));
    };

    private createDeferred<T>(timeoutMs: number, timeoutMessage: string): IPersistencePortDeferred<T> {
        let resolvePromise!: (value: T) => void;
        let rejectPromise!: (error: unknown) => void;
        const promise = new Promise<T>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        void promise.catch(() => undefined);
        this.trackedPromises.push(promise);
        const deferred: IPersistencePortDeferred<T> = {
            promise,
            resolve: resolvePromise,
            reject: rejectPromise,
            settled: false,
            timer: setTimeout(() => {
                this.abort(new Error(timeoutMessage));
            }, timeoutMs),
        };
        return deferred;
    }

    private resolveDeferred<T>(deferred: IPersistencePortDeferred<T>, value: T) {
        if (deferred.settled) {
            return;
        }
        deferred.settled = true;
        clearTimeout(deferred.timer);
        deferred.resolve(value);
    }

    private rejectDeferred<T>(deferred: IPersistencePortDeferred<T>, error: unknown) {
        if (deferred.settled) {
            return;
        }
        deferred.settled = true;
        clearTimeout(deferred.timer);
        deferred.reject(error);
    }
}

function tryPostPdfPersistenceCancel(port: MessagePort) {
    try {
        port.postMessage(createPdfPersistenceCancelFrame());
        return true;
    } catch {
        return false;
    }
}

async function streamPdfBytesToPersistencePort(
    ipcRenderer: Pick<IpcRenderer, 'postMessage'>,
    beginResult: {sessionId: string},
    chunks: TDocumentChunkSource,
    expectedTotalBytes: number,
) {
    const limits = assertPersistenceProtocolLimits(beginResult);
    const channel = new MessageChannel();
    channel.port1.start();
    const lifecycle = new PdfPersistencePortLifecycle(channel.port1);
    let portTransferred = false;
    try {
        ipcRenderer.postMessage(DOCUMENTS_CHANNELS.fileSavePdfDataPort, beginResult.sessionId, [channel.port2]);
        portTransferred = true;
        await lifecycle.waitUntilReady();

        let seq = 0;
        let bytesWritten = 0;
        const inFlightAcks: Array<Promise<void>> = [];
        for await (const chunk of iterateDocumentChunks(chunks)) {
            const bytes = getTightTransferChunk(chunk, `savePdfDataChunks.chunks[${seq}]`);
            bytesWritten += bytes.byteLength;
            if (bytes.byteLength > limits.maxChunkBytes || bytesWritten > expectedTotalBytes) {
                throw new Error('savePdfDataChunks chunks exceed the negotiated PDF persistence size');
            }
            // Electron's main-process MessagePort only transfers ports here; transferring the
            // ArrayBuffer drops the structured-clone payload before MessagePortMain receives it.
            const acknowledgement = lifecycle.waitForAcknowledgement(seq);
            channel.port1.postMessage(createPdfPersistenceChunkFrame(seq, bytes));
            inFlightAcks.push(acknowledgement);
            if (inFlightAcks.length >= limits.maxInFlightChunks) {
                await inFlightAcks.shift();
            }
            seq += 1;
        }
        if (bytesWritten !== expectedTotalBytes) {
            throw new Error('savePdfDataChunks chunks did not match the negotiated PDF persistence size');
        }
        await Promise.all(inFlightAcks);

        channel.port1.postMessage(createPdfPersistenceCompleteFrame());
        return await lifecycle.waitForResult();
    } catch (error) {
        if (portTransferred) {
            tryPostPdfPersistenceCancel(channel.port1);
        }
        lifecycle.abort(error);
        throw error;
    } finally {
        lifecycle.abort(new Error('PDF persistence port lifecycle closed'));
        await lifecycle.drain();
        channel.port1.close();
    }
}

export function createDocumentsPreloadFileClient(
    ipcRenderer: TDocumentsFileIpcRenderer,
): TDocumentsPreloadFileClient & IDocxExportFileCapability {
    const invoke = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS, {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL});
    const invokeOpen = createCodecIpcInvoker<IDocumentOpenInvokeMap>(
        ipcRenderer,
        DOCUMENT_OPEN_PLATFORM_FEATURE.ipcCodecs,
        {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL},
    );
    const invokeWorkingCopy = createCodecIpcInvoker<IDocumentWorkingCopyInvokeMap>(
        ipcRenderer,
        DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs,
        {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL},
    );
    const invokeFiles = createCodecIpcInvoker<IDocumentFilesInvokeMap>(
        ipcRenderer,
        DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs,
        {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL},
    );
    const invokePdf = createCodecIpcInvoker<IDocumentPdfInvokeMap>(
        ipcRenderer,
        DOCUMENT_PDF_PLATFORM_FEATURE.ipcCodecs,
        {invokeTimeoutMsByChannel: DOCUMENTS_NATIVE_INVOKE_TIMEOUT_MS_BY_CHANNEL},
    );
    const eventSubscriber = createTypedIpcEventSubscriber<IDocumentsFileEventMap>(ipcRenderer);
    const docxExportCapability = createDocxExportFileCapability(ipcRenderer);
    const pdfAnnotationParsePreloadMethods = createPdfAnnotationParsePreloadMethods({
        invokeFiles,
        invokeWorkingCopy,
    });
    const openDocumentDirect = (path: string, password?: string) => password === undefined
        ? invokeOpen(DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirect, path)
        : invokeOpen(DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirect, path, password);
    const openDocumentDirectBatch = (
        paths: string[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => options === undefined
        ? invokeOpen(DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirectBatch, paths, requestId)
        : invokeOpen(DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirectBatch, paths, requestId, options);
    const commitStagedPersistence = async (
        result: ISerializedPdfPersistencePortResult,
        callbacks: IPdfSerializedCommitCallbacks | undefined,
    ) => {
        const staged = result.staged;
        if (staged === undefined) {
            return result;
        }
        try {
            await callbacks?.verifyPathBeforeCommit?.(
                staged.stagedOutput.path,
                staged.stagedOutput.size,
            );
            await callbacks?.assertBeforeCommit?.();
            return await invoke(
                DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf,
                staged.sessionId,
                staged.stagedOutput,
            );
        } catch (error) {
            await invoke(
                DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf,
                staged.sessionId,
                staged.stagedOutput,
            ).catch(() => false);
            throw error;
        }
    };

    return {
        ...docxExportCapability,
        ...pdfAnnotationParsePreloadMethods,
        openDocumentDirect,
        openDocumentDirectBatch,
        cancelOpenDocumentDirectBatch: (requestId: string) =>
            invokeOpen(DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.cancelOpenDocumentDirectBatch, requestId),
        savePdfAs: (workingPath, options, revisionOptions) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfAs,
                assertAbsolutePath(workingPath, 'savePdfAs.workingPath'),
                assertPdfSaveAsOptions(options, 'savePdfAs.options'),
                assertPdfSerializedSaveOptions(revisionOptions, 'savePdfAs.revisionOptions'),
            ),
        savePdfDataAs: async (workingPath, data, options, serializedSaveOptions, commitCallbacks) => {
            const checkedWorkingPath = assertAbsolutePath(workingPath, 'savePdfDataAs.workingPath');
            const checkedData = assertPersistenceData(data, 'savePdfDataAs.data');
            const checkedOptions = assertPdfSaveAsOptions(options, 'savePdfDataAs.options');
            const checkedSerializedSaveOptions = assertPdfSerializedSaveOptions(
                serializedSaveOptions,
                'savePdfDataAs.serializedSaveOptions',
            );
            const checkedCommitCallbacks = assertPdfSerializedCommitCallbacks(
                commitCallbacks,
                'savePdfDataAs.commitCallbacks',
            );
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.savePdfDataAsBegin,
                checkedWorkingPath,
                checkedData.byteLength,
                checkedOptions,
                checkedSerializedSaveOptions,
            );
            if (!beginResult.sessionId) {
                return {
                    path: null,
                    validation: null,
                };
            }
            const streamingBeginResult = {
                ...beginResult,
                sessionId: beginResult.sessionId,
            };

            const stagedResult = await streamPdfBytesToPersistencePort(
                ipcRenderer,
                streamingBeginResult,
                iterateUint8ArrayChunks(checkedData),
                checkedData.byteLength,
            );
            return commitStagedPersistence(stagedResult, checkedCommitCallbacks);
        },
        savePdfDialog: (suggestedName) => invokeFiles(
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfDialog,
            suggestedName,
        ),
        saveDocxAs: (workingPath) => invokeFiles(
            DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.saveDocxAs,
            workingPath,
        ),
        readFile: (path) => invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readFile, path),
        statFile: (path) => invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.statFile, path),
        readFileRange: (path, offset, length) =>
            invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readFileRange, path, offset, length),
        createManagedTempFileHandle: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.createManagedTempFileHandle,
                assertAbsolutePath(path, 'createManagedTempFileHandle.path'),
            ),
        releaseManagedTempFileHandle: (leaseId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.releaseManagedTempFileHandle,
                assertNonEmptyString(leaseId, 'releaseManagedTempFileHandle.leaseId'),
            ),
        getPdfOpeningGeometry: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getPdfOpeningGeometry,
                assertAbsolutePath(path, 'getPdfOpeningGeometry.path'),
            ),
        getPdfNativePageSizes: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getPdfNativePageSizes,
                assertAbsolutePath(path, 'getPdfNativePageSizes.path'),
            ),
        cancelPdfNativePagePreview: (requestId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cancelPdfNativePagePreview,
                assertNonEmptyString(requestId, 'cancelPdfNativePagePreview.requestId'),
            ),
        renderPdfNativePagePreview: (path, pageNumber, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.renderPdfNativePagePreview,
                assertAbsolutePath(path, 'renderPdfNativePagePreview.path'),
                assertPositiveInteger(pageNumber, 'renderPdfNativePagePreview.pageNumber'),
                assertPdfNativePagePreviewOptions(options, 'renderPdfNativePagePreview.options'),
            ),
        beginPdfAnnotationIndex: (path, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.beginPdfAnnotationIndex,
                assertAbsolutePath(path, 'beginPdfAnnotationIndex.path'),
                assertPdfSerializedSaveOptions(options, 'beginPdfAnnotationIndex.options'),
            ),
        readPdfAnnotationIndexChunk: (sessionId, offset, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readPdfAnnotationIndexChunk,
                assertNonEmptyString(sessionId, 'readPdfAnnotationIndexChunk.sessionId'),
                assertPdfSidecarChunkOffset(offset, 'readPdfAnnotationIndexChunk.offset'),
                assertPdfIndexChunkOptions(options, 'readPdfAnnotationIndexChunk.options', PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES),
            ),
        releasePdfAnnotationIndex: (sessionId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.releasePdfAnnotationIndex,
                assertNonEmptyString(sessionId, 'releasePdfAnnotationIndex.sessionId'),
            ),
        cancelPdfAnnotationIndex: (sessionId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cancelPdfAnnotationIndex,
                assertNonEmptyString(sessionId, 'cancelPdfAnnotationIndex.sessionId'),
            ),
        beginPdfEmbeddedShapeIndex: (path, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.beginPdfEmbeddedShapeIndex,
                assertAbsolutePath(path, 'beginPdfEmbeddedShapeIndex.path'),
                assertPdfSerializedSaveOptions(options, 'beginPdfEmbeddedShapeIndex.options'),
            ),
        readPdfEmbeddedShapeIndexChunk: (sessionId, offset, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readPdfEmbeddedShapeIndexChunk,
                assertNonEmptyString(sessionId, 'readPdfEmbeddedShapeIndexChunk.sessionId'),
                assertPdfSidecarChunkOffset(offset, 'readPdfEmbeddedShapeIndexChunk.offset'),
                assertPdfIndexChunkOptions(options, 'readPdfEmbeddedShapeIndexChunk.options', PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES),
            ),
        releasePdfEmbeddedShapeIndex: (sessionId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.releasePdfEmbeddedShapeIndex,
                assertNonEmptyString(sessionId, 'releasePdfEmbeddedShapeIndex.sessionId'),
            ),
        cancelPdfEmbeddedShapeIndex: (sessionId) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cancelPdfEmbeddedShapeIndex,
                assertNonEmptyString(sessionId, 'cancelPdfEmbeddedShapeIndex.sessionId'),
            ),
        readFileChunks: async (path, options, onChunk) => {
            const checkedPath = assertAbsolutePath(path, 'readFileChunks.path');
            const chunkBytes = getChunkReadSize(options);
            const { size } = await invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.statFile, checkedPath);
            let bytesRead = 0;
            let chunks = 0;
            while (bytesRead < size) {
                throwIfAborted(options?.signal);
                const length = Math.min(chunkBytes, size - bytesRead);
                const chunk = await invokeFiles(
                    DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readFileRange,
                    checkedPath,
                    bytesRead,
                    length,
                );
                if (chunk.byteLength === 0) {
                    throw new Error(`Unexpected end of file after ${bytesRead} of ${size} bytes`);
                }
                if (chunk.byteLength > length) {
                    throw new Error(`Invalid file range response: received ${chunk.byteLength} bytes for a ${length}-byte request`);
                }
                await onChunk(chunk, bytesRead);
                bytesRead += chunk.byteLength;
                chunks += 1;
            }
            return {
                size,
                bytesRead,
                chunks,
            };
        },
        readTextFile: (path) => invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readTextFile, path),
        fileExists: (path) => invokeFiles(DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.fileExists, path),
        getDocumentRevision: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getDocumentRevision,
                assertAbsolutePath(path, 'getDocumentRevision.path'),
            ),
        getWorkingCopyBackingStatus: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getWorkingCopyBackingStatus,
                assertAbsolutePath(path, 'getWorkingCopyBackingStatus.path'),
            ),
        onDocumentRevisionChanged: (callback) => {
            return eventSubscriber.onDecodedPayload(
                DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onDocumentRevisionChanged,
                decodeDocumentRevisionChangedEvent,
                callback,
            );
        },
        onWorkingCopyBackingStatusChanged: (callback) => {
            return eventSubscriber.onDecodedPayload(
                DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onWorkingCopyBackingStatusChanged,
                decodeWorkingCopyBackingStatus,
                callback,
            );
        },
        onNativePrintDialogOpened: createNativePrintDialogOpenedSubscriber(ipcRenderer),
        analyzePdfConformance: (path, options) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.analyzePdfConformance,
                assertAbsolutePath(path, 'analyzePdfConformance.path'),
                options,
            ),
        validatePdfData: (data, fileName?: string) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.validatePdfData,
                assertWriteData(data, 'validatePdfData.data'),
                assertOptionalFileName(fileName, 'validatePdfData.fileName'),
            ),
        validatePdfPath: (path, options) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.validatePdfPath,
                assertAbsolutePath(path, 'validatePdfPath.path'),
                options,
            ),
        openPdfInDefaultAppData: (data, fileName?: string) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.openPdfInDefaultAppData,
                assertWriteData(data, 'openPdfInDefaultAppData.data'),
                assertOptionalFileName(fileName, 'openPdfInDefaultAppData.fileName'),
            ),
        openPdfInDefaultAppPath: (path, fileName?: string) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.openPdfInDefaultAppPath,
                assertAbsolutePath(path, 'openPdfInDefaultAppPath.path'),
                assertOptionalFileName(fileName, 'openPdfInDefaultAppPath.fileName'),
            ),
        printPdfData: (data, fileName?: string, options?: IPdfDataPrintOptions) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.printPdfData,
                assertWriteData(data, 'printPdfData.data'),
                assertOptionalFileName(fileName, 'printPdfData.fileName'),
                decodeOptionalPdfDataPrintOptions(options, 'printPdfData.options'),
            ),
        cancelPdfPrint: requestId => invokePdf(
            DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.cancelPdfPrint,
            assertNonEmptyString(requestId, 'cancelPdfPrint.requestId', 128),
        ),
        printPdfPath: (path, fileName?: string, options?: IPdfPathPrintOptions) =>
            invokePdf(
                DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.printPdfPath,
                assertAbsolutePath(path, 'printPdfPath.path'),
                assertOptionalFileName(fileName, 'printPdfPath.fileName'),
                decodeOptionalPdfPathPrintOptions(options, 'printPdfPath.options'),
            ),
        writeFile: (path, data, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.writeFile,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
                assertPdfSerializedSaveOptions(options, 'writeFile.options'),
            ),
        replaceWorkingCopyFromPath: (workingCopyPath, sourcePath, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.replaceWorkingCopyFromPath,
                assertAbsolutePath(workingCopyPath, 'replaceWorkingCopyFromPath.workingCopyPath'),
                assertAbsolutePath(sourcePath, 'replaceWorkingCopyFromPath.sourcePath'),
                assertPdfSerializedSaveOptions(options, 'replaceWorkingCopyFromPath.options'),
            ),
        writeDocxFile: (path, data) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.writeDocxFile,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName, data, originalPath?: string, password?: string) =>
            invokeWorkingCopy(
                DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                ...workingCopyPassword.appendWorkingCopyPassword(assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'), workingCopyPassword.assertOptionalPdfDecryptPassword(password)),
            ),
        createWorkingCopyFromPath: (sourcePath, originalPath?: string, password?: string) =>
            invokeWorkingCopy(
                DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                ...workingCopyPassword.appendWorkingCopyPassword(assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'), workingCopyPassword.assertOptionalPdfDecryptPassword(password)),
            ),
        saveFileStructured: (path, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.saveFileStructured,
                assertAbsolutePath(path, 'saveFileStructured.path'),
                assertPdfSerializedSaveOptions(options, 'saveFileStructured.options'),
            ),
        resyncWorkingCopy: (path) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.resyncWorkingCopy,
                assertAbsolutePath(path, 'resyncWorkingCopy.path'),
            ),
        repairPdf: (path, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.repairPdf,
                assertAbsolutePath(path, 'repairPdf.path'),
                assertPdfSerializedSaveOptions(options, 'repairPdf.options'),
            ),
        optimizePdfForInteraction: (path, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.optimizePdfForInteraction,
                assertAbsolutePath(path, 'optimizePdfForInteraction.path'),
                assertPdfSerializedSaveOptions(options, 'optimizePdfForInteraction.options'),
            ),
        optimizePdfAsCopy: (path, options, requestId, revisionOptions) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.optimizePdfAsCopy,
                assertAbsolutePath(path, 'optimizePdfAsCopy.path'),
                assertPdfOptimizeOptions(options, 'optimizePdfAsCopy.options'),
                typeof requestId === 'string'
                    ? assertNonEmptyString(requestId, 'optimizePdfAsCopy.requestId', 128)
                    : undefined,
                revisionOptions === undefined
                    ? undefined
                    : assertPdfSerializedSaveOptions(revisionOptions, 'optimizePdfAsCopy.revisionOptions'),
            ),
        savePdfData: async (path, data, options, commitCallbacks) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfData.path');
            const checkedData = assertPersistenceData(data, 'savePdfData.data');
            const checkedOptions = assertPdfSerializedSaveOptions(options, 'savePdfData.options');
            const checkedCommitCallbacks = assertPdfSerializedCommitCallbacks(
                commitCallbacks,
                'savePdfData.commitCallbacks',
            );
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedData.byteLength,
                checkedOptions,
            );
            const stagedResult = await streamPdfBytesToPersistencePort(
                ipcRenderer,
                beginResult,
                iterateUint8ArrayChunks(checkedData),
                checkedData.byteLength,
            );
            const result = await commitStagedPersistence(stagedResult, checkedCommitCallbacks);
            return result.validation;
        },
        savePdfDataChunks: async (path, totalBytes, chunks, options, commitCallbacks) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfDataChunks.path');
            const checkedTotalBytes = assertPositiveSafeInteger(totalBytes, 'savePdfDataChunks.totalBytes');
            const checkedOptions = assertPdfSerializedSaveOptions(options, 'savePdfDataChunks.options');
            const checkedCommitCallbacks = assertPdfSerializedCommitCallbacks(
                commitCallbacks,
                'savePdfDataChunks.commitCallbacks',
            );
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedTotalBytes,
                checkedOptions,
            );
            const stagedResult = await streamPdfBytesToPersistencePort(
                ipcRenderer,
                beginResult,
                chunks,
                checkedTotalBytes,
            );
            const result = await commitStagedPersistence(stagedResult, checkedCommitCallbacks);
            return result.validation;
        },
        savePdfNoteTextUpdates: (path, updates, modifiedAt, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNoteTextUpdates,
                assertAbsolutePath(path, 'savePdfNoteTextUpdates.path'),
                normalizePdfNativeNoteTextUpdates(updates, 'savePdfNoteTextUpdates.updates'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteTextUpdates.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNoteTextUpdates.options'),
            ),
        savePdfNoteChanges: (path, changes, modifiedAt, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNoteChanges,
                assertAbsolutePath(path, 'savePdfNoteChanges.path'),
                normalizePdfNativeNoteChanges(changes, 'savePdfNoteChanges.changes'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNoteChanges.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNoteChanges.options'),
            ),
        savePdfNativeMutations: (path, mutations, modifiedAt, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNativeMutations,
                assertAbsolutePath(path, 'savePdfNativeMutations.path'),
                normalizePdfNativeMutationSet(mutations, 'savePdfNativeMutations.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'savePdfNativeMutations.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'savePdfNativeMutations.options'),
            ),
        applyPdfNativeMutationsToWorkingCopy: (path, mutations, modifiedAt, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.applyPdfNativeMutationsToWorkingCopy,
                assertAbsolutePath(path, 'applyPdfNativeMutationsToWorkingCopy.path'),
                normalizePdfNativeMutationSet(mutations, 'applyPdfNativeMutationsToWorkingCopy.mutations'),
                normalizePdfNativeModifiedAt(modifiedAt, 'applyPdfNativeMutationsToWorkingCopy.modifiedAt'),
                assertPdfSerializedSaveOptions(options, 'applyPdfNativeMutationsToWorkingCopy.options'),
            ),
        commitStagedPdfNativeMutations: (path, stagedOutput, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.commitStagedPdfNativeMutations,
                assertAbsolutePath(path, 'commitStagedPdfNativeMutations.path'),
                stagedOutput,
                assertPdfNativeStagedCommitOptions(options, 'commitStagedPdfNativeMutations.options'),
            ),
        cloneStagedPdfNativeMutationToWorkingCopy: (stagedOutput, originalPath) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cloneStagedPdfNativeMutationToWorkingCopy,
                stagedOutput,
                assertOptionalAbsolutePath(originalPath, 'cloneStagedPdfNativeMutationToWorkingCopy.originalPath'),
            ),
        replaceWorkingCopyFromStagedPdfNativeMutation: (path, stagedOutput, options) =>
            invokeFiles(
                DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.replaceWorkingCopyFromStagedPdfNativeMutation,
                assertAbsolutePath(path, 'replaceWorkingCopyFromStagedPdfNativeMutation.path'),
                stagedOutput,
                assertPdfSerializedSaveOptions(options, 'replaceWorkingCopyFromStagedPdfNativeMutation.options'),
            ),
        cleanupFile: (path) => invokeWorkingCopy(
            DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.cleanupFile,
            path,
        ),
        cleanupOcrTemp: (path) => invokeWorkingCopy(
            DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.cleanupOcrTemp,
            path,
        ),
    };
}
