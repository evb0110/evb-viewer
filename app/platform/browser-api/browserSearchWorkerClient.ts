import type {
    IBrowserSearchWorkerRequest,
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    TBrowserSearchWorkerRequestType,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {
    BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT,
    type IBrowserSearchWorkerPageRecord,
} from '@app/platform/browser-api/browserSearchLegacyArrayPageLimit';
import {BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST} from '@app/platform/browser-api/browserSearchWorker.types';
import { isRecord } from '@contracts/runtimeGuards';
import {
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SearchRegexLimitError,
} from '@contracts/search';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    detectRendererDiagnosticsHost,
    getRendererFailureReporter,
    initializeRendererFailureReporter,
} from '@app/utils/failureReporter';

interface IPendingWorkerRequest {
    requestType: TBrowserSearchWorkerRequestType;
    resolveData: (data: unknown) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
    onProgress?: TBrowserSearchWorkerProgressHandler;
    onPage?: (page: IBrowserSearchWorkerPageRecord) => void;
}

type TBrowserSearchWorkerProgressHandler = (progress: {
    processed: number;
    total: number;
}) => void;

interface IBrowserSearchWorkerRequestOptions {
    onProgress?: TBrowserSearchWorkerProgressHandler;
    timeoutMs?: number;
    resetWorkerOnTimeout?: boolean;
}

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

    const reporter = getRendererFailureReporter() ?? initializeRendererFailureReporter({host: detectRendererDiagnosticsHost()});
    const receipt = reporter.capture({
        code: 'RENDERER_SEARCH_WORKER_FAILED',
        context: {},
        local: {
            source: 'browser-search-worker-parent',
            message: error.message,
            cause: error,
        },
    }, {runtime: 'browser-worker-parent'});
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

function isFiniteProgressNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseSearchWorkerProgress(
    response: unknown,
    expectedType: TBrowserSearchWorkerRequestType,
): Parameters<TBrowserSearchWorkerProgressHandler>[0] | null {
    if (
        !isRecord(response)
        || response.ok !== true
        || response.type !== expectedType
        || !isRecord(response.progress)
    ) {
        return null;
    }

    if (
        !isFiniteProgressNumber(response.progress.processed)
        || !isFiniteProgressNumber(response.progress.total)
    ) {
        return null;
    }

    return {
        processed: response.progress.processed,
        total: response.progress.total,
    };
}

function decodeExtractDocumentTextResult(data: unknown): IBrowserSearchWorkerResultMap['extractDocumentText'] | null {
    if (!isRecord(data) || typeof data.pageCount !== 'number' || !Array.isArray(data.pageTexts)) {
        return null;
    }

    const pageTexts = data.pageTexts;
    if (
        !Number.isSafeInteger(data.pageCount)
        || data.pageCount < 0
        || data.pageCount > BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT
        || pageTexts.length > BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT
        || pageTexts.length > data.pageCount
        || !pageTexts.every((pageText): pageText is string => typeof pageText === 'string')
    ) {
        return null;
    }

    return {
        pageCount: data.pageCount,
        pageTexts: [...pageTexts],
    };
}

function decodeCancelResult(data: unknown): IBrowserSearchWorkerResultMap['cancel'] | null {
    if (!isRecord(data) || typeof data.canceled !== 'boolean') {
        return null;
    }

    return {canceled: data.canceled};
}

function decodeStreamDocumentTextResult(data: unknown): IBrowserSearchWorkerResultMap['streamDocumentText'] | null {
    if (
        !isRecord(data)
        || typeof data.pageCount !== 'number'
        || !Number.isSafeInteger(data.pageCount)
        || data.pageCount < 0
    ) {
        return null;
    }

    return {pageCount: data.pageCount};
}

function isSearchMatchRange(value: unknown): value is IBrowserSearchWorkerResultMap['matchPageText']['matches'][number] {
    return isRecord(value)
        && typeof value.startOffset === 'number'
        && Number.isSafeInteger(value.startOffset)
        && value.startOffset >= 0
        && typeof value.endOffset === 'number'
        && Number.isSafeInteger(value.endOffset)
        && value.endOffset > value.startOffset;
}

function decodeMatchPageTextResult(data: unknown): IBrowserSearchWorkerResultMap['matchPageText'] | null {
    if (
        !isRecord(data)
        || !Array.isArray(data.matches)
        || data.matches.length > BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST
        || typeof data.truncated !== 'boolean'
        || !data.matches.every(isSearchMatchRange)
    ) {
        return null;
    }

    return {
        matches: data.matches.map(match => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
        })),
        truncated: data.truncated,
    };
}

