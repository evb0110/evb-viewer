import {
    describe,
    expect,
    it,
} from 'vitest';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {completedPageProgress} from '@evb/scan-cleanup/core/detection';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';

function decodeProgress(partial: ReturnType<typeof completedPageProgress>, completedUnits: number) {
    return () => SCAN_CLEANUP_PROGRESS_SCHEMA.decode({
        stage: 'detecting',
        completedUnits,
        totalUnits: 138_000,
        percent: 0,
        ...partial,
    });
}

describe('completedPageProgress', () => {
    it('reports the full list when every completed page was classified', () => {
        const progress = completedPageProgress(new Set([
            1,
            2,
            3,
        ]), 3);
        expect(progress).toEqual({completedPageNumbers: [
            1,
            2,
            3,
        ]});
        expect(decodeProgress(progress, 3)).not.toThrow();
    });

    it('flags a bounded prefix when pages completed without a classification', () => {
        const progress = completedPageProgress(new Set([
            1,
            3,
        ]), 5);
        expect(progress.completedPageNumbersTruncated).toBe(true);
        expect(decodeProgress(progress, 5)).not.toThrow();
    });

    it('caps a document-sized list at the IPC entry limit', () => {
        const reported = new Set(Array.from({length: SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 5}, (_, index) => index + 1));
        const progress = completedPageProgress(reported, reported.size);
        expect(progress.completedPageNumbers).toHaveLength(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
        expect(progress.completedPageNumbersTruncated).toBe(true);
        expect(decodeProgress(progress, reported.size)).not.toThrow();
    });
});
