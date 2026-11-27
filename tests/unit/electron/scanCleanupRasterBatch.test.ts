import {
    mkdtemp,
    open as fsOpen,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    sep,
} from 'node:path';
import type * as TFsPromises from 'node:fs/promises';
import {decode} from 'fast-png';
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
import {
    readPreviewBytes,
    readPreviewMetadata,
} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';
import {encodePngFromPpm} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import type {IScanCleanupRasterDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {IRunCommandOptions} from '@electron/native-tools/runNativeCommand';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

// Keep all 1,024 real PPM handoffs and pixel checks without thousands of disk
// operations. Other cases below still publish through the real filesystem.
const memoryFiles = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof TFsPromises>();
    return {
        ...actual,
        readFile: async (...args: Parameters<typeof actual.readFile>) =>
            memoryFiles.get(String(args[0])) ?? actual.readFile(...args),
    };
});

// One RGB pixel as Poppler writes it when no output format is requested.
const PPM = Buffer.concat([
    Buffer.from('P6\n1 1\n255\n', 'ascii'),
    Buffer.from([
        12,
        34,
        56,
    ]),
]);

/** What a reader of the published raster sees: Poppler's direct P6 PPM bytes. */
async function readPublishedPixels(path: string) {
    const bytes = await readFile(path);
    const header = 'P6\n1 1\n255\n';
    expect(bytes.subarray(0, header.length).toString('ascii')).toBe(header);
    return {
        width: 1,
        height: 1,
        channels: 3,
        pixels: [...bytes.subarray(header.length)],
    };
}

