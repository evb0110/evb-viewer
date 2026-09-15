import type {
    IPdfNativePageSize,
    TPdfNativePageSizes,
} from '@contracts/electronApiDocuments';
import type { IDocumentZoomPageLayout } from '@app/modules/document-viewer/public';
import { resolveDocumentPageDisplayScale } from '@app/modules/document-viewer/public';

/** Keep DOM and lifecycle geometry work bounded when the PDF has sparse metadata. */
export const NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT = 256;
const NATIVE_PDF_ZOOM_ANCHOR_PAGE_RADIUS = 4;

export interface INativePdfPageGeometry {
    readonly pageCount: number;
    readonly defaultPageSize: IPdfNativePageSize;
    getPageSize(pageNumber: number): IPdfNativePageSize;
    getKnownPageNumbers(): readonly number[];
}

export interface INativePdfPageLayoutOptions {
    readonly availableHeight: number;
    readonly availableWidth: number;
    readonly manualZoom: number;
    readonly pageGapPx: number;
    readonly zoomMode: 'custom' | 'fit-width' | 'fit-height';
}

export interface INativePdfPageLayout {
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
}

export interface INativePdfSparsePageLayout {
    readonly pageCount: number;
    readonly totalHeight: number;
    readonly maxPageWidth: number;
    getPageSize(pageNumber: number): IPdfNativePageSize;
    getPageHeight(pageNumber: number): number;
    getPageTop(pageNumber: number): number;
    getPageLayout(pageNumber: number): INativePdfPageLayout;
    resolveMostVisiblePage(scrollTop: number, viewportHeight: number): number;
    resolvePageNumbers(options: {
        activePage: number;
        overscanViewports: number;
        renderMarginPages: number;
        scrollTop: number;
        viewportHeight: number;
    }): number[];
    createZoomLayoutAdapter(options: {
        getActivePage: () => number;
        getPageLeft?: (pageWidth: number) => number;
        getScrollTop: () => number;
        getViewportHeight: () => number;
        overscanViewports: number;
        renderMarginPages: number;
    }): readonly IDocumentZoomPageLayout[];
}

interface IResolvedPageDisplayLayout {
    readonly height: number;
    readonly scale: number;
    readonly width: number;
}

interface IPageHeightDelta {
    readonly delta: number;
    readonly pageNumber: number;
}

function clonePageSize(pageSize: IPdfNativePageSize): IPdfNativePageSize {
    return {
        width: pageSize.width,
        height: pageSize.height,
    };
}

function isValidPageSize(pageSize: unknown): pageSize is IPdfNativePageSize {
    return typeof pageSize === 'object'
        && pageSize !== null
        && Number.isFinite((pageSize as IPdfNativePageSize).width)
        && (pageSize as IPdfNativePageSize).width > 0
        && Number.isFinite((pageSize as IPdfNativePageSize).height)
        && (pageSize as IPdfNativePageSize).height > 0;
}

function normalizePageNumber(pageNumber: number, pageCount: number) {
    if (!Number.isFinite(pageNumber)) {
        return 1;
    }
    return Math.min(pageCount, Math.max(1, Math.trunc(pageNumber)));
}

function normalizeNonNegativeFinite(value: number) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizePageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Native PDF page geometry requires a positive safe page count');
    }
    return pageCount;
}

function isPageSizeArray(
    pageSizes: TPdfNativePageSizes,
): pageSizes is readonly IPdfNativePageSize[] {
    return Array.isArray(pageSizes);
}

/**
 * Normalize either the legacy small-document array or compact page metadata
 * into a scalar page count plus a bounded known-page map.
 */
