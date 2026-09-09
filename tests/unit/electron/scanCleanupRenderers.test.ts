import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';
import type {TScanCleanupRunCommand} from '@evb/scan-cleanup/core/types';

const mocks = vi.hoisted(() => ({
    readPngDimensions: vi.fn(),
    rm: vi.fn(),
}));

vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({readPngDimensions: mocks.readPngDimensions}));
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    return {
        ...actual,
        rm: mocks.rm,
    };
});

describe('createScanCleanupRenderers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.rm.mockResolvedValue(undefined);
        mocks.readPngDimensions.mockResolvedValue({
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

    it('renders the MediaBox for a suspicious crop on a dominant landscape document', async () => {
        const pdfInfo = [
            'Pages:           3',
            'Page    1 size:  358.816 x 425.609 pts',
            'Page    1 rot:   0',
            'Page    1 MediaBox:      0.00     0.00   841.89   633.89',
            'Page    1 CropBox:     411.63   122.85   770.44   548.46',
            'Page    2 size:  616.667 x 452.792 pts',
            'Page    2 rot:   0',
            'Page    2 MediaBox:      0.00     0.00   841.89   633.89',
            'Page    2 CropBox:      62.13   115.86   678.80   568.65',
            'Page    3 size:  702.1 x 493.179 pts',
            'Page    3 rot:   0',
            'Page    3 MediaBox:      0.00     0.00   841.89   633.89',
            'Page    3 CropBox:      76.89    59.94   778.99   553.12',
        ].join('\n');
        const runCommand = vi.fn<TScanCleanupRunCommand>(async command => {
            if (command === '/bin/pdfinfo') {
                return {
                    exitCode: 0,
                    stdout: pdfInfo,
                    stderr: '',
                };
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const {renderPage} = createScanCleanupRenderers(runCommand, undefined, {pdfinfoBinary: '/bin/pdfinfo'});

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/spread.pdf',
            '/tmp/page.png',
            300,
        );

        expect(runCommand).toHaveBeenLastCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-r',
                '300',
                '-f',
                '1',
                '-l',
                '1',
                '-singlefile',
                '/tmp/spread.pdf',
                '/tmp/page',
            ],
            expect.any(Object),
        );
    });

    it('shares an in-flight geometry read without sharing caller cancellation', async () => {
        const pdfInfo = [
            'Pages:           3',
            ...Array.from({length: 3}, (_, index) => [
                `Page    ${String(index + 1)} size:  300 x 400 pts`,
                `Page    ${String(index + 1)} rot:   0`,
                `Page    ${String(index + 1)} MediaBox:      0.00     0.00   800.00   600.00`,
                `Page    ${String(index + 1)} CropBox:     250.00   100.00   550.00   500.00`,
            ].join('\n')),
        ].join('\n');
        const geometryRead = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string
        }>();
        const runCommand = vi.fn<TScanCleanupRunCommand>(async command => {
            if (command === '/bin/pdfinfo') {
                return geometryRead.promise;
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const {
            renderPage,
            renderPagePpm,
        } = createScanCleanupRenderers(runCommand, undefined, {pdfinfoBinary: '/bin/pdfinfo'});
        const cancelled = new AbortController();
        const retained = new AbortController();
        const cancelledRender = renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/concurrent.pdf',
            '/tmp/cancelled.png',
            300,
            undefined,
            cancelled.signal,
        );
        await vi.waitFor(() => {
            expect(runCommand.mock.calls.some(([command]) => command === '/bin/pdfinfo')).toBe(true);
        });
        const pdfInfoCall = runCommand.mock.calls.find(([command]) => command === '/bin/pdfinfo');
        expect(pdfInfoCall?.[2]).not.toHaveProperty('signal');
        const retainedRender = renderPagePpm(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            2,
            '/tmp/concurrent.pdf',
            '/tmp/retained.ppm',
            300,
            undefined,
            retained.signal,
        );
        cancelled.abort(new Error('cancel only this caller'));
        await expect(cancelledRender).rejects.toThrow('cancel only this caller');
        geometryRead.resolve({
            exitCode: 0,
            stdout: pdfInfo,
            stderr: '',
        });
        await retainedRender;

        expect(runCommand.mock.calls.filter(([command]) => command === '/bin/pdfinfo')).toHaveLength(2);
        expect(runCommand).toHaveBeenLastCalledWith(
            '/bin/pdftoppm',
            expect.any(Array),
            expect.objectContaining({signal: retained.signal}),
        );
        expect(runCommand.mock.lastCall?.[1]).not.toContain('-png');
        expect(runCommand.mock.lastCall?.[1]).not.toContain('-cropbox');
    });

    it('keeps an ordinary intentional crop on a landscape document', async () => {
        const pdfInfo = [
            'Pages:           3',
            ...Array.from({length: 3}, (_, index) => [
                `Page    ${String(index + 1)} size:  760 x 560 pts`,
                `Page    ${String(index + 1)} rot:   0`,
                `Page    ${String(index + 1)} MediaBox:      0.00     0.00   800.00   600.00`,
                `Page    ${String(index + 1)} CropBox:     20.00    20.00   780.00   580.00`,
            ].join('\n')),
        ].join('\n');
        const runCommand = vi.fn(async (command: string) => ({
            exitCode: 0,
            stdout: command === '/bin/pdfinfo' ? pdfInfo : '',
            stderr: '',
        }));
        const {renderPage} = createScanCleanupRenderers(runCommand, undefined, {pdfinfoBinary: '/bin/pdfinfo'});

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            2,
            '/tmp/cropped.pdf',
            '/tmp/page.png',
            300,
        );

        expect(runCommand).toHaveBeenLastCalledWith(
            '/bin/pdftoppm',
            expect.arrayContaining(['-cropbox']),
            expect.any(Object),
        );
    });

    it('does not broaden a materially smaller same-orientation crop', async () => {
        const pdfInfo = [
            'Pages:           3',
            ...Array.from({length: 3}, (_, index) => [
                `Page    ${String(index + 1)} size:  600 x 400 pts`,
                `Page    ${String(index + 1)} rot:   0`,
                `Page    ${String(index + 1)} MediaBox:      0.00     0.00   800.00   600.00`,
                `Page    ${String(index + 1)} CropBox:     100.00   100.00   700.00   500.00`,
            ].join('\n')),
        ].join('\n');
        const runCommand = vi.fn(async (command: string) => ({
            exitCode: 0,
            stdout: command === '/bin/pdfinfo' ? pdfInfo : '',
            stderr: '',
        }));
        const {renderPage} = createScanCleanupRenderers(runCommand, undefined, {pdfinfoBinary: '/bin/pdfinfo'});

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            2,
            '/tmp/same-orientation.pdf',
            '/tmp/page.png',
            300,
        );

        expect(runCommand).toHaveBeenLastCalledWith(
            '/bin/pdftoppm',
            expect.arrayContaining(['-cropbox']),
            expect.any(Object),
        );
    });

    it('does not broaden a true single-page crop', async () => {
        const pdfInfo = [
            'Pages:           1',
            'Page    1 size:  300 x 400 pts',
            'Page    1 rot:   0',
            'Page    1 MediaBox:      0.00     0.00   800.00   600.00',
            'Page    1 CropBox:     250.00   100.00   550.00   500.00',
        ].join('\n');
        const runCommand = vi.fn(async (command: string) => ({
            exitCode: 0,
            stdout: command === '/bin/pdfinfo' ? pdfInfo : '',
            stderr: '',
        }));
        const {renderPage} = createScanCleanupRenderers(runCommand, undefined, {pdfinfoBinary: '/bin/pdfinfo'});

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/single.pdf',
            '/tmp/page.png',
            300,
        );

        expect(runCommand).toHaveBeenLastCalledWith(
            '/bin/pdftoppm',
            expect.arrayContaining(['-cropbox']),
            expect.any(Object),
        );
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
    });
});
