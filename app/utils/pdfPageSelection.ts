import { uniq } from 'es-toolkit/array';
import { range as createRange } from 'es-toolkit/math';
import type { IPdfPageRange } from '@app/types/pdfUi';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import {
    createExplicitPageSelection as createCompactExplicitPageSelection,
    createRangePageSelection as createCompactRangePageSelection,
    isPageSelected as isPageInSelection,
} from '@pdf-core/pdfPageSelection';
export type {
    IAllPageSelection,
    IComplementPageSelection,
    IEmptyPageSelection,
    IExceptionPageSelection,
    IExplicitPageSelection,
    IPredicatePageSelection,
    IRangePageSelection,
    IPageMoveRange,
    IPageMoveRangeSegment,
    IPageMoveRanges,
    IMappedPageSelection,
    TPageSelection,
    TPageMoveOperation,
    TPageSelectionPredicate,
} from '@pdf-core/pdfPageSelection';
export {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    createAllPageSelection,
    createComplementOfPageSelection,
    createComplementPageSelection,
    createEmptyPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    createPageMoveRange,
    createPageMoveRanges,
    createPredicatePageSelection,
    createRangePageSelection,
    invertPageSelection,
    isPageSelected,
    isPageMoveNoOp,
    isPageMoveOperationNoOp,
    isPageMoveRangesNoOp,
    iteratePageSelection,
    iteratePageSelectionBatches,
    iteratePageSelectionRanges,
    mapPageNumberAfterPageMove,
    mapPageNumberBeforePageMove,
    materializePageSelection,
    pageMoveRangeLength,
    pageMoveRangesRestInsertIndex,
    pageMoveRangesSelectedPageCount,
    pageMoveRestInsertIndex,
    pageSelectionCount,
    togglePageSelection,
} from '@pdf-core/pdfPageSelection';

export interface IPageThumbnailClickModifiers {
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
}

export function shouldSelectPageFromThumbnailClick(modifiers: IPageThumbnailClickModifiers) {
    return modifiers.shiftKey === true || modifiers.metaKey === true || modifiers.ctrlKey === true;
}

export function resolveThumbnailContextMenuPages(
    page: number,
    selectedPages: number[],
    totalPages: number,
) {
    const normalizedSelection = normalizeSelectedPageNumbers(selectedPages, totalPages);
    if (normalizedSelection.includes(page)) {
        return normalizedSelection;
    }

    return normalizeSelectedPageNumbers([page], totalPages);
}

export function resolveThumbnailContextMenuSelection(
    page: number,
    selection: TPageSelection,
    totalPages: number,
): TPageSelection {
    if (selection.pageCount === totalPages && isPageInSelection(selection, page)) {
        return selection;
    }
    return createCompactExplicitPageSelection(totalPages, [page]);
}

export function normalizeSelectedPageNumbers(selectedPages: number[], totalPages: number): number[] {
    return uniq(selectedPages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
}

export function arePageNumberListsEqual(left: number[], right: number[]) {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => value === right[index]);
}

export function expandPageRange(range: IPdfPageRange | null): number[] | null {
    if (!range) {
        return null;
    }

    return createRange(range.startPage, range.endPage + 1);
}

export function createPageSelectionFromRange(
    range: IPdfPageRange | null,
    totalPages: number,
): TPageSelection | null {
    if (!range) {
        return null;
    }
    return createCompactRangePageSelection(totalPages, range.startPage, range.endPage);
}

export function createAllPageNumbers(totalPages: number): number[] {
    return createRange(1, totalPages + 1);
}
