import { range } from 'es-toolkit/math';
import type {
    IPageMoveRangeSegment,
    IPageMoveRanges,
} from '@pdf-core/pdfPageSelection';
import {
    createPageMoveRange,
    createPageMoveRanges,
    pageMoveRangesRestInsertIndex,
    pageMoveRangesSelectedPageCount,
} from '@pdf-core/pdfPageSelection';
import {stringifyJson} from '@contracts/stringifyJson';

export type {
    IPageMoveRangeSegment, IPageMoveRanges,
} from '@pdf-core/pdfPageSelection';

export function validatePageDeleteRanges(
    ranges: unknown,
    totalPages: unknown,
): asserts ranges is IPageMoveRangeSegment[] {
    if (
        typeof totalPages !== 'number'
        || !Number.isSafeInteger(totalPages)
        || totalPages < 1
    ) {
        throw new Error('deletePageRanges: totalPages must be a positive safe integer');
    }
    if (!Array.isArray(ranges) || ranges.length === 0) {
        throw new Error('deletePageRanges: ranges must be a non-empty array');
    }
    let previousEnd = 0;
    for (const range of ranges) {
        if (
            !range
            || typeof range !== 'object'
            || typeof (range as {startPage?: unknown}).startPage !== 'number'
            || !Number.isSafeInteger((range as {startPage: number}).startPage)
            || typeof (range as {endPage?: unknown}).endPage !== 'number'
            || !Number.isSafeInteger((range as {endPage: number}).endPage)
        ) {
            throw new Error('deletePageRanges: ranges must contain page numbers');
        }
        const {
            startPage,
            endPage,
        } = range as IPageMoveRangeSegment;
        if (
            startPage < 1
            || endPage < startPage
            || endPage > totalPages
            || startPage <= previousEnd
        ) {
            throw new Error('deletePageRanges: ranges must be sorted, disjoint, and within the document');
        }
        previousEnd = endPage;
    }
}

export function validatePageMoveRanges(
    ranges: unknown,
    insertAt: unknown,
    totalPages: unknown,
): asserts ranges is IPageMoveRangeSegment[] {
    if (
        typeof totalPages !== 'number'
        || !Number.isSafeInteger(totalPages)
        || totalPages < 1
    ) {
        throw new Error('movePageRanges: totalPages must be a positive safe integer');
    }
    if (!Array.isArray(ranges)) {
        throw new Error('movePageRanges: ranges must be an array');
    }
    if (typeof insertAt !== 'number' || !Number.isSafeInteger(insertAt)) {
        throw new Error('movePageRanges: insertAt must be a safe integer');
    }
    createPageMoveRanges(totalPages, ranges, insertAt);
}

export function formatPageRange(pages: number[]) {
    const sorted = [...pages].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
        const start = sorted[i]!;
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
            end = sorted[++i]!;
        }
        parts.push(start === end ? `${start}` : `${start}-${end}`);
        i++;
    }
    return `p${parts.join(',')}`;
}

function isValidPageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPageWithinTotalPages(page: number, totalPages: unknown) {
    return (
        typeof totalPages !== 'number'
        || !Number.isInteger(totalPages)
        || totalPages <= 0
        || page <= totalPages
    );
}

export function validatePageNumbers(
    pages: unknown,
    label: string,
    options: {
        totalPages?: number;
        requireUnique?: boolean;
    } = {},
): asserts pages is number[] {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`${label}: must be a non-empty array of page numbers`);
    }

    const pageSet = new Set<number>();
    const pageCandidates: unknown[] = pages;
    for (const p of pageCandidates) {
        if (!isValidPageNumber(p)) {
            throw new Error(`${label}: invalid page number ${stringifyJson(p) ?? '<invalid>'}`);
        }
        if (!isPageWithinTotalPages(p, options.totalPages)) {
            throw new Error(`${label}: page number ${p} is out of range 1-${options.totalPages ?? '<unknown>'}`);
        }
        if (options.requireUnique && pageSet.has(p)) {
            throw new Error(`${label}: duplicate page number ${p}`);
        }
        pageSet.add(p);
    }
}

export function validateReorderPermutation(newOrder: number[], totalPages = newOrder.length) {
    if (newOrder.length !== totalPages) {
        throw new Error(`reorderPages: expected ${totalPages} page(s), received ${newOrder.length}`);
    }

    const pageSet = new Set(newOrder);
    for (const pageNumber of range(1, totalPages + 1)) {
        if (!pageSet.has(pageNumber)) {
            throw new Error(`reorderPages: missing page ${pageNumber} in reorder payload`);
        }
    }
}

export function validatePageMoveRange(
    startPage: unknown,
    endPage: unknown,
    insertAt: unknown,
    totalPages: unknown,
): asserts startPage is number {
    if (
        typeof totalPages !== 'number'
        || !Number.isSafeInteger(totalPages)
        || totalPages < 1
    ) {
        throw new Error('movePages: totalPages must be a positive safe integer');
    }
    if (
        typeof startPage !== 'number'
        || typeof endPage !== 'number'
        || typeof insertAt !== 'number'
    ) {
        throw new Error('movePages: startPage, endPage, and insertAt must be safe integers');
    }
    createPageMoveRange(totalPages, startPage, endPage, insertAt);
}

function appendPageRange(parts: string[], startPage: number, endPage: number) {
    if (startPage > endPage) {
        return;
    }
    parts.push(startPage === endPage ? String(startPage) : `${startPage}-${endPage}`);
}

/**
 * Encodes the order after a move of sorted runs as comma-separated page runs.
 * Only the selected runs and the unselected gaps are represented, so the
 * list stays proportional to the number of source runs.
 */
export function formatPageMoveRanges(move: IPageMoveRanges) {
    const parts: string[] = [];
    const restInsertIndex = pageMoveRangesRestInsertIndex(move);
    const selectedCount = pageMoveRangesSelectedPageCount(move);
    const appendSelectedRanges = () => {
        for (const segment of move.ranges) {
            appendPageRange(parts, segment.startPage, segment.endPage);
        }
    };
    let nextSourcePage = 1;
    let restIndex = 0;
    let inserted = false as boolean;

    const appendRestRange = (startPage: number, endPage: number) => {
        if (startPage > endPage) {
            return;
        }
        const rangeCount = endPage - startPage + 1;
        if (!inserted && restInsertIndex <= restIndex + rangeCount) {
            const beforeCount = restInsertIndex - restIndex;
            appendPageRange(parts, startPage, startPage + beforeCount - 1);
            appendSelectedRanges();
            appendPageRange(parts, startPage + beforeCount, endPage);
            inserted = true;
        } else {
            appendPageRange(parts, startPage, endPage);
        }
        restIndex += rangeCount;
    };

    for (const segment of move.ranges) {
        appendRestRange(nextSourcePage, segment.startPage - 1);
        nextSourcePage = segment.endPage + 1;
    }
    appendRestRange(nextSourcePage, move.pageCount);
    if (!inserted) {
        appendSelectedRanges();
    }

    // A valid move always has at least one selected page. Keep the check
    // explicit so a malformed future representation cannot emit an empty
    // page list.
    return selectedCount > 0 ? parts.join(',') : '';
}
