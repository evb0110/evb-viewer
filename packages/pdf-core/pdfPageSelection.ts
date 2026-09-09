import type {
    IPageMoveRange,
    IPageMoveRangeSegment,
    IPageMoveRanges,
    IMappedPageSelection,
    IPageSelectionBatchOptions,
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import {
    createAllPageSelection,
    createComplementOfPageSelection,
    createComplementPageSelection,
    createEmptyPageSelection,
    createExceptionPageSelection,
    createExplicitPageSelection,
} from '@contracts/pageNumbers';

function normalizeSelectionPage(page: number, pageCount: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
        throw new RangeError(`Page selection page ${page} is outside 1-${pageCount}`);
    }
    return page;
}

export type {
    IAllPageSelection,
    IComplementPageSelection,
    IEmptyPageSelection,
    IExceptionPageSelection,
    IExplicitPageSelection,
    IPageMoveRange,
    IPageMoveRangeSegment,
    IPageMoveRanges,
    IMappedPageSelection,
    IPredicatePageSelection,
    IRangePageSelection,
    IPageSelectionBatchOptions,
    TPageIndex,
    TPageMoveOperation,
    TPageNumber,
    TPageSelection,
    TPageSelectionPredicate,
} from '@contracts/pageNumbers';
export {
    clampPageNumber,
    createAllPageSelection,
    createComplementOfPageSelection,
    createComplementPageSelection,
    createEmptyPageSelection,
    createExceptionPageSelection,
    createExplicitPageSelection,
    createPageMoveRange,
    createPageMoveRanges,
    createPredicatePageSelection,
    createRangePageSelection,
    pageIndexToPageNumber,
    pageNumberToPageIndex,
    parsePageIndex,
    parsePageNumber,
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';

export function pageSelectionCount(selection: TPageSelection): number {
    switch (selection.kind) {
        case 'none':
            return 0;
        case 'all':
            return selection.pageCount;
        case 'explicit':
            return selection.pages.length;
        case 'range':
            return selection.endPage - selection.startPage + 1;
        case 'predicate': {
            const first = selection.predicate === 'odd' ? 1 : 2;
            if (first > selection.pageCount) {
                return 0;
            }
            return Math.floor((selection.pageCount - first) / 2) + 1;
        }
        case 'exceptions': {
            const included = selection.includedPages.filter(page => !isPageSelected(selection.base, page)).length;
            const excluded = selection.excludedPages.filter(page => isPageSelected(selection.base, page)).length;
            return pageSelectionCount(selection.base) + included - excluded;
        }
        case 'mapped':
            return pageSelectionCount(selection.source);
        case 'complement': {
            const excludedCount = selection.excludedPages !== undefined
                ? selection.excludedPages.length
                : selection.excludedSelection === undefined
                    ? 0
                    : pageSelectionCount(selection.excludedSelection);
            return selection.pageCount - excludedCount;
        }
    }
}

export function isPageSelected(selection: TPageSelection, page: number): boolean {
    if (!Number.isSafeInteger(page) || page < 1 || page > selection.pageCount) {
        return false;
    }
    switch (selection.kind) {
        case 'none':
            return false;
        case 'all':
            return true;
        case 'explicit':
            return selection.pages.includes(page);
        case 'range':
            return page >= selection.startPage && page <= selection.endPage;
        case 'predicate':
            return selection.predicate === 'even' ? page % 2 === 0 : page % 2 !== 0;
        case 'exceptions':
            if (selection.excludedPages.includes(page)) {
                return false;
            }
            if (selection.includedPages.includes(page)) {
                return true;
            }
            return isPageSelected(selection.base, page);
        case 'mapped': {
            let sourcePage: number | null = page;
            for (const move of selection.moves.toReversed()) {
                if (sourcePage === null) {
                    break;
                }
                sourcePage = mapPageNumberBeforePageMove(sourcePage, move);
            }
            return sourcePage !== null && isPageSelected(selection.source, sourcePage);
        }
        case 'complement':
            if (selection.excludedPages !== undefined) {
                return !selection.excludedPages.includes(page);
            }
            return selection.excludedSelection === undefined
                ? true
                : !isPageSelected(selection.excludedSelection, page);
    }
}

interface IPageMappingSegment {
    fromPageNumber: number;
    toPageNumber: number;
    count: number;
}

function appendPageMapping(
    mappings: IPageMappingSegment[],
    fromPageNumber: number,
    toPageNumber: number,
    count: number,
) {
    if (count <= 0) {
        return;
    }
    const previous = mappings.at(-1);
    if (
        previous
        && previous.fromPageNumber + previous.count === fromPageNumber
        && previous.toPageNumber + previous.count === toPageNumber
    ) {
        previous.count += count;
        return;
    }
    mappings.push({
        fromPageNumber,
        toPageNumber,
        count,
    });
}

/**
 * Builds destination-ordered source mappings for one move. The ranges stay
 * compact, so composing a move chain never needs a page-count-sized order.
 */
function createPageMoveMappings(move: TPageMoveOperation): IPageMappingSegment[] {
    const selectedRanges: IPageMoveRangeSegment[] = isPageMoveRanges(move)
        ? move.ranges
        : [{
            startPage: move.startPage,
            endPage: move.endPage,
        }];
    const selectedCount = selectedRanges.reduce(
        (count, segment) => count + segment.endPage - segment.startPage + 1,
        0,
    );
    const restInsertIndex = pageMoveRangesRestInsertIndex({
        pageCount: move.pageCount,
        ranges: selectedRanges,
        insertAt: move.insertAt,
    });
    const mappings: IPageMappingSegment[] = [];
    let nextSourcePage = 1;
    let restIndex = 0;
    let destinationPage = 1;
    let inserted = false as boolean;

    const appendSelected = () => {
        for (const segment of selectedRanges) {
            const count = segment.endPage - segment.startPage + 1;
            appendPageMapping(mappings, segment.startPage, destinationPage, count);
            destinationPage += count;
        }
    };

    const appendRestRange = (startPage: number, endPage: number) => {
        if (startPage > endPage) {
            return;
        }
        const rangeCount = endPage - startPage + 1;
        if (!inserted && restInsertIndex <= restIndex + rangeCount) {
            const beforeCount = restInsertIndex - restIndex;
            appendPageMapping(mappings, startPage, destinationPage, beforeCount);
            destinationPage += beforeCount;
            appendSelected();
            appendPageMapping(
                mappings,
                startPage + beforeCount,
                destinationPage,
                rangeCount - beforeCount,
            );
            destinationPage += rangeCount - beforeCount;
            inserted = true;
        } else {
            appendPageMapping(mappings, startPage, destinationPage, rangeCount);
            destinationPage += rangeCount;
        }
        restIndex += rangeCount;
    };

    for (const segment of selectedRanges) {
        appendRestRange(nextSourcePage, segment.startPage - 1);
        nextSourcePage = segment.endPage + 1;
    }
    appendRestRange(nextSourcePage, move.pageCount);
    if (!inserted) {
        appendSelected();
    }
    if (destinationPage !== move.pageCount + 1 || selectedCount <= 0) {
        throw new RangeError('Page move mappings must cover the document');
    }
    return mappings;
}

function composePageMoveMappings(
    currentMappings: readonly IPageMappingSegment[],
    nextMappings: readonly IPageMappingSegment[],
): IPageMappingSegment[] {
    const composed: IPageMappingSegment[] = [];
    for (const next of nextMappings) {
        const nextEnd = next.fromPageNumber + next.count - 1;
        for (const current of currentMappings) {
            const currentEnd = current.toPageNumber + current.count - 1;
            if (current.toPageNumber > nextEnd) {
                break;
            }
            const overlapStart = Math.max(current.toPageNumber, next.fromPageNumber);
            const overlapEnd = Math.min(currentEnd, nextEnd);
            if (overlapStart <= overlapEnd) {
                appendPageMapping(
                    composed,
                    current.fromPageNumber + overlapStart - current.toPageNumber,
                    next.toPageNumber + overlapStart - next.fromPageNumber,
                    overlapEnd - overlapStart + 1,
                );
            }
        }
    }
    return composed;
}

function lowerBoundPage(pages: readonly number[], value: number) {
    let low = 0;
    let high = pages.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const middlePage = pages[middle];
        if (middlePage !== undefined && middlePage < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function* iteratePageSelectionRange(
    selection: TPageSelection,
    startPage: number,
    endPage: number,
): Generator<number> {
    const start = Math.max(1, startPage);
    const end = Math.min(selection.pageCount, endPage);
    if (start > end) {
        return;
    }
    switch (selection.kind) {
        case 'none':
            return;
        case 'all':
            for (let page = start; page <= end; page += 1) yield page;
            return;
        case 'explicit': {
            const first = lowerBoundPage(selection.pages, start);
            for (const page of selection.pages.slice(first)) {
                if (page > end) {
                    break;
                }
                yield page;
            }
            return;
        }
        case 'range': {
            const rangeStart = Math.max(start, selection.startPage);
            const rangeEnd = Math.min(end, selection.endPage);
            for (let page = rangeStart; page <= rangeEnd; page += 1) yield page;
            return;
        }
        case 'predicate': {
            let page = start;
            if (selection.predicate === 'even' && page % 2 !== 0) page += 1;
            if (selection.predicate === 'odd' && page % 2 === 0) page += 1;
            for (; page <= end; page += 2) yield page;
            return;
        }
        case 'complement': {
            const excluded = selection.excludedPages !== undefined
                ? createExplicitPageSelection(selection.pageCount, selection.excludedPages)
                : selection.excludedSelection;
            if (excluded === undefined) {
                for (let page = start; page <= end; page += 1) yield page;
                return;
            }
            let nextPage = start;
            for (const excludedPage of iteratePageSelectionRange(excluded, start, end)) {
                for (let page = nextPage; page < excludedPage; page += 1) yield page;
                nextPage = excludedPage + 1;
            }
            for (let page = nextPage; page <= end; page += 1) yield page;
            return;
        }
        case 'exceptions': {
            const includedPages = selection.includedPages.filter(page => (
                page >= start
                && page <= end
                && !isPageSelected(selection.base, page)
                && !selection.excludedPages.includes(page)
            ));
            let includedIndex = 0;
            for (const page of iteratePageSelectionRange(selection.base, start, end)) {
                for (
                    let included = includedPages[includedIndex];
                    included !== undefined && included < page;
                    included = includedPages[includedIndex]
                ) {
                    yield included;
                    includedIndex += 1;
                }
                if (!selection.excludedPages.includes(page)) {
                    yield page;
                }
                if (includedPages[includedIndex] === page) {
                    includedIndex += 1;
                }
            }
            yield* includedPages.slice(includedIndex);
            return;
        }
        case 'mapped':
            for (const page of iterateMappedPageSelection(selection)) {
                if (page >= start && page <= end) {
                    yield page;
                }
            }
            return;
    }
}

function* iterateMappedPageSelection(selection: IMappedPageSelection): Generator<number> {
    let mappings: IPageMappingSegment[] = [{
        fromPageNumber: 1,
        toPageNumber: 1,
        count: selection.pageCount,
    }];
    for (const move of selection.moves) {
        mappings = composePageMoveMappings(mappings, createPageMoveMappings(move));
    }
    for (const mapping of mappings) {
        for (const sourcePage of iteratePageSelectionRange(
            selection.source,
            mapping.fromPageNumber,
            mapping.fromPageNumber + mapping.count - 1,
        )) {
            yield mapping.toPageNumber + sourcePage - mapping.fromPageNumber;
        }
    }
}

/** Iterates selected pages without creating a document-sized array. */
export function* iteratePageSelection(selection: TPageSelection): Generator<number> {
    switch (selection.kind) {
        case 'none':
            return;
        case 'all':
            for (let page = 1; page <= selection.pageCount; page += 1) yield page;
            return;
        case 'explicit':
            yield* selection.pages;
            return;
        case 'range':
            for (let page = selection.startPage; page <= selection.endPage; page += 1) yield page;
            return;
        case 'predicate':
            for (let page = selection.predicate === 'even' ? 2 : 1; page <= selection.pageCount; page += 2) yield page;
            return;
        case 'exceptions':
            yield* iteratePageSelectionRange(selection, 1, selection.pageCount);
            return;
        case 'mapped':
            yield* iterateMappedPageSelection(selection);
            return;
        case 'complement': {
            yield* iteratePageSelectionRange(selection, 1, selection.pageCount);
            return;
        }
    }
}

function* mergePageRangeSources(
    left: Iterable<IPageMoveRangeSegment>,
    right: Iterable<IPageMoveRangeSegment>,
): Generator<IPageMoveRangeSegment> {
    const leftIterator = left[Symbol.iterator]();
    const rightIterator = right[Symbol.iterator]();
    let leftNext = leftIterator.next();
    let rightNext = rightIterator.next();
    let pending: IPageMoveRangeSegment | null = null;

    while (!leftNext.done || !rightNext.done) {
        const next = rightNext.done || (
            !leftNext.done
            && leftNext.value.startPage <= rightNext.value.startPage
        )
            ? leftNext
            : rightNext;
        if (next === leftNext) {
            leftNext = leftIterator.next();
        } else {
            rightNext = rightIterator.next();
        }

        if (next.done) {
            continue;
        }
        const segment = next.value;
        if (!pending) {
            pending = {
                startPage: segment.startPage,
                endPage: segment.endPage,
            };
        } else if (segment.startPage <= pending.endPage + 1) {
            pending.endPage = Math.max(pending.endPage, segment.endPage);
        } else {
            yield pending;
            pending = {
                startPage: segment.startPage,
                endPage: segment.endPage,
            };
        }
    }

    if (pending) {
        yield pending;
    }
}

function* subtractPageRangePages(
    ranges: Iterable<IPageMoveRangeSegment>,
    excludedPages: readonly number[],
): Generator<IPageMoveRangeSegment> {
    let excludedIndex = 0;
    for (const range of ranges) {
        let nextPage = range.startPage;
        for (
            let excludedPage = excludedPages[excludedIndex];
            excludedPage !== undefined && excludedPage < nextPage;
            excludedPage = excludedPages[excludedIndex]
        ) {
            excludedIndex += 1;
        }
        for (
            let excludedPage = excludedPages[excludedIndex];
            excludedPage !== undefined && excludedPage <= range.endPage;
            excludedPage = excludedPages[excludedIndex]
        ) {
            if (nextPage < excludedPage) {
                yield {
                    startPage: nextPage,
                    endPage: excludedPage - 1,
                };
            }
            nextPage = excludedPage + 1;
            excludedIndex += 1;
        }
        if (nextPage <= range.endPage) {
            yield {
                startPage: nextPage,
                endPage: range.endPage,
            };
        }
    }
}

function* iterateExplicitPageSelectionRanges(
    pages: readonly number[],
): Generator<IPageMoveRangeSegment> {
    const [
        firstPage,
        ...restPages
    ] = pages;
    if (firstPage === undefined) {
        return;
    }
    let startPage = firstPage;
    let endPage = startPage;
    for (const page of restPages) {
        if (page === endPage + 1) {
            endPage = page;
            continue;
        }
        yield {
            startPage,
            endPage,
        };
        startPage = page;
        endPage = page;
    }
    yield {
        startPage,
        endPage,
    };
}

function* iterateMappedPageSelectionRanges(
    selection: IMappedPageSelection,
): Generator<IPageMoveRangeSegment> {
    let mappings: IPageMappingSegment[] = [{
        fromPageNumber: 1,
        toPageNumber: 1,
        count: selection.pageCount,
    }];
    for (const move of selection.moves) {
        mappings = composePageMoveMappings(mappings, createPageMoveMappings(move));
    }
    for (const mapping of mappings) {
        const mappingEnd = mapping.fromPageNumber + mapping.count - 1;
        for (const sourceRange of iteratePageSelectionRangesWithin(
            selection.source,
            mapping.fromPageNumber,
            mappingEnd,
        )) {
            yield {
                startPage: mapping.toPageNumber + sourceRange.startPage - mapping.fromPageNumber,
                endPage: mapping.toPageNumber + sourceRange.endPage - mapping.fromPageNumber,
            };
        }
    }
}

function* iteratePageSelectionRangesWithin(
    selection: TPageSelection,
    startPage: number,
    endPage: number,
): Generator<IPageMoveRangeSegment> {
    const start = Math.max(1, startPage);
    const end = Math.min(selection.pageCount, endPage);
    if (start > end) {
        return;
    }
    switch (selection.kind) {
        case 'none':
            return;
        case 'all':
            yield {
                startPage: start,
                endPage: end,
            };
            return;
        case 'explicit': {
            const first = lowerBoundPage(selection.pages, start);
            let rangeStart: number | null = null;
            let rangeEnd = start;
            for (const page of selection.pages.slice(first)) {
                if (page > end) {
                    break;
                }
                if (rangeStart === null) {
                    rangeStart = page;
                } else if (page !== rangeEnd + 1) {
                    yield {
                        startPage: rangeStart,
                        endPage: rangeEnd,
                    };
                    rangeStart = page;
                }
                rangeEnd = page;
            }
            if (rangeStart !== null) {
                yield {
                    startPage: rangeStart,
                    endPage: rangeEnd,
                };
            }
            return;
        }
        case 'range':
            if (selection.startPage <= end && selection.endPage >= start) {
                yield {
                    startPage: Math.max(start, selection.startPage),
                    endPage: Math.min(end, selection.endPage),
                };
            }
            return;
        case 'predicate': {
            let page = start;
            if (selection.predicate === 'even' && page % 2 !== 0) {
                page += 1;
            }
            if (selection.predicate === 'odd' && page % 2 === 0) {
                page += 1;
            }
            for (; page <= end; page += 2) {
                yield {
                    startPage: page,
                    endPage: page,
                };
            }
            return;
        }
        case 'complement': {
            const excludedRanges = selection.excludedPages === undefined
                ? selection.excludedSelection === undefined
                    ? []
                    : iteratePageSelectionRangesWithin(selection.excludedSelection, start, end)
                : iterateExplicitPageSelectionRanges(selection.excludedPages);
            let nextPage = start;
            for (const excludedRange of excludedRanges) {
                if (excludedRange.endPage < start) {
                    continue;
                }
                if (excludedRange.startPage > end) {
                    break;
                }
                const excludedStart = Math.max(start, excludedRange.startPage);
                const excludedEnd = Math.min(end, excludedRange.endPage);
                if (nextPage < excludedStart) {
                    yield {
                        startPage: nextPage,
                        endPage: excludedStart - 1,
                    };
                }
                nextPage = excludedEnd + 1;
            }
            if (nextPage <= end) {
                yield {
                    startPage: nextPage,
                    endPage,
                };
            }
            return;
        }
        case 'exceptions': {
            const excludedPages = selection.excludedPages.filter(page => (
                isPageSelected(selection.base, page)
            ));
            const includedPages = selection.includedPages.filter(page => (
                !isPageSelected(selection.base, page)
                && !selection.excludedPages.includes(page)
                && page >= start
                && page <= end
            ));
            yield* mergePageRangeSources(
                subtractPageRangePages(
                    iteratePageSelectionRangesWithin(selection.base, start, end),
                    excludedPages,
                ),
                iterateExplicitPageSelectionRanges(includedPages),
            );
            return;
        }
        case 'mapped':
            for (const mappedRange of iterateMappedPageSelectionRanges(selection)) {
                if (mappedRange.endPage < start) {
                    continue;
                }
                if (mappedRange.startPage > end) {
                    break;
                }
                yield {
                    startPage: Math.max(start, mappedRange.startPage),
                    endPage: Math.min(end, mappedRange.endPage),
                };
            }
            return;
    }
}

/**
 * Yields selected pages as sorted, contiguous ranges. The iterator keeps
 * select-all, ranges, and complements proportional to their structural
 * descriptions instead of walking every page in the document.
 */
export function* iteratePageSelectionRanges(
    selection: TPageSelection,
): Generator<IPageMoveRangeSegment> {
    yield* iteratePageSelectionRangesWithin(selection, 1, selection.pageCount);
}

/**
 * Produces bounded native-operation batches.  The generator itself retains
 * only the current batch, so callers can process select-all on large files.
 */
export function* iteratePageSelectionBatches(
    selection: TPageSelection,
    options: IPageSelectionBatchOptions = {},
): Generator<number[]> {
    const batchSize = options.batchSize ?? 1_024;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
        throw new RangeError('Page selection batchSize must be a positive safe integer');
    }
    let batch: number[] = [];
    for (const page of iteratePageSelection(selection)) {
        batch.push(page);
        if (batch.length >= batchSize) {
            yield batch;
            batch = [];
        }
    }
    if (batch.length > 0) yield batch;
}

export function materializePageSelection(
    selection: TPageSelection,
    options: IPageSelectionBatchOptions = {},
) {
    const pages: number[] = [];
    for (const batch of iteratePageSelectionBatches(selection, options)) pages.push(...batch);
    return pages;
}

export function invertPageSelection(selection: TPageSelection): TPageSelection {
    switch (selection.kind) {
        case 'none':
            return createAllPageSelection(selection.pageCount);
        case 'all':
            return createEmptyPageSelection(selection.pageCount);
        case 'complement':
            if (selection.excludedPages !== undefined) {
                return createExplicitPageSelection(selection.pageCount, selection.excludedPages);
            }
            return selection.excludedSelection ?? createAllPageSelection(selection.pageCount);
        case 'exceptions':
            return createComplementOfPageSelection(selection);
        case 'explicit':
        case 'range':
        case 'predicate':
        case 'mapped':
            return createComplementOfPageSelection(selection);
    }
}

export function togglePageSelection(selection: TPageSelection, page: number): TPageSelection {
    normalizeSelectionPage(page, selection.pageCount);
    if (selection.kind === 'all') {
        return createComplementPageSelection(selection.pageCount, [page]);
    }
    if (selection.kind === 'none') {
        return createExplicitPageSelection(selection.pageCount, [page]);
    }
    if (selection.kind === 'explicit') {
        const next = selection.pages.includes(page)
            ? selection.pages.filter(candidate => candidate !== page)
            : [
                ...selection.pages,
                page,
            ];
        return createExplicitPageSelection(selection.pageCount, next);
    }
    if (selection.kind === 'complement' && selection.excludedPages !== undefined) {
        const next = selection.excludedPages.includes(page)
            ? selection.excludedPages.filter(candidate => candidate !== page)
            : [
                ...selection.excludedPages,
                page,
            ];
        return createComplementPageSelection(selection.pageCount, next);
    }
    if (selection.kind === 'exceptions') {
        const included = selection.includedPages.filter(candidate => candidate !== page);
        const excluded = selection.excludedPages.filter(candidate => candidate !== page);
        if (isPageSelected(selection, page)) excluded.push(page);
        else included.push(page);
        return createExceptionPageSelection(selection.base, included, excluded);
    }
    // A range or predicate stays compact when one page is toggled.  The
    // exceptions carry only the changed page and retain the lazy base.
    return isPageSelected(selection, page)
        ? createExceptionPageSelection(selection, [], [page])
        : createExceptionPageSelection(selection, [page], []);
}


function isPageMoveRanges(move: TPageMoveOperation): move is IPageMoveRanges {
    return 'ranges' in move && Array.isArray(move.ranges);
}

export function createMappedPageSelection(
    source: TPageSelection,
    move: TPageMoveOperation,
): TPageSelection {
    if (source.pageCount !== move.pageCount) {
        throw new RangeError('Mapped page selection and move must use the same page count');
    }
    if (isPageMoveOperationNoOp(move) || source.kind === 'none' || source.kind === 'all') {
        return source;
    }
    if (source.kind === 'mapped') {
        let base = source.source;
        const moves = [
            ...source.moves,
            move,
        ];
        while (base.kind === 'mapped') {
            moves.unshift(...base.moves);
            base = base.source;
        }
        return {
            kind: 'mapped',
            pageCount: source.pageCount,
            source: base,
            moves,
        };
    }
    return {
        kind: 'mapped',
        pageCount: source.pageCount,
        source,
        moves: [move],
    };
}
export function pageMoveRangeLength(move: IPageMoveRange) {
    return move.endPage - move.startPage + 1;
}

/** Maps an original zero-based insertion slot into the remaining-page list. */
export function pageMoveRestInsertIndex(move: IPageMoveRange) {
    const length = pageMoveRangeLength(move);
    if (move.insertAt < move.startPage - 1) {
        return move.insertAt;
    }
    if (move.insertAt > move.endPage) {
        return move.insertAt - length;
    }
    return move.startPage - 1;
}

export function isPageMoveNoOp(move: IPageMoveRange) {
    return move.insertAt >= move.startPage - 1 && move.insertAt <= move.endPage;
}

export function pageMoveRangesSelectedPageCount(move: IPageMoveRanges) {
    return move.ranges.reduce((count, segment) => count + segment.endPage - segment.startPage + 1, 0);
}

/** Maps an original insertion slot into the remaining-page list. */
export function pageMoveRangesRestInsertIndex(move: IPageMoveRanges) {
    let selectedThroughInsert = 0;
    for (const segment of move.ranges) {
        if (segment.startPage > move.insertAt) {
            break;
        }
        selectedThroughInsert += Math.min(segment.endPage, move.insertAt) - segment.startPage + 1;
    }
    return move.insertAt - selectedThroughInsert;
}

export function isPageMoveRangesNoOp(move: IPageMoveRanges) {
    const [range] = move.ranges;
    return range !== undefined && move.ranges.length === 1 && isPageMoveNoOp({
        pageCount: move.pageCount,
        startPage: range.startPage,
        endPage: range.endPage,
        insertAt: move.insertAt,
    });
}

export function isPageMoveOperationNoOp(move: TPageMoveOperation) {
    return isPageMoveRanges(move) ? isPageMoveRangesNoOp(move) : isPageMoveNoOp(move);
}

function selectedOffsetForPage(page: number, move: IPageMoveRanges) {
    let offset = 0;
    for (const segment of move.ranges) {
        if (page < segment.startPage) {
            break;
        }
        if (page <= segment.endPage) {
            return offset + page - segment.startPage;
        }
        offset += segment.endPage - segment.startPage + 1;
    }
    return null;
}

function selectedPagesBeforePage(page: number, move: IPageMoveRanges) {
    let count = 0;
    for (const segment of move.ranges) {
        if (segment.startPage >= page) {
            break;
        }
        count += Math.min(segment.endPage, page - 1) - segment.startPage + 1;
    }
    return count;
}

function selectedPageAtOffset(offset: number, move: IPageMoveRanges) {
    let remaining = offset;
    for (const segment of move.ranges) {
        const count = segment.endPage - segment.startPage + 1;
        if (remaining < count) {
            return segment.startPage + remaining;
        }
        remaining -= count;
    }
    return null;
}

function restPageAtIndex(restIndex: number, move: IPageMoveRanges) {
    let remaining = restIndex;
    let nextPage = 1;
    for (const segment of move.ranges) {
        const gapCount = segment.startPage - nextPage;
        if (remaining < gapCount) {
            return nextPage + remaining;
        }
        remaining -= gapCount;
        nextPage = segment.endPage + 1;
    }
    return nextPage + remaining <= move.pageCount ? nextPage + remaining : null;
}

function mapPageNumberAfterPageMoveRanges(page: number, move: IPageMoveRanges) {
    const selectedOffset = selectedOffsetForPage(page, move);
    const restInsertIndex = pageMoveRangesRestInsertIndex(move);
    const selectedCount = pageMoveRangesSelectedPageCount(move);
    if (selectedOffset !== null) {
        return restInsertIndex + selectedOffset + 1;
    }
    const restIndex = page - 1 - selectedPagesBeforePage(page, move);
    return restIndex < restInsertIndex
        ? restIndex + 1
        : restIndex + selectedCount + 1;
}

function mapPageNumberBeforePageMoveRanges(page: number, move: IPageMoveRanges) {
    const restInsertIndex = pageMoveRangesRestInsertIndex(move);
    const selectedCount = pageMoveRangesSelectedPageCount(move);
    const destinationStart = restInsertIndex + 1;
    if (page >= destinationStart && page < destinationStart + selectedCount) {
        return selectedPageAtOffset(page - destinationStart, move);
    }
    const restIndex = page < destinationStart
        ? page - 1
        : page - selectedCount - 1;
    return restPageAtIndex(restIndex, move);
}

export function mapPageNumberAfterPageMove(page: number, move: TPageMoveOperation) {
    if (isPageMoveRanges(move)) {
        normalizeSelectionPage(page, move.pageCount);
        return mapPageNumberAfterPageMoveRanges(page, move);
    }
    normalizeSelectionPage(page, move.pageCount);
    if (isPageMoveNoOp(move)) {
        return page;
    }
    const length = pageMoveRangeLength(move);
    const restInsertIndex = pageMoveRestInsertIndex(move);
    if (page >= move.startPage && page <= move.endPage) {
        return restInsertIndex + page - move.startPage + 1;
    }
    const restIndex = page < move.startPage
        ? page - 1
        : move.startPage - 1 + page - move.endPage - 1;
    return restIndex < restInsertIndex
        ? restIndex + 1
        : restIndex + length + 1;
}

/** Maps a destination page back to its original page after a move. */
export function mapPageNumberBeforePageMove(page: number, move: TPageMoveOperation) {
    if (isPageMoveRanges(move)) {
        normalizeSelectionPage(page, move.pageCount);
        return mapPageNumberBeforePageMoveRanges(page, move);
    }
    normalizeSelectionPage(page, move.pageCount);
    if (isPageMoveNoOp(move)) {
        return page;
    }
    const length = pageMoveRangeLength(move);
    const restInsertIndex = pageMoveRestInsertIndex(move);
    const destinationStart = restInsertIndex + 1;
    if (page >= destinationStart && page < destinationStart + length) {
        return move.startPage + page - destinationStart;
    }
    const restIndex = page < destinationStart
        ? page - 1
        : page - length - 1;
    return restIndex < move.startPage - 1
        ? restIndex + 1
        : restIndex + length + 1;
}

/** Builds a full permutation for small/browser-only implementations. */
export function buildPageMoveOrder(move: IPageMoveRange) {
    const order: number[] = [];
    const restInsertIndex = pageMoveRestInsertIndex(move);
    let restIndex = 0;
    for (let page = 1; page <= move.pageCount; page += 1) {
        if (page >= move.startPage && page <= move.endPage) continue;
        if (restIndex === restInsertIndex) {
            for (let movedPage = move.startPage; movedPage <= move.endPage; movedPage += 1) {
                order.push(movedPage);
            }
        }
        order.push(page);
        restIndex += 1;
    }
    if (restIndex === restInsertIndex) {
        for (let movedPage = move.startPage; movedPage <= move.endPage; movedPage += 1) {
            order.push(movedPage);
        }
    }
    return order;
}

/** Builds a full permutation for the bounded browser fallback. */
export function buildPageMoveRangesOrder(move: IPageMoveRanges) {
    const selectedPages: number[] = [];
    const restPages: number[] = [];
    let segmentIndex = 0;
    for (let page = 1; page <= move.pageCount; page += 1) {
        const segment = move.ranges[segmentIndex];
        if (segment && page >= segment.startPage && page <= segment.endPage) {
            selectedPages.push(page);
            if (page === segment.endPage) {
                segmentIndex += 1;
            }
        } else {
            restPages.push(page);
        }
    }
    const restInsertIndex = pageMoveRangesRestInsertIndex(move);
    return [
        ...restPages.slice(0, restInsertIndex),
        ...selectedPages,
        ...restPages.slice(restInsertIndex),
    ];
}
