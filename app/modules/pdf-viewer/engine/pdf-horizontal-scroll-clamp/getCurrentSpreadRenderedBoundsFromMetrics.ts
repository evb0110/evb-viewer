import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {
    getPageRowBoundsForViewMode,
    normalizePageMetrics,
    resolveCurrentSpreadBaseWidth,
} from '@app/modules/document-viewer/public';
import type {
    TPdfViewMode,
    TPdfViewRotation,
} from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type { IRenderedSpreadHorizontalBounds } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/pdfHorizontalScrollClampTypes';

export function getCurrentSpreadRenderedBoundsFromMetrics(options: {
    container: HTMLElement;
    basePageWidth: number | null;
    basePageHeight: number | null;
    numPages: number;
    pageMetrics: IPdfPageMetric[];
    currentPage: number;
    viewMode: TPdfViewMode;
    viewRotation: TPdfViewRotation;
    effectiveScale: number;
    getScaleForPage?: ((pageNumber: TPageNumber) => number) | undefined;
    scaledMargin: number;
}): IRenderedSpreadHorizontalBounds | null {
    if (!options.basePageWidth || !options.basePageHeight || options.numPages <= 0) {
        return null;
    }

    const normalizedMetrics = normalizePageMetrics({
        pageMetrics: options.pageMetrics,
        totalPages: options.numPages,
        fallbackWidth: options.basePageWidth,
        fallbackHeight: options.basePageHeight,
        viewRotation: options.viewRotation,
    });
    const currentPage = requirePageNumber(options.currentPage, options.numPages);
    const rowBounds = getPageRowBoundsForViewMode({
        pageNumber: currentPage,
        viewMode: options.viewMode,
        totalPages: options.numPages,
    });
    const rowPageCount = Math.max(1, rowBounds.end - rowBounds.start + 1);
    const baseSpreadWidth = resolveCurrentSpreadBaseWidth(
        normalizedMetrics,
        options.viewMode,
        options.numPages,
        currentPage,
    );
    if (!baseSpreadWidth) {
        return null;
    }

    let renderedSpreadWidth = 0;
    for (
        let pageNumber = Number(rowBounds.start);
        pageNumber <= rowBounds.end;
        pageNumber += 1
    ) {
        const normalizedPageNumber = requirePageNumber(pageNumber, options.numPages);
        const pageMetric = normalizedMetrics[pageNumber - 1];
        const pageScale = options.getScaleForPage?.(normalizedPageNumber) ?? options.effectiveScale;
        if (pageMetric && Number.isFinite(pageScale) && pageScale > 0) {
            renderedSpreadWidth += pageMetric.width * pageScale;
        }
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
