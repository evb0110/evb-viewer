import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type {TPdfViewMode} from '@contracts/shared';
import type {IPageRange} from '@app/types/pdfUi';
import {getPageRowBoundsForViewMode} from '@app/modules/document-viewer/public';

function isFinitePageRange(range: IPageRange) {
    return Number.isFinite(range.start)
        && Number.isFinite(range.end)
        && range.start <= range.end;
}

function pageRangeContainsPage(range: IPageRange, pageNumber: TPageNumber) {
    return isFinitePageRange(range)
        && pageNumber >= range.start
        && pageNumber <= range.end;
}

function pageRangesIntersect(left: IPageRange, right: IPageRange) {
    return isFinitePageRange(left)
        && isFinitePageRange(right)
        && left.start <= right.end
        && right.start <= left.end;
}

function expandRangeToCompleteRows(options: IResolvePdfProtectedVisibleRangeOptions) {
    if (!isFinitePageRange(options.visibleRange) || options.totalPages <= 0) {
        return options.visibleRange;
    }
    const firstRow = getPageRowBoundsForViewMode({
        pageNumber: requirePageNumber(options.visibleRange.start, options.totalPages),
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    const lastRow = getPageRowBoundsForViewMode({
        pageNumber: requirePageNumber(options.visibleRange.end, options.totalPages),
        viewMode: options.viewMode,
        totalPages: options.totalPages,
    });
    return {
        start: firstRow.start,
        end: lastRow.end,
    };
}

interface IIsPdfVisibleRenderRangeCurrentOptions {
    range: IPageRange;
    visibleRange: IPageRange;
    navigationTargetPage: number | null;
    viewMode: TPdfViewMode;
    totalPages: number;
}

interface IResolvePdfProtectedVisibleRangeOptions {
    visibleRange: IPageRange;
    navigationTargetPage: number | null;
    viewMode: TPdfViewMode;
    totalPages: number;
}

export function resolvePdfProtectedVisibleRange(
    options: IResolvePdfProtectedVisibleRangeOptions,
) {
    const visibleRows = expandRangeToCompleteRows(options);
    if (options.navigationTargetPage !== null && options.totalPages > 0) {
        const targetRow = getPageRowBoundsForViewMode({
            pageNumber: requirePageNumber(options.navigationTargetPage, options.totalPages),
            viewMode: options.viewMode,
            totalPages: options.totalPages,
        });
        // A disjoint committed range is stale while navigation owns the viewport.
        // Once measured geometry reaches the target row, however, every row that
        // intersects the viewport is authoritative raster demand too.
        return pageRangesIntersect(visibleRows, targetRow) ? {
            start: requirePageNumber(Math.min(visibleRows.start, targetRow.start), options.totalPages),
            end: requirePageNumber(Math.max(visibleRows.end, targetRow.end), options.totalPages),
        } : targetRow;
    }
    return visibleRows;
}

export function isPdfVisibleRenderRangeCurrent(
    options: IIsPdfVisibleRenderRangeCurrentOptions,
) {
    if (options.navigationTargetPage !== null && options.totalPages > 0) {
        const targetRowBounds = resolvePdfProtectedVisibleRange(options);
        return pageRangesIntersect(options.range, targetRowBounds)
            || pageRangeContainsPage(
                options.range,
                requirePageNumber(options.navigationTargetPage, options.totalPages),
            );
    }

    return pageRangesIntersect(options.range, resolvePdfProtectedVisibleRange(options));
}