export function createNativePdfPageGeometry(pageSizes: TPdfNativePageSizes): INativePdfPageGeometry {
    if (isPageSizeArray(pageSizes)) {
        const pageCount = normalizePageCount(pageSizes.length);
        const firstPageSize = pageSizes[0];
        if (!isValidPageSize(firstPageSize)) {
            throw new Error('Native PDF page geometry is missing the first page size');
        }
        const defaultPageSize = clonePageSize(firstPageSize);
        const knownPageSizes = new Map<number, IPdfNativePageSize>();
        for (const [
            index,
            pageSize,
        ] of pageSizes.entries()) {
            if (isValidPageSize(pageSize)) {
                knownPageSizes.set(index + 1, clonePageSize(pageSize));
            }
        }
        const knownPageNumbers = [...knownPageSizes.keys()].sort((a, b) => a - b);
        return {
            pageCount,
            defaultPageSize,
            getPageSize(pageNumber) {
                const normalizedPageNumber = normalizePageNumber(pageNumber, pageCount);
                return knownPageSizes.get(normalizedPageNumber) ?? defaultPageSize;
            },
            getKnownPageNumbers() {
                return knownPageNumbers;
            },
        };
    }

    if (
        typeof pageSizes !== 'object'
        || pageSizes === null
        || !isValidPageSize(pageSizes.defaultPageSize)
    ) {
        throw new Error('Native PDF page geometry metadata is invalid');
    }
    const pageCount = normalizePageCount(pageSizes.pageCount);
    const defaultPageSize = clonePageSize(pageSizes.defaultPageSize);
    const knownPageSizes = new Map<number, IPdfNativePageSize>();
    for (const override of pageSizes.overrides) {
        if (
            Number.isSafeInteger(override.pageNumber)
            && override.pageNumber >= 1
            && override.pageNumber <= pageCount
            && isValidPageSize(override)
        ) {
            knownPageSizes.set(override.pageNumber, clonePageSize(override));
        }
    }
    const knownPageNumbers = [...knownPageSizes.keys()].sort((a, b) => a - b);
    return {
        pageCount,
        defaultPageSize,
        getPageSize(pageNumber) {
            const normalizedPageNumber = normalizePageNumber(pageNumber, pageCount);
            return knownPageSizes.get(normalizedPageNumber) ?? defaultPageSize;
        },
        getKnownPageNumbers() {
            return knownPageNumbers;
        },
    };
}

function resolvePageDisplayLayout(
    pageSize: IPdfNativePageSize,
    options: INativePdfPageLayoutOptions,
): IResolvedPageDisplayLayout {
    const scale = resolveDocumentPageDisplayScale({
        availableHeight: normalizeNonNegativeFinite(options.availableHeight),
        availableWidth: normalizeNonNegativeFinite(options.availableWidth),
        manualZoom: options.manualZoom,
        pageSize,
        zoomMode: options.zoomMode,
    });
    return {
        height: Math.max(1, Math.round(pageSize.height * scale)),
        scale,
        width: Math.max(1, Math.round(pageSize.width * scale)),
    };
}

function createBoundedPageRange(start: number, end: number, pageCount: number) {
    let normalizedStart = Math.min(pageCount, Math.max(1, Math.trunc(start)));
    let normalizedEnd = Math.min(pageCount, Math.max(1, Math.trunc(end)));
    if (normalizedEnd < normalizedStart) {
        [
            normalizedStart,
            normalizedEnd,
        ] = [
            normalizedEnd,
            normalizedStart,
        ];
    }
    if (normalizedEnd - normalizedStart + 1 <= NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT) {
        return Array.from(
            {length: normalizedEnd - normalizedStart + 1},
            (_, index) => normalizedStart + index,
        );
    }
    const center = Math.min(
        normalizedEnd,
        Math.max(
            normalizedStart,
            normalizedStart + Math.round((normalizedEnd - normalizedStart) / 2),
        ),
    );
    normalizedStart = Math.max(
        1,
        Math.min(
            pageCount - NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT + 1,
            center - Math.floor(NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT / 2),
        ),
    );
    normalizedEnd = Math.min(pageCount, normalizedStart + NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT - 1);
    normalizedStart = Math.max(1, normalizedEnd - NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT + 1);
    return Array.from(
        {length: normalizedEnd - normalizedStart + 1},
        (_, index) => normalizedStart + index,
    );
}

function findFirstPageWithBottomAfter(
    pageCount: number,
    pageTop: (pageNumber: number) => number,
    pageHeight: (pageNumber: number) => number,
    boundary: number,
) {
    let low = 1;
    let high = pageCount + 1;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (pageTop(middle) + pageHeight(middle) > boundary) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    return low;
}

function findLastPageWithTopBefore(
    pageCount: number,
    pageTop: (pageNumber: number) => number,
    boundary: number,
) {
    let low = 1;
    let high = pageCount + 1;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (pageTop(middle) < boundary) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low - 1;
}

