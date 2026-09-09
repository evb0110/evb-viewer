import {
    SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@contracts/scan-cleanup/inputLimits';
import type {TScanCleanupPageScope} from '@evb/scan-cleanup/core/pageScope';

/**
 * The native protocol admits one bounded manifest at a time. This is a
 * transport and residency budget, not a source-document page limit.
 */
export {
    SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
};

export interface IScanCleanupPageBatch {
    batchIndex: number;
    startOffset: number;
    endOffsetExclusive: number;
}

/** Iterate bounded ranges without materializing a document page list. */
export function *iterateScanCleanupPageBatches(
    totalItems: number,
    batchSize = SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
): Generator<IScanCleanupPageBatch> {
    if (!Number.isSafeInteger(totalItems) || totalItems < 0) {
        throw new Error('Scan cleanup batch item count must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
        throw new Error('Scan cleanup batch size must be a positive safe integer');
    }
    let batchIndex = 0;
    for (let startOffset = 0; startOffset < totalItems; startOffset += batchSize) {
        yield {
            batchIndex,
            startOffset,
            endOffsetExclusive: Math.min(totalItems, startOffset + batchSize),
        };
        batchIndex += 1;
    }
}

export function collectScanCleanupPageBatch<T>(
    values: readonly T[],
    batch: IScanCleanupPageBatch,
) {
    return values.slice(batch.startOffset, batch.endOffsetExclusive);
}

export function collectScanCleanupPageScopeBatch(
    pageScope: TScanCleanupPageScope,
    batch: IScanCleanupPageBatch,
) {
    if (!('startPageNumber' in pageScope)) {
        return pageScope.slice(batch.startOffset, batch.endOffsetExclusive);
    }
    const startPageNumber = pageScope.startPageNumber + batch.startOffset;
    return Array.from(
        {length: batch.endOffsetExclusive - batch.startOffset},
        (_, index) => startPageNumber + index,
    );
}

export async function runScanCleanupPageBatches(
    totalItems: number,
    task: (batch: IScanCleanupPageBatch) => Promise<void>,
    options: {
        batchSize?: number;
        signal?: AbortSignal;
        onBatchComplete?: (batch: IScanCleanupPageBatch) => void
    } = {},
) {
    for (const batch of iterateScanCleanupPageBatches(totalItems, options.batchSize)) {
        options.signal?.throwIfAborted();
        await task(batch);
        options.onBatchComplete?.(batch);
    }
}
