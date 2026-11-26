import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    runOcrCommand: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    log: vi.fn(),
    decodeMetadata: vi.fn(),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runOcrCommand}));
vi.mock('fs/promises', () => ({
    open: mocks.open,
    stat: mocks.stat,
    readFile: mocks.readFile,
    rm: mocks.rm,
}));
vi.mock('@contracts/scan-cleanup/nativeArtifactCodecs', () => ({decodeNativeScanCleanupOutputMetadataJson: mocks.decodeMetadata}));

describe('tryPreprocessOcrImage', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
        });
        mocks.stat.mockResolvedValue({ size: 1024 });
        mocks.readFile.mockResolvedValue('{}');
        mocks.rm.mockResolvedValue(undefined);
        mocks.decodeMetadata.mockReturnValue({inverseTransform: null});
    });

    it('refuses raw-input fallback when preprocessing termination is unproven', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const failure = markUnprovenNativeTermination(new Error('timeout'), 'child remains alive');
        mocks.runOcrCommand.mockRejectedValueOnce(failure);
        await expect(tryPreprocessOcrImage('/raw.png', '/clean.png', mocks.log,
            new AbortController().signal, undefined, '/scan-cleanup')).rejects.toBe(failure);
    });

    it('uses native scan cleanup with pinned pixel options', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const controller = new AbortController();

        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
            undefined,
            '/bin/evb-scan-cleanup',
            '/tmp/clean.json',
            288,
        )).resolves.toEqual({path: '/tmp/clean.png'});

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

    it('uses the granted Rayon allowance even when the parent environment requests more threads', async () => {
        vi.stubEnv('RAYON_NUM_THREADS', '16');
        try {
            const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
            await expect(tryPreprocessOcrImage(
                '/tmp/raw.png', '/tmp/clean.png', mocks.log, new AbortController().signal,
                undefined, '/bin/evb-scan-cleanup', '/tmp/clean.json', 300, 'clean', 1,
            )).resolves.toEqual({path: '/tmp/clean.png'});
            expect(mocks.runOcrCommand.mock.calls[0]?.[2].env.RAYON_NUM_THREADS).toBe('1');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('returns the native inverse transform for same-size deskew output', async () => {
        const inverseTransform = {matrix: [
            [
                1,
                0,
                -12,
            ],
            [
                0,
                1,
                8,
            ],
            [
                0,
                0,
                1,
            ],
        ]};
        mocks.decodeMetadata.mockReturnValue({inverseTransform});
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
            undefined,
            '/bin/evb-scan-cleanup',
            '/tmp/clean.json',
        )).resolves.toEqual({
            path: '/tmp/clean.png',
            inverseTransform,
        });
    });

    it('uses only polarity correction for preprocessing-off OCR', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/polarity.png',
            mocks.log,
            new AbortController().signal,
            undefined,
            '/bin/evb-scan-cleanup',
            '/tmp/polarity.json',
            300,
            'polarity-only',
        )).resolves.toEqual({path: '/tmp/polarity.png'});

        const nativeArgs: string[] = mocks.runOcrCommand.mock.calls[0]?.[1] ?? [];
        const options = JSON.parse(nativeArgs[nativeArgs.indexOf('--options') + 1] ?? '{}');
        expect(options).toMatchObject({
            ocrMode: true,
            ocrPolarityOnly: true,
            normalizeIllumination: false,
            despeckle: false,
            layout: 'force-single',
            cropContent: false,
            matchPageSize: false,
        });
        expect(options.margins).toEqual({
            leftMm: 0,
            topMm: 0,
            rightMm: 0,
            bottomMm: 0,
        });
    });

    it('falls back before recognition when native geometry metadata is singular', async () => {
        mocks.decodeMetadata.mockReturnValue({inverseTransform: {matrix: [
            [
                1,
                0,
                0,
            ],
            [
                0,
                0,
                0,
            ],
            [
                0,
                0,
                1,
            ],
        ]}});
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
            undefined,
            '/bin/evb-scan-cleanup',
            '/tmp/clean.json',
        )).resolves.toEqual({path: '/tmp/raw.png'});
        expect(mocks.log).toHaveBeenCalledWith('warn', expect.stringContaining('metadata is unusable'));
    });

    it('uses the original image without launching a substitute when scan cleanup is unavailable', async () => {
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const onDiagnostic = vi.fn();
        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            new AbortController().signal,
            onDiagnostic,
        )).resolves.toEqual({path: '/tmp/raw.png'});
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({code: 'OCR_PREPROCESSING_UNAVAILABLE'}));
    });

    it('propagates preprocessing aborts instead of falling back', async () => {
        const abortError = new Error('aborted');
        mocks.runOcrCommand.mockRejectedValue(abortError);
        const controller = new AbortController();
        controller.abort();
        const { tryPreprocessOcrImage } = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(tryPreprocessOcrImage(
            '/tmp/raw.png',
            '/tmp/clean.png',
            mocks.log,
            controller.signal,
            undefined,
            '/bin/evb-scan-cleanup',
        )).rejects.toBe(abortError);
    });

    it('reads only the PNM header of the rendered page in prepareOcrPageRaster when cleanup succeeds', async () => {
        const renderedPpm = Buffer.concat([
            Buffer.from('P6\n2 1\n255\n', 'ascii'),
            Buffer.from([
                10,
                20,
                30,
                240,
                240,
                240,
            ]),
        ]);
        const cleanedPgm = Buffer.concat([
            Buffer.from('P5\n2 1\n255\n', 'ascii'),
            Buffer.from([
                0,
                255,
            ]),
        ]);
        mocks.open.mockImplementation(async (path: string) => {
            const source = path === '/tmp/page-1.ppm' ? renderedPpm : cleanedPgm;
            return {
                read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const bytesRead = source.copy(buffer, offset, position, Math.min(source.length, position + length));
                    return {bytesRead};
                },
                close: async () => undefined,
            };
        });
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path === '/tmp/page-1.ppm-clean.pnm') return cleanedPgm;
            if (path === '/tmp/page-1.ppm-clean.pnm.json') return '{}';
            throw new Error(`Unexpected full readFile path: ${path}`);
        });
        const {prepareOcrPageRaster} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        const result = await prepareOcrPageRaster({
            renderedPath: '/tmp/page-1.ppm',
            pageNumber: 1,
            dpi: 300,
            cleanupMode: 'polarity-only',
            scanCleanupBinary: '/bin/evb-scan-cleanup',
            log: mocks.log,
            signal: new AbortController().signal,
        });

        const nativeArgs: string[] = mocks.runOcrCommand.mock.calls[0]?.[1] ?? [];
        expect(nativeArgs[nativeArgs.indexOf('--output') + 1]).toBe('/tmp/page-1.ppm-clean.pnm');
        expect(nativeArgs[nativeArgs.indexOf('--metadata') + 1]).toBe('/tmp/page-1.ppm-clean.pnm.json');
        expect(result.width).toBe(2);
        expect(result.height).toBe(1);
        expect(Buffer.from(result.image)).toEqual(cleanedPgm);
        expect(mocks.readFile).not.toHaveBeenCalledWith('/tmp/page-1.ppm');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page-1.ppm-clean.pnm', {force: true});
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page-1.ppm-clean.pnm.json', {force: true});
    });

    it('passes file paths without reading raster bodies in prepareOcrPageRasterFile', async () => {
        const renderedPpm = Buffer.from('P6\n2480 3508\n255\n', 'ascii');
        const cleanedPgm = Buffer.from('P5\n2480 3508\n255\n', 'ascii');
        mocks.open.mockImplementation(async (path: string) => {
            const source = path === '/tmp/page-2.ppm' ? renderedPpm : cleanedPgm;
            return {
                read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const bytesRead = source.copy(buffer, offset, position, Math.min(source.length, position + length));
                    return {bytesRead};
                },
                close: async () => undefined,
            };
        });
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path === '/tmp/page-2.ppm-clean.pnm.json') return '{}';
            throw new Error(`Unexpected full readFile path: ${path}`);
        });
        const {prepareOcrPageRasterFile} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        const result = await prepareOcrPageRasterFile({
            renderedPath: '/tmp/page-2.ppm',
            pageNumber: 2,
            dpi: 300,
            cleanupMode: 'clean',
            scanCleanupBinary: '/bin/evb-scan-cleanup',
            log: mocks.log,
            signal: new AbortController().signal,
        });

        expect(result).toEqual({
            width: 2480,
            height: 3508,
            image: {
                kind: 'file',
                path: '/tmp/page-2.ppm-clean.pnm',
                width: 2480,
                height: 3508,
            },
        });
        expect(mocks.readFile).toHaveBeenCalledTimes(1);
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/page-2.ppm-clean.pnm.json', 'utf8');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page-2.ppm', {force: true});
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page-2.ppm-clean.pnm.json', {force: true});
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/page-2.ppm-clean.pnm', {force: true});
    });
});
