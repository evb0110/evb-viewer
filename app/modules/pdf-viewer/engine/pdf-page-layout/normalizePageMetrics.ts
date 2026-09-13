import {isFinitePositive} from '@contracts/runtimeGuards';
import type { TPdfViewRotation } from '@contracts/shared';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import {
    createLazyIndexedCollection,
    isLazyIndexedCollection,
    type ILazyIndexedCollection,
} from '@app/modules/document-viewer/public';

export { createLazyIndexedCollection };

type IPdfLazyIndexedCollection<T> = ILazyIndexedCollection<T>;
export type { IPdfLazyIndexedCollection };

/**
 * A page metric collection is deliberately small at the interface. Callers
 * can still use `length`, numeric reads, and `map`, while large documents keep
 * their values in bounded chunks instead of allocating one array per page.
 */
export interface IPdfPageMetricCollection extends ILazyIndexedCollection<IPdfPageMetric> {
    readonly isSparsePageMetricCollection: true;
    readonly exactPageCount: number;
    readonly estimate: (index: number) => IPdfPageMetric;
    readonly estimateRange: (
        start: number,
        end: number,
        dimension: 'width' | 'height',
    ) => number;
    readonly maximumWidth: number;
    readonly maximumHeight: number;
    readonly knownIndices: readonly number[];
    readonly hasExact: (index: number) => boolean;
}

export const PDF_PAGE_METRICS_CHUNK_SIZE = 256;
// Keep the established dense behavior for ordinary documents. Above this
// boundary, page metrics remain sparse so a page arrival cannot rebuild a
// page-count-sized layout graph in the renderer.
export const PDF_PAGE_METRICS_DENSE_LIMIT = 20_000;

interface IKnownMetricEntry {
    index: number;
    metric: IPdfPageMetric;
}

function isValidPageMetric(metric: IPdfPageMetric | null | undefined): metric is IPdfPageMetric {
    return isFinitePositive(metric?.width) && isFinitePositive(metric.height);
}

function clonePageMetric(metric: IPdfPageMetric): IPdfPageMetric {
    return {
        width: metric.width,
        height: metric.height,
        ...(metric.rotation !== undefined ? {rotation: metric.rotation} : {}),
        ...(metric.userUnit !== undefined ? {userUnit: metric.userUnit} : {}),
    };
}

/**
 * Layout owns the document's projected dimensions. It never changes the
 * source metric, which keeps PDF persistence, print, and source-space tools
 * independent from a display rotation.
 */
export function projectPdfPageMetricForView(
    metric: IPdfPageMetric,
    viewRotation: TPdfViewRotation = 0,
): IPdfPageMetric {
    const cloned = clonePageMetric(metric);
    if (viewRotation === 90 || viewRotation === 270) {
        return {
            ...cloned,
            width: cloned.height,
            height: cloned.width,
        };
    }
    return cloned;
}

export function getIndexedValue<T>(values: readonly T[] | ILazyIndexedCollection<T>, index: number) {
    if (isLazyIndexedCollection<T>(values)) {
        return values.get(index);
    }
    return values[index];
}

function collectKnownMetricEntries(
    pageMetrics: readonly IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    totalPages: number,
): IKnownMetricEntry[] {
    if (isLazyIndexedCollection<IPdfPageMetric>(pageMetrics)) {
        const collection = pageMetrics as Partial<IPdfPageMetricCollection>;
        if (collection.knownIndices) {
            return collection.knownIndices
                .map(index => {
                    const metric = getIndexedValue(pageMetrics, index);
                    return isValidPageMetric(metric)
                        ? {
                            index,
                            metric,
                        }
                        : null;
                })
                .filter((entry): entry is IKnownMetricEntry => entry !== null);
        }
    }

    // Object.keys walks only materialized sparse entries. That matters for a
    // pageMetrics array whose length is one million but which has a handful of
    // measured pages. Dense ordinary documents stay on the simpler path.
    const entries: IKnownMetricEntry[] = [];
    for (const key of Object.keys(pageMetrics)) {
        if (!/^\d+$/.test(key)) {
            continue;
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= totalPages) {
            continue;
        }
        const metric = getIndexedValue(pageMetrics, index);
        if (isValidPageMetric(metric)) {
            entries.push({
                index,
                metric,
            });
        }
    }
    entries.sort((left, right) => left.index - right.index);
    return entries;
}

function resolveNearestMetricEstimate(
    entries: readonly IKnownMetricEntry[],
    targetIndex: number,
    fallbackMetric: IPdfPageMetric,
) {
    if (entries.length === 0) {
        return fallbackMetric;
    }

    let low = 0;
    let high = entries.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const entry = entries[middle];
        if (!entry) {
            high = middle;
            continue;
        }
        if (entry.index <= targetIndex) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    const after = entries[low] ?? null;
    const before = entries[low - 1] ?? null;
    if (before && after) {
        const beforeDistance = targetIndex - before.index;
        const afterDistance = after.index - targetIndex;
        return beforeDistance <= afterDistance ? before.metric : after.metric;
    }
    return before?.metric ?? after?.metric ?? fallbackMetric;
}

