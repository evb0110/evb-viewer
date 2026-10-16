import {vi} from 'vitest';
import type * as TScanCleanupInputLimits from '@contracts/scan-cleanup/inputLimits';

// Loads the conversion pipeline with another streaming batch size, so a test can
// cross a batch boundary with a few pages instead of the production batch. The
// module graph is fresh only for this load; other tests keep the production batch.
export async function loadScanCleanupPipelineWithBatchPages(batchPages: number) {
    vi.resetModules();
    vi.doMock('@contracts/scan-cleanup/inputLimits', async importOriginal => ({
        ...await importOriginal<typeof TScanCleanupInputLimits>(),
        SCAN_CLEANUP_STREAMING_BATCH_PAGES: batchPages,
    }));
    try {
        return await import('@evb/scan-cleanup/core/runScanCleanupConversion');
    } finally {
        vi.doUnmock('@contracts/scan-cleanup/inputLimits');
    }
}
