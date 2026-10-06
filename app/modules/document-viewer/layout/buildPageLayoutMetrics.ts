import {
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageIndex } from '@contracts/pageNumbers';

import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type {
    IPdfPageLayoutBase,
    IPdfPageLayoutMetrics,
} from '@app/modules/document-viewer/layout/pdfPageLayoutMetrics';
import { getPageNumbersForViewMode } from '@app/modules/document-viewer/layout/getPageRowBoundsForViewMode';
import { createLazyIndexedCollection } from '@app/modules/document-viewer/virtualization/pageVirtualization';
import {
    getIndexedValue,
    getPageMetricMaximum,
    isSparsePageMetricCollection,
    PDF_PAGE_METRICS_CHUNK_SIZE,
    PDF_PAGE_METRICS_DENSE_LIMIT,
    type IPdfLazyIndexedCollection,
} from '@app/modules/document-viewer/layout/normalizePageMetrics';

const baseCache = new WeakMap<object, Map<string, IPdfPageLayoutBase>>();
const MAX_CACHED_BASES_PER_METRICS = 4;

function normalizeSpacing(value: number, fallback = 0) {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function resolveSafeLayoutSpacing(options: {
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
}) {
    const paddingTop = normalizeSpacing(options.paddingTop);
    return {
        gap: normalizeSpacing(options.gap),
        paddingTop,
        paddingBottom: typeof options.paddingBottom === 'number'
            ? normalizeSpacing(options.paddingBottom, paddingTop)
            : paddingTop,
    };
}

function buildPrefixSums(values: readonly number[]) {
    const prefixSums = Array.from({length: values.length}, () => 0);
    for (let index = 0; index < values.length; index += 1) {
        prefixSums[index] = (values[index] ?? 0) + (prefixSums[index - 1] ?? 0);
    }
    return prefixSums;
}

function getLayoutRowCount(totalPages: number, viewMode: TPdfViewMode) {
    if (viewMode === 'single' || totalPages <= 1) {
        return totalPages;
    }
    return viewMode === 'facing'
        ? Math.ceil(totalPages / 2)
        : 1 + Math.ceil((totalPages - 1) / 2);
}

function getLayoutRowStart(rowIndex: number, totalPages: number, viewMode: TPdfViewMode) {
    if (viewMode === 'single' || totalPages <= 1) {
        return rowIndex + 1;
    }
    return viewMode === 'facing'
        ? rowIndex * 2 + 1
        : rowIndex === 0 ? 1 : rowIndex * 2;
}

function getLayoutRowEnd(rowIndex: number, totalPages: number, viewMode: TPdfViewMode) {
    const start = getLayoutRowStart(rowIndex, totalPages, viewMode);
    if (viewMode === 'single' || totalPages <= 1) {
        return start;
    }
    return viewMode === 'facing'
        ? Math.min(totalPages, start + 1)
        : rowIndex === 0 ? 1 : Math.min(totalPages, start + 1);
}

function getLayoutRowIndex(pageIndex: TPageIndex, totalPages: number, viewMode: TPdfViewMode) {
    if (viewMode === 'single' || totalPages <= 1) {
        return pageIndex;
    }
    return viewMode === 'facing'
        ? Math.floor(pageIndex / 2)
        : pageIndex === 0 ? 0 : 1 + Math.floor((pageIndex - 1) / 2);
}

function getMetricDimension(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    pageIndex: TPageIndex,
    dimension: 'width' | 'height',
) {
    const metric = getIndexedValue(pageMetrics, pageIndex);
    const value = metric?.[dimension];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

function getMetricEstimateDimension(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    pageIndex: TPageIndex,
    dimension: 'width' | 'height',
) {
    const metric = isSparsePageMetricCollection(pageMetrics)
        ? pageMetrics.estimate(pageIndex)
        : getIndexedValue(pageMetrics, pageIndex);
    const value = metric?.[dimension];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

function getRowHeight(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    rowIndex: number,
    totalPages: number,
    viewMode: TPdfViewMode,
    getDimension: (
        pageIndex: TPageIndex,
    ) => number,
) {
    const start = getLayoutRowStart(rowIndex, totalPages, viewMode) - 1;
    const end = getLayoutRowEnd(rowIndex, totalPages, viewMode) - 1;
    let height = 0;
    for (let index = start; index <= end; index += 1) {
        height = Math.max(
            height,
            getDimension(requirePageIndex(index)),
        );
    }
    return height;
}

function getEstimatedRowHeight(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    rowIndex: number,
    totalPages: number,
    viewMode: TPdfViewMode,
) {
    return getRowHeight(
        pageMetrics,
        rowIndex,
        totalPages,
        viewMode,
        pageIndex => getMetricEstimateDimension(pageMetrics, pageIndex, 'height'),
    );
}

function getEstimatedRowChangeIndexes(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    totalPages: number,
    viewMode: TPdfViewMode,
) {
    if (!isSparsePageMetricCollection(pageMetrics)) {
        return [];
    }

    const rowCount = getLayoutRowCount(totalPages, viewMode);
    const knownIndices = pageMetrics.knownIndices;
    const changes: number[] = [];
    for (let index = 0; index < knownIndices.length - 1; index += 1) {
        const currentIndex = knownIndices[index];
        const nextIndex = knownIndices[index + 1];
        if (currentIndex === undefined || nextIndex === undefined) {
            continue;
        }
        const metricChangeIndex = Math.floor((currentIndex + nextIndex) / 2) + 1;
        if (metricChangeIndex >= totalPages) {
            continue;
        }
        const rowIndex = getLayoutRowIndex(
            requirePageIndex(metricChangeIndex),
            totalPages,
            viewMode,
        );
        if (rowIndex > 0 && rowIndex < rowCount && changes.at(-1) !== rowIndex) {
            changes.push(rowIndex);
        }
    }
    return changes;
}

function findFirstAtOrAfter(values: readonly number[], target: number) {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const middleValue = values[middle];
        if (middleValue === undefined) {
            return low;
        }
        if (middleValue < target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

interface ISparsePrefixDeltaNode {
    key: number;
    value: number;
    height: number;
    subtreeTotal: number;
    left: ISparsePrefixDeltaNode | null;
    right: ISparsePrefixDeltaNode | null;
}

function getSparsePrefixDeltaHeight(node: ISparsePrefixDeltaNode | null) {
    return node?.height ?? 0;
}

function getSparsePrefixDeltaTotal(node: ISparsePrefixDeltaNode | null) {
    return node?.subtreeTotal ?? 0;
}

function refreshSparsePrefixDeltaNode(node: ISparsePrefixDeltaNode) {
    node.height = 1 + Math.max(
        getSparsePrefixDeltaHeight(node.left),
        getSparsePrefixDeltaHeight(node.right),
    );
    node.subtreeTotal = node.value
        + getSparsePrefixDeltaTotal(node.left)
        + getSparsePrefixDeltaTotal(node.right);
    return node;
}

function rotateSparsePrefixDeltaLeft(node: ISparsePrefixDeltaNode) {
    const pivot = node.right;
    if (!pivot) {
        return node;
    }
    node.right = pivot.left;
    pivot.left = refreshSparsePrefixDeltaNode(node);
    return refreshSparsePrefixDeltaNode(pivot);
}

function rotateSparsePrefixDeltaRight(node: ISparsePrefixDeltaNode) {
    const pivot = node.left;
    if (!pivot) {
        return node;
    }
    node.left = pivot.right;
    pivot.right = refreshSparsePrefixDeltaNode(node);
    return refreshSparsePrefixDeltaNode(pivot);
}

function rebalanceSparsePrefixDeltaNode(node: ISparsePrefixDeltaNode) {
    const refreshed = refreshSparsePrefixDeltaNode(node);
    const balance = getSparsePrefixDeltaHeight(refreshed.left)
        - getSparsePrefixDeltaHeight(refreshed.right);
    if (balance > 1) {
        const left = refreshed.left;
        if (!left) {
            return refreshed;
        }
        if (
            getSparsePrefixDeltaHeight(left.left)
            < getSparsePrefixDeltaHeight(left.right)
        ) {
            refreshed.left = rotateSparsePrefixDeltaLeft(left);
        }
        return rotateSparsePrefixDeltaRight(refreshed);
    }
    if (balance < -1) {
        const right = refreshed.right;
        if (!right) {
            return refreshed;
        }
        if (
            getSparsePrefixDeltaHeight(right.right)
            < getSparsePrefixDeltaHeight(right.left)
        ) {
            refreshed.right = rotateSparsePrefixDeltaRight(right);
        }
        return rotateSparsePrefixDeltaLeft(refreshed);
    }
    return refreshed;
}

function setSparsePrefixDelta(
    node: ISparsePrefixDeltaNode | null,
    key: number,
    value: number,
): ISparsePrefixDeltaNode {
    if (!node) {
        return {
            key,
            value,
            height: 1,
            subtreeTotal: value,
            left: null,
            right: null,
        };
    }

    if (key < node.key) {
        node.left = setSparsePrefixDelta(node.left, key, value);
    } else if (key > node.key) {
        node.right = setSparsePrefixDelta(node.right, key, value);
    } else {
        node.value = value;
        return refreshSparsePrefixDeltaNode(node);
    }

    return rebalanceSparsePrefixDeltaNode(node);
}

function getSparsePrefixDeltaMinimum(node: ISparsePrefixDeltaNode) {
    let current = node;
    while (current.left) {
        current = current.left;
    }
    return current;
}

function removeSparsePrefixDelta(
    node: ISparsePrefixDeltaNode | null,
    key: number,
): ISparsePrefixDeltaNode | null {
    if (!node) {
        return null;
    }

    if (key < node.key) {
        node.left = removeSparsePrefixDelta(node.left, key);
    } else if (key > node.key) {
        node.right = removeSparsePrefixDelta(node.right, key);
    } else {
        if (!node.left) {
            return node.right;
        }
        if (!node.right) {
            return node.left;
        }
        const successor = getSparsePrefixDeltaMinimum(node.right);
        node.key = successor.key;
        node.value = successor.value;
        node.right = removeSparsePrefixDelta(node.right, successor.key);
    }

    return rebalanceSparsePrefixDeltaNode(node);
}

function getSparsePrefixDeltaBefore(node: ISparsePrefixDeltaNode | null, key: number) {
    let total = 0;
    let current = node;
    while (current) {
        if (current.key >= key) {
            current = current.left;
            continue;
        }
        total += current.value + getSparsePrefixDeltaTotal(current.left);
        current = current.right;
    }
    return total;
}

function createChunkedPrefixSums(
    length: number,
    valueAt: (index: number) => number,
    estimateValueAt: (index: number) => number = valueAt,
    estimateBlockTotal?: (start: number, end: number) => number,
    estimatePrefixAt?: (end: number) => number,
) {
    const blockSize = PDF_PAGE_METRICS_CHUNK_SIZE;
    const blockValues = new Map<number, number[]>();
    const maxCachedBlocks = 32;
    // Exact blocks are sparse corrections to the estimated default runs. The
    // AVL tree stores subtree sums, so a prefix query needs O(log n) exact
    // corrections without retaining one prefix value for every block.
    let exactBlockDeltas: ISparsePrefixDeltaNode | null = null;

    function getBlockValues(blockIndex: number) {
        const cached = blockValues.get(blockIndex);
        if (cached) {
            blockValues.delete(blockIndex);
            blockValues.set(blockIndex, cached);
            return cached;
        }

        const start = blockIndex * blockSize;
        const end = Math.min(length, start + blockSize);
        const values = new Array<number>(Math.max(0, end - start));
        let total = 0;
        for (let index = start; index < end; index += 1) {
            const value = valueAt(index);
            values[index - start] = value;
            total += value;
        }
        const estimatedTotal = getEstimatedBlockTotal(blockIndex);
        const delta = total - estimatedTotal;
        exactBlockDeltas = delta === 0
            ? removeSparsePrefixDelta(exactBlockDeltas, blockIndex)
            : setSparsePrefixDelta(exactBlockDeltas, blockIndex, delta);
        blockValues.set(blockIndex, values);
        while (blockValues.size > maxCachedBlocks) {
            const oldest = blockValues.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            blockValues.delete(oldest);
        }
        return values;
    }

    function getEstimatedBlockTotal(blockIndex: number) {
        const start = blockIndex * blockSize;
        const end = Math.min(length, start + blockSize);
        if (estimateBlockTotal) {
            return estimateBlockTotal(start, end);
        }
        const estimatedValue = estimateValueAt(start);
        return estimatedValue * Math.max(0, end - start);
    }

    function getBlockPrefix(blockIndex: number) {
        const blockStart = blockIndex * blockSize;
        let estimatedPrefix = 0;
        if (estimatePrefixAt) {
            estimatedPrefix = estimatePrefixAt(blockStart);
        } else {
            for (let currentBlock = 0; currentBlock < blockIndex; currentBlock += 1) {
                estimatedPrefix += getEstimatedBlockTotal(currentBlock);
            }
        }
        return estimatedPrefix + getSparsePrefixDeltaBefore(exactBlockDeltas, blockIndex);
    }

    return createLazyIndexedCollection<number>({
        length,
        getValue: index => {
            const blockIndex = Math.floor(index / blockSize);
            const values = getBlockValues(blockIndex);
            let prefix = getBlockPrefix(blockIndex);
            for (let offset = 0; offset <= index % blockSize; offset += 1) {
                prefix += values[offset] ?? 0;
            }
            return prefix;
        },
        chunkSize: blockSize,
        maxCachedChunks: maxCachedBlocks,
        cacheValues: false,
    });
}

function buildDensePageLayoutBase(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    viewMode: TPdfViewMode;
}) {
    const pageWidths = new Array<number>(options.totalPages);
    const pageHeights = new Array<number>(options.totalPages);
    for (let index = 0; index < options.totalPages; index += 1) {
        const pageIndex = requirePageIndex(index);
        pageWidths[index] = getMetricDimension(options.pageMetrics, pageIndex, 'width');
        pageHeights[index] = getMetricDimension(options.pageMetrics, pageIndex, 'height');
    }

    const pageRowIndices = Array.from({length: options.totalPages}, () => 0);
    const rowStartPages: number[] = [];
    const rowEndPages: number[] = [];
    const rowHeights: number[] = [];
    let rowIndex = 0;

    for (let pageNumber = 1; pageNumber <= options.totalPages;) {
        const rowPages = getPageNumbersForViewMode({
            pageNumber: requirePageNumber(pageNumber, options.totalPages),
            viewMode: options.viewMode,
            totalPages: options.totalPages,
        });
        const rowEndPage = rowPages[rowPages.length - 1] ?? pageNumber;
        rowStartPages.push(pageNumber);
        rowEndPages.push(rowEndPage);
        rowHeights.push(Math.max(...rowPages.map(rowPage => pageHeights[rowPage - 1] ?? 0)));
        for (const rowPage of rowPages) {
            pageRowIndices[rowPage - 1] = rowIndex;
        }
        pageNumber = rowEndPage + 1;
        rowIndex += 1;
    }

    return Object.freeze({
        totalPages: options.totalPages,
        isSparse: false,
        maxPageWidth: pageWidths.reduce(
            (maxWidth, pageWidth) => pageWidth > maxWidth ? pageWidth : maxWidth,
            0,
        ),
        maxPageHeight: pageHeights.reduce(
            (maxHeight, pageHeight) => pageHeight > maxHeight ? pageHeight : maxHeight,
            0,
        ),
        pageWidths: Object.freeze(pageWidths),
        pageHeights: Object.freeze(pageHeights),
        pageHeightPrefixSums: Object.freeze(buildPrefixSums(pageHeights)),
        pageRowIndices: Object.freeze(pageRowIndices),
        rowStartPages: Object.freeze(rowStartPages),
        rowEndPages: Object.freeze(rowEndPages),
        rowHeights: Object.freeze(rowHeights),
        rowHeightPrefixSums: Object.freeze(buildPrefixSums(rowHeights)),
    }) satisfies IPdfPageLayoutBase;
}

function buildSparsePageLayoutBase(options: {
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>;
    totalPages: number;
    viewMode: TPdfViewMode;
}) {
    const rowCount = getLayoutRowCount(options.totalPages, options.viewMode);
    const pageWidths = createLazyIndexedCollection<number>({
        length: options.totalPages,
        getValue: index => getMetricDimension(
            options.pageMetrics,
            requirePageIndex(index),
            'width',
        ),
    });
    const pageHeights = createLazyIndexedCollection<number>({
        length: options.totalPages,
        getValue: index => getMetricDimension(
            options.pageMetrics,
            requirePageIndex(index),
            'height',
        ),
    });
    const pageRowIndices = createLazyIndexedCollection<number>({
        length: options.totalPages,
        getValue: index => getLayoutRowIndex(
            requirePageIndex(index),
            options.totalPages,
            options.viewMode,
        ),
    });
    const rowStartPages = createLazyIndexedCollection<number>({
        length: rowCount,
        getValue: rowIndex => getLayoutRowStart(rowIndex, options.totalPages, options.viewMode),
    });
    const rowEndPages = createLazyIndexedCollection<number>({
        length: rowCount,
        getValue: rowIndex => getLayoutRowEnd(rowIndex, options.totalPages, options.viewMode),
    });
    const rowHeights = createLazyIndexedCollection<number>({
        length: rowCount,
        getValue: rowIndex => {
            return getRowHeight(
                options.pageMetrics,
                rowIndex,
                options.totalPages,
                options.viewMode,
                index => getMetricDimension(
                    options.pageMetrics,
                    requirePageIndex(index),
                    'height',
                ),
            );
        },
    });
    const estimatePageHeightRange = (start: number, end: number) => (
        isSparsePageMetricCollection(options.pageMetrics)
            ? options.pageMetrics.estimateRange(start, end, 'height')
            : getMetricEstimateDimension(
                options.pageMetrics,
                requirePageIndex(start),
                'height',
            ) * (end - start)
    );
    const pageHeightPrefixSums = createChunkedPrefixSums(
        options.totalPages,
        index => getMetricDimension(
            options.pageMetrics,
            requirePageIndex(index),
            'height',
        ),
        index => getMetricEstimateDimension(
            options.pageMetrics,
            requirePageIndex(index),
            'height',
        ),
        estimatePageHeightRange,
        end => estimatePageHeightRange(0, end),
    );
    const estimatedRowChanges = getEstimatedRowChangeIndexes(
        options.pageMetrics,
        options.totalPages,
        options.viewMode,
    );
    const estimateRowHeightRange = (start: number, end: number) => {
        let total = 0;
        let cursor = start;
        let changeIndex = findFirstAtOrAfter(estimatedRowChanges, start + 1);
        while (cursor < end) {
            const nextChange = estimatedRowChanges[changeIndex] ?? end;
            const segmentEnd = Math.min(end, nextChange);
            total += (segmentEnd - cursor) * getEstimatedRowHeight(
                options.pageMetrics,
                cursor,
                options.totalPages,
                options.viewMode,
            );
            cursor = segmentEnd;
            if (nextChange <= cursor) {
                changeIndex += 1;
            }
        }
        return total;
    };
    const rowHeightPrefixSums = createChunkedPrefixSums(
        rowCount,
        rowIndex => getRowHeight(
            options.pageMetrics,
            rowIndex,
            options.totalPages,
            options.viewMode,
            index => getMetricDimension(
                options.pageMetrics,
                requirePageIndex(index),
                'height',
            ),
        ),
        rowIndex => getEstimatedRowHeight(
            options.pageMetrics,
            rowIndex,
            options.totalPages,
            options.viewMode,
        ),
        estimateRowHeightRange,
        end => estimateRowHeightRange(0, end),
    );

    return Object.freeze({
        totalPages: options.totalPages,
        isSparse: true,
        maxPageWidth: getPageMetricMaximum(options.pageMetrics, 'width'),
        maxPageHeight: getPageMetricMaximum(options.pageMetrics, 'height'),
        pageWidths,
        pageHeights,
        pageHeightPrefixSums,
        pageRowIndices,
        rowStartPages,
        rowEndPages,
        rowHeights,
        rowHeightPrefixSums,
    }) as IPdfPageLayoutBase;
}

function buildPageLayoutBase(options: {
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>;
    pageMetricsVersion: number;
    totalPages: number;
    viewMode: TPdfViewMode;
}) {
    const cacheKey = [
        options.pageMetricsVersion,
        options.totalPages,
        options.viewMode,
    ].join(':');
    const metricsObject = options.pageMetrics as object;
    const cached = baseCache.get(metricsObject)?.get(cacheKey);
    if (cached) {
        return cached;
    }

    const base = options.totalPages > PDF_PAGE_METRICS_DENSE_LIMIT
        || isSparsePageMetricCollection(options.pageMetrics)
        ? buildSparsePageLayoutBase(options)
        : buildDensePageLayoutBase({
            pageMetrics: options.pageMetrics,
            totalPages: options.totalPages,
            viewMode: options.viewMode,
        });

    const metricsCache = baseCache.get(metricsObject) ?? new Map<string, IPdfPageLayoutBase>();
    metricsCache.set(cacheKey, base);
    while (metricsCache.size > MAX_CACHED_BASES_PER_METRICS) {
        const oldest = metricsCache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        metricsCache.delete(oldest);
    }
    baseCache.set(metricsObject, metricsCache);
    return base;
}

/**
 * `pageMetrics` may be a dense array for ordinary documents or a lazy indexed
 * collection returned by `normalizePageMetrics` for large documents. The
 * layout keeps the same indexed interface in both cases, but sparse layouts
 * build row and prefix chunks only when a caller asks for that geometry.
 */
export function buildPageLayoutMetrics(options: {
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>;
    pageMetricsVersion?: number;
    totalPages: number;
    viewMode: TPdfViewMode;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom?: number;
}): IPdfPageLayoutMetrics | null {
    if (options.totalPages <= 0 || !Number.isFinite(options.scale) || options.scale <= 0) {
        return null;
    }

    const base = buildPageLayoutBase({
        pageMetrics: options.pageMetrics,
        pageMetricsVersion: options.pageMetricsVersion ?? 0,
        totalPages: options.totalPages,
        viewMode: options.viewMode,
    });

    const {
        gap,
        paddingTop,
        paddingBottom,
    } = resolveSafeLayoutSpacing({
        gap: options.gap,
        paddingTop: options.paddingTop,
        ...(options.paddingBottom !== undefined ? {paddingBottom: options.paddingBottom} : {}),
    });
    return {
        base,
        scale: options.scale,
        gap,
        paddingTop,
        paddingBottom,
    };
}
