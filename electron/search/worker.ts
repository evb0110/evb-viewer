import {
    parentPort,
    workerData,
} from 'worker_threads';
import { stat } from 'fs/promises';
import type { IPdfSearchIndex } from '@electron/search/indexBuilder';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    ISearchMatch,
    ISearchWorkerRequest,
    ISearchWorkerShutdownResult,
    TSearchWorkerOutboundMessage,
} from '@electron/search/protocol';
import { SEARCH_RESULT_LIMIT } from '@electron/config/constants';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseSearchWorkerInboundMessage } from '@electron/search/parseSearchWorkerInboundMessage';
import {
    resetPersistentNativeSearchServiceCaches,
    shutdownPersistentNativeSearchServices,
} from '@electron/search/tryRunPersistentNativeSearch';
import {
    buildExcerpt,
    iteratePageMatches,
} from '@electron/search/worker/searchMatch';
import { parsePageNumber } from '@contracts/pageNumbers';
import type { IResolvedSearchMatchOptions } from '@pdf-core/pdfSearchCore';
import type { ICachedIndex } from '@electron/search/worker/ensureSearchIndex';
import {
    ensureSearchIndex,
    getIndexCacheKey,
} from '@electron/search/worker/ensureSearchIndex';
import {
    classifyXlargeSearchPath,
    ensureXlargeSearchIndex,
    resetXlargeSearchIndexBuilds,
} from '@electron/search/xlargeSearchRouting';
import type {IXlargeSearchIndexBuildProgress} from '@electron/search/xlargeIndexBuilder';
import { collectSearchMatchWords } from '@pdf-core/collectSearchMatchWords';
import { decodeSearchWorkerData } from '@contracts/resourcePolicies';

interface ISearchRequestContext extends IResolvedSearchMatchOptions {
    requestId: string;
    pdfPath: string;
    documentRevision: TDocumentRevisionToken;
    normalizedQuery: string;
    pageCount?: number;
    pathSizeBytes?: number;
    isXlarge: boolean;
    shouldWarmup: boolean;
    signal: AbortSignal;
}

interface ISearchExecutionResult {
    results: ISearchMatch[];
    truncated: boolean;
}

interface ISearchProgressResultBatch extends ISearchExecutionResult { resultsStartIndex?: number; }

const PROGRESS_THROTTLE_MS = 60;
const DEFAULT_NATIVE_SERVICE_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SEARCH_WORKER_RESOURCE_POLICY = {
    indexCacheMaxEntries: 2,
    indexCacheTtlMs: 2 * 60_000,
    maxPageTextBytes: 2 * 1024 * 1024,
    maxTotalTextBytes: 96 * 1024 * 1024,
};
const CANCELLED_REQUESTS_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_CANCELLED_REQUESTS_MAX_ENTRIES ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 256;
    }
    return Math.min(parsed, 8_192);
})();
const CANCELLED_REQUEST_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_CANCELLED_REQUEST_TTL_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
function resolveWorkerResourcePolicy(value: unknown) {
    if (value == null) {
        return {
            nativeServiceIdleTimeoutMs: DEFAULT_NATIVE_SERVICE_IDLE_TIMEOUT_MS,
            resourcePolicy: DEFAULT_SEARCH_WORKER_RESOURCE_POLICY,
        };
    }
    const workerData = decodeSearchWorkerData(value);
    if (!workerData) {
        throw new Error('Invalid search workerData');
    }
    return workerData;
}

const workerResourcePolicy = resolveWorkerResourcePolicy(workerData);
const searchIndexCacheOptions = {
    maxEntries: workerResourcePolicy.resourcePolicy.indexCacheMaxEntries,
    ttlMs: workerResourcePolicy.resourcePolicy.indexCacheTtlMs,
    maxPageTextBytes: workerResourcePolicy.resourcePolicy.maxPageTextBytes,
    maxTotalTextBytes: workerResourcePolicy.resourcePolicy.maxTotalTextBytes,
};
const indexCache = new Map<string, ICachedIndex>();
const retainedTextBytesByIndex = new WeakMap<IPdfSearchIndex, number>();
const cancelledRequests = new Map<string, number>();
const requestAbortControllers = new Map<string, AbortController>();
const progressSentAt = new Map<string, number>();
const activeSearchRequests = new Set<Promise<void>>();
const log = createLogger('search-worker');
let shutdownStarted = false;

function assertNever(value: never) {
    throw new Error(`Unhandled search worker inbound message: ${JSON.stringify(value)}`);
}

