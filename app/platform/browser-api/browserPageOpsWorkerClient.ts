import type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
} from '@contracts/browserPageOpsWorker';
import {BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS} from '@contracts/browserPageOpsWorker';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
    BrowserWorkerResetError,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';
import { getErrorMessage } from '@app/utils/error';
import { captureRendererFailure } from '@app/utils/failureReporter';
import {yieldToBrowser} from '@app/platform/browser-api/browserYield';
import {tryRunBrowserPageOpsWithWasm} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import * as v from 'valibot';

const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;
// Desktop gives its native page tools two minutes (qpdf, native crop and
// mutation saves). The browser engine is that tool built for one wasm32
// thread and cannot report progress, and its parse time grows with its input,
// so a request nobody can cancel waits that long plus a second per MiB.
const DESKTOP_NATIVE_PAGE_OP_TIMEOUT_MS = 2 * 60 * 1000;
const ENGINE_DEADLINE_MS_PER_MIB = 1000;
const WORKER_INPUT_COPY_CHUNK_BYTES = 512 * 1024;

export {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';

function reportWorkerFailure(error: Error & {failure?: FailureReceipt}) {
    if (error.failure) {
        return error;
    }

    const receipt = captureRendererFailure({
        code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
        local: {
            source: 'browser-page-ops-worker-parent',
            message: error.message,
            cause: error,
        },
    });
    Object.defineProperty(error, 'failure', {
        configurable: true,
        value: receipt,
    });
    return error;
}

interface IBuildWorkerRequestWithTransfersOptions {
    preserveInputOwnership?: boolean;
    signal?: AbortSignal;
}

async function buildWorkerRequestWithTransfers(
    request: TBrowserPageOpsWorkerRequest,
    options: IBuildWorkerRequestWithTransfersOptions = {},
) {
    const toTransferableRequestData = async (data: Uint8Array) => {
        if (!options.preserveInputOwnership) return toTransferableUint8Array(data);
        const copy = new Uint8Array(data.byteLength);
        for (let offset = 0; offset < data.byteLength; offset += WORKER_INPUT_COPY_CHUNK_BYTES) {
            if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
            copy.set(data.subarray(offset, offset + WORKER_INPUT_COPY_CHUNK_BYTES), offset);
            await yieldToBrowser();
        }
        return copy;
    };
    const transfer: Transferable[] = [];
    if (request.type === 'textBoxAppearance') return {
        request,
        transfer,
    };
    if (request.type === 'insertPages') {
        const transferableData = await toTransferableRequestData(request.payload.data);
        const transferableInsertionData = await toTransferableRequestData(request.payload.insertionData);
        return {
            request: {
                ...request,
                payload: {
                    ...request.payload,
                    data: transferableData,
                    insertionData: transferableInsertionData,
                },
            },
            transfer: [
                transferableData.buffer,
                transferableInsertionData.buffer,
            ] satisfies Transferable[],
        };
    }

    if (request.type === 'mergePages') {
        const transferredBuffers = new Set<ArrayBuffer>();
        const documents: Uint8Array[] = [];
        for (const document of request.payload.documents) {
            let data = await toTransferableRequestData(document);
            if (transferredBuffers.has(data.buffer)) {
                data = data.slice();
            }
            transferredBuffers.add(data.buffer);
            transfer.push(data.buffer);
            documents.push(data);
        }
        return {
            request: {
                ...request,
                payload: {documents},
            },
            transfer,
        };
    }

    if (request.type === 'ocrTextLayer') {
        const data = await toTransferableRequestData(request.payload.data);
        const pagePdfs: Uint8Array[] = [];
        for (const page of request.payload.pagePdfs) {
            const transferablePage = await toTransferableRequestData(page);
            transfer.push(transferablePage.buffer);
            pagePdfs.push(transferablePage);
        }
        transfer.push(data.buffer);
        return {
            request: {
                ...request,
                payload: {
                    ...request.payload,
                    data,
                    pagePdfs,
                },
            },
            transfer,
        };
    }

    const transferableData = await toTransferableRequestData(request.payload.data);
    transfer.push(transferableData.buffer);
    let originalAppearanceSourceData: Uint8Array<ArrayBuffer> | undefined;
    if (request.type === 'saveMutations' && request.payload.originalAppearanceSourceData) {
        originalAppearanceSourceData = await toTransferableRequestData(request.payload.originalAppearanceSourceData);
        if (originalAppearanceSourceData.buffer === transferableData.buffer) originalAppearanceSourceData = originalAppearanceSourceData.slice();
        transfer.push(originalAppearanceSourceData.buffer);
    }
    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                data: transferableData,
                ...(originalAppearanceSourceData ? {originalAppearanceSourceData} : {}),
            },
        },
        transfer,
    };
}


