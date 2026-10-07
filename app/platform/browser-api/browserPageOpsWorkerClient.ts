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
import {browserAnnotationParseIsolation} from '@app/platform/browser-api/browserAnnotationParseIsolation';
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

interface IBuildWorkerRequestWithTransfersOptions {preserveInputOwnership?: boolean;}

function buildWorkerRequestWithTransfers(
    request: TBrowserPageOpsWorkerRequest,
    options: IBuildWorkerRequestWithTransfersOptions = {},
) {
    const toTransferableRequestData = (data: Uint8Array) => options.preserveInputOwnership
        ? toTransferableUint8Array(data.slice())
        : toTransferableUint8Array(data);
    const transfer: Transferable[] = [];
    if (request.type === 'insertPages') {
        const transferableData = toTransferableRequestData(request.payload.data);
        const transferableInsertionData = toTransferableRequestData(request.payload.insertionData);
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
        const documents = request.payload.documents.map((document) => {
            let data = toTransferableRequestData(document);
            if (transferredBuffers.has(data.buffer)) {
                data = data.slice();
            }
            transferredBuffers.add(data.buffer);
            transfer.push(data.buffer);
            return data;
        });
        return {
            request: {
                ...request,
                payload: {documents},
            },
            transfer,
        };
    }

    const transferableData = toTransferableRequestData(request.payload.data);
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
        disposeWorkerOnSettlement?: boolean;
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
            if (options.disposeWorkerOnSettlement) {
                client.resetWorker();
            }
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

        try {
            const workerRequest = buildWorkerRequestWithTransfers(
                request,
                options.preserveInputOwnership === undefined
                    ? {}
                    : {preserveInputOwnership: options.preserveInputOwnership},
            );
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            client.cancelPendingRequest(
                request.id,
                reportWorkerFailure(error instanceof Error ? error : new Error(String(error))),
            );
        }
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

async function runDedicatedBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    signal?: AbortSignal,
) {
    const releaseAdmission = await browserAnnotationParseIsolation.acquire(signal);
    const client = createBrowserPageOpsWorkerClient();
    try {
        if (isCpuPageOperation(type)) {
            try {
                client.getWorker();
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError) || signal?.aborted) {
                    throw error;
                }
                return await runBrowserPageOpsWithoutWorker(type, payload, signal);
            }
        }
        return await runBrowserPageOpsWorkerRequestWithClient(client, type, payload, {
            ...(signal ? {signal} : {}),
            preserveInputOwnership: true,
            disposeWorkerOnSettlement: true,
        });
    } finally {
        client.resetWorker();
        releaseAdmission();
    }
}

export async function runBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: IRunBrowserPageOpsWorkerRequestOptions = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    if (isCpuPageOperation(type)) {
        if (canUseBrowserPageOpsWorker()) {
            return runDedicatedBrowserPageOpsWorkerRequest(type, payload, options.signal);
        }
        const releaseAdmission = await browserAnnotationParseIsolation.acquire(options.signal);
        try {
            return await runBrowserPageOpsWithoutWorker(type, payload, options.signal);
        } finally {
            releaseAdmission();
        }
    }
    if (options.dedicated) {
        return runDedicatedBrowserPageOpsWorkerRequest(type, payload, options.signal);
    }

    return runBrowserPageOpsWorkerRequestWithClient(
        browserPageOpsWorkerClient,
        type,
        payload,
        options.signal ? {signal: options.signal} : {},
    );
}
