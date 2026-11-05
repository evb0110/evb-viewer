import type { TPageIndex } from '@contracts/pageNumbers';
import {
    createLazyIndexedCollection, isLazyIndexedCollection,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
import type {
    IDocumentViewportWrite, IDocumentViewportWritePort,
} from '@app/modules/document-viewer/runtime/documentViewportWritePort';

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

// Physical scrolling needs the vertical rows, independent of page-width policy.
type TLayoutScrollMetrics = Pick<IPdfPageLayoutMetrics, 'scale' | 'gap' | 'paddingTop' | 'paddingBottom'> & {base: Pick<IPdfPageLayoutBase, 'totalPages' | 'rowHeights' | 'rowHeightPrefixSums' | 'rowStartPages' | 'rowEndPages'>;};
type TDocumentPageHeights = readonly number[] & { readonly sumRange?: (start: number, end: number) => number };

export const PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT = 8_388_608;

// A document taller than the browser can scroll is shown through one physical
// segment at a time. The viewport session owns the segment origin; these
// functions only say which origins are valid and when one has to move.
// Origins sit at row starts, so no mounted row begins above the segment.

function findFirstLayoutRowAtOrAfter(
    layout: TLayoutScrollMetrics,
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
function alignLayoutPhysicalScrollOrigin(layout: TLayoutScrollMetrics, top: number) {
    const rowIndex = findFirstLayoutRowAtOrAfter(layout, top + layout.paddingTop, true) - 1;
    return rowIndex <= 0 ? 0 : getLayoutRowTop(layout, rowIndex) - layout.paddingTop;
}

function getLayoutMaxPhysicalScrollOrigin(layout: TLayoutScrollMetrics, contentHeight: number) {
    return alignLayoutPhysicalScrollOrigin(layout, contentHeight - PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
}

/**
 * The physical segment for an origin, or null when the whole document fits.
 * Its pages are the rows that start inside it; no other row can be placed.
 */
export function getLayoutPhysicalScrollSegment(
    layout: TLayoutScrollMetrics,
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
    layout: TLayoutScrollMetrics,
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

export function getLayoutRowHeight(layout: TLayoutScrollMetrics, rowIndex: number) {
    return (layout.base.rowHeights[rowIndex] ?? 0) * layout.scale;
}

export function getLayoutRowTop(layout: TLayoutScrollMetrics, rowIndex: number) {
    return layout.paddingTop
        + (layout.base.rowHeightPrefixSums[rowIndex - 1] ?? 0) * layout.scale
        + rowIndex * layout.gap;
}

export function getLayoutPageTop(layout: IPdfPageLayoutMetrics, pageIndex: TPageIndex) {
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    return rowIndex < 0 ? null : getLayoutRowTop(layout, rowIndex);
}

export function getLayoutContentHeight(layout: TLayoutScrollMetrics) {
    const rowCount = layout.base.rowHeights.length;
    return layout.paddingTop
        + layout.paddingBottom
        + (layout.base.rowHeightPrefixSums[rowCount - 1] ?? 0) * layout.scale
        + Math.max(0, rowCount - 1) * layout.gap;
}

export function resolveDocumentPageTopsBounded(
    heights: TDocumentPageHeights,
) {
    if (!isLazyIndexedCollection(heights)) {
        let top = DOCUMENT_PAGE_GUTTER_PX;
        return heights.map((height) => {
            const value = top;
            top += height + DOCUMENT_PAGE_GUTTER_PX;
            return value;
        });
    }
    const sumRange = heights.sumRange;
    if (sumRange) {
        return createLazyIndexedCollection({
            cacheValues: false,
            getValue: index => DOCUMENT_PAGE_GUTTER_PX
                + index * DOCUMENT_PAGE_GUTTER_PX
                + sumRange(0, index),
            length: heights.length,
        });
    }
    const prefixTops = new Map<number, number>([[
        0,
        DOCUMENT_PAGE_GUTTER_PX,
    ]]);
    const resolvePageTop = (index: number) => {
        const cached = prefixTops.get(index);
        if (cached !== undefined) {
            return cached;
        }
        let nearestIndex = 0;
        let top = DOCUMENT_PAGE_GUTTER_PX;
        for (const [
            cachedIndex,
            cachedTop,
        ] of prefixTops) {
            if (cachedIndex <= index && cachedIndex >= nearestIndex) {
                nearestIndex = cachedIndex;
                top = cachedTop;
            }
        }
        for (let pageIndex = nearestIndex; pageIndex < index; pageIndex += 1) {
            top += (heights[pageIndex] ?? 0) + DOCUMENT_PAGE_GUTTER_PX;
        }
        prefixTops.set(index, top);
        while (prefixTops.size > 32) {
            const oldest = [...prefixTops.keys()].find(key => key !== 0 && key !== index);
            if (oldest === undefined) {
                break;
            }
            prefixTops.delete(oldest);
        }
        return top;
    };
    return createLazyIndexedCollection({
        cacheValues: false,
        getValue: resolvePageTop,
        length: heights.length,
    });
}

/** Page-source rows reuse the same physical layout contract as PDF rows. */
export function buildDocumentPageSourceScrollLayout(heights: TDocumentPageHeights) {
    const pageTops = resolveDocumentPageTopsBounded(heights);
    const rows = createLazyIndexedCollection({
        length: heights.length,
        getValue: index => index + 1,
    });
    const layout = {
        scale: 1,
        gap: DOCUMENT_PAGE_GUTTER_PX,
        paddingTop: DOCUMENT_PAGE_GUTTER_PX,
        paddingBottom: DOCUMENT_PAGE_GUTTER_PX,
        base: {
            totalPages: heights.length,
            rowHeights: heights,
            rowStartPages: rows,
            rowEndPages: rows,
            rowHeightPrefixSums: createLazyIndexedCollection({
                length: heights.length,
                getValue: index => (pageTops[index] ?? DOCUMENT_PAGE_GUTTER_PX)
                    - DOCUMENT_PAGE_GUTTER_PX * (index + 1) + (heights[index] ?? 0),
            }),
        },
    } satisfies TLayoutScrollMetrics;
    return {
        layout,
        pageTops,
    };
}

/** The viewport session's single origin owner, shared by PDF and page sources. */
export function createLayoutPhysicalScrollSession() {
    const origin = shallowRef(0);
    function place(layout: TLayoutScrollMetrics | null, documentTop: number, height: number, currentOrigin = origin.value) {
        origin.value = layout ? resolveLayoutPhysicalScrollOrigin(layout, documentTop, height, currentOrigin) : 0;
        return origin.value;
    }
    function apply(options: {
        layout: TLayoutScrollMetrics | null;
        container: HTMLElement;
        port: IDocumentViewportWritePort;
        write: IDocumentViewportWrite;
        isCurrent: () => boolean;
        onApplied?: () => void;
    }) {
        const previousOrigin = origin.value;
        const nextOrigin = place(options.layout, options.write.top ?? previousOrigin + options.container.scrollTop, options.container.clientHeight);
        const commit = () => {
            if (!options.isCurrent() || origin.value !== nextOrigin) return false;
            const applied = options.port.apply(options.container, {
                ...options.write,
                ...(options.write.top === undefined ? {} : {top: options.write.top - nextOrigin}),
            });
            if (applied) options.onApplied?.();
            return applied;
        };
        // Vue must install the new physical track before the browser can accept
        // its offset. The existing write intent fences newer commands/input.
        if (nextOrigin !== previousOrigin) {
            void nextTick(commit);
            return true;
        }
        return commit();
    }
    return {
        origin,
        place,
        apply,
    };
}