function sumNearestMetricEstimateRange(options: {
    entries: readonly IKnownMetricEntry[];
    totalPages: number;
    fallbackMetric: IPdfPageMetric;
    start: number;
    end: number;
    dimension: 'width' | 'height';
}) {
    const start = Math.max(0, Math.min(options.totalPages, Math.trunc(options.start)));
    const end = Math.max(start, Math.min(options.totalPages, Math.trunc(options.end)));
    if (start >= end) {
        return 0;
    }
    if (options.entries.length === 0) {
        return (end - start) * options.fallbackMetric[options.dimension];
    }

    let total = 0;
    let segmentStart = 0;
    for (let entryIndex = 0; entryIndex < options.entries.length; entryIndex += 1) {
        const entry = options.entries[entryIndex];
        if (!entry) {
            continue;
        }
        const nextEntry = options.entries[entryIndex + 1];
        const segmentEnd = nextEntry
            ? Math.floor((entry.index + nextEntry.index) / 2) + 1
            : options.totalPages;
        const overlapStart = Math.max(start, segmentStart);
        const overlapEnd = Math.min(end, segmentEnd);
        if (overlapStart < overlapEnd) {
            total += (overlapEnd - overlapStart) * entry.metric[options.dimension];
        }
        segmentStart = segmentEnd;
        if (segmentStart >= end) {
            break;
        }
    }
    return total;
}

function createSparsePageMetrics(options: {
    pageMetrics: readonly IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>;
    totalPages: number;
    fallbackMetric: IPdfPageMetric;
    entries: readonly IKnownMetricEntry[];
    viewRotation: TPdfViewRotation;
}): IPdfPageMetricCollection {
    const exactIndices = new Set(options.entries.map(entry => entry.index));
    const projectedEntries = options.entries.map(entry => ({
        index: entry.index,
        metric: projectPdfPageMetricForView(entry.metric, options.viewRotation),
    }));
    let maximumWidth = options.fallbackMetric.width;
    let maximumHeight = options.fallbackMetric.height;
    for (const entry of projectedEntries) {
        maximumWidth = Math.max(maximumWidth, entry.metric.width);
        maximumHeight = Math.max(maximumHeight, entry.metric.height);
    }

    const estimate = (index: number) => clonePageMetric(resolveNearestMetricEstimate(
        projectedEntries,
        index,
        options.fallbackMetric,
    ));
    const estimateRange = (
        start: number,
        end: number,
        dimension: 'width' | 'height',
    ) => sumNearestMetricEstimateRange({
        entries: projectedEntries,
        totalPages: options.totalPages,
        fallbackMetric: options.fallbackMetric,
        start,
        end,
        dimension,
    });
    const collection = createLazyIndexedCollection<IPdfPageMetric>({
        length: options.totalPages,
        getValue: index => {
            const exactMetric = getIndexedValue(options.pageMetrics, index);
            if (isValidPageMetric(exactMetric)) {
                return projectPdfPageMetricForView(exactMetric, options.viewRotation);
            }
            return estimate(index);
        },
    }) as IPdfPageMetricCollection;

    Object.defineProperties(collection, {
        isSparsePageMetricCollection: {
            configurable: false,
            enumerable: false,
            value: true,
        },
        exactPageCount: {
            configurable: false,
            enumerable: false,
            value: exactIndices.size,
        },
        estimate: {
            configurable: false,
            enumerable: false,
            value: estimate,
        },
        estimateRange: {
            configurable: false,
            enumerable: false,
            value: estimateRange,
        },
        maximumWidth: {
            configurable: false,
            enumerable: false,
            value: maximumWidth,
        },
        maximumHeight: {
            configurable: false,
            enumerable: false,
            value: maximumHeight,
        },
        knownIndices: {
            configurable: false,
            enumerable: false,
            value: Object.freeze(projectedEntries.map(entry => entry.index)),
        },
        hasExact: {
            configurable: false,
            enumerable: false,
            value: (index: number) => exactIndices.has(index),
        },
    });
    return collection;
}

export function isSparsePageMetricCollection(value: unknown): value is IPdfPageMetricCollection {
    return isLazyIndexedCollection<IPdfPageMetric>(value)
        && (value as Partial<IPdfPageMetricCollection>).isSparsePageMetricCollection === true;
}

