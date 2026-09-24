import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildPopplerEnv,
    createOcrRasterRenderLimits,
    preparePdfForPoppler,
    probeOcrPageSizeInches,
    renderPdfPageToPng,
    renderPdfPageToPpm,
    renderOcrPageToPng,
} from '@electron/features/ocr/pipeline/popplerStage';
import type { IOcrPipelinePaths } from '@electron/features/ocr/pipeline/types';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    readPngDimensions: vi.fn(),
    rm: vi.fn(),
    runOcrCommand: vi.fn(),
    stat: vi.fn(),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runOcrCommand}));
vi.mock('@evb/scan-cleanup/core/rasterLayerDimensions', () => ({readPngDimensions: mocks.readPngDimensions}));

vi.mock('node:fs/promises', () => ({
    rm: mocks.rm,
    stat: mocks.stat,
}));

const workerPaths: IOcrPipelinePaths = {
    tesseractBinary: '/bin/tesseract',
    tessdataPath: '/share/tessdata',
    pdftoppmBinary: '/bin/pdftoppm',
    pdftotextBinary: '/bin/pdftotext',
    qpdfBinary: '/bin/qpdf',
    tempDir: '/tmp/ocr',
};

describe('buildPopplerEnv', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('omits Poppler environment when no optional resource directories are configured', () => {
        expect(buildPopplerEnv(workerPaths)).toBeUndefined();
    });

    it('sets Poppler data and fontconfig paths when configured', () => {
        expect(buildPopplerEnv({
            ...workerPaths,
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
        })).toEqual({
            POPPLER_DATADIR: '/share/poppler',
            FONTCONFIG_PATH: '/share/fontconfig',
            FONTCONFIG_FILE: '/share/fontconfig/fonts.conf',
        });
    });
});

describe('preparePdfForPoppler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stat.mockResolvedValue({ size: 1024 });
    });

    it('returns surfaced warnings when qpdf preflight falls back to the original PDF', async () => {
        mocks.runOcrCommand.mockRejectedValueOnce(new Error('qpdf failed'));
        const log = vi.fn();
        const trackTempFile = vi.fn((path: string) => path);

        const result = await preparePdfForPoppler(
            workerPaths,
            log,
            '/tmp/source.pdf',
            'session',
            trackTempFile,
        );

        expect(result).toEqual({
            pdfPath: '/tmp/source.pdf',
            warnings: ['qpdf preflight failed; falling back to original PDF for Poppler commands: qpdf failed'],
        });
        expect(log).toHaveBeenCalledWith('warn', result.warnings[0]);
    });
});

