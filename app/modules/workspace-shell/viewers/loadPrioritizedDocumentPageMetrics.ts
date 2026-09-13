import {
    createLazyIndexedCollection,
    type IDocumentPageMetrics,
    type IDocumentPageSource,
    type ILazyIndexedCollection,
} from '@app/modules/document-viewer/public';

const COLD_OPEN_PROVISIONAL_PAGE_METRIC: IDocumentPageMetrics = Object.freeze({
    widthPoints: 612,
    heightPoints: 792,
    rotation: 0,
});
const METRIC_HYDRATION_YIELD_INTERVAL = 128;
const METRIC_HYDRATION_MAX_CONCURRENCY = 8;
const DOCUMENT_PAGE_METRICS_CHUNK_SIZE = 256;
const DOCUMENT_PAGE_METRICS_MAX_CACHED_CHUNKS = 32;

/**
 * The document page source still has a few small-document array consumers.
 * Keep those consumers concrete below this limit, but never make a page-count
 * sized array for a large document. The same boundary also disables eager
 * background metric hydration, since PDF.js retains page requests at the
 * document level.
 */
const DOCUMENT_PAGE_METRICS_DENSE_COMPATIBILITY_LIMIT = 20_000;

export interface IDocumentPageMetricsCollection extends ILazyIndexedCollection<IDocumentPageMetrics> {
    readonly isSparseDocumentPageMetrics: true;
    readonly exactPageCount: number;
    readonly exactRevision: number;
    readonly fallbackMetric: IDocumentPageMetrics;
    readonly forEachExact: (callback: (pageNumber: number, metric: IDocumentPageMetrics) => void) => void;
    readonly hasExact: (pageNumber: number) => boolean;
    readonly getEstimated: (pageNumber: number) => IDocumentPageMetrics;
    readonly getExactPageNumbers: () => readonly number[];
    readonly setExact: (pageNumber: number, metric: IDocumentPageMetrics) => void;
    readonly mergeExact: (
        updates: ReadonlyMap<number, IDocumentPageMetrics>,
    ) => IDocumentPageMetricsCollection;
}

export type TDocumentPageMetricsCollection = IDocumentPageMetrics[] | IDocumentPageMetricsCollection;

function cloneMetric(metric: IDocumentPageMetrics) {
    return {
        widthPoints: metric.widthPoints,
        heightPoints: metric.heightPoints,
        rotation: metric.rotation,
    } satisfies IDocumentPageMetrics;
}

function normalizePageCount(pageCount: number) {
    return Math.max(0, Math.trunc(pageCount));
}

function normalizePageNumber(pageNumber: number, pageCount: number) {
    const safePageNumber = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
    return Math.max(1, Math.min(pageCount, safePageNumber));
}

function createDenseDocumentPageMetrics(
    pageCount: number,
    initialMetric: IDocumentPageMetrics,
) {
    const metrics: IDocumentPageMetrics[] = [];
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        metrics.push(cloneMetric(initialMetric));
    }
    return metrics;
}

function createSparseDocumentPageMetrics(
    pageCount: number,
    fallbackMetric: IDocumentPageMetrics,
    initialExactMetrics: ReadonlyMap<number, IDocumentPageMetrics> = new Map(),
): IDocumentPageMetricsCollection {
    const exactMetrics = new Map(initialExactMetrics);
    let exactRevision = 0;
    const safeFallbackMetric = Object.freeze(cloneMetric(fallbackMetric));
    const collection = createLazyIndexedCollection<IDocumentPageMetrics>({
        cacheValues: false,
        chunkSize: DOCUMENT_PAGE_METRICS_CHUNK_SIZE,
        length: pageCount,
        maxCachedChunks: DOCUMENT_PAGE_METRICS_MAX_CACHED_CHUNKS,
        getValue: index => exactMetrics.get(index + 1) ?? safeFallbackMetric,
    }) as IDocumentPageMetricsCollection;

    Object.defineProperties(collection, {
        isSparseDocumentPageMetrics: {
            configurable: false,
            enumerable: false,
            value: true,
        },
        exactPageCount: {
            configurable: false,
            enumerable: false,
            get: () => exactMetrics.size,
        },
        exactRevision: {
            configurable: false,
            enumerable: false,
            get: () => exactRevision,
        },
        fallbackMetric: {
            configurable: false,
            enumerable: false,
            value: safeFallbackMetric,
        },
        forEachExact: {
            configurable: false,
            enumerable: false,
            value: (callback: (pageNumber: number, metric: IDocumentPageMetrics) => void) => {
                for (const [
                    pageNumber,
                    metric,
                ] of exactMetrics) {
                    callback(pageNumber, metric);
                }
            },
        },
        hasExact: {
            configurable: false,
            enumerable: false,
            value: (pageNumber: number) => Number.isInteger(pageNumber) && exactMetrics.has(pageNumber),
        },
        getEstimated: {
            configurable: false,
            enumerable: false,
            value: () => safeFallbackMetric,
        },
        getExactPageNumbers: {
            configurable: false,
            enumerable: false,
            value: () => [...exactMetrics.keys()].sort((left, right) => left - right),
        },
        setExact: {
            configurable: false,
            enumerable: false,
            value: (pageNumber: number, metric: IDocumentPageMetrics) => {
                if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) {
                    exactMetrics.set(pageNumber, metric);
                    exactRevision += 1;
                }
            },
        },
        mergeExact: {
            configurable: false,
            enumerable: false,
            value: (updates: ReadonlyMap<number, IDocumentPageMetrics>) => {
                if (updates.size === 0) {
                    return collection;
                }
                for (const [
                    pageNumber,
                    metric,
                ] of updates) {
                    if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) {
                        exactMetrics.set(pageNumber, metric);
                        exactRevision += 1;
                    }
                }
                return collection;
            },
        },
    });
    return collection;
}

