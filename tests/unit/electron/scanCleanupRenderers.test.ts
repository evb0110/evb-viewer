import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {IRunNativeToolCommandOptions} from '@electron/native-tools/runNativeToolCommand';
import {createOcrJobStorageBudget} from '@electron/features/ocr/pipeline/ocrJobStorageBudget';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import type * as FsPromises from 'node:fs/promises';
import {decode} from 'fast-png';
import type * as RasterLayerDimensions from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';

const mocks = vi.hoisted(() => ({
    readPngDimensions: vi.fn(),
    readPpmDimensions: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    runCommand: vi.fn(),
    acquire: vi.fn(),
    writePngFromPpm: vi.fn(),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runCommand}));
vi.mock('@electron/features/ocr/main/ocrRuntimePolicy', () => ({getOcrRuntimePolicy: () => ({globalPageSlots: 2})}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {
    acquire: mocks.acquire,
    getSnapshot: () => ({capacity: {cpuTokens: 2}}),
}}));

vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({
    readPngDimensions: mocks.readPngDimensions,
    readPpmDimensions: mocks.readPpmDimensions,
    writePngFromPpm: mocks.writePngFromPpm,
}));
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    return {
        ...actual,
        rm: mocks.rm,
        stat: mocks.stat,
    };
});

describe('createScanCleanupRenderers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({isFile: () => true});
        mocks.readPngDimensions.mockResolvedValue({
            width: 1,
            height: 1,
            isColor: true,
        });
        mocks.readPpmDimensions.mockResolvedValue({
            width: 1,
            height: 1,
            isColor: true,
        });
        mocks.writePngFromPpm.mockResolvedValue({
            width: 1,
            height: 1,
        });
    });

    // Poppler's PNG writer is fixed at maximum zlib compression, which costs a
    // smooth scanned page tens of seconds. A PNG caller gets Poppler's PPM
    // pixels, losslessly, from the app's fast encode.
    it('renders a PNG caller through Poppler PPM and keeps every pixel', async () => {
        const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises');
        const actualRaster = await vi.importActual<typeof RasterLayerDimensions>(
            '@evb/scan-cleanup/core/rasterLayerDimensions',
        );
        mocks.writePngFromPpm.mockImplementation(actualRaster.writePngFromPpm);
        const root = await actualFs.mkdtemp(join(tmpdir(), 'scan-cleanup-renderers-'));
        try {
            const runCommand = vi.fn(async (_binary: string, args: string[]) => {
                await actualFs.writeFile(`${args.at(-1)!}.ppm`, Buffer.concat([
                    Buffer.from('P6\n2 1\n255\n', 'ascii'),
                    Buffer.from([
                        200,
                        10,
                        20,
                        30,
                        40,
                        250,
                    ]),
                ]));
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: '',
                };
            });
            const {renderPage} = createScanCleanupRenderers(runCommand);
            const controller = new AbortController();

            await renderPage(
                {pdftoppmBinary: '/bin/pdftoppm'},
                vi.fn(),
                1,
                '/tmp/source.pdf',
                join(root, 'page.png'),
                300,
                undefined,
                controller.signal,
                undefined,
                {
                    expectedWidthPx: 2,
                    expectedHeightPx: 1,
                    maxDimensionPx: 100,
                    maxPixels: 100,
                },
            );

            expect(runCommand).toHaveBeenCalledWith(
                '/bin/pdftoppm',
                [
                    '-cropbox',
                    '-r',
                    '300',
                    '-f',
                    '1',
                    '-l',
                    '1',
                    '-singlefile',
                    '/tmp/source.pdf',
                    join(root, 'page'),
                ],
                expect.objectContaining({signal: controller.signal}),
            );
            const image = decode(await actualFs.readFile(join(root, 'page.png')));
            expect({
                width: image.width,
                height: image.height,
                channels: image.channels,
                pixels: [...image.data],
            }).toEqual({
                width: 2,
                height: 1,
                channels: 3,
                pixels: [
                    200,
                    10,
                    20,
                    30,
                    40,
                    250,
                ],
            });
            expect(mocks.rm).toHaveBeenCalledWith(join(root, 'page.ppm'), {force: true});
        } finally {
            await actualFs.rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('preserves the renderer error when failed cleanup cannot remove the output', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const rendererError = new Error('renderer produced an invalid PNG');
        mocks.readPngDimensions.mockRejectedValue(rendererError);
        mocks.rm.mockRejectedValue(new Error('cleanup failed'));
        const {renderPage} = createScanCleanupRenderers(runCommand);

        await expect(renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
        )).rejects.toBe(rendererError);
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.png', {force: true});
    });

    it('removes a partial PNG without masking a command failure', async () => {
        const rendererError = new Error('pdftoppm failed after opening the output');
        const runCommand = vi.fn().mockRejectedValue(rendererError);
        mocks.rm.mockRejectedValue(new Error('cleanup failed'));
        const {renderPage} = createScanCleanupRenderers(runCommand);

        await expect(renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
        )).rejects.toBe(rendererError);
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.png', {force: true});
    });

    // Poppler writes the PPM a PNG is encoded from. A render that fails after
    // writing part of it must not leave that file behind its PNG caller.
    it('removes the intermediate PPM when the render fails', async () => {
        const rendererError = new Error('pdftoppm failed after writing part of the page');
        const runCommand = vi.fn().mockRejectedValue(rendererError);
        const {renderPage} = createScanCleanupRenderers(runCommand);

        await expect(renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
        )).rejects.toBe(rendererError);
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.png', {force: true});
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.ppm', {force: true});
    });

    it('keeps the PPM route available for sidecar-only handoffs', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const {renderPagePpm} = createScanCleanupRenderers(runCommand);

        await renderPagePpm(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.ppm',
            300,
        );

        expect(runCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-cropbox',
                '-r',
                '300',
                '-f',
                '1',
                '-l',
                '1',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page',
            ],
            expect.any(Object),
        );
        expect(mocks.readPpmDimensions).toHaveBeenCalledWith('/tmp/page.ppm');
    });

    it('rejects and removes an oversized PPM render', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        mocks.readPpmDimensions.mockResolvedValue({
            width: 2,
            height: 2,
            isColor: true,
        });
        const {renderPagePpm} = createScanCleanupRenderers(runCommand, {
            maxDimensionPx: 1,
            maxPixels: 1,
        });

        await expect(renderPagePpm(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/oversized.ppm',
            300,
        )).rejects.toThrow('PPM raster 2x2 exceeds limits');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/oversized.ppm', {force: true});
    });
});

