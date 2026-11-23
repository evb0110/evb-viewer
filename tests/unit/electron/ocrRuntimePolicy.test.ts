import {
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IHostResourceProfileSnapshot,
    THostResourceTier,
} from '@contracts/hostResourceProfile';
import {
    encodePnm,
    readPnmSize,
} from '@ocr-core/ppmRaster';
import {
    resolveOcrLaneResources,
    resolveOcrRuntimePolicy,
} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {
    createOcrWorkerPipelineHarness,
    hasOcrWorkerPipelineTools,
    type IOcrWorkerPipelineHarness,
} from '@tests/helpers/ocrWorkerPipelineHarness';

const MIB = 1024 ** 2;
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

    it.each([
        {
            cpus: 32,
            ramGiB: 64,
            lanes: 16,
        },
        {
            cpus: 64,
            ramGiB: 128,
            lanes: 32,
        },
    ])('scales past eight lanes on a $cpus-core, $ramGiB GiB host', ({
        cpus,
        ramGiB,
        lanes,
    }) => {
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(cpus, ramGiB * GIB, 'high'),
            {},
        ).globalPageSlots).toBe(lanes);
    });

    it('keeps a 4 GiB host to one lane whatever its tier or override', () => {
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(16, 4 * GIB, 'high'),
            {},
        ).globalPageSlots).toBe(1);
        expect(resolveOcrRuntimePolicy(
            createResourceProfile(16, 4 * GIB, 'high'),
            {OCR_GLOBAL_PAGE_SLOTS: '6'},
        ).globalPageSlots).toBe(1);
    });

    it('gives environment overrides highest precedence within the host cores', () => {
        vi.stubEnv('EVB_OCR_MODEL_DOWNLOAD_CONCURRENCY', '12');
        try {
            expect(resolveOcrRuntimePolicy(
                createResourceProfile(16, 8 * GIB, 'low'),
                {OCR_GLOBAL_PAGE_SLOTS: '12'},
            )).toEqual({
                globalPageSlots: 12,
                modelDownloadConcurrency: 8,
            });
            expect(resolveOcrRuntimePolicy(
                createResourceProfile(6, 8 * GIB, 'low'),
                {OCR_GLOBAL_PAGE_SLOTS: '12'},
            ).globalPageSlots).toBe(6);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('resolveOcrLaneResources', () => {
    const capacity = {
        cpuTokens: 8,
        estimatedResidentBytes: 16 * GIB,
        nativeProcesses: 4,
        ioWeight: 4,
    };

    it('charges two and a half times the models plus the page heap', () => {
        const image = encodePnm(2_000, 3_000, 1, new Uint8Array(2_000 * 3_000));

        expect(resolveOcrLaneResources(40 * MIB, image, capacity)).toEqual({
            cpuTokens: 1,
            estimatedResidentBytes: 100 * MIB + 192 * MIB + 2_000 * 3_000 * 12,
            nativeProcesses: 0,
            ioWeight: 0,
        });
    });

    it('never asks for more memory than the broker has', () => {
        const image = encodePnm(10, 10, 3, new Uint8Array(300));

        expect(resolveOcrLaneResources(4 * GIB, image, {
            ...capacity,
            estimatedResidentBytes: 2 * GIB,
        }).estimatedResidentBytes).toBe(2 * GIB);
    });
});

describe('desktop OCR job billing', () => {
    let harness: IOcrWorkerPipelineHarness | undefined;

    afterEach(async () => {
        await harness?.close();
        if (harness) {
            await rm(harness.root, {
                recursive: true,
                force: true,
            });
        }
        harness = undefined;
        vi.unstubAllEnvs();
    });

    it('holds a broker lease of 2.5 x the installed model bytes plus the page heap while the engine runs', async (context) => {
        if (!await hasOcrWorkerPipelineTools()) {
            context.skip();
            return;
        }
        const {mainJobBroker} = await import('@electron/resources/jobBroker');
        const charges: Array<{
            used: number;
            expected: number;
        }> = [];
        const modelBytes = 3 * MIB + 17;
        harness = await createOcrWorkerPipelineHarness({
            pageCount: 2,
            onEngineRequest: (request) => {
                const {
                    width,
                    height,
                } = readPnmSize(request.image);
                charges.push({
                    used: mainJobBroker.getSnapshot().used.estimatedResidentBytes,
                    expected: Math.ceil(2.5 * modelBytes + 192 * MIB + width * height * 12),
                });
            },
        });
        await writeFile(join(harness.root, 'eng.traineddata'), new Uint8Array(modelBytes));

        const {result} = await harness.start('ocr-billing');

        // Both pages reach the engine before the job writes its PDF.
        expect(charges, JSON.stringify(result)).toHaveLength(2);
        for (const charge of charges) expect(charge.used).toBe(charge.expected);
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });
});
