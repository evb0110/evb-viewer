import {
    requirePageIndex,
    requirePageNumber,
    type TPageIndex,
    type TPageNumber,
} from '@contracts/pageNumbers';

export interface IPdfPageLayoutBase {
    totalPages: number;
    /** True when the base uses lazy indexed collections instead of dense arrays. */
    isSparse: boolean;
    maxPageWidth: number;
    maxPageHeight: number;
    pageWidths: readonly number[];
    pageHeights: readonly number[];
    pageHeightPrefixSums: readonly number[];
    pageRowIndices: readonly number[];
    rowStartPages: readonly number[];
    rowEndPages: readonly number[];
    rowHeights: readonly number[];
    rowHeightPrefixSums: readonly number[];
}

export interface IPdfPageLayoutMetrics {
    base: IPdfPageLayoutBase;
    scale: number;
    gap: number;
    paddingTop: number;
    paddingBottom: number;
}

export const PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT = 8_388_608;

export function getLayoutPhysicalScrollSegment(
    layout: IPdfPageLayoutMetrics,
    anchorTop: number,
) {
    const contentHeight = getLayoutContentHeight(layout);
    if (contentHeight <= PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT) {
        return null;
    }
    const origin = Math.floor(anchorTop / PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT)
        * PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT;
    return {
        height: Math.min(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT, contentHeight - origin),
        origin,
    };
}

export function getLayoutPhysicalScrollOrigin(
    layout: IPdfPageLayoutMetrics,
    pageNumber: number,
) {
    const boundedPage = Math.min(
        layout.base.totalPages,
        Math.max(1, Math.trunc(pageNumber)),
    );
    const pageIndex = requirePageIndex(boundedPage - 1);
    const pageTop = getLayoutPageTop(layout, pageIndex) ?? 0;
    return getLayoutPhysicalScrollSegment(layout, pageTop)?.origin ?? 0;
}

function findFirstLayoutRowAtOrAfter(
    layout: IPdfPageLayoutMetrics,
    top: number,
    strictlyAfter = false,
) {
    let low = 0;
    let high = layout.base.rowHeights.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const rowTop = getLayoutRowTop(layout, middle);
        if (rowTop < top || (strictlyAfter && rowTop === top)) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function getLayoutPageAtOrAfterTop(layout: IPdfPageLayoutMetrics, top: number) {
    const rowIndex = findFirstLayoutRowAtOrAfter(layout, Math.max(0, top));
    for (const candidateRowIndex of [
        rowIndex - 1,
        rowIndex,
    ]) {
        if (candidateRowIndex < 0 || candidateRowIndex >= layout.base.rowHeights.length) {
            continue;
        }
        const rowTop = getLayoutRowTop(layout, candidateRowIndex);
        const start = layout.base.rowStartPages[candidateRowIndex] ?? 1;
        if (rowTop >= top) {
            return requirePageNumber(start);
        }
    }
    return null;
}

function getLayoutPageAtOrBeforeTop(layout: IPdfPageLayoutMetrics, top: number) {
    const rowIndex = findFirstLayoutRowAtOrAfter(layout, Math.max(0, top), true);
    for (let candidateRowIndex = Math.min(
        rowIndex - 1,
        layout.base.rowHeights.length - 1,
    ); candidateRowIndex >= 0; candidateRowIndex -= 1) {
        const rowTop = getLayoutRowTop(layout, candidateRowIndex);
        if (rowTop > top) {
            continue;
        }
        const start = layout.base.rowStartPages[candidateRowIndex] ?? 1;
        const end = layout.base.rowEndPages[candidateRowIndex] ?? start;
        return requirePageNumber(end);
    }
    return layout.base.rowStartPages.length > 0
        ? requirePageNumber(layout.base.rowStartPages[0] ?? 1)
        : null;
}

export function getLayoutPhysicalScrollSegmentTransition(
    layout: IPdfPageLayoutMetrics,
    scrollTop: number,
    previousScrollTop: number,
    viewportHeight: number,
    physicalScrollOrigin: number,
): {
    origin: number;
    page: TPageNumber;
    scrollTop: number;
} | null {
    const segment = getLayoutPhysicalScrollSegment(layout, physicalScrollOrigin);
    if (!segment || !Number.isFinite(scrollTop) || !Number.isFinite(previousScrollTop)) {
        return null;
    }
    const maxScrollTop = Math.max(0, segment.height - Math.max(0, viewportHeight));
    if (previousScrollTop < scrollTop) {
        if (
            scrollTop < maxScrollTop - 1
            || physicalScrollOrigin + segment.height >= getLayoutContentHeight(layout)
        ) {
            return null;
        }
        const origin = physicalScrollOrigin + PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT;
        const page = getLayoutPageAtOrAfterTop(layout, origin);
        if (!page) {
            return null;
        }
        const pageTop = getLayoutPageTop(layout, requirePageIndex(page - 1));
        return pageTop === null ? null : {
            origin,
            page,
            scrollTop: Math.max(0, pageTop - origin),
        };
    }
    if (
        previousScrollTop <= scrollTop
        || scrollTop > 1
        || physicalScrollOrigin <= 0
    ) {
        return null;
    }
    const origin = Math.max(0, physicalScrollOrigin - PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
    const previousSegment = getLayoutPhysicalScrollSegment(layout, origin);
    if (!previousSegment) {
        return null;
    }
    const previousMaxScrollTop = Math.max(
        0,
        previousSegment.height - Math.max(0, viewportHeight),
    );
    const page = getLayoutPageAtOrBeforeTop(
        layout,
        origin + previousMaxScrollTop,
    );
    return page === null ? null : {
        origin,
        page,
        scrollTop: previousMaxScrollTop,
    };
}

export function getLayoutPageWidth(layout: IPdfPageLayoutMetrics, pageIndex: TPageIndex) {
    return (layout.base.pageWidths[pageIndex] ?? 0) * layout.scale;
}

export function getLayoutPageHeight(layout: IPdfPageLayoutMetrics, pageIndex: TPageIndex) {
    return (layout.base.pageHeights[pageIndex] ?? 0) * layout.scale;
}

export function getLayoutRowHeight(layout: IPdfPageLayoutMetrics, rowIndex: number) {
    return (layout.base.rowHeights[rowIndex] ?? 0) * layout.scale;
}

export function getLayoutRowTop(layout: IPdfPageLayoutMetrics, rowIndex: number) {
    return layout.paddingTop
        + (layout.base.rowHeightPrefixSums[rowIndex - 1] ?? 0) * layout.scale
        + rowIndex * layout.gap;
}

export function getLayoutPageTop(layout: IPdfPageLayoutMetrics, pageIndex: TPageIndex) {
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    return rowIndex < 0 ? null : getLayoutRowTop(layout, rowIndex);
}

export function getLayoutContentHeight(layout: IPdfPageLayoutMetrics) {
    const rowCount = layout.base.rowHeights.length;
    return layout.paddingTop
        + layout.paddingBottom
        + (layout.base.rowHeightPrefixSums[rowCount - 1] ?? 0) * layout.scale
        + Math.max(0, rowCount - 1) * layout.gap;
}
