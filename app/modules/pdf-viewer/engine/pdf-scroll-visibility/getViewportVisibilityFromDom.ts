import { clamp } from 'es-toolkit/math';
import {
    parsePageNumber,
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import { measureDevPerf } from '@app/utils/devPerf';
import type {
    IViewportVisibilityResult,
    IVisiblePageRange,
} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import {
    getLayoutPageHeight,
    getLayoutPageTop as getResolvedLayoutPageTop,
    getLayoutPageWidth,
    getLayoutRowHeight,
    getLayoutRowTop as getResolvedLayoutRowTop,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

interface IVisiblePageMetrics {
    range: IVisiblePageRange | null;
    mostVisiblePage: TPageNumber | null;
    maxVisibleArea: number;
}

function normalizePageNumber(value: unknown) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }

    const pageNumber = Number.parseInt(value, 10);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return null;
    }

    return parsePageNumber(pageNumber);
}

export function getPageNumberFromElement(element: HTMLElement) {
    return normalizePageNumber(element.dataset.page);
}

export function isBufferedPageElement(element: HTMLElement) {
    return element.classList.contains('page_container--buffered') === true;
}

function getViewportIntersectionLength(
    start: number,
    end: number,
    viewportStart: number,
    viewportEnd: number,
) {
    return Math.max(0, Math.min(end, viewportEnd) - Math.max(start, viewportStart));
}

function getLayoutPageTop(metrics: IPdfPageLayoutMetrics, index: number) {
    return Math.max(
        0,
        (getResolvedLayoutPageTop(metrics, requirePageIndex(index)) ?? 0) - metrics.paddingTop,
    );
}

function getLayoutRowTop(metrics: IPdfPageLayoutMetrics, rowIndex: number) {
    return Math.max(0, getResolvedLayoutRowTop(metrics, rowIndex) - metrics.paddingTop);
}

function getLayoutRowBottom(metrics: IPdfPageLayoutMetrics, rowIndex: number) {
    return getLayoutRowTop(metrics, rowIndex) + getLayoutRowHeight(metrics, rowIndex);
}

function getLayoutRowWidth(metrics: IPdfPageLayoutMetrics, rowIndex: number) {
    const rowStartPage = metrics.base.rowStartPages[rowIndex] ?? 1;
    const rowEndPage = metrics.base.rowEndPages[rowIndex] ?? rowStartPage;
    let width = 0;
    for (let pageNumber = rowStartPage; pageNumber <= rowEndPage; pageNumber += 1) {
        width += getLayoutPageWidth(metrics, requirePageIndex(pageNumber - 1));
    }
    return width;
}

function getLayoutPageLeft(metrics: IPdfPageLayoutMetrics, index: number, containerWidth: number) {
    const rowIndex = metrics.base.pageRowIndices[index] ?? 0;
    const rowStartPage = metrics.base.rowStartPages[rowIndex] ?? index + 1;
    let pageLeft = Math.max(0, (containerWidth - getLayoutRowWidth(metrics, rowIndex)) / 2);
    for (let pageNumber = rowStartPage; pageNumber < index + 1; pageNumber += 1) {
        pageLeft += getLayoutPageWidth(metrics, requirePageIndex(pageNumber - 1));
    }
    return pageLeft;
}

