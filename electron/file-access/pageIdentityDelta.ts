import {randomUUID} from 'node:crypto';
import type {
    IPageIdentityDelta,
    IPageIdentityRangeInsert,
    IPageIdentityRangeMapping,
    IPageIdentityRangeTouch,
    TPageIdentityDeltaPage,
    TPageIdentityRangeOperation,
} from '@contracts/electronApiPageOps';
import type {
    IPageMoveRangeSegment,
    IPageMoveRanges,
} from '@contracts/pageNumbers';

const PAGE_IDENTITY_INLINE_PAGE_COUNT = 4_096;
const PAGE_IDENTITY_MAX_RANGE_OPERATIONS = 100_000;

type TMutablePageIdentityRangeOperation = TPageIdentityRangeOperation extends infer TOperation
    ? TOperation extends object
        ? {-readonly [TKey in keyof TOperation]: TOperation[TKey]}
        : never
    : never;

function assertPageCount(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
}

function assertPositivePageNumber(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
}

function assertRangeCount(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
}

function createLegacyOrRangeDelta(
    previousPageCount: number,
    pages: TPageIdentityDeltaPage[],
    ranges: TPageIdentityRangeOperation[],
    nextPageCount: number,
): IPageIdentityDelta {
    if (previousPageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT && nextPageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        return {
            previousPageCount,
            pages,
        };
    }
    if (ranges.length > PAGE_IDENTITY_MAX_RANGE_OPERATIONS) {
        throw new Error('Page identity delta contains too many range operations');
    }
    return {
        previousPageCount,
        nextPageCount,
        ranges,
    };
}

function appendMapping(
    ranges: TMutablePageIdentityRangeOperation[],
    fromPageNumber: number,
    toPageNumber: number,
    count: number,
) {
    if (count <= 0) {
        return;
    }
    const kind: IPageIdentityRangeMapping['kind'] = fromPageNumber === toPageNumber ? 'retain' : 'move';
    const previous = ranges.at(-1);
    if (
        previous
        && (previous.kind === 'retain' || previous.kind === 'move')
        && previous.kind === kind
        && previous.fromPageNumber + previous.count === fromPageNumber
        && previous.toPageNumber + previous.count === toPageNumber
    ) {
        previous.count += count;
        return;
    }
    ranges.push({
        kind,
        fromPageNumber,
        toPageNumber,
        count,
    });
}

function appendDelete(
    ranges: TMutablePageIdentityRangeOperation[],
    fromPageNumber: number,
    count: number,
) {
    if (count <= 0) {
        return;
    }
    ranges.push({
        kind: 'delete',
        fromPageNumber,
        count,
    });
}

function appendTouch(
    ranges: TMutablePageIdentityRangeOperation[],
    toPageNumber: number,
    count: number,
    reason: IPageIdentityRangeTouch['reason'],
) {
    if (count <= 0) {
        return;
    }
    ranges.push({
        kind: 'touch',
        toPageNumber,
        count,
        reason,
    });
}

function sortedUniquePages(pageNumbers: readonly number[], pageCount: number) {
    const pages = [...new Set(pageNumbers)];
    pages.sort((left, right) => left - right);
    if (pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
        throw new Error('Page identity delta contains an out-of-range page');
    }
    return pages;
}

function createLargeIdentityDelta(
    pageCount: number,
    touchedPages: readonly number[] = [],
    reason?: IPageIdentityRangeTouch['reason'],
) {
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    const touched = reason === undefined ? [] : sortedUniquePages(touchedPages, pageCount);
    let oldPage = 1;
    let newPage = 1;
    for (let index = 0; index < touched.length;) {
        const touchedStart = touched[index]!;
        if (oldPage < touchedStart) {
            const count = touchedStart - oldPage;
            appendMapping(ranges, oldPage, newPage, count);
            oldPage += count;
            newPage += count;
        }
        let touchedEnd = touchedStart;
        while (index + 1 < touched.length && touched[index + 1] === touchedEnd + 1) {
            index += 1;
            touchedEnd = touched[index]!;
        }
        const count = touchedEnd - touchedStart + 1;
        appendMapping(ranges, touchedStart, newPage, count);
        appendTouch(ranges, newPage, count, reason!);
        oldPage = touchedEnd + 1;
        newPage += count;
        index += 1;
    }
    if (oldPage <= pageCount) {
        appendMapping(ranges, oldPage, newPage, pageCount - oldPage + 1);
    }
    return {
        previousPageCount: pageCount,
        nextPageCount: pageCount,
        ranges,
    } satisfies IPageIdentityDelta;
}