/**
 * A request whose caller holds an abort signal has no deadline: its owner
 * stops it, and stopping it ends the worker. Others get the size-scaled one.
 */
function getEngineDeadlineMs(payload: object, signal: AbortSignal | undefined) {
    if (signal) return undefined;
    let inputBytes = 0;
    for (const value of Object.values(payload)) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (item instanceof Uint8Array) inputBytes += item.byteLength;
        }
    }
    return DESKTOP_NATIVE_PAGE_OP_TIMEOUT_MS + Math.ceil(inputBytes / (1024 * 1024)) * ENGINE_DEADLINE_MS_PER_MIB;
}

export function canUseBrowserPageOpsWorker() {
    return canUseBrowserWorker();
}

function createBrowserPageOpsWorkerClient() {
    return new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
        idleTtlMs: BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS,
        createWorker: () => {
            try {
                return new Worker(
                    new URL('./browserPageOps.worker.ts', import.meta.url),
                    { type: 'module' },
                );
            } catch (error) {
                throw reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
                    getErrorMessage(error),
                ));
            }
        },
        createError: event => reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
            event.error instanceof Error ? event.error.message : event.message,
        )),
        handleMessage: settleBrowserWorkerResult,
    });
}

const browserPageOpsWorkerClient = createBrowserPageOpsWorkerClient();
// Two reusable workers admit isolated and CPU-bound operations; eight more may wait.
const pageOpsWorkerOwner = new BrowserWorkerRequestOwner(createBrowserPageOpsWorkerClient, 2);

async function runAdmittedPageOperation<TResult>(
    signal: AbortSignal | undefined,
    run: (client: BrowserWorkerClient<IPendingBrowserWorkerRequest>, requestId: number, yieldAdmitted: () => Promise<void>) => Promise<TResult>,
) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    if (pageOpsWorkerOwner.waitingCount >= 8) {
        throw new BrowserPageOpsWorkerUnavailableError('Browser annotation parse worker queue is full');
    }
    const requestId = pageOpsWorkerOwner.createRequestId();
    const abort = () => pageOpsWorkerOwner.cancel(requestId, abortErrorFromSignal(signal!));
    signal?.addEventListener('abort', abort, {once: true});
    try {
        // An operation aborted or reset during a yield starts no more work.
        return await pageOpsWorkerOwner.run(requestId, (client, isAdmitted) => run(client, requestId, async () => {
            await yieldToBrowser();
            if (signal?.aborted) {
                throw abortErrorFromSignal(signal);
            }
            if (!isAdmitted()) {
                throw new BrowserWorkerResetError();
            }
        }));
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

interface IRunBrowserPageOpsWorkerRequestOptions {
    signal?: AbortSignal;
    dedicated?: boolean;
    // A dedicated request copies its input so the caller keeps it; a caller
    // that reads its input again after a failure transfers it instead.
    transferInput?: boolean;
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Browser page operation request was aborted');
}

async function runBrowserPageOpsWorkerRequestWithClient<K extends TBrowserPageOpsWorkerRequestType>(
    client: BrowserWorkerClient<IPendingBrowserWorkerRequest>,
    requestId: number,
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: {
        signal?: AbortSignal;
        preserveInputOwnership?: boolean;
    } = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const request: IBrowserPageOpsWorkerRequest<K> = {
        id: requestId,
        type,
        payload,
    } as IBrowserPageOpsWorkerRequest<K>;

    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const worker = client.getWorker();

    const deadlineMs = getEngineDeadlineMs(payload, options.signal);
    return new Promise<IBrowserPageOpsWorkerResultMap[K]>((resolve, reject) => {
        let removeAbortListener: () => void = () => undefined;
        let settled = false;
        const finish = () => {
            if (settled) {
                return false;
            }
            settled = true;
            removeAbortListener();
            return true;
        };
        const rejectRequest = (error: Error) => {
            if (!finish()) {
                return;
            }
            reject(error);
        };
        client.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (value) => {
                if (settled) {
                    return false;
                }
                const decoded = v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS[type], value, {abortEarly: true});
                if (!decoded.success) {
                    return false;
                }
                finish();
                resolve(decoded.output as IBrowserPageOpsWorkerResultMap[K]);
                return true;
            },
            reject: error => rejectRequest(reportWorkerFailure(error)),
        }, () => reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
            `Browser page operation worker request timed out after ${String(deadlineMs)}ms`,
        )), deadlineMs);

        if (options.signal) {
            const handleAbort = () => client.cancelPendingRequest(
                request.id,
                abortErrorFromSignal(options.signal!),
                {resetWorker: true},
            );
            options.signal.addEventListener('abort', handleAbort, {once: true});
            removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
            if (options.signal.aborted) {
                handleAbort();
                return;
            }
        }

        void buildWorkerRequestWithTransfers(request, options).then((workerRequest) => {
            if (!settled) worker.postMessage(workerRequest.request, workerRequest.transfer);
        }).catch((error: unknown) => {
            if (settled) return;
            client.cancelPendingRequest(
                request.id,
                reportWorkerFailure(error instanceof Error ? error : new Error(String(error))),
            );
        });
    });
}

