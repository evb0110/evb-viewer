export type TScanCleanupSelectionIntent = 'single' | 'toggle' | 'range';

/**
 * A page order that can answer position lookups without materializing every
 * page. Natural order and a sorted sparse prefix both use this contract.
 */
export interface IScanCleanupPageOrder {
    readonly length: number;
    pageAt: (position: number) => number | undefined;
    positionOf: (page: number) => number;
}

export type TScanCleanupOrderedPages = readonly number[] | IScanCleanupPageOrder;

export interface IScanCleanupSelectionState {
    anchor: number;
    leader: number;
    selectedPages: ReadonlySet<number>;
}

export function resolveScanCleanupSelection(
    state: IScanCleanupSelectionState,
    page: number,
    intent: TScanCleanupSelectionIntent,
    orderedPages: TScanCleanupOrderedPages,
): IScanCleanupSelectionState {
    if (intent === 'toggle') {
        const selectedPages = new Set(state.selectedPages);
        if (selectedPages.has(page)) {selectedPages.delete(page);}
        else {selectedPages.add(page);}
        return {
            anchor: page,
            leader: page,
            selectedPages,
        };
    }
    if (intent === 'range') {
        const anchorIndex = pageOrderPositionOf(orderedPages, state.anchor);
        const pageIndex = pageOrderPositionOf(orderedPages, page);
        if (anchorIndex >= 1 && pageIndex >= 1) {
            const start = Math.min(anchorIndex, pageIndex);
            const end = Math.max(anchorIndex, pageIndex);
            return {
                anchor: state.anchor,
                leader: page,
                selectedPages: new Set(pageOrderPages(orderedPages, start, end)),
            };
        }
    }
    return {
        anchor: page,
        leader: page,
        selectedPages: new Set([page]),
    };
}

export function createScanCleanupNaturalPageOrder(pageCount: number): IScanCleanupPageOrder {
    const length = Math.max(0, Math.trunc(pageCount));
    return {
        length,
        pageAt: position => position >= 1 && position <= length
            ? position
            : undefined,
        positionOf: page => page >= 1 && page <= length
            ? page
            : -1,
    };
}

/**
 * Keep the known, sorted pages in memory and leave every other page in its
 * natural position after that prefix. Lookups only inspect the known pages,
 * so a million-page rail can sort the results it has actually loaded without
 * manufacturing a million-entry order.
 */
export function createScanCleanupSparsePageOrder(
    pageCount: number,
    loadedPages: Iterable<number>,
    compare: (left: number, right: number) => number,
): IScanCleanupPageOrder {
    const length = Math.max(0, Math.trunc(pageCount));
    const knownByPosition = [...loadedPages]
        .filter(page => Number.isInteger(page) && page >= 1 && page <= length);
    knownByPosition.sort(compare);
    const knownByNaturalPage = [...knownByPosition].sort((left, right) => left - right);
    const positionByPage = new Map(knownByPosition.map((page, index) => [
        page,
        index + 1,
    ] as const));
    const unknownCountBefore = (page: number) => upperBound(knownByNaturalPage, page - 1);
    const pageAtUnknownPosition = (unknownPosition: number) => {
        let low = 1;
        let high = length;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            const unknownCount = middle - unknownCountBefore(middle + 1);
            if (unknownCount < unknownPosition) {low = middle + 1;}
            else {high = middle;}
        }
        return low;
    };
    return {
        length,
        pageAt: position => {
            if (position < 1 || position > length) {
                return undefined;
            }
            if (position <= knownByPosition.length) {
                return knownByPosition[position - 1];
            }
            return pageAtUnknownPosition(position - knownByPosition.length);
        },
        positionOf: page => {
            if (!Number.isInteger(page) || page < 1 || page > length) {
                return -1;
            }
            const knownPosition = positionByPage.get(page);
            return knownPosition ?? knownByPosition.length + page - unknownCountBefore(page);
        },
    };
}

function upperBound(values: readonly number[], target: number) {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const value = values[middle];
        if (value === undefined) {
            high = middle;
            continue;
        }
        if (value <= target) {low = middle + 1;}
        else {high = middle;}
    }
    return low;
}

function isPageNumberArray(orderedPages: TScanCleanupOrderedPages): orderedPages is readonly number[] {
    return Array.isArray(orderedPages);
}

function pageOrderPositionOf(orderedPages: TScanCleanupOrderedPages, page: number) {
    return isPageNumberArray(orderedPages)
        ? orderedPages.indexOf(page) + 1
        : orderedPages.positionOf(page);
}

function pageOrderPages(orderedPages: TScanCleanupOrderedPages, start: number, end: number) {
    if (isPageNumberArray(orderedPages)) {
        return orderedPages.slice(start - 1, end);
    }
    const pages: number[] = [];
    for (let position = start; position <= end; position += 1) {
        const page = orderedPages.pageAt(position);
        if (page === undefined) {
            break;
        }
        pages.push(page);
    }
    return pages;
}
