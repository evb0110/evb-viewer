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
import {isRecord} from '@contracts/runtimeGuards';
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
import {SearchRegexLimitError, validateSearchQuery} from '@pdf-core/pdfSearchCore';
import * as v from 'valibot';

const textEncoder = new TextEncoder();
const WORKER_INDEX_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const WORKER_INDEX_CACHE_IDLE_TTL_MS = 15_000;

interface IWorkerCachedIndex {
    readonly documentRevision: string;
    readonly indexBytes: Uint8Array;
    readonly byteLength: number;
}

const workerIndexCache = new Map<string, IWorkerCachedIndex>();
let workerIndexCacheBytes = 0;
let workerIndexCacheEvictionEpoch = 0;
let workerIndexCacheIdleTimer: ReturnType<typeof setTimeout> | null = null;

function clearWorkerIndexCacheIdleTimer() {
    if (workerIndexCacheIdleTimer !== null) {
        clearTimeout(workerIndexCacheIdleTimer);
        workerIndexCacheIdleTimer = null;
    }
}

function scheduleWorkerIndexCacheIdleClear() {
    clearWorkerIndexCacheIdleTimer();
    if (workerIndexCache.size === 0) {
        return;
    }
    workerIndexCacheIdleTimer = setTimeout(() => {
        workerIndexCacheIdleTimer = null;
        workerIndexCacheEvictionEpoch += 1;
        workerIndexCache.clear();
        workerIndexCacheBytes = 0;
    }, WORKER_INDEX_CACHE_IDLE_TTL_MS);
}

function evictWorkerIndexCache(documentKey?: string) {
    workerIndexCacheEvictionEpoch += 1;
    if (documentKey === undefined) {
        workerIndexCache.clear();
        workerIndexCacheBytes = 0;
        clearWorkerIndexCacheIdleTimer();
        return;
    }
    const existing = workerIndexCache.get(documentKey);
    if (!existing) {
        return;
    }
    workerIndexCache.delete(documentKey);
    workerIndexCacheBytes -= existing.byteLength;
    if (workerIndexCache.size === 0) {
        clearWorkerIndexCacheIdleTimer();
    }
}

function getCachedWorkerIndex(documentKey: string, documentRevision: string): Uint8Array | null {
    const entry = workerIndexCache.get(documentKey);
    if (!entry) {
        return null;
    }
    if (entry.documentRevision !== documentRevision) {
        evictWorkerIndexCache(documentKey);
        return null;
    }
    workerIndexCache.delete(documentKey);
    workerIndexCache.set(documentKey, entry);
    scheduleWorkerIndexCacheIdleClear();
    return entry.indexBytes;
}

function storeCachedWorkerIndex(documentKey: string, documentRevision: string, indexBytes: Uint8Array) {
    evictWorkerIndexCache(documentKey);
    const byteLength = indexBytes.byteLength;
    if (byteLength === 0 || byteLength > WORKER_INDEX_CACHE_MAX_BYTES) {
        return;
    }
    while (workerIndexCache.size > 0 && workerIndexCacheBytes + byteLength > WORKER_INDEX_CACHE_MAX_BYTES) {
        const oldestKey = workerIndexCache.keys().next().value;
        if (typeof oldestKey !== 'string') {
            break;
        }
        evictWorkerIndexCache(oldestKey);
    }
    workerIndexCache.set(documentKey, {
        documentRevision,
        indexBytes,
        byteLength,
    });
    workerIndexCacheBytes += byteLength;
    scheduleWorkerIndexCacheIdleClear();
}

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
        // Release cached index bytes on WASM failure/memory pressure.
        evictWorkerIndexCache();
        throw new Error(outcome.error.message);
    }
    return outcome.output;
}

async function handleIndexRequest(request: IBrowserSearchWorkerRequest<'index'>): Promise<{
    data: IBrowserSearchWorkerResultMap['index'];
    transfer: Transferable[];
}> {
    const {documentKey, documentRevision, pageCount, pagesBuffer, maxPageTextBytes, maxTotalTextBytes} = request.payload;
    if (documentKey !== undefined) {
        evictWorkerIndexCache(documentKey);
    }
    const cacheEpoch = workerIndexCacheEvictionEpoch;
    const output = await runWasm(
        encodePdfSearchWasmRequest(
            {
                op: 'index',
                documentRevision,
                pageCount,
                maxPageTextBytes: maxPageTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
                maxTotalTextBytes: maxTotalTextBytes ?? SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
            },
            pagesBuffer,
        ),
    );
    const decoded = decodePdfSearchIndexWasmOutput(output);
    if (
        documentKey !== undefined &&
        workerIndexCacheEvictionEpoch === cacheEpoch &&
        decoded.indexBytes.byteLength <= WORKER_INDEX_CACHE_MAX_BYTES
    ) {
        // Retain a worker-owned copy before transferring `decoded.indexBytes.buffer` to the main thread.
        storeCachedWorkerIndex(documentKey, documentRevision, decoded.indexBytes.slice());
    }
    return {
        data: decoded,
        transfer: [decoded.indexBytes.buffer],
    };
}

