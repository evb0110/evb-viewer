import {
    pageNumberToPageIndex,
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import {
    getLayoutPageHeight,
    getLayoutPageWidth,
    getLayoutRowHeight,
    type IPdfPageLayoutMetrics,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

/** Which spacer edge touches a mounted row, and therefore where a hidden row sits flush. */
export type TPdfVirtualSpacerShellAnchor = 'top' | 'bottom';

interface IShellPage {
    height: number;
    offset: number;
    width: number;
}

function formatPx(value: number) {
    return `${Math.round(value * 1000) / 1000}px`;
}

/**
 * Paints the pages a virtual spacer stands in for as repeated page shells.
 *
 * The spacer background is a single paint operation over the whole spacer, so
 * the compositor can rasterize it wherever it scrolls, including frames in
 * which a fast fling has outrun the main thread and no page is mounted there.
 * Without it such frames show only the viewer background.
 *
 * The pattern repeats the row adjacent to the spacer at the track's row pitch
 * and is anchored at the edge that touches that row. Uniform documents line up
 * exactly with the pages that replace the pattern when they mount.
 */
export function buildPdfVirtualSpacerShellStyle(
    layout: IPdfPageLayoutMetrics,
    adjacentPage: TPageNumber,
    anchor: TPdfVirtualSpacerShellAnchor,
): Record<string, string> | null {
    const totalPages = layout.base.totalPages;
    if (totalPages <= 0) {
        return null;
    }
    const pageIndex = pageNumberToPageIndex(requirePageNumber(
        Math.min(totalPages, Math.max(1, Math.trunc(adjacentPage))),
        totalPages,
    ));
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    if (rowIndex < 0) {
        return null;
    }
    const rowStart = layout.base.rowStartPages[rowIndex] ?? pageIndex + 1;
    const rowEnd = layout.base.rowEndPages[rowIndex] ?? rowStart;
    const pages: IShellPage[] = [];
    let rowWidth = 0;
    for (let pageNumber = rowStart; pageNumber <= rowEnd; pageNumber += 1) {
        const index = pageNumberToPageIndex(requirePageNumber(pageNumber, totalPages));
        const width = getLayoutPageWidth(layout, index);
        const height = getLayoutPageHeight(layout, index);
        if (pages.length > 0) {
            rowWidth += layout.gap;
        }
        pages.push({
            height,
            offset: rowWidth,
            width,
        });
        rowWidth += width;
    }
    const pitch = getLayoutRowHeight(layout, rowIndex) + layout.gap;
    if (
        pages.length === 0
        || !Number.isFinite(pitch)
        || pitch <= layout.gap
        || pages.some(page => !(page.width > 0 && page.height > 0))
    ) {
        return null;
    }
    // A top-anchored tile starts with a page. A bottom-anchored tile is pushed
    // one gap below the spacer so that a page, not a gap, ends at its edge.
    const positionY = anchor === 'top' ? '0px' : `calc(100% + ${formatPx(layout.gap)})`;
    return {
        // The track centres a row inside its content box and left-aligns a row
        // wider than it; a spacer at least as wide as the row does the same.
        width: `max(100%, ${formatPx(rowWidth)})`,
        backgroundImage: pages.map(page => (
            `linear-gradient(var(--app-pdf-page-bg) 0 ${formatPx(page.height)}, transparent ${formatPx(page.height)})`
        )).join(', '),
        backgroundSize: pages.map(page => `${formatPx(page.width)} ${formatPx(pitch)}`).join(', '),
        backgroundRepeat: 'repeat-y',
        backgroundPosition: pages.map(page => (
            `calc(50% + ${formatPx(page.offset - ((rowWidth - page.width) / 2))}) ${positionY}`
        )).join(', '),
    };
}
