import {
    describe,
    expect,
    it,
    vi,
    beforeEach,
} from 'vitest';

const mockElectronAPI = {
    onOcrProgress: vi.fn(),
    onOcrComplete: vi.fn(),
    ocrCreateSearchablePdf: vi.fn(),
    ocrCancel: vi.fn(),
    ocrGetLanguages: vi.fn(),
    saveDocxAs: vi.fn(),
    writeDocxFile: vi.fn(),
    readFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
};

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => mockElectronAPI}));

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
});

const { useOcr } = await import('@app/composables/useOcr');

async function waitForCondition(
    condition: () => boolean,
    timeoutMs = 500,
) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        if (condition()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for condition');
}

describe('useOcr', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockElectronAPI.onOcrProgress.mockReturnValue(vi.fn());
        mockElectronAPI.onOcrComplete.mockReturnValue(vi.fn());
        mockElectronAPI.ocrCreateSearchablePdf.mockResolvedValue({
            started: true,
            jobId: 'job-1',
        });
        mockElectronAPI.ocrCancel.mockResolvedValue({ canceled: true });
    });

    it('settles runOcr when canceled before completion', async () => {
        const progressUnsubscribe = vi.fn();
        const completeUnsubscribe = vi.fn();
        mockElectronAPI.onOcrProgress.mockReturnValue(progressUnsubscribe);
        mockElectronAPI.onOcrComplete.mockReturnValue(completeUnsubscribe);

        const ocr = useOcr();
        const runPromise = ocr.runOcr(
            {} as never,
            new Uint8Array([
                1,
                2,
                3,
            ]),
            1,
            1,
            '/tmp/work.pdf',
        );

        await waitForCondition(() => mockElectronAPI.ocrCreateSearchablePdf.mock.calls.length > 0);
        ocr.cancelOcr();

        const settled = await Promise.race([
            runPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => {
                setTimeout(() => resolve('timeout'), 100);
            }),
        ]);

        expect(settled).toBe('resolved');
        expect(mockElectronAPI.ocrCancel).toHaveBeenCalledTimes(1);
        expect(progressUnsubscribe).toHaveBeenCalledTimes(1);
        expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
        expect(ocr.progress.value.isRunning).toBe(false);
        expect(ocr.error.value).toBeNull();
    });
});
