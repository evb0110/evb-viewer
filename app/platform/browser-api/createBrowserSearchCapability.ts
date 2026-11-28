import {getErrorMessage} from '@app/utils/error';
import type {IPdfSearchProgress, IPdfSearchResponse, IPdfSearchResult, TSearchResultOffset} from '@contracts/search';
import {SEARCH_EXCERPT_CONTEXT_CHARS, SEARCH_REGEX_MAX_EXECUTION_MS, SEARCH_RESULT_LIMIT} from '@contracts/search';
import {concatUint8Arrays, encodePdfSearchPageRecord, isStaleSearchIndexAnswer, SEARCH_INDEX_TEXT_BUDGET} from '@contracts/searchIndexWire';
import {isRecord} from '@contracts/runtimeGuards';
import {buildPdfSearchExcerpt, normalizeSearchText, validateSearchQuery} from '@pdf-core/pdfSearchCore';
import {collectSearchMatchWordsFromIndex, createSearchPageWordIndex, type ISearchPageWordIndex} from '@pdf-core/collectSearchMatchWords';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {SEARCH_PLATFORM_FEATURE, ISearchCapability} from '@contracts/searchPlatformFeature';
import type {TFeatureBrowserBindings} from '@contracts/platformFeature';
import {
    BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS,
    BrowserSearchWorkerTimeoutError,
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
    evictBrowserSearchWorkerCache,
} from '@app/platform/browser-api/browserSearchWorkerClient';
import {isCacheMissSearchIndexAnswer} from '@app/platform/browser-api/browserSearchWorker.types';
import {matchBrowserSearchPageWindowInWorker} from '@app/platform/browser-api/matchBrowserSearchPageWindow';
import type {IBrowserSearchDocumentPageRecord, IExtractedBrowserSearchPage} from '@app/platform/browser-api/browserSearchCore';
import {yieldToBrowser} from '@app/platform/browser-api/browserYield';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {createRequestId, type IOcrWord, type TRequestId} from '@contracts/shared';
import {BrowserLogger} from '@app/utils/browserLogger';
import {resolveBrowserCapabilityTier} from '@app/platform/browser/browserCapabilityTier';
import {SearchRegexLimitError} from '@pdf-core';

interface ISearchPageGeometry {
    words: readonly IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

interface ICachedWasmSearchIndex {
    pdfPath: string;
    pageCount: number;
    indexBytes: Uint8Array;
    pageGeometries: Map<number, ISearchPageGeometry>;
    workerHydrated: boolean;
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
}

interface IPersistedWasmSearchMetaRecord {
    version: number;
    pdfPath: string;
    documentRevision: string;
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
const COLD_BATCH_MAX_PAGES = 16;
const COLD_BATCH_MAX_BYTES = 256 * 1024;
const COLD_BATCH_MAX_ELAPSED_MS = 16;
// Separate database name for the split payload/metadata schema so already-open
// tabs running on the legacy `evb-browser-search-cache` v2 database never hit
// IndexedDB `VersionError` during rollout.
const SEARCH_CACHE_DB_NAME = 'evb-browser-search-cache-v2';
const SEARCH_CACHE_DB_VERSION = 2;
// Version 12 stores unified EVBSIDX4 binary indexes built by evb-pdf-search.wasm.
const SEARCH_CACHE_RECORD_VERSION = 12;
const SEARCH_CACHE_STORE = 'document-text';
const SEARCH_CACHE_META_STORE = 'document-meta';
const SEARCH_CACHE_LAST_ACCESSED_INDEX = 'last-accessed-at';
let searchCacheAccessSequence = 0;

function isBrowserSearchCanceledError(error: unknown) {
    return error instanceof Error && getErrorMessage(error) === 'ERR_BROWSER_SEARCH_CANCELED';
}

function createSearchCacheAccessTimestamp() {
    searchCacheAccessSequence += 1;
    return Date.now() * 1000 + searchCacheAccessSequence;
}

function idbRequest<T>(request: IDBRequest<T>, errorMessage: string): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

function openSearchCacheDb(): Promise<IDBDatabase | null> {
    const {indexedDbFactory} = resolveBrowserCapabilityTier();
    if (!indexedDbFactory) {
        return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
        const request = indexedDbFactory.open(SEARCH_CACHE_DB_NAME, SEARCH_CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const hadDataStore = db.objectStoreNames.contains(SEARCH_CACHE_STORE);
            const dataStore = hadDataStore
                ? request.transaction?.objectStore(SEARCH_CACHE_STORE)
                : db.createObjectStore(SEARCH_CACHE_STORE, {keyPath: 'pdfPath'});
            const hadMetaStore = db.objectStoreNames.contains(SEARCH_CACHE_META_STORE);
            const metaStore = hadMetaStore
                ? request.transaction?.objectStore(SEARCH_CACHE_META_STORE)
                : db.createObjectStore(SEARCH_CACHE_META_STORE, {keyPath: 'pdfPath'});
            if (hadDataStore && !hadMetaStore) {
                // Clear rebuildable v2 payloads on upgrade to v3 so no unindexed rows sit outside the pruning budget.
                dataStore?.clear();
            }
            if (metaStore && !metaStore.indexNames.contains(SEARCH_CACHE_LAST_ACCESSED_INDEX)) {
                metaStore.createIndex(SEARCH_CACHE_LAST_ACCESSED_INDEX, 'lastAccessedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open search cache database'));
    });
}

async function runSearchCacheStoresTransaction<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T>,
) {
    const db = await openSearchCacheDb();
    if (!db) {
        return null;
    }
    try {
        const tx = db.transaction(stores, mode);
        let txError: unknown = null;
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error('Search cache transaction failed'));
            tx.onerror = () => reject(tx.error ?? new Error('Search cache transaction failed'));
        }).catch((error: unknown) => {
            txError = error;
        });
        try {
            const result = await run(tx);
            await done;
            if (txError) {
                throw txError instanceof Error ? txError : new Error(getErrorMessage(txError));
            }
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
    if (!isRecord(value)) {
        return null;
    }
    if (
        value.version !== SEARCH_CACHE_RECORD_VERSION ||
        typeof value.pdfPath !== 'string' ||
        typeof value.fileSize !== 'number' ||
        !Number.isFinite(value.fileSize) ||
        value.fileSize < 0 ||
        typeof value.contentSignature !== 'string' ||
        typeof value.documentRevision !== 'string' ||
        typeof value.pageCount !== 'number' ||
        !Number.isInteger(value.pageCount) ||
        value.pageCount < 1 ||
        !(value.indexBytes instanceof Uint8Array) ||
        value.indexBytes.byteLength === 0 ||
        value.indexBytes.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES ||
        value.textBytes !== value.indexBytes.byteLength
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
    };
}

