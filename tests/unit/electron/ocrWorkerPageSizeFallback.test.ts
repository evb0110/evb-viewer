import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {readOcrPdfPageSizesInches} from '@electron/features/ocr/worker/pdfPageSizeProbe';

let tempDir: string | null = null;

afterEach(async () => {
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

function nativePageSizesCommand(pageSizes: unknown) {
    return vi.fn(async (_command: string, args: string[]) => {
        const outputIndex = args.indexOf('--output');
        const outputPath = args[outputIndex + 1];
        if (outputPath === undefined) {
            throw new Error('test native command did not receive an output path');
        }
        await writeFile(outputPath, JSON.stringify({pages: pageSizes}));
        return {
            stdout: '',
            stderr: '',
            exitCode: 0,
        };
    });
}

describe('OCR worker native page-size probe', () => {
    it('uses native page sizes for a huge path without reading the source into JavaScript', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        const sourcePdfPath = join(tempDir, 'huge.pdf');
        const runCommand = nativePageSizesCommand([{
            pageNumber: 1,
            widthInches: 8.5,
            heightInches: 11,
        }]);

        const result = await readOcrPdfPageSizesInches({
            pdfPath: sourcePdfPath,
            pdfPageOpsBinary: '/native/evb-pdf-page-ops',
            qpdfBinary: '/native/qpdf',
            tempDir,
            runCommand,
        });

        expect(result).toEqual({
            status: 'available',
            pageSizes: new Map([[
                1,
                {
                    width: 8.5,
                    height: 11,
                },
            ]]),
        });
        expect(runCommand).toHaveBeenCalledOnce();
        expect(runCommand.mock.calls[0]?.[0]).toBe('/native/evb-pdf-page-ops');
        expect(runCommand.mock.calls[0]?.[1]).toEqual([
            'page-sizes',
            '--input',
            sourcePdfPath,
            '--output',
            expect.any(String),
            '--qpdf',
            '/native/qpdf',
        ]);
    });

    it('returns a typed degraded result when native page-size tooling is unavailable', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        const sourcePdfPath = join(tempDir, 'two-gigabyte.pdf');
        const runCommand = vi.fn();

        const result = await readOcrPdfPageSizesInches({
            pdfPath: sourcePdfPath,
            tempDir,
            runCommand,
        });

        expect(result.status).toBe('degraded');
        if (result.status !== 'degraded') {
            throw new Error('expected degraded native page-size result');
        }
        expect(result.reason).toBe('native-tool-unavailable');
        expect(result.message).not.toContain('larger than');
        expect(result.pageSizes).toEqual(new Map());
        expect(runCommand).not.toHaveBeenCalled();
    });

    it('keeps OCR running with conservative defaults when native inspection fails', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        const runCommand = vi.fn(async () => {
            throw new Error('page-size helper unavailable');
        });

        const result = await readOcrPdfPageSizesInches({
            pdfPath: join(tempDir, 'huge.pdf'),
            pdfPageOpsBinary: '/native/evb-pdf-page-ops',
            qpdfBinary: '/native/qpdf',
            tempDir,
            runCommand,
        });

        expect(result).toMatchObject({
            status: 'degraded',
            reason: 'native-tool-failed',
            pageSizes: new Map(),
        });
        if (result.status !== 'degraded') {
            throw new Error('expected degraded native page-size result');
        }
        expect(result.message).toContain('page-size helper unavailable');
    });
});