const PUBLISHED_PIXEL = {
    width: 1,
    height: 1,
    channels: 3,
    pixels: [
        12,
        34,
        56,
    ],
};
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
    memoryFiles.clear();
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan cleanup raster batch renderer', () => {
    it('preserves partial Poppler output when native termination is unproven', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        let partialPath = '';
        const failure = markUnprovenNativeTermination(
            new DOMException('Poppler cancellation could not stop its writer', 'AbortError'),
            'Poppler process tree remains unproven',
        );
        const renderBatch = createScanCleanupRasterBatchRenderer(async (_binary, args) => {
            partialPath = `${args.at(-1)!}-1.ppm`;
            await writeFile(partialPath, PPM);
            throw failure;
        }, createFileSystem());

        await expect(renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: join(root, 'source.pdf'),
            targets: [{
                pageNumber: 1,
                outputPath: join(root, 'page-1.png'),
                limits: {
                    expectedHeightPx: 1,
                    expectedWidthPx: 1,
                    maxPixels: 100,
                    maxDimensionPx: 10,
                },
            }],
        })).rejects.toBe(failure);

        await expect(readFile(partialPath), 'the unproven native writer must retain its batch directory and partial bytes').resolves.toEqual(PPM);
        await expect(stat(join(root, 'page-1.png'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('renders one contiguous window with one Poppler process and publishes every target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[], options?: IRunCommandOptions) => {
            const prefix = args.at(-1)!;
            await Promise.all([
                writeFile(`${prefix}-0017.ppm`, PPM),
                writeFile(`${prefix}-0018.ppm`, PPM),
            ]);
            const stderr = `17 18 ${prefix}-0017.ppm\n18 18 ${prefix}-0018.ppm\n`;
            options?.onStderr?.(stderr);
            return {
                exitCode: 0,
                stderr,
                stdout: '',
            };
        });
        const fileSystem = createFileSystem();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, fileSystem);
        const renderedPages: number[] = [];
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
            onPageRendered: pageNumber => renderedPages.push(pageNumber),
        });

        expect(runCommand).toHaveBeenCalledOnce();
        // Poppler's own PNG writer is fixed at maximum compression; it is
        // asked for PPM and the batch publishes a fast lossless PNG.
        expect(runCommand.mock.calls[0]?.[1]).toEqual([
            '-progress',
            '-cropbox',
            '-hide-annotations',
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
        expect(renderedPages).toEqual([
            17,
            18,
        ]);
        expect(await readPublishedPixels(targets[0]!.outputPath)).toEqual(PUBLISHED_PIXEL);
        expect(await readPublishedPixels(targets[1]!.outputPath)).toEqual(PUBLISHED_PIXEL);
        expect((await readdir(root)).sort()).toEqual([
            'page-17.png',
            'page-18.png',
        ]);
    });

    it.each([
        {ending: '\n', platform: 'LF'},
        {ending: '\r\n', platform: 'CRLF'},
    ])('reports completed pages from split $platform records before Poppler exits', async ({ending}) => {
        const root = await mkdtemp(join(tmpdir(), 'scan cleanup raster batch test-'));
        roots.push(root);
        const renderedPages: number[] = [];
        const progressBeforeExit: number[][] = [];
        const renderBatch = createScanCleanupRasterBatchRenderer(async (_binary, args, options?: IRunCommandOptions) => {
            const prefix = args.at(-1)!;
            const first = `${prefix}-1.ppm`;
            const second = `${prefix}-2.ppm`;
            const firstRecord = `1 2 ${first}${ending}`;
            const secondRecord = `2 2 ${second}${ending}`;
            const warning = `Syntax Warning: skipping object 2 2${ending}`;
            const chunks = [
                firstRecord.slice(0, 2),
                firstRecord.slice(2, -1),
                firstRecord.slice(-1) + warning.slice(0, 12),
                warning.slice(12) + secondRecord.slice(0, 3),
                secondRecord.slice(3),
            ];
            await writeFile(first, PPM);
            for (const chunk of chunks.slice(0, -1)) {
                options?.onStderr?.(chunk);
                progressBeforeExit.push([...renderedPages]);
            }
            await writeFile(second, PPM);
            options?.onStderr?.(chunks[4]!);
            progressBeforeExit.push([...renderedPages]);
            return {
                exitCode: 0,
                stderr: chunks.join(''),
                stdout: '',
            };
        }, createFileSystem());

        const results = await renderBatch({
            dpi: 150,
            log: vi.fn(),
            onPageRendered: pageNumber => renderedPages.push(pageNumber),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: join(root, 'source.pdf'),
            targets: [
                1,
                2,
            ].map(pageNumber => ({
                limits: {
                    expectedHeightPx: 1,
                    expectedWidthPx: 1,
                    maxPixels: 100,
                    maxDimensionPx: 10,
                },
                outputPath: join(root, `page-${String(pageNumber)}.png`),
                pageNumber,
            })),
        });

        expect(progressBeforeExit).toEqual([
            [],
            [],
            [1],
            [1],
            [
                1,
                2,
            ],
        ]);
        expect(renderedPages).toEqual(results.map(result => result.pageNumber));
        expect(results).toHaveLength(2);
    });

    it('keeps a rendered batch when its progress callback throws', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[], options?: IRunCommandOptions) => {
            const output = `${args.at(-1)!}-0003.ppm`;
            await writeFile(output, PPM);
            const stderr = `3 3 ${output}\n`;
            options?.onStderr?.(stderr);
            return {
                exitCode: 0,
                stderr,
                stdout: '',
            };
        });
        const log = vi.fn();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, createFileSystem());
        const outputPath = join(root, 'page-3.png');

        const results = await renderBatch({
            dpi: 150,
            log,
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [{
                limits: {
                    expectedHeightPx: 3,
                    expectedWidthPx: 3,
                    maxDimensionPx: 100,
                    maxPixels: 10_000,
                },
                outputPath,
                pageNumber: 3,
            }],
            onPageRendered: () => {
                throw new Error('progress channel closed');
            },
        });

        expect(results).toEqual([{
            height: 1,
            pageNumber: 3,
            width: 1,
        }]);
        expect(await readPublishedPixels(outputPath)).toEqual(PUBLISHED_PIXEL);
        expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('progress channel closed'));
    });

    it('keeps published rasters when scratch cleanup fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[]) => {
            const prefix = args.at(-1)!;
            await writeFile(`${prefix}-0001.ppm`, PPM);
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const fileSystem = createFileSystem();
        const cleanupError = new Error('scratch cleanup failed');
        vi.mocked(fileSystem.rm).mockRejectedValueOnce(cleanupError);
        const log = vi.fn();
        const outputPath = join(root, 'page-1.png');
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, fileSystem);

        await expect(renderBatch({
            dpi: 150,
            log,
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [{
                limits: {
                    expectedHeightPx: 1,
                    expectedWidthPx: 1,
                    maxDimensionPx: 100,
                    maxPixels: 10_000,
                },
                outputPath,
                pageNumber: 1,
            }],
        })).resolves.toEqual([{
            height: 1,
            pageNumber: 1,
            width: 1,
        }]);
        expect(await readPublishedPixels(outputPath)).toEqual(PUBLISHED_PIXEL);
        expect(log).toHaveBeenCalledWith(
            'warn',
            'Scan cleanup could not remove raster batch scratch directory: scratch cleanup failed',
        );
    });

    it('does not report pages after Poppler fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async () => {
            throw new Error('pdftoppm failed');
        });
        const renderedPages: number[] = [];
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, createFileSystem());

        await expect(renderBatch({
            dpi: 150,
            log: vi.fn(),
            onPageRendered: pageNumber => renderedPages.push(pageNumber),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [
                1,
                2,
            ].map(pageNumber => ({
                limits: {
                    expectedHeightPx: 1,
                    expectedWidthPx: 1,
                    maxDimensionPx: 100,
                    maxPixels: 10_000,
                },
                outputPath: join(root, `page-${String(pageNumber)}.png`),
                pageNumber,
            })),
        })).rejects.toThrow('pdftoppm failed');
        expect(renderedPages).toEqual([]);
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
        const root = '/memory-raster-batch';
        const scratch = join(root, 'pdftoppm-batch-test');
        const ppmPath = join(tmpdir(), `scan-cleanup-ppm-${process.pid}`);
        await writeFile(ppmPath, PPM);
        const ppmStat = await stat(ppmPath);
        await rm(ppmPath);
        const runCommand = vi.fn(async (_binary: string, args: string[]) => {
            const prefix = args.at(-1)!;
            const firstPage = Number(args[args.indexOf('-f') + 1]);
            const lastPage = Number(args[args.indexOf('-l') + 1]);
            expect(firstPage).toBe(1);
            expect(lastPage).toBe(1_024);
            for (let page = firstPage; page <= lastPage; page += 1) {
                memoryFiles.set(`${prefix}-${String(page).padStart(4, '0')}.ppm`, PPM);
            }
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand, {
            mkdtemp: async () => scratch,
            open: async path => ({
                read: async (buffer, offset, length, position) => ({bytesRead: memoryFiles.get(path)!.copy(buffer, offset, position, position + length)}),
                stat: async () => ppmStat,
                close: async () => undefined,
            }),
            readdir: async () => Array.from({length: 1_024}, (_, index) => ({
                isFile: () => true,
                name: `page-${String(index + 1).padStart(4, '0')}.ppm`,
            })),
            rename: async (source, target) => {
                const bytes = memoryFiles.get(source);
                if (!bytes) {throw new Error(`Missing encoded raster: ${source}`);}
                memoryFiles.set(target, bytes);
                memoryFiles.delete(source);
            },
            rm: async () => {
                for (const path of memoryFiles.keys()) {
                    if (path.startsWith(`${scratch}${sep}`)) {memoryFiles.delete(path);}
                }
            },
        });
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
            expect(await readPublishedPixels(target.outputPath)).toEqual(PUBLISHED_PIXEL);
        }
    });

    it('reads detection-retained PPM rasters for both path-only preview metadata and preview PNG bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-ppm-preview-'));
        roots.push(root);
        const retainedPath = join(root, 'page-1-150.png');
        const ppm = Buffer.concat([
            Buffer.from('P6\n2 1\n255\n', 'ascii'),
            Buffer.from([
                12,
                34,
                56,
                200,
                150,
                100,
            ]),
        ]);
        await writeFile(retainedPath, ppm);
        const deps = {
            open: (path: string, flags: 'r') => fsOpen(path, flags),
            readFile: (path: string) => readFile(path),
            stat: (path: string) => stat(path),
        } as unknown as IScanCleanupRasterDependencies;

        await expect(readPreviewMetadata(retainedPath, deps)).resolves.toEqual({
            width: 2,
            height: 1,
            sizeBytes: ppm.byteLength,
        });
        const pngBytes = await readPreviewBytes(retainedPath, deps);
        const decoded = decode(pngBytes);
        expect({
            width: decoded.width,
            height: decoded.height,
            channels: decoded.channels,
            pixels: [...decoded.data],
        }).toEqual({
            width: 2,
            height: 1,
            channels: 3,
            pixels: [
                12,
                34,
                56,
                200,
                150,
                100,
            ],
        });
    });

    it('streams preview PPM-to-PNG conversion asynchronously without blocking the event loop and enforces byte caps', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-ppm-stream-'));
        roots.push(root);
        const retainedPath = join(root, 'page-1-150.png');
        // Multi-block high-entropy PPM (~6 MiB) so streaming spans multiple 1 MiB zlib thread-pool blocks.
        const width = 1_400;
        const height = 1_400;
        const header = Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, 'ascii');
        const pixels = Buffer.allocUnsafe(width * height * 3);
        let state = 0x1234_5678;
        for (let index = 0; index < pixels.byteLength; index += 1) {
            state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
            pixels[index] = state >>> 24;
        }
        await writeFile(retainedPath, Buffer.concat([
            header,
            pixels,
        ]));
        const readFileSpy = vi.fn((path: string) => readFile(path));
        const deps = {
            open: (path: string, flags: 'r') => fsOpen(path, flags),
            readFile: readFileSpy,
            stat: (path: string) => stat(path),
        } as unknown as IScanCleanupRasterDependencies;

        let timerFiredBeforeCompletion = false;
        let finished = false;
        const encodePromise = readPreviewBytes(retainedPath, deps).finally(() => {
            finished = true;
        });
        await new Promise<void>(resolve => {
            setTimeout(() => {
                timerFiredBeforeCompletion = !finished;
                resolve();
            }, 0);
        });
        const pngBytes = await encodePromise;

        expect(timerFiredBeforeCompletion).toBe(true);
        expect(readFileSpy).not.toHaveBeenCalled();
        const decoded = decode(pngBytes);
        expect(decoded.width).toBe(width);
        expect(decoded.height).toBe(height);
        expect(decoded.channels).toBe(3);
        expect(Buffer.compare(Buffer.from(decoded.data), pixels)).toBe(0);

        await expect(encodePngFromPpm(retainedPath, {
            maxPixels: width * height,
            maxDimensionPx: width,
            maxOutputBytes: 1_024,
            open: (path: string, flags: 'r') => fsOpen(path, flags),
        })).rejects.toThrow('Encoded PNG exceeds 1024 bytes');
    });
});