export function createIdentityDelta(pageCount: number): IPageIdentityDelta {
    assertPageCount(pageCount, 'pageCount');
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        return {
            previousPageCount: pageCount,
            pages: Array.from({length: pageCount}, (_value, index) => ({fromPageNumber: index + 1})),
        };
    }
    return createLargeIdentityDelta(pageCount);
}

function createPageTouchIdentityDelta(
    pageCount: number,
    pages: readonly number[],
    reason: IPageIdentityRangeTouch['reason'],
) {
    assertPageCount(pageCount, 'pageCount');
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        return createIdentityDelta(pageCount);
    }
    return createLargeIdentityDelta(pageCount, pages, reason);
}

function createPageRangeTouchIdentityDelta(
    pageCount: number,
    pageRanges: readonly IPageMoveRangeSegment[],
    reason: IPageIdentityRangeTouch['reason'],
) {
    assertPageCount(pageCount, 'pageCount');
    let previousEnd = 0;
    let selectedPageCount = 0;
    for (const range of pageRanges) {
        assertPositivePageNumber(range.startPage, 'startPage');
        assertPositivePageNumber(range.endPage, 'endPage');
        if (
            range.startPage <= previousEnd
            || range.endPage < range.startPage
            || range.endPage > pageCount
        ) {
            throw new Error('Page touch ranges must be sorted, disjoint, and within the document');
        }
        selectedPageCount += range.endPage - range.startPage + 1;
        previousEnd = range.endPage;
    }
    if (selectedPageCount === 0) {
        throw new Error('Page touch ranges must select at least one page');
    }
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        const pages = pageRanges.flatMap(range => Array.from(
            {length: range.endPage - range.startPage + 1},
            (_value, index) => range.startPage + index,
        ));
        return createPageTouchIdentityDelta(pageCount, pages, reason);
    }
    if (pageRanges.length + 1 > PAGE_IDENTITY_MAX_RANGE_OPERATIONS) {
        throw new Error('Page touch ranges exceed the identity operation limit');
    }
    return {
        previousPageCount: pageCount,
        nextPageCount: pageCount,
        ranges: [
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: pageCount,
            },
            ...pageRanges.map(range => ({
                kind: 'touch' as const,
                toPageNumber: range.startPage,
                count: range.endPage - range.startPage + 1,
                reason,
            })),
        ],
    } satisfies IPageIdentityDelta;
}

export const createRotateIdentityDelta = (
    pageCount: number,
    pages: readonly number[],
) => createPageTouchIdentityDelta(pageCount, pages, 'rotate');

export const createCropIdentityDelta = (
    pageCount: number,
    pages: readonly number[],
) => createPageTouchIdentityDelta(pageCount, pages, 'crop');

export const createRemoveCropIdentityDelta = (
    pageCount: number,
    pages: readonly number[],
) => createPageTouchIdentityDelta(pageCount, pages, 'remove-crop');

export const createRotateRangesIdentityDelta = (
    pageCount: number,
    ranges: readonly IPageMoveRangeSegment[],
) => createPageRangeTouchIdentityDelta(pageCount, ranges, 'rotate');

export const createCropRangesIdentityDelta = (
    pageCount: number,
    ranges: readonly IPageMoveRangeSegment[],
) => createPageRangeTouchIdentityDelta(pageCount, ranges, 'crop');

export const createRemoveCropRangesIdentityDelta = (
    pageCount: number,
    ranges: readonly IPageMoveRangeSegment[],
) => createPageRangeTouchIdentityDelta(pageCount, ranges, 'remove-crop');

export function createDeleteIdentityDelta(pageCount: number, deletedPages: readonly number[]): IPageIdentityDelta {
    assertPageCount(pageCount, 'pageCount');
    const deleted = sortedUniquePages(deletedPages, pageCount);
    const nextPageCount = pageCount - deleted.length;
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT && nextPageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        const deletedSet = new Set(deleted);
        return {
            previousPageCount: pageCount,
            pages: Array.from({length: pageCount}, (_value, index) => index + 1)
                .filter(pageNumber => !deletedSet.has(pageNumber))
                .map(fromPageNumber => ({fromPageNumber})),
        };
    }
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    let oldPage = 1;
    let newPage = 1;
    for (let index = 0; index < deleted.length;) {
        const deletedStart = deleted[index]!;
        if (oldPage < deletedStart) {
            const count = deletedStart - oldPage;
            appendMapping(ranges, oldPage, newPage, count);
            oldPage += count;
            newPage += count;
        }
        let deletedEnd = deletedStart;
        while (index + 1 < deleted.length && deleted[index + 1] === deletedEnd + 1) {
            index += 1;
            deletedEnd = deleted[index]!;
        }
        appendDelete(ranges, deletedStart, deletedEnd - deletedStart + 1);
        oldPage = deletedEnd + 1;
        index += 1;
    }
    if (oldPage <= pageCount) appendMapping(ranges, oldPage, newPage, pageCount - oldPage + 1);
    return createLegacyOrRangeDelta(pageCount, [], ranges, nextPageCount);
}

