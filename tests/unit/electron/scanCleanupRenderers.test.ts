import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';

const mocks = vi.hoisted(() => ({
    readPngDimensions: vi.fn(),
    readPpmDimensions: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
}));

vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({
    readPngDimensions: mocks.readPngDimensions,
    readPpmDimensions: mocks.readPpmDimensions,
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
    });

    it('asks pdftoppm for PNG output without a main-process conversion pass', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const {renderPage} = createScanCleanupRenderers(runCommand);
        const controller = new AbortController();

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
            undefined,
            controller.signal,
            undefined,
            {
                expectedWidthPx: 1,
                expectedHeightPx: 1,
                maxDimensionPx: 100,
                maxPixels: 100,
            },
        );

        expect(runCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
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
            expect.objectContaining({signal: controller.signal}),
        );
        expect(mocks.readPngDimensions).toHaveBeenCalledWith('/tmp/page.png');
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

    it('leaves FIFO PPM dimensions to the streaming consumer', async () => {
        mocks.stat.mockResolvedValue({isFile: () => false});
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

        expect(mocks.readPpmDimensions).not.toHaveBeenCalled();
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
