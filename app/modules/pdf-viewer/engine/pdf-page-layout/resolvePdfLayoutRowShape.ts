import {
    pageNumberToPageIndex,
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import {
    getLayoutPageHeight,
    getLayoutPageWidth,
    getLayoutRowHeight,
    getLayoutRowTop,
    type IPdfPageLayoutMetrics,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';

export interface IPdfLayoutRowShapePage {
    height: number;
    width: number;
}

export interface IPdfLayoutRowShape {
    pages: IPdfLayoutRowShapePage[];
    /** Distance between the tops of this row and the next one. */
    pitch: number;
    /** Row top in layout coordinates, including the track's top padding. */
    top: number;
}

/** The painted shape of the row that holds a page, as the page track lays it out. */
export function resolvePdfLayoutRowShape(
    layout: IPdfPageLayoutMetrics,
    page: TPageNumber,
): IPdfLayoutRowShape | null {
    const totalPages = layout.base.totalPages;
    if (totalPages <= 0) {
        return null;
    }
    const pageIndex = pageNumberToPageIndex(requirePageNumber(
        Math.min(totalPages, Math.max(1, Math.trunc(page))),
        totalPages,
    ));
    const rowIndex = layout.base.pageRowIndices[pageIndex] ?? -1;
    if (rowIndex < 0) {
        return null;
    }
    const rowStart = layout.base.rowStartPages[rowIndex] ?? pageIndex + 1;
    const rowEnd = layout.base.rowEndPages[rowIndex] ?? rowStart;
    const pages: IPdfLayoutRowShapePage[] = [];
    for (let pageNumber = rowStart; pageNumber <= rowEnd; pageNumber += 1) {
        const index = pageNumberToPageIndex(requirePageNumber(pageNumber, totalPages));
        pages.push({
            height: getLayoutPageHeight(layout, index),
            width: getLayoutPageWidth(layout, index),
        });
    }
    const pitch = getLayoutRowHeight(layout, rowIndex) + layout.gap;
    if (
        pages.length === 0
        || !Number.isFinite(pitch)
        || pitch <= layout.gap
        || pages.some(shapePage => !(shapePage.width > 0 && shapePage.height > 0))
    ) {
        return null;
    }
    return {
        pages,
        pitch,
        top: getLayoutRowTop(layout, rowIndex),
    };
}