export function createMoveIdentityDelta(
    pageCount: number,
    fromPageNumber: number,
    toPageNumber: number,
    count = 1,
): IPageIdentityDelta {
    assertPageCount(pageCount, 'pageCount');
    assertPositivePageNumber(fromPageNumber, 'fromPageNumber');
    assertPositivePageNumber(toPageNumber, 'toPageNumber');
    assertRangeCount(count, 'count');
    if (fromPageNumber + count - 1 > pageCount || toPageNumber > pageCount - count + 1) {
        throw new Error('Page identity move exceeds the document page count');
    }
    // `toPageNumber` is the first page in the final order, not the original
    // insertion slot. A forward move can therefore land inside the original
    // source interval after the intervening pages shift left. Only the exact
    // source start leaves the order unchanged.
    if (toPageNumber === fromPageNumber) {
        return createIdentityDelta(pageCount);
    }
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    if (toPageNumber < fromPageNumber) {
        appendMapping(ranges, 1, 1, toPageNumber - 1);
        appendMapping(ranges, fromPageNumber, toPageNumber, count);
        appendMapping(ranges, toPageNumber, toPageNumber + count, fromPageNumber - toPageNumber);
        appendMapping(ranges, fromPageNumber + count, fromPageNumber + count, pageCount - (fromPageNumber + count) + 1);
    } else {
        appendMapping(ranges, 1, 1, fromPageNumber - 1);
        appendMapping(ranges, fromPageNumber + count, fromPageNumber, toPageNumber - fromPageNumber);
        appendMapping(ranges, fromPageNumber, toPageNumber, count);
        appendMapping(ranges, toPageNumber + count, toPageNumber + count, pageCount - (toPageNumber + count) + 1);
    }
    const pages = pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT
        ? ranges.flatMap(range => (range.kind === 'retain' || range.kind === 'move'
            ? Array.from({length: range.count}, (_value, index) => ({fromPageNumber: range.fromPageNumber + index}))
            : []))
        : [];
    return createLegacyOrRangeDelta(pageCount, pages, ranges, pageCount);
}

/**
 * Creates a complete identity mapping for moving sorted, non-contiguous
 * source runs as one block. The insertion slot uses the original zero-based
 * page order, while each output mapping uses its final one-based destination.
 */
