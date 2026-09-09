import {
    rm,
    stat,
} from 'fs/promises';
import { sortBy } from 'es-toolkit/array';
import { sumBy } from 'es-toolkit/math';
import type {IPdfSearchIndex} from '@electron/features/search/searchIndexTypes';
import {SEARCH_INDEX_SCHEMA_VERSION} from '@electron/features/search/searchIndexSchemaVersion';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/features/search/searchIndexBuilderPublic';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';

export interface ICachedIndex {
    mtimeMs: number;
    sourceMtimeMs: number;
    index: IPdfSearchIndex;
    accessedAt: number;
    validatedTextBudget: boolean;
}

export interface ISearchIndexCacheOptions {
    maxEntries: number;
    ttlMs: number;
    maxPageTextBytes: number;
    maxTotalTextBytes: number;
}

interface IEnsureSearchIndexOptions {
    documentRevision: TDocumentRevisionToken;
    pageCount?: number;
    signal?: AbortSignal;
    throwIfCancelled: (signal?: AbortSignal) => void;
    onPageIndexed?: (page: IPdfSearchIndex['pages'][number]) => void;
}

interface IInFlightSearchIndexBuild {
    controller: AbortController;
    promise: Promise<ICachedIndex> | null;
    waiterCount: number;
    indexedPages: IPdfSearchIndex['pages'];
    waiters: Set<IInFlightSearchIndexWaiter>;
    expectedCount?: number;
}

interface IInFlightSearchIndexWaiter {
    nextPageIndex: number;
    onPageIndexed?: (page: IPdfSearchIndex['pages'][number]) => void;
    streamFailed: boolean;
}

class SearchIndexTextBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SearchIndexTextBudgetError';
    }
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

export function getIndexCacheKey(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    return `${pdfPath}\0${documentRevision}`;
}

function getIndexBuildKey(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    return getIndexCacheKey(pdfPath, documentRevision);
}

const MAX_SEARCH_INDEX_REBUILD_ATTEMPTS = 2;

const inFlightIndexBuilds = new Map<string, IInFlightSearchIndexBuild>();

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function statMtimeMs(filePath: string) {
    try {
        return (await stat(filePath)).mtimeMs;
    } catch {
        return null;
    }
}

async function getSearchSourceMtimeMs(pdfPath: string) {
    const [
        pdfMtimeMs,
        ocrManifestMtimeMs,
    ] = await Promise.all([
        statMtimeMs(pdfPath),
        statMtimeMs(`${pdfPath}.ocr/manifest.json`),
    ]);

    return Math.max(pdfMtimeMs ?? 0, ocrManifestMtimeMs ?? 0);
}

function pruneIndexCache(
    indexCache: Map<string, ICachedIndex>,
    options: ISearchIndexCacheOptions,
    now = Date.now(),
) {
    const freshEntries = Array.from(indexCache.entries())
        .filter(([
            ,
            entry,
        ]) => now - entry.accessedAt <= options.ttlMs);
    const retainedEntries = sortBy(
        freshEntries,
        [entry => entry[1].accessedAt],
    ).slice(Math.max(0, freshEntries.length - options.maxEntries));

    indexCache.clear();
    retainedEntries.forEach(([
        pdfPath,
        entry,
    ]) => indexCache.set(pdfPath, entry));
}

function validateIndexTextBudget(
    index: IPdfSearchIndex,
    options: ISearchIndexCacheOptions,
) {
    let totalTextBytes = 0;

    for (const page of index.pages) {
        const pageText = page.text;
        const pageTextBytes = Buffer.byteLength(pageText, 'utf8');
        if (pageTextBytes > options.maxPageTextBytes) {
            throw new SearchIndexTextBudgetError(
                `Search index page ${page.pageNumber} is too large (${Math.round(pageTextBytes / 1024)}KB > `
                + `${Math.round(options.maxPageTextBytes / 1024)}KB limit)`,
            );
        }

        totalTextBytes += pageTextBytes;
        if (totalTextBytes > options.maxTotalTextBytes) {
            throw new SearchIndexTextBudgetError(
                `Search index resident text budget exceeded (${Math.round(totalTextBytes / (1024 * 1024))}MB > `
                + `${Math.round(options.maxTotalTextBytes / (1024 * 1024))}MB limit)`,
            );
        }
    }
}

async function deleteSearchIndexFile(
    indexCache: Map<string, ICachedIndex>,
    cacheKey: string,
    indexPath: string,
) {
    indexCache.delete(cacheKey);
    await rm(indexPath, { force: true }).catch(() => undefined);
}