export function isSparseDocumentPageMetrics(
    metrics: TDocumentPageMetricsCollection,
): metrics is IDocumentPageMetricsCollection {
    return 'isSparseDocumentPageMetrics' in metrics;
}

export function mergeDocumentPageMetrics(
    metrics: TDocumentPageMetricsCollection,
    updates: ReadonlyMap<number, IDocumentPageMetrics>,
) {
    if (updates.size === 0) {
        return metrics;
    }
    if (isSparseDocumentPageMetrics(metrics)) {
        return metrics.mergeExact(updates);
    }
    const nextMetrics = metrics.slice();
    for (const [
        pageNumber,
        metric,
    ] of updates) {
        if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= nextMetrics.length) {
            nextMetrics[pageNumber - 1] = metric;
        }
    }
    return nextMetrics;
}

function createDocumentPageMetrics(
    pageCount: number,
    initialMetric: IDocumentPageMetrics,
    initialExactMetrics?: ReadonlyMap<number, IDocumentPageMetrics>,
): TDocumentPageMetricsCollection {
    const safePageCount = normalizePageCount(pageCount);
    if (safePageCount <= DOCUMENT_PAGE_METRICS_DENSE_COMPATIBILITY_LIMIT) {
        const denseMetrics = createDenseDocumentPageMetrics(safePageCount, initialMetric);
        if (initialExactMetrics) {
            for (const [
                pageNumber,
                metric,
            ] of initialExactMetrics) {
                if (pageNumber >= 1 && pageNumber <= denseMetrics.length) {
                    denseMetrics[pageNumber - 1] = metric;
                }
            }
        }
        return denseMetrics;
    }
    return createSparseDocumentPageMetrics(safePageCount, initialMetric, initialExactMetrics);
}

export async function loadInitialDocumentPageMetric(
    source: IDocumentPageSource,
    pageNumber: number,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const metric = await source.getPageMetrics(pageNumber, signal);
    signal.throwIfAborted();
    return metric;
}

/**
 * Gives every page a renderable shell immediately while exact metrics hydrate
 * nearest-first. The initial page is the best available document-local shape;
 * cloning avoids later replacement of one page mutating another page's shell.
 */
export function createProvisionalDocumentPageMetrics(
    pageCount: number,
    initialMetric: IDocumentPageMetrics,
) {
    return createDocumentPageMetrics(pageCount, initialMetric);
}

export function createColdOpenProvisionalDocumentPageMetrics(requestedPage: number) {
    const pageCount = Math.max(1, Math.trunc(requestedPage));
    return createProvisionalDocumentPageMetrics(pageCount, COLD_OPEN_PROVISIONAL_PAGE_METRIC);
}

