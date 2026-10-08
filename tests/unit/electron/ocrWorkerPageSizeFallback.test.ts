import {
    mkdtemp,
    readdir,
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
import {createOcrPageSizeSource} from '@electron/features/ocr/pipeline/pdfPageSizeProbe';

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

function nativePageSizesCommand(pageSizes: unknown[]) {
    return vi.fn(async (_command: string, args: string[]) => {
        const outputIndex = args.indexOf('--output');
        const outputPath = args[outputIndex + 1];
        if (outputPath === undefined) {
            throw new Error('test native command did not receive an output path');
        }
        await writeFile(outputPath, `${JSON.stringify({
            format: 'evb-pdf-page-sizes',
            schemaVersion: 1,
            pageCount: pageSizes.length,
            chunkBytes: 512,
        })}\n${JSON.stringify({
            chunkIndex: 0,
            firstPageNumber: 1,
            pages: pageSizes,
        })}\n`);
        return {
            stdout: '',
            stderr: '',
            exitCode: 0,
        };
    });
}

describe('OCR worker native page-size probe', () => {
    it('reads every request batch of a job from one metadata-only native sidecar', async () => {
        const probeTempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        tempDir = probeTempDir;
        const sourcePdfPath = join(probeTempDir, 'huge.pdf');
        const runCommand = nativePageSizesCommand(Array.from({length: 6}, (_, index) => ({
            pageNumber: index + 1,
            widthInches: 8.5 + index,
            heightInches: 11,
        })));
        const source = createOcrPageSizeSource({
            pdfPageOpsBinary: '/native/evb-pdf-page-ops',
            qpdfBinary: '/native/qpdf',
            tempDir: probeTempDir,
            runCommand,
        });

        const firstBatch = await source.read(sourcePdfPath, [
            2,
            1,
        ]);
        const secondBatch = await source.read(sourcePdfPath, [
            5,
            9,
        ]);

        expect(firstBatch).toEqual({
            status: 'available',
            pageSizes: new Map([
                [
                    1,
                    {
                        width: 8.5,
                        height: 11,
                    },
                ],
                [
                    2,
                    {
                        width: 9.5,
                        height: 11,
                    },
                ],
            ]),
        });
        expect(secondBatch).toEqual({
            status: 'available',
            pageSizes: new Map([[
                5,
                {
                    width: 12.5,
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
            '--metadata-only',
        ]);

        await source.close();
        expect(await readdir(probeTempDir)).toEqual([]);
    });

    it('probes a new source path, such as the Poppler fallback copy, once more', async () => {
        const probeTempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        tempDir = probeTempDir;
        const runCommand = nativePageSizesCommand([{
            pageNumber: 1,
            widthInches: 8.5,
            heightInches: 11,
        }]);
        const source = createOcrPageSizeSource({
            pdfPageOpsBinary: '/native/evb-pdf-page-ops',
            tempDir: probeTempDir,
            runCommand,
        });

        await source.read(join(probeTempDir, 'source.pdf'), [1]);
        await source.read(join(probeTempDir, 'normalized.pdf'), [1]);
        await source.read(join(probeTempDir, 'normalized.pdf'), [1]);

        expect(runCommand.mock.calls.map(call => call[1][2])).toEqual([
            join(probeTempDir, 'source.pdf'),
            join(probeTempDir, 'normalized.pdf'),
        ]);
        await source.close();
        expect(await readdir(probeTempDir)).toEqual([]);
    });

    it('returns a typed degraded result when native page-size tooling is unavailable', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-page-size-probe-'));
        const sourcePdfPath = join(tempDir, 'two-gigabyte.pdf');
        const runCommand = vi.fn();

        const result = await createOcrPageSizeSource({
            tempDir,
            runCommand,
        }).read(sourcePdfPath, [1]);

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

        const result = await createOcrPageSizeSource({
            pdfPageOpsBinary: '/native/evb-pdf-page-ops',
            qpdfBinary: '/native/qpdf',
            tempDir,
            runCommand,
        }).read(join(tempDir, 'huge.pdf'), [1]);

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
