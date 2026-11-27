import {getErrorMessage} from '@app/utils/error';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
    TSearchResultOffset,
} from '@contracts/search';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_REGEX_MAX_EXECUTION_MS,
    SEARCH_RESULT_LIMIT,
} from '@contracts/search';
import {
    concatUint8Arrays,
    encodePdfSearchPageRecord,
    isStaleSearchIndexAnswer,
    SEARCH_INDEX_TEXT_BUDGET,
} from '@contracts/searchIndexWire';
import {isRecord} from '@contracts/runtimeGuards';
import {
    buildPdfSearchExcerpt,
    validateSearchQuery,
} from '@pdf-core/pdfSearchCore';
import {
    collectSearchMatchWordsFromIndex,
    createSearchPageWordIndex,
    type ISearchPageWordIndex,
} from '@pdf-core/collectSearchMatchWords';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    SEARCH_PLATFORM_FEATURE,
    ISearchCapability,
} from '@contracts/searchPlatformFeature';
import type {TFeatureBrowserBindings} from '@contracts/platformFeature';
import {
    BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS,
    BrowserSearchWorkerTimeoutError,
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
} from '@app/platform/browser-api/browserSearchWorkerClient';
import {matchBrowserSearchPageWindowInWorker} from '@app/platform/browser-api/matchBrowserSearchPageWindow';
import type {IExtractedBrowserSearchPage} from '@app/platform/browser-api/browserSearchCore';
import {yieldToBrowser} from '@app/platform/browser-api/browserYield';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    createRequestId,
    type IOcrWord,
    type TRequestId,
} from '@contracts/shared';
import {BrowserLogger} from '@app/utils/browserLogger';
import {resolveBrowserCapabilityTier} from '@app/platform/browser/browserCapabilityTier';
import {SearchRegexLimitError} from '@pdf-core';

interface ISearchPageGeometry {
    words: readonly IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

interface ICachedWasmSearchIndex {
    pageCount: number;
    indexBytes: Uint8Array;
    pageGeometries: Map<number, ISearchPageGeometry>;
}

interface IPersistedWasmSearchIndexRecord {
    version: number;
    pdfPath: string;
    fileSize: number;
    contentSignature: string;
    documentRevision: string;
    pageCount: number;
    indexBytes: Uint8Array;
    textBytes: number;
    lastAccessedAt: number;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: (pdfPath?: string) => Promise<void>;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;

const SEARCH_GEOMETRY_CACHE_LIMIT = 24;
const SEARCH_DOCUMENT_CACHE_LIMIT = 4;
const SEARCH_INDEX_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SEARCH_PERSISTED_CACHE_MAX_RECORDS = 16;
const SEARCH_PERSISTED_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const SEARCH_CACHE_DB_NAME = 'evb-browser-search-cache';
const SEARCH_CACHE_DB_VERSION = 2;
// Version 12 stores unified EVBSIDX4 binary indexes built by evb-pdf-search.wasm.
const SEARCH_CACHE_RECORD_VERSION = 12;
const SEARCH_CACHE_STORE = 'document-text';
const SEARCH_CACHE_LAST_ACCESSED_INDEX = 'last-accessed-at';
let searchCacheAccessSequence = 0;

function isBrowserSearchCanceledError(error: unknown) {
    return error instanceof Error && getErrorMessage(error) === 'ERR_BROWSER_SEARCH_CANCELED';
}

function createSearchCacheAccessTimestamp() {
    searchCacheAccessSequence += 1;
    return (Date.now() * 1000) + searchCacheAccessSequence;
}

function idbRequest<T>(request: IDBRequest<T>, errorMessage: string): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

function openSearchCacheDb(): Promise<IDBDatabase | null> {
    const {indexedDbFactory} = resolveBrowserCapabilityTier();
    if (!indexedDbFactory) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const request = indexedDbFactory.open(SEARCH_CACHE_DB_NAME, SEARCH_CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(SEARCH_CACHE_STORE)
                ? request.transaction?.objectStore(SEARCH_CACHE_STORE)
                : db.createObjectStore(SEARCH_CACHE_STORE, {keyPath: 'pdfPath'});
            if (store && !store.indexNames.contains(SEARCH_CACHE_LAST_ACCESSED_INDEX)) {
                store.createIndex(SEARCH_CACHE_LAST_ACCESSED_INDEX, 'lastAccessedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open search cache database'));
    });
}

async function runSearchCacheTransaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
) {
    const db = await openSearchCacheDb();
    if (!db) return null;
    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, mode);
        let txError: unknown = null;
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error('Search cache transaction failed'));
            tx.onerror = () => reject(tx.error ?? new Error('Search cache transaction failed'));
        }).catch((error: unknown) => {
            txError = error;
        });
        try {
            const result = await run(tx.objectStore(SEARCH_CACHE_STORE));
            await done;
            if (txError) throw txError instanceof Error ? txError : new Error(getErrorMessage(txError));
            return result;
        } catch (error) {
            await done;
            throw error instanceof Error ? error : new Error(getErrorMessage(error));
        }
    } finally {
        db.close();
    }
}