async function handleSearchRequest(request: IBrowserSearchWorkerRequest<'search'>): Promise<IBrowserSearchWorkerResultMap['search']> {
    const {documentKey, indexBytes, documentRevision, query, options, limit, contextChars, resultOffset} = request.payload;
    validateSearchQuery(query, options);
    const cacheEpoch = workerIndexCacheEvictionEpoch;
    const effectiveIndexBytes = indexBytes ?? (documentKey === undefined ? null : getCachedWorkerIndex(documentKey, documentRevision));
    if (effectiveIndexBytes === null) {
        return {cacheMiss: true};
    }
    // Warm the WASM instance before signaling start so cold download/compile never spends the timeout.
    await pdfSearchWasm.load();
    self.postMessage({
        id: request.id,
        started: true,
    } satisfies TBrowserSearchWorkerResponse);
    const output = await runWasm(
        encodePdfSearchWasmRequest(
            {
                op: 'search',
                documentRevision,
                query,
                limit,
                contextChars,
                ...(resultOffset === undefined ? {} : {resultOffset}),
                matchCase: options.matchCase,
                wholeWord: options.wholeWord,
                useRegex: options.useRegex,
            },
            effectiveIndexBytes,
        ),
    );
    const decoded = decodePdfSearchJsonOutput(output);
    if (isStaleSearchIndexAnswer(decoded)) {
        if (documentKey !== undefined) {
            evictWorkerIndexCache(documentKey);
        }
        return {stale: true};
    }
    const parsed = v.safeParse(SEARCH_INDEX_RESPONSE_SCHEMA, decoded, {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search returned an invalid search response');
    }
    if (indexBytes !== undefined && documentKey !== undefined && workerIndexCacheEvictionEpoch === cacheEpoch) {
        storeCachedWorkerIndex(documentKey, documentRevision, indexBytes);
    }
    return parsed.output;
}

async function runMatchPageWasm(
    text: string,
    query: string,
    options: {matchCase: boolean; wholeWord: boolean; useRegex: boolean},
    maxMatches: number,
    resultOffset: number | 'last' | undefined,
) {
    const output = await runWasm(
        encodePdfSearchWasmRequest(
            {
                op: 'matchPage',
                query,
                matchCase: options.matchCase,
                wholeWord: options.wholeWord,
                useRegex: options.useRegex,
                maxMatches,
                ...(resultOffset === undefined ? {} : {resultOffset}),
            },
            textEncoder.encode(text),
        ),
    );
    const parsed = v.safeParse(PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA, decodePdfSearchJsonOutput(output), {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search returned an invalid page match response');
    }
    return parsed.output;
}

async function handleMatchPageTextRequest(
    request: IBrowserSearchWorkerRequest<'matchPageText'>,
): Promise<IBrowserSearchWorkerResultMap['matchPageText']> {
    const {text, query, options, maxMatches, resultOffset} = request.payload;
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
    const parsed = await runMatchPageWasm(text, query, options, maxMatches, resultOffset);
    return {
        ...parsed,
        matchingMs: Date.now() - startedAtMs,
    };
}

async function handleMatchPageBatchRequest(
    request: IBrowserSearchWorkerRequest<'matchPageBatch'>,
): Promise<IBrowserSearchWorkerResultMap['matchPageBatch']> {
    const {pages, query, options, maxMatches, resultOffset} = request.payload;
    validateSearchQuery(query, options);
    if (pages.every((page) => page.text.length === 0)) {
        return {
            pages: pages.map((page) => ({
                pageNumber: page.pageNumber,
                matches: [],
                truncated: false,
                matchCount: 0,
            })),
            matchingMs: 0,
        };
    }
    await pdfSearchWasm.load();
    const startedAtMs = Date.now();
    self.postMessage({
        id: request.id,
        started: true,
    } satisfies TBrowserSearchWorkerResponse);
    const pageResults: IBrowserSearchWorkerResultMap['matchPageBatch']['pages'] = [];
    let batchMatchedCount = 0;
    let collectedCount = 0;
    for (const page of pages) {
        if (page.text.length === 0) {
            pageResults.push({
                pageNumber: page.pageNumber,
                matches: [],
                truncated: false,
                matchCount: 0,
            });
            continue;
        }
        const pageOffset = resultOffset === 'last' ? 'last' : Math.max(0, (resultOffset ?? 0) - batchMatchedCount);
        const pageMaxMatches = resultOffset === 'last' ? maxMatches : maxMatches - collectedCount;
        if (resultOffset !== 'last' && pageMaxMatches <= 0) {
            break;
        }
        const matched = await runMatchPageWasm(page.text, query, options, pageMaxMatches, pageOffset);
        pageResults.push({
            pageNumber: page.pageNumber,
            ...matched,
        });
        batchMatchedCount += matched.matchCount;
        collectedCount += matched.matches.length;
        if (resultOffset !== 'last' && (matched.truncated || collectedCount >= maxMatches)) {
            break;
        }
    }
    return {
        pages: pageResults,
        matchingMs: Date.now() - startedAtMs,
    };
}

// The worker only builds and searches text via evb-pdf-search.wasm. Page text
// comes from the renderer's own PDF.js or DjVu.js document, so terminating this
// worker on cancel never touches a document.
self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) {
        return;
    }
    if (isRecord(event.data) && event.data.type === 'evictCache') {
        evictWorkerIndexCache(typeof event.data.documentKey === 'string' ? event.data.documentKey : undefined);
        return;
    }
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
            case 'matchPageBatch':
                data = await handleMatchPageBatchRequest(request);
                break;
        }
        self.postMessage(
            {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            } as TBrowserSearchWorkerResponse,
            transfer,
        );
    } catch (error) {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
            ...(error instanceof SearchRegexLimitError ? {errorCode: 'SEARCH_REGEX_LIMIT' as const} : {}),
        } satisfies TBrowserSearchWorkerResponse);
    }
});