export async function hydrateRemainingDocumentPageMetrics(options: {
    source: IDocumentPageSource;
    initialPage: number;
    initialMetric: IDocumentPageMetrics;
    signal: AbortSignal;
    isCurrent: () => boolean;
    getPriorityPage?: () => number;
    getPriorityPages?: () => readonly number[];
    loadMetric?: (
        pageNumber: number,
        signal: AbortSignal,
    ) => Promise<IDocumentPageMetrics>;
    onMetric?: (pageNumber: number, metric: IDocumentPageMetrics) => void;
    concurrency?: number;
    maxHydratedPages?: number;
}) {
    const {
        source,
        initialPage,
        initialMetric,
        signal,
        isCurrent,
        getPriorityPage = () => initialPage,
        getPriorityPages,
        loadMetric = (pageNumber, activeSignal) => source.getPageMetrics(pageNumber, activeSignal),
        onMetric,
        concurrency = 4,
        maxHydratedPages = Number.POSITIVE_INFINITY,
    } = options;
    const pageCount = normalizePageCount(source.pageCount);
    signal.throwIfAborted();
    if (!isCurrent()) {
        return null;
    }
    const safeInitialPage = normalizePageNumber(initialPage, pageCount);
    const initialExactMetrics = new Map<number, IDocumentPageMetrics>([[
        safeInitialPage,
        initialMetric,
    ]]);
    const metrics = createDocumentPageMetrics(pageCount, initialMetric, initialExactMetrics);
    const sparseMetrics = isSparseDocumentPageMetrics(metrics) ? metrics : null;
    if (pageCount > DOCUMENT_PAGE_METRICS_DENSE_COMPATIBILITY_LIMIT) {
        return metrics;
    }
    // Sparse collections own their exact values. Dense compatibility arrays
    // need a side index so the scheduler can tell provisional values from
    // hydrated values without probing or enumerating every page.
    const exactMetrics = sparseMetrics
        ? null
        : initialExactMetrics;
    let lowerCursor = safeInitialPage - 1;
    let upperCursor = safeInitialPage + 1;
    const inFlightPages = new Set<number>();
    let hydratedMetricCount = 0;
    let scheduledMetricCount = 0;
    const hydrationLimit = Number.isFinite(maxHydratedPages)
        ? Math.max(0, Math.trunc(maxHydratedPages))
        : Number.POSITIVE_INFINITY;
    const isUnavailable = (pageNumber: number) => (
        pageNumber === safeInitialPage
        || (sparseMetrics?.hasExact(pageNumber) ?? exactMetrics?.has(pageNumber) ?? false)
        || inFlightPages.has(pageNumber)
    );
    const resolvePriorityPage = () => {
        const requestedPriority = Math.max(
            1,
            Math.min(pageCount, Math.trunc(getPriorityPage())),
        );
        return Number.isFinite(requestedPriority) ? requestedPriority : safeInitialPage;
    };
    const takeCursorPage = (priorityPage: number) => {
        while (lowerCursor >= 1 && isUnavailable(lowerCursor)) {
            lowerCursor -= 1;
        }
        while (upperCursor <= pageCount && isUnavailable(upperCursor)) {
            upperCursor += 1;
        }
        const lowerDistance = lowerCursor >= 1
            ? Math.abs(lowerCursor - priorityPage)
            : Number.POSITIVE_INFINITY;
        const upperDistance = upperCursor <= pageCount
            ? Math.abs(upperCursor - priorityPage)
            : Number.POSITIVE_INFINITY;
        if (lowerDistance === Number.POSITIVE_INFINITY && upperDistance === Number.POSITIVE_INFINITY) {
            return null;
        }
        if (lowerDistance <= upperDistance) {
            const selectedPage = lowerCursor;
            lowerCursor -= 1;
            return selectedPage;
        }
        const selectedPage = upperCursor;
        upperCursor += 1;
        return selectedPage;
    };
    const takePriorityPage = () => {
        const requestedPages = getPriorityPages?.() ?? [];
        const seenPages = new Set<number>();
        for (const requestedPage of requestedPages) {
            if (!Number.isFinite(requestedPage)) {
                continue;
            }
            const pageNumber = normalizePageNumber(requestedPage, pageCount);
            if (
                seenPages.has(pageNumber)
                || isUnavailable(pageNumber)
            ) {
                continue;
            }
            seenPages.add(pageNumber);
            inFlightPages.add(pageNumber);
            return pageNumber;
        }
        return null;
    };
    const takeNextPage = () => {
        if (scheduledMetricCount >= hydrationLimit) {
            return null;
        }
        if (getPriorityPages) {
            const selectedPriorityPage = takePriorityPage();
            if (selectedPriorityPage !== null) {
                scheduledMetricCount += 1;
                return selectedPriorityPage;
            }
        }
        const priorityPage = resolvePriorityPage();
        if (priorityPage !== safeInitialPage && !isUnavailable(priorityPage)) {
            inFlightPages.add(priorityPage);
            scheduledMetricCount += 1;
            return priorityPage;
        }
        const selectedPage = takeCursorPage(priorityPage);
        if (selectedPage !== null) {
            inFlightPages.add(selectedPage);
            scheduledMetricCount += 1;
        }
        return selectedPage;
    };
    const runWorker = async () => {
        for (;;) {
            signal.throwIfAborted();
            if (!isCurrent()) {
                return;
            }
            const pageNumber = takeNextPage();
            if (pageNumber === null) {
                return;
            }
            try {
                const metric = await loadMetric(pageNumber, signal);
                signal.throwIfAborted();
                if (!isCurrent()) {
                    return;
                }
                if (sparseMetrics) {
                    sparseMetrics.setExact(pageNumber, metric);
                } else {
                    exactMetrics?.set(pageNumber, metric);
                    metrics[pageNumber - 1] = metric;
                }
                onMetric?.(pageNumber, metric);
                hydratedMetricCount += 1;
                if (hydratedMetricCount % METRIC_HYDRATION_YIELD_INTERVAL === 0) {
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
            } finally {
                inFlightPages.delete(pageNumber);
            }
        }
    };
    const normalizedConcurrency = Number.isFinite(concurrency)
        ? Math.max(1, Math.trunc(concurrency))
        : 4;
    const workerCount = Math.min(
        METRIC_HYDRATION_MAX_CONCURRENCY,
        normalizedConcurrency,
        Math.max(0, pageCount - 1),
        hydrationLimit,
    );
    const workers: Array<Promise<void>> = [];
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        workers.push(runWorker());
    }
    await Promise.all(workers);
    return isCurrent() ? metrics : null;
}
