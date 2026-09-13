import { resolveDocumentRasterResidencyPlan } from '@app/modules/document-viewer/public';

export interface IDocumentPageSourceRenderDemandOptions {
    bufferRadius?: number;
    continuousScroll: boolean;
    currentPage: number;
    pageCount: number;
    pageHeights: readonly number[];
    pageTops: readonly number[];
    scrollTop: number;
    viewportHeight: number;
    mountedPages?: readonly number[];
    maxBufferPixels?: number;
    maximumResidentPages?: number;
    minimumBufferPages?: number;
    preferredDirection?: -1 | 0 | 1;
    estimatePagePixels?: ((pageNumber: number) => number) | undefined;
}
export interface IDocumentPageSourceRenderDemand {
    bufferPages: number[];
    residentPages: number[];
    visiblePages: number[];
}

function normalizePage(pageNumber: number, pageCount: number) {
    return Math.max(1, Math.min(pageCount, Math.trunc(pageNumber)));
}

function resolveContinuousVisiblePages(options: IDocumentPageSourceRenderDemandOptions, pageCount: number) {
    const viewportBottom = options.scrollTop + Math.max(1, options.viewportHeight);
    let low = 0;
    let high = pageCount;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const top = options.pageTops[middle] ?? Number.POSITIVE_INFINITY;
        const height = options.pageHeights[middle] ?? 0;
        if (top + height <= options.scrollTop) low = middle + 1;
        else high = middle;
    }
    const pages: number[] = [];
    for (let index = low; index < pageCount; index += 1) {
        const top = options.pageTops[index];
        if (top === undefined || top >= viewportBottom) break;
        const height = options.pageHeights[index];
        if (height !== undefined && top + height > options.scrollTop) pages.push(index + 1);
    }
    return pages;
}

/**
 * Keeps geometry virtualization independent from raster residency. The page
 * source may mount a broad positional window, but only viewport pages and a
 * short contiguous guard band own decoded full-page surfaces.
 */
export function resolveDocumentPageSourceRenderDemand(
    options: IDocumentPageSourceRenderDemandOptions,
): IDocumentPageSourceRenderDemand {
    const pageCount = Math.max(0, Math.trunc(options.pageCount));
    if (pageCount === 0) {
        return {
            bufferPages: [],
            residentPages: [],
            visiblePages: [],
        };
    }

    const currentPage = normalizePage(options.currentPage, pageCount);
    const visiblePages = options.continuousScroll
        ? resolveContinuousVisiblePages(options, pageCount)
        : [currentPage];
    if (!visiblePages.includes(currentPage)) {
        visiblePages.push(currentPage);
        visiblePages.sort((left, right) => left - right);
    }

    const fallbackRadius = Math.max(1, Math.trunc(options.bufferRadius ?? 1));
    const mountedPages = options.mountedPages ?? [...new Set(visiblePages.flatMap(pageNumber => (
        Array.from(
            {length: fallbackRadius * 2 + 1},
            (_, index) => normalizePage(pageNumber - fallbackRadius + index, pageCount),
        )
    )))];
    const plan = resolveDocumentRasterResidencyPlan({
        mountedPages,
        visiblePages,
        bufferRadius: options.bufferRadius ?? 1,
        maxBufferPixels: options.maxBufferPixels ?? Number.POSITIVE_INFINITY,
        ...(options.maximumResidentPages === undefined
            ? {}
            : {maximumResidentPages: options.maximumResidentPages}),
        ...(options.minimumBufferPages === undefined
            ? {}
            : {minimumBufferPages: options.minimumBufferPages}),
        ...(options.preferredDirection === undefined
            ? {}
            : {preferredDirection: options.preferredDirection}),
        estimatePagePixels: options.estimatePagePixels ?? (() => 1),
    });
    const bufferPages = plan.bufferPages.toSorted((left, right) => left - right);

    return {
        bufferPages,
        residentPages: plan.residentPages.toSorted((left, right) => left - right),
        visiblePages: plan.visiblePages,
    };
}