function parsePersistedMetaRecord(value: unknown): IPersistedWasmSearchMetaRecord | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        value.version !== SEARCH_CACHE_RECORD_VERSION ||
        typeof value.pdfPath !== 'string' ||
        typeof value.documentRevision !== 'string' ||
        typeof value.textBytes !== 'number' ||
        !Number.isInteger(value.textBytes) ||
        value.textBytes <= 0 ||
        value.textBytes > SEARCH_INDEX_CACHE_MAX_BYTES ||
        typeof value.lastAccessedAt !== 'number' ||
        !Number.isFinite(value.lastAccessedAt)
    ) {
        return null;
    }
    return {
        version: value.version,
        pdfPath: value.pdfPath,
        documentRevision: value.documentRevision,
        textBytes: value.textBytes,
        lastAccessedAt: value.lastAccessedAt,
    };
}

function bestEffortCache<T>(operation: Promise<T>) {
    return operation.catch((error: unknown) => {
        BrowserLogger.warn('search', 'Search cache is unavailable; searching without it', {error});
        return null;
    });
}

async function prunePersistedSearchCaches() {
    await runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', (tx) => {
        const dataStore = tx.objectStore(SEARCH_CACHE_STORE);
        const metaStore = tx.objectStore(SEARCH_CACHE_META_STORE);
        return new Promise<void>((resolve, reject) => {
            let keptRecords = 0;
            let keptBytes = 0;
            const request = metaStore.index(SEARCH_CACHE_LAST_ACCESSED_INDEX).openCursor(null, 'prev');
            request.onerror = () => reject(request.error ?? new Error('Failed to prune search cache records'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                const record = parsePersistedMetaRecord(cursor.value);
                const recordBytes = record?.textBytes ?? 0;
                const recordPath = record?.pdfPath ?? (typeof cursor.primaryKey === 'string' ? cursor.primaryKey : null);
                if (
                    record === null ||
                    keptRecords >= SEARCH_PERSISTED_CACHE_MAX_RECORDS ||
                    keptBytes + recordBytes > SEARCH_PERSISTED_CACHE_MAX_BYTES
                ) {
                    cursor.delete();
                    if (recordPath !== null) {
                        dataStore.delete(recordPath);
                    }
                } else {
                    keptRecords += 1;
                    keptBytes += recordBytes;
                }
                cursor.continue();
            };
        });
    });
}

function hasPageGeometry(page: Pick<IExtractedBrowserSearchPage, 'words' | 'pageWidth' | 'pageHeight'>): page is {
    words: IOcrWord[];
    pageWidth: number;
    pageHeight: number;
} {
    return (
        Array.isArray(page.words) &&
        page.words.length > 0 &&
        typeof page.pageWidth === 'number' &&
        Number.isFinite(page.pageWidth) &&
        page.pageWidth > 0 &&
        typeof page.pageHeight === 'number' &&
        Number.isFinite(page.pageHeight) &&
        page.pageHeight > 0
    );
}

function rememberPageGeometry(geometries: Map<number, ISearchPageGeometry>, page: IExtractedBrowserSearchPage) {
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
        if (typeof oldest !== 'number') {
            break;
        }
        geometries.delete(oldest);
    }
}