function postMessage(message: TSearchWorkerOutboundMessage) {
    parentPort?.postMessage(message);
}

async function getPdfFileStat(filePath: string) {
    try {
        return await stat(filePath);
    } catch {
        return null;
    }
}

function isCancelled(requestId: string) {
    const expiresAt = cancelledRequests.get(requestId);
    if (expiresAt === undefined) {
        return false;
    }
    if (expiresAt <= Date.now()) {
        cancelledRequests.delete(requestId);
        return false;
    }
    return true;
}

function pruneCancelledRequests(now = Date.now()) {
    for (const [
        requestId,
        expiresAt,
    ] of cancelledRequests.entries()) {
        if (expiresAt <= now) {
            cancelledRequests.delete(requestId);
        }
    }

    if (cancelledRequests.size <= CANCELLED_REQUESTS_MAX_ENTRIES) {
        return;
    }

    const overflowCount = cancelledRequests.size - CANCELLED_REQUESTS_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const oldestRequestId = cancelledRequests.keys().next().value;
        if (typeof oldestRequestId !== 'string') {
            break;
        }
        cancelledRequests.delete(oldestRequestId);
    }
}

function markRequestCancelled(requestId: string) {
    const now = Date.now();
    pruneCancelledRequests(now);
    if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
    }
    cancelledRequests.set(requestId, now + CANCELLED_REQUEST_TTL_MS);
    pruneCancelledRequests(now);
}

function throwIfCancelled(
    requestId: string,
    signal?: AbortSignal,
) {
    if (isCancelled(requestId) || signal?.aborted) {
        throw createAbortError();
    }
}

function sendProgress(
    requestId: string,
    processed: number,
    total: number,
    force = false,
    partialResult?: ISearchProgressResultBatch,
) {
    const now = Date.now();
    const lastSentAt = progressSentAt.get(requestId) ?? 0;
    if (
        !force
        && processed !== 0
        && processed !== total
        && now - lastSentAt < PROGRESS_THROTTLE_MS
    ) {
        return;
    }

    progressSentAt.set(requestId, now);
    const progress: TSearchWorkerOutboundMessage = {
        type: 'progress',
        requestId,
        processed,
        total,
    };
    if (partialResult !== undefined) {
        progress.results = partialResult.results;
        if (partialResult.resultsStartIndex !== undefined) {
            progress.resultsStartIndex = partialResult.resultsStartIndex;
        }
        progress.truncated = partialResult.truncated;
    }
    postMessage(progress);
}

