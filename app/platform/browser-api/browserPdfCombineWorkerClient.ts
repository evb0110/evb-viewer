import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequest,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
} from '@contracts/browserPdfCombineWorker';
import {BROWSER_PDF_COMBINE_WORKER_RESULT_SCHEMAS} from '@contracts/browserPdfCombineWorker';
import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import {isPdfCombineOutputTooLargeError} from '@contracts/pdfCombineOutputPolicy';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';
import { captureRendererFailure } from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import * as v from 'valibot';

const BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS = 15_000;
// Desktop's native image combiner gets five minutes. The browser build runs
// it on one wasm32 thread without progress reports, so a combine nobody can
// cancel waits that long plus a second per MiB of input; one with an abort
// signal has no deadline, since canceling it ends the worker.
const DESKTOP_NATIVE_IMAGE_COMBINE_TIMEOUT_MS = 5 * 60 * 1000;
const ENGINE_DEADLINE_MS_PER_MIB = 1000;

function getCombineDeadlineMs(payload: IBrowserPdfCombineWorkerRequestMap[TBrowserPdfCombineWorkerRequestType], signal: AbortSignal | undefined) {
    if (signal) return undefined;
    const specInputs = payload.wasmImagePreprocessing?.pageSpecs?.flatMap(spec => [
        spec.image,
        spec.background,
        spec.mask,
    ]) ?? [];
    const inputBytes = [
        ...payload.inputs,
        ...specInputs,
    ].reduce((total, input) => total + (input?.data.byteLength ?? 0), 0);
    return DESKTOP_NATIVE_IMAGE_COMBINE_TIMEOUT_MS + Math.ceil(inputBytes / (1024 * 1024)) * ENGINE_DEADLINE_MS_PER_MIB;
}

export class BrowserPdfCombineWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPdfCombineWorkerUnavailableError';
    }
}

interface IBrowserPdfCombineWorkerFailure extends Error {failure?: FailureReceipt;}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IBrowserPdfCombineWorkerFailure).failure;
}

function isExpectedWorkerFailure(error: Error) {
    return error.name === 'AbortError'
        || isPdfCombineOutputTooLargeError(error)
        || error.message === 'ERR_BROWSER_PDF_COMBINE_WASM_UNAVAILABLE'
        || error.message === 'ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT';
}

function reportWorkerFailure(error: Error) {
    if (isExpectedWorkerFailure(error)) {
        return error;
    }
    const existingReceipt = getWorkerFailureReceipt(error);
    if (existingReceipt) {
        return error;
    }

    const receipt = captureRendererFailure({
        code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED',
        local: {
            source: 'browser-pdf-combine-worker-parent',
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

function buildWorkerRequestWithTransfers(
    request: TBrowserPdfCombineWorkerRequest,
) {
    const transfer: Transferable[] = [];
    const transferredBuffers = new Set<ArrayBuffer>();
    const cloneInput = (input: IBrowserPdfCombineInput) => {
        let data = toTransferableUint8Array(input.data);
        if (transferredBuffers.has(data.buffer)) {
            data = data.slice();
        }
        transferredBuffers.add(data.buffer);
        const cloned = {
            ...input,
            data,
        };
        transfer.push(cloned.data.buffer);
        return cloned;
    };
    const inputs = request.payload.inputs.map((input) => ({...cloneInput(input)}));
    const preprocessing = request.payload.wasmImagePreprocessing;
    const wasmImagePreprocessing = preprocessing?.pageSpecs
        ? {
            ...preprocessing,
            pageSpecs: preprocessing.pageSpecs.map(spec => ({
                ...spec,
                ...(spec.image ? {image: cloneInput(spec.image)} : {}),
                ...(spec.background ? {background: cloneInput(spec.background)} : {}),
                ...(spec.mask ? {mask: cloneInput(spec.mask)} : {}),
            })),
        }
        : preprocessing;

    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                inputs,
                ...(wasmImagePreprocessing ? {wasmImagePreprocessing} : {}),
            },
        },
        transfer,
    };
}

export function canUseBrowserPdfCombineWorker() {
    return canUseBrowserWorker();
}

function createBrowserPdfCombineWorkerClient() {
    return new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
        idleTtlMs: BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS,
        createWorker: () => {
            try {
                return new Worker(
                    new URL('./browserPdfCombine.worker.ts', import.meta.url),
                    { type: 'module' },
                );
            } catch (error) {
                throw reportWorkerFailure(new BrowserPdfCombineWorkerUnavailableError(
                    getErrorMessage(error),
                ));
            }
        },
        createError: event => reportWorkerFailure(new BrowserPdfCombineWorkerUnavailableError(
            event.error instanceof Error ? getErrorMessage(event.error) : event.message,
        )),
        handleMessage: (pendingRequests, response, onSettled) => settleBrowserWorkerResult(
            pendingRequests,
            response,
            onSettled,
            isNativeErrorEnvelope,
        ),
    });
}

const browserPdfCombineWorkerOwner = new BrowserWorkerRequestOwner(createBrowserPdfCombineWorkerClient);

export async function runBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType>(
    type: K,
    payload: IBrowserPdfCombineWorkerRequestMap[K],
    signal?: AbortSignal,
    options: {timeoutMs?: number} = {},
): Promise<IBrowserPdfCombineWorkerResultMap[K]> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
    const request: IBrowserPdfCombineWorkerRequest<K> = {
        id: browserPdfCombineWorkerOwner.createRequestId(),
        type,
        payload,
    } as IBrowserPdfCombineWorkerRequest<K>;

    const abort = () => browserPdfCombineWorkerOwner.cancel(
        request.id,
        signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError'),
    );
    signal?.addEventListener('abort', abort, {once: true});
    const deadlineMs = options.timeoutMs ?? getCombineDeadlineMs(payload, signal);
    try {
        return await browserPdfCombineWorkerOwner.run(request.id, client => {
            const worker = client.getWorker();
            return new Promise<IBrowserPdfCombineWorkerResultMap[K]>((resolve, reject) => {
                client.registerPendingRequest(request.id, {
                    requestType: type,
                    resolveData: (value) => {
                        const result = v.safeParse(BROWSER_PDF_COMBINE_WORKER_RESULT_SCHEMAS[type], {data: value}, {abortEarly: true});
                        if (!result.success) return false;
                        resolve(result.output);
                        return true;
                    },
                    reject: error => reject(reportWorkerFailure(error)),
                }, () => reportWorkerFailure(new BrowserPdfCombineWorkerUnavailableError(
                    `Browser PDF combine worker request timed out after ${String(deadlineMs)}ms`,
                )), deadlineMs);
                try {
                    const workerRequest = buildWorkerRequestWithTransfers(request);
                    worker.postMessage(workerRequest.request, workerRequest.transfer);
                } catch (error) {
                    client.cancelPendingRequest(
                        request.id,
                        reportWorkerFailure(error instanceof Error ? error : new Error(String(error))),
                    );
                }
            });
        });
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

export function cloneCombineWorkerInput(
    fileName: string,
    data: Uint8Array,
): IBrowserPdfCombineInput {
    return {
        fileName,
        data: toTransferableUint8Array(data),
    };
}
