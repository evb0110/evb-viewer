import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import type {IScanCleanupDetectionResult} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    assertMaxReadPages,
    assertPageCount,
    assertPageNumber,
    assertReadWindow,
    assertRecordWrite,
    RESULT_STORE_MAX_RECORD_BYTES,
    toPersistedDetectionResult,
} from '@evb/scan-cleanup/core/resultStoreRules';

/**
 * A detection result store for a host without a scratch filesystem. It keeps
 * each page's record as its serialized JSON, the same bytes the file-backed
 * store writes, so a read returns a fresh copy and a document-scale store
 * holds strings rather than live object graphs.
 */
export function createMemoryScanCleanupDetectionResultStore(
    pageCount: number,
    maxReadPages = SCAN_CLEANUP_STREAMING_BATCH_PAGES,
): IScanCleanupDetectionResultStore {
    assertPageCount(pageCount);
    assertMaxReadPages(maxReadPages);
    const records = new Map<number, string>();
    let closed = false;
    const assertOpen = () => {
        if (closed) throw new Error('Scan cleanup result store is closed');
    };
    const write = (pageNumber: number, result: IScanCleanupDetectionResult, requireExisting: boolean) => {
        assertOpen();
        assertPageNumber(pageNumber, pageCount);
        assertRecordWrite(pageNumber, result.pageNumber, records.has(pageNumber), requireExisting);
        const record = JSON.stringify(toPersistedDetectionResult(result));
        // UTF-16 length bounds the UTF-8 length from below; the record cap is
        // about runaway records, not an exact byte budget.
        if (record.length > RESULT_STORE_MAX_RECORD_BYTES) {
            throw new RangeError(`Scan cleanup result record exceeds ${String(RESULT_STORE_MAX_RECORD_BYTES)} bytes`);
        }
        records.set(pageNumber, record);
    };
    const read = (pageNumber: number) => {
        const record = records.get(pageNumber);
        return record === undefined ? undefined : JSON.parse(record) as IScanCleanupDetectionResult;
    };
    const readRange = (firstPageNumber: number, lastPageNumberExclusive: number) => {
        assertReadWindow(firstPageNumber, lastPageNumberExclusive, pageCount, maxReadPages);
        const results: IScanCleanupDetectionResult[] = [];
        for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
            const result = read(pageNumber);
            if (result !== undefined) results.push(result);
        }
        return results;
    };
    return {
        pageCount,
        get resultCount() {
            return records.size;
        },
        append: async result => write(result.pageNumber, result, false),
        replace: async (pageNumber, result) => write(pageNumber, result, true),
        getPage: async pageNumber => {
            assertOpen();
            assertPageNumber(pageNumber, pageCount);
            return read(pageNumber);
        },
        readRange: async (firstPageNumber, lastPageNumberExclusive) => {
            assertOpen();
            return readRange(firstPageNumber, lastPageNumberExclusive);
        },
        forEachChunk: async onChunk => {
            assertOpen();
            for (let firstPageNumber = 1; firstPageNumber <= pageCount; firstPageNumber += maxReadPages) {
                await onChunk(
                    readRange(firstPageNumber, Math.min(pageCount + 1, firstPageNumber + maxReadPages)),
                    firstPageNumber,
                );
            }
        },
        close: async () => {
            closed = true;
            records.clear();
        },
    };
}
