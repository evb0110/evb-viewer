import { getErrorMessage } from '@app/utils/error';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import {
    SEARCH_REGEX_MAX_EXECUTION_MS, SearchRegexLimitError,
} from '@contracts/search';
import {validateSearchQuery} from '@pdf-core';
import {
    buildPdfSearchExcerpt,
    iteratePdfSearchMatches,
} from '@pdf-core/pdfSearchCore';
import { collectSearchMatchWords } from '@pdf-core/collectSearchMatchWords';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    SEARCH_PLATFORM_FEATURE,
    ISearchCapability,
} from '@contracts/searchPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    validateBrowserSearchPageCount,
    validateBrowserSearchQueryCost,
} from '@app/platform/browser-api/browserSearchLimits';
import {
    BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS,
    BrowserSearchWorkerTimeoutError,
    BrowserSearchWorkerUnavailableError,
    canUseBrowserSearchWorker,
    cancelBrowserSearchWorkerRequest,
    createBrowserSearchWorkerRequest,
    createBrowserSearchWorkerPageStreamRequest,
} from '@app/platform/browser-api/browserSearchWorkerClient';
import {
    iterateBrowserSearchDocumentPages,
    streamBrowserSearchDocumentPages,
} from '@app/platform/browser-api/browserSearchCore';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import {
    createRequestId,
    type IOcrWord,
    type TRequestId,
} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resolveBrowserCapabilityTier } from '@app/platform/browser/browserCapabilityTier';
import {
    createPersistedSearchCacheRecord,
    estimatePageTextBytes,
    getPersistedRecordBytes,
    parsePersistedSearchCacheRecord,
    type IPersistedSearchDocumentCacheRecord,
    type ISearchDocumentTextSource,
} from '@app/platform/browser-api/browserSearchCache';

function idbRequestToPromise<T>(
    request: IDBRequest<T>,
    errorMessage: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
}

function readStoreValue<T>(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
    decode: (value: unknown) => T | null,
): Promise<T | null> {
    return idbRequestToPromise<unknown>(store.get(key), errorMessage)
        .then((value) => value === undefined ? null : decode(value));
}

function writeStoreValue(
    store: IDBObjectStore,
    value: unknown,
    errorMessage: string,
    key?: IDBValidKey,
) {
    const request = typeof key === 'undefined'
        ? store.put(value)
        : store.put(value, key);

    return idbRequestToPromise(request, errorMessage)
        .then(() => undefined);
}

function deleteStoreValue(
    store: IDBObjectStore,
    key: IDBValidKey,
    errorMessage: string,
) {
    return idbRequestToPromise(store.delete(key), errorMessage)
        .then(() => undefined);
}

function clearStore(
    store: IDBObjectStore,
    errorMessage: string,
) {
    return idbRequestToPromise(store.clear(), errorMessage)
        .then(() => undefined);
}

interface IPreparedSearchDocumentCache {
    pageCount: number | null;
    pageTexts: Map<number, string>;
    pageGeometries: Map<number, ISearchPageGeometry>;
    pageTextBytes: number;
    canCacheWholeDocumentText: boolean;
    isComplete: boolean;
}

interface ICreateBrowserSearchCapabilityResult {
    capability: ISearchCapability;
    clearSearchCaches: (pdfPath?: string) => Promise<void>;
}

interface IIterateSearchPagesOptions {
    onPage: (page: ISearchPageData, pageCount: number) => Promise<unknown> | unknown;
    requestId?: TRequestId;
    requestGeneration?: number | undefined;
    expectedPageCount?: number;
    streamDirectExtraction?: boolean;
    continueExtractionAfterStop?: boolean;
    requireGeometry?: boolean;
}

