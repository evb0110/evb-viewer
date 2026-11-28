import type {
    IBrowserSearchWorkerRequest,
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    TBrowserSearchWorkerRequestType,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {
    BROWSER_SEARCH_WORKER_ERROR_RESPONSE_SCHEMA,
    BROWSER_SEARCH_WORKER_RESPONSE_STATUS_SCHEMA,
    BROWSER_SEARCH_WORKER_RESULT_SCHEMAS,
    BROWSER_SEARCH_WORKER_STARTED_RESPONSE_SCHEMA,
    BROWSER_SEARCH_WORKER_SUCCESS_RESPONSE_SCHEMA,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {isRecord} from '@contracts/runtimeGuards';
import {SEARCH_REGEX_MAX_EXECUTION_MS} from '@contracts/search';
import {SearchRegexLimitError} from '@pdf-core';
import {BrowserWorkerClient, BrowserWorkerRequestOwner, canUseBrowserWorker} from '@app/platform/browser-api/browserWorkerClient';
import {runWithBrowserWorkerAdmission} from '@app/platform/browser-api/browserWorkerAdmission';
import {getErrorMessage} from '@app/utils/error';
import {captureRendererFailure} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import * as v from 'valibot';

interface IPendingWorkerRequest {
    requestType: TBrowserSearchWorkerRequestType;
    resolveData: (data: unknown) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
    matchTimeoutMs?: number;
}

/**
 * `matchTimeoutMs` bounds the match from the moment the worker reports it
 * started, so a cold worker's start-up is not counted, and terminates the
 * worker when the bound passes: a running regular expression cannot be
 * interrupted.
 */
interface IBrowserSearchWorkerRequestOptions {
    matchTimeoutMs?: number;
    /** Soft affinity hint (e.g. document key) to reuse the warm worker caching this document's index. */
    affinityKey?: string;
    /** Re-checked at dispatch time so queued requests never refill the worker cache after a reset/invalidation. */
    isCacheable?: () => boolean;
}

const BROWSER_SEARCH_WORKER_IDLE_TTL_MS = 15_000;
export const BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS = SEARCH_REGEX_MAX_EXECUTION_MS + 1_000;

export class BrowserSearchWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerUnavailableError';
    }
}

class BrowserSearchWorkerRequestError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerRequestError';
    }
}

export class BrowserSearchWorkerTimeoutError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerTimeoutError';
    }
}

interface IBrowserSearchWorkerFailure extends Error {
    failure?: FailureReceipt;
}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IBrowserSearchWorkerFailure).failure;
}

function isExpectedWorkerTermination(error: Error) {
    return (
        getErrorMessage(error) === 'ERR_BROWSER_SEARCH_CANCELED' ||
        error instanceof SearchRegexLimitError ||
        error instanceof BrowserSearchWorkerTimeoutError
    );
}

