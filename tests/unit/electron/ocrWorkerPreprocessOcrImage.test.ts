import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runOcrCommand: vi.fn(),
    stat: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@electron/features/ocr/worker/runOcrCommand', () => ({runOcrCommand: mocks.runOcrCommand}));
vi.mock('fs/promises', () => ({stat: mocks.stat}));

describe('tryPreprocessOcrImage', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
        });
        mocks.stat.mockResolvedValue({ size: 1024 });
    });

    it('prefers native scan cleanup and does not invoke unpaper after success', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');
        const controller = new AbortController();

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
            undefined,
            '/bin/evb-scan-cleanup',
            '/tmp/clean.json',
            288,
        )).resolves.toBe('/tmp/clean.png');

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/evb-scan-cleanup',
            [
                '--input',
                '/tmp/raw.png',
                '--output',
                '/tmp/clean.png',
                '--metadata',
                '/tmp/clean.json',
                '--ocr-mode',
                '--options',
                expect.any(String),
            ],
            expect.objectContaining({
                commandLabel: 'evb-scan-cleanup(ocr-preprocess)',
                signal: controller.signal,
            }),
        );
        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);

        // OCR input must stay reproducible while viewer-facing cleanup defaults
        // are tuned, so every pixel-affecting option is pinned at the call site
        // rather than inherited from the engine defaults. Any drift in this
        // object is an OCR behaviour change and has to be made deliberately.
        const nativeArgs: string[] = mocks.runOcrCommand.mock.calls[0]?.[1] ?? [];
        const pinnedOptions = nativeArgs[nativeArgs.indexOf('--options') + 1] ?? '{}';
        expect(JSON.parse(pinnedOptions)).toEqual({
            dpi: 288,
            sourceDpi: 288,
            requestedRenderDpi: 288,
            sourceHasBilevelLayer: false,
            binarization: 'auto',
            thickness: 0,
            normalizeIllumination: true,
            despeckle: true,
            despeckleLevel: 'normal',
            outputMode: 'bw',
            ocrMode: true,
            layout: 'auto',
            manualSplit: null,
            manualContentBoxes: {},
            manualZones: {
                picture: [],
                fill: [],
            },
            cropContent: true,
            matchPageSize: true,
            pageAlignment: 'top-center',
            placementOverrides: {},
            margins: {
                leftMm: 5,
                topMm: 5,
                rightMm: 5,
                bottomMm: 5,
            },
            experimental: {autoDewarp: false},
            rotationDegrees: 0,
            excluded: false,
            skipBlankPages: false,
            maxPixels: 160_000_000,
            maxDimensionPx: 40_000,
        });
    });

    it('returns the cleaned image path when unpaper succeeds', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');
        const controller = new AbortController();

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
        )).resolves.toBe('/tmp/clean.png');

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            ['--version'],
            expect.objectContaining({
                commandLabel: 'unpaper(version-probe)',
                timeoutMs: 10_000,
                signal: controller.signal,
                log: expect.any(Function),
            }),
        );
        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            [
                '--layout',
                'single',
                '--deskew-scan-direction',
                'left,right',
                '--no-mask-center',
                '/tmp/raw.png',
                '/tmp/clean.png',
            ],
            expect.objectContaining({
                commandLabel: 'unpaper(ocr-preprocess)',
                signal: controller.signal,
                timeoutMs: 30_000,
                log: expect.any(Function),
            }),
        );
        expect(mocks.stat).toHaveBeenCalledWith('/tmp/clean.png');
    });

    it('falls back to the raw Poppler image when unpaper is unavailable', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');
        const onDiagnostic = vi.fn();

        await expect(tryPreprocessOcrImage(
            undefined,
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
            onDiagnostic,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('unpaper is not bundled'),
        );
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
            code: 'OCR_PREPROCESSING_UNAVAILABLE',
            severity: 'warning',
        }));
    });

    it('falls back to the raw Poppler image when unpaper fails', async () => {
        mocks.runOcrCommand
            .mockResolvedValueOnce({
                stdout: '',
                stderr: '',
            })
            .mockImplementationOnce(async (
                _command: string,
                _args: string[],
                options: {log: (level: 'debug' | 'warn' | 'error', message: string) => void},
            ) => {
                options.log('error', 'unpaper(ocr-preprocess) timed out after 30000ms');
                throw new Error('deskew failed');
            });
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('using raw page render'),
        );
        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            'unpaper(ocr-preprocess) timed out after 30000ms',
        );
        expect(mocks.log).not.toHaveBeenCalledWith(
            'error',
            expect.any(String),
        );
    });

    it('disables preprocessing when the unpaper binary is not runnable', async () => {
        mocks.runOcrCommand.mockRejectedValue(new Error('unpaper exited after signal SIGKILL'));
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/unpaper',
            ['--version'],
            expect.any(Object),
        );
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('not runnable'),
        );
    });

    it('downgrades optional unpaper probe command errors so they do not report as worker errors', async () => {
        mocks.runOcrCommand.mockImplementation(async (
            _command: string,
            _args: string[],
            options: {log: (level: 'debug' | 'warn' | 'error', message: string) => void},
        ) => {
            options.log('error', 'unpaper(version-probe) timed out after 10000ms');
            throw new Error('unpaper(version-probe) timed out after 10000ms');
        });
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            'unpaper(version-probe) timed out after 10000ms',
        );
        expect(mocks.log).not.toHaveBeenCalledWith(
            'error',
            expect.any(String),
        );
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('retries failed unpaper probes after the negative cache ttl expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.stubEnv('EVB_OCR_UNPAPER_NEGATIVE_PROBE_TTL_MS', '1000');
        try {
            mocks.runOcrCommand
                .mockRejectedValueOnce(new Error('temporary probe failure'))
                .mockResolvedValueOnce({
                    stdout: '',
                    stderr: '',
                })
                .mockResolvedValueOnce({
                    stdout: '',
                    stderr: '',
                });
            const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

            await expect(tryPreprocessOcrImage(
                '/bin/unpaper',
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                new AbortController().signal,
            )).resolves.toBe('/tmp/raw.png');
            await Promise.resolve();

            await expect(tryPreprocessOcrImage(
                '/bin/unpaper',
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                new AbortController().signal,
            )).resolves.toBe('/tmp/raw.png');
            expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);

            vi.setSystemTime(1_001);
            await expect(tryPreprocessOcrImage(
                '/bin/unpaper',
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                new AbortController().signal,
            )).resolves.toBe('/tmp/clean.png');
            expect(mocks.runOcrCommand).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });

    it('falls back to the raw Poppler image when unpaper output is empty', async () => {
        mocks.stat.mockResolvedValue({ size: 0 });
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
        )).resolves.toBe('/tmp/raw.png');

        expect(mocks.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('did not produce a usable image'),
        );
    });

    it('propagates preprocessing aborts instead of falling back', async () => {
        const abortError = new Error('aborted');
        mocks.runOcrCommand.mockRejectedValue(abortError);
        const controller = new AbortController();
        controller.abort();
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/worker/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/bin/unpaper',
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
        )).rejects.toBe(abortError);
    });
});