function postEmptySearchComplete(requestId: string) {
    postMessage({
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function postSearchComplete(
    requestId: string,
    result: ISearchExecutionResult,
) {
    postMessage({
        type: 'complete',
        requestId,
        response: result,
    });
}

function completeWithNativeSearch(
    context: ISearchRequestContext,
    nativeResult: {
        response: ISearchExecutionResult;
        totalPages: number;
    },
) {
    indexCache.delete(getIndexCacheKey(context.pdfPath, context.documentRevision));
    sendProgress(context.requestId, 0, nativeResult.totalPages, true);
    sendProgress(
        context.requestId,
        nativeResult.totalPages,
        nativeResult.totalPages,
        true,
        nativeResult.response,
    );
    postSearchComplete(context.requestId, nativeResult.response);
}

function isNativeSearchAttemptDisabledForRuntime() {
    return process.env.EVB_PDF_SEARCH_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_SEARCH_ENABLE !== '1');
}

async function tryCompleteWithNativeSearch(context: ISearchRequestContext) {
    if (context.isXlarge || context.shouldWarmup || isNativeSearchAttemptDisabledForRuntime()) {
        return false;
    }

    try {
        const { tryRunNativeSearch } = await import('@electron/search/nativeSearch');
        const nativeResult = await tryRunNativeSearch({
            pdfPath: context.pdfPath,
            documentRevision: context.documentRevision,
            query: context.normalizedQuery,
            matchCase: context.matchCase,
            wholeWord: context.wholeWord,
            useRegex: context.useRegex,
            nativeServiceIdleTimeoutMs: workerResourcePolicy.nativeServiceIdleTimeoutMs,
            signal: context.signal,
            ...(context.pageCount !== undefined ? { pageCount: context.pageCount } : {}),
        });
        throwIfCancelled(context.requestId, context.signal);
        if (!nativeResult) {
            return false;
        }

        completeWithNativeSearch(context, nativeResult);
        return true;
    } catch (error) {
        if (isAbortError(error) || isCancelled(context.requestId)) {
            throw error;
        }
        log.debug(`Native search unavailable, falling back to JS search: ${getErrorMessage(error)}`);
        return false;
    }
}

function getXlargePageCount(context: ISearchRequestContext) {
    if (typeof context.pageCount === 'number' && context.pageCount > 0) {
        return context.pageCount;
    }
    throw new Error(
        'Xlarge search requires the document page count. The legacy whole-document index is unavailable.',
    );
}

function createXlargeSearchIndexBuildOptions(context: ISearchRequestContext) {
    const pageCount = getXlargePageCount(context);
    return {
        pdfPath: context.pdfPath,
        documentRevision: context.documentRevision,
        pageCount,
        signal: context.signal,
        onProgress: (progress: IXlargeSearchIndexBuildProgress) => {
            throwIfCancelled(context.requestId, context.signal);
            const processed = progress.complete
                ? progress.pageCount
                : Math.min(progress.pagesScanned, Math.max(0, progress.pageCount - 1));
            sendProgress(
                context.requestId,
                processed,
                progress.pageCount,
                progress.complete,
            );
        },
    };
}

async function buildXlargeSearchIndex(context: ISearchRequestContext) {
    const result = await ensureXlargeSearchIndex(createXlargeSearchIndexBuildOptions(context));
    throwIfCancelled(context.requestId, context.signal);
    return result;
}

async function tryCompleteWithXlargeSearch(context: ISearchRequestContext) {
    if (!context.isXlarge) {
        return false;
    }

    if (context.shouldWarmup) {
        await buildXlargeSearchIndex(context);
        throwIfCancelled(context.requestId, context.signal);
        postEmptySearchComplete(context.requestId);
        return true;
    }

    const {
        tryRunNativeSearch,
        XlargeNativeSearchCapabilityError,
        isXlargeNativeSearchCapabilityError,
    } = await import('@electron/search/nativeSearch');
    const isCapabilityError = (error: unknown) => (
        (typeof isXlargeNativeSearchCapabilityError === 'function'
            && isXlargeNativeSearchCapabilityError(error))
        || (
            typeof error === 'object'
            && error !== null
            && typeof (error as {kind?: unknown}).kind === 'string'
        )
    );
    const createCapabilityError = (
        kind: 'invalid-response' | 'native-failure',
        message: string,
        cause?: unknown,
    ) => {
        if (typeof XlargeNativeSearchCapabilityError === 'function') {
            return new XlargeNativeSearchCapabilityError(
                kind,
                message,
                cause === undefined ? {} : {cause},
            );
        }
        const fallbackError = new Error(message) as Error & {kind: string};
        fallbackError.name = 'XlargeNativeSearchCapabilityError';
        fallbackError.kind = kind;
        return fallbackError;
    };
    let rebuilt = false;
    for (;;) {
        throwIfCancelled(context.requestId, context.signal);
        try {
            const nativeResult = await tryRunNativeSearch({
                pdfPath: context.pdfPath,
                documentRevision: context.documentRevision,
                query: context.normalizedQuery,
                matchCase: context.matchCase,
                wholeWord: context.wholeWord,
                useRegex: context.useRegex,
                nativeServiceIdleTimeoutMs: workerResourcePolicy.nativeServiceIdleTimeoutMs,
                signal: context.signal,
                strictXlarge: true,
                skipLegacyGeometry: true,
                ...(context.pageCount === undefined ? {} : {pageCount: context.pageCount}),
            });
            throwIfCancelled(context.requestId, context.signal);
            if (!nativeResult) {
                throw createCapabilityError('invalid-response', 'Native xlarge search returned no result');
            }

            completeWithNativeSearch(context, nativeResult);
            return true;
        } catch (error) {
            if (isAbortError(error) || isCancelled(context.requestId)) {
                throw error;
            }
            if (
                !rebuilt
                && isCapabilityError(error)
                && (error as {kind?: unknown}).kind === 'index-missing-or-stale'
            ) {
                rebuilt = true;
                try {
                    await buildXlargeSearchIndex(context);
                } catch (buildError) {
                    if (isAbortError(buildError) || isCancelled(context.requestId)) {
                        throw buildError;
                    }
                    throw createCapabilityError(
                        'native-failure',
                        `Failed to build the xlarge search sidecar: ${getErrorMessage(buildError)}`,
                        buildError,
                    );
                }
                continue;
            }
            throw error;
        }
    }
}

function postSearchCancelled(requestId: string) {
    postMessage({
        type: 'cancelled',
        requestId,
    });
}

function postSearchError(
    requestId: string,
    error: unknown,
) {
    const errMsg = getErrorMessage(error);
    postMessage({
        type: 'error',
        requestId,
        error: `Search failed: ${errMsg}`,
    });
}

async function createSearchRequestContext(request: ISearchWorkerRequest): Promise<ISearchRequestContext> {
    const {
        requestId,
        pdfPath,
        documentRevision,
        query,
        pageCount,
        warmup,
        matchCase = false,
        wholeWord = false,
        useRegex = false,
    } = request;

    const abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);
    const { signal } = abortController;
    pruneCancelledRequests();
    progressSentAt.delete(requestId);
    throwIfCancelled(requestId, signal);

    const fileStat = !pdfPath ? null : await getPdfFileStat(pdfPath);
    if (!pdfPath || fileStat === null) {
        throw new Error(`PDF not found: ${pdfPath}`);
    }
    throwIfCancelled(requestId, signal);

    const pathSizeBytes = typeof fileStat.size === 'number' && Number.isFinite(fileStat.size)
        ? fileStat.size
        : undefined;
    const classification = classifyXlargeSearchPath({
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(pathSizeBytes === undefined ? {} : {pathSizeBytes}),
    });

    const context: ISearchRequestContext = {
        requestId,
        pdfPath,
        documentRevision,
        normalizedQuery: query.trim(),
        isXlarge: classification.isXlarge,
        shouldWarmup: warmup === true,
        matchCase,
        wholeWord,
        useRegex,
        signal,
    };
    if (pageCount !== undefined) {
        context.pageCount = pageCount;
    }
    if (pathSizeBytes !== undefined) {
        context.pathSizeBytes = pathSizeBytes;
    }
    return context;
}

async function getRequestSearchIndex(context: ISearchRequestContext) {
    const {
        requestId,
        pdfPath,
        documentRevision,
        pageCount,
        signal,
    } = context;

    const streamIndexedPage = createIndexedPageResultStreamer(context);
    const ensureOptions: Parameters<typeof ensureSearchIndex>[3] = {
        documentRevision,
        signal,
        throwIfCancelled: abortSignal => throwIfCancelled(requestId, abortSignal),
    };
    if (pageCount !== undefined) {
        ensureOptions.pageCount = pageCount;
    }
    if (streamIndexedPage !== undefined) {
        ensureOptions.onPageIndexed = streamIndexedPage;
    }

    const indexEntry = await ensureSearchIndex(
        indexCache,
        pdfPath,
        searchIndexCacheOptions,
        ensureOptions,
    );
    pruneRetainedTextCache(indexEntry);
    throwIfCancelled(requestId, signal);
    return indexEntry;
}

function getRetainedTextBytes(entry: ICachedIndex) {
    const cachedTextBytes = retainedTextBytesByIndex.get(entry.index);
    if (cachedTextBytes !== undefined) {
        return cachedTextBytes;
    }
    const textBytes = entry.index.pages.reduce(
        (total, page) => total + Buffer.byteLength(page.text ?? '', 'utf8'),
        0,
    );
    retainedTextBytesByIndex.set(entry.index, textBytes);
    return textBytes;
}

function pruneRetainedTextCache(retainedEntry: ICachedIndex) {
    const cachedEntries = Array.from(indexCache.entries())
        .map(([
            cacheKey,
            entry,
        ]) => ({
            cacheKey,
            entry,
            textBytes: getRetainedTextBytes(entry),
        }))
        .sort((left, right) => {
            if (left.entry === right.entry) {
                return 0;
            }
            if (left.entry === retainedEntry) {
                return 1;
            }
            if (right.entry === retainedEntry) {
                return -1;
            }
            return left.entry.accessedAt - right.entry.accessedAt;
        });
    let retainedTextBytes = cachedEntries.reduce(
        (total, entry) => total + entry.textBytes,
        0,
    );

    for (const entry of cachedEntries) {
        if (retainedTextBytes <= searchIndexCacheOptions.maxTotalTextBytes) {
            return;
        }
        indexCache.delete(entry.cacheKey);
        retainedTextBytes -= entry.textBytes;
    }
}

function getTotalPages(
    indexEntry: ICachedIndex,
    pageCount?: number,
) {
    return typeof pageCount === 'number' && pageCount > 0
        ? pageCount
        : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);
}

