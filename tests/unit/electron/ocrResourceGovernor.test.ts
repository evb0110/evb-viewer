import type * as TViMockOriginalModule from '@electron/resources/jobBroker';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ocrResourceGovernor as importedOcrResourceGovernor } from '@electron/features/ocr/main/ocrResourceGovernor';

const mocks = vi.hoisted(() => ({
    resourceProfile: {
        logicalCpus: 8,
        totalRamBytes: 16 * 1024 * 1024 * 1024,
        safeMode: false,
        detectedTier: 'high',
        performanceMode: 'auto',
        tier: 'high',
    },
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    brokerAcquire: vi.fn(),
    brokerCancelOwner: vi.fn(),
    brokerCancelPendingOwner: vi.fn(),
    brokerLeaseRelease: vi.fn(),
}));

vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => mocks.resourceProfile}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/resources/jobBroker', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    mainJobBroker: {
        acquire: mocks.brokerAcquire,
        cancelOwner: mocks.brokerCancelOwner,
        cancelPendingOwner: mocks.brokerCancelPendingOwner,
    },
}));

type TOcrResourceGovernor = typeof importedOcrResourceGovernor;

async function loadOcrResourceGovernor(): Promise<TOcrResourceGovernor> {
    return (await import('@electron/features/ocr/main/ocrResourceGovernor')).ocrResourceGovernor;
}

describe('ocr resource governor', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.resourceProfile.logicalCpus = 8;
        mocks.resourceProfile.totalRamBytes = 16 * 1024 * 1024 * 1024;
        mocks.resourceProfile.detectedTier = 'high';
        mocks.resourceProfile.tier = 'high';
        mocks.brokerAcquire.mockImplementation(async (request: {resources: {
            cpuTokens: number;
            estimatedResidentBytes: number;
            nativeProcesses: number;
            ioWeight: number;
        }}) => ({
            token: 'broker-lease',
            resources: request.resources,
            release: mocks.brokerLeaseRelease,
        }));
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        ocrResourceGovernor.reset();
    });

    it('delegates pending cancellation and active release to the shared broker', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        const activeLease = await ocrResourceGovernor.acquire({
            jobId: 'job-a',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
        });
        ocrResourceGovernor.releaseJob('job-a');
        expect(mocks.brokerLeaseRelease).toHaveBeenCalledOnce();
        expect(mocks.brokerCancelOwner).toHaveBeenCalledWith(
            'job-a',
            'OCR resource request cancelled for job job-a',
        );
        expect(ocrResourceGovernor.release(activeLease.token)).toBe(false);
    });

    it('cancels pending page admission without releasing an active page lease', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        const activeLease = await ocrResourceGovernor.acquire({
            jobId: 'job-uncertain',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
        });

        ocrResourceGovernor.cancelPendingForJob('job-uncertain', 'worker termination is uncertain');

        expect(mocks.brokerCancelPendingOwner).toHaveBeenCalledWith(
            'job-uncertain',
            'worker termination is uncertain',
        );
        expect(mocks.brokerLeaseRelease).not.toHaveBeenCalled();
        expect(ocrResourceGovernor.release(activeLease.token)).toBe(true);
    });

    it('grants normal requests while a high-DPI request is active when weighted slots remain', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

        const highDpiLease = await ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
            signal: new AbortController().signal,
        });
        const normalLease = await ocrResourceGovernor.acquire({
            jobId: 'job-normal',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
        });

        expect(normalLease.effectiveDpi).toBe(300);
        ocrResourceGovernor.release(highDpiLease.token);
        ocrResourceGovernor.release(normalLease.token);
    });

    it('admits each page through the cross-feature resource broker', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        const controller = new AbortController();
        const lease = await ocrResourceGovernor.acquire({
            jobId: 'job-brokered',
            pageNumber: 3,
            requestedDpi: 300,
            signal: controller.signal,
        });

        expect(mocks.brokerAcquire).toHaveBeenCalledWith({
            ownerId: 'job-brokered',
            kind: 'ocr-page',
            priority: 'user',
            perOwnerLimit: 4,
            signal: controller.signal,
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 33_660_000,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        ocrResourceGovernor.release(lease.token);
        expect(mocks.brokerLeaseRelease).toHaveBeenCalledOnce();
    });

    it('uses the canonical low tier for admission and high-DPI slot cost', async () => {
        mocks.resourceProfile.detectedTier = 'low';
        mocks.resourceProfile.tier = 'low';
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        const lease = await ocrResourceGovernor.acquire({
            jobId: 'job-low-tier',
            pageNumber: 1,
            requestedDpi: 600,
            signal: new AbortController().signal,
        });

        expect(mocks.brokerAcquire).toHaveBeenCalledWith(expect.objectContaining({
            perOwnerLimit: 1,
            resources: expect.objectContaining({cpuTokens: 1}),
        }));
        ocrResourceGovernor.release(lease.token);
    });

    it('does not create a local lease when cross-feature admission fails', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        mocks.brokerAcquire.mockRejectedValueOnce(new Error('global memory pressure'));

        await expect(ocrResourceGovernor.acquire({
            jobId: 'job-rejected',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
        })).rejects.toThrow('global memory pressure');

        const nextLease = await ocrResourceGovernor.acquire({
            jobId: 'job-after-rejection',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
        });
        ocrResourceGovernor.release(nextLease.token);
    });

    it('rejects huge pages instead of silently lowering requested OCR quality', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

        await expect(ocrResourceGovernor.acquire({
            jobId: 'job-huge-page',
            pageNumber: 1,
            requestedDpi: 300,
            signal: new AbortController().signal,
            pageWidthIn: 500,
            pageHeightIn: 500,
        })).rejects.toThrow('Choose a lower quality setting explicitly');
    });

});