function isCpuPageOperation(type: TBrowserPageOpsWorkerRequestType) {
    return type === 'textBoxAppearance' || type === 'saveMutations' || type === 'decrypt' || type === 'printLayout'
        || type === 'ocrTextLayer' || type === 'ocrTextVisibility' || type === 'splitPages'
        || type === 'overlayText' || type === 'recompressImages' || type === 'replacePageImages';
}

async function runBrowserPageOpsWithoutWorker<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    yieldAdmitted: () => Promise<void>,
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    if (type === 'textBoxAppearance') {
        throw new BrowserPageOpsWorkerUnavailableError('Text appearance generation requires a worker');
    }
    // Without a worker the engine runs on this thread as one long task, with
    // the same request ceiling as the worker.
    const result = await tryRunBrowserPageOpsWithWasm(type, payload, yieldAdmitted);
    await yieldAdmitted();
    return result as IBrowserPageOpsWorkerResultMap[K];
}

function runAdmittedBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    signal?: AbortSignal,
    transferInput = false,
) {
    return runAdmittedPageOperation(signal, async (client, requestId, yieldAdmitted) => {
        if (isCpuPageOperation(type)) {
            // Worker startup and the ownership-preserving copy must not extend
            // the input event's task. Use the same scheduler as the fallback.
            await yieldAdmitted();
            try {
                client.getWorker();
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                    throw error;
                }
                return runBrowserPageOpsWithoutWorker(type, payload, yieldAdmitted);
            }
            await yieldAdmitted();
        }
        return runBrowserPageOpsWorkerRequestWithClient(client, requestId, type, payload, {
            ...(signal ? {signal} : {}),
            preserveInputOwnership: !transferInput,
        });
    });
}

export async function runBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: IRunBrowserPageOpsWorkerRequestOptions = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    if (isCpuPageOperation(type)) {
        if (canUseBrowserPageOpsWorker()) {
            return runAdmittedBrowserPageOpsWorkerRequest(type, payload, options.signal);
        }
        return runAdmittedPageOperation(options.signal, (_client, _requestId, yieldAdmitted) => (
            runBrowserPageOpsWithoutWorker(type, payload, yieldAdmitted)
        ));
    }
    if (options.dedicated) {
        return runAdmittedBrowserPageOpsWorkerRequest(type, payload, options.signal, options.transferInput);
    }

    return runBrowserPageOpsWorkerRequestWithClient(
        browserPageOpsWorkerClient,
        browserPageOpsWorkerClient.createRequestId(),
        type,
        payload,
        options.signal ? {signal: options.signal} : {},
    );
}
