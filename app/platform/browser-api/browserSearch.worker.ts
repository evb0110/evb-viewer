import {
    getBrowserSearchWorkerRequestId,
    parseBrowserSearchWorkerRequest,
    type IBrowserSearchWorkerRequest,
    type IBrowserSearchWorkerResultMap,
    type TBrowserSearchWorkerRequestType,
    type TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {createNativeWasmToolLoader} from '@app/platform/browser/nativeWasmTool';
import {handlePrecompiledWasmModuleMessage} from '@app/platform/browser/loadWasmWithDeadline';
import {getErrorMessage} from '@app/utils/error';
import {
    decodePdfSearchIndexWasmOutput,
    decodePdfSearchJsonOutput,
    encodePdfSearchWasmRequest,
    isStaleSearchIndexAnswer,
    PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA,
    PDF_SEARCH_WASM_EXPORT_PREFIX,
    PDF_SEARCH_WASM_MAX_OUTPUT_BYTES,
    PDF_SEARCH_WASM_MAX_REQUEST_BYTES,
    SEARCH_INDEX_RESPONSE_SCHEMA,
    SEARCH_INDEX_TEXT_BUDGET,
} from '@contracts/searchIndexWire';
import {
    SearchRegexLimitError,
    validateSearchQuery,
} from '@pdf-core/pdfSearchCore';
import * as v from 'valibot';

const textEncoder = new TextEncoder();

const pdfSearchWasm = createNativeWasmToolLoader({
    path: '/wasm/evb-pdf-search.wasm',
    prefix: PDF_SEARCH_WASM_EXPORT_PREFIX,
    runExport: 'run',
    label: 'PDF search WASM',
    maxRequestBytes: PDF_SEARCH_WASM_MAX_REQUEST_BYTES,
    maxOutputBytes: PDF_SEARCH_WASM_MAX_OUTPUT_BYTES,
});

async function runWasm(request: Uint8Array) {
    const outcome = await pdfSearchWasm.call(request);
    if (outcome.status === 'failed') {
        throw new Error(outcome.error.message);
    }
    return outcome.output;
}

async function handleIndexRequest(
    request: IBrowserSearchWorkerRequest<'index'>,
): Promise<{
    data: IBrowserSearchWorkerResultMap['index'];
    transfer: Transferable[];
}> {
    const {
        documentRevision,
        pageCount,
        pagesBuffer,
        maxPageTextBytes,
        maxTotalTextBytes,
    } = request.payload;
    const output = await runWasm(encodePdfSearchWasmRequest({
        op: 'index',
        documentRevision,
        pageCount,
        maxPageTextBytes: maxPageTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
        maxTotalTextBytes: maxTotalTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
    }, pagesBuffer));
    const decoded = decodePdfSearchIndexWasmOutput(output);
    return {
        data: decoded,
        transfer: [decoded.indexBytes.buffer],
    };
}

async function handleSearchRequest(
    request: IBrowserSearchWorkerRequest<'search'>,
): Promise<IBrowserSearchWorkerResultMap['search']> {
    const {
        indexBytes,
        documentRevision,
        query,
        options,
        limit,
        contextChars,
        resultOffset,
    } = request.payload;
    validateSearchQuery(query, options);
    // Warm the WASM instance before signaling start so cold download/compile never spends the timeout.
    await pdfSearchWasm.load();
    self.postMessage({
        id: request.id,
        started: true,
    } satisfies TBrowserSearchWorkerResponse);
    const output = await runWasm(encodePdfSearchWasmRequest({
        op: 'search',
        documentRevision,
        query,
        limit,
        contextChars,
        ...(resultOffset === undefined ? {} : {resultOffset}),
        matchCase: options.matchCase,
        wholeWord: options.wholeWord,
        useRegex: options.useRegex,
    }, indexBytes));
    const decoded = decodePdfSearchJsonOutput(output);
    if (isStaleSearchIndexAnswer(decoded)) {
        return {stale: true};
    }
    const parsed = v.safeParse(SEARCH_INDEX_RESPONSE_SCHEMA, decoded, {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search returned an invalid search response');
    }
    return parsed.output;
}

async function handleMatchPageTextRequest(
    request: IBrowserSearchWorkerRequest<'matchPageText'>,
): Promise<IBrowserSearchWorkerResultMap['matchPageText']> {
    const {
        text,
        query,
        options,
        maxMatches,
        resultOffset,
    } = request.payload;
    validateSearchQuery(query, options);
    if (text.length === 0) {
        return {
            matches: [],
            truncated: false,
            matchCount: 0,
            matchingMs: 0,
        };
    }
    await pdfSearchWasm.load();
    const startedAtMs = Date.now();
    self.postMessage({
        id: request.id,
        started: true,
    } satisfies TBrowserSearchWorkerResponse);
    const output = await runWasm(encodePdfSearchWasmRequest({
        op: 'matchPage',
        query,
        matchCase: options.matchCase,
        wholeWord: options.wholeWord,
        useRegex: options.useRegex,
        maxMatches,
        ...(resultOffset === undefined ? {} : {resultOffset}),
    }, textEncoder.encode(text)));
    const parsed = v.safeParse(
        PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA,
        decodePdfSearchJsonOutput(output),
        {abortEarly: true},
    );
    if (!parsed.success) {
        throw new Error('evb-pdf-search returned an invalid page match response');
    }
    return {
        ...parsed.output,
        matchingMs: Date.now() - startedAtMs,
    };
}

// The worker only builds and searches text via evb-pdf-search.wasm. Page text
// comes from the renderer's own PDF.js or DjVu.js document, so terminating this
// worker on cancel never touches a document.
self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) return;
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
        let data: IBrowserSearchWorkerResultMap[TBrowserSearchWorkerRequestType];
        let transfer: Transferable[] = [];
        switch (request.type) {
            case 'index': {
                const outcome = await handleIndexRequest(request);
                data = outcome.data;
                transfer = outcome.transfer;
                break;
            }
            case 'search':
                data = await handleSearchRequest(request);
                break;
            case 'matchPageText':
                data = await handleMatchPageTextRequest(request);
                break;
        }
        self.postMessage({
            id: request.id,
            type: request.type,
            ok: true,
            data,
        } as TBrowserSearchWorkerResponse, transfer);
    } catch (error) {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
            ...(error instanceof SearchRegexLimitError ? {errorCode: 'SEARCH_REGEX_LIMIT' as const} : {}),
        } satisfies TBrowserSearchWorkerResponse);
    }
});
