import {
    matchPdfSearchPageWindow,
    SearchRegexLimitError,
    type IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import {
    SEARCH_REGEX_MAX_EXECUTION_MS,
    type TSearchResultOffset,
} from '@contracts/search';
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

export async function matchBrowserSearchPageWindow(
    ...args: Parameters<typeof matchBrowserSearchPageWindowInWorker>
): Promise<ReturnType<typeof matchPdfSearchPageWindow>> {
    const [
        text,
        query,
        options,
        maxMatches,
        resultOffset,
    ] = args;
    return options.useRegex
        ? matchBrowserSearchPageWindowInWorker(...args)
        : matchPdfSearchPageWindow(text, query, options, maxMatches, resultOffset);
}

/**
 * One page's match window for a browser search. A regular expression runs in
 * the search worker, so a catastrophic one cannot hold the renderer: a worker
 * still matching at its bound is terminated and reported as the budget error,
 * and aborting `signal` terminates a running match. Highlight reconciliation
 * also uses this boundary for literal queries. `regexBudget` is the matching time left in the caller's
 * budget; the time the worker reports is taken from it.
 */
export async function matchBrowserSearchPageWindowInWorker(
    text: string,
    query: string,
    options: IResolvedSearchMatchOptions,
    maxMatches: number,
    resultOffset: TSearchResultOffset,
    regexBudget: {remainingMs: number},
    signal: AbortSignal,
): Promise<ReturnType<typeof matchPdfSearchPageWindow>> {
    if (options.useRegex && regexBudget.remainingMs <= 0) {
        throw createRegexBudgetError();
    }
    if (!canUseBrowserSearchWorker()) {
        throw new BrowserSearchWorkerUnavailableError(
            'Browser search worker is required for page-text matching',
        );
    }

    signal.throwIfAborted();
    // Reading the page and starting the worker do not spend the budget; the
    // worker's own time on the match does.
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
        {matchTimeoutMs: BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS},
    );
    const cancelWorkerRequest = () => cancelBrowserSearchWorkerRequest(
        workerRequest.requestId,
        {resetWorker: true},
    );
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
