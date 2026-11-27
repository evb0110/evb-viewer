import {parsePageNumber, type TPageNumber} from '@contracts/pageNumbers';

/**
 * Render caches can outlive the live PDF page count during teardown. Drop
 * stale plain page candidates before calling session predicates that require
 * a page branded against the current document.
 */
export const createPdfRenderPagePredicate =
    (getPageCount: () => number, predicate: (pageNumber: TPageNumber) => boolean) => (pageNumber: unknown) => {
        if (typeof pageNumber !== 'number') {
            return false;
        }
        const brandedPageNumber = parsePageNumber(pageNumber, getPageCount());
        return brandedPageNumber !== null && predicate(brandedPageNumber);
    };