function isPageSearchable(
    page: IPdfSearchIndex['pages'][number],
    totalPages: number,
) {
    return page.pageNumber >= 1 && page.pageNumber <= totalPages;
}

function appendPageMatches(
    params: {
        context: ISearchRequestContext;
        page: IPdfSearchIndex['pages'][number];
        results: ISearchMatch[];
        globalMatchIndex: number;
    },
) {
    const {
        context,
        page,
        results,
    } = params;
    const pageText = page.text;
    let { globalMatchIndex } = params;
    let truncated = false;

    if (!pageText) {
        return {
            globalMatchIndex,
            truncated,
        };
    }

    let pageMatchIndex = 0;
    const pageNumber = parsePageNumber(page.pageNumber, context.pageCount);
    if (pageNumber === null) {
        return {
            globalMatchIndex,
            truncated,
        };
    }
    const pageMatches = iteratePageMatches(pageText, context.normalizedQuery, {
        matchCase: context.matchCase,
        wholeWord: context.wholeWord,
        useRegex: context.useRegex,
    });

    for (const pageMatch of pageMatches) {
        throwIfCancelled(context.requestId, context.signal);
        if (results.length >= SEARCH_RESULT_LIMIT) {
            truncated = true;
            break;
        }
        const startOffset = pageMatch.startOffset;
        const endOffset = pageMatch.endOffset;
        const words = collectSearchMatchWords(page, startOffset, endOffset);

        results.push({
            pageNumber,
            pageMatchIndex,
            matchIndex: globalMatchIndex,
            startOffset,
            endOffset,
            excerpt: buildExcerpt(pageText, startOffset, endOffset),
            ...(words !== undefined ? { words } : {}),
            ...(words !== undefined && page.pageWidth !== undefined ? { pageWidth: page.pageWidth } : {}),
            ...(words !== undefined && page.pageHeight !== undefined ? { pageHeight: page.pageHeight } : {}),
            ...(words !== undefined && page.rotation !== undefined ? { rotation: page.rotation } : {}),
        });

        pageMatchIndex += 1;
        globalMatchIndex += 1;

    }

    return {
        globalMatchIndex,
        truncated,
    };
}

