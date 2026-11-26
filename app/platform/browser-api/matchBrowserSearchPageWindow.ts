import {
    SearchRegexLimitError,
    type IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {
    SEARCH_REGEX_MAX_EXECUTION_MS,
    type TSearchResultOffset,
} from '@contracts/search';
import type {IPdfSearchMatchPageResponse} from '@contracts/searchIndexWire';
import {
    BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS,
    BrowserSearchWorkerTimeoutError,
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
} from '@app/platform/browser-api/browserSearchWorkerClient';

function createRegexBudgetError() {
    return new SearchRegexLimitError(
        `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`,
    );
}

/**
 * Matches one page's text in the browser search WASM worker (`evb-pdf-search.wasm`).
 * Both literal and regular expression queries run through the same Rust engine.
 */
export async function matchBrowserSearchPageWindow(
    text: string,
    query: string,
    options: IResolvedSearchMatchOptions,
    maxMatches: number,
    resultOffset: TSearchResultOffset,
    regexBudget: {remainingMs: number},
    signal: AbortSignal,
): Promise<IPdfSearchMatchPageResponse> {
    return matchBrowserSearchPageWindowInWorker(
        text,
        query,
        options,
        maxMatches,
        resultOffset,
        regexBudget,
        signal,
    );
}

/**
 * One page's match window executed via `evb-pdf-search.wasm` in the browser
 * search worker. Aborting `signal` terminates only the busy worker.
 */
export async function matchBrowserSearchPageWindowInWorker(
    text: string,
    query: string,
    options: IResolvedSearchMatchOptions,
    maxMatches: number,
    resultOffset: TSearchResultOffset,
    regexBudget: {remainingMs: number},
    signal: AbortSignal,
): Promise<IPdfSearchMatchPageResponse> {
    if (options.useRegex && regexBudget.remainingMs <= 0) {
        throw createRegexBudgetError();
    }
    if (!canUseBrowserSearchWorker()) {
        throw new BrowserSearchWorkerUnavailableError(
            'Browser search worker is required for page-text matching',
        );
    }

    signal.throwIfAborted();
    const workerRequest = createBrowserSearchWorkerRequest(
        'matchPageText',
        {
            text,
            query,
            options,
            maxMatches,
            resultOffset,
            ...(options.useRegex ? {budgetMs: regexBudget.remainingMs} : {}),
        },
        options.useRegex ? {matchTimeoutMs: BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS} : {},
    );
    const cancelWorkerRequest = () => cancelBrowserSearchWorkerRequest(workerRequest.requestId);
    signal.addEventListener('abort', cancelWorkerRequest, {once: true});
    try {
        const {
            matchingMs,
            ...result
        } = await workerRequest.promise;
        if (options.useRegex) regexBudget.remainingMs -= matchingMs;
        return result;
    } catch (error) {
        throw error instanceof BrowserSearchWorkerTimeoutError ? createRegexBudgetError() : error;
    } finally {
        signal.removeEventListener('abort', cancelWorkerRequest);
    }
}
