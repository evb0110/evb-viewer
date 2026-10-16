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
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';
import { getErrorMessage } from '@app/utils/error';
import { captureRendererFailure } from '@app/utils/failureReporter';
import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';
import {yieldToBrowser} from '@app/platform/browser-api/browserYield';
import {tryRunBrowserPageOpsWithWasm} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import * as v from 'valibot';

const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS = 90_000;
const WORKER_INPUT_COPY_CHUNK_BYTES = 512 * 1024;

export {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';

interface IBrowserPageOpsWorkerFailure extends Error {failure?: FailureReceipt;}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IBrowserPageOpsWorkerFailure).failure;
}

function reportWorkerFailure(error: Error) {
    const existingReceipt = getWorkerFailureReceipt(error);
    if (existingReceipt) {
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

    const transferableData = await toTransferableRequestData(request.payload.data);
    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                data: transferableData,
            },
        },
        transfer: [transferableData.buffer] satisfies Transferable[],
    };
}


export function canUseBrowserPageOpsWorker() {
    return canUseBrowserWorker();
}

function createBrowserPageOpsWorkerClient() {
    return new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
        idleTtlMs: BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS,
        requestTimeoutMs: BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS,
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

interface IPageOpsWorkerLease {
    client: BrowserWorkerClient<IPendingBrowserWorkerRequest>;
    release: () => void;
}

interface IPageOpsWorkerWaiter {
    resolve: (lease: IPageOpsWorkerLease) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
}

// A free client is the admission slot. Reuse the most recently used worker;
// BrowserWorkerClient owns its existing idle, failure and cancellation cleanup.
const freePageOpsWorkerClients = [
    createBrowserPageOpsWorkerClient(),
    createBrowserPageOpsWorkerClient(),
];
const pageOpsWorkerWaiters: IPageOpsWorkerWaiter[] = [];

function leasePageOpsWorker(client: BrowserWorkerClient<IPendingBrowserWorkerRequest>): IPageOpsWorkerLease {
    return {
        client,
        release: () => {
            for (let waiter = pageOpsWorkerWaiters.shift(); waiter; waiter = pageOpsWorkerWaiters.shift()) {
                if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
                if (waiter.signal?.aborted) {
                    waiter.reject(abortErrorFromSignal(waiter.signal));
                    continue;
                }
                waiter.resolve(leasePageOpsWorker(client));
                return;
            }
            freePageOpsWorkerClients.push(client);
        },
    };
}

function acquirePageOpsWorker(signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal));
    const client = freePageOpsWorkerClients.pop();
    if (client) return Promise.resolve(leasePageOpsWorker(client));
    if (pageOpsWorkerWaiters.length >= 8) return Promise.reject(new BrowserPageOpsWorkerUnavailableError('Browser annotation parse worker queue is full'));
    return new Promise<IPageOpsWorkerLease>((resolve, reject) => {
        const waiter: IPageOpsWorkerWaiter = {
            resolve,
            reject,
            ...(signal ? {signal} : {}),
        };
        if (signal) {
            waiter.abort = () => {
                const index = pageOpsWorkerWaiters.indexOf(waiter);
                if (index < 0) return;
                pageOpsWorkerWaiters.splice(index, 1);
                reject(abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', waiter.abort, {once: true});
        }
        pageOpsWorkerWaiters.push(waiter);
    });
}


interface IRunBrowserPageOpsWorkerRequestOptions {
    signal?: AbortSignal;
    dedicated?: boolean;
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Browser page operation request was aborted');
}

async function runBrowserPageOpsWorkerRequestWithClient<K extends TBrowserPageOpsWorkerRequestType>(
    client: BrowserWorkerClient<IPendingBrowserWorkerRequest>,
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: {
        signal?: AbortSignal;
        preserveInputOwnership?: boolean;
    } = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const request: IBrowserPageOpsWorkerRequest<K> = {
        id: client.createRequestId(),
        type,
        payload,
    } as IBrowserPageOpsWorkerRequest<K>;

    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const worker = client.getWorker();

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
            `Browser page operation worker request timed out after ${BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS}ms`,
        )));

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
    return type === 'saveMutations' || type === 'decrypt' || type === 'printLayout';
}

async function runBrowserPageOpsWithoutWorker<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    signal?: AbortSignal,
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const data = (payload as IBrowserPageOpsWorkerRequestMap['decrypt']).data;
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    if (data.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
        throw new BrowserPageOpsWorkerUnavailableError('Browser page operation exceeds the direct fallback byte budget');
    }
    await yieldToBrowser();
    const result = await tryRunBrowserPageOpsWithWasm(type, payload);
    await yieldToBrowser();
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    return result as IBrowserPageOpsWorkerResultMap[K];
}

async function runAdmittedBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    signal?: AbortSignal,
) {
    const {
        client, release,
    } = await acquirePageOpsWorker(signal);
    try {
        if (isCpuPageOperation(type)) {
            // Worker startup and the ownership-preserving copy must not extend
            // the input event's task. Use the same scheduler as the fallback.
            await yieldToBrowser();
            try {
                client.getWorker();
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError) || signal?.aborted) {
                    throw error;
                }
                return await runBrowserPageOpsWithoutWorker(type, payload, signal);
            }
            await yieldToBrowser();
        }
        return await runBrowserPageOpsWorkerRequestWithClient(client, type, payload, {
            ...(signal ? {signal} : {}),
            preserveInputOwnership: true,
        });
    } finally {
        release();
    }
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
        const {release} = await acquirePageOpsWorker(options.signal);
        try {
            return await runBrowserPageOpsWithoutWorker(type, payload, options.signal);
        } finally {
            release();
        }
    }
    if (options.dedicated) {
        return runAdmittedBrowserPageOpsWorkerRequest(type, payload, options.signal);
    }

    return runBrowserPageOpsWorkerRequestWithClient(
        browserPageOpsWorkerClient,
        type,
        payload,
        options.signal ? {signal: options.signal} : {},
    );
}
