import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IOcrSearchablePdfPage,
    IOcrSearchablePdfPageRange,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';

const MAX_BATCH_PAGES = 5_000;
const OCR_PAGE_REQUEST_BATCH_SIZE = MAX_BATCH_PAGES;

export interface IOcrPageRange extends IOcrSearchablePdfPageRange {
    firstPage: number;
    lastPage: number;
}

export function getOcrPageSelectionCount(selection: TOcrSearchablePdfPages) {
    if (Array.isArray(selection)) {
        return selection.length;
    }
    switch (selection.kind) {
        case 'all':
            return selection.pageCount;
        case 'range':
            return selection.lastPage - selection.firstPage + 1;
        case 'ranges':
            return selection.ranges.reduce(
                (count, pageRange) => count + pageRange.lastPage - pageRange.firstPage + 1,
                0,
            );
        case 'pages':
            return selection.pages.length;
    }
}

/**
 * Expands a scalar selection into bounded arrays suitable for one worker
 * iteration. At most MAX_BATCH_PAGES page objects exist at any point.
 */
export function* iterateOcrPageRequestBatches(
    selection: TOcrSearchablePdfPages,
    chunkPages = OCR_PAGE_REQUEST_BATCH_SIZE,
): Generator<IOcrSearchablePdfPage[]> {
    assertPositiveSafeInteger(chunkPages, 'chunkPages');
    if (chunkPages > MAX_BATCH_PAGES) {
        throw new RangeError(`chunkPages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }
    if (Array.isArray(selection)) {
        for (let offset = 0; offset < selection.length; offset += chunkPages) {
            yield selection.slice(offset, offset + chunkPages);
        }
        return;
    }

    if (selection.kind === 'pages') {
        for (let offset = 0; offset < selection.pages.length; offset += chunkPages) {
            yield selection.pages.slice(offset, offset + chunkPages);
        }
        return;
    }

    const ranges = selection.kind === 'all'
        ? [{
            firstPage: 1,
            lastPage: selection.pageCount,
        }]
        : selection.kind === 'range'
            ? [{
                firstPage: selection.firstPage,
                lastPage: selection.lastPage,
            }]
            : selection.ranges;
    const languages = [...selection.languages];
    let batch: IOcrSearchablePdfPage[] = [];
    for (const pageRange of ranges) {
        for (let offset = 0; offset <= pageRange.lastPage - pageRange.firstPage; offset += 1) {
            const pageNumber = pageRange.firstPage + offset;
            batch.push({
                pageNumber: requirePageNumber(pageNumber),
                languages,
            });
            if (batch.length === chunkPages) {
                yield batch;
                batch = [];
            }
        }
    }
    if (batch.length > 0) {
        yield batch;
    }
}

function assertPositiveSafeInteger(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${fieldName} must be a positive safe integer`);
    }
}

/**
 * Yields bounded page ranges without materializing a range for every page.
 * Keep this independent of request-window budgets. It plans a document span,
 * while individual page numbers only need to remain safely representable.
 */
export function* iterateOcrPageRanges(
    pageCount: number,
    chunkPages = OCR_PAGE_REQUEST_BATCH_SIZE,
): Generator<IOcrPageRange> {
    assertPositiveSafeInteger(pageCount, 'pageCount');
    assertPositiveSafeInteger(chunkPages, 'chunkPages');
    if (chunkPages > MAX_BATCH_PAGES) {
        throw new RangeError(`chunkPages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }

    let firstPage = 1;
    while (firstPage <= pageCount) {
        const pageSpan = Math.min(chunkPages, pageCount - firstPage + 1);
        const lastPage = firstPage + pageSpan - 1;
        yield {
            firstPage,
            lastPage,
        };
        if (lastPage === pageCount) {
            return;
        }
        firstPage = lastPage + 1;
    }
}
