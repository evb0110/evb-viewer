import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { TPdfViewMode } from '@app/types/pdfContracts';
import { clamp } from 'es-toolkit/math';

function clampPageNumber(pageNumber: TPageNumber, totalPages: number) {
    return requirePageNumber(clamp(Math.floor(pageNumber), 1, totalPages), totalPages);
}

function resolveSinglePageRowBounds(pageNumber: TPageNumber) {
    return {
        start: pageNumber,
        end: pageNumber,
    };
}

function resolveFacingRowBounds(pageNumber: TPageNumber, totalPages: number) {
    const rowStart = requirePageNumber(pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber, totalPages);
    const rowEnd = rowStart === totalPages
        ? rowStart
        : requirePageNumber(Math.min(totalPages, rowStart + 1), totalPages);
    return {
        start: rowStart,
        end: rowEnd,
    };
}

function resolveFacingFirstSingleRowBounds(pageNumber: TPageNumber, totalPages: number) {
    if (pageNumber === 1 || (pageNumber === totalPages && totalPages % 2 === 0)) {
        return resolveSinglePageRowBounds(pageNumber);
    }

    const rowStart = requirePageNumber(pageNumber % 2 === 0 ? pageNumber : pageNumber - 1, totalPages);
    return {
        start: rowStart,
        end: requirePageNumber(Math.min(totalPages, rowStart + 1), totalPages),
    };
}

function resolveSpreadRowBounds(
    pageNumber: TPageNumber,
    viewMode: TPdfViewMode,
    totalPages: number,
) {
    const clampedPageNumber = clampPageNumber(pageNumber, totalPages);
    if (viewMode === 'single' || totalPages <= 1) {
        return resolveSinglePageRowBounds(clampedPageNumber);
    }

    return viewMode === 'facing'
        ? resolveFacingRowBounds(clampedPageNumber, totalPages)
        : resolveFacingFirstSingleRowBounds(clampedPageNumber, totalPages);
}

export function getPageRowBoundsForViewMode(options: {
    pageNumber: TPageNumber;
    viewMode: TPdfViewMode;
    totalPages: number;
}) {
    return resolveSpreadRowBounds(options.pageNumber, options.viewMode, options.totalPages);
}

export function getPageNumbersForViewMode(options: {
    pageNumber: TPageNumber;
    viewMode: TPdfViewMode;
    totalPages: number;
}) {
    const bounds = getPageRowBoundsForViewMode(options);
    return Array.from(
        {length: Math.max(0, bounds.end - bounds.start + 1)},
        (_, index) => requirePageNumber(bounds.start + index, options.totalPages),
    );
}