describe('renderPdfPageToPng', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readPngDimensions.mockResolvedValue({
            width: 1,
            height: 1,
            isColor: true,
        });
        mocks.rm.mockResolvedValue(undefined);
        mocks.runOcrCommand.mockReset();
    });

    it('renders readable OCR input directly without preparing a full PDF copy', async () => {
        const fallback = vi.fn();
        await renderOcrPageToPng([
            workerPaths,
            vi.fn(),
            17,
            '/source.pdf',
            '/page.png',
            300,
        ], fallback);
        expect(fallback).not.toHaveBeenCalled();
        expect(mocks.runOcrCommand).toHaveBeenCalledWith('/bin/pdftoppm', expect.arrayContaining(['/source.pdf']), expect.anything());
    });

    it('repairs a Poppler failure and retries the same page and raster settings', async () => {
        mocks.runOcrCommand.mockRejectedValueOnce(new Error('broken xref'));
        const fallback = vi.fn().mockResolvedValue({
            pdfPath: '/normalized.pdf',
            warnings: [],
        });
        await renderOcrPageToPng([
            workerPaths,
            vi.fn(),
            17,
            '/source.pdf',
            '/page.png',
            300,
        ], fallback);
        expect(fallback).toHaveBeenCalledOnce();
        expect(mocks.runOcrCommand).toHaveBeenLastCalledWith('/bin/pdftoppm', [
            '-png',
            '-cropbox',
            '-r',
            '300',
            '-f',
            '17',
            '-l',
            '17',
            '-singlefile',
            '/normalized.pdf',
            '/page',
        ], expect.anything());
    });

    it.each([
        new RangeError('raster exceeds limits'),
        Object.assign(new Error('device full'), {code: 'ENOSPC'}),
        new Error('pdftoppm failed: No space left on device'),
        new Error('pdftoppm failed: Disk quota exceeded'),
        markUnprovenNativeTermination(new Error('termination failed'), 'process still running'),
    ])('does not normalize after a safety failure: %s', async error => {
        mocks.runOcrCommand.mockRejectedValueOnce(error);
        const fallback = vi.fn();
        await expect(renderOcrPageToPng([
            workerPaths,
            vi.fn(),
            1,
            '/source.pdf',
            '/page.png',
            300,
        ], fallback)).rejects.toBe(error);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('does not retry the original input when normalization also failed', async () => {
        const error = new Error('broken PDF');
        mocks.runOcrCommand.mockRejectedValueOnce(error);
        const fallback = vi.fn().mockResolvedValue({
            pdfPath: '/source.pdf',
            warnings: ['repair failed'],
        });
        await expect(renderOcrPageToPng([
            workerPaths,
            vi.fn(),
            1,
            '/source.pdf',
            '/page.png',
            300,
        ], fallback)).rejects.toBe(error);
        expect(mocks.runOcrCommand).toHaveBeenCalledOnce();
    });

    it('renders OCR rasters against the PDF CropBox contract', async () => {
        const log = vi.fn();

        await renderPdfPageToPng(
            workerPaths,
            log,
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-cropbox',
                '-r',
                '300',
                '-f',
                '3',
                '-l',
                '3',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page-3',
            ],
            expect.objectContaining({commandLabel: 'pdftoppm(page=3,dpi=300)'}),
        );
        expect(mocks.readPngDimensions).toHaveBeenCalledWith('/tmp/page-3.png');
    });

    it('rejects an oversized PNG from its header without reading its payload into memory', async () => {
        mocks.readPngDimensions.mockResolvedValueOnce({
            width: 10_000,
            height: 10_000,
            isColor: true,
        });

        await expect(renderPdfPageToPng(
            workerPaths,
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page-1.png',
            300,
            undefined,
            undefined,
            undefined,
            {
                expectedWidthPx: 1_000,
                expectedHeightPx: 1_000,
                maxPixels: 45_000_000,
                maxDimensionPx: 40_000,
            },
        )).rejects.toThrow('PNG raster 10000x10000 exceeds limits');
        expect(mocks.readPngDimensions).toHaveBeenCalledWith('/tmp/page-1.png');
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page-1.png', {force: true});
    });

    it('rejects over-budget trusted geometry before spawning pdftoppm', async () => {
        await expect(renderPdfPageToPpm(
            workerPaths,
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page-1.ppm',
            300,
            undefined,
            undefined,
            undefined,
            {
                expectedWidthPx: 10_000,
                expectedHeightPx: 10_000,
                maxPixels: 45_000_000,
                maxDimensionPx: 40_000,
            },
        )).rejects.toThrow('Poppler raster 10000x10000 exceeds limits');
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
    });

    it('renders raw PPM without the PNG encoder flag for pipeline-internal rasters', async () => {
        const log = vi.fn();
        mocks.stat.mockResolvedValue({isFile: () => false});

        await renderPdfPageToPpm(
            workerPaths,
            log,
            5,
            '/tmp/source.pdf',
            '/tmp/page-5.ppm',
            360,
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-cropbox',
                '-r',
                '360',
                '-f',
                '5',
                '-l',
                '5',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page-5',
            ],
            expect.objectContaining({commandLabel: 'pdftoppm(page=5,dpi=360)'}),
        );
    });

    it('renders only the requested positive pixel crop', async () => {
        const log = vi.fn();

        await renderPdfPageToPng(
            workerPaths,
            log,
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
            undefined,
            undefined,
            {
                x: 11,
                y: 22,
                width: 333,
                height: 444,
            },
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-cropbox',
                '-r',
                '300',
                '-f',
                '3',
                '-l',
                '3',
                '-singlefile',
                '-x',
                '11',
                '-y',
                '22',
                '-W',
                '333',
                '-H',
                '444',
                '/tmp/source.pdf',
                '/tmp/page-3',
            ],
            expect.objectContaining({commandLabel: 'pdftoppm(page=3,dpi=300)'}),
        );
    });

    it.each([
        [
            'x',
            -1,
        ],
        [
            'y',
            -1,
        ],
        [
            'width',
            1.5,
        ],
        [
            'height',
            Number.MAX_SAFE_INTEGER + 1,
        ],
    ] as const)('rejects an invalid %s crop value', async (field, value) => {
        const crop = {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            [field]: value,
        };

        await expect(renderPdfPageToPng(
            workerPaths,
            vi.fn(),
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
            undefined,
            undefined,
            crop,
        )).rejects.toThrow(
            `Poppler pixel crop ${field} must be a ${
                field === 'x' || field === 'y' ? 'non-negative' : 'positive'
            } safe integer`,
        );
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
    });
});

describe('OCR raster admission before rendering (SRCH-006)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('derives pre-render raster limits from the page size and target DPI', () => {
        expect(createOcrRasterRenderLimits({
            width: 8.5,
            height: 11,
        }, 300)).toEqual({
            expectedWidthPx: 2550,
            expectedHeightPx: 3300,
            maxPixels: 45_000_000,
            maxDimensionPx: 40_000,
        });
    });

    it('rejects an oversize page raster before spawning pdftoppm', async () => {
        const log = vi.fn();

        await expect(renderPdfPageToPng(
            workerPaths,
            log,
            1,
            '/tmp/ocr/source.pdf',
            '/tmp/ocr/page-1.png',
            300,
            undefined,
            undefined,
            undefined,
            createOcrRasterRenderLimits({
                width: 200,
                height: 200,
            }, 300),
        )).rejects.toThrow('Poppler raster 60000x60000 exceeds limits');
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
    });

    it('recovers the page size from a low-resolution render when the native probe is degraded', async () => {
        const log = vi.fn();
        mocks.runOcrCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.readPngDimensions.mockResolvedValue({
            width: 68,
            height: 88,
        });

        await expect(probeOcrPageSizeInches(
            workerPaths,
            log,
            1,
            {popplerSourcePdfPath: '/tmp/ocr/source.pdf'},
            '/tmp/ocr/page-1-size-probe.png',
        )).resolves.toEqual({
            width: 8.5,
            height: 11,
        });
        expect(mocks.runOcrCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runOcrCommand.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
            '-r',
            '8',
        ]));
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/ocr/page-1-size-probe.png', {force: true});
    });
});