function reportWorkerFailure(error: Error) {
    if (isExpectedWorkerTermination(error)) {
        return error;
    }
    const existingReceipt = getWorkerFailureReceipt(error);
    if (existingReceipt) {
        return error;
    }

    const receipt = captureRendererFailure({
        code: 'RENDERER_SEARCH_WORKER_FAILED',
        local: {
            source: 'browser-search-worker-parent',
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

function getSearchWorkerResponseId(response: unknown) {
    return isRecord(response) && typeof response.id === 'number' ? response.id : null;
}

function decodeSearchWorkerResult<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserSearchWorkerResultMap[K] | null {
    const result = v.safeParse(BROWSER_SEARCH_WORKER_RESULT_SCHEMAS[type], data, {abortEarly: true});
    return result.success ? (result.output as IBrowserSearchWorkerResultMap[K]) : null;
}

function settleSearchWorkerResponse(
    client: BrowserWorkerClient<IPendingWorkerRequest>,
    pendingWorkerRequests: Map<number, IPendingWorkerRequest>,
    response: unknown,
    scheduleIdleWorkerTermination: () => void,
) {
    const responseId = getSearchWorkerResponseId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingWorkerRequests.get(responseId);
    if (!pending) {
        return;
    }

    if (v.is(BROWSER_SEARCH_WORKER_STARTED_RESPONSE_SCHEMA, response)) {
        const matchTimeoutMs = pending.matchTimeoutMs;
        if (matchTimeoutMs !== undefined) {
            client.restartRequestTimeout(responseId, () => createMatchTimeoutError(client, matchTimeoutMs), matchTimeoutMs);
        }
        return;
    }

    const timeoutTimer = pending.timeoutTimer;
    pendingWorkerRequests.delete(responseId);
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        pending.timeoutTimer = null;
    }

    const status = v.safeParse(BROWSER_SEARCH_WORKER_RESPONSE_STATUS_SCHEMA, response, {abortEarly: true});
    if (!status.success) {
        pending.reject(new Error('Browser search worker returned an invalid response'));
        scheduleIdleWorkerTermination();
        return;
    }

    if (status.output.ok) {
        const result = v.safeParse(BROWSER_SEARCH_WORKER_SUCCESS_RESPONSE_SCHEMA, response, {abortEarly: true});
        if (!result.success || result.output.type !== pending.requestType || !pending.resolveData(result.output.data)) {
            pending.reject(new Error('Browser search worker returned an invalid result'));
            scheduleIdleWorkerTermination();
            return;
        }
        scheduleIdleWorkerTermination();
        return;
    }

    const result = v.safeParse(BROWSER_SEARCH_WORKER_ERROR_RESPONSE_SCHEMA, response, {abortEarly: true});
    const errorMessage =
        result.success && typeof result.output.error === 'string'
            ? result.output.error
            : 'Browser search worker returned an invalid error response';
    pending.reject(
        result.success && result.output.errorCode === 'SEARCH_REGEX_LIMIT'
            ? new SearchRegexLimitError(errorMessage)
            : new BrowserSearchWorkerRequestError(errorMessage),
    );
    scheduleIdleWorkerTermination();
}

function createMatchTimeoutError(client: BrowserWorkerClient<IPendingWorkerRequest>, timeoutMs: number) {
    const timeoutError = reportWorkerFailure(
        new BrowserSearchWorkerTimeoutError(`Browser search worker match timed out after ${timeoutMs}ms`),
    );
    client.resetWorker(timeoutError);
    return timeoutError;
}

export function canUseBrowserSearchWorker() {
    return canUseBrowserWorker();
}

function createBrowserSearchWorkerClient() {
    const client = new BrowserWorkerClient<IPendingWorkerRequest>({
        idleTtlMs: BROWSER_SEARCH_WORKER_IDLE_TTL_MS,
        preloadWasmPaths: () => ['/wasm/evb-pdf-search.wasm'],
        createWorker: () => {
            try {
                return new Worker(new URL('./browserSearch.worker.ts', import.meta.url), {type: 'module'});
            } catch (error) {
                throw reportWorkerFailure(new BrowserSearchWorkerUnavailableError(getErrorMessage(error)));
            }
        },
        createError: (event) =>
            reportWorkerFailure(
                new BrowserSearchWorkerRequestError(event.error instanceof Error ? getErrorMessage(event.error) : event.message),
            ),
        handleMessage: (...args) => settleSearchWorkerResponse(client, ...args),
    });
    return client;
}

const browserSearchWorkerSlots = Math.min(
    2,
    Math.max(1, Math.floor((typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4) / 2)),
);
const browserSearchWorkerOwner = new BrowserWorkerRequestOwner(createBrowserSearchWorkerClient, browserSearchWorkerSlots);
const pendingSearchAdmissionCancels = new Map<number, AbortController>();
let globalCacheEvictionEpoch = 0;
const documentCacheEvictionEpochs = new Map<string, number>();

export function createBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: IBrowserSearchWorkerRequestOptions = {},
): {
    requestId: number;
    promise: Promise<IBrowserSearchWorkerResultMap[K]>;
} {
    const requestId = browserSearchWorkerOwner.createRequestId();
    const initialDocumentKey =
        type === 'search' || type === 'index'
            ? (payload as IBrowserSearchWorkerRequestMap['search'] | IBrowserSearchWorkerRequestMap['index']).documentKey
            : undefined;
    const globalEpochAtEnqueue = globalCacheEvictionEpoch;
    const documentEpochAtEnqueue = initialDocumentKey === undefined ? 0 : (documentCacheEvictionEpochs.get(initialDocumentKey) ?? 0);

    const admissionAbort = new AbortController();
    pendingSearchAdmissionCancels.set(requestId, admissionAbort);
    const promise = runWithBrowserWorkerAdmission(
        {
            category: 'search',
            priority: 'interactive',
            categoryLimit: browserSearchWorkerSlots,
            signal: admissionAbort.signal,
            createAbortError: () => new Error('ERR_BROWSER_SEARCH_CANCELED'),
        },
        () =>
            browserSearchWorkerOwner.run(
                requestId,
                (client) => {
                    const cacheStillValid =
                        globalCacheEvictionEpoch === globalEpochAtEnqueue &&
                        (initialDocumentKey === undefined ||
                            (documentCacheEvictionEpochs.get(initialDocumentKey) ?? 0) === documentEpochAtEnqueue) &&
                        options.isCacheable?.() !== false;

                    let dispatchPayload = payload;
                    if (!cacheStillValid && (type === 'search' || type === 'index')) {
                        if (type === 'search' && (payload as IBrowserSearchWorkerRequestMap['search']).indexBytes === undefined) {
                            return Promise.resolve({cacheMiss: true} as IBrowserSearchWorkerResultMap[K]);
                        }
                        if (initialDocumentKey !== undefined) {
                            const {documentKey: _omitted, ...uncachedPayload} = payload as
                                IBrowserSearchWorkerRequestMap['search'] | IBrowserSearchWorkerRequestMap['index'];
                            dispatchPayload = uncachedPayload as IBrowserSearchWorkerRequestMap[K];
                        }
                    }

                    const request = {
                        id: requestId,
                        type,
                        payload: dispatchPayload,
                    } as IBrowserSearchWorkerRequest<K>;

                    const worker = client.getWorker();
                    return new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
                        client.registerPendingRequest(
                            request.id,
                            {
                                requestType: type,
                                ...(options.matchTimeoutMs === undefined ? {} : {matchTimeoutMs: options.matchTimeoutMs}),
                                resolveData: (value) => {
                                    const decoded = decodeSearchWorkerResult(type, value);
                                    if (!decoded) {
                                        return false;
                                    }
                                    resolve(decoded);
                                    return true;
                                },
                                reject: (error) => reject(reportWorkerFailure(error)),
                                // As on desktop a search runs until it finishes or is canceled; only
                                // a regular expression's match has a time bound (matchTimeoutMs).
                            },
                            () => reportWorkerFailure(new BrowserSearchWorkerTimeoutError('Browser search worker request timed out')),
                        );

                        try {
                            const transfer: Transferable[] = [];
                            if (type === 'index') {
                                const {documentKey, pagesBuffer} = dispatchPayload as IBrowserSearchWorkerRequestMap['index'];
                                if (documentKey !== undefined) {
                                    // Evict any older cached revision for this document across all active workers
                                    // before posting the index build (worker message delivery is FIFO).
                                    browserSearchWorkerOwner.postToActiveWorkers({type: 'evictCache', documentKey});
                                }
                                if (
                                    pagesBuffer.buffer instanceof ArrayBuffer &&
                                    pagesBuffer.byteOffset === 0 &&
                                    pagesBuffer.byteLength === pagesBuffer.buffer.byteLength
                                ) {
                                    transfer.push(pagesBuffer.buffer);
                                }
                            }
                            worker.postMessage(request, transfer);
                        } catch (error) {
                            client.cancelPendingRequest(
                                request.id,
                                reportWorkerFailure(new BrowserSearchWorkerRequestError(getErrorMessage(error))),
                            );
                        }
                    });
                },
                options.affinityKey === undefined ? {} : {affinityKey: options.affinityKey},
            ),
    ).finally(() => {
        pendingSearchAdmissionCancels.delete(requestId);
    });

    return {
        requestId,
        promise,
    };
}

/** Evicts cached search index bytes from live browser search workers without spawning new ones. */
export function evictBrowserSearchWorkerCache(documentKey?: string) {
    if (documentKey === undefined) {
        globalCacheEvictionEpoch += 1;
        documentCacheEvictionEpochs.clear();
    } else {
        documentCacheEvictionEpochs.set(documentKey, (documentCacheEvictionEpochs.get(documentKey) ?? 0) + 1);
    }
    browserSearchWorkerOwner.postToActiveWorkers(
        documentKey === undefined ? {type: 'evictCache'} : {type: 'evictCache', documentKey},
        documentKey,
    );
}

/** Canceling an admitted synchronous match terminates only its worker. */
export function cancelBrowserSearchWorkerRequest(requestId: number) {
    const admissionAbort = pendingSearchAdmissionCancels.get(requestId);
    pendingSearchAdmissionCancels.delete(requestId);
    admissionAbort?.abort(new Error('ERR_BROWSER_SEARCH_CANCELED'));
    browserSearchWorkerOwner.cancel(requestId, new Error('ERR_BROWSER_SEARCH_CANCELED'));
}
