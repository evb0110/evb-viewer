import {
    mkdtemp,
    open as fsOpen,
    readFile,
    readdir,
    rename,
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
import {
    createScanCleanupRasterBatchRenderer,
    type IScanCleanupRasterBatchFileSystem,
} from '@electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const roots: string[] = [];

function createFileSystem() {
    const fileSystem: IScanCleanupRasterBatchFileSystem = {
        mkdtemp: vi.fn(prefix => mkdtemp(prefix)),
        open: vi.fn((path, flags) => fsOpen(path, flags)),
        readdir: vi.fn(async (path: string, options: {withFileTypes: true}) => readdir(path, options)),
        rename: vi.fn((oldPath, newPath) => rename(oldPath, newPath)),
        rm: vi.fn((path, options) => rm(path, options)),
    };
    return fileSystem;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan cleanup raster batch renderer', () => {
    it('renders one contiguous window with one Poppler process and publishes every target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[]) => {
            const prefix = args.at(-1)!;
            await Promise.all([
                writeFile(`${prefix}-0017.png`, PNG),
                writeFile(`${prefix}-0018.png`, PNG),
            ]);
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const fileSystem = createFileSystem();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, fileSystem);
        const targets = [
            17,
            18,
        ].map(pageNumber => ({
            limits: {
                expectedHeightPx: 3,
                expectedWidthPx: 3,
                maxDimensionPx: 100,
                maxPixels: 10_000,
            },
            outputPath: join(root, `page-${String(pageNumber)}.png`),
            pageNumber,
        }));

        const results = await renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets,
        });

        expect(runCommand).toHaveBeenCalledOnce();
        expect(runCommand.mock.calls[0]?.[1]).toEqual([
            '-png',
            '-cropbox',
            '-r',
            '150',
            '-f',
            '17',
            '-l',
            '18',
            '/source.pdf',
            expect.stringContaining('pdftoppm-batch-'),
        ]);
        expect(results).toEqual([
            {
                height: 1,
                pageNumber: 17,
                width: 1,
            },
            {
                height: 1,
                pageNumber: 18,
                width: 1,
            },
        ]);
        expect(await readFile(targets[0]!.outputPath)).toEqual(PNG);
        expect(await readFile(targets[1]!.outputPath)).toEqual(PNG);
        expect((await readdir(root)).sort()).toEqual([
            'page-17.png',
            'page-18.png',
        ]);
        expect(fileSystem.mkdtemp).toHaveBeenCalledOnce();
        expect(fileSystem.readdir).toHaveBeenCalledOnce();
        expect(fileSystem.open).toHaveBeenCalledTimes(2);
        expect(fileSystem.rename).toHaveBeenCalledTimes(2);
        expect(fileSystem.rm).toHaveBeenCalledOnce();
    });

    it('rejects non-contiguous windows before starting Poppler', async () => {
        const runCommand = vi.fn();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, createFileSystem());

        await expect(renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [
                1,
                3,
            ].map(pageNumber => ({
                limits: {
                    expectedHeightPx: 3,
                    expectedWidthPx: 3,
                    maxDimensionPx: 100,
                    maxPixels: 10_000,
                },
                outputPath: `/page-${String(pageNumber)}.png`,
                pageNumber,
            })),
        })).rejects.toThrow('contiguous');
        expect(runCommand).not.toHaveBeenCalled();
    });

    it('rejects dimension and pixel-limit violations before starting Poppler', async () => {
        const runCommand = vi.fn();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, createFileSystem());
        const renderTarget = (limits: {
            expectedHeightPx: number;
            expectedWidthPx: number;
            maxDimensionPx: number;
            maxPixels: number;
        }) => renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [{
                limits,
                outputPath: '/page-1.png',
                pageNumber: 1,
            }],
        });

        await expect(renderTarget({
            expectedHeightPx: 1,
            expectedWidthPx: 101,
            maxDimensionPx: 100,
            maxPixels: 10_000,
        })).rejects.toThrow('exceeds limits');
        await expect(renderTarget({
            expectedHeightPx: 11,
            expectedWidthPx: 11,
            maxDimensionPx: 100,
            maxPixels: 100,
        })).rejects.toThrow('exceeds limits');
        expect(runCommand).not.toHaveBeenCalled();
    });

    it('accepts the 1,024-page manifest batch without changing per-page limits', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[]) => {
            const prefix = args.at(-1)!;
            const firstPage = Number(args[args.indexOf('-f') + 1]);
            const lastPage = Number(args[args.indexOf('-l') + 1]);
            expect(firstPage).toBe(1);
            expect(lastPage).toBe(1_024);
            await Promise.all(Array.from({length: lastPage - firstPage + 1}, (_, index) =>
                writeFile(`${prefix}-${String(index + 1).padStart(4, '0')}.png`, PNG)));
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, createFileSystem());
        const targets = Array.from({length: 1_024}, (_, index) => ({
            limits: {
                expectedHeightPx: 1,
                expectedWidthPx: 1,
                maxDimensionPx: 100,
                maxPixels: 10_000,
            },
            outputPath: join(root, `page-${String(index + 1)}.png`),
            pageNumber: index + 1,
        }));

        await expect(renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets,
        })).resolves.toHaveLength(1_024);
        expect(runCommand).toHaveBeenCalledOnce();
        for (const target of targets) {
            expect(await readFile(target.outputPath)).toEqual(PNG);
        }
    });
});
