import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';
import { resolveOcrRuntimePolicy } from '@electron/features/ocr/main/ocrRuntimePolicy';

const GIB = 1024 ** 3;

function createResourceProfile(
    logicalCpus: number,
    totalRamBytes: number,
    tier: THostResourceTier,
): IHostResourceProfileSnapshot {
    return {
        logicalCpus,
        totalRamBytes,
        safeMode: false,
        detectedTier: tier,
        performanceMode: 'auto',
        tier,
    };
}

describe('resolveOcrRuntimePolicy', () => {
    it.each([
        {
            tier: 'low',
            modelDownloadConcurrency: 1,
        },
        {
            tier: 'medium',
            modelDownloadConcurrency: 3,
        },
        {
            tier: 'high',
            modelDownloadConcurrency: 3,
        },
    ] satisfies Array<{
        tier: THostResourceTier;
        modelDownloadConcurrency: number;
    }>)('resolves the $tier tier model download limit', ({
        tier,
        modelDownloadConcurrency,
    }) => {
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(4, 8 * GIB, tier),
            {},
        )).toMatchObject({modelDownloadConcurrency});
    });

    it('preserves the existing medium and high formulas', () => {
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(8, 16 * GIB, 'medium'),
            {},
        ).globalPageSlots).toBe(4);
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(16, 32 * GIB, 'high'),
            {},
        ).globalPageSlots).toBe(8);
    });

    it('gives environment overrides highest precedence', () => {
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(2, 4 * GIB, 'low'),
            {
                OCR_GLOBAL_PAGE_SLOTS: '12',
                EVB_OCR_MODEL_DOWNLOAD_CONCURRENCY: '12',
            },
        )).toEqual({
            globalPageSlots: 8,
            modelDownloadConcurrency: 8,
        });
    });
});
