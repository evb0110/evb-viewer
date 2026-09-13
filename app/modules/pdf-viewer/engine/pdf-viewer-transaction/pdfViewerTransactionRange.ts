import type { TPageNumber } from '@contracts/pageNumbers';

import type { TPdfViewMode } from '@contracts/shared';
import type { IPageRange } from '@app/types/pdfUi';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import {
    createDocumentSinglePageRange,
    doDocumentPageRangesIntersect,
    normalizeDocumentPageRange,
} from '@app/modules/document-viewer/public';

function normalizePdfViewerTransactionRange(range: IPageRange, totalPages: number): IPageRange {
    return normalizeDocumentPageRange(range, totalPages);
}

export function createPdfViewerTransactionSinglePageRange(
    pageNumber: TPageNumber,
    totalPages: number,
): IPageRange {
    return createDocumentSinglePageRange(pageNumber, totalPages);
}

export function getPdfViewerTransactionRowRange(options: {
    pageNumber: TPageNumber;
    totalPages: number;
    viewMode: TPdfViewMode;
}): IPageRange {
    if (options.totalPages <= 0) {
        return createPdfViewerTransactionSinglePageRange(options.pageNumber, options.totalPages);
    }
    return normalizePdfViewerTransactionRange(
        getPageRowBoundsForViewMode({
            pageNumber: options.pageNumber,
            totalPages: options.totalPages,
            viewMode: options.viewMode,
        }),
        options.totalPages,
    );
}

export function doPdfViewerTransactionRangesIntersect(left: IPageRange, right: IPageRange) {
    return doDocumentPageRangesIntersect(left, right);
}