function parsePersistedIndexRecord(value: unknown): IPersistedWasmSearchIndexRecord | null {
    if (!isRecord(value)) return null;
    if (
        value.version !== SEARCH_CACHE_RECORD_VERSION
        || typeof value.pdfPath !== 'string'
        || typeof value.fileSize !== 'number'
        || !Number.isFinite(value.fileSize)
        || value.fileSize < 0
        || typeof value.contentSignature !== 'string'
        || typeof value.documentRevision !== 'string'
        || typeof value.pageCount !== 'number'
        || !Number.isInteger(value.pageCount)
        || value.pageCount < 1
        || !(value.indexBytes instanceof Uint8Array)
        || value.indexBytes.byteLength === 0
        || value.indexBytes.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES
        || value.textBytes !== value.indexBytes.byteLength
    ) {
        return null;
    }
    return {
        version: value.version,
        pdfPath: value.pdfPath,
        fileSize: value.fileSize,
        contentSignature: value.contentSignature,
        documentRevision: value.documentRevision,
        pageCount: value.pageCount,
        indexBytes: value.indexBytes,
        textBytes: value.textBytes,
        lastAccessedAt: typeof value.lastAccessedAt === 'number' ? value.lastAccessedAt : 0,
    };
}

function bestEffortCache<T>(operation: Promise<T>) {
    return operation.catch((error: unknown) => {
        BrowserLogger.warn('search', 'Search cache is unavailable; searching without it', {error});
        return null;
    });
}