export function createNativePdfSparsePageLayout(
    pageGeometry: INativePdfPageGeometry,
    options: INativePdfPageLayoutOptions,
): INativePdfSparsePageLayout {
    const pageCount = pageGeometry.pageCount;
    const pageGapPx = normalizeNonNegativeFinite(options.pageGapPx);
    const defaultPageDisplayLayout = resolvePageDisplayLayout(pageGeometry.defaultPageSize, options);
    const pageDisplayLayouts = new Map<number, IResolvedPageDisplayLayout>();
    const pageHeightDeltas: IPageHeightDelta[] = [];
    for (const pageNumber of pageGeometry.getKnownPageNumbers()) {
        const pageDisplayLayout = resolvePageDisplayLayout(pageGeometry.getPageSize(pageNumber), options);
        pageDisplayLayouts.set(pageNumber, pageDisplayLayout);
        const delta = pageDisplayLayout.height - defaultPageDisplayLayout.height;
        if (delta !== 0) {
            pageHeightDeltas.push({
                pageNumber,
                delta,
            });
        }
    }
    const prefixDeltas = new Float64Array(pageHeightDeltas.length + 1);
    for (const [
        index,
        entry,
    ] of pageHeightDeltas.entries()) {
        prefixDeltas[index + 1] = (prefixDeltas[index] ?? 0) + entry.delta;
    }

    function getNormalizedPageNumber(pageNumber: number) {
        return normalizePageNumber(pageNumber, pageCount);
    }

    function getPageDisplayLayout(pageNumber: number) {
        const normalizedPageNumber = getNormalizedPageNumber(pageNumber);
        return pageDisplayLayouts.get(normalizedPageNumber) ?? defaultPageDisplayLayout;
    }

    function getHeightDeltaBefore(pageNumber: number) {
        let low = 0;
        let high = pageHeightDeltas.length;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            const entry = pageHeightDeltas[middle];
            if (!entry) {
                break;
            }
            if (entry.pageNumber < pageNumber) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return prefixDeltas[low] ?? 0;
    }

    function getPageTop(pageNumber: number) {
        const normalizedPageNumber = getNormalizedPageNumber(pageNumber);
        return pageGapPx
            + (normalizedPageNumber - 1) * (defaultPageDisplayLayout.height + pageGapPx)
            + getHeightDeltaBefore(normalizedPageNumber);
    }

    function getPageHeight(pageNumber: number) {
        return getPageDisplayLayout(pageNumber).height;
    }

    function getPageLayout(pageNumber: number): INativePdfPageLayout {
        const displayLayout = getPageDisplayLayout(pageNumber);
        return {
            ...displayLayout,
            top: getPageTop(pageNumber),
        };
    }

    const maxPageWidth = Math.max(
        defaultPageDisplayLayout.width,
        ...[...pageDisplayLayouts.values()].map(layout => layout.width),
    );
    const totalHeight = getPageTop(pageCount) + getPageHeight(pageCount) + pageGapPx;

    function resolvePageAtOffset(offset: number) {
        const normalizedOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
        const firstPage = findFirstPageWithBottomAfter(
            pageCount,
            getPageTop,
            getPageHeight,
            normalizedOffset,
        );
        const nextPage = Math.min(pageCount, Math.max(1, firstPage));
        const previousPage = Math.max(1, nextPage - 1);
        const distance = (pageNumber: number) => {
            const top = getPageTop(pageNumber);
            const bottom = top + getPageHeight(pageNumber);
            return normalizedOffset < top
                ? top - normalizedOffset
                : normalizedOffset > bottom ? normalizedOffset - bottom : 0;
        };
        return distance(nextPage) < distance(previousPage) ? nextPage : previousPage;
    }

    function resolveMostVisiblePage(scrollTop: number, viewportHeight: number) {
        const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
        const height = normalizeNonNegativeFinite(viewportHeight);
        const bottom = top + height;
        const centerPage = resolvePageAtOffset(top + height / 2);
        let mostVisiblePage = centerPage;
        let maxVisibleHeight = -1;
        for (const pageNumber of createBoundedPageRange(centerPage - 1, centerPage + 1, pageCount)) {
            const pageTop = getPageTop(pageNumber);
            const pageBottom = pageTop + getPageHeight(pageNumber);
            const visibleHeight = Math.max(0, Math.min(pageBottom, bottom) - Math.max(pageTop, top));
            if (visibleHeight > maxVisibleHeight) {
                mostVisiblePage = pageNumber;
                maxVisibleHeight = visibleHeight;
            }
        }
        return mostVisiblePage;
    }

    function resolvePageNumbers(windowOptions: {
        activePage: number;
        overscanViewports: number;
        renderMarginPages: number;
        scrollTop: number;
        viewportHeight: number;
    }) {
        const scroll = Number.isFinite(windowOptions.scrollTop) ? Math.max(0, windowOptions.scrollTop) : 0;
        const viewport = normalizeNonNegativeFinite(windowOptions.viewportHeight);
        const overscanViewports = normalizeNonNegativeFinite(windowOptions.overscanViewports);
        const overscanPx = viewport * overscanViewports;
        const firstPage = findFirstPageWithBottomAfter(
            pageCount,
            getPageTop,
            getPageHeight,
            Math.max(0, scroll - overscanPx),
        );
        const lastPage = findLastPageWithTopBefore(
            pageCount,
            getPageTop,
            scroll + viewport + overscanPx,
        );
        const activePage = getNormalizedPageNumber(windowOptions.activePage);
        const start = Math.max(1, Math.min(pageCount, firstPage)) - Math.max(0, Math.trunc(windowOptions.renderMarginPages));
        const end = Math.min(pageCount, Math.max(1, lastPage)) + Math.max(0, Math.trunc(windowOptions.renderMarginPages));
        if (firstPage > lastPage || viewport <= 0) {
            return createBoundedPageRange(activePage, activePage, pageCount);
        }
        const pageNumbers = createBoundedPageRange(start, end, pageCount);
        if (!pageNumbers.includes(activePage) && pageNumbers.length < NATIVE_PDF_SPARSE_PAGE_WINDOW_LIMIT) {
            pageNumbers.push(activePage);
            pageNumbers.sort((a, b) => a - b);
        }
        return pageNumbers;
    }

    function createZoomLayoutAdapter(adapterOptions: {
        getActivePage: () => number;
        getPageLeft?: (pageWidth: number) => number;
        getScrollTop: () => number;
        getViewportHeight: () => number;
        overscanViewports: number;
        renderMarginPages: number;
    }): readonly IDocumentZoomPageLayout[] {
        const target = Object.create(null) as IDocumentZoomPageLayout[];
        const getPageNumbers = () => {
            const pageNumbers = new Set(resolvePageNumbers({
                activePage: adapterOptions.getActivePage(),
                overscanViewports: adapterOptions.overscanViewports,
                renderMarginPages: adapterOptions.renderMarginPages,
                scrollTop: adapterOptions.getScrollTop(),
                viewportHeight: adapterOptions.getViewportHeight(),
            }));
            pageNumbers.add(1);
            pageNumbers.add(pageCount);
            const activePage = getNormalizedPageNumber(adapterOptions.getActivePage());
            for (let pageNumber = activePage - NATIVE_PDF_ZOOM_ANCHOR_PAGE_RADIUS; pageNumber <= activePage + NATIVE_PDF_ZOOM_ANCHOR_PAGE_RADIUS; pageNumber += 1) {
                if (pageNumber >= 1 && pageNumber <= pageCount) {
                    pageNumbers.add(pageNumber);
                }
            }
            return [...pageNumbers].sort((a, b) => a - b);
        };
        const forEach = (
            callback: (layout: IDocumentZoomPageLayout, index: number, array: readonly IDocumentZoomPageLayout[]) => void,
            thisArg?: unknown,
        ) => {
            for (const pageNumber of getPageNumbers()) {
                const layout = getPageLayout(pageNumber);
                const pageLeft = adapterOptions.getPageLeft?.(layout.width);
                callback.call(thisArg, {
                    ...layout,
                    ...(pageLeft === undefined ? {} : {left: pageLeft}),
                }, pageNumber - 1, adapter);
            }
        };
        const adapter = new Proxy(target, {get(_target, property) {
            if (property === 'length') {
                return pageCount;
            }
            if (property === 'forEach') {
                return forEach;
            }
            if (typeof property === 'string' && /^\d+$/u.test(property)) {
                const pageIndex = Number(property);
                if (Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount) {
                    const layout = getPageLayout(pageIndex + 1);
                    const pageLeft = adapterOptions.getPageLeft?.(layout.width);
                    return {
                        ...layout,
                        ...(pageLeft === undefined ? {} : {left: pageLeft}),
                    };
                }
            }
            return undefined;
        }});
        return adapter;
    }

    return {
        pageCount,
        totalHeight,
        maxPageWidth,
        getPageSize: pageGeometry.getPageSize,
        getPageHeight,
        getPageTop,
        getPageLayout,
        resolveMostVisiblePage,
        resolvePageNumbers,
        createZoomLayoutAdapter,
    };
}