function parseSearchWorkerPage(
    response: unknown,
    expectedType: TBrowserSearchWorkerRequestType,
): IBrowserSearchWorkerPageRecord | null {
    if (
        !isRecord(response)
        || response.ok !== true
        || response.type !== expectedType
        || !isRecord(response.page)
        || typeof response.page.pageNumber !== 'number'
        || !Number.isSafeInteger(response.page.pageNumber)
        || response.page.pageNumber < 1
        || typeof response.page.pageCount !== 'number'
        || !Number.isSafeInteger(response.page.pageCount)
        || response.page.pageCount < response.page.pageNumber
        || typeof response.page.text !== 'string'
    ) {
        return null;
    }

    return {
        pageNumber: response.page.pageNumber,
        pageCount: response.page.pageCount,
        text: response.page.text,
    };
}

function decodeSearchWorkerResult<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserSearchWorkerResultMap[K] | null {
    if (type === 'extractDocumentText') {
        return decodeExtractDocumentTextResult(data) as IBrowserSearchWorkerResultMap[K] | null;
    }

    if (type === 'streamDocumentText') {
        return decodeStreamDocumentTextResult(data) as IBrowserSearchWorkerResultMap[K] | null;
    }

    if (type === 'matchPageText') {
        return decodeMatchPageTextResult(data) as IBrowserSearchWorkerResultMap[K] | null;
    }

    if (type === 'acknowledgePage') {
        if (!isRecord(data) || data.acknowledged !== true) {
            return null;
        }
        return {acknowledged: true} as IBrowserSearchWorkerResultMap[K];
    }

    return decodeCancelResult(data) as IBrowserSearchWorkerResultMap[K] | null;
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

    const progress = parseSearchWorkerProgress(response, pending.requestType);
    if (progress) {
        pending.onProgress?.(progress);
        return;
    }

    const page = parseSearchWorkerPage(response, pending.requestType);
    if (page) {
        pending.onPage?.(page);
        return;
    }

    const timeoutTimer = pending.timeoutTimer;
    pendingWorkerRequests.delete(responseId);
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        pending.timeoutTimer = null;
    }

    if (!isRecord(response) || typeof response.ok !== 'boolean') {
        pending.reject(new Error('Browser search worker returned an invalid response'));
        scheduleIdleWorkerTermination();
        return;
    }

    if (response.ok === true) {
        if (response.type !== pending.requestType || !('data' in response) || !pending.resolveData(response.data)) {
            pending.reject(new Error('Browser search worker returned an invalid result'));
            scheduleIdleWorkerTermination();
            return;
        }
        scheduleIdleWorkerTermination();
        return;
    }

    const errorMessage = typeof response.error === 'string'
        ? response.error
        : 'Browser search worker returned an invalid error response';
    pending.reject(response.errorCode === 'SEARCH_REGEX_LIMIT'
        ? new SearchRegexLimitError(errorMessage)
        : new BrowserSearchWorkerRequestError(errorMessage));
    scheduleIdleWorkerTermination();
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

function postBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: IBrowserSearchWorkerRequestOptions = {},
): {
    requestId: number;
    promise: Promise<IBrowserSearchWorkerResultMap[K]>;
} {
    const request: IBrowserSearchWorkerRequest<K> = {
        id: browserSearchWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserSearchWorkerClient.getWorker();

    const promise =
        new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
            browserSearchWorkerClient.registerPendingRequest(request.id, {
                requestType: type,
                resolveData: (value) => {
                    const decoded = decodeSearchWorkerResult(type, value);
                    if (!decoded) {
                        return false;
                    }
                    resolve(decoded);
                    return true;
                },
                reject: error => reject(reportWorkerFailure(error)),
                ...(options.onProgress ? {onProgress: options.onProgress} : {}),
            }, () => {
                const timeoutMs = options.timeoutMs ?? BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS;
                const timeoutError = reportWorkerFailure(new BrowserSearchWorkerTimeoutError(
                    `Browser search worker request timed out after ${timeoutMs}ms`,
                ));
                if (options.resetWorkerOnTimeout) {
                    browserSearchWorkerClient.resetWorker(timeoutError);
                }
                return timeoutError;
            }, options.timeoutMs);

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

export interface IBrowserSearchWorkerPageStream {
    requestId: number;
    pages: AsyncIterable<IBrowserSearchWorkerPageRecord>;
    promise: Promise<IBrowserSearchWorkerResultMap['streamDocumentText']>;
}

function createPageStreamQueue(
    onPageConsumed: () => void,
    onStreamClosed: () => void,
) {
    const pendingPages: IBrowserSearchWorkerPageRecord[] = [];
    const pendingReads: Array<{
        resolve: (result: IteratorResult<IBrowserSearchWorkerPageRecord>) => void;
        reject: (error: Error) => void;
    }> = [];
    let completed = false;
    let failure: Error | null = null;

    const fail = (error: Error) => {
        if (completed || failure) {
            return;
        }
        failure = error;
        pendingPages.length = 0;
        pendingReads.splice(0).forEach(read => read.reject(error));
    };

    const finish = () => {
        if (completed) {
            return;
        }
        completed = true;
        if (pendingPages.length === 0 && !failure) {
            pendingReads.splice(0).forEach(read => read.resolve({
                done: true,
                value: undefined,
            }));
        }
    };

    const acknowledgeConsumedPage = () => {
        try {
            onPageConsumed();
        } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            onStreamClosed();
        }
    };

    const push = (page: IBrowserSearchWorkerPageRecord) => {
        if (completed || failure) {
            return;
        }
        const read = pendingReads.shift();
        if (read) {
            acknowledgeConsumedPage();
            read.resolve({
                done: false,
                value: page,
            });
            return;
        }
        if (pendingPages.length > 0) {
            fail(new Error('Browser search worker exceeded the page stream buffer'));
            return;
        }
        pendingPages.push(page);
    };

    const next = (): Promise<IteratorResult<IBrowserSearchWorkerPageRecord>> => {
        const page = pendingPages.shift();
        if (page) {
            acknowledgeConsumedPage();
            return Promise.resolve({
                done: false,
                value: page,
            });
        }
        if (failure) {
            return Promise.reject(failure);
        }
        if (completed) {
            return Promise.resolve({
                done: true,
                value: undefined,
            });
        }
        if (pendingReads.length > 0) {
            return Promise.reject(new Error('Browser search worker page reads must be consumed serially'));
        }
        return new Promise((resolve, reject) => pendingReads.push({
            resolve,
            reject,
        }));
    };

    const iterator: AsyncIterableIterator<IBrowserSearchWorkerPageRecord> = {
        next,
        return: () => {
            if (!completed && !failure) {
                onStreamClosed();
            }
            finish();
            return Promise.resolve({
                done: true,
                value: undefined,
            });
        },
        [Symbol.asyncIterator]() {
            return this;
        },
    };

    return {
        iterator,
        push,
        fail,
        finish,
    };
}

export function createBrowserSearchWorkerPageStreamRequest(
    payload: IBrowserSearchWorkerRequestMap['streamDocumentText'],
): IBrowserSearchWorkerPageStream {
    const request: IBrowserSearchWorkerRequest<'streamDocumentText'> = {
        id: browserSearchWorkerClient.createRequestId(),
        type: 'streamDocumentText',
        payload,
    };
    const worker = browserSearchWorkerClient.getWorker();
    const pageQueue = createPageStreamQueue(
        () => {
            const acknowledgeRequest: IBrowserSearchWorkerRequest<'acknowledgePage'> = {
                id: browserSearchWorkerClient.createRequestId(),
                type: 'acknowledgePage',
                payload: {requestId: request.id},
            };
            try {
                worker.postMessage(acknowledgeRequest);
            } catch (error) {
                throw reportWorkerFailure(error instanceof Error ? error : new Error(String(error)));
            }
        },
        () => cancelBrowserSearchWorkerRequest(request.id),
    );
    const promise = new Promise<IBrowserSearchWorkerResultMap['streamDocumentText']>((resolve, reject) => {
        browserSearchWorkerClient.registerPendingRequest(request.id, {
            requestType: request.type,
            resolveData: (value) => {
                const decoded = decodeSearchWorkerResult(request.type, value);
                if (!decoded) {
                    return false;
                }
                pageQueue.finish();
                resolve(decoded);
                return true;
            },
            reject: (error) => {
                pageQueue.fail(error);
                reject(reportWorkerFailure(error));
            },
            onPage: pageQueue.push,
        }, () => reportWorkerFailure(new BrowserSearchWorkerRequestError(
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
        pages: pageQueue.iterator,
        promise,
    };
}

export function runBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: IBrowserSearchWorkerRequestOptions = {},
): Promise<IBrowserSearchWorkerResultMap[K]> {
    return postBrowserSearchWorkerRequest(type, payload, options).promise;
}

export function createBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: IBrowserSearchWorkerRequestOptions = {},
) {
    return postBrowserSearchWorkerRequest(type, payload, options);
}

export function cancelBrowserSearchWorkerRequest(
    requestId: number,
    options: {resetWorker?: boolean} = {},
) {
    if (!browserSearchWorkerClient.hasPendingRequest(requestId)) {
        return;
    }

    const cancelError = new Error('ERR_BROWSER_SEARCH_CANCELED');
    if (!browserSearchWorkerClient.hasWorker()) {
        browserSearchWorkerClient.cancelPendingRequest(requestId, cancelError);
        return;
    }

    try {
        const cancelRequest: IBrowserSearchWorkerRequest<'cancel'> = {
            id: browserSearchWorkerClient.createRequestId(),
            type: 'cancel',
            payload: { requestId },
        };
        browserSearchWorkerClient.getWorker().postMessage(cancelRequest);
    } catch (error) {
        browserSearchWorkerClient.cancelPendingRequest(
            requestId,
            cancelError,
            {
                resetWorker: true,
                resetError: new BrowserSearchWorkerRequestError(getErrorMessage(error)),
            },
        );
        return;
    }

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
