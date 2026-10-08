import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/pdfContracts';
import { getCurrentSpreadRenderedBoundsFromDom } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromDom';
import { getCurrentSpreadRenderedBoundsFromMetrics } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/getCurrentSpreadRenderedBoundsFromMetrics';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';

export function resolveHorizontalScrollClampForActiveSpread(options: {
    container: HTMLElement | null;
    fitMode: TFitMode;
    pageNumber: TPageNumber;
    viewMode: TPdfViewMode;
    numPages: number;
    basePageWidth: number | null;
    basePageHeight: number | null;
    pageWidths: readonly number[];
    effectiveScale: number;
    getScaleForPage?: ((pageNumber: TPageNumber) => number) | undefined;
    scaledMargin: number;
    epsilon: number;
}) {
    if (!options.container || options.fitMode !== 'width') {
        return null;
    }

    const renderedSpreadBounds =
        getCurrentSpreadRenderedBoundsFromDom({
            container: options.container,
            pageNumber: options.pageNumber,
            viewMode: options.viewMode,
            totalPages: options.numPages,
        })
        ?? getCurrentSpreadRenderedBoundsFromMetrics({
            container: options.container,
            basePageWidth: options.basePageWidth,
            basePageHeight: options.basePageHeight,
            numPages: options.numPages,
            pageWidths: options.pageWidths,
            currentPage: options.pageNumber,
            viewMode: options.viewMode,
            effectiveScale: options.effectiveScale,
            getScaleForPage: options.getScaleForPage,
            scaledMargin: options.scaledMargin,
        });
    if (!renderedSpreadBounds) {
        return null;
    }

    return resolvePageBoundedHorizontalScroll({
        scrollLeft: options.container.scrollLeft,
        viewportWidth: options.container.clientWidth,
        pageLeft: renderedSpreadBounds.left,
        pageWidth: renderedSpreadBounds.width,
        margin: options.scaledMargin,
        epsilon: options.epsilon,
    });
}