function findFirstVisibleLayoutRowIndex(metrics: IPdfPageLayoutMetrics, viewportTop: number) {
    let low = 0;
    let high = metrics.base.rowHeights.length - 1;
    let result = -1;
    while (low <= high) {
        const mid = low + Math.floor((high - low) / 2);
        if (getLayoutRowBottom(metrics, mid) > viewportTop) {
            result = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    return result;
}

function findLastVisibleLayoutRowIndex(metrics: IPdfPageLayoutMetrics, viewportBottom: number) {
    let low = 0;
    let high = metrics.base.rowHeights.length - 1;
    let result = -1;
    while (low <= high) {
        const mid = low + Math.floor((high - low) / 2);
        if (getLayoutRowTop(metrics, mid) < viewportBottom) {
            result = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return result;
}

export function getViewportVisibilityFromLayout(
    container: HTMLElement,
    totalPages: number,
    metrics: IPdfPageLayoutMetrics | null,
    physicalScrollOrigin = 0,
): IViewportVisibilityResult | null {
    if (!metrics || metrics.base.totalPages !== totalPages) {
        return null;
    }
    const viewportTop = Math.max(
        0,
        container.scrollTop + Math.max(0, physicalScrollOrigin) - metrics.paddingTop,
    );
    const viewportBottom = viewportTop + container.clientHeight;
    const layoutPageCount = Math.min(
        totalPages,
        metrics.base.pageRowIndices.length,
        metrics.base.pageHeights.length,
    );
    if (layoutPageCount <= 0) {
        return null;
    }
    const firstVisibleRowIndex = findFirstVisibleLayoutRowIndex(metrics, viewportTop);
    const lastVisibleRowIndex = findLastVisibleLayoutRowIndex(metrics, viewportBottom);
    if (
        firstVisibleRowIndex === -1
        || lastVisibleRowIndex === -1
        || lastVisibleRowIndex < firstVisibleRowIndex
    ) {
        return null;
    }
    const viewportLeft = Math.max(0, container.scrollLeft);
    const viewportRight = viewportLeft + container.clientWidth;
    let firstVisiblePage: TPageNumber | null = null;
    let lastVisiblePage: TPageNumber | null = null;
    let mostVisiblePage: TPageNumber | null = null;
    let maxVisibleArea = 0;
    const firstVisibleIndex = clamp(
        (metrics.base.rowStartPages[firstVisibleRowIndex] ?? 1) - 1,
        0,
        layoutPageCount - 1,
    );
    const lastVisibleIndex = clamp(
        (metrics.base.rowEndPages[lastVisibleRowIndex] ?? layoutPageCount) - 1,
        0,
        layoutPageCount - 1,
    );
    for (let index = firstVisibleIndex; index <= lastVisibleIndex; index += 1) {
        const pageTop = getLayoutPageTop(metrics, index);
        const pageHeight = getLayoutPageHeight(metrics, requirePageIndex(index));
        const pageLeft = getLayoutPageLeft(metrics, index, container.clientWidth);
        const pageWidth = getLayoutPageWidth(metrics, requirePageIndex(index));
        const visibleArea = getViewportIntersectionLength(
            pageTop,
            pageTop + pageHeight,
            viewportTop,
            viewportBottom,
        ) * getViewportIntersectionLength(
            pageLeft,
            pageLeft + pageWidth,
            viewportLeft,
            viewportRight,
        );
        if (visibleArea <= 0) {
            continue;
        }
        const pageNumber = requirePageNumber(index + 1, totalPages);
        firstVisiblePage ??= pageNumber;
        lastVisiblePage = pageNumber;
        if (visibleArea > maxVisibleArea) {
            maxVisibleArea = visibleArea;
            mostVisiblePage = pageNumber;
        }
    }
    if (firstVisiblePage === null || lastVisiblePage === null) {
        return null;
    }
    return {
        range: {
            start: requirePageNumber(clamp(firstVisiblePage, 1, totalPages), totalPages),
            end: requirePageNumber(clamp(lastVisiblePage, 1, totalPages), totalPages),
        },
        mostVisiblePage: maxVisibleArea > 0 && mostVisiblePage !== null
            ? requirePageNumber(clamp(mostVisiblePage, 1, totalPages), totalPages)
            : null,
    };
}

function collectVisiblePageMetrics(container: HTMLElement): IVisiblePageMetrics {
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');

    let firstVisiblePage: TPageNumber | null = null;
    let lastVisiblePage: TPageNumber | null = null;
    let mostVisiblePage: TPageNumber | null = null;
    let maxVisibleArea = 0;

    for (const pageElement of pageContainers) {
        if (isBufferedPageElement(pageElement)) {
            continue;
        }

        const pageNumber = getPageNumberFromElement(pageElement);
        if (!pageNumber) {
            continue;
        }

        const pageTop = pageElement.offsetTop;
        const pageBottom = pageTop + pageElement.offsetHeight;
        const pageLeft = pageElement.offsetLeft;
        const pageRight = pageLeft + pageElement.offsetWidth;
        const visibleArea = getViewportIntersectionLength(
            pageTop,
            pageBottom,
            viewportTop,
            viewportBottom,
        ) * getViewportIntersectionLength(
            pageLeft,
            pageRight,
            viewportLeft,
            viewportRight,
        );

        if (visibleArea > 0) {
            firstVisiblePage ??= pageNumber;
            lastVisiblePage = pageNumber;

            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                mostVisiblePage = pageNumber;
            }
        }

        if (pageTop > viewportBottom) {
            break;
        }
    }

    return {
        range:
            firstVisiblePage !== null && lastVisiblePage !== null
                ? {
                    start: firstVisiblePage,
                    end: lastVisiblePage,
                }
                : null,
        mostVisiblePage,
        maxVisibleArea,
    };
}

export function getViewportVisibilityFromDom(
    container: HTMLElement,
    totalPages: number,
): IViewportVisibilityResult {
    return measureDevPerf('pdf:scroll-visibility', () => {
        if (totalPages <= 0) {
            return {
                range: null,
                mostVisiblePage: null,
            };
        }

        const visible = collectVisiblePageMetrics(container);
        return {
            range: visible.range
                ? {
                    start: requirePageNumber(clamp(visible.range.start, 1, totalPages), totalPages),
                    end: requirePageNumber(clamp(visible.range.end, 1, totalPages), totalPages),
                }
                : null,
            mostVisiblePage:
                visible.maxVisibleArea > 0 && visible.mostVisiblePage !== null
                    ? requirePageNumber(clamp(visible.mostVisiblePage, 1, totalPages), totalPages)
                    : null,
        };
    }, {
        thresholdMs: 8,
        details: { totalPages },
    });
}