interface ISearchPageGeometry {
    words: readonly IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

interface ISearchPageData {
    pageNumber: number;
    text: string;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

type TSearchListener = (progress: IPdfSearchProgress) => void;
type TPageOutcome = 'continue' | 'stop' | 'cancel';

const SEARCH_PAGE_CACHE_LIMIT = 24;
const SEARCH_DOCUMENT_TEXT_CACHE_MAX_RECORDS = 8_192;
const SEARCH_GEOMETRY_CACHE_LIMIT = SEARCH_PAGE_CACHE_LIMIT;
const SEARCH_DOCUMENT_CACHE_LIMIT = 4;
const SEARCH_YIELD_INTERVAL = 1;
const SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SEARCH_PERSISTED_CACHE_MAX_RECORDS = 16;
const SEARCH_PERSISTED_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const SEARCH_CACHE_DB_NAME = 'evb-browser-search-cache';
const SEARCH_CACHE_DB_VERSION = 2;
const SEARCH_CACHE_RECORD_VERSION = 8;
const SEARCH_CACHE_LEGACY_RECORD_VERSION = 7;
const SEARCH_CACHE_STORE = 'document-text';
const SEARCH_CACHE_LAST_ACCESSED_INDEX = 'last-accessed-at';
const PDFJS_TEXT_SOURCE: ISearchDocumentTextSource = {
    kind: 'pdfjs-text-content',
    version: 1,
};
let searchCacheAccessSequence = 0;

function isBrowserSearchCanceledError(error: unknown) {
    return error instanceof Error && getErrorMessage(error) === 'ERR_BROWSER_SEARCH_CANCELED';
}

function hasCachedGeometryForEveryPage(cache: IPreparedSearchDocumentCache) {
    if (typeof cache.pageCount !== 'number' || cache.pageCount <= 0) {
        return false;
    }
    return cache.pageGeometries.size >= cache.pageCount;
}

function isRecordCacheReady(
    cache: IPreparedSearchDocumentCache,
    requireGeometry = false,
) {
    return typeof cache.pageCount === 'number'
        && cache.pageCount > 0
        && cache.canCacheWholeDocumentText
        && cache.isComplete
        && (!requireGeometry || hasCachedGeometryForEveryPage(cache));
}

function createDocumentCache(): IPreparedSearchDocumentCache {
    return {
        pageCount: null,
        pageTexts: new Map<number, string>(),
        pageGeometries: new Map<number, ISearchPageGeometry>(),
        pageTextBytes: 0,
        canCacheWholeDocumentText: true,
        isComplete: false,
    };
}

function openSearchCacheDb(): Promise<IDBDatabase | null> {
    const { indexedDbFactory } = resolveBrowserCapabilityTier();
    if (!indexedDbFactory) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDbFactory.open(SEARCH_CACHE_DB_NAME, SEARCH_CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(SEARCH_CACHE_STORE)
                ? request.transaction?.objectStore(SEARCH_CACHE_STORE)
                : db.createObjectStore(SEARCH_CACHE_STORE, { keyPath: 'pdfPath' });
            if (store && !store.indexNames.contains(SEARCH_CACHE_LAST_ACCESSED_INDEX)) {
                store.createIndex(SEARCH_CACHE_LAST_ACCESSED_INDEX, 'lastAccessedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open search cache database'));
    });
}

function createSearchCacheAccessTimestamp() {
    searchCacheAccessSequence += 1;
    return (Date.now() * 1000) + searchCacheAccessSequence;
}

function canPersistPageTexts(pageTexts: ReadonlyMap<number, string>) {
    return estimatePageTextBytes(pageTexts) <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES;
}

function waitForTransaction(transaction: IDBTransaction, errorMessage: string) {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error(errorMessage));
        transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
    });
}

async function runSearchCacheTransaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
) {
    const db = await openSearchCacheDb();
    if (!db) {
        return null;
    }

    try {
        const tx = db.transaction(SEARCH_CACHE_STORE, mode);
        let transactionError: unknown = null;
        const done = waitForTransaction(tx, 'Search cache transaction failed')
            .catch((error: unknown) => {
                transactionError = error;
            });
        try {
            const result = await run(tx.objectStore(SEARCH_CACHE_STORE));
            await done;
            if (transactionError) {
                throw transactionError instanceof Error
                    ? transactionError
                    : new Error(getErrorMessage(transactionError));
            }
            return result;
        } catch (error) {
            await done;
            throw error instanceof Error
                ? error
                : new Error(getErrorMessage(error));
        }
    } finally {
        db.close();
    }
}

async function loadPersistedSearchCacheRecord(cacheKey: string) {
    return runSearchCacheTransaction(
        'readonly',
        (store) => readStoreValue(
            store,
            cacheKey,
            'Failed to read search cache record',
            parsePersistedSearchCacheRecord,
        ),
    );
}

async function deletePersistedSearchCacheRecord(cacheKey: string) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => deleteStoreValue(store, cacheKey, 'Failed to delete search cache record'),
    );
}

async function touchPersistedSearchCacheRecord(record: IPersistedSearchDocumentCacheRecord) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => writeStoreValue(
            store,
            {
                ...record,
                textBytes: getPersistedRecordBytes(record),
                lastAccessedAt: createSearchCacheAccessTimestamp(),
            },
            'Failed to touch search cache record',
        ),
    );
}

async function persistSearchCacheRecord(
    record: IPersistedSearchDocumentCacheRecord,
) {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => writeStoreValue(
            store,
            {
                ...record,
                textBytes: estimatePageTextBytes(record.pages),
                lastAccessedAt: createSearchCacheAccessTimestamp(),
            },
            'Failed to write search cache record',
        ),
    );
    await prunePersistedSearchCaches();
}

async function persistSearchCacheRecordBestEffort(
    record: IPersistedSearchDocumentCacheRecord,
) {
    try {
        await persistSearchCacheRecord(record);
    } catch (error) {
        BrowserLogger.warn('search', 'Search completed but cache persistence failed', {
            pdfPath: record.pdfPath,
            pageCount: record.pageCount,
            error,
        });
    }
}

