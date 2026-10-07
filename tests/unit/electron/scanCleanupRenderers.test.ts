import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decode} from 'fast-png';
import type * as RasterLayerDimensions from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';

const mocks = vi.hoisted(() => ({
    readPngDimensions: vi.fn(),
    readPpmDimensions: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    writePngFromPpm: vi.fn(),
}));

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
