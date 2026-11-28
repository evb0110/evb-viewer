import {beforeEach, describe, expect, it, vi} from 'vitest';
import {JobBroker, type IJobBrokerRunContext} from '@electron/resources/jobBroker';
import {OCR_PREPROCESS_BASE_RESIDENT_BYTES, OCR_PREPROCESS_BYTES_PER_PIXEL} from '@electron/features/ocr/main/ocrRuntimePolicy';
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
        mocks.stat.mockResolvedValue({size: 1024});
        mocks.readFile.mockResolvedValue('{}');
        mocks.rm.mockResolvedValue(undefined);
        mocks.decodeMetadata.mockReturnValue({inverseTransform: null});
    });

    it('refuses raw-input fallback when preprocessing termination is unproven', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const failure = markUnprovenNativeTermination(new Error('timeout'), 'child remains alive');
        mocks.runOcrCommand.mockRejectedValueOnce(failure);
        await expect(
            tryPreprocessOcrImage('/raw.png', '/clean.png', mocks.log, new AbortController().signal, undefined, '/scan-cleanup'),
        ).rejects.toBe(failure);
    });

    it('uses native scan cleanup with pinned pixel options', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const controller = new AbortController();

        await expect(
            tryPreprocessOcrImage(
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                controller.signal,
                undefined,
                '/bin/evb-scan-cleanup',
                '/tmp/clean.json',
                288,
            ),
        ).resolves.toEqual({path: '/tmp/clean.png'});

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
            await expect(
                tryPreprocessOcrImage(
                    '/tmp/raw.png',
                    '/tmp/clean.png',
                    mocks.log,
                    new AbortController().signal,
                    undefined,
                    '/bin/evb-scan-cleanup',
                    '/tmp/clean.json',
                    300,
                    'clean',
                    1,
                ),
            ).resolves.toEqual({path: '/tmp/clean.png'});
            expect(mocks.runOcrCommand.mock.calls[0]?.[2].env.RAYON_NUM_THREADS).toBe('1');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('returns the native inverse transform for same-size deskew output', async () => {
        const inverseTransform = {
            matrix: [
                [1, 0, -12],
                [0, 1, 8],
                [0, 0, 1],
            ],
        };
        mocks.decodeMetadata.mockReturnValue({inverseTransform});
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(
            tryPreprocessOcrImage(
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                new AbortController().signal,
                undefined,
                '/bin/evb-scan-cleanup',
                '/tmp/clean.json',
            ),
        ).resolves.toEqual({
            path: '/tmp/clean.png',
            inverseTransform,
        });
    });

    it('uses only polarity correction for preprocessing-off OCR', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(
            tryPreprocessOcrImage(
                '/tmp/raw.png',
                '/tmp/polarity.png',
                mocks.log,
                new AbortController().signal,
                undefined,
                '/bin/evb-scan-cleanup',
                '/tmp/polarity.json',
                300,
                'polarity-only',
            ),
        ).resolves.toEqual({path: '/tmp/polarity.png'});

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
        mocks.decodeMetadata.mockReturnValue({
            inverseTransform: {
                matrix: [
                    [1, 0, 0],
                    [0, 0, 0],
                    [0, 0, 1],
                ],
            },
        });
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(
            tryPreprocessOcrImage(
                '/tmp/raw.png',
                '/tmp/clean.png',
                mocks.log,
                new AbortController().signal,
                undefined,
                '/bin/evb-scan-cleanup',
                '/tmp/clean.json',
            ),
        ).resolves.toEqual({path: '/tmp/raw.png'});
        expect(mocks.log).toHaveBeenCalledWith('warn', expect.stringContaining('metadata is unusable'));
    });

    it('uses the original image without launching a substitute when scan cleanup is unavailable', async () => {
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        const onDiagnostic = vi.fn();
        await expect(
            tryPreprocessOcrImage('/tmp/raw.png', '/tmp/clean.png', mocks.log, new AbortController().signal, onDiagnostic),
        ).resolves.toEqual({path: '/tmp/raw.png'});
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({code: 'OCR_PREPROCESSING_UNAVAILABLE'}));
    });

    it('propagates preprocessing aborts instead of falling back', async () => {
        const abortError = new Error('aborted');
        mocks.runOcrCommand.mockRejectedValue(abortError);
        const controller = new AbortController();
        controller.abort();
        const {tryPreprocessOcrImage} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');

        await expect(
            tryPreprocessOcrImage('/tmp/raw.png', '/tmp/clean.png', mocks.log, controller.signal, undefined, '/bin/evb-scan-cleanup'),
        ).rejects.toBe(abortError);
    });

    it('reads only the PNM header of the rendered page in prepareOcrPageRaster when cleanup succeeds', async () => {
        const renderedPpm = Buffer.concat([Buffer.from('P6\n2 1\n255\n', 'ascii'), Buffer.from([10, 20, 30, 240, 240, 240])]);
        const cleanedPgm = Buffer.concat([Buffer.from('P5\n2 1\n255\n', 'ascii'), Buffer.from([0, 255])]);
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
            if (path === '/tmp/page-1.ppm-clean.pnm') {
                return cleanedPgm;
            }
            if (path === '/tmp/page-1.ppm-clean.pnm.json') {
                return '{}';
            }
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
            if (path === '/tmp/page-2.ppm-clean.pnm.json') {
                return '{}';
            }
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

    it('acquires an explicit broker lease matching cleanupThreads and decoded raster memory for clean and polarity-only modes', async () => {
        const MIB = 1024 * 1024;
        const GIB = 1024 * MIB;
        const width = 2_480;
        const height = 3_508;
        const renderedPpm = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
        const cleanedPgm = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
        mocks.open.mockImplementation(async (path: string) => {
            const source = path.endsWith('-clean.pnm') ? cleanedPgm : renderedPpm;
            return {
                read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                    const bytesRead = source.copy(buffer, offset, position, Math.min(source.length, position + length));
                    return {bytesRead};
                },
                close: async () => undefined,
            };
        });
        mocks.readFile.mockResolvedValue('{}');

        // 8-core / 8 GiB auto-tier broker where clean mode requests 6 Rayon threads.
        const broker = new JobBroker({
            cpuTokens: 6,
            estimatedResidentBytes: 6 * GIB,
            nativeProcesses: 4,
            ioWeight: 4,
        });
        const observedClean: Array<{
            used: ReturnType<JobBroker['getSnapshot']>['used'];
            rayonThreads: string | undefined;
            hasBrokerRun: boolean;
            leaseActive: boolean;
        }> = [];
        mocks.runOcrCommand.mockImplementationOnce(
            async (_cmd: string, _args: string[], options: {env?: NodeJS.ProcessEnv; brokerRun?: IJobBrokerRunContext}) => {
                observedClean.push({
                    used: broker.getSnapshot().used,
                    rayonThreads: options.env?.RAYON_NUM_THREADS,
                    hasBrokerRun: options.brokerRun !== undefined,
                    leaseActive: options.brokerRun ? broker.isRunningLease(options.brokerRun.lease) : false,
                });
                return {stdout: '', stderr: ''};
            },
        );

        const {prepareOcrPageRasterFile} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
        await prepareOcrPageRasterFile({
            renderedPath: '/tmp/page-clean.ppm',
            pageNumber: 1,
            dpi: 300,
            cleanupMode: 'clean',
            scanCleanupBinary: '/bin/evb-scan-cleanup',
            cleanupThreads: 6,
            broker,
            brokerOwnerId: 'ocr:job-clean',
            log: mocks.log,
            signal: new AbortController().signal,
        });

        expect(observedClean).toEqual([
            {
                used: {
                    cpuTokens: 6,
                    estimatedResidentBytes: OCR_PREPROCESS_BASE_RESIDENT_BYTES + width * height * OCR_PREPROCESS_BYTES_PER_PIXEL.clean,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                rayonThreads: '6',
                hasBrokerRun: true,
                leaseActive: true,
            },
        ]);
        expect(broker.getSnapshot().active).toBe(0);

        const observedPolarity: Array<{
            used: ReturnType<JobBroker['getSnapshot']>['used'];
            rayonThreads: string | undefined;
        }> = [];
        mocks.runOcrCommand.mockImplementationOnce(async (_cmd: string, _args: string[], options: {env?: NodeJS.ProcessEnv}) => {
            observedPolarity.push({
                used: broker.getSnapshot().used,
                rayonThreads: options.env?.RAYON_NUM_THREADS,
            });
            return {stdout: '', stderr: ''};
        });

        await prepareOcrPageRasterFile({
            renderedPath: '/tmp/page-polarity.ppm',
            pageNumber: 2,
            dpi: 300,
            cleanupMode: 'polarity-only',
            scanCleanupBinary: '/bin/evb-scan-cleanup',
            cleanupThreads: 1,
            broker,
            brokerOwnerId: 'ocr:job-polarity',
            log: mocks.log,
            signal: new AbortController().signal,
        });

        expect(observedPolarity).toEqual([
            {
                used: {
                    cpuTokens: 1,
                    estimatedResidentBytes:
                        OCR_PREPROCESS_BASE_RESIDENT_BYTES + width * height * OCR_PREPROCESS_BYTES_PER_PIXEL['polarity-only'],
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                rayonThreads: '1',
            },
        ]);
        expect(broker.getSnapshot().active).toBe(0);

        // Requesting 12 threads against a 2-token broker must clamp both the lease and RAYON_NUM_THREADS to 2.
        const smallBroker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 6 * GIB,
            nativeProcesses: 2,
            ioWeight: 2,
        });
        let clampedThreads: string | undefined;
        let clampedCpuTokens = 0;
        mocks.runOcrCommand.mockImplementationOnce(async (_cmd: string, _args: string[], options: {env?: NodeJS.ProcessEnv}) => {
            clampedThreads = options.env?.RAYON_NUM_THREADS;
            clampedCpuTokens = smallBroker.getSnapshot().used.cpuTokens;
            return {stdout: '', stderr: ''};
        });
        await prepareOcrPageRasterFile({
            renderedPath: '/tmp/page-clamped.ppm',
            pageNumber: 3,
            dpi: 300,
            cleanupMode: 'clean',
            scanCleanupBinary: '/bin/evb-scan-cleanup',
            cleanupThreads: 12,
            broker: smallBroker,
            brokerOwnerId: 'ocr:job-clamped',
            log: mocks.log,
            signal: new AbortController().signal,
        });
        expect(clampedCpuTokens).toBe(2);
        expect(clampedThreads).toBe('2');
        expect(smallBroker.getSnapshot().active).toBe(0);
    });

    it('falls back to raw raster with diagnostic on broker admission failure while still propagating aborts', async () => {
        const renderedPpm = Buffer.from('P6\n100 100\n255\n', 'ascii');
        mocks.open.mockResolvedValue({
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                const bytesRead = renderedPpm.copy(buffer, offset, position, Math.min(renderedPpm.length, position + length));
                return {bytesRead};
            },
            close: async () => undefined,
        });

        const broker = new JobBroker(
            {
                cpuTokens: 1,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            {maxQueuedJobs: 1},
        );
        const activeLease = await broker.acquire({
            ownerId: 'busy-owner',
            kind: 'busy',
            priority: 'user',
            resources: {cpuTokens: 1, estimatedResidentBytes: 0, nativeProcesses: 1, ioWeight: 1},
        });
        const queuedAbort = new AbortController();
        const queuedLease = broker.acquire({
            ownerId: 'queued-owner',
            kind: 'queued',
            priority: 'user',
            resources: {cpuTokens: 1, estimatedResidentBytes: 0, nativeProcesses: 1, ioWeight: 1},
            signal: queuedAbort.signal,
        });
        void queuedLease.catch(() => undefined);

        try {
            const {prepareOcrPageRasterFile} = await import('@electron/features/ocr/pipeline/tryPreprocessOcrImage');
            const fallbackResult = await prepareOcrPageRasterFile({
                renderedPath: '/tmp/page-full-queue.ppm',
                pageNumber: 1,
                dpi: 300,
                cleanupMode: 'clean',
                scanCleanupBinary: '/bin/evb-scan-cleanup',
                cleanupThreads: 1,
                broker,
                brokerOwnerId: 'ocr:job-full',
                log: mocks.log,
                signal: new AbortController().signal,
            });
            expect(fallbackResult).toEqual({
                width: 100,
                height: 100,
                image: {kind: 'file', path: '/tmp/page-full-queue.ppm', width: 100, height: 100},
                diagnostic: expect.objectContaining({
                    code: 'OCR_PREPROCESSING_FAILED',
                    pageNumber: 1,
                }),
            });
            expect(mocks.runOcrCommand).not.toHaveBeenCalled();

            // Aborting while waiting in the broker queue must propagate rather than falling back.
            queuedAbort.abort();
            const cancelController = new AbortController();
            const waitingPreprocess = prepareOcrPageRasterFile({
                renderedPath: '/tmp/page-aborted.ppm',
                pageNumber: 2,
                dpi: 300,
                cleanupMode: 'clean',
                scanCleanupBinary: '/bin/evb-scan-cleanup',
                cleanupThreads: 1,
                broker,
                brokerOwnerId: 'ocr:job-abort',
                log: mocks.log,
                signal: cancelController.signal,
            });
            await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
            cancelController.abort(new DOMException('canceled preprocess', 'AbortError'));
            await expect(waitingPreprocess).rejects.toMatchObject({name: 'AbortError'});
        } finally {
            queuedAbort.abort();
            activeLease.release();
        }
    });
});