async function clearPersistedSearchCaches() {
    await runSearchCacheTransaction(
        'readwrite',
        (store) => clearStore(store, 'Failed to clear search cache records'),
    );
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
            const record = parsePersistedSearchCacheRecord(cursor.value);
            const recordBytes = record === null ? 0 : getPersistedRecordBytes(record);
            const shouldDelete = record === null
                || keptRecords >= SEARCH_PERSISTED_CACHE_MAX_RECORDS
                || keptBytes + recordBytes > SEARCH_PERSISTED_CACHE_MAX_BYTES;
            if (shouldDelete) {
                cursor.delete();
            } else {
                keptRecords += 1;
                keptBytes += recordBytes;
            }
            cursor.continue();
        };
    }));
}

async function clearPersistedSearchCacheForDocument(pdfPath: string) {
    await deletePersistedSearchCacheRecord(pdfPath);
}

function hydrateCacheFromPersistedRecord(
    cache: IPreparedSearchDocumentCache,
    record: IPersistedSearchDocumentCacheRecord | null,
) {
    if (!record || cache.pageCount !== null) {
        return;
    }

    cache.pageCount = record.pageCount;
    cache.pageTexts = new Map();
    cache.pageGeometries = new Map();
    cache.pageTextBytes = 0;
    cache.canCacheWholeDocumentText = true;
    cache.isComplete = true;

    for (const page of record.pages) {
        rememberPageText(cache, page.pageNumber, page.text);
    }
}

function yieldAfterSearchPage(pageNumber: number) {
    return pageNumber % SEARCH_YIELD_INTERVAL === 0 ? yieldToBrowser() : Promise.resolve();
}

function rememberPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
    text: string,
) {
    const existing = cache.pageTexts.get(pageNumber);
    if (typeof existing === 'string') {
        cache.pageTextBytes -= existing.length * 2;
        cache.pageTexts.delete(pageNumber);
    }
    if (text.length === 0) {
        return;
    }
    cache.pageTexts.set(pageNumber, text);
    cache.pageTextBytes += text.length * 2;

    if (
        cache.canCacheWholeDocumentText
        && cache.pageTextBytes <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES
        && cache.pageTexts.size <= SEARCH_DOCUMENT_TEXT_CACHE_MAX_RECORDS
    ) {
        return;
    }

    cache.canCacheWholeDocumentText = false;
    cache.isComplete = false;
    while (
        cache.pageTexts.size > SEARCH_PAGE_CACHE_LIMIT
        || cache.pageTextBytes > SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES
    ) {
        const oldestPage = cache.pageTexts.keys().next().value;
        if (typeof oldestPage !== 'number') {
            break;
        }
        const oldestText = cache.pageTexts.get(oldestPage);
        if (typeof oldestText === 'string') {
            cache.pageTextBytes -= oldestText.length * 2;
        }
        cache.pageTexts.delete(oldestPage);
        cache.pageGeometries.delete(oldestPage);
    }
}

function hasSearchPageGeometry(page: ISearchPageData): page is ISearchPageData & ISearchPageGeometry {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0;
}

function rememberPageData(
    cache: IPreparedSearchDocumentCache,
    page: ISearchPageData,
) {
    rememberPageText(cache, page.pageNumber, page.text);
    if (hasSearchPageGeometry(page)) {
        cache.pageGeometries.set(page.pageNumber, {
            words: page.words,
            pageWidth: page.pageWidth,
            pageHeight: page.pageHeight,
        });
        while (cache.pageGeometries.size > SEARCH_GEOMETRY_CACHE_LIMIT) {
            const oldestPage = cache.pageGeometries.keys().next().value;
            if (typeof oldestPage !== 'number') {
                break;
            }
            cache.pageGeometries.delete(oldestPage);
        }
    } else {
        cache.pageGeometries.delete(page.pageNumber);
    }
}

function getCachedPageText(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
) {
    const cached = cache.pageTexts.get(pageNumber);
    if (typeof cached !== 'string') {
        return null;
    }

    cache.pageTexts.delete(pageNumber);
    cache.pageTexts.set(pageNumber, cached);
    return cached;
}

function getCachedPageData(
    cache: IPreparedSearchDocumentCache,
    pageNumber: number,
    requireGeometry: boolean,
): ISearchPageData | null {
    const text = getCachedPageText(cache, pageNumber);
    if (typeof text !== 'string') {
        return null;
    }
    const geometry = cache.pageGeometries.get(pageNumber);
    if (requireGeometry && !geometry) {
        return null;
    }
    return {
        pageNumber,
        text,
        ...(geometry ? {
            words: geometry.words,
            pageWidth: geometry.pageWidth,
            pageHeight: geometry.pageHeight,
        } : {}),
    };
}