export function getPageMetricMaximum(
    pageMetrics: readonly IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    dimension: 'width' | 'height',
) {
    if (isSparsePageMetricCollection(pageMetrics)) {
        return dimension === 'width' ? pageMetrics.maximumWidth : pageMetrics.maximumHeight;
    }

    let maximum = 0;
    if (pageMetrics.length > PDF_PAGE_METRICS_DENSE_LIMIT && !isLazyIndexedCollection(pageMetrics)) {
        // A caller may hand the layout a raw sparse array instead of the
        // normalized collection. Own numeric keys are the only measured
        // pages, so do not probe every virtual hole just to find a maximum.
        for (const key of Object.keys(pageMetrics)) {
            if (!/^\d+$/.test(key)) {
                continue;
            }
            const index = Number(key);
            const metric = pageMetrics[index];
            if (isValidPageMetric(metric)) {
                maximum = Math.max(maximum, metric[dimension]);
            }
        }
        return maximum;
    }
    for (let index = 0; index < pageMetrics.length; index += 1) {
        const metric = getIndexedValue(pageMetrics, index);
        if (isValidPageMetric(metric)) {
            maximum = Math.max(maximum, metric[dimension]);
        }
    }
    return maximum;
}

export function cloneSparsePageMetrics(
    pageMetrics: readonly IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
) {
    const clone: IPdfPageMetric[] = [];
    // Preserve the indexed snapshot contract without materializing holes. A
    // million-page source therefore keeps a million-length sparse array, not
    // a million metric objects.
    clone.length = pageMetrics.length;
    if (isLazyIndexedCollection<IPdfPageMetric>(pageMetrics)) {
        for (const index of (pageMetrics as Partial<IPdfPageMetricCollection>).knownIndices ?? []) {
            const metric = getIndexedValue(pageMetrics, index);
            if (isValidPageMetric(metric)) {
                clone[index] = clonePageMetric(metric);
            }
        }
        return clone;
    }

    for (const key of Object.keys(pageMetrics)) {
        if (!/^\d+$/.test(key)) {
            continue;
        }
        const index = Number(key);
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            clone[index] = clonePageMetric(metric);
        }
    }
    return clone;
}

export function forEachKnownPageMetric(
    pageMetrics: readonly IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    callback: (metric: IPdfPageMetric, index: number) => void,
) {
    if (isLazyIndexedCollection<IPdfPageMetric>(pageMetrics)) {
        for (const index of (pageMetrics as Partial<IPdfPageMetricCollection>).knownIndices ?? []) {
            const metric = getIndexedValue(pageMetrics, index);
            if (isValidPageMetric(metric)) {
                callback(metric, index);
            }
        }
        return;
    }

    for (const key of Object.keys(pageMetrics)) {
        if (!/^\d+$/.test(key)) {
            continue;
        }
        const index = Number(key);
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            callback(metric, index);
        }
    }
}

export function normalizePageMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
    viewRotation?: TPdfViewRotation;
}): IPdfPageMetric[] {
    const {
        pageMetrics,
        totalPages,
        fallbackWidth,
        fallbackHeight,
        viewRotation = 0,
    } = options;

    if (totalPages <= 0) {
        return [];
    }

    const safeFallbackWidth = isFinitePositive(fallbackWidth) ? fallbackWidth : 1;
    const safeFallbackHeight = isFinitePositive(fallbackHeight) ? fallbackHeight : 1;
    const fallbackMetric = {
        width: safeFallbackWidth,
        height: safeFallbackHeight,
    } satisfies IPdfPageMetric;
    const projectedFallbackMetric = projectPdfPageMetricForView(fallbackMetric, viewRotation);
    if (totalPages > PDF_PAGE_METRICS_DENSE_LIMIT) {
        const knownEntries = collectKnownMetricEntries(pageMetrics, totalPages);
        // `IPdfPageMetric[]` remains the compatibility type used by the
        // viewer. The returned value is a lazy indexed collection at this
        // scale, with numeric reads supplied by its proxy.
        return createSparsePageMetrics({
            pageMetrics,
            totalPages,
            fallbackMetric: projectedFallbackMetric,
            entries: knownEntries,
            viewRotation,
        });
    }

    const nearestBefore: Array<IKnownMetricEntry | null> = Array.from({length: totalPages}, () => null);
    let previousKnownMetric: IKnownMetricEntry | null = null;

    for (let index = 0; index < totalPages; index += 1) {
        nearestBefore[index] = previousKnownMetric;
        const metric = getIndexedValue(pageMetrics, index);
        if (isValidPageMetric(metric)) {
            previousKnownMetric = {
                index,
                metric: projectPdfPageMetricForView(metric, viewRotation),
            };
        }
    }

    const normalizedMetrics = new Array<IPdfPageMetric>(totalPages);
    let nextKnownMetric: IKnownMetricEntry | null = null;

    for (let index = totalPages - 1; index >= 0; index -= 1) {
        const metric = getIndexedValue(pageMetrics, index);
        if (isValidPageMetric(metric)) {
            normalizedMetrics[index] = projectPdfPageMetricForView(metric, viewRotation);
            nextKnownMetric = {
                index,
                metric: projectPdfPageMetricForView(metric, viewRotation),
            };
            continue;
        }

        const before = nearestBefore[index];
        const after = nextKnownMetric;
        const estimate = before && after
            ? (index - before.index <= after.index - index ? before.metric : after.metric)
            : before?.metric ?? after?.metric ?? projectedFallbackMetric;
        normalizedMetrics[index] = clonePageMetric(estimate);
    }

    return normalizedMetrics;
}