async function loadCachedIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    options: ISearchIndexCacheOptions,
): Promise<ICachedIndex | null> {
    const now = Date.now();
    pruneIndexCache(indexCache, options, now);
    const cacheKey = getIndexCacheKey(pdfPath, documentRevision);
    const indexPath = getIndexPath(pdfPath);

    const mtimeMs = await statMtimeMs(indexPath);
    if (mtimeMs === null) {
        indexCache.delete(cacheKey);
        return null;
    }
    const sourceMtimeMs = await getSearchSourceMtimeMs(pdfPath);

    const cached = indexCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs && cached.sourceMtimeMs === sourceMtimeMs) {
        const touched = {
            ...cached,
            accessedAt: now,
        };
        indexCache.set(cacheKey, touched);
        return touched;
    }

    if (sourceMtimeMs > mtimeMs) {
        indexCache.delete(cacheKey);
        return null;
    }

    const index = await loadSearchIndex(pdfPath, documentRevision);
    if (!index) {
        indexCache.delete(cacheKey);
        return null;
    }

    const entry: ICachedIndex = {
        mtimeMs,
        sourceMtimeMs,
        index,
        accessedAt: now,
        validatedTextBudget: true,
    };
    try {
        validateIndexTextBudget(entry.index, options);
    } catch (error) {
        if (error instanceof SearchIndexTextBudgetError) {
            await deleteSearchIndexFile(indexCache, cacheKey, indexPath);
            return null;
        }
        throw error;
    }
    indexCache.set(cacheKey, entry);
    pruneIndexCache(indexCache, options, now);
    return entry;
}

async function cacheBuiltIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    index: IPdfSearchIndex,
    options: ISearchIndexCacheOptions,
): Promise<ICachedIndex> {
    const now = Date.now();
    pruneIndexCache(indexCache, options, now);
    const cacheKey = getIndexCacheKey(pdfPath, documentRevision);
    const indexPath = getIndexPath(pdfPath);
    const mtimeMs = await statMtimeMs(indexPath) ?? Date.now();
    const sourceMtimeMs = await getSearchSourceMtimeMs(pdfPath);

    const entry: ICachedIndex = {
        mtimeMs,
        sourceMtimeMs,
        index,
        accessedAt: now,
        validatedTextBudget: true,
    };
    try {
        validateIndexTextBudget(entry.index, options);
    } catch (error) {
        if (error instanceof SearchIndexTextBudgetError) {
            await deleteSearchIndexFile(indexCache, cacheKey, indexPath);
        }
        throw error;
    }
    indexCache.set(cacheKey, entry);
    pruneIndexCache(indexCache, options, now);
    return entry;
}

function shouldRebuildCachedIndex(
    entry: ICachedIndex,
    documentRevision: TDocumentRevisionToken,
    expectedCount?: number,
) {
    if (entry.index.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
        return true;
    }
    if (entry.index.documentRevision.token !== documentRevision) {
        return true;
    }

    if (typeof expectedCount !== 'number' || expectedCount <= 0) {
        return false;
    }

    if (entry.index.pages.length < expectedCount) {
        return true;
    }

    const inRangeCount = sumBy(
        entry.index.pages,
        page => page.pageNumber >= 1 && page.pageNumber <= expectedCount ? 1 : 0,
    );

    return inRangeCount < expectedCount;
}

function isNativeSearchSidecarDisabledForRuntime() {
    return process.env.EVB_PDF_SEARCH_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_SEARCH_ENABLE !== '1');
}

async function ensureNativeSearchSidecar(
    pdfPath: string,
    entry: ICachedIndex,
    documentRevision: TDocumentRevisionToken,
    signal?: AbortSignal,
) {
    if (isNativeSearchSidecarDisabledForRuntime()) {
        return;
    }

    try {
        const { ensureNativeSearchIndexBestEffort } = await import('@electron/features/search/nativeSearchIndex');
        await ensureNativeSearchIndexBestEffort(pdfPath, entry.index, documentRevision, signal);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw error;
        }
    }
}

function waitForInFlightIndexBuild(
    build: IInFlightSearchIndexBuild,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPdfSearchIndex['pages'][number]) => void,
) {
    if (signal?.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }

    build.waiterCount += 1;
    let released = false;
    const waiter: IInFlightSearchIndexWaiter = {
        nextPageIndex: 0,
        ...(onPageIndexed !== undefined ? {onPageIndexed} : {}),
        streamFailed: false,
    };
    build.waiters.add(waiter);

    return new Promise<ICachedIndex>((resolve, reject) => {
        const release = (abortIfOrphaned: boolean) => {
            if (released) {
                return;
            }
            released = true;
            build.waiters.delete(waiter);
            if (signal) {
                signal.removeEventListener('abort', handleAbort);
            }
            build.waiterCount = Math.max(0, build.waiterCount - 1);
            if (abortIfOrphaned && build.waiterCount === 0 && !build.controller.signal.aborted) {
                build.controller.abort(createAbortError('Search index build cancelled; no waiting requests remain'));
            }
        };

        const handleAbort = () => {
            release(true);
            reject(signal ? abortErrorFromSignal(signal) : createAbortError());
        };

        if (signal) {
            signal.addEventListener('abort', handleAbort, {once: true});
        }

        notifyIndexBuildWaiter(build, waiter);

        const buildPromise = build.promise;
        if (!buildPromise) {
            release(false);
            reject(new Error('Search index build was not initialized'));
            return;
        }

        buildPromise.then(
            entry => {
                release(false);
                resolve(entry);
            },
            error => {
                release(false);
                reject(error);
            },
        );
    });
}