function isAsciiOnly(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) > 0x7f) {
            return false;
        }
    }
    return true;
}

/**
 * Conservative, Unicode-version-independent upper bound on literal matches of
 * `query` in `pageText` (never undercounts, so batching never extracts a
 * subsequent page when already-buffered pages can fill `SEARCH_RESULT_LIMIT`
 * and prove truncation). Uses an exact ASCII scan when both query and page are
 * ASCII, and a code-point length bound for non-ASCII text so differences in
 * browser vs Rust Unicode case-folding tables can never undercount.
 */
function createLiteralMatchUpperBoundEstimator(query: string) {
    const trimmed = query.trim();
    const asciiQuery = isAsciiOnly(trimmed);
    const asciiToken = asciiQuery
        ? trimmed
              .toLowerCase()
              .split(/\s+/u)
              .reduce((best, part) => (part.length > best.length ? part : best), '')
        : '';
    let normalizedQuery: string;
    try {
        normalizedQuery = normalizeSearchText(query);
    } catch {
        normalizedQuery = query;
    }
    const minMatchCodePoints = Math.max(1, [...normalizedQuery.replace(/\s+/gu, ' ')].length);

    return (pageText: string, cap: number): number => {
        if (pageText.length === 0 || cap <= 0) {
            return 0;
        }
        if (trimmed.length === 0) {
            return Math.min(cap, pageText.length);
        }
        if (asciiQuery && isAsciiOnly(pageText)) {
            if (asciiToken.length === 0) {
                return Math.min(cap, pageText.length);
            }
            const lowerText = pageText.toLowerCase();
            let count = 0;
            let position = 0;
            while (count < cap) {
                const found = lowerText.indexOf(asciiToken, position);
                if (found < 0) {
                    break;
                }
                count += 1;
                position = found + 1;
            }
            return count;
        }
        // Every UTF-16 unit expands under ligature/NFC normalization to at most 4 code points,
        // and every non-overlapping literal match consumes at least `minMatchCodePoints` code points.
        return Math.min(cap, Math.floor((pageText.length * 4) / minMatchCodePoints));
    };
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const memoryIndexCache = new Map<string, ICachedWasmSearchIndex>();
    let memoryIndexCacheBytes = 0;
    let cacheResetGeneration = 0;
    const pathInvalidationGenerations = new Map<string, number>();
    const activePersistChains = new Map<string, Promise<void>>();
    const activeSearchRequests = new Map<
        TRequestId,
        {
            generation: number;
            canceled: boolean;
            abort: AbortController;
        }
    >();
    let nextSearchGeneration = 0;

    function getCacheKey(pdfPath: string, documentRevision: string) {
        return `${pdfPath}\0${documentRevision}`;
    }

    function bumpPathInvalidation(pdfPath: string) {
        pathInvalidationGenerations.set(pdfPath, (pathInvalidationGenerations.get(pdfPath) ?? 0) + 1);
    }

    function deleteMemoryIndexKey(key: string) {
        const existing = memoryIndexCache.get(key);
        if (!existing) {
            return;
        }
        memoryIndexCache.delete(key);
        memoryIndexCacheBytes -= existing.indexBytes.byteLength;
    }

    function deleteDocumentMemoryCaches(pdfPath: string) {
        const prefix = `${pdfPath}\0`;
        for (const key of [...memoryIndexCache.keys()]) {
            if (key === pdfPath || key.startsWith(prefix)) {
                deleteMemoryIndexKey(key);
            }
        }
    }

    function evictWorkerCacheSafe(pdfPath?: string) {
        if (typeof evictBrowserSearchWorkerCache === 'function') {
            evictBrowserSearchWorkerCache(pdfPath);
        }
    }

    function storeMemoryIndex(key: string, entry: ICachedWasmSearchIndex) {
        deleteMemoryIndexKey(key);
        const byteLength = entry.indexBytes.byteLength;
        if (byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
            return;
        }
        while (
            memoryIndexCache.size > 0 &&
            (memoryIndexCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT || memoryIndexCacheBytes + byteLength > SEARCH_INDEX_CACHE_MAX_BYTES)
        ) {
            const oldestKey = memoryIndexCache.keys().next().value;
            if (typeof oldestKey !== 'string') {
                break;
            }
            const evicted = memoryIndexCache.get(oldestKey);
            deleteMemoryIndexKey(oldestKey);
            if (evicted && evicted.pdfPath !== entry.pdfPath) {
                evictWorkerCacheSafe(evicted.pdfPath);
            }
        }
        memoryIndexCache.set(key, entry);
        memoryIndexCacheBytes += byteLength;
    }

    if (typeof browserDocumentStore.onDocumentRecordRemoved === 'function') {
        browserDocumentStore.onDocumentRecordRemoved((ref) => {
            bumpPathInvalidation(ref);
            deleteDocumentMemoryCaches(ref);
            evictWorkerCacheSafe(ref);
        });
    }
    if (typeof browserDocumentStore.onDocumentRevisionChanged === 'function') {
        browserDocumentStore.onDocumentRevisionChanged((event) => {
            bumpPathInvalidation(event.documentRef);
            deleteDocumentMemoryCaches(event.documentRef);
            evictWorkerCacheSafe(event.documentRef);
        });
    }

    async function clearSearchCaches(pdfPath?: string) {
        if (pdfPath) {
            bumpPathInvalidation(pdfPath);
            deleteDocumentMemoryCaches(pdfPath);
            evictWorkerCacheSafe(pdfPath);
            await activePersistChains.get(pdfPath)?.catch(() => undefined);
            await runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', async (tx) => {
                await Promise.all([
                    idbRequest(tx.objectStore(SEARCH_CACHE_STORE).delete(pdfPath), 'Failed to delete search cache record'),
                    idbRequest(tx.objectStore(SEARCH_CACHE_META_STORE).delete(pdfPath), 'Failed to delete search cache metadata record'),
                ]);
            });
            return;
        }
        cacheResetGeneration += 1;
        memoryIndexCache.clear();
        memoryIndexCacheBytes = 0;
        evictWorkerCacheSafe();
        await Promise.allSettled([...activePersistChains.values()]);
        await runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', async (tx) => {
            await Promise.all([
                idbRequest(tx.objectStore(SEARCH_CACHE_STORE).clear(), 'Failed to clear search cache records'),
                idbRequest(tx.objectStore(SEARCH_CACHE_META_STORE).clear(), 'Failed to clear search cache metadata records'),
            ]);
        });
    }

    function startSearchRequest(requestId: TRequestId | undefined) {
        if (!requestId) {
            return undefined;
        }
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
        if (!requestId) {
            return false;
        }
        const active = activeSearchRequests.get(requestId);
        return !active || active.generation !== generation || active.canceled;
    }

    function getRequestSignal(requestId: TRequestId | undefined, generation: number | undefined) {
        const active = requestId === undefined ? undefined : activeSearchRequests.get(requestId);
        return active?.generation === generation ? active?.abort.signal : undefined;
    }

    function finishSearchRequest(requestId: TRequestId | undefined, generation: number | undefined) {
        if (!requestId) {
            return;
        }
        const active = activeSearchRequests.get(requestId);
        if (active?.generation === generation) {
            activeSearchRequests.delete(requestId);
        }
    }

    function emitSearchProgress(progress: IPdfSearchProgress) {
        searchProgressListeners.forEach((listener) => listener(progress));
    }

    async function resolveSearchDocumentRevision(pdfPath: string, requestedRevision: string | undefined) {
        const currentRevision = await browserDocumentStore.getDocumentRevision(pdfPath);
        return requestedRevision === currentRevision.token ? requestedRevision : currentRevision.token;
    }

    function captureCacheEpoch(pdfPath: string) {
        return {
            resetGeneration: cacheResetGeneration,
            pathGeneration: pathInvalidationGenerations.get(pdfPath) ?? 0,
        };
    }

    function isCacheEpochCurrent(pdfPath: string, epoch: {resetGeneration: number; pathGeneration: number}) {
        return cacheResetGeneration === epoch.resetGeneration && (pathInvalidationGenerations.get(pdfPath) ?? 0) === epoch.pathGeneration;
    }

    async function loadCachedIndex(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        expectedPageCount: number | undefined,
        cacheEpoch: {resetGeneration: number; pathGeneration: number},
    ): Promise<ICachedWasmSearchIndex | null> {
        const cacheKey = getCacheKey(pdfPath, documentRevision);
        const cached = memoryIndexCache.get(cacheKey);
        if (cached) {
            if (typeof expectedPageCount !== 'number' || expectedPageCount === cached.pageCount) {
                memoryIndexCache.delete(cacheKey);
                memoryIndexCache.set(cacheKey, cached);
                return cached;
            }
            deleteMemoryIndexKey(cacheKey);
            evictWorkerCacheSafe(pdfPath);
        }
        const rawPersisted = await bestEffortCache(
            runSearchCacheStoresTransaction(SEARCH_CACHE_STORE, 'readonly', (tx) =>
                idbRequest<unknown>(tx.objectStore(SEARCH_CACHE_STORE).get(pdfPath), 'Failed to read search cache record'),
            ),
        );
        if (rawPersisted === null || rawPersisted === undefined) {
            return null;
        }
        if (!isCacheEpochCurrent(pdfPath, cacheEpoch)) {
            return null;
        }
        const persisted = parsePersistedIndexRecord(rawPersisted);
        if (
            persisted &&
            persisted.fileSize === fileSize &&
            persisted.contentSignature === contentSignature &&
            persisted.documentRevision === documentRevision &&
            (typeof expectedPageCount !== 'number' || expectedPageCount <= 0 || persisted.pageCount === expectedPageCount)
        ) {
            // Conditionally touch only the existing matching metadata record in the same readwrite
            // transaction so deleted or superseded entries are never recreated or overwritten, and
            // `document-text` (`indexBytes`) is never rewritten on cache hit.
            void bestEffortCache(
                runSearchCacheStoresTransaction(SEARCH_CACHE_META_STORE, 'readwrite', async (tx) => {
                    if (!isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                        return;
                    }
                    const metaStore = tx.objectStore(SEARCH_CACHE_META_STORE);
                    const existingMeta = parsePersistedMetaRecord(
                        await idbRequest<unknown>(metaStore.get(pdfPath), 'Failed to read search cache metadata record'),
                    );
                    if (!existingMeta || existingMeta.documentRevision !== documentRevision || !isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                        return;
                    }
                    await idbRequest(
                        metaStore.put({
                            ...existingMeta,
                            lastAccessedAt: createSearchCacheAccessTimestamp(),
                        } satisfies IPersistedWasmSearchMetaRecord),
                        'Failed to touch search cache metadata record',
                    );
                }),
            );
            const hydrated: ICachedWasmSearchIndex = {
                pdfPath,
                pageCount: persisted.pageCount,
                indexBytes: persisted.indexBytes,
                pageGeometries: new Map(),
                workerHydrated: false,
            };
            storeMemoryIndex(cacheKey, hydrated);
            return hydrated;
        }
        await bestEffortCache(
            runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', async (tx) => {
                await Promise.all([
                    idbRequest(tx.objectStore(SEARCH_CACHE_STORE).delete(pdfPath), 'Failed to delete stale search cache record'),
                    idbRequest(
                        tx.objectStore(SEARCH_CACHE_META_STORE).delete(pdfPath),
                        'Failed to delete stale search cache metadata record',
                    ),
                ]);
            }),
        );
        return null;
    }

    async function buildMemoryIndex(
        pdfPath: string,
        documentRevision: string,
        pageCount: number,
        pagesBuffer: Uint8Array,
        pageGeometries: Map<number, ISearchPageGeometry>,
        cacheEpoch: {resetGeneration: number; pathGeneration: number},
        signal: AbortSignal | undefined,
    ) {
        if (!canUseBrowserSearchWorker() || !isCacheEpochCurrent(pdfPath, cacheEpoch)) {
            return null;
        }
        const workerReq = createBrowserSearchWorkerRequest(
            'index',
            {
                documentKey: pdfPath,
                documentRevision,
                pageCount,
                pagesBuffer,
                maxPageTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
                maxTotalTextBytes: SEARCH_INDEX_CACHE_MAX_BYTES,
            },
            {
                affinityKey: pdfPath,
                isCacheable: () => isCacheEpochCurrent(pdfPath, cacheEpoch),
            },
        );
        const cancel = () => cancelBrowserSearchWorkerRequest(workerReq.requestId);
        signal?.addEventListener('abort', cancel, {once: true});
        let built;
        try {
            built = await workerReq.promise;
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
        if (!isCacheEpochCurrent(pdfPath, cacheEpoch)) {
            evictWorkerCacheSafe(pdfPath);
            return null;
        }
        if (built.coverage.truncated || built.indexBytes.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
            return null;
        }
        const entry: ICachedWasmSearchIndex = {
            pdfPath,
            pageCount,
            indexBytes: built.indexBytes,
            pageGeometries,
            workerHydrated: true,
        };
        storeMemoryIndex(getCacheKey(pdfPath, documentRevision), entry);
        return entry;
    }

    function schedulePersistedIndexWrite(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        entry: ICachedWasmSearchIndex,
        cacheEpoch: {resetGeneration: number; pathGeneration: number},
    ): Promise<void> {
        const isStillValid = () => isCacheEpochCurrent(pdfPath, cacheEpoch);
        const previous = activePersistChains.get(pdfPath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                if (!isStillValid()) {
                    return;
                }
                const liveRevision = await browserDocumentStore.getDocumentRevision(pdfPath).catch(() => null);
                if (!liveRevision || liveRevision.token !== documentRevision || !isStillValid()) {
                    return;
                }
                await runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', async (tx) => {
                    await Promise.all([
                        idbRequest(
                            tx.objectStore(SEARCH_CACHE_STORE).put({
                                version: SEARCH_CACHE_RECORD_VERSION,
                                pdfPath,
                                fileSize,
                                contentSignature,
                                documentRevision,
                                pageCount: entry.pageCount,
                                indexBytes: entry.indexBytes,
                                textBytes: entry.indexBytes.byteLength,
                            } satisfies IPersistedWasmSearchIndexRecord),
                            'Failed to write search cache record',
                        ),
                        idbRequest(
                            tx.objectStore(SEARCH_CACHE_META_STORE).put({
                                version: SEARCH_CACHE_RECORD_VERSION,
                                pdfPath,
                                documentRevision,
                                textBytes: entry.indexBytes.byteLength,
                                lastAccessedAt: createSearchCacheAccessTimestamp(),
                            } satisfies IPersistedWasmSearchMetaRecord),
                            'Failed to write search cache metadata record',
                        ),
                    ]);
                });
                if (!isStillValid()) {
                    await runSearchCacheStoresTransaction([SEARCH_CACHE_STORE, SEARCH_CACHE_META_STORE], 'readwrite', async (tx) => {
                        await Promise.all([
                            idbRequest(tx.objectStore(SEARCH_CACHE_STORE).delete(pdfPath), 'Failed to rollback stale search cache record'),
                            idbRequest(
                                tx.objectStore(SEARCH_CACHE_META_STORE).delete(pdfPath),
                                'Failed to rollback stale search cache metadata record',
                            ),
                        ]);
                    });
                    return;
                }
                await prunePersistedSearchCaches();
            })
            .finally(() => {
                if (activePersistChains.get(pdfPath) === next) {
                    activePersistChains.delete(pdfPath);
                }
            });
        activePersistChains.set(pdfPath, next);
        return next;
    }

    async function attachGeometryToIndexedResults(
        pdfPath: string,
        cached: ICachedWasmSearchIndex,
        results: IPdfSearchResult[],
        requestId: TRequestId | undefined,
        requestGeneration: number | undefined,
        signal: AbortSignal | undefined,
    ) {
        if (results.length === 0) {
            return results;
        }
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
                    if (isCanceled(requestId, requestGeneration)) {
                        return [];
                    }
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
        return results.map((result) => {
            const geometry = resolvedGeometries.get(result.pageNumber) ?? cached.pageGeometries.get(result.pageNumber);
            if (!geometry) {
                return result;
            }
            let wordIndex = wordIndexes.get(result.pageNumber);
            if (wordIndex === undefined) {
                wordIndex = createSearchPageWordIndex(geometry);
                wordIndexes.set(result.pageNumber, wordIndex);
            }
            const words =
                wordIndex === null ? undefined : collectSearchMatchWordsFromIndex(wordIndex, result.startOffset, result.endOffset);
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
        cacheEpoch: {resetGeneration: number; pathGeneration: number},
        signal: AbortSignal | undefined,
    ): Promise<IPdfSearchResponse | null> {
        const executeWorkerSearch = async (includeIndexBytes: boolean) => {
            const canHydrateWorker = isCacheEpochCurrent(pdfPath, cacheEpoch);
            const sendBytes = includeIndexBytes || !canHydrateWorker;
            const workerReq = createBrowserSearchWorkerRequest(
                'search',
                {
                    ...(canHydrateWorker ? {documentKey: pdfPath} : {}),
                    ...(sendBytes ? {indexBytes: cached.indexBytes} : {}),
                    documentRevision,
                    query,
                    options: matchOptions,
                    limit: SEARCH_RESULT_LIMIT,
                    contextChars: SEARCH_EXCERPT_CONTEXT_CHARS,
                    resultOffset,
                },
                {
                    affinityKey: pdfPath,
                    isCacheable: () => isCacheEpochCurrent(pdfPath, cacheEpoch),
                    ...(matchOptions.useRegex ? {matchTimeoutMs: BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS} : {}),
                },
            );
            const cancel = () => cancelBrowserSearchWorkerRequest(workerReq.requestId);
            signal?.addEventListener('abort', cancel, {once: true});
            try {
                return await workerReq.promise;
            } finally {
                signal?.removeEventListener('abort', cancel);
            }
        };
        let rawResponse;
        try {
            rawResponse = await executeWorkerSearch(!cached.workerHydrated);
            if (isCacheMissSearchIndexAnswer(rawResponse)) {
                cached.workerHydrated = false;
                if (isCanceled(requestId, requestGeneration)) {
                    return {
                        results: [],
                        truncated: false,
                    };
                }
                rawResponse = await executeWorkerSearch(true);
            }
        } catch (error) {
            if (error instanceof BrowserSearchWorkerTimeoutError) {
                throw new SearchRegexLimitError(`Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`);
            }
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
        if (isStaleSearchIndexAnswer(rawResponse) || isCacheMissSearchIndexAnswer(rawResponse)) {
            deleteMemoryIndexKey(getCacheKey(pdfPath, documentRevision));
            evictWorkerCacheSafe(pdfPath);
            return null;
        }
        if (isCacheEpochCurrent(pdfPath, cacheEpoch)) {
            cached.workerHydrated = true;
        }
        let results: IPdfSearchResult[];
        try {
            results = await attachGeometryToIndexedResults(pdfPath, cached, rawResponse.results, requestId, requestGeneration, signal);
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
            ...(matchOptions.useRegex || resultOffset === 'last'
                ? {}
                : {
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
            const cacheEpoch = captureCacheEpoch(pdfPath);
            try {
                const {size, contentSignature} = await browserDocumentStore.getContentSnapshot(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const cached = await loadCachedIndex(pdfPath, size, contentSignature, documentRevision, options.pageCount, cacheEpoch);
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
                        cacheEpoch,
                        signal,
                    );
                    if (indexedResponse !== null) {
                        return indexedResponse;
                    }
                }

                // Cold search: stream pages through evb-pdf-search.wasm in bounded
                // batches (bytes, elapsed work, and page count) for live progress and
                // early truncation, then build the EVBSIDX4 index and persist to IDB asynchronously.
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

                const applyPageMatchResult = (
                    page: IBrowserSearchDocumentPageRecord,
                    matchResult: {
                        matches: ReadonlyArray<{pageMatchIndex: number; startOffset: number; endOffset: number}>;
                        matchCount: number;
                    },
                ) => {
                    const pageWordIndex = matchResult.matches.length > 0 ? createSearchPageWordIndex(page) : null;
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
                        const words =
                            pageWordIndex === null
                                ? undefined
                                : collectSearchMatchWordsFromIndex(pageWordIndex, match.startOffset, match.endOffset);
                        const hit: IPdfSearchResult = {
                            pageNumber: requirePageNumber(page.pageNumber),
                            pageMatchIndex: match.pageMatchIndex,
                            matchIndex,
                            startOffset: match.startOffset,
                            endOffset: match.endOffset,
                            excerpt: buildPdfSearchExcerpt(page.text, match.startOffset, match.endOffset, SEARCH_EXCERPT_CONTEXT_CHARS),
                            ...(words !== undefined ? {words} : {}),
                            ...(words !== undefined && page.pageWidth !== undefined ? {pageWidth: page.pageWidth} : {}),
                            ...(words !== undefined && page.pageHeight !== undefined ? {pageHeight: page.pageHeight} : {}),
                        };
                        if (resultOffset === 'last') {
                            results[matchIndex % SEARCH_RESULT_LIMIT] = hit;
                        } else {
                            results.push(hit);
                        }
                    }
                    matchedCount += matchResult.matchCount;
                };

                const matchPendingBatch = async (batch: readonly IBrowserSearchDocumentPageRecord[]) => {
                    if (batch.length === 0) {
                        return;
                    }
                    const effectiveSignal = signal ?? new AbortController().signal;
                    const maxMatches = resultOffset === 'last' ? SEARCH_RESULT_LIMIT : SEARCH_RESULT_LIMIT - results.length + 1;
                    const batchOffset = resultOffset === 'last' ? 'last' : Math.max(0, resultOffset - matchedCount);
                    if (batch.length === 1 || matchOptions.useRegex) {
                        const page = batch[0]!;
                        const matchResult = await matchBrowserSearchPageWindowInWorker(
                            page.text,
                            query,
                            matchOptions,
                            maxMatches,
                            batchOffset,
                            {remainingMs: SEARCH_REGEX_MAX_EXECUTION_MS},
                            effectiveSignal,
                        );
                        if (isCanceled(requestId, requestGeneration)) {
                            completedAllPages = false;
                            return;
                        }
                        applyPageMatchResult(page, matchResult);
                        if (truncated) {
                            return;
                        }
                    } else {
                        const workerReq = createBrowserSearchWorkerRequest(
                            'matchPageBatch',
                            {
                                pages: batch.map((page) => ({
                                    pageNumber: page.pageNumber,
                                    text: page.text,
                                })),
                                query,
                                options: matchOptions,
                                maxMatches,
                                resultOffset: batchOffset,
                            },
                            {
                                affinityKey: pdfPath,
                                isCacheable: () => isCacheEpochCurrent(pdfPath, cacheEpoch),
                            },
                        );
                        const cancel = () => cancelBrowserSearchWorkerRequest(workerReq.requestId);
                        effectiveSignal.addEventListener('abort', cancel, {once: true});
                        let batchResponse;
                        try {
                            batchResponse = await workerReq.promise;
                        } finally {
                            effectiveSignal.removeEventListener('abort', cancel);
                        }
                        if (isCanceled(requestId, requestGeneration)) {
                            completedAllPages = false;
                            return;
                        }
                        const pageByNumber = new Map(batch.map((page) => [page.pageNumber, page]));
                        for (const pageMatch of batchResponse.pages) {
                            const page = pageByNumber.get(pageMatch.pageNumber);
                            if (!page) {
                                continue;
                            }
                            applyPageMatchResult(page, pageMatch);
                            if (truncated) {
                                return;
                            }
                        }
                    }
                    const lastPage = batch.at(-1)!;
                    const delta = results.slice(emittedResultCount);
                    emitSearchProgress({
                        requestId,
                        processed: lastPage.pageNumber,
                        total: lastPage.pageCount,
                        ...(matchOptions.useRegex || resultOffset === 'last'
                            ? {}
                            : {
                                  results: delta,
                                  resultsStartIndex: emittedResultCount,
                                  truncated: false,
                              }),
                    });
                    emittedResultCount = results.length;
                    await yieldToBrowser();
                };

                try {
                    const estimateLiteralMatchUpperBound =
                        !matchOptions.useRegex && resultOffset !== 'last' ? createLiteralMatchUpperBoundEstimator(query) : null;
                    let pendingBatch: IBrowserSearchDocumentPageRecord[] = [];
                    let pendingBatchBytes = 0;
                    let pendingBatchPossibleMatches = 0;
                    let batchStartedAtMs = 0;
                    let batchRampLimit = 1;

                    const flushPendingBatch = async () => {
                        if (pendingBatch.length === 0) {
                            return;
                        }
                        const batchToRun = pendingBatch;
                        pendingBatch = [];
                        pendingBatchBytes = 0;
                        pendingBatchPossibleMatches = 0;
                        batchStartedAtMs = 0;
                        await matchPendingBatch(batchToRun);
                        batchRampLimit = Math.min(COLD_BATCH_MAX_PAGES, batchRampLimit * 2);
                    };

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
                        let pageByteEstimate = page.text.length * 2;
                        if (canCacheIndex) {
                            const encoded = encodePdfSearchPageRecord({
                                pageNumber: page.pageNumber,
                                text: page.text,
                            });
                            pageByteEstimate = encoded.byteLength;
                            if (bufferedBytes + encoded.byteLength > SEARCH_INDEX_CACHE_MAX_BYTES) {
                                canCacheIndex = false;
                                pageChunks.length = 0;
                            } else {
                                pageChunks.push(encoded);
                                bufferedBytes += encoded.byteLength;
                            }
                        }

                        if (pendingBatch.length === 0) {
                            batchStartedAtMs = performance.now();
                        }
                        pendingBatch.push(page);
                        pendingBatchBytes += pageByteEstimate;

                        const matchesToOverflow =
                            resultOffset === 'last'
                                ? Number.POSITIVE_INFINITY
                                : Math.max(0, resultOffset - matchedCount) + Math.max(1, SEARCH_RESULT_LIMIT - results.length + 1);
                        if (estimateLiteralMatchUpperBound !== null && pendingBatchPossibleMatches < matchesToOverflow) {
                            pendingBatchPossibleMatches += estimateLiteralMatchUpperBound(
                                page.text,
                                matchesToOverflow - pendingBatchPossibleMatches,
                            );
                        }

                        const effectiveMaxPages = matchOptions.useRegex
                            ? 1
                            : resultOffset === 'last'
                              ? Math.min(batchRampLimit, COLD_BATCH_MAX_PAGES)
                              : Math.min(batchRampLimit, COLD_BATCH_MAX_PAGES, Math.max(1, SEARCH_RESULT_LIMIT - results.length));

                        if (
                            pendingBatch.length >= effectiveMaxPages ||
                            pendingBatchBytes >= COLD_BATCH_MAX_BYTES ||
                            pendingBatchPossibleMatches >= matchesToOverflow ||
                            performance.now() - batchStartedAtMs >= COLD_BATCH_MAX_ELAPSED_MS
                        ) {
                            await flushPendingBatch();
                            if (truncated || isCanceled(requestId, requestGeneration)) {
                                if (isCanceled(requestId, requestGeneration)) {
                                    completedAllPages = false;
                                }
                                break;
                            }
                        }
                    }

                    if (!truncated && !isCanceled(requestId, requestGeneration) && pendingBatch.length > 0) {
                        await flushPendingBatch();
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
                if (completedAllPages && canCacheIndex && totalPages > 0 && isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                    const pagesBuffer = concatUint8Arrays(pageChunks, bufferedBytes);
                    pageChunks.length = 0;
                    const builtEntry = await bestEffortCache(
                        buildMemoryIndex(pdfPath, documentRevision, totalPages, pagesBuffer, pageGeometries, cacheEpoch, signal),
                    );
                    if (builtEntry && isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                        // Detach optional IDB persistence off the cold terminal response; guarded by
                        // revision and cache-reset epoch so it never overwrites a newer revision or reset.
                        void bestEffortCache(
                            schedulePersistedIndexWrite(pdfPath, size, contentSignature, documentRevision, builtEntry, cacheEpoch),
                        );
                    }
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
            const cacheEpoch = captureCacheEpoch(pdfPath);
            try {
                const {size, contentSignature} = await browserDocumentStore.getContentSnapshot(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const existing = await loadCachedIndex(pdfPath, size, contentSignature, documentRevision, options.pageCount, cacheEpoch);
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
                        if (isCanceled(requestId, requestGeneration)) {
                            return false;
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

                if (isCanceled(requestId, requestGeneration)) {
                    return false;
                }
                if (canCacheIndex && totalPages > 0 && isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                    const pagesBuffer = concatUint8Arrays(pageChunks, bufferedBytes);
                    pageChunks.length = 0;
                    const builtEntry = await bestEffortCache(
                        buildMemoryIndex(pdfPath, documentRevision, totalPages, pagesBuffer, pageGeometries, cacheEpoch, signal),
                    );
                    if (builtEntry && isCacheEpochCurrent(pdfPath, cacheEpoch)) {
                        await bestEffortCache(
                            schedulePersistedIndexWrite(pdfPath, size, contentSignature, documentRevision, builtEntry, cacheEpoch),
                        );
                    }
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