function createIndexedPageResultStreamer(context: ISearchRequestContext) {
    if (context.shouldWarmup || context.normalizedQuery.length === 0) {
        return undefined;
    }

    const results: ISearchMatch[] = [];
    const totalPages = typeof context.pageCount === 'number' && context.pageCount > 0
        ? context.pageCount
        : 0;
    let globalMatchIndex = 0;
    let processedCount = 0;
    let truncated = false;

    return (page: IPdfSearchIndex['pages'][number]) => {
        throwIfCancelled(context.requestId, context.signal);
        const total = totalPages || Math.max(processedCount + 1, page.pageNumber);
        if (!isPageSearchable(page, total)) {
            return;
        }

        processedCount += 1;
        const wasTruncated = truncated;
        const previousResultCount = results.length;
        if (previousResultCount >= SEARCH_RESULT_LIMIT) {
            truncated = true;
        }
        if (!truncated && results.length < SEARCH_RESULT_LIMIT) {
            const pageResult = appendPageMatches({
                context,
                page,
                results,
                globalMatchIndex,
            });
            globalMatchIndex = pageResult.globalMatchIndex;
            truncated = pageResult.truncated;
            if (!truncated && results.length >= SEARCH_RESULT_LIMIT && processedCount < total) {
                truncated = true;
            }
        }

        if (results.length !== previousResultCount || (!wasTruncated && truncated)) {
            const resultDelta = results.slice(previousResultCount);
            sendProgress(context.requestId, processedCount, total, true, {
                results: resultDelta,
                resultsStartIndex: previousResultCount,
                truncated,
            });
            return;
        }

        sendProgress(context.requestId, processedCount, total);
    };
}

function searchIndex(
    context: ISearchRequestContext,
    indexEntry: ICachedIndex,
): ISearchExecutionResult {
    const totalPages = getTotalPages(indexEntry, context.pageCount);
    sendProgress(context.requestId, 0, totalPages, true);

    const results: ISearchMatch[] = [];
    let globalMatchIndex = 0;
    let processedCount = 0;
    let truncated = false;

    for (let pageIdx = 0; pageIdx < indexEntry.index.pages.length; pageIdx += 1) {
        throwIfCancelled(context.requestId, context.signal);

        const page = indexEntry.index.pages[pageIdx];
        if (!page || !isPageSearchable(page, totalPages)) {
            continue;
        }

        const pageResult = appendPageMatches({
            context,
            page,
            results,
            globalMatchIndex,
        });
        globalMatchIndex = pageResult.globalMatchIndex;
        truncated = pageResult.truncated;

        processedCount += 1;
        sendProgress(context.requestId, processedCount, totalPages);

        if (truncated) {
            break;
        }
    }

    if (processedCount < totalPages) {
        sendProgress(context.requestId, totalPages, totalPages, true);
    } else {
        sendProgress(context.requestId, processedCount, totalPages, true);
    }
    throwIfCancelled(context.requestId, context.signal);

    return {
        results,
        truncated,
    };
}