function resetExtractedPageCache(cache: IPreparedSearchDocumentCache) {
    cache.pageTexts.clear();
    cache.pageGeometries.clear();
    cache.pageTextBytes = 0;
    cache.canCacheWholeDocumentText = true;
    cache.isComplete = false;
}

export function createBrowserSearchCapability(): ICreateBrowserSearchCapabilityResult {
    const searchProgressListeners = new Set<TSearchListener>();
    const searchDocumentCache = new Map<string, IPreparedSearchDocumentCache>();
    const activeSearchRequests = new Map<TRequestId, {
        generation: number;
        canceled: boolean
    }>();
    const activePageWorkerSearchRequests = new Map<TRequestId, {
        generation: number;
        workerRequestId: number;
        resetWorkerOnCancel: boolean;
    }>();
    const activeMatchWorkerSearchRequests = new Map<TRequestId, {
        generation: number;
        workerRequestId: number;
        resetWorkerOnCancel: boolean;
    }>();
    let nextSearchGeneration = 0;

    function getMemoryCacheKey(pdfPath: string, documentRevision: string) {
        return `${pdfPath}\0${documentRevision}`;
    }

    function deleteDocumentMemoryCaches(pdfPath: string) {
        searchDocumentCache.delete(pdfPath);
        const prefix = `${pdfPath}\0`;
        for (const key of searchDocumentCache.keys()) {
            if (key.startsWith(prefix)) {
                searchDocumentCache.delete(key);
            }
        }
    }

    function getDocumentCache(cacheKey: string) {
        let cache = searchDocumentCache.get(cacheKey);
        if (!cache) {
            while (searchDocumentCache.size >= SEARCH_DOCUMENT_CACHE_LIMIT) {
                const oldestKey = searchDocumentCache.keys().next().value;
                if (typeof oldestKey !== 'string') {
                    break;
                }
                searchDocumentCache.delete(oldestKey);
            }
            cache = createDocumentCache();
            searchDocumentCache.set(cacheKey, cache);
        }
        return cache;
    }

    async function clearSearchCachesAsync(pdfPath?: string) {
        if (pdfPath) {
            deleteDocumentMemoryCaches(pdfPath);
            await clearPersistedSearchCacheForDocument(pdfPath);
            return;
        }

        searchDocumentCache.clear();
        await clearPersistedSearchCaches();
    }

    const clearSearchCaches = clearSearchCachesAsync;

    function startSearchRequest(requestId: TRequestId | undefined) {
        if (!requestId) {
            return undefined;
        }
        for (const workerRequests of [
            activePageWorkerSearchRequests,
            activeMatchWorkerSearchRequests,
        ]) {
            const previousWorkerRequest = workerRequests.get(requestId);
            if (!previousWorkerRequest) {
                continue;
            }
            void cancelBrowserSearchWorkerRequest(
                previousWorkerRequest.workerRequestId,
                previousWorkerRequest.resetWorkerOnCancel
                    ? {resetWorker: true}
                    : {},
            );
            workerRequests.delete(requestId);
        }
        const generation = nextSearchGeneration + 1;
        nextSearchGeneration = generation;
        activeSearchRequests.set(requestId, {
            generation,
            canceled: false,
        });
        return generation;
    }

    function consumeCancellation(requestId: TRequestId | undefined, generation: number | undefined) {
        if (!requestId) {
            return false;
        }
        const active = activeSearchRequests.get(requestId);
        return !active || active.generation !== generation || active.canceled;
    }

    function finishSearchRequest(requestId: TRequestId | undefined, generation: number | undefined) {
        if (!requestId) {
            return;
        }
        const active = activeSearchRequests.get(requestId);
        if (active?.generation === generation) {
            activeSearchRequests.delete(requestId);
        }
        for (const workerRequests of [
            activePageWorkerSearchRequests,
            activeMatchWorkerSearchRequests,
        ]) {
            const workerRequest = workerRequests.get(requestId);
            if (workerRequest?.generation === generation) {
                workerRequests.delete(requestId);
            }
        }
    }

    function isExtractionCanceled(requestId: TRequestId | undefined, generation: number | undefined) {
        return consumeCancellation(requestId, generation);
    }

    function isSearchCanceled(requestId: TRequestId | undefined, generation: number | undefined) {
        return consumeCancellation(requestId, generation);
    }

    function emitPageProgress(requestId: TRequestId | undefined, processed: number, total: number) {
        if (!requestId) {
            return;
        }
        const progress: IPdfSearchProgress = {
            requestId,
            processed,
            total,
        };
        searchProgressListeners.forEach((listener) => listener(progress));
    }

    function emitSearchProgress(progress: IPdfSearchProgress) {
        searchProgressListeners.forEach((listener) => listener(progress));
    }

    function pickValidPersistedRecord(
        record: IPersistedSearchDocumentCacheRecord | null,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        expectedPageCount?: number,
    ) {
        if (!record) {
            return null;
        }
        if (
            record.version !== SEARCH_CACHE_RECORD_VERSION
            && record.version !== SEARCH_CACHE_LEGACY_RECORD_VERSION
        ) {
            return null;
        }
        if (record.fileSize !== fileSize) {
            return null;
        }
        if (record.contentSignature !== contentSignature) {
            return null;
        }
        if (record.documentRevision !== documentRevision) {
            return null;
        }
        if (
            typeof expectedPageCount === 'number'
            && expectedPageCount > 0
            && record.pageCount !== expectedPageCount
        ) {
            return null;
        }
        const textBytes = estimatePageTextBytes(record.pages);
        if (record.textBytes !== textBytes) {
            return null;
        }
        if (getPersistedRecordBytes(record) > SEARCH_DOCUMENT_TEXT_CACHE_MAX_BYTES) {
            return null;
        }
        return record;
    }

    interface IStreamedSearchPage extends ISearchPageData {pageCount?: number;}

    interface IStreamedSearchDocumentText {
        pages: AsyncIterable<IStreamedSearchPage>;
        completion: Promise<number>;
        cancel: () => void;
    }

    function createDirectSearchDocumentTextStream(
        pdfPath: string,
        requestId: TRequestId | undefined,
        requestGeneration: number | undefined,
    ): IStreamedSearchDocumentText {
        return {
            pages: streamBrowserSearchDocumentPages(
                pdfPath,
                {shouldContinue: () => !isExtractionCanceled(requestId, requestGeneration)},
            ),
            completion: Promise.resolve(0),
            cancel: () => {},
        };
    }

    function createSearchDocumentTextStream(
        pdfPath: string,
        requestId: TRequestId | undefined,
        requestGeneration: number | undefined,
    ): IStreamedSearchDocumentText {
        if (!canUseBrowserSearchWorker()) {
            return createDirectSearchDocumentTextStream(pdfPath, requestId, requestGeneration);
        }
        try {
            const workerRequest = createBrowserSearchWorkerPageStreamRequest({pdfPath});
            if (requestId) {
                activePageWorkerSearchRequests.set(requestId, {
                    generation: requestGeneration ?? 0,
                    workerRequestId: workerRequest.requestId,
                    resetWorkerOnCancel: false,
                });
            }
            const completion = workerRequest.promise.then(result => result.pageCount);
            void completion.catch(() => {});
            return {
                pages: workerRequest.pages,
                completion,
                cancel: () => cancelBrowserSearchWorkerRequest(workerRequest.requestId),
            };
        } catch (error) {
            if (error instanceof BrowserSearchWorkerUnavailableError) {
                return createDirectSearchDocumentTextStream(pdfPath, requestId, requestGeneration);
            }
            throw error;
        }
    }

    async function matchSearchPage(
        pageText: string,
        query: string,
        matchOptions: {
            matchCase: boolean;
            wholeWord: boolean;
            useRegex: boolean
        },
        requestId: TRequestId,
        requestGeneration: number,
        maxMatches: number,
        deadlineAtMs: number,
    ) {
        if (matchOptions.useRegex && Date.now() >= deadlineAtMs) {
            throw new SearchRegexLimitError(
                `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`,
            );
        }
        if (!matchOptions.useRegex) {
            const matches = [];
            let truncated = false;
            for (const match of iteratePdfSearchMatches(pageText, query, matchOptions)) {
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

        if (!canUseBrowserSearchWorker()) {
            throw new BrowserSearchWorkerUnavailableError(
                'Browser search worker is required for regular expression search',
            );
        }

        const workerRequest = createBrowserSearchWorkerRequest(
            'matchPageText',
            {
                text: pageText,
                query,
                options: matchOptions,
                maxMatches,
                deadlineAtMs,
            },
            {
                timeoutMs: BROWSER_SEARCH_REGEX_WORKER_TIMEOUT_MS,
                resetWorkerOnTimeout: true,
            },
        );
        activeMatchWorkerSearchRequests.set(requestId, {
            generation: requestGeneration,
            workerRequestId: workerRequest.requestId,
            resetWorkerOnCancel: true,
        });
        try {
            const result = await workerRequest.promise;
            return isSearchCanceled(requestId, requestGeneration)
                ? {
                    matches: [],
                    truncated: false,
                }
                : result;
        } catch (error) {
            if (error instanceof BrowserSearchWorkerTimeoutError) {
                throw new SearchRegexLimitError(
                    `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms matching budget`,
                );
            }
            throw error;
        } finally {
            const activeWorkerRequest = activeMatchWorkerSearchRequests.get(requestId);
            if (activeWorkerRequest?.generation === requestGeneration
                && activeWorkerRequest.workerRequestId === workerRequest.requestId) {
                activeMatchWorkerSearchRequests.delete(requestId);
            }
        }
    }

    async function deliverPage(
        page: ISearchPageData,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ): Promise<TPageOutcome> {
        if (isSearchCanceled(options.requestId, options.requestGeneration)) {
            return 'cancel';
        }
        const result = await options.onPage(page, pageCount);
        if (result === false) {
            return 'stop';
        }
        emitPageProgress(options.requestId, page.pageNumber, pageCount);
        await yieldAfterSearchPage(page.pageNumber);
        return 'continue';
    }

    async function iterateStreamedDocumentText(
        cache: IPreparedSearchDocumentCache,
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        options: IIterateSearchPagesOptions,
    ) {
        const stream = createSearchDocumentTextStream(pdfPath, options.requestId, options.requestGeneration);
        let pageCount = 0;
        let canceled = false;
        let stopped = false;
        const cancelStream = () => {
            void stream.completion.catch(() => {});
            stream.cancel();
        };

        try {
            for await (const page of stream.pages) {
                if (isSearchCanceled(options.requestId, options.requestGeneration)) {
                    canceled = true;
                    cancelStream();
                    break;
                }

                pageCount = page.pageCount ?? page.pageNumber;
                rememberPageData(cache, page);
                if (stopped) {
                    emitPageProgress(options.requestId, page.pageNumber, pageCount);
                    await yieldAfterSearchPage(page.pageNumber);
                    continue;
                }

                const outcome = await deliverPage(page, pageCount, options);
                if (outcome === 'cancel') {
                    canceled = true;
                    cancelStream();
                    break;
                }
                if (outcome === 'stop') {
                    stopped = true;
                    if (options.continueExtractionAfterStop !== true) {
                        cancelStream();
                        break;
                    }
                }
            }

            if (!canceled && !stopped) {
                const completedPageCount = await stream.completion;
                pageCount = completedPageCount > 0 ? completedPageCount : pageCount;
            }
        } catch (error) {
            if (isBrowserSearchCanceledError(error)) {
                resetExtractedPageCache(cache);
                if (stopped && !canceled && !isExtractionCanceled(options.requestId, options.requestGeneration)) {
                    cache.pageCount = pageCount > 0 ? pageCount : cache.pageCount;
                    return true;
                }
                return !canceled && stopped;
            }
            throw error;
        } finally {
            if (options.requestId) {
                const workerRequest = activePageWorkerSearchRequests.get(options.requestId);
                if (workerRequest?.generation === (options.requestGeneration ?? 0)) {
                    activePageWorkerSearchRequests.delete(options.requestId);
                }
            }
        }

        cache.pageCount = pageCount;
        cache.isComplete = !canceled && !stopped && cache.canCacheWholeDocumentText;
        if (cache.isComplete && canPersistPageTexts(cache.pageTexts)) {
            await persistSearchCacheRecordBestEffort(createPersistedSearchCacheRecord(
                pdfPath,
                fileSize,
                contentSignature,
                documentRevision,
                pageCount,
                cache.pageTexts,
                createSearchCacheAccessTimestamp(),
                SEARCH_CACHE_RECORD_VERSION,
                PDFJS_TEXT_SOURCE,
            ));
        }
        return !canceled;
    }

    async function iterateCachedDocumentPages(
        cache: IPreparedSearchDocumentCache,
        pageCount: number,
        options: IIterateSearchPagesOptions,
    ) {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            const cachedPage = getCachedPageData(cache, pageNumber, Boolean(options.requireGeometry)) ?? {
                pageNumber,
                text: '',
            };
            const outcome = await deliverPage(cachedPage, pageCount, options);
            if (outcome === 'cancel' || outcome === 'stop') {
                return false;
            }
        }
        return true;
    }

    async function iteratePersistedDocumentPages(
        record: IPersistedSearchDocumentCacheRecord,
        options: IIterateSearchPagesOptions,
    ) {
        const pageTexts = new Map<number, string>();
        for (const page of record.pages) {
            pageTexts.set(page.pageNumber, page.text);
        }
        for (let pageNumber = 1; pageNumber <= record.pageCount; pageNumber += 1) {
            const text = pageTexts.get(pageNumber) ?? '';
            const outcome = await deliverPage({
                pageNumber,
                text,
            }, record.pageCount, options);
            if (outcome === 'cancel') {
                return false;
            }
            if (outcome === 'stop') {
                return true;
            }
        }
        return true;
    }

    async function iterateSearchPages(
        pdfPath: string,
        fileSize: number,
        contentSignature: string,
        documentRevision: string,
        options: IIterateSearchPagesOptions,
    ) {
        const memoryCacheKey = getMemoryCacheKey(pdfPath, documentRevision);
        let cache = getDocumentCache(memoryCacheKey);
        const cachedPageCount = cache.pageCount;

        if (isRecordCacheReady(cache, Boolean(options.requireGeometry)) && cachedPageCount) {
            if (
                typeof options.expectedPageCount !== 'number'
                || options.expectedPageCount === cachedPageCount
            ) {
                return iterateCachedDocumentPages(cache, cachedPageCount, options);
            }
            searchDocumentCache.delete(memoryCacheKey);
            cache = getDocumentCache(memoryCacheKey);
        }

        const persistedRecord = options.requireGeometry
            ? null
            : await loadPersistedSearchCacheRecord(pdfPath);
        const validPersistedRecord = pickValidPersistedRecord(
            persistedRecord,
            fileSize,
            contentSignature,
            documentRevision,
            options.expectedPageCount,
        );
        if (validPersistedRecord) {
            if (validPersistedRecord.version === SEARCH_CACHE_LEGACY_RECORD_VERSION) {
                const migratedPages = new Map<number, string>();
                for (const page of validPersistedRecord.pages) {
                    migratedPages.set(page.pageNumber, page.text);
                }
                void persistSearchCacheRecordBestEffort(createPersistedSearchCacheRecord(
                    pdfPath,
                    fileSize,
                    contentSignature,
                    documentRevision,
                    validPersistedRecord.pageCount,
                    migratedPages,
                    createSearchCacheAccessTimestamp(),
                    SEARCH_CACHE_RECORD_VERSION,
                    validPersistedRecord.textSource ?? PDFJS_TEXT_SOURCE,
                ));
            } else {
                void touchPersistedSearchCacheRecord(validPersistedRecord);
            }
            hydrateCacheFromPersistedRecord(cache, validPersistedRecord);
            return iteratePersistedDocumentPages(validPersistedRecord, options);
        }
        if (persistedRecord) {
            await clearPersistedSearchCacheForDocument(pdfPath);
        }

        if (options.streamDirectExtraction) {
            let canceled = false as boolean;
            let stopped = false as boolean;
            let pageCount = 0;
            try {
                pageCount = await iterateBrowserSearchDocumentPages(
                    pdfPath,
                    async (page, totalPages) => {
                        if (isSearchCanceled(options.requestId, options.requestGeneration)) {
                            canceled = true;
                            return;
                        }
                        pageCount = totalPages;
                        rememberPageData(cache, page);
                        if (stopped) {
                            emitPageProgress(options.requestId, page.pageNumber, totalPages);
                            await yieldAfterSearchPage(page.pageNumber);
                        } else {
                            const outcome = await deliverPage(page, totalPages, options);
                            if (outcome === 'cancel') {
                                canceled = true;
                            } else if (outcome === 'stop') {
                                stopped = true;
                            }
                        }
                    },
                    {shouldContinue: () => (
                        !isExtractionCanceled(options.requestId, options.requestGeneration)
                            && !canceled
                            && (options.continueExtractionAfterStop === true || !stopped)
                    )},
                );
            } catch (error) {
                if (isBrowserSearchCanceledError(error)) {
                    resetExtractedPageCache(cache);
                    if (stopped && !canceled && !isExtractionCanceled(options.requestId, options.requestGeneration)) {
                        cache.pageCount = pageCount > 0 ? pageCount : cache.pageCount;
                        return true;
                    }
                    return !canceled && stopped;
                }
                throw error;
            }

            cache.pageCount = pageCount;
            cache.isComplete = !canceled && cache.canCacheWholeDocumentText;
            if (cache.isComplete && canPersistPageTexts(cache.pageTexts)) {
                await persistSearchCacheRecordBestEffort(createPersistedSearchCacheRecord(
                    pdfPath,
                    fileSize,
                    contentSignature,
                    documentRevision,
                    pageCount,
                    cache.pageTexts,
                    createSearchCacheAccessTimestamp(),
                    SEARCH_CACHE_RECORD_VERSION,
                    PDFJS_TEXT_SOURCE,
                ));
            }
            return !canceled;
        }

        return iterateStreamedDocumentText(
            cache,
            pdfPath,
            fileSize,
            contentSignature,
            documentRevision,
            options,
        );
    }

    async function resolveSearchDocumentRevision(pdfPath: string, requestedRevision: string | undefined) {
        const currentRevision = await browserDocumentStore.getDocumentRevision(pdfPath);
        return requestedRevision === currentRevision.token
            ? requestedRevision
            : currentRevision.token;
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
            if (options.pageCount !== undefined) {
                validateBrowserSearchPageCount(options.pageCount);
            }
            validateBrowserSearchQueryCost(query, options.pageCount);
            if (matchOptions.useRegex && !canUseBrowserSearchWorker()) {
                throw new BrowserSearchWorkerUnavailableError(
                    'Browser search worker is required for regular expression search',
                );
            }

            const requestId = options.requestId ?? createRequestId('browser-search');
            const results: IPdfSearchResult[] = [];
            let emittedResultCount = 0;
            let truncated = false;
            const pageMatchCounts = new Map<number, number>();
            const requestGeneration = startSearchRequest(requestId);
            let regexDeadlineAtMs: number | null = null;
            try {
                const { size } = await browserDocumentStore.stat(pdfPath);
                const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                await iterateSearchPages(pdfPath, size, contentSignature, documentRevision, {
                    requestId,
                    ...(requestGeneration === undefined ? {} : {requestGeneration}),
                    ...(options.pageCount !== undefined ? {expectedPageCount: options.pageCount} : {}),
                    streamDirectExtraction: true,
                    requireGeometry: true,
                    onPage: async (page, pageCount) => {
                        if (isSearchCanceled(requestId, requestGeneration)) {
                            return false;
                        }

                        if (matchOptions.useRegex && regexDeadlineAtMs === null) {
                            regexDeadlineAtMs = Date.now() + SEARCH_REGEX_MAX_EXECUTION_MS;
                        }
                        const matchResult = await matchSearchPage(
                            page.text,
                            query,
                            matchOptions,
                            requestId,
                            requestGeneration ?? 0,
                            (SEARCH_RESULT_LIMIT - results.length) + 1,
                            regexDeadlineAtMs ?? Number.POSITIVE_INFINITY,
                        );
                        for (const match of matchResult.matches) {
                            if (isSearchCanceled(requestId, requestGeneration)) {
                                return false;
                            }
                            if (results.length >= SEARCH_RESULT_LIMIT) {
                                // Only a match we refuse to report proves the set was cut, so the
                                // limit-th match alone must never raise the truncated flag.
                                truncated = true;
                                emitSearchProgress({
                                    requestId,
                                    processed: page.pageNumber,
                                    total: pageCount,
                                    results: results.slice(emittedResultCount),
                                    resultsStartIndex: emittedResultCount,
                                    truncated: true,
                                });
                                emittedResultCount = results.length;
                                return false;
                            }

                            const pageMatchIndex = pageMatchCounts.get(page.pageNumber) ?? 0;
                            pageMatchCounts.set(page.pageNumber, pageMatchIndex + 1);
                            const words = collectSearchMatchWords(page, match.startOffset, match.endOffset);
                            results.push({
                                pageNumber: requirePageNumber(page.pageNumber),
                                pageMatchIndex,
                                matchIndex: results.length,
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
                            });
                        }

                        const delta = results.slice(emittedResultCount);
                        emitSearchProgress({
                            requestId,
                            processed: page.pageNumber,
                            total: pageCount,
                            ...(matchOptions.useRegex ? {} : {
                                results: delta,
                                resultsStartIndex: emittedResultCount,
                                truncated: false,
                            }),
                        });
                        emittedResultCount = results.length;
                        await yieldToBrowser();
                        return true;
                    },
                });

                if (consumeCancellation(requestId, requestGeneration)) {
                    return {
                        results: [],
                        truncated: false,
                    };
                }

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
            try {
                const { size } = await browserDocumentStore.stat(pdfPath);
                const contentSignature = await browserDocumentStore.getContentSignature(pdfPath);
                const documentRevision = await resolveSearchDocumentRevision(pdfPath, options.documentRevision);
                const completed = await iterateSearchPages(pdfPath, size, contentSignature, documentRevision, {
                    ...(requestId !== undefined ? {requestId} : {}),
                    ...(requestGeneration !== undefined ? {requestGeneration} : {}),
                    ...(options.pageCount !== undefined ? {expectedPageCount: options.pageCount} : {}),
                    onPage: async () => {
                        await yieldToBrowser();
                    },
                });
                return completed && !consumeCancellation(requestId, requestGeneration);
            } finally {
                finishSearchRequest(requestId, requestGeneration);
            }
        },
        cancel(requestId) {
            if (requestId) {
                const active = activeSearchRequests.get(requestId);
                if (active) {
                    active.canceled = true;
                }
                for (const workerRequests of [
                    activePageWorkerSearchRequests,
                    activeMatchWorkerSearchRequests,
                ]) {
                    const workerRequest = workerRequests.get(requestId);
                    if (!workerRequest) {
                        continue;
                    }
                    void cancelBrowserSearchWorkerRequest(
                        workerRequest.workerRequestId,
                        workerRequest.resetWorkerOnCancel
                            ? {resetWorker: true}
                            : {},
                    );
                    workerRequests.delete(requestId);
                }
            }
            return Promise.resolve({ canceled: true });
        },
        onProgress(callback) {
            searchProgressListeners.add(callback);
            return () => {
                searchProgressListeners.delete(callback);
            };
        },
        async resetCache() {
            await clearSearchCachesAsync();
            return true;
        },
    } satisfies TFeatureBrowserBindings<typeof SEARCH_PLATFORM_FEATURE>;

    return {
        capability,
        clearSearchCaches,
    };
}
