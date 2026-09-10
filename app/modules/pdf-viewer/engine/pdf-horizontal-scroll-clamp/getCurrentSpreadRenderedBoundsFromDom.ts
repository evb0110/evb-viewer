import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type { IRenderedSpreadHorizontalBounds } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/pdfHorizontalScrollClampTypes';

export function getCurrentSpreadRenderedBoundsFromDom(options: {
    container: HTMLElement;
    pageNumber: TPageNumber;
    viewMode: 'single' | 'facing' | 'facing-first-single';
    totalPages: number;
}): IRenderedSpreadHorizontalBounds | null {
    if (options.totalPages <= 0) {
        return null;
    }
    const bounds = getPageRowBoundsForViewMode({
        pageNumber: options.pageNumber,
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    const containerRect = options.container.getBoundingClientRect();
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;

    for (
        let pageNumber = Number(bounds.start);
        pageNumber <= bounds.end;
        pageNumber += 1
    ) {
        const normalizedPageNumber = requirePageNumber(pageNumber, options.totalPages);
        const pageElement = options.container.querySelector<HTMLElement>(
            `.page_container[data-page="${normalizedPageNumber}"]`,
        );
        if (!pageElement) {
            return null;
        }
        // Buffered pages can retain the outgoing page's dimensions while the
        // active spread is being recomputed. Let the metric snapshot own the
        // bounds until every page in the row is current.
        if (pageElement.classList.contains('page_container--buffered')) {
            return null;
        }

        const pageRect = pageElement.getBoundingClientRect();
        const pageWidth = pageRect.width || pageElement.offsetWidth || pageElement.clientWidth;
        if (!Number.isFinite(pageWidth) || pageWidth <= 0) {
            return null;
        }

        const pageLeft = Number.isFinite(pageRect.left)
            ? pageRect.left - containerRect.left + options.container.scrollLeft
            : pageElement.offsetLeft;
        if (!Number.isFinite(pageLeft)) {
            return null;
        }

        left = Math.min(left, pageLeft);
        right = Math.max(right, pageLeft + pageWidth);
    }

    const width = right - left;
    return Number.isFinite(width) && width > 0
        ? {
            left: Math.max(0, left),
            width,
        }
        : null;
}
