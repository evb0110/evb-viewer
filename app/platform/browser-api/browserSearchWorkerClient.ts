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
import { isRecord } from '@contracts/runtimeGuards';
import {SEARCH_REGEX_MAX_EXECUTION_MS} from '@contracts/search';
import {SearchRegexLimitError} from '@pdf-core';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';
import { captureRendererFailure } from '@app/utils/failureReporter';
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
interface IBrowserSearchWorkerRequestOptions {matchTimeoutMs?: number;}

const BROWSER_SEARCH_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS = 60_000;
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

interface IBrowserSearchWorkerFailure extends Error {failure?: FailureReceipt;}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IBrowserSearchWorkerFailure).failure;
}

function isExpectedWorkerTermination(error: Error) {
    return getErrorMessage(error) === 'ERR_BROWSER_SEARCH_CANCELED'
        || error instanceof SearchRegexLimitError
        || error instanceof BrowserSearchWorkerTimeoutError;
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
    return isRecord(response) && typeof response.id === 'number'
        ? response.id
        : null;
}

function decodeSearchWorkerResult<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserSearchWorkerResultMap[K] | null {
    const result = v.safeParse(BROWSER_SEARCH_WORKER_RESULT_SCHEMAS[type], data, {abortEarly: true});
    return result.success ? result.output : null;
}

function settleSearchWorkerResponse(
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
            browserSearchWorkerClient.restartRequestTimeout(
                responseId,
                () => createMatchTimeoutError(matchTimeoutMs),
                matchTimeoutMs,
            );
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
    const errorMessage = result.success && typeof result.output.error === 'string'
        ? result.output.error
        : 'Browser search worker returned an invalid error response';
    pending.reject(result.success && result.output.errorCode === 'SEARCH_REGEX_LIMIT'
        ? new SearchRegexLimitError(errorMessage)
        : new BrowserSearchWorkerRequestError(errorMessage));
    scheduleIdleWorkerTermination();
}

function createMatchTimeoutError(timeoutMs: number) {
    const timeoutError = reportWorkerFailure(new BrowserSearchWorkerTimeoutError(
        `Browser search worker match timed out after ${timeoutMs}ms`,
    ));
    browserSearchWorkerClient.resetWorker(timeoutError);
    return timeoutError;
}

export function canUseBrowserSearchWorker() {
    return canUseBrowserWorker();
}

const browserSearchWorkerClient = new BrowserWorkerClient<IPendingWorkerRequest>({
    idleTtlMs: BROWSER_SEARCH_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browserSearch.worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch (error) {
            throw reportWorkerFailure(new BrowserSearchWorkerUnavailableError(
                getErrorMessage(error),
            ));
        }
    },
    createError: event => reportWorkerFailure(new BrowserSearchWorkerRequestError(
        event.error instanceof Error ? getErrorMessage(event.error) : event.message,
    )),
    handleMessage: settleSearchWorkerResponse,
});

export function createBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: IBrowserSearchWorkerRequestOptions = {},
): {
    requestId: number;
    promise: Promise<IBrowserSearchWorkerResultMap[K]>;
} {
    const request = {
        id: browserSearchWorkerClient.createRequestId(),
        type,
        payload,
    } as IBrowserSearchWorkerRequest<K>;

    const worker = browserSearchWorkerClient.getWorker();

    const promise =
        new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
            browserSearchWorkerClient.registerPendingRequest(request.id, {
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
                reject: error => reject(reportWorkerFailure(error)),
            }, () => reportWorkerFailure(new BrowserSearchWorkerTimeoutError(
                `Browser search worker request timed out after ${BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS}ms`,
            )));

            try {
                worker.postMessage(request);
            } catch (error) {
                browserSearchWorkerClient.cancelPendingRequest(
                    request.id,
                    reportWorkerFailure(new BrowserSearchWorkerRequestError(getErrorMessage(error))),
                );
            }
        });

    return {
        requestId: request.id,
        promise,
    };
}

/**
 * The worker answers a match synchronously, so a cancel cannot interrupt it
 * there: the request is settled here, and `resetWorker` terminates a worker
 * that is still running a long regular expression.
 */
export function cancelBrowserSearchWorkerRequest(
    requestId: number,
    options: {resetWorker?: boolean} = {},
) {
    const cancelError = new Error('ERR_BROWSER_SEARCH_CANCELED');
    browserSearchWorkerClient.cancelPendingRequest(
        requestId,
        cancelError,
        options.resetWorker
            ? {
                resetWorker: true,
                resetError: cancelError,
            }
            : {},
    );
}
