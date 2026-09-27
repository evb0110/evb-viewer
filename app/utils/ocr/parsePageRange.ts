import { range } from 'es-toolkit/math';
import type { TOcrPageRange } from '@app/utils/ocr/ocrTypes';

/** Keep renderer-side page lists small. Larger contiguous scopes stay scalar. */
export const OCR_PAGE_SELECTION_EXPANSION_LIMIT = 5_000;

interface IOcrPageScopeRange {
    firstPage: number;
    lastPage: number;
}

export type TOcrPageSelectionScope =
    | number[]
    | {
        kind: 'all';
        pageCount: number;
    }
    | {
        kind: 'range';
        firstPage: number;
        lastPage: number;
    }
    | {
        kind: 'ranges';
        ranges: IOcrPageScopeRange[];
    };

function mergePageRanges(ranges: IOcrPageScopeRange[]) {
    const ordered = [...ranges].sort((left, right) =>
        left.firstPage - right.firstPage || left.lastPage - right.lastPage);
    const merged: IOcrPageScopeRange[] = [];
    for (const current of ordered) {
        const previous = merged.at(-1);
        if (previous && current.firstPage <= previous.lastPage + 1) {
            previous.lastPage = Math.max(previous.lastPage, current.lastPage);
        } else {
            merged.push({...current});
        }
    }
    return merged;
}

function getScopePageCount(scope: TOcrPageSelectionScope) {
    if (Array.isArray(scope)) {
        return scope.length;
    }
    if (scope.kind === 'all') {
        return scope.pageCount;
    }
    if (scope.kind === 'range') {
        return scope.lastPage - scope.firstPage + 1;
    }
    return scope.ranges.reduce(
        (count, pageRange) => count + pageRange.lastPage - pageRange.firstPage + 1,
        0,
    );
}

/**
 * Resolve the UI page scope without expanding a large all-page or contiguous
 * range request. Arrays remain the compatibility representation for current
 * and sparse selections.
 */
export function parseOcrPageSelection(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): TOcrPageSelectionScope {
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
        return [];
    }
    if (rangeType === 'current') {
        return currentPage >= 1 && currentPage <= totalPages ? [currentPage] : [];
    }
    if (rangeType === 'all') {
        return {
            kind: 'all',
            pageCount: totalPages,
        };
    }

    const ranges: IOcrPageScopeRange[] = [];
    const parts = customRange.split(',').map(part => part.trim());
    const singlePagePattern = /^\d+$/u;
    const pageRangePattern = /^(\d+)\s*-\s*(\d+)$/u;
    for (const part of parts) {
        const rangeMatch = pageRangePattern.exec(part);
        if (rangeMatch) {
            const start = Number(rangeMatch[1]);
            const end = Number(rangeMatch[2]);
            if (start <= end) {
                const firstPage = Math.max(1, start);
                const lastPage = Math.min(totalPages, end);
                if (firstPage <= lastPage) {
                    ranges.push({
                        firstPage,
                        lastPage,
                    });
                }
            }
            continue;
        }
        if (singlePagePattern.test(part)) {
            const pageNumber = Number(part);
            if (pageNumber >= 1 && pageNumber <= totalPages) {
                ranges.push({
                    firstPage: pageNumber,
                    lastPage: pageNumber,
                });
            }
        }
    }

    const mergedRanges = mergePageRanges(ranges);
    if (mergedRanges.length === 0) {
        return [];
    }
    const pageCount = mergedRanges.reduce(
        (count, pageRange) => count + pageRange.lastPage - pageRange.firstPage + 1,
        0,
    );
    if (pageCount > OCR_PAGE_SELECTION_EXPANSION_LIMIT) {
        if (mergedRanges.length === 1) {
            const [pageRange] = mergedRanges;
            if (pageRange) {
                return {
                    kind: 'range',
                    ...pageRange,
                };
            }
        }
        return {
            kind: 'ranges',
            ranges: mergedRanges,
        };
    }

    return mergedRanges.flatMap(pageRange =>
        range(pageRange.firstPage, pageRange.lastPage + 1));
}

export function parsePageRange(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): number[] {
    const selection = parseOcrPageSelection(
        rangeType,
        customRange,
        currentPage,
        totalPages,
    );
    if (Array.isArray(selection)) {
        return selection;
    }
    if (selection.kind === 'all') {
        return selection.pageCount <= OCR_PAGE_SELECTION_EXPANSION_LIMIT
            ? range(1, selection.pageCount + 1)
            : [];
    }
    if (selection.kind === 'range') {
        return selection.lastPage - selection.firstPage + 1 <= OCR_PAGE_SELECTION_EXPANSION_LIMIT
            ? range(selection.firstPage, selection.lastPage + 1)
            : [];
    }
    return getScopePageCount(selection) <= OCR_PAGE_SELECTION_EXPANSION_LIMIT
        ? selection.ranges.flatMap(pageRange => range(pageRange.firstPage, pageRange.lastPage + 1))
        : [];
}
