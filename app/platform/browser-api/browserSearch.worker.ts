import {
    getBrowserSearchWorkerRequestId,
    parseBrowserSearchWorkerRequest,
    type IBrowserSearchWorkerRequest,
    type TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { getErrorMessage } from '@app/utils/error';
import {
    iteratePdfSearchMatches,
    SearchRegexLimitError,
    validateSearchQuery,
} from '@pdf-core/pdfSearchCore';

// The worker only matches page text. Page text comes from the renderer's own
// PDF.js document, so a long regular expression can be stopped by
// terminating this worker without touching a document.
function handleMatchPageTextRequest(
    request: IBrowserSearchWorkerRequest,
) {
    const {
        text, query, options, maxMatches, deadlineAtMs,
    } = request.payload;
    validateSearchQuery(query, options);

    const matches = [];
    let truncated = false;
    for (const match of iteratePdfSearchMatches(text, query, {
        ...options,
        ...(deadlineAtMs === undefined ? {} : {deadlineAtMs}),
    })) {
        if (matches.length >= maxMatches) {
            truncated = true;
            break;
        }
        matches.push(match);
    }

    return {
        matches,
        truncated,
    };
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
    const request = parseBrowserSearchWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserSearchWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser search worker request',
            } satisfies TBrowserSearchWorkerResponse);
        }
        return;
    }

    try {
        const data = handleMatchPageTextRequest(request);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data,
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
            ...(error instanceof SearchRegexLimitError ? {errorCode: 'SEARCH_REGEX_LIMIT' as const} : {}),
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    }
});
