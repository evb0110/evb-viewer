import type { IpcRenderer } from 'electron';
import type {IPdfValidationResult} from '@contracts/pdfConformance';
import type {IPdfSerializedCommitCallbacks} from '@contracts/electronApiDocuments';
import {requireSessionId} from '@contracts/shared';
import {
    DOCX_EXPORT_STREAM_CHANNELS,
    DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES,
    type IDocxExportFileCapability,
    type IDocxExportStreamBeginResult,
} from '@contracts/docxExport';
import { isRecord } from '@contracts/runtimeGuards';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS,
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
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createCodecIpcInvoker} from '@electron/preload/ipcClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import {
    assertAbsolutePath,
    assertPdfSerializedSaveOptions,
} from '@electron/features/documents/preloadShared';

// The documents methods that are not plain invokes: savePdfData streams bytes
// over a MessagePort and runs renderer callbacks before its commit, and DOCX
// export streams chunks. Every other documents method comes from the generic
// platform-feature client.

const PDF_PERSISTENCE_CHUNK_BYTES = PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES;
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS;
const PDF_PERSISTENCE_PROGRESS_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_PROGRESS_TIMEOUT_MS;
const PDF_PERSISTENCE_RESULT_TIMEOUT_MS = PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS;
const LONG_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1000;
interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: IPdfValidationResult;
    staged?: {
        sessionId: string;
        stagedOutput: ITypedStagedArtifact;
    };
}

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

function assertPersistenceData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    return value;
}
function createDocxExportFileCapability(
    ipcRenderer: Pick<IpcRenderer, 'invoke'>,
): IDocxExportFileCapability {
    const invoke = async <TResult>(channel: string, ...args: unknown[]) => await ipcRenderer.invoke(channel, ...args) as TResult;
    const beginDocxFileStream = (path: Parameters<IDocxExportFileCapability['beginDocxFileStream']>[0]) => invoke<IDocxExportStreamBeginResult>(DOCX_EXPORT_STREAM_CHANNELS.begin, assertAbsolutePath(path, 'beginDocxFileStream.path'));
    const writeDocxFileStreamChunk = (sessionId: Parameters<IDocxExportFileCapability['writeDocxFileStreamChunk']>[0], chunk: Parameters<IDocxExportFileCapability['writeDocxFileStreamChunk']>[1]) => {
        const checkedSessionId = requireSessionId(sessionId);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new Error('writeDocxFileStreamChunk.chunk must be a non-empty Uint8Array');
        }
        if (chunk.byteLength > DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES) {
            throw new Error(`writeDocxFileStreamChunk chunk exceeds maximum size (${DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES} bytes)`);
        }
        return invoke<boolean>(DOCX_EXPORT_STREAM_CHANNELS.writeChunk, checkedSessionId, Uint8Array.from(chunk));
    };
    const commitDocxFileStream = (sessionId: Parameters<IDocxExportFileCapability['commitDocxFileStream']>[0]) => invoke<boolean>(DOCX_EXPORT_STREAM_CHANNELS.commit, requireSessionId(sessionId));
    const cancelDocxFileStream = (sessionId: Parameters<IDocxExportFileCapability['cancelDocxFileStream']>[0]) => invoke<boolean>(DOCX_EXPORT_STREAM_CHANNELS.cancel, requireSessionId(sessionId));
    return {
        beginDocxFileStream,
        writeDocxFileStreamChunk,
        commitDocxFileStream,
        cancelDocxFileStream,
    };
}

