import {
    iterateScanCleanupPageBatches,
    runScanCleanupPageBatches,
    SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@evb/scan-cleanup/core/pageBatches';
import {
    getScanCleanupPageAt,
    resolveScanCleanupPageScopeLazy,
} from '@evb/scan-cleanup/core/pageScope';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('scan-cleanup page batching', () => {
    it.each([
        [
            SCAN_CLEANUP_STREAMING_BATCH_PAGES,
            true,
        ],
        [
            SCAN_CLEANUP_STREAMING_BATCH_PAGES + 1,
            false,
        ],
        [
            2_646,
            false,
        ],
    ])('keeps the all-document scope array-free at the streaming boundary (%s pages)', (pageCount, isArray) => {
        const scope = resolveScanCleanupPageScopeLazy(undefined, pageCount);

        expect(Array.isArray(scope)).toBe(isArray);
        expect(scope.length).toBe(pageCount);
    });

    it('keeps a large all-document scope lazy', () => {
        const scope = resolveScanCleanupPageScopeLazy(undefined, SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1);

        expect(Array.isArray(scope)).toBe(false);
        expect(scope.length).toBe(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1);
        expect(getScanCleanupPageAt(scope, 0)).toBe(1);
        expect(getScanCleanupPageAt(scope, scope.length - 1))
            .toBe(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1);
    });

    it('continues across the native manifest boundary in source order', async () => {
        const processed: number[] = [];
        const progress: number[] = [];

        await runScanCleanupPageBatches(
            SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1,
            async batch => {
                for (
                    let pageNumber = batch.startOffset + 1;
                    pageNumber <= batch.endOffsetExclusive;
                    pageNumber += 1
                ) {
                    processed.push(pageNumber);
                }
            },
            {onBatchComplete: batch => progress.push(batch.endOffsetExclusive)},
        );

        expect([...iterateScanCleanupPageBatches(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1)]).toEqual([
            {
                batchIndex: 0,
                startOffset: 0,
                endOffsetExclusive: SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
            },
            {
                batchIndex: 1,
                startOffset: SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
                endOffsetExclusive: SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1,
            },
        ]);
        expect(progress).toEqual([
            SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
            SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1,
        ]);
        expect(processed).toHaveLength(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1);
        expect(processed[SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES - 1]).toBe(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES);
        expect(processed[SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES]).toBe(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1);
    });

    it('stops before the next batch when cancellation arrives', async () => {
        const controller = new AbortController();
        const batches: number[] = [];

        await expect(runScanCleanupPageBatches(
            SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1,
            async batch => {
                batches.push(batch.batchIndex);
                controller.abort();
            },
            {signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});
        expect(batches).toEqual([0]);
    });

    it('runs both sides of the 20,000-page boundary without a document page list', async () => {
        const totalPages = SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1;
        const scope = resolveScanCleanupPageScopeLazy(undefined, totalPages);
        const invocations: Array<{
            start: number;
            length: number
        }> = [];

        await runScanCleanupPageBatches(scope.length, async batch => {
            invocations.push({
                start: batch.startOffset + 1,
                length: batch.endOffsetExclusive - batch.startOffset,
            });
        });

        expect(Array.isArray(scope)).toBe(false);
        expect(invocations).toEqual([
            {
                start: 1,
                length: SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
            },
            {
                start: SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES + 1,
                length: 1,
            },
        ]);
    });

    it('cancels a million-page scope after bounded native work', async () => {
        const totalPages = 1_000_000;
        const scope = resolveScanCleanupPageScopeLazy(undefined, totalPages);
        const controller = new AbortController();
        const invocations: number[] = [];

        await expect(runScanCleanupPageBatches(
            scope.length,
            async batch => {
                invocations.push(batch.batchIndex);
                if (batch.batchIndex === 1) controller.abort();
            },
            {signal: controller.signal},
        )).rejects.toMatchObject({name: 'AbortError'});

        expect(Array.isArray(scope)).toBe(false);
        expect(invocations).toEqual([
            0,
            1,
        ]);
        expect([...iterateScanCleanupPageBatches(totalPages)].length).toBe(50);
    });
});
