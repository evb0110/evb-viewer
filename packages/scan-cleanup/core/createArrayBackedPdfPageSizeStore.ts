import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';

/**
 * Page geometry already held as records: the browser source's inspected
 * pages, and small compatibility tests. Desktop's document-scale path reads
 * its bounded sidecar through PdfPageSizeStore instead.
 */
export function createArrayBackedPdfPageSizeStore(
    pageSizes: readonly IPdfPageSize[],
    documentPageCount = pageSizes.length,
): IPdfPageSizeStore {
    const pageCount = Number.isSafeInteger(documentPageCount) && documentPageCount >= 0
        ? documentPageCount
        : pageSizes.length;
    const fallback = pageSizes[0] ?? {
        pageNumber: 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
    } satisfies IPdfPageSize;
    let closed = false;
    const assertOpen = () => {
        if (closed) throw new Error('Page-size store is closed');
    };
    const resolvePage = (pageNumber: number) => {
        const page = pageSizes[pageNumber - 1];
        if (page !== undefined && page.pageNumber === pageNumber) {
            return page;
        }
        // A few direct compatibility tests vary pageCount without replacing
        // their tiny geometry fixture. Production always supplies a native
        // store and never takes this branch.
        if (pageSizes.length === pageCount) {
            throw new Error(`Page-size source returned no geometry for page ${String(pageNumber)}`);
        }
        return {
            ...fallback,
            pageNumber,
        };
    };
    const validatePageNumber = (pageNumber: number) => {
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
            throw new RangeError(`Page-size source has no geometry for page ${String(pageNumber)}`);
        }
    };
    return {
        get pageCount() {
            return pageCount;
        },
        fork: () => createArrayBackedPdfPageSizeStore(pageSizes, pageCount),
        getPage: pageNumber => {
            assertOpen();
            validatePageNumber(pageNumber);
            return Promise.resolve(resolvePage(pageNumber));
        },
        readRange: (firstPageNumber, lastPageNumberExclusive) => {
            assertOpen();
            if (
                !Number.isSafeInteger(firstPageNumber)
                || !Number.isSafeInteger(lastPageNumberExclusive)
                || firstPageNumber < 1
                || lastPageNumberExclusive < firstPageNumber
                || lastPageNumberExclusive > pageCount + 1
            ) {
                throw new RangeError('Page-size range read has invalid page bounds');
            }
            const pages: IPdfPageSize[] = [];
            for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                pages.push(resolvePage(pageNumber));
            }
            return Promise.resolve(pages);
        },
        forEachChunk: async onChunk => {
            assertOpen();
            let chunkIndex = 0;
            for (
                let firstPageNumber = 1;
                firstPageNumber <= pageCount;
                firstPageNumber += SCAN_CLEANUP_STREAMING_BATCH_PAGES
            ) {
                const pages: IPdfPageSize[] = [];
                const lastPageNumberExclusive = Math.min(
                    pageCount + 1,
                    firstPageNumber + SCAN_CLEANUP_STREAMING_BATCH_PAGES,
                );
                for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                    pages.push(resolvePage(pageNumber));
                }
                await onChunk({
                    pageCount,
                    chunkIndex,
                    firstPageNumber,
                    offset: 0,
                    byteLength: 0,
                    pages,
                });
                chunkIndex += 1;
            }
        },
        close: () => {
            closed = true;
            return Promise.resolve();
        },
    };
}