function getTightTransferChunk(chunk: Uint8Array, fieldName: string) {
    const checkedChunk = assertPersistenceData(chunk, fieldName);
    return checkedChunk.byteOffset === 0 && checkedChunk.byteLength === checkedChunk.buffer.byteLength
        ? checkedChunk
        : checkedChunk.slice();
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
            progressTimeoutMs: PDF_PERSISTENCE_PROGRESS_TIMEOUT_MS,
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
    private rejectAbort!: (error: unknown) => void;
    private readonly abortPromise: Promise<never>;
    private result: IPersistencePortDeferred<ISerializedPdfPersistencePortResult> | null = null;
    private progressTimer: ReturnType<typeof setTimeout>;
    private aborted = false;

    public constructor(
        private readonly port: MessagePort,
        private readonly limits: ReturnType<typeof assertPersistenceProtocolLimits>,
    ) {
        this.abortPromise = new Promise<never>((_resolve, reject) => {
            this.rejectAbort = reject;
        });
        void this.abortPromise.catch(() => undefined);
        this.ready = this.createDeferred<undefined>(
            PDF_PERSISTENCE_READY_TIMEOUT_MS,
            'PDF persistence port did not become ready',
        );
        this.progressTimer = setTimeout(() => {
            this.abort(new Error('PDF persistence stream made no progress'));
        }, limits.progressTimeoutMs);
        port.addEventListener('message', this.handleMessage);
    }

    public waitUntilReady() {
        return this.ready.promise;
    }

    public waitForAbort() {
        return this.abortPromise;
    }

    public waitForAcknowledgement(seq: number) {
        if (this.aborted) {
            const promise = Promise.reject(new Error('PDF persistence port lifecycle was aborted'));
            void promise.catch(() => undefined);
            this.trackedPromises.push(promise);
            return promise;
        }
        const acknowledgement = this.createDeferred<undefined>(
            this.limits.ackTimeoutMs,
            `PDF persistence chunk ${seq} was not acknowledged`,
        );
        this.acknowledgements.set(seq, acknowledgement);
        return acknowledgement.promise;
    }

    public waitForResult() {
        if (this.result === null) {
            throw new Error('PDF persistence final-result phase has not started');
        }
        return this.result.promise;
    }

    public noteProgress() {
        if (this.aborted || this.result !== null) {
            return;
        }
        clearTimeout(this.progressTimer);
        this.progressTimer = setTimeout(() => {
            this.abort(new Error('PDF persistence stream made no progress'));
        }, this.limits.progressTimeoutMs);
    }

    public beginFinalResultWait() {
        if (this.result !== null || this.aborted) {
            return;
        }
        clearTimeout(this.progressTimer);
        this.result = this.createDeferred<ISerializedPdfPersistencePortResult>(
            this.limits.resultTimeoutMs,
            'PDF persistence port did not return a final result',
        );
    }

    public abort(error: unknown) {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.port.removeEventListener('message', this.handleMessage);
        this.rejectAbort(error);
        this.rejectDeferred(this.ready, error);
        clearTimeout(this.progressTimer);
        if (this.result !== null) {
            this.rejectDeferred(this.result, error);
        }
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
            const wasSettled = this.ready.settled;
            this.resolveDeferred(this.ready, undefined);
            if (!wasSettled) {
                this.noteProgress();
            }
            return;
        }
        if (payload.type === 'ack') {
            const acknowledgement = this.acknowledgements.get(payload.seq);
            if (acknowledgement) {
                this.acknowledgements.delete(payload.seq);
                this.resolveDeferred(acknowledgement, undefined);
                this.noteProgress();
            }
            return;
        }
        if (payload.type === 'result') {
            if (this.result === null) {
                return;
            }
            this.resolveDeferred(this.result, {
                path: payload.path,
                validation: payload.validation,
            });
            return;
        }
        if (payload.type === 'staged') {
            if (this.result === null) {
                return;
            }
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
    chunks: Iterable<Uint8Array>,
    expectedTotalBytes: number,
) {
    const limits = assertPersistenceProtocolLimits(beginResult);
    const channel = new MessageChannel();
    channel.port1.start();
    const lifecycle = new PdfPersistencePortLifecycle(channel.port1, limits);
    let portTransferred = false;
    let chunkIterator: Iterator<Uint8Array> | undefined;
    let sourceExhausted = false;
    try {
        ipcRenderer.postMessage(DOCUMENTS_CHANNELS.fileSavePdfDataPort, beginResult.sessionId, [channel.port2]);
        portTransferred = true;
        await lifecycle.waitUntilReady();

        chunkIterator = chunks[Symbol.iterator]();
        let seq = 0;
        let bytesWritten = 0;
        const inFlightAcks: Array<Promise<void>> = [];
        while (true) {
            const nextChunk = await Promise.race([
                Promise.resolve(chunkIterator.next()),
                lifecycle.waitForAbort(),
            ]);
            if (nextChunk.done) {
                sourceExhausted = true;
                break;
            }
            const chunk = nextChunk.value;
            const bytes = getTightTransferChunk(chunk, `savePdfData.chunks[${seq}]`);
            bytesWritten += bytes.byteLength;
            if (bytes.byteLength > limits.maxChunkBytes || bytesWritten > expectedTotalBytes) {
                throw new Error('savePdfData chunks exceed the negotiated PDF persistence size');
            }
            // Electron's main-process MessagePort only transfers ports here; transferring the
            // ArrayBuffer drops the structured-clone payload before MessagePortMain receives it.
            lifecycle.noteProgress();
            const acknowledgement = lifecycle.waitForAcknowledgement(seq);
            channel.port1.postMessage(createPdfPersistenceChunkFrame(seq, bytes));
            inFlightAcks.push(acknowledgement);
            if (inFlightAcks.length >= limits.maxInFlightChunks) {
                await inFlightAcks.shift();
            }
            seq += 1;
        }
        if (bytesWritten !== expectedTotalBytes) {
            throw new Error('savePdfData chunks did not match the negotiated PDF persistence size');
        }
        await Promise.all(inFlightAcks);

        channel.port1.postMessage(createPdfPersistenceCompleteFrame());
        lifecycle.beginFinalResultWait();
        return await lifecycle.waitForResult();
    } catch (error) {
        if (portTransferred) {
            tryPostPdfPersistenceCancel(channel.port1);
        }
        lifecycle.abort(error);
        throw error;
    } finally {
        if (!sourceExhausted) {
            chunkIterator?.return?.();
        }
        lifecycle.abort(new Error('PDF persistence port lifecycle closed'));
        await lifecycle.drain();
        channel.port1.close();
    }
}

export function createDocumentsPreloadStreams(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'postMessage' | 'send'>,
) {
    const invoke = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS, {invokeTimeoutMsByChannel: {[DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: LONG_NATIVE_IPC_TIMEOUT_MS}});
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
                requireSessionId(staged.sessionId),
                staged.stagedOutput,
            );
        } catch (error) {
            await invoke(
                DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf,
                requireSessionId(staged.sessionId),
                staged.stagedOutput,
            ).catch(() => false);
            throw error;
        }
    };
    return {
        ...createDocxExportFileCapability(ipcRenderer),
        savePdfData: async (
            path: string,
            data: Uint8Array,
            options?: unknown,
            commitCallbacks?: IPdfSerializedCommitCallbacks,
        ) => {
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
    };
}
