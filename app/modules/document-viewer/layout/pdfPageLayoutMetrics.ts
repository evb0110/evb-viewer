import type { TPageIndex } from '@contracts/pageNumbers';

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

// A document taller than the browser can scroll is shown through one physical
// segment at a time. The viewport session owns the segment origin; these
// functions only say which origins are valid and when one has to move.
// Origins sit at row starts, so no mounted row begins above the segment.

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

/** The latest row-start origin at or above `top`. */
function alignLayoutPhysicalScrollOrigin(layout: IPdfPageLayoutMetrics, top: number) {
    const rowIndex = findFirstLayoutRowAtOrAfter(layout, top + layout.paddingTop, true) - 1;
    return rowIndex <= 0 ? 0 : getLayoutRowTop(layout, rowIndex) - layout.paddingTop;
}

function getLayoutMaxPhysicalScrollOrigin(layout: IPdfPageLayoutMetrics, contentHeight: number) {
    return alignLayoutPhysicalScrollOrigin(layout, contentHeight - PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
}

/**
 * The physical segment for an origin, or null when the whole document fits.
 * Its pages are the rows that start inside it; no other row can be placed.
 */
export function getLayoutPhysicalScrollSegment(
    layout: IPdfPageLayoutMetrics,
    origin: number,
) {
    const contentHeight = getLayoutContentHeight(layout);
    if (contentHeight <= PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT) {
        return null;
    }
    // The last segment ends with the document and may exceed the cap by part of a row.
    const height = origin >= getLayoutMaxPhysicalScrollOrigin(layout, contentHeight)
        ? contentHeight - origin
        : PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT;
    // One pixel absorbs rounding between an aligned origin and its row's top.
    const firstRow = findFirstLayoutRowAtOrAfter(layout, origin + layout.paddingTop - 1);
    const lastRow = Math.max(firstRow, findFirstLayoutRowAtOrAfter(layout, origin + height) - 1);
    return {
        height,
        origin,
        firstPage: layout.base.rowStartPages[firstRow] ?? 1,
        lastPage: layout.base.rowEndPages[lastRow] ?? layout.base.totalPages,
    };
}

/**
 * Keeps `currentOrigin` while it is still a row start and the viewport at
 * document offset `viewportTop` stays a viewport away from both ends of its
 * segment; otherwise returns the row-start origin that centres the viewport
 * in a new segment.
 */
export function resolveLayoutPhysicalScrollOrigin(
    layout: IPdfPageLayoutMetrics,
    viewportTop: number,
    viewportHeight: number,
    currentOrigin: number | null,
) {
    const contentHeight = getLayoutContentHeight(layout);
    if (contentHeight <= PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT) {
        return 0;
    }
    const maxOrigin = getLayoutMaxPhysicalScrollOrigin(layout, contentHeight);
    if (
        currentOrigin !== null && currentOrigin >= 0 && currentOrigin <= maxOrigin
        && alignLayoutPhysicalScrollOrigin(layout, currentOrigin) === currentOrigin
    ) {
        const height = currentOrigin >= maxOrigin ? contentHeight - currentOrigin : PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT;
        const top = viewportTop - currentOrigin;
        const leading = currentOrigin > 0 ? viewportHeight : 0;
        const trailing = currentOrigin < maxOrigin ? viewportHeight : 0;
        if (top >= leading && top + viewportHeight <= height - trailing) {
            return currentOrigin;
        }
    }
    return alignLayoutPhysicalScrollOrigin(layout, Math.min(
        maxOrigin,
        Math.max(0, viewportTop - PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT / 2),
    ));
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