export function createPageMoveRangesIdentityDelta(
    move: IPageMoveRanges,
): IPageIdentityDelta {
    const {
        pageCount,
        ranges: sourceRanges,
        insertAt,
    } = move;
    assertPageCount(pageCount, 'pageCount');
    if (!Number.isSafeInteger(insertAt) || insertAt < 0 || insertAt > pageCount) {
        throw new Error(`Page move insertAt must be a safe integer in 0-${pageCount}`);
    }
    if (sourceRanges.length === 0) {
        return createIdentityDelta(pageCount);
    }
    if (sourceRanges.length > PAGE_IDENTITY_MAX_RANGE_OPERATIONS) {
        throw new Error('Page move ranges exceed the item limit');
    }

    let previousEnd = 0;
    let selectedCount = 0;
    let selectedThroughInsert = 0;
    for (const sourceRange of sourceRanges) {
        const {
            startPage,
            endPage,
        } = sourceRange;
        if (
            !Number.isSafeInteger(startPage)
            || !Number.isSafeInteger(endPage)
            || startPage < 1
            || endPage < startPage
            || endPage > pageCount
            || startPage <= previousEnd
        ) {
            throw new Error('Page move ranges must be sorted, disjoint, and within the document');
        }
        const count = endPage - startPage + 1;
        selectedCount += count;
        if (startPage <= insertAt) {
            selectedThroughInsert += Math.min(endPage, insertAt) - startPage + 1;
        }
        previousEnd = endPage;
    }
    const restInsertIndex = insertAt - selectedThroughInsert;
    const before: Array<{
        fromPageNumber: number;
        count: number
    }> = [];
    const after: Array<{
        fromPageNumber: number;
        count: number
    }> = [];
    const appendGap = (startPage: number, endPage: number) => {
        if (startPage > endPage) {
            return;
        }
        const beforeEnd = Math.min(endPage, insertAt);
        if (startPage <= beforeEnd) {
            before.push({
                fromPageNumber: startPage,
                count: beforeEnd - startPage + 1,
            });
        }
        const afterStart = Math.max(startPage, insertAt + 1);
        if (afterStart <= endPage) {
            after.push({
                fromPageNumber: afterStart,
                count: endPage - afterStart + 1,
            });
        }
    };
    let nextSourcePage = 1;
    for (const sourceRange of sourceRanges) {
        appendGap(nextSourcePage, sourceRange.startPage - 1);
        nextSourcePage = sourceRange.endPage + 1;
    }
    appendGap(nextSourcePage, pageCount);
    if (restInsertIndex !== before.reduce((sum, range) => sum + range.count, 0)) {
        throw new Error('Page move ranges produced an invalid insertion slot');
    }

    const outputRanges: TMutablePageIdentityRangeOperation[] = [];
    let destinationPage = 1;
    for (const sourceRange of before) {
        appendMapping(outputRanges, sourceRange.fromPageNumber, destinationPage, sourceRange.count);
        destinationPage += sourceRange.count;
    }
    for (const sourceRange of sourceRanges) {
        appendMapping(
            outputRanges,
            sourceRange.startPage,
            destinationPage,
            sourceRange.endPage - sourceRange.startPage + 1,
        );
        destinationPage += sourceRange.endPage - sourceRange.startPage + 1;
    }
    for (const sourceRange of after) {
        appendMapping(outputRanges, sourceRange.fromPageNumber, destinationPage, sourceRange.count);
        destinationPage += sourceRange.count;
    }
    if (destinationPage !== pageCount + 1 || selectedCount > pageCount) {
        throw new Error('Page move ranges do not cover the document');
    }
    const pages = pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT
        ? outputRanges.flatMap(range => (range.kind === 'retain' || range.kind === 'move'
            ? Array.from({length: range.count}, (_value, index) => ({fromPageNumber: range.fromPageNumber + index}))
            : []))
        : [];
    return createLegacyOrRangeDelta(pageCount, pages, outputRanges, pageCount);
}

export function createDeleteRangeIdentityDelta(pageCount: number, fromPageNumber: number, count: number) {
    assertPageCount(pageCount, 'pageCount');
    assertPositivePageNumber(fromPageNumber, 'fromPageNumber');
    assertRangeCount(count, 'count');
    if (fromPageNumber + count - 1 > pageCount) {
        throw new Error('Page identity delete range exceeds the document page count');
    }
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        return createDeleteIdentityDelta(
            pageCount,
            Array.from({length: count}, (_value, index) => fromPageNumber + index),
        );
    }
    const nextPageCount = pageCount - count;
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    appendMapping(ranges, 1, 1, fromPageNumber - 1);
    appendDelete(ranges, fromPageNumber, count);
    appendMapping(
        ranges,
        fromPageNumber + count,
        fromPageNumber,
        pageCount - (fromPageNumber + count) + 1,
    );
    return createLegacyOrRangeDelta(pageCount, [], ranges, nextPageCount);
}

/**
 * Creates a sparse identity mapping for deleting sorted, disjoint page runs.
 * The ranges are kept as the only page-sized input, so deleting all but one
 * page from a very large document does not allocate a page-number array.
 */