function notifyIndexBuildWaiter(
    build: IInFlightSearchIndexBuild,
    waiter: IInFlightSearchIndexWaiter,
) {
    if (waiter.streamFailed || waiter.onPageIndexed === undefined) {
        waiter.nextPageIndex = build.indexedPages.length;
        return;
    }

    while (waiter.nextPageIndex < build.indexedPages.length) {
        const page = build.indexedPages[waiter.nextPageIndex];
        waiter.nextPageIndex += 1;
        if (page === undefined) {
            continue;
        }
        try {
            waiter.onPageIndexed(page);
        } catch {
            waiter.streamFailed = true;
            delete waiter.onPageIndexed;
            waiter.nextPageIndex = build.indexedPages.length;
            return;
        }
    }
}

function publishIndexedPageToWaiters(
    build: IInFlightSearchIndexBuild,
    page: IPdfSearchIndex['pages'][number],
) {
    build.indexedPages.push(page);
    for (const waiter of build.waiters) {
        notifyIndexBuildWaiter(build, waiter);
    }
}

function createInFlightIndexBuild(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    cacheOptions: ISearchIndexCacheOptions,
    expectedCount: number | undefined,
) {
    const buildKey = getIndexBuildKey(pdfPath, documentRevision);
    const existing = inFlightIndexBuilds.get(buildKey);
    if (existing) {
        const shouldReplaceUnknownCountBuild = isPositiveInteger(expectedCount)
            && (!isPositiveInteger(existing.expectedCount) || existing.expectedCount < expectedCount);
        if (!shouldReplaceUnknownCountBuild) {
            return existing;
        }
        existing.controller.abort();
        inFlightIndexBuilds.delete(buildKey);
    }

    const controller = new AbortController();
    const build: IInFlightSearchIndexBuild = {
        controller,
        waiterCount: 0,
        indexedPages: [],
        waiters: new Set(),
        promise: null,
        ...(expectedCount !== undefined ? { expectedCount } : {}),
    };

    const buildOptions: Parameters<typeof buildSearchIndex>[2] = {
        documentRevision,
        signal: controller.signal,
    };
    if (expectedCount !== undefined) {
        buildOptions.pageCount = expectedCount;
    }
    buildOptions.onPageIndexed = page => publishIndexedPageToWaiters(build, page);
    buildOptions.validateBeforePersist = index => validateIndexTextBudget(index, cacheOptions);

    build.promise = (async () => {
        const entry = await cacheBuiltIndex(
            indexCache,
            pdfPath,
            documentRevision,
            await buildSearchIndex(pdfPath, [], buildOptions),
            cacheOptions,
        );
        await ensureNativeSearchSidecar(pdfPath, entry, documentRevision, controller.signal);
        return entry;
    })().finally(() => {
        if (inFlightIndexBuilds.get(buildKey) === build) {
            inFlightIndexBuilds.delete(buildKey);
        }
    });
    inFlightIndexBuilds.set(buildKey, build);
    return build;
}

export async function ensureSearchIndex(
    indexCache: Map<string, ICachedIndex>,
    pdfPath: string,
    cacheOptions: ISearchIndexCacheOptions,
    ensureOptions: IEnsureSearchIndexOptions,
): Promise<ICachedIndex> {
    const expectedCount = ensureOptions.pageCount;
    const {
        documentRevision,
        signal,
    } = ensureOptions;
    ensureOptions.throwIfCancelled(signal);

    let entry = await loadCachedIndex(indexCache, pdfPath, documentRevision, cacheOptions);
    ensureOptions.throwIfCancelled(signal);
    let rebuildAttempts = 0;
    while (!entry || (
        rebuildAttempts < MAX_SEARCH_INDEX_REBUILD_ATTEMPTS
        && shouldRebuildCachedIndex(entry, documentRevision, expectedCount)
    )) {
        entry = await waitForInFlightIndexBuild(createInFlightIndexBuild(
            indexCache,
            pdfPath,
            documentRevision,
            cacheOptions,
            expectedCount,
        ), signal, ensureOptions.onPageIndexed);
        rebuildAttempts += 1;
        ensureOptions.throwIfCancelled(signal);
    }

    if (!entry.validatedTextBudget) {
        validateIndexTextBudget(entry.index, cacheOptions);
        entry.validatedTextBudget = true;
    }

    await ensureNativeSearchSidecar(pdfPath, entry, documentRevision, signal);
    return entry;
}