function handleSearchRequestError(
    requestId: string,
    error: unknown,
) {
    if (isAbortError(error) || isCancelled(requestId)) {
        postSearchCancelled(requestId);
        return;
    }

    postSearchError(requestId, error);
}

function cleanupSearchRequest(requestId: string) {
    requestAbortControllers.delete(requestId);
    progressSentAt.delete(requestId);
    cancelledRequests.delete(requestId);
}

async function processSearchRequest(request: ISearchWorkerRequest) {
    try {
        const context = await createSearchRequestContext(request);

        if (context.normalizedQuery.length === 0 && !context.shouldWarmup) {
            throwIfCancelled(context.requestId, context.signal);
            postEmptySearchComplete(context.requestId);
            return;
        }

        if (await tryCompleteWithXlargeSearch(context)) {
            return;
        }

        if (await tryCompleteWithNativeSearch(context)) {
            return;
        }

        const indexEntry = await getRequestSearchIndex(context);

        if (context.shouldWarmup) {
            throwIfCancelled(context.requestId, context.signal);
            postEmptySearchComplete(context.requestId);
            return;
        }

        postSearchComplete(context.requestId, searchIndex(context, indexEntry));
    } catch (error) {
        handleSearchRequestError(request.requestId, error);
    } finally {
        cleanupSearchRequest(request.requestId);
    }
}

function startSearchRequest(request: ISearchWorkerRequest) {
    const operation = processSearchRequest(request);
    activeSearchRequests.add(operation);
    void operation.finally(() => activeSearchRequests.delete(operation));
}

async function shutdownSearchWorker(reason: string) {
    if (shutdownStarted) {
        return;
    }
    shutdownStarted = true;
    for (const controller of requestAbortControllers.values()) {
        controller.abort();
    }
    let shutdownError: string | undefined;
    try {
        await shutdownPersistentNativeSearchServices(reason);
    } catch (error) {
        shutdownError = getErrorMessage(error);
    }
    await Promise.allSettled(activeSearchRequests);
    const shutdownResult = {
        type: 'shutdown-complete',
        ...(shutdownError ? {error: shutdownError} : {}),
    } satisfies ISearchWorkerShutdownResult;
    parentPort?.postMessage(shutdownResult);
    parentPort?.close();
}

parentPort?.on('message', (rawMessage: unknown) => {
    const message = parseSearchWorkerInboundMessage(rawMessage);
    if (!message) {
        log.warn('Ignoring malformed search worker inbound message');
        return;
    }

    switch (message.type) {
        case 'cancel':
            markRequestCancelled(message.requestId);
            requestAbortControllers.get(message.requestId)?.abort();
            return;
        case 'reset-cache':
            indexCache.clear();
            resetXlargeSearchIndexBuilds();
            resetPersistentNativeSearchServiceCaches();
            pruneCancelledRequests();
            return;
        case 'reset-state':
            indexCache.clear();
            resetXlargeSearchIndexBuilds();
            resetPersistentNativeSearchServiceCaches();
            cancelledRequests.clear();
            progressSentAt.clear();
            return;
        case 'shutdown':
            void shutdownSearchWorker(message.reason).catch((error: unknown) => {
                log.warn(`Search worker shutdown sequence failed: ${getErrorMessage(error)}`);
                parentPort?.close();
            });
            return;
        case 'search':
            if (shutdownStarted) {
                postMessage({
                    type: 'error',
                    requestId: message.payload.requestId,
                    error: 'Search worker is shutting down',
                });
                return;
            }
            if (requestAbortControllers.has(message.payload.requestId)) {
                postMessage({
                    type: 'error',
                    requestId: message.payload.requestId,
                    error: `Search failed: duplicate active requestId "${message.payload.requestId}"`,
                });
                return;
            }
            startSearchRequest(message.payload);
            return;
        default:
            assertNever(message);
    }
});

log.debug('Search worker initialized');