export function createDeleteRangesIdentityDelta(
    pageCount: number,
    deletedRanges: readonly IPageMoveRangeSegment[],
) {
    assertPageCount(pageCount, 'pageCount');
    if (deletedRanges.length === 0) {
        return createIdentityDelta(pageCount);
    }

    let previousEnd = 0;
    let deletedCount = 0;
    for (const deletedRange of deletedRanges) {
        const {
            startPage,
            endPage,
        } = deletedRange;
        if (
            !Number.isSafeInteger(startPage)
            || !Number.isSafeInteger(endPage)
            || startPage < 1
            || endPage < startPage
            || endPage > pageCount
            || startPage <= previousEnd
        ) {
            throw new Error('Page identity delete ranges must be sorted, disjoint, and within the document');
        }
        deletedCount += endPage - startPage + 1;
        previousEnd = endPage;
    }

    const nextPageCount = pageCount - deletedCount;
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        const deletedPages: number[] = [];
        for (const deletedRange of deletedRanges) {
            for (let page = deletedRange.startPage; page <= deletedRange.endPage; page += 1) {
                deletedPages.push(page);
            }
        }
        return createDeleteIdentityDelta(pageCount, deletedPages);
    }

    const ranges: TMutablePageIdentityRangeOperation[] = [];
    let oldPage = 1;
    let newPage = 1;
    for (const deletedRange of deletedRanges) {
        if (oldPage < deletedRange.startPage) {
            const count = deletedRange.startPage - oldPage;
            appendMapping(ranges, oldPage, newPage, count);
            oldPage += count;
            newPage += count;
        }
        const count = deletedRange.endPage - deletedRange.startPage + 1;
        appendDelete(ranges, deletedRange.startPage, count);
        oldPage = deletedRange.endPage + 1;
    }
    if (oldPage <= pageCount) {
        appendMapping(ranges, oldPage, newPage, pageCount - oldPage + 1);
    }
    return createLegacyOrRangeDelta(pageCount, [], ranges, nextPageCount);
}

export function createReorderIdentityDelta(pageCount: number, order: readonly number[]): IPageIdentityDelta {
    assertPageCount(pageCount, 'pageCount');
    if (order.length !== pageCount) {
        throw new Error(`Page identity reorder expected ${pageCount} pages, received ${order.length}`);
    }
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        return {
            previousPageCount: pageCount,
            pages: order.map(fromPageNumber => ({fromPageNumber})),
        };
    }
    const seen = new Set<number>();
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    let outputPage = 1;
    for (let index = 0; index < order.length;) {
        const fromPageNumber = order[index]!;
        if (seen.has(fromPageNumber) || fromPageNumber < 1 || fromPageNumber > pageCount) {
            throw new Error('Page identity reorder is not a permutation');
        }
        seen.add(fromPageNumber);
        let count = 1;
        while (index + count < order.length && order[index + count] === fromPageNumber + count) {
            const next = order[index + count]!;
            if (seen.has(next) || next < 1 || next > pageCount) {
                throw new Error('Page identity reorder is not a permutation');
            }
            seen.add(next);
            count += 1;
        }
        appendMapping(ranges, fromPageNumber, outputPage, count);
        index += count;
        outputPage += count;
    }
    if (seen.size !== pageCount) throw new Error('Page identity reorder is not a permutation');
    return createLegacyOrRangeDelta(pageCount, [], ranges, pageCount);
}

export function createInsertIdentityDelta(pageCount: number, afterPage: number, insertedPageCount: number): IPageIdentityDelta {
    assertPageCount(pageCount, 'pageCount');
    if (!Number.isSafeInteger(afterPage) || afterPage < 0 || afterPage > pageCount) {
        throw new Error('afterPage must be between zero and the page count');
    }
    if (!Number.isSafeInteger(insertedPageCount) || insertedPageCount < 0) {
        throw new Error('insertedPageCount must be a non-negative safe integer');
    }
    if (insertedPageCount === 0) {
        return createIdentityDelta(pageCount);
    }
    if (insertedPageCount > Number.MAX_SAFE_INTEGER - pageCount) {
        throw new Error('insertedPageCount would exceed the safe page count');
    }
    const nextPageCount = pageCount + insertedPageCount;
    if (pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT && nextPageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        const before = Array.from({length: afterPage}, (_value, index) => ({fromPageNumber: index + 1}));
        const inserted = Array.from({length: insertedPageCount}, () => ({insertedId: randomUUID()}));
        const after = Array.from({length: pageCount - afterPage}, (_value, index) => ({fromPageNumber: afterPage + index + 1}));
        return {
            previousPageCount: pageCount,
            pages: [
                ...before,
                ...inserted,
                ...after,
            ],
        };
    }
    const identitySeed = randomUUID();
    const ranges: TMutablePageIdentityRangeOperation[] = [];
    appendMapping(ranges, 1, 1, afterPage);
    const insert: IPageIdentityRangeInsert = {
        kind: 'insert',
        toPageNumber: afterPage + 1,
        count: insertedPageCount,
        identitySeed,
        ...(insertedPageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT
            ? {insertedIds: Array.from({length: insertedPageCount}, () => randomUUID())}
            : {}),
    };
    ranges.push(insert);
    appendMapping(ranges, afterPage + 1, afterPage + insertedPageCount + 1, pageCount - afterPage);
    return createLegacyOrRangeDelta(pageCount, [], ranges, nextPageCount);
}

/** Returns a sparse range mapping for the OCR v4 catalog remapper. */