// Filesystem assertions cover the native adapter boundary, shared by OCR and
// scan cleanup. The marked failure substitutes proof, not an unkillable child.
describe('Poppler output ownership at the native proof boundary', () => {
    const fs = vi.importActual<typeof FsPromises>('node:fs/promises');
    const paths = {pdftoppmBinary: '/bin/pdftoppm'};

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.rm.mockImplementation((await fs).rm);
        mocks.stat.mockImplementation((await fs).stat);
        mocks.acquire.mockResolvedValue({release: () => true});
    });

    it.each([
        'png',
        'ppm',
    ] as const)('retains marked %s bytes without affirmative proof', async (format) => {
        const actual = await fs;
        const dir = await actual.mkdtemp(join(tmpdir(), 'poppler-ownership-'));
        const output = join(dir, `page.${format}`);
        const failure = markUnprovenNativeTermination(new Error('render timeout'), 'tree unproven');
        const {
            renderPdfPageToPng, renderPdfPageToPpm,
        } = await import('@electron/features/ocr/pipeline/popplerStage');
        const render = format === 'png' ? renderPdfPageToPng : renderPdfPageToPpm;
        try {
            for (const outcome of [
                'absent',
                'false',
                'rejected',
            ]) {
                await actual.writeFile(output, 'partial raster bytes');
                if (format === 'png') await actual.writeFile(join(dir, 'page.ppm'), 'partial Poppler PPM bytes');
                const proof = outcome === 'absent' ? undefined : outcome === 'false'
                    ? Promise.resolve(false) : Promise.reject(new Error('proof unavailable'));
                mocks.runCommand.mockImplementation(async (_command: string, _args: string[], options: IRunNativeToolCommandOptions) => {
                    if (proof) options.onTerminationProof?.(proof);
                    // Attach a rejection observer even on the original revision.
                    await proof?.catch(() => undefined);
                    throw failure;
                });
                await expect(render(paths, vi.fn(), 1, join(dir, 'source.pdf'), output, 300)).rejects.toBe(failure);
                expect(await actual.readFile(output, 'utf8')).toBe('partial raster bytes');
                if (format === 'png') expect(await actual.readFile(join(dir, 'page.ppm'), 'utf8')).toBe('partial Poppler PPM bytes');
            }
        } finally {
            await actual.rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        'png',
        'ppm',
    ] as const)('removes ordinary failed %s bytes', async (format) => {
        const actual = await fs;
        const dir = await actual.mkdtemp(join(tmpdir(), 'poppler-ordinary-'));
        const output = join(dir, `page.${format}`);
        const failure = new Error('ordinary render failure');
        const {
            renderPdfPageToPng, renderPdfPageToPpm,
        } = await import('@electron/features/ocr/pipeline/popplerStage');
        try {
            await actual.writeFile(output, 'partial raster');
            if (format === 'png') await actual.writeFile(join(dir, 'page.ppm'), 'partial Poppler PPM bytes');
            mocks.runCommand.mockRejectedValue(failure);
            await expect((format === 'png' ? renderPdfPageToPng : renderPdfPageToPpm)(
                paths, vi.fn(), 1, join(dir, 'source.pdf'), output, 300,
            )).rejects.toBe(failure);
            await expect(actual.stat(output)).rejects.toMatchObject({code: 'ENOENT'});
            if (format === 'png') await expect(actual.stat(join(dir, 'page.ppm'))).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await actual.rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps an empty native marker out of OCR normalization fallback', async () => {
        const actual = await fs;
        const dir = await actual.mkdtemp(join(tmpdir(), 'poppler-empty-marker-'));
        const failure = markUnprovenNativeTermination(new Error('render timeout'), '');
        mocks.runCommand.mockRejectedValue(failure);
        const {renderOcrPageToPng} = await import('@electron/features/ocr/pipeline/popplerStage');
        try {
            await expect(renderOcrPageToPng([
                paths,
                vi.fn(),
                1,
                join(dir, 'source.pdf'),
                join(dir, 'page.png'),
                300,
            ], async () => {throw new Error('must not reach fallback');})).rejects.toBe(failure);
        } finally {
            await actual.rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        false,
        true,
    ])('retains OCR page inputs and outputs on a marked failure (size probe=%s)', async (probe) => {
        const actual = await fs;
        const dir = await actual.mkdtemp(join(tmpdir(), 'poppler-page-owner-'));
        const source = join(dir, 'source.pdf');
        const sourceBytes = await actual.readFile(join(process.cwd(), 'tests/fixtures/release/packaged-core-ocr-smoke.pdf'));
        const output = join(dir, probe ? 'session-page-1-size-probe.png' : 'session-page-1.png');
        const clean = join(dir, 'session-page-1-clean.png');
        const metadata = join(dir, 'session-page-1-clean.json');
        const failure = markUnprovenNativeTermination(new Error('Poppler timeout'), 'tree unproven');
        const {processOcrPages} = await import('@electron/features/ocr/pipeline/runOcrJob');
        const controller = new AbortController();
        const storageBudget = createOcrJobStorageBudget({
            abortController: controller,
            checkpointDir: dir,
            tempDir: dir,
            sessionId: 'session',
        });
        try {
            await Promise.all([
                actual.writeFile(source, sourceBytes),
                actual.writeFile(output, 'owned Poppler raster bytes'),
                actual.writeFile(clean, 'owned clean raster bytes'),
                actual.writeFile(metadata, 'owned metadata bytes'),
                actual.writeFile(join(dir, 'eng.traineddata'), Buffer.alloc(1024)),
            ]);
            mocks.runCommand.mockRejectedValue(failure);
            await expect(processOcrPages([{
                pageNumber: 1,
                languages: ['eng'],
            }], 1, {
                jobId: 'ownership-boundary',
                sessionId: 'session',
                paths: {
                    ...paths,
                    tempDir: dir,
                    tesseractBinary: '/bin/tesseract',
                    tessdataPath: dir,
                    qpdfBinary: '/bin/qpdf',
                },
                log: () => undefined,
                getPopplerSourcePdfPath: () => source,
                preparePopplerFallback: async () => {throw new Error('must not reach fallback');},
                extractionDpi: 300,
                pageSizeByNumber: probe ? new Map() : new Map([[
                    1,
                    {
                        width: 8.5,
                        height: 11,
                    },
                ]]),
                pageSourceDpiByNumber: new Map(),
                options: {},
                checkpointDir: dir,
                checkpointPage: async () => undefined,
                signal: controller.signal,
                storageBudget,
                trackTempFile: path => path,
            })).rejects.toBe(failure);
            expect(await actual.readFile(source)).toEqual(sourceBytes);
            expect(await actual.readFile(output, 'utf8')).toBe('owned Poppler raster bytes');
            expect(await actual.readFile(clean, 'utf8')).toBe('owned clean raster bytes');
            expect(await actual.readFile(metadata, 'utf8')).toBe('owned metadata bytes');
        } finally {
            await storageBudget.stop();
            await actual.rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps a writing child output linked until eventual affirmative exit proof', async () => {
        const actual = await fs;
        const dir = await actual.mkdtemp(join(tmpdir(), 'poppler-writing-child-'));
        const source = join(dir, 'source.pdf');
        const sourceBytes = await actual.readFile(join(process.cwd(), 'tests/fixtures/release/packaged-core-ocr-smoke.pdf'));
        const output = join(dir, 'page.png');
        const ppm = join(dir, 'page.ppm');
        await actual.writeFile(output, 'owned PNG bytes');
        await actual.writeFile(source, sourceBytes);
        // IPC acknowledgements order the observations; no sleep or retry.
        const child = spawn(process.execPath, [
            '-e',
            `
            const fs = require('node:fs');
            const input = fs.openSync(process.argv[2], 'r');
            const fd = fs.openSync(process.argv[1], 'w');
            fs.writeSync(fd, 'first');
            process.send('ready');
            process.on('message', message => {
                if (message === 'write') {
                    fs.writeSync(fd, '-continued');
                    const bytes = Buffer.alloc(12);
                    fs.readSync(input, bytes, 0, bytes.length, 0);
                    process.send({event: 'written', source: bytes.toString()});
                }
                if (message === 'exit') { fs.closeSync(input); fs.closeSync(fd); process.exit(0); }
            });
        `,
            ppm,
            source,
        ], {stdio: [
            'ignore',
            'ignore',
            'pipe',
            'ipc',
        ]});
        const ready = once(child, 'message');
        const closed = once(child, 'close');
        onTestFinished(async () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            await closed;
        });
        const proof = Promise.withResolvers<boolean>();
        const removed = Promise.withResolvers<undefined>();
        const ppmRemoved = Promise.withResolvers<undefined>();
        mocks.rm.mockImplementation(async (path: string, options: Parameters<typeof actual.rm>[1]) => {
            await actual.rm(path, options);
            if (path === output) removed.resolve(undefined);
            if (path === ppm) ppmRemoved.resolve(undefined);
        });
        const failure = markUnprovenNativeTermination(new Error('bounded proof wait ended'), 'child exit not yet proved');
        const {renderOcrPageToPng} = await import('@electron/features/ocr/pipeline/popplerStage');
        try {
            await Promise.race([
                ready,
                closed.then(() => {throw new Error('writing child exited before ready');}),
            ]);
            mocks.runCommand.mockImplementation(async (_command: string, _args: string[], options: IRunNativeToolCommandOptions) => {
                options.onTerminationProof?.(proof.promise);
                throw failure;
            });
            await expect(renderOcrPageToPng([
                paths,
                vi.fn(),
                1,
                source,
                output,
                300,
            ], async () => {throw new Error('must not reach fallback');})).rejects.toBe(failure);
            expect(await actual.readFile(output, 'utf8')).toBe('owned PNG bytes');
            expect(await actual.readFile(ppm, 'utf8')).toBe('first');
            const written = once(child, 'message');
            child.send('write');
            const [message] = await written;
            expect(message).toEqual({
                event: 'written',
                source: sourceBytes.subarray(0, 12).toString(),
            });
            expect(await actual.readFile(output, 'utf8')).toBe('owned PNG bytes');
            expect(await actual.readFile(ppm, 'utf8')).toBe('first-continued');
            expect(await actual.readFile(source)).toEqual(sourceBytes);
            child.send('exit');
            expect(await closed).toEqual([
                0,
                null,
            ]);
            // A close/exit alone is not the adapter's process-tree proof.
            expect(await actual.readFile(output, 'utf8')).toBe('owned PNG bytes');
            expect(await actual.readFile(ppm, 'utf8')).toBe('first-continued');
            proof.resolve(true);
            await Promise.all([
                removed.promise,
                ppmRemoved.promise,
            ]);
            await expect(actual.stat(output)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(actual.stat(ppm)).rejects.toMatchObject({code: 'ENOENT'});
            expect(await actual.readFile(source)).toEqual(sourceBytes);
        } finally {
            if (child.exitCode === null) child.kill('SIGKILL');
            await closed;
            proof.resolve(false);
            await actual.rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
