import type { TBrand } from '@contracts/brand';

export type TPageIndex = TBrand<number, 'PageIndex'>;
export type TPageNumber = TBrand<number, 'PageNumber'>;

/**
 * A page selection keeps the document size as a scalar.  Only explicit
 * selections carry a page-sized collection.  The other forms are lazy and
 * can be expanded a batch at a time when an operation needs page numbers.
 */
export type TPageSelectionPredicate = 'even' | 'odd';

export interface IEmptyPageSelection {
    kind: 'none';
    pageCount: number;
}

export interface IAllPageSelection {
    kind: 'all';
    pageCount: number;
}

export interface IExplicitPageSelection {
    kind: 'explicit';
    pageCount: number;
    pages: number[];
}

export interface IRangePageSelection {
    kind: 'range';
    pageCount: number;
    startPage: number;
    endPage: number;
}

export interface IComplementPageSelection {
    kind: 'complement';
    pageCount: number;
    /** A small exclusion list, when the excluded selection is explicit. */
    excludedPages?: number[];
    /** A lazy excluded selection for complements of ranges or predicates. */
    excludedSelection?: TPageSelection;
}

export interface IPredicatePageSelection {
    kind: 'predicate';
    pageCount: number;
    predicate: TPageSelectionPredicate;
}

export interface IExceptionPageSelection {
    kind: 'exceptions';
    pageCount: number;
    base: TPageSelection;
    includedPages: number[];
    excludedPages: number[];
}

/**
 * A page selection whose page identities were carried through a move. This
 * keeps a predicate, complement, or range lazy even after drag reorder.
 */
export interface IMappedPageSelection {
    kind: 'mapped';
    pageCount: number;
    source: TPageSelection;
    moves: TPageMoveOperation[];
}

export type TPageSelection =
    | IEmptyPageSelection
    | IAllPageSelection
    | IExplicitPageSelection
    | IRangePageSelection
    | IComplementPageSelection
    | IPredicatePageSelection
    | IExceptionPageSelection
    | IMappedPageSelection;

export interface IPageSelectionBatchOptions { batchSize?: number; }

function normalizeSelectionPageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new RangeError('Page selection pageCount must be a non-negative safe integer');
    }
    return pageCount;
}

function normalizeSelectionPage(page: number, pageCount: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
        throw new RangeError(`Page selection page ${page} is outside 1-${pageCount}`);
    }
    return page;
}

function normalizeSelectionPages(pages: readonly number[], pageCount: number) {
    const normalized = [...new Set(pages)].map(page => normalizeSelectionPage(page, pageCount));
    normalized.sort((left, right) => left - right);
    return normalized;
}

export function createExceptionPageSelection(
    base: TPageSelection,
    includedPages: readonly number[],
    excludedPages: readonly number[],
): IExceptionPageSelection {
    return {
        kind: 'exceptions',
        pageCount: base.pageCount,
        base,
        includedPages: normalizeSelectionPages(includedPages, base.pageCount),
        excludedPages: normalizeSelectionPages(excludedPages, base.pageCount),
    };
}

export function createEmptyPageSelection(pageCount: number): IEmptyPageSelection {
    return {
        kind: 'none',
        pageCount: normalizeSelectionPageCount(pageCount),
    };
}

export function createAllPageSelection(pageCount: number): IAllPageSelection {
    return {
        kind: 'all',
        pageCount: normalizeSelectionPageCount(pageCount),
    };
}

export function createExplicitPageSelection(
    pageCount: number,
    pages: readonly number[],
): IExplicitPageSelection {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    return {
        kind: 'explicit',
        pageCount: normalizedPageCount,
        pages: normalizeSelectionPages(pages, normalizedPageCount),
    };
}

export function createRangePageSelection(
    pageCount: number,
    startPage: number,
    endPage: number,
): IRangePageSelection {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    const normalizedStart = normalizeSelectionPage(startPage, normalizedPageCount);
    const normalizedEnd = normalizeSelectionPage(endPage, normalizedPageCount);
    if (normalizedStart > normalizedEnd) {
        throw new RangeError('Page selection range must start before it ends');
    }
    return {
        kind: 'range',
        pageCount: normalizedPageCount,
        startPage: normalizedStart,
        endPage: normalizedEnd,
    };
}

export function createComplementPageSelection(
    pageCount: number,
    excludedPages: readonly number[],
): IComplementPageSelection {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    return {
        kind: 'complement',
        pageCount: normalizedPageCount,
        excludedPages: normalizeSelectionPages(excludedPages, normalizedPageCount),
    };
}

export function createComplementOfPageSelection(
    selection: TPageSelection,
): IComplementPageSelection {
    if (selection.kind === 'explicit') {
        return createComplementPageSelection(selection.pageCount, selection.pages);
    }
    return {
        kind: 'complement',
        pageCount: selection.pageCount,
        excludedSelection: selection,
    };
}

export function createPredicatePageSelection(
    pageCount: number,
    predicate: TPageSelectionPredicate,
): IPredicatePageSelection {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    return {
        kind: 'predicate',
        pageCount: normalizedPageCount,
        predicate,
    };
}

export interface IPageMoveRange {
    pageCount: number;
    startPage: number;
    endPage: number;
    /** Zero-based insertion slot in the original page order. */
    insertAt: number;
}

/** One contiguous source run in a multi-range thumbnail move. */
export interface IPageMoveRangeSegment {
    startPage: number;
    endPage: number;
}

