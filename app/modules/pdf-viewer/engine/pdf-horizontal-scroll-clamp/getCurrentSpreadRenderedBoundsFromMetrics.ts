import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { getPageRowBoundsForViewMode } from '@app/modules/document-viewer/public';
import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IRenderedSpreadHorizontalBounds } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/pdfHorizontalScrollClampTypes';

export function getCurrentSpreadRenderedBoundsFromMetrics(options: {
    container: HTMLElement;
    basePageWidth: number | null;
    basePageHeight: number | null;
    numPages: number;
    pageWidths: readonly number[];
    currentPage: number;
    viewMode: TPdfViewMode;
    effectiveScale: number;
    getScaleForPage?: ((pageNumber: TPageNumber) => number) | undefined;
    scaledMargin: number;
}): IRenderedSpreadHorizontalBounds | null {
    if (!options.basePageWidth || !options.basePageHeight || options.numPages <= 0) {
        return null;
    }

    const currentPage = requirePageNumber(options.currentPage, options.numPages);
    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: currentPage,
        viewMode: options.viewMode,
        totalPages: options.numPages,
    });
    const rowPageCount = Math.max(1, rowBounds.end - rowBounds.start + 1);
    let baseSpreadWidth = 0;
    let renderedSpreadWidth = 0;
    for (
        let pageNumber = Number(rowBounds.start);
        pageNumber <= rowBounds.end;
        pageNumber += 1
    ) {
        const normalizedPageNumber = requirePageNumber(pageNumber, options.numPages);
        const pageWidth = options.pageWidths[pageNumber - 1];
        baseSpreadWidth += pageWidth ?? 0;
        const pageScale = options.getScaleForPage?.(normalizedPageNumber) ?? options.effectiveScale;
        if (pageWidth && Number.isFinite(pageScale) && pageScale > 0) {
            renderedSpreadWidth += pageWidth * pageScale;
        }
    }
    if (!baseSpreadWidth) {
        return null;
    }
    if (renderedSpreadWidth <= 0) {
        renderedSpreadWidth = baseSpreadWidth * options.effectiveScale;
    }
    renderedSpreadWidth += Math.max(0, rowPageCount - 1) * options.scaledMargin;
    if (!Number.isFinite(renderedSpreadWidth) || renderedSpreadWidth <= 0) {
        return null;
    }

    return {
        left: Math.max(
            options.scaledMargin,
            (options.container.clientWidth - renderedSpreadWidth) / 2,
        ),
        width: renderedSpreadWidth,
    };
}