async function prunePersistedSearchCaches() {
    await runSearchCacheTransaction('readwrite', store => new Promise<void>((resolve, reject) => {
        let keptRecords = 0;
        let keptBytes = 0;
        const request = store.index(SEARCH_CACHE_LAST_ACCESSED_INDEX).openCursor(null, 'prev');
        request.onerror = () => reject(request.error ?? new Error('Failed to prune search cache records'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            const record = parsePersistedIndexRecord(cursor.value);
            const recordBytes = record?.textBytes ?? 0;
            if (
                record === null
                || keptRecords >= SEARCH_PERSISTED_CACHE_MAX_RECORDS
                || keptBytes + recordBytes > SEARCH_PERSISTED_CACHE_MAX_BYTES
            ) {
                cursor.delete();
            } else {
                keptRecords += 1;
                keptBytes += recordBytes;
            }
            cursor.continue();
        };
    }));
}

function hasPageGeometry(page: Pick<IExtractedBrowserSearchPage, 'words' | 'pageWidth' | 'pageHeight'>): page is {
    words: IOcrWord[];
    pageWidth: number;
    pageHeight: number;
} {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0;
}

function rememberPageGeometry(
    geometries: Map<number, ISearchPageGeometry>,
    page: IExtractedBrowserSearchPage,
) {
    if (!hasPageGeometry(page)) {
        geometries.delete(page.pageNumber);
        return;
    }
    geometries.delete(page.pageNumber);
    geometries.set(page.pageNumber, {
        words: page.words,
        pageWidth: page.pageWidth,
        pageHeight: page.pageHeight,
    });
    while (geometries.size > SEARCH_GEOMETRY_CACHE_LIMIT) {
        const oldest = geometries.keys().next().value;
        if (typeof oldest !== 'number') break;
        geometries.delete(oldest);
    }
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const memoryIndexCache = new Map<string, ICachedWasmSearchIndex>();
    const activeSearchRequests = new Map<TRequestId, {
        generation: number;
        canceled: boolean;
        abort: AbortController;
    }>();
    let nextSearchGeneration = 0;

    function getCacheKey(pdfPath: string, documentRevision: string) {
        return `${pdfPath}\0${documentRevision}`;
    }

    function deleteDocumentMemoryCaches(pdfPath: string) {
        const prefix = `${pdfPath}\0`;
        for (const key of memoryIndexCache.keys()) {
            if (key === pdfPath || key.startsWith(prefix)) {
                memoryIndexCache.delete(key);
            }
        }
    }

    function storeMemoryIndex(key: string, entry: ICachedWasmSearchIndex) {
        memoryIndexCache.delete(key);
        while (memoryIndexCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT) {
            const oldestKey = memoryIndexCache.keys().next().value;
            if (typeof oldestKey !== 'string') break;
            memoryIndexCache.delete(oldestKey);
        }
        memoryIndexCache.set(key, entry);
    }

    async function clearSearchCaches(pdfPath?: string) {
        if (pdfPath) {
            deleteDocumentMemoryCaches(pdfPath);
            await runSearchCacheTransaction('readwrite', store =>
                idbRequest(store.delete(pdfPath), 'Failed to delete search cache record').then(() => undefined));
            return;
        }
        memoryIndexCache.clear();
        await runSearchCacheTransaction('readwrite', store =>
            idbRequest(store.clear(), 'Failed to clear search cache records').then(() => undefined));
    }

    function startSearchRequest(requestId: TRequestId | undefined) {
        if (!requestId) return undefined;
        const generation = ++nextSearchGeneration;
        activeSearchRequests.get(requestId)?.abort.abort();
        activeSearchRequests.set(requestId, {
            generation,
            canceled: false,
            abort: new AbortController(),
        });
        return generation;
    }

    function isCanceled(requestId: TRequestId | undefined, generation: number | undefined) {
        if (!requestId) return false;
        const active = activeSearchRequests.get(requestId);
        return !active || active.generation !== generation || active.canceled;
    }

    function getRequestSignal(requestId: TRequestId | undefined, generation: number | undefined) {
        const active = requestId === undefined ? undefined : activeSearchRequests.get(requestId);
        return active?.generation === generation ? active?.abort.signal : undefined;
    }

    function finishSearchRequest(requestId: TRequestId | undefined, generation: number | undefined) {
        if (!requestId) return;
        const active = activeSearchRequests.get(requestId);
        if (active?.generation === generation) {
            activeSearchRequests.delete(requestId);
        }
    }

    function emitSearchProgress(progress: IPdfSearchProgress) {
        searchProgressListeners.forEach(listener => listener(progress));
    }

    async function resolveSearchDocumentRevision(pdfPath: string, requestedRevision: string | undefined) {
        const currentRevision = await browserDocumentStore.getDocumentRevision(pdfPath);
        return requestedRevision === currentRevision.token
            ? requestedRevision
            : currentRevision.token;
    }

    async function loadCachedIndex(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        expectedPageCount: number | undefined,
    ): Promise<ICachedWasmSearchIndex | null> {
        const cacheKey = getCacheKey(pdfPath, documentRevision);
        const cached = memoryIndexCache.get(cacheKey);
        if (cached) {
            if (typeof expectedPageCount !== 'number' || expectedPageCount === cached.pageCount) {
                memoryIndexCache.delete(cacheKey);
                memoryIndexCache.set(cacheKey, cached);
                return cached;
            }
            memoryIndexCache.delete(cacheKey);
        }
        const rawPersisted = await bestEffortCache(runSearchCacheTransaction('readonly', store =>
            idbRequest<unknown>(store.get(pdfPath), 'Failed to read search cache record')));
        if (rawPersisted === null || rawPersisted === undefined) return null;
        const persisted = parsePersistedIndexRecord(rawPersisted);
        if (
            persisted
            && persisted.fileSize === fileSize
            && persisted.contentSignature === contentSignature
            && persisted.documentRevision === documentRevision
            && (typeof expectedPageCount !== 'number' || expectedPageCount <= 0 || persisted.pageCount === expectedPageCount)
        ) {
            void bestEffortCache(runSearchCacheTransaction('readwrite', store =>
                idbRequest(store.put({
                    ...persisted,
                    lastAccessedAt: createSearchCacheAccessTimestamp(),
                }), 'Failed to touch search cache record')));
            const hydrated: ICachedWasmSearchIndex = {
                pageCount: persisted.pageCount,
                indexBytes: persisted.indexBytes,
                pageGeometries: new Map(),
            };
            storeMemoryIndex(cacheKey, hydrated);
            return hydrated;
        }
        await bestEffortCache(runSearchCacheTransaction('readwrite', store =>
            idbRequest(store.delete(pdfPath), 'Failed to delete stale search cache record')));
        return null;
    }

    async function buildAndPersistIndex(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        pageCount: number,
        pagesBuffer: Uint8Array,
        pageGeometries: Map<number, ISearchPageGeometry>,
        signal: AbortSignal | undefined,
    ) {
        if (!canUseBrowserSearchWorker()) return null;
        const workerReq = createBrowserSearchWorkerRequest('index', {
            documentRevision,
            pageCount,
            pagesBuffer,
            maxPageTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
            maxTotalTextBytes: SEARCH_INDEX_CACHE_MAX_BYTES,
        });
        const cancel = () => cancelBrowserSearchWorkerRequest(workerReq.requestId);
        signal?.addEventListener('abort', cancel, {once: true});
        let built;
        try {
            built = await workerReq.promise;
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
        if (built.coverage.truncated || built.indexBytes.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
            return null;
        }
        const entry: ICachedWasmSearchIndex = {
            pageCount,
            indexBytes: built.indexBytes,
            pageGeometries,
        };
        storeMemoryIndex(getCacheKey(pdfPath, documentRevision), entry);
        await bestEffortCache((async () => {
            await runSearchCacheTransaction('readwrite', store =>
                idbRequest(store.put({
                    version: SEARCH_CACHE_RECORD_VERSION,
                    pdfPath,
                    fileSize,
                    contentSignature,
                    documentRevision,
                    pageCount,
                    indexBytes: built.indexBytes,
                    textBytes: built.indexBytes.byteLength,
                    lastAccessedAt: createSearchCacheAccessTimestamp(),
                } satisfies IPersistedWasmSearchIndexRecord), 'Failed to write search cache record'));
            await prunePersistedSearchCaches();
        })());
        return entry;
    }

    async function attachGeometryToIndexedResults(
        pdfPath: string,
        cached: ICachedWasmSearchIndex,
        results: IPdfSearchResult[],
        requestId: TRequestId | undefined,
        requestGeneration: number | undefined,
        signal: AbortSignal | undefined,
    ) {
        if (results.length === 0) return results;
        const missingPages = new Set<number>();
        for (const result of results) {
            if (!cached.pageGeometries.has(result.pageNumber)) {
                missingPages.add(result.pageNumber);
            }
        }
        const resolvedGeometries = new Map<number, ISearchPageGeometry>();
        for (const result of results) {
            const cachedGeometry = cached.pageGeometries.get(result.pageNumber);
            if (cachedGeometry) {
                resolvedGeometries.set(result.pageNumber, cachedGeometry);
            }
        }
        if (missingPages.size > 0) {
            const {loadBrowserSearchDocument} = await import('@app/platform/browser-api/browserSearchCore');
            const doc = await loadBrowserSearchDocument(pdfPath);
            try {
                for (const pageNumber of missingPages) {
                    if (isCanceled(requestId, requestGeneration)) return [];
                    const page = await doc.extractPage(pageNumber, {
                        shouldContinue: () => !isCanceled(requestId, requestGeneration),
                        ...(signal === undefined ? {} : {signal}),
                    });
                    rememberPageGeometry(cached.pageGeometries, page);
                    if (hasPageGeometry(page)) {
                        resolvedGeometries.set(pageNumber, {
                            words: page.words,
                            pageWidth: page.pageWidth,
                            pageHeight: page.pageHeight,
                        });
                    }
                }
            } finally {
                await doc.destroy();
            }
        }
        const wordIndexes = new Map<number, ISearchPageWordIndex | null>();
        return results.map(result => {
            const geometry = resolvedGeometries.get(result.pageNumber) ?? cached.pageGeometries.get(result.pageNumber);
            if (!geometry) return result;
            let wordIndex = wordIndexes.get(result.pageNumber);
            if (wordIndex === undefined) {
                wordIndex = createSearchPageWordIndex(geometry);
                wordIndexes.set(result.pageNumber, wordIndex);
            }
            const words = wordIndex === null
                ? undefined
                : collectSearchMatchWordsFromIndex(wordIndex, result.startOffset, result.endOffset);
            return words === undefined
                ? result
                : {
                    ...result,
                    words,
                    pageWidth: geometry.pageWidth,
                    pageHeight: geometry.pageHeight,
                };
        });
    }

    async function searchCachedIndex(
        pdfPath: string,
        documentRevision: string,
        cached: ICachedWasmSearchIndex,
        query: string,
        matchOptions: {
            matchCase: boolean;
            wholeWord: boolean;
            useRegex: boolean;
        },
        resultOffset: TSearchResultOffset,
        requestId: TRequestId,
        requestGeneration: number | undefined,
        signal: AbortSignal | undefined,
    ): Promise<IPdfSearchResponse | null> {
        const workerReq = createBrowserSearchWorkerRequest(
            'search',
            {
                indexBytes: cached.indexBytes,
                documentRevision,
                query,
                options: matchOptions,
                limit: SEARCH_RESULT_LIMIT,
                contextChars: SEARCH_EXCERPT_CONTEXT_CHARS,
                resultOffset,
            },
            matchOptions.useRegex ? {matchTimeoutMs: BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS} : {},
        );
        const cancel = () => cancelBrowserSearchWorkerRequest(workerReq.requestId);
        signal?.addEventListener('abort', cancel, {once: true});
        let rawResponse;
        try {
            rawResponse = await workerReq.promise;
        } catch (error) {
            if (error instanceof BrowserSearchWorkerTimeoutError) {
                throw new SearchRegexLimitError(
                    `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`,
                );
            }
            if (isBrowserSearchCanceledError(error) || isCanceled(requestId, requestGeneration)) {
                return {
                    results: [],
                    truncated: false,
                };
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
        if (isCanceled(requestId, requestGeneration)) {
            return {
                results: [],
                truncated: false,
            };
        }
        if (isStaleSearchIndexAnswer(rawResponse)) {
            memoryIndexCache.delete(getCacheKey(pdfPath, documentRevision));
            return null;
        }
        let results: IPdfSearchResult[];
        try {
            results = await attachGeometryToIndexedResults(
                pdfPath,
                cached,
                rawResponse.results,
                requestId,
                requestGeneration,
                signal,
            );
        } catch (error) {
            if (isBrowserSearchCanceledError(error) || isCanceled(requestId, requestGeneration)) {
                return {
                    results: [],
                    truncated: false,
                };
            }
            throw error;
        }
        if (isCanceled(requestId, requestGeneration)) {
            return {
                results: [],
                truncated: false,
            };
        }
        emitSearchProgress({
            requestId,
            processed: cached.pageCount,
            total: cached.pageCount,
            ...(matchOptions.useRegex || resultOffset === 'last' ? {} : {
                results,
                resultsStartIndex: 0,
                truncated: rawResponse.truncated,
            }),
        });
        return {
            results,
            truncated: rawResponse.truncated,
        };
    }

    const capability = {
        async run(pdfPath, query, options = {}) {
            if (query.length === 0) {
                return {
                    results: [],
                    truncated: false,
                };
            }
            const matchOptions = {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            };
            validateSearchQuery(query, matchOptions);
            if (!canUseBrowserSearchWorker()) {
                throw new BrowserSearchWorkerUnavailableError(
                    matchOptions.useRegex
                        ? 'Browser search worker is required for regular expression search'
                        : 'Browser search worker is required for document search',
                );
            }

            const requestId = options.requestId ?? createRequestId('browser-search');
            const resultOffset = options.resultOffset ?? 0;
            const requestGeneration = startSearchRequest(requestId);
            const signal = getRequestSignal(requestId, requestGeneration);
            try {
                const {
                    size, contentSignature,
                } = await browserDocumentStore.getContentSnapshot(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const cached = await loadCachedIndex(
                    pdfPath,
                    size,
                    contentSignature,
                    documentRevision,
                    options.pageCount,
                );
                if (cached) {
                    const indexedResponse = await searchCachedIndex(
                        pdfPath,
                        documentRevision,
                        cached,
                        query,
                        matchOptions,
                        resultOffset,
                        requestId,
                        requestGeneration,
                        signal,
                    );
                    if (indexedResponse !== null) return indexedResponse;
                }

                // Cold search: stream pages through evb-pdf-search.wasm page-by-page for
                // live progress and early truncation, then build the EVBSIDX4 index if complete.
                const {streamBrowserSearchDocumentPages} = await import('@app/platform/browser-api/browserSearchCore');
                const results: IPdfSearchResult[] = [];
                const pageChunks: Uint8Array[] = [];
                const pageGeometries = new Map<number, ISearchPageGeometry>();
                let bufferedBytes = 0;
                let canCacheIndex = true;
                let emittedResultCount = 0;
                let truncated = false;
                let matchedCount = 0;
                let totalPages = 0;
                let completedAllPages = true;

                try {
                    for await (const page of streamBrowserSearchDocumentPages(pdfPath, {
                        shouldContinue: () => !isCanceled(requestId, requestGeneration),
                        ...(signal === undefined ? {} : {signal}),
                    })) {
                        if (isCanceled(requestId, requestGeneration)) {
                            completedAllPages = false;
                            break;
                        }
                        totalPages = page.pageCount;
                        rememberPageGeometry(pageGeometries, page);
                        if (canCacheIndex) {
                            const encoded = encodePdfSearchPageRecord({
                                pageNumber: page.pageNumber,
                                text: page.text,
                            });
                            if (bufferedBytes + encoded.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
                                canCacheIndex = false;
                                pageChunks.length = 0;
                            } else {
                                pageChunks.push(encoded);
                                bufferedBytes += encoded.byteLength;
                            }
                        }

                        const matchResult = await matchBrowserSearchPageWindowInWorker(
                            page.text,
                            query,
                            matchOptions,
                            resultOffset === 'last' ? SEARCH_RESULT_LIMIT : (SEARCH_RESULT_LIMIT - results.length) + 1,
                            resultOffset === 'last' ? 'last' : Math.max(0, resultOffset - matchedCount),
                            {remainingMs: SEARCH_REGEX_MAX_EXECUTION_MS},
                            signal ?? new AbortController().signal,
                        );
                        if (isCanceled(requestId, requestGeneration)) {
                            completedAllPages = false;
                            break;
                        }
                        const pageWordIndex = matchResult.matches.length > 0
                            ? createSearchPageWordIndex(page)
                            : null;
                        for (const match of matchResult.matches) {
                            if (resultOffset !== 'last' && results.length >= SEARCH_RESULT_LIMIT) {
                                truncated = true;
                                completedAllPages = false;
                                emitSearchProgress({
                                    requestId,
                                    processed: page.pageNumber,
                                    total: page.pageCount,
                                    results: results.slice(emittedResultCount),
                                    resultsStartIndex: emittedResultCount,
                                    truncated: true,
                                });
                                emittedResultCount = results.length;
                                break;
                            }
                            const matchIndex = matchedCount + match.pageMatchIndex;
                            const words = pageWordIndex === null
                                ? undefined
                                : collectSearchMatchWordsFromIndex(pageWordIndex, match.startOffset, match.endOffset);
                            const hit: IPdfSearchResult = {
                                pageNumber: requirePageNumber(page.pageNumber),
                                pageMatchIndex: match.pageMatchIndex,
                                matchIndex,
                                startOffset: match.startOffset,
                                endOffset: match.endOffset,
                                excerpt: buildPdfSearchExcerpt(
                                    page.text,
                                    match.startOffset,
                                    match.endOffset,
                                    SEARCH_EXCERPT_CONTEXT_CHARS,
                                ),
                                ...(words !== undefined ? {words} : {}),
                                ...(words !== undefined && page.pageWidth !== undefined ? {pageWidth: page.pageWidth} : {}),
                                ...(words !== undefined && page.pageHeight !== undefined ? {pageHeight: page.pageHeight} : {}),
                            };
                            if (resultOffset === 'last') results[matchIndex % SEARCH_RESULT_LIMIT] = hit;
                            else results.push(hit);
                        }
                        matchedCount += matchResult.matchCount;
                        if (truncated) break;

                        const delta = results.slice(emittedResultCount);
                        emitSearchProgress({
                            requestId,
                            processed: page.pageNumber,
                            total: page.pageCount,
                            ...(matchOptions.useRegex || resultOffset === 'last' ? {} : {
                                results: delta,
                                resultsStartIndex: emittedResultCount,
                                truncated: false,
                            }),
                        });
                        emittedResultCount = results.length;
                        await yieldToBrowser();
                    }
                } catch (error) {
                    if (isBrowserSearchCanceledError(error) || isCanceled(requestId, requestGeneration)) {
                        return {
                            results: [],
                            truncated: false,
                        };
                    }
                    throw error;
                }

                if (isCanceled(requestId, requestGeneration)) {
                    return {
                        results: [],
                        truncated: false,
                    };
                }
                if (completedAllPages && canCacheIndex && totalPages > 0) {
                    const pagesBuffer = concatUint8Arrays(pageChunks, bufferedBytes);
                    pageChunks.length = 0;
                    await bestEffortCache(buildAndPersistIndex(
                        pdfPath,
                        size,
                        contentSignature,
                        documentRevision,
                        totalPages,
                        pagesBuffer,
                        pageGeometries,
                        signal,
                    ));
                }
                results.sort((first, second) => first.matchIndex - second.matchIndex);
                return {
                    results,
                    truncated,
                } satisfies IPdfSearchResponse;
            } finally {
                finishSearchRequest(requestId, requestGeneration);
            }
        },

        async warmIndex(pdfPath, options = {}) {
            const requestId = options.requestId;
            const requestGeneration = startSearchRequest(requestId);
            const signal = getRequestSignal(requestId, requestGeneration);
            try {
                const {
                    size, contentSignature,
                } = await browserDocumentStore.getContentSnapshot(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const existing = await loadCachedIndex(
                    pdfPath,
                    size,
                    contentSignature,
                    documentRevision,
                    options.pageCount,
                );
                if (existing) {
                    if (requestId) {
                        emitSearchProgress({
                            requestId,
                            processed: existing.pageCount,
                            total: existing.pageCount,
                        });
                    }
                    return !isCanceled(requestId, requestGeneration);
                }

                const {streamBrowserSearchDocumentPages} = await import('@app/platform/browser-api/browserSearchCore');
                const pageChunks: Uint8Array[] = [];
                const pageGeometries = new Map<number, ISearchPageGeometry>();
                let bufferedBytes = 0;
                let canCacheIndex = true;
                let totalPages = 0;

                try {
                    for await (const page of streamBrowserSearchDocumentPages(pdfPath, {
                        shouldContinue: () => !isCanceled(requestId, requestGeneration),
                        ...(signal === undefined ? {} : {signal}),
                    })) {
                        if (isCanceled(requestId, requestGeneration)) return false;
                        totalPages = page.pageCount;
                        rememberPageGeometry(pageGeometries, page);
                        if (canCacheIndex) {
                            const encoded = encodePdfSearchPageRecord({
                                pageNumber: page.pageNumber,
                                text: page.text,
                            });
                            if (bufferedBytes + encoded.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
                                canCacheIndex = false;
                                pageChunks.length = 0;
                            } else {
                                pageChunks.push(encoded);
                                bufferedBytes += encoded.byteLength;
                            }
                        }
                        if (requestId) {
                            emitSearchProgress({
                                requestId,
                                processed: page.pageNumber,
                                total: page.pageCount,
                            });
                        }
                        await yieldToBrowser();
                    }
                } catch (error) {
                    if (isBrowserSearchCanceledError(error) || isCanceled(requestId, requestGeneration)) {
                        return false;
                    }
                    throw error;
                }

                if (isCanceled(requestId, requestGeneration)) return false;
                if (canCacheIndex && totalPages > 0) {
                    const pagesBuffer = concatUint8Arrays(pageChunks, bufferedBytes);
                    pageChunks.length = 0;
                    await bestEffortCache(buildAndPersistIndex(
                        pdfPath,
                        size,
                        contentSignature,
                        documentRevision,
                        totalPages,
                        pagesBuffer,
                        pageGeometries,
                        signal,
                    ));
                }
                return true;
            } finally {
                finishSearchRequest(requestId, requestGeneration);
            }
        },

        cancel(requestId) {
            if (requestId) {
                const active = activeSearchRequests.get(requestId);
                if (active) {
                    active.canceled = true;
                    active.abort.abort();
                }
            }
            return Promise.resolve({canceled: true});
        },

        onProgress(callback) {
            searchProgressListeners.add(callback);
            return () => {
                searchProgressListeners.delete(callback);
            };
        },

        async resetCache() {
            await clearSearchCaches();
            return true;
        },
    } satisfies TFeatureBrowserBindings<typeof SEARCH_PLATFORM_FEATURE>;

    return {
        capability,
        clearSearchCaches,
    };
}