/** A non-contiguous move that keeps the selected runs in source order. */
export interface IPageMoveRanges {
    pageCount: number;
    ranges: IPageMoveRangeSegment[];
    /** Zero-based insertion slot in the original page order. */
    insertAt: number;
}

export type TPageMoveOperation = IPageMoveRange | IPageMoveRanges;

export function createPageMoveRanges(
    pageCount: number,
    ranges: readonly IPageMoveRangeSegment[],
    insertAt: number,
): IPageMoveRanges {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    if (normalizedPageCount === 0) {
        throw new RangeError('Page move requires a non-empty document');
    }
    if (ranges.length === 0) {
        throw new RangeError('Page move ranges must contain at least one range');
    }
    if (!Number.isSafeInteger(insertAt) || insertAt < 0 || insertAt > normalizedPageCount) {
        throw new RangeError(`Page move insertAt must be a safe integer in 0-${normalizedPageCount}`);
    }

    const normalized = [...ranges].map((segment) => {
        const {
            startPage,
            endPage,
        } = segment;
        const normalizedStart = normalizeSelectionPage(startPage, normalizedPageCount);
        const normalizedEnd = normalizeSelectionPage(endPage, normalizedPageCount);
        if (normalizedStart > normalizedEnd) {
            throw new RangeError('Page move range must start before it ends');
        }
        return {
            startPage: normalizedStart,
            endPage: normalizedEnd,
        };
    });
    normalized.sort((left, right) => left.startPage - right.startPage);

    const merged: IPageMoveRangeSegment[] = [];
    for (const segment of normalized) {
        const previous = merged.at(-1);
        if (previous && segment.startPage <= previous.endPage + 1) {
            previous.endPage = Math.max(previous.endPage, segment.endPage);
        } else {
            merged.push(segment);
        }
    }
    return {
        pageCount: normalizedPageCount,
        ranges: merged,
        insertAt,
    };
}

export function createPageMoveRange(
    pageCount: number,
    startPage: number,
    endPage: number,
    insertAt: number,
): IPageMoveRange {
    const normalizedPageCount = normalizeSelectionPageCount(pageCount);
    if (normalizedPageCount === 0) {
        throw new RangeError('Page move requires a non-empty document');
    }
    const normalizedStart = normalizeSelectionPage(startPage, normalizedPageCount);
    const normalizedEnd = normalizeSelectionPage(endPage, normalizedPageCount);
    if (normalizedStart > normalizedEnd) {
        throw new RangeError('Page move range must start before it ends');
    }
    if (!Number.isSafeInteger(insertAt) || insertAt < 0 || insertAt > normalizedPageCount) {
        throw new RangeError(`Page move insertAt must be a safe integer in 0-${normalizedPageCount}`);
    }
    return {
        pageCount: normalizedPageCount,
        startPage: normalizedStart,
        endPage: normalizedEnd,
        insertAt,
    };
}

function isPageIndexValue(value: number): value is TPageIndex {
    return Number.isSafeInteger(value) && value >= 0;
}

function isPageNumberValue(value: number): value is TPageNumber {
    return Number.isSafeInteger(value) && value >= 1;
}

function toPageIndex(value: number): TPageIndex {
    if (!isPageIndexValue(value)) {
        throw new RangeError('Page index must be a non-negative safe integer');
    }
    return value;
}

function toPageNumber(value: number): TPageNumber {
    if (!isPageNumberValue(value)) {
        throw new RangeError('Page number must be a positive safe integer');
    }
    return value;
}

export function parsePageIndex(value: number, pageCount?: number): TPageIndex | null {
    if (!Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    if (pageCount !== undefined && value >= pageCount) {
        return null;
    }
    return toPageIndex(value);
}

export function parsePageNumber(value: number, pageCount?: number): TPageNumber | null {
    if (!Number.isSafeInteger(value) || value < 1) {
        return null;
    }
    if (pageCount !== undefined && value > pageCount) {
        return null;
    }
    return toPageNumber(value);
}

export function requirePageIndex(value: number, pageCount?: number): TPageIndex {
    const pageIndex = parsePageIndex(value, pageCount);
    if (pageIndex === null) {
        throw new RangeError('Page index must be a non-negative safe integer within the document');
    }
    return pageIndex;
}

export function requirePageNumber(value: number, pageCount?: number): TPageNumber {
    const pageNumber = parsePageNumber(value, pageCount);
    if (pageNumber === null) {
        throw new RangeError('Page number must be a positive safe integer within the document');
    }
    return pageNumber;
}

// A viewport reading is live: the page count is 0 until a document reports its
// length and still describes the previous document during a swap. Clamp such a
// reading instead of asserting it, and keep requirePageNumber for settled values.
export function clampPageNumber(value: number, pageCount?: number): TPageNumber {
    const truncated = Number.isNaN(value) ? 1 : Math.trunc(value);
    const withinDocument = pageCount !== undefined && pageCount > 0
        ? Math.min(truncated, pageCount)
        : truncated;
    return toPageNumber(Math.max(1, Math.min(withinDocument, Number.MAX_SAFE_INTEGER)));
}

export function pageIndexToPageNumber(pageIndex: TPageIndex): TPageNumber {
    return toPageNumber(pageIndex + 1);
}

export function pageNumberToPageIndex(pageNumber: TPageNumber): TPageIndex {
    return toPageIndex(pageNumber - 1);
}
