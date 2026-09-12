import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import { tmpdir } from 'os';
import { join } from 'path';
import {
    existsSync,
    readdirSync,
} from 'fs';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import type * as FsPromises from 'fs/promises';
import type * as WorkerTask from '@electron/utils/workerTask';
import * as utifModule from 'utif';
import { decode as decodePng } from 'fast-png';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IManagedScratchDir {
    path: string;
    prefix: string;
}

interface IImageExportProgressForTest {
    phase: string;
    processed: number;
}

interface IRenderedRasterSize {
    width: number;
    height: number;
}

const mocks = vi.hoisted(() => ({
    runCommand: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    createManagedScratchTempDir: vi.fn(async (_prefix: string) => ''),
    managedScratchDirs: [] as IManagedScratchDir[],
    renderPageCount: 2,
    pdfPageCount: 2,
    nativeImageCombinePath: null as string | null,
    pdfimagesPath: undefined as string | undefined,
    popplerDataDir: undefined as string | undefined,
    popplerFontConfigDir: undefined as string | undefined,
    sourceImageDpi: 360,
    pageWidthPts: 439.6,
    pageHeightPts: 670,
    renderedRasterSizes: [] as IRenderedRasterSize[],
    requestedRenderDpis: [] as number[],
    tiffDescriptorReadCount: 0,
    tiffWorkerPath: null as string | null,
    tiffWorkerPageGroups: [] as string[][],
    tiffWorkerStarted: false,
    tiffWorkerBlock: false,
    nativeTiffCombineEnabled: false,
    nativeTiffCombinePageGroups: [] as string[][],
    nativeTiffCombineStarted: false,
    nativeTiffCombineBlock: false,
    pageSizeOverrides: {} as Record<number, {
        widthPts: number;
        heightPts: number
    }>,
}));

// Mirrors the production bounded stdout capture in appendTextChunkWithByteCap:
// every byte is delivered, but the retained buffer keeps only a bounded tail.
const MOCK_NATIVE_MAX_STDOUT_BYTES = 262_144;

function simulateBoundedStdoutCapture(output: string) {
    if (Buffer.byteLength(output, 'utf8') <= MOCK_NATIVE_MAX_STDOUT_BYTES) {
        return output;
    }
    const tailBytes = Math.floor(MOCK_NATIVE_MAX_STDOUT_BYTES * 0.9);
    return output.slice(Math.max(0, output.length - tailBytes));
};

vi.mock('fs/promises', async () => {
    const actual = await vi.importActual<typeof FsPromises>('fs/promises');
    return {
        ...actual,
        readFile: async (path: Parameters<typeof actual.readFile>[0], ...args: Parameters<typeof actual.readFile> extends [unknown, ...infer Rest] ? Rest : never) => {
            if (String(path) === '/tmp/input.pdf') {
                return Buffer.from('%PDF-1.7\n%%EOF\n');
            }
            if (String(path).includes('/render-pages-') && /\.tif{1,2}$/u.test(String(path))) {
                mocks.tiffDescriptorReadCount += 1;
            }
            return actual.readFile(path, ...args);
        },
        rename: mocks.rename,
        stat: mocks.stat,
    };
});

vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({
        pdftoppm: '/mock/pdftoppm',
        pdfinfo: '/mock/pdfinfo',
        qpdf: '/mock/qpdf',
        pdfimages: mocks.pdfimagesPath,
        popplerDataDir: mocks.popplerDataDir,
        popplerFontConfigDir: mocks.popplerFontConfigDir,
    }),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runCommand}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineDisabled: () => mocks.nativeImageCombinePath === null,
    resolveNativePdfImageCombinePath: () => mocks.nativeImageCombinePath,
}));
vi.mock('@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner', async () => {
    const actual = await vi.importActual<typeof FsPromises>('fs/promises');
    return {tryCombinePagesWithNativeTiffCombiner: async (
        pagePaths: string[],
        outputPath: string,
        signal?: AbortSignal,
    ) => {
        if (!mocks.nativeTiffCombineEnabled) {
            return false;
        }

        mocks.nativeTiffCombinePageGroups.push([...pagePaths]);
        mocks.nativeTiffCombineStarted = true;
        if (mocks.nativeTiffCombineBlock) {
            await new Promise<void>((resolve, reject) => {
                const handleAbort = () => {
                    signal?.removeEventListener('abort', handleAbort);
                    reject(signal?.reason ?? new DOMException('TIFF combine canceled', 'AbortError'));
                };
                if (signal?.aborted) {
                    handleAbort();
                    return;
                }
                signal?.addEventListener('abort', handleAbort, {once: true});
            });
        }

        await actual.writeFile(outputPath, Buffer.from('mock-native-tiff'));
        return true;
    }};
});
vi.mock('@electron/utils/workerTask', async () => {
    const actual = await vi.importActual<typeof WorkerTask>('@electron/utils/workerTask');
    return {
        ...actual,
        resolveUnpackedWorkerPath: (...args: Parameters<typeof actual.resolveUnpackedWorkerPath>) =>
            mocks.tiffWorkerPath ?? actual.resolveUnpackedWorkerPath(...args),
        runResultWorkerTask: async (options: {
            signal?: AbortSignal;
            workerData: unknown;
        }) => {
            const workerData = options.workerData as {
                deleteSourcePages?: unknown;
                outputPath?: unknown;
                pagePaths?: unknown;
            };
            if (typeof workerData.outputPath !== 'string' || !Array.isArray(workerData.pagePaths)
                || !workerData.pagePaths.every((path): path is string => typeof path === 'string')) {
                throw new Error('Invalid mock TIFF worker payload');
            }

            mocks.tiffWorkerPageGroups.push([...workerData.pagePaths]);
            mocks.tiffWorkerStarted = true;
            if (mocks.tiffWorkerBlock) {
                await new Promise<void>((resolve, reject) => {
                    const handleAbort = () => {
                        options.signal?.removeEventListener('abort', handleAbort);
                        reject(options.signal?.reason ?? new DOMException('TIFF combine canceled', 'AbortError'));
                    };
                    if (options.signal?.aborted) {
                        handleAbort();
                        return;
                    }
                    options.signal?.addEventListener('abort', handleAbort, {once: true});
                });
            }

            const actualFs = await vi.importActual<typeof FsPromises>('fs/promises');
            await actualFs.writeFile(workerData.outputPath, Buffer.from('mock-worker-tiff'));
            if (workerData.deleteSourcePages === true) {
                await Promise.all(workerData.pagePaths.map(path => actualFs.rm(path, {force: true})));
            }
            return undefined;
        },
    };
});
vi.mock('pdf-lib', () => ({PDFDocument: {load: vi.fn(async () => ({ getPageCount: () => mocks.pdfPageCount }))}}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/utils/managedScratchTemp', () => ({
    createManagedScratchTempDir: (...args: [string]) => mocks.createManagedScratchTempDir(...args),
    usingManagedScratchScope: async (prefix: string, run: (scratchPath: string) => Promise<unknown>) => {
        const scratchPath = await mocks.createManagedScratchTempDir(prefix);
        try {
            return await run(scratchPath);
        } finally {
            await rm(scratchPath, {
                force: true,
                recursive: true,
            });
        }
    },
}));

const {
    createPageRanges,
    exportPdfAsMultiPageTiff,
    exportPdfPagesAsImages,
    normalizeImageExportPath,
    promoteStagedFiles,
    createStagedFilePublicationLedger,
    rollbackStagedFilePublications,
} = await import('@electron/features/image-export/main/export');
const { IMAGE_EXPORT_MAX_NETPBM_READ_BYTES } = await import('@electron/features/image-export/main/imageExportResourceLimits');
const {
    combinePagesIntoMultiPageTiffLocal,
    estimateMultiPageTiffByteLength,
    splitTiffPageDescriptorsForClassicLimit,
} = await import('@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal');

const UTIF = utifModule;

function computePdftoppmRasterSize(args: string[]): IRenderedRasterSize {
    const scaleToIndex = args.indexOf('-scale-to');
    const resolutionIndex = args.indexOf('-r');
    const requestedDpi = resolutionIndex >= 0 ? Number.parseFloat(String(args[resolutionIndex + 1])) : 150;
    const effectiveDpi = scaleToIndex >= 0
        ? (72 * Number.parseFloat(String(args[scaleToIndex + 1]))) / Math.max(mocks.pageWidthPts, mocks.pageHeightPts)
        : requestedDpi;

    return {
        width: Math.ceil((mocks.pageWidthPts * effectiveDpi) / 72),
        height: Math.ceil((mocks.pageHeightPts * effectiveDpi) / 72),
    };
}

function expectSinglePixelPng(bytes: Uint8Array, rgb: [number, number, number]) {
    const decoded = decodePng(bytes);
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(decoded.channels).toBe(3);
    expect(Array.from(decoded.data.slice(0, 3))).toEqual(rgb);
}

function countTiffDirectories(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = view.getUint32(4, false);
    let count = 0;

    while (offset !== 0) {
        expect(offset + 2).toBeLessThanOrEqual(bytes.byteLength);
        const entryCount = view.getUint16(offset, false);
        const nextPointerOffset = offset + 2 + (entryCount * 12);
        expect(nextPointerOffset + 4).toBeLessThanOrEqual(bytes.byteLength);
        offset = view.getUint32(nextPointerOffset, false);
        count += 1;
        expect(count).toBeLessThan(256);
    }

    return count;
}

describe('image export', () => {
    let tempDir = '';

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'image-export-test-'));
        mocks.runCommand.mockReset();
        mocks.stat.mockReset();
        mocks.rename.mockReset();
        mocks.atomicReplace.mockReset();
        mocks.makeSiblingTempPath.mockReset();
        mocks.makeSiblingTempPath.mockImplementation((targetPath: string) => `${targetPath}.tmp`);
        mocks.managedScratchDirs.length = 0;
        mocks.createManagedScratchTempDir.mockImplementation(async (prefix: string) => {
            const path = await mkdtemp(join(tempDir, prefix));
            mocks.managedScratchDirs.push({
                path,
                prefix,
            });
            return path;
        });
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;
        mocks.nativeImageCombinePath = null;
        mocks.pdfimagesPath = undefined;
        mocks.popplerDataDir = undefined;
        mocks.popplerFontConfigDir = undefined;
        mocks.sourceImageDpi = 360;
        mocks.pageWidthPts = 439.6;
        mocks.pageHeightPts = 670;
        mocks.renderedRasterSizes.length = 0;
        mocks.requestedRenderDpis.length = 0;
        mocks.tiffDescriptorReadCount = 0;
        mocks.tiffWorkerPath = null;
        mocks.tiffWorkerPageGroups.length = 0;
        mocks.tiffWorkerStarted = false;
        mocks.tiffWorkerBlock = false;
        mocks.nativeTiffCombineEnabled = false;
        mocks.nativeTiffCombinePageGroups.length = 0;
        mocks.nativeTiffCombineStarted = false;
        mocks.nativeTiffCombineBlock = false;
        mocks.pageSizeOverrides = {};
        mocks.stat.mockImplementation(async () => ({
            isFile: () => true,
            size: 1024,
        }));
        mocks.rename.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });
        mocks.runCommand.mockImplementation(async (command: string, args: string[], options?: {onStdout?: (chunk: string) => void}) => {
            if (command === '/mock/qpdf' && args[0] === '--show-npages') {
                return {
                    stdout: String(mocks.pdfPageCount),
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command === '/mock/pdfinfo') {
                const firstPageArgIndex = args.indexOf('-f');
                const firstPage = firstPageArgIndex >= 0
                    ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                    : 1;
                const lastPageArgIndex = args.indexOf('-l');
                const lastPage = lastPageArgIndex >= 0
                    ? Number.parseInt(String(args[lastPageArgIndex + 1]), 10)
                    : mocks.pdfPageCount;

                const lines = [`Pages:           ${mocks.pdfPageCount}`];
                for (let page = firstPage; page <= lastPage; page += 1) {
                    const overriddenSize = mocks.pageSizeOverrides[page];
                    lines.push(`Page ${String(page).padStart(4, ' ')} rot:  0`);
                    lines.push(`Page ${String(page).padStart(4, ' ')} size:  ${overriddenSize?.widthPts ?? mocks.pageWidthPts} x ${overriddenSize?.heightPts ?? mocks.pageHeightPts} pts`);
                }
                const fullOutput = lines.join('\n');
                // The real runner streams every stdout byte before the bounded
                // capture trims its retained buffer, so deliver full chunks here.
                for (let offset = 0; offset < fullOutput.length; offset += 4096) {
                    options?.onStdout?.(fullOutput.slice(offset, offset + 4096));
                }

                return {
                    stdout: simulateBoundedStdoutCapture(fullOutput),
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command === mocks.pdfimagesPath) {
                const firstPageArgIndex = args.indexOf('-f');
                const lastPageArgIndex = args.indexOf('-l');
                const firstPage = firstPageArgIndex >= 0
                    ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                    : 1;
                const lastPage = lastPageArgIndex >= 0
                    ? Number.parseInt(String(args[lastPageArgIndex + 1]), 10)
                    : mocks.pdfPageCount;

                return {
                    stdout: [
                        'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                        ...Array.from({ length: lastPage - firstPage + 1 }, (_, index) => {
                            const page = firstPage + index;
                            return `${String(page).padStart(4, ' ')}     0 image     100   100  rgb     3   8  image  no         1  0   ${mocks.sourceImageDpi}   ${mocks.sourceImageDpi} 1.0K 1.0%`;
                        }),
                    ].join('\n'),
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command === mocks.nativeImageCombinePath) {
                expect(args).toContain('png');
                const outputArgIndex = args.indexOf('--output');
                const outputPath = args[outputArgIndex + 1];
                if (typeof outputPath !== 'string') {
                    throw new Error('Expected native image combiner output path');
                }
                await writeFile(outputPath, 'native-png');
                return {
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                };
            }

            if (command !== '/mock/pdftoppm') {
                throw new Error(`Unexpected command: ${command}`);
            }

            const prefix = args[args.length - 1];
            if (typeof prefix !== 'string') {
                throw new Error('Expected pdftoppm output prefix');
            }

            const dpiArgIndex = args.indexOf('-r');
            if (dpiArgIndex >= 0) {
                mocks.requestedRenderDpis.push(Number.parseFloat(String(args[dpiArgIndex + 1])));
            }

            const formatArg = args.includes('-png')
                ? '-png'
                : args.includes('-jpeg')
                    ? '-jpeg'
                    : args.includes('-tiff')
                        ? '-tiff'
                        : '-ppm';
            const extension = formatArg === '-png'
                ? 'png'
                : formatArg === '-jpeg'
                    ? 'jpg'
                    : formatArg === '-tiff'
                        ? 'tif'
                        : 'ppm';

            const firstPageArgIndex = args.indexOf('-f');
            const lastPageArgIndex = args.indexOf('-l');
            const firstPage = firstPageArgIndex >= 0
                ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                : 1;
            const lastPage = lastPageArgIndex >= 0
                ? Number.parseInt(String(args[lastPageArgIndex + 1]), 10)
                : mocks.renderPageCount;
            const rasterSize = computePdftoppmRasterSize(args);

            for (let page = firstPage; page <= lastPage; page += 1) {
                mocks.renderedRasterSizes.push(rasterSize);
                const pageBytes = extension === 'tif'
                    ? Buffer.from(UTIF.encodeImage(new Uint8Array([
                        page === 1 ? 255 : 0,
                        page === 2 ? 255 : 0,
                        0,
                        255,
                    ]), 1, 1))
                    : extension === 'ppm'
                        ? Buffer.concat([
                            Buffer.from('P6\n1 1\n255\n'),
                            Buffer.from([
                                page,
                                0,
                                0,
                            ]),
                        ])
                        : Buffer.from(`page-${page}-${extension}`);
                await writeFile(`${prefix}-${page}.${extension}`, pageBytes);
            }

            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });
    });

    afterEach(async () => {
        if (tempDir) {
            expect(mocks.managedScratchDirs.every(({path}) => !existsSync(path))).toBe(true);
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('creates a multi-page TIFF without host tool fallbacks', async () => {
        const outputPath = join(tempDir, 'exported.tiff');
        const controller = new AbortController();

        const resultPaths = await exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {
            cancelGroup: 'tiff-export-1',
            signal: controller.signal,
        });
        expect(resultPaths).toEqual([outputPath]);

        const outputBytes = new Uint8Array(await readFile(outputPath));
        const ifds = UTIF.decode(outputBytes);
        expect(ifds.length).toBeGreaterThanOrEqual(2);

        UTIF.decodeImage(outputBytes, ifds[0]!);
        UTIF.decodeImage(outputBytes, ifds[1]!);

        const firstRgba = UTIF.toRGBA8(ifds[0]!);
        const secondRgba = UTIF.toRGBA8(ifds[1]!);

        expect(Array.from(firstRgba.slice(0, 4))).toEqual([
            255,
            0,
            0,
            255,
        ]);
        expect(Array.from(secondRgba.slice(0, 4))).toEqual([
            0,
            255,
            0,
            255,
        ]);

        expect(mocks.runCommand).toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.any(Array),
            expect.objectContaining({
                cancelGroup: 'tiff-export-1',
                timeoutMs: 180_000,
                commandLabel: 'pdftoppm(export-tiff)',
                signal: controller.signal,
            }),
        );
        expect(mocks.runCommand).toHaveBeenCalledWith(
            '/mock/qpdf',
            [
                '--show-npages',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                cancelGroup: 'tiff-export-1',
                signal: controller.signal,
            }),
        );
    });

    it('aborts image export while its page-count protocol wait is pending', async () => {
        const outputPath = join(tempDir, 'page-count-canceled.png');
        const controller = new AbortController();
        let pageCountSignal: AbortSignal | undefined;
        mocks.runCommand.mockImplementationOnce((
            _command: string,
            _args: string[],
            options: {
                cancelGroup?: string;
                signal?: AbortSignal;
            },
        ) => {
            pageCountSignal = options.signal;
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
            });
        });

        const exportPromise = exportPdfPagesAsImages('/tmp/input.pdf', outputPath, {
            cancelGroup: 'image-export-page-count',
            signal: controller.signal,
        });

        await vi.waitFor(() => expect(pageCountSignal).toBe(controller.signal));
        expect(mocks.runCommand).toHaveBeenCalledWith(
            '/mock/qpdf',
            [
                '--show-npages',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                cancelGroup: 'image-export-page-count',
                signal: controller.signal,
            }),
        );

        controller.abort(new DOMException('page count canceled', 'AbortError'));

        await expect(exportPromise).rejects.toThrow('page count canceled');
        expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    });

    it('reports multi-page TIFF render and combine progress', async () => {
        const outputPath = join(tempDir, 'progress.tiff');
        const progress = vi.fn();

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {onProgress: progress}))
            .resolves
            .toEqual([outputPath]);

        expect(progress).toHaveBeenCalledWith({
            phase: 'rendering',
            processed: 0,
            total: 2,
            percent: 0,
        });
        expect(progress).toHaveBeenCalledWith({
            phase: 'rendering',
            processed: 2,
            total: 2,
            percent: 90,
        });
        expect(progress).toHaveBeenCalledWith({
            phase: 'combining',
            processed: 1,
            total: 1,
            percent: 100,
        });
    });

    it('stops multi-page TIFF descriptor planning after rendering is canceled', async () => {
        mocks.renderPageCount = 4;
        mocks.pdfPageCount = 4;
        const controller = new AbortController();
        const outputPath = join(tempDir, 'descriptor-planning-canceled.tiff');

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {
            signal: controller.signal,
            onProgress: progress => {
                if (progress.phase === 'rendering' && progress.processed === progress.total) {
                    controller.abort(new DOMException('descriptor planning canceled', 'AbortError'));
                }
            },
        })).rejects.toMatchObject({
            name: 'AbortError',
            message: 'descriptor planning canceled',
        });

        expect(mocks.tiffDescriptorReadCount).toBe(0);
        expect(existsSync(outputPath)).toBe(false);
        expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    });

    it('combines each TIFF render window before rendering the next window', async () => {
        mocks.renderPageCount = 50;
        mocks.pdfPageCount = 50;
        mocks.tiffWorkerPath = join(tempDir, 'mock-tiff-worker.js');
        await writeFile(mocks.tiffWorkerPath, 'mock worker');
        let firstWindowReleasedBeforeSecondRender = false;
        const defaultRunCommand = mocks.runCommand.getMockImplementation();
        if (!defaultRunCommand) {
            throw new Error('Expected default command mock');
        }
        mocks.runCommand.mockImplementation(async (
            command: string,
            args: string[],
            options?: Record<string, unknown>,
        ) => {
            if (command === '/mock/pdftoppm') {
                const firstPageArgIndex = args.indexOf('-f');
                const firstPage = firstPageArgIndex >= 0
                    ? Number.parseInt(String(args[firstPageArgIndex + 1]), 10)
                    : 1;
                if (firstPage > 1) {
                    const firstWindowPaths = mocks.tiffWorkerPageGroups[0] ?? [];
                    firstWindowReleasedBeforeSecondRender = firstWindowPaths.length > 0
                        && firstWindowPaths.every(pagePath => !existsSync(pagePath));
                }
            }
            return defaultRunCommand(command, args, options);
        });

        const outputPath = join(tempDir, 'windowed.tiff');
        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath)).resolves.toEqual([
            join(tempDir, 'windowed-part-001.tiff'),
            join(tempDir, 'windowed-part-002.tiff'),
        ]);

        expect(mocks.tiffWorkerPageGroups).toHaveLength(2);
        expect(mocks.tiffWorkerPageGroups.map(group => group.length)).toEqual([
            25,
            25,
        ]);
        expect(firstWindowReleasedBeforeSecondRender).toBe(true);
        expect(mocks.tiffWorkerPageGroups.flat().every(pagePath => !existsSync(pagePath))).toBe(true);
    });

    it('cancels a TIFF combine without publishing output or retaining scratch', async () => {
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;
        mocks.tiffWorkerPath = join(tempDir, 'mock-tiff-worker.js');
        await writeFile(mocks.tiffWorkerPath, 'mock worker');
        mocks.tiffWorkerBlock = true;
        const controller = new AbortController();
        const outputPath = join(tempDir, 'combine-canceled.tiff');
        const exportPromise = exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {signal: controller.signal});

        await vi.waitFor(() => expect(mocks.tiffWorkerStarted).toBe(true));
        controller.abort(new DOMException('combine canceled', 'AbortError'));

        await expect(exportPromise).rejects.toMatchObject({
            name: 'AbortError',
            message: 'combine canceled',
        });
        expect(existsSync(outputPath)).toBe(false);
        expect(existsSync(`${outputPath}.tmp`)).toBe(false);
        expect(mocks.tiffWorkerPageGroups).toHaveLength(1);
    });

    it('renders every page at its source resolution instead of upscaling it', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.renderPageCount = 6;
        mocks.pdfPageCount = 6;

        const outputPath = join(tempDir, 'native-scale.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toHaveLength(6);

        expect(mocks.renderedRasterSizes).toHaveLength(6);
        expect(mocks.renderedRasterSizes.every(size => size.width === 2198 && size.height === 3350)).toBe(true);
    });

    it('probes the source resolution a bounded number of times regardless of render chunking', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.renderPageCount = 100;
        mocks.pdfPageCount = 100;

        const outputPath = join(tempDir, 'sampled-probe.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toHaveLength(100);

        const renderChunkCount = mocks.runCommand.mock.calls.filter(([command]) => command === '/mock/pdftoppm').length;
        expect(renderChunkCount).toBe(20);

        const probedPageCount = mocks.runCommand.mock.calls
            .filter(([command]) => command === '/mock/pdfimages')
            .reduce((total, call) => {
                const args = call[1];
                const firstPage = Number.parseInt(String(args[args.indexOf('-f') + 1]), 10);
                const lastPage = Number.parseInt(String(args[args.indexOf('-l') + 1]), 10);
                return total + (lastPage - firstPage + 1);
            }, 0);
        expect(probedPageCount).toBeLessThanOrEqual(8);
    });

    it('plans past former page-count limits in bounded lazy ranges', () => {
        for (const pageCount of [
            501,
            100_001,
        ]) {
            let batchCount = 0;
            let coveredPages = 0;
            let previousLastPage = 0;
            for (const pageRange of createPageRanges(pageCount, 25)) {
                expect(pageRange.firstPage).toBe(previousLastPage + 1);
                expect(pageRange.lastPage - pageRange.firstPage + 1).toBeLessThanOrEqual(25);
                coveredPages += pageRange.lastPage - pageRange.firstPage + 1;
                previousLastPage = pageRange.lastPage;
                batchCount += 1;
            }

            expect(coveredPages).toBe(pageCount);
            expect(previousLastPage).toBe(pageCount);
            expect(batchCount).toBe(Math.ceil(pageCount / 25));
        }
        expect(mocks.runCommand).not.toHaveBeenCalled();
    });

    it('allows staged image output to exceed the former document-wide byte cap', async () => {
        mocks.renderPageCount = 60;
        mocks.pdfPageCount = 60;
        mocks.stat.mockImplementation(async () => ({
            isFile: () => true,
            size: 40 * 1024 * 1024,
        }));

        const outputPath = join(tempDir, 'large-document.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toHaveLength(60);
    });

    it('refuses a PDF image export above the output-path budget before rendering', async () => {
        mocks.pdfPageCount = 100_001;
        const defaultRunCommand = mocks.runCommand.getMockImplementation();
        if (!defaultRunCommand) {
            throw new Error('Expected default command mock');
        }
        mocks.runCommand.mockImplementation(async (
            command: string,
            args: string[],
            options?: {onStdout?: (chunk: string) => void},
        ) => {
            if (command === '/mock/pdftoppm') {
                throw new Error('PDF rendering must not start for an oversized output');
            }
            return defaultRunCommand(command, args, options);
        });

        const outputPath = join(tempDir, 'oversized-output-path-budget.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).rejects.toMatchObject({name: 'ImageExportOutputBudgetError'});
        expect(mocks.runCommand).not.toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.any(Array),
            expect.anything(),
        );
        expect(readdirSync(tempDir)).toEqual([]);
    });

    it('keeps an oversized page inside the PPM read limit instead of scaling it up past the limit', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.sourceImageDpi = 1200;
        mocks.pageWidthPts = 1000;
        mocks.pageHeightPts = 1000;
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'oversized.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const rasterSize = mocks.renderedRasterSizes[0];
        expect(rasterSize).toBeDefined();
        expect(rasterSize!.width * rasterSize!.height * 3).toBeLessThan(IMAGE_EXPORT_MAX_NETPBM_READ_BYTES);
    });

    it('plans export DPI from the complete pdfinfo output when a huge first page precedes thousands of pages', async () => {
        // Regression for EXP-001: the bounded stdout capture keeps only the last
        // ~256 KiB of pdfinfo output, so a huge page 1 inside a 6,000-page
        // document used to be invisible to DPI planning and the export could
        // choose an unsafe DPI for it. The mock reproduces that tail-only
        // buffer while still streaming the full output through onStdout.
        const hugePageSize = {
            widthPts: 2000,
            heightPts: 2000,
        };
        mocks.pdfPageCount = 6_000;
        mocks.pageSizeOverrides[1] = hugePageSize;

        const outputPath = join(tempDir, 'huge-first-page.png');
        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toHaveLength(6_000);

        const ppmHeaderReserveBytes = 64 * 1024;
        const maxRenderDimension = Math.floor(Math.sqrt(
            (IMAGE_EXPORT_MAX_NETPBM_READ_BYTES - ppmHeaderReserveBytes) / 3,
        ));
        const hugePageSafeDpi = Math.floor((maxRenderDimension * 72) / hugePageSize.widthPts);
        expect(hugePageSafeDpi).toBeLessThan(300);
        expect(mocks.requestedRenderDpis.length).toBeGreaterThan(0);
        expect(mocks.requestedRenderDpis.every(dpi => dpi === hugePageSafeDpi)).toBe(true);
    }, 60_000);

    it('uses the default export DPI when the source-resolution probe fails', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const defaultRunCommand = mocks.runCommand.getMockImplementation();
        if (!defaultRunCommand) {
            throw new Error('Expected default command mock');
        }

        mocks.runCommand.mockImplementation(async (command: string, args: string[]) => {
            if (command === '/mock/pdfimages') {
                throw new Error('probe timed out');
            }
            return defaultRunCommand(command, args);
        });

        const outputPath = join(tempDir, 'fallback.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        expect(mocks.renderedRasterSizes[0]).toEqual({
            width: 1832,
            height: 2792,
        });
    });

    it('passes bundled Poppler runtime environment to export Poppler commands', async () => {
        mocks.pdfimagesPath = '/mock/pdfimages';
        mocks.popplerDataDir = '/mock/poppler/share/poppler';
        mocks.popplerFontConfigDir = '/mock/poppler/etc/fonts';
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'poppler-env.png');
        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const expectedEnv = {
            POPPLER_DATADIR: '/mock/poppler/share/poppler',
            FONTCONFIG_PATH: '/mock/poppler/etc/fonts',
            FONTCONFIG_FILE: '/mock/poppler/etc/fonts/fonts.conf',
        };
        const pdfimagesCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdfimages');
        expect(pdfimagesCall?.[2]).toMatchObject({env: expectedEnv});
        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[2]).toMatchObject({env: expectedEnv});
    });

    it('keeps the full TIFF directory chain intact well past the legacy UTIF header limit', async () => {
        const outputPath = join(tempDir, 'large-local-combine.tiff');
        const pagePaths: string[] = [];
        const pageCount = 120;

        for (let index = 0; index < pageCount; index += 1) {
            const pagePath = join(tempDir, `page-${String(index + 1).padStart(3, '0')}.tif`);
            const pageBytes = Buffer.from(UTIF.encodeImage(new Uint8Array([
                index,
                0,
                0,
                255,
            ]), 1, 1));
            await writeFile(pagePath, pageBytes);
            pagePaths.push(pagePath);
        }

        await combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath);

        const outputBytes = new Uint8Array(await readFile(outputPath));
        expect(countTiffDirectories(outputBytes)).toBe(pageCount);

        const ifds = UTIF.decode(outputBytes);
        expect(ifds).toHaveLength(pageCount);
        expect(ifds[0]?.t273?.[0] ?? 0).toBeGreaterThan(20_000);

        UTIF.decodeImage(outputBytes, ifds[pageCount - 1]!);
        const lastRgba = UTIF.toRGBA8(ifds[pageCount - 1]!);
        expect(Array.from(lastRgba.slice(0, 4))).toEqual([
            pageCount - 1,
            0,
            0,
            255,
        ]);
    });

    it('removes local TIFF source pages after a successful native combine', async () => {
        mocks.nativeTiffCombineEnabled = true;
        const pagePaths = [
            join(tempDir, 'native-page-1.tif'),
            join(tempDir, 'native-page-2.tif'),
            join(tempDir, 'native-page-3.tif'),
        ];
        await Promise.all(pagePaths.map(pagePath => writeFile(pagePath, 'source')));
        const outputPath = join(tempDir, 'native-combined.tiff');

        await combinePagesIntoMultiPageTiffLocal(pagePaths, outputPath, {deleteSourcePages: true});

        expect(existsSync(outputPath)).toBe(true);
        expect(pagePaths.every(pagePath => !existsSync(pagePath))).toBe(true);
        expect(mocks.nativeTiffCombinePageGroups).toEqual([pagePaths]);
    });

    it('honors an already-aborted signal before the local TIFF fallback reads pages', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('cancelled', 'AbortError'));

        await expect(combinePagesIntoMultiPageTiffLocal(
            [join(tempDir, 'missing-page.tif')],
            join(tempDir, 'cancelled.tiff'),
            controller.signal,
        )).rejects.toMatchObject({name: 'AbortError'});

        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('rejects a deferred local TIFF WriteStream error without replacing the target', async () => {
        const pagePath = join(tempDir, 'page.tif');
        const outputPath = join(tempDir, 'stream-error.tiff');
        await writeFile(pagePath, Buffer.from(UTIF.encodeImage(new Uint8Array([
            1,
            2,
            3,
            255,
        ]), 1, 1)));
        await import('node:fs/promises').then(({mkdir}) => mkdir(`${outputPath}.tmp`));

        await expect(combinePagesIntoMultiPageTiffLocal([pagePath], outputPath))
            .rejects.toBeInstanceOf(Error);

        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('splits TIFF descriptors into classic-size multi-page parts', () => {
        const descriptors = [
            {
                path: '/tmp/page-1.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
            {
                path: '/tmp/page-2.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
            {
                path: '/tmp/page-3.tif',
                width: 1,
                height: 1,
                dataLength: 400,
            },
        ];
        const twoPageLimit = estimateMultiPageTiffByteLength(descriptors.slice(0, 2));

        expect(splitTiffPageDescriptorsForClassicLimit(descriptors, twoPageLimit)).toEqual([
            [
                descriptors[0],
                descriptors[1],
            ],
            [descriptors[2]],
        ]);
    });

    it('rejects a TIFF split when a single page exceeds the classic-size limit', () => {
        const descriptor = {
            path: '/tmp/page-1.tif',
            width: 1,
            height: 1,
            dataLength: 400,
        };

        expect(() => splitTiffPageDescriptorsForClassicLimit(
            [descriptor],
            estimateMultiPageTiffByteLength([descriptor]) - 1,
        )).toThrow('A single TIFF page exceeds the Classic TIFF 4GB limit');
    });

    it('rejects large TIFF exports when worker startup fails and local fallback is unsafe', async () => {
        mocks.stat.mockImplementation(async (path: string) => ({
            isFile: () => true,
            size: path.includes('-1.tif') || path.includes('-2.tif')
                ? 32 * 1024 * 1024
                : 1024,
        }));

        const outputPath = join(tempDir, 'large-export.tiff');

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('TIFF combine worker unavailable and local fallback is disabled for exports larger than 2 pages or 16MB');
    });

    it('uses sibling temp and atomic replace for image export EXDEV fallback', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.rename.mockRejectedValue(Object.assign(new Error('Cross-device link'), {code: 'EXDEV'}));

        const outputPath = join(tempDir, 'exported.png');
        const tempPath = `${outputPath}.tmp`;

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        expect(mocks.makeSiblingTempPath).toHaveBeenCalledWith(outputPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(`${tempPath}.tmp`, tempPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, outputPath);
        expectSinglePixelPng(new Uint8Array(await readFile(outputPath)), [
            1,
            0,
            0,
        ]);
        expect(existsSync(tempPath)).toBe(false);
    });

    it('normalizes extensionless image targets with a JPEG fallback when requested', () => {
        expect(normalizeImageExportPath(join(tempDir, 'exported'), 'jpeg')).toEqual({
            normalizedPath: join(tempDir, 'exported.jpg'),
            format: 'jpeg',
        });
    });

    it('exports JPEG page images when the target extension is JPG', async () => {
        const outputPath = join(tempDir, 'exported.jpg');
        const firstOutputPath = join(tempDir, 'exported-001.jpg');
        const secondOutputPath = join(tempDir, 'exported-002.jpg');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([
            firstOutputPath,
            secondOutputPath,
        ]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).toContain('-jpeg');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expect(pdftoppmCall?.[1]).not.toContain('-tiff');
        expect(await readFile(firstOutputPath, 'utf8')).toBe('page-1-jpg');
        expect(await readFile(secondOutputPath, 'utf8')).toBe('page-2-jpg');
    });

    it('keeps long multi-page image export names distinct within the filesystem limit', async () => {
        const outputPath = join(tempDir, `${'long-export-name-'.repeat(20)}.png`);
        const firstOutputPath = join(tempDir, `${'long-export-name-'.repeat(20).slice(0, 247)}-001.png`);
        const secondOutputPath = join(tempDir, `${'long-export-name-'.repeat(20).slice(0, 247)}-002.png`);
        let stagedPathIndex = 0;
        mocks.makeSiblingTempPath.mockImplementation(() => join(tempDir, `.staged-image-${stagedPathIndex += 1}.tmp`));

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([
            firstOutputPath,
            secondOutputPath,
        ]);

        expect(Buffer.byteLength(firstOutputPath.split('/').at(-1) ?? '', 'utf8')).toBeLessThanOrEqual(255);
        expect(Buffer.byteLength(secondOutputPath.split('/').at(-1) ?? '', 'utf8')).toBeLessThanOrEqual(255);
        expect(firstOutputPath).not.toBe(secondOutputPath);
    });

    it('chooses non-conflicting derived image paths before rendering multi-file exports', async () => {
        const outputPath = join(tempDir, 'exported.png');
        const firstExistingPath = join(tempDir, 'exported-001.png');
        const firstOutputPath = join(tempDir, 'exported-001-1.png');
        const secondOutputPath = join(tempDir, 'exported-002.png');
        await writeFile(firstExistingPath, 'existing-page');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([
            firstOutputPath,
            secondOutputPath,
        ]);

        expect(await readFile(firstExistingPath, 'utf8')).toBe('existing-page');
        expect(existsSync(firstOutputPath)).toBe(true);
        expect(existsSync(secondOutputPath)).toBe(true);
    });

    it('exports TIFF page images when the target extension is TIF', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'exported.tif');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).toContain('-tiff');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expect(pdftoppmCall?.[1]).not.toContain('-jpeg');

        const outputBytes = new Uint8Array(await readFile(outputPath));
        const ifds = UTIF.decode(outputBytes);
        expect(ifds).toHaveLength(1);
        UTIF.decodeImage(outputBytes, ifds[0]!);
        expect(Array.from(UTIF.toRGBA8(ifds[0]!).slice(0, 4))).toEqual([
            255,
            0,
            0,
            255,
        ]);
    });

    it('renders PNG exports through raw PPM before encoding to avoid slow native PNG output', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;

        const outputPath = join(tempDir, 'exported.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        const pdftoppmCall = mocks.runCommand.mock.calls.find(([command]) => command === '/mock/pdftoppm');
        expect(pdftoppmCall?.[1]).not.toContain('-png');
        expectSinglePixelPng(new Uint8Array(await readFile(outputPath)), [
            1,
            0,
            0,
        ]);
    });

    it('uses native PPM-to-PNG encoding when the Rust image combiner is available', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.nativeImageCombinePath = '/native/evb-pdf-image-combine';

        const outputPath = join(tempDir, 'exported.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath)).resolves.toEqual([outputPath]);

        expect(mocks.runCommand).toHaveBeenCalledWith('/native/evb-pdf-image-combine', [
            '--format',
            'png',
            '--dpi',
            '300',
            '--output',
            expect.stringMatching(/page-1\.png$/u),
            '--',
            expect.stringMatching(/page-1\.ppm$/u),
        ], expect.objectContaining({commandLabel: 'evb-pdf-image-combine(ppm-to-png)'}));
        expect(await readFile(outputPath, 'utf8')).toBe('native-png');
    });

    it('rejects oversized rendered PPM fallback output before reading it into memory', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.stat.mockImplementation(async (path: string) => ({
            isFile: () => true,
            size: path.endsWith('.ppm') ? 193 * 1024 * 1024 : 1024,
        }));

        const outputPath = join(tempDir, 'oversized.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('Rendered PPM output exceeds safe read limit (192MB)');
    });

    it('keeps an existing image target when EXDEV atomic replacement fails', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        mocks.rename.mockRejectedValue(Object.assign(new Error('Cross-device link'), {code: 'EXDEV'}));
        mocks.atomicReplace.mockRejectedValue(new Error('replace failed'));

        const outputPath = join(tempDir, 'existing.png');
        const tempPath = `${outputPath}.tmp`;
        await writeFile(outputPath, 'old-target');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('replace failed');

        expect(await readFile(outputPath, 'utf8')).toBe('old-target');
        expect(existsSync(tempPath)).toBe(false);
    });

    it('removes promoted multi-page image targets when a later promotion fails', async () => {
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;

        const outputPath = join(tempDir, 'new-export.png');
        const firstTargetPath = join(tempDir, 'new-export-001.png');
        const secondTargetPath = join(tempDir, 'new-export-002.png');

        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (targetPath === secondTargetPath) {
                throw new Error('second promotion failed');
            }

            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath))
            .rejects
            .toThrow('second promotion failed');

        expect(existsSync(firstTargetPath)).toBe(false);
        expect(existsSync(secondTargetPath)).toBe(false);
    });

    it('retains the only backup when rollback restoration fails', async () => {
        const firstTargetPath = join(tempDir, 'first.png');
        const secondTargetPath = join(tempDir, 'second.png');
        const firstStagedPath = join(tempDir, 'first.staged');
        const secondStagedPath = join(tempDir, 'second.staged');
        await Promise.all([
            writeFile(firstTargetPath, 'old-first'),
            writeFile(secondTargetPath, 'old-second'),
            writeFile(firstStagedPath, 'new-first'),
            writeFile(secondStagedPath, 'new-second'),
        ]);
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (sourcePath === secondStagedPath) {
                throw new Error('second promotion failed');
            }
            if (sourcePath === `${firstTargetPath}.tmp`) {
                throw new Error('first restore failed');
            }
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, {force: true});
        });

        await expect(promoteStagedFiles([
            {
                stagedPath: firstStagedPath,
                targetPath: firstTargetPath,
                targetExisted: true,
            },
            {
                stagedPath: secondStagedPath,
                targetPath: secondTargetPath,
                targetExisted: true,
            },
        ])).rejects.toThrow('Recovery backup(s) retained');

        expect(await readFile(`${firstTargetPath}.tmp`, 'utf8')).toBe('old-first');
    });

    it('rolls back publications from multiple batches and restores displaced output', async () => {
        const firstTargetPath = join(tempDir, 'transaction-first.png');
        const secondTargetPath = join(tempDir, 'transaction-second.png');
        const firstStagedPath = join(tempDir, 'transaction-first.staged');
        const secondStagedPath = join(tempDir, 'transaction-second.staged');
        await Promise.all([
            writeFile(firstTargetPath, 'old-first'),
            writeFile(firstStagedPath, 'new-first'),
            writeFile(secondStagedPath, 'new-second'),
        ]);
        const ledger = createStagedFilePublicationLedger();

        await promoteStagedFiles([{
            stagedPath: firstStagedPath,
            targetPath: firstTargetPath,
            targetExisted: true,
        }], undefined, ledger);
        await promoteStagedFiles([{
            stagedPath: secondStagedPath,
            targetPath: secondTargetPath,
            targetExisted: false,
        }], undefined, ledger);

        await rollbackStagedFilePublications(ledger);

        expect(await readFile(firstTargetPath, 'utf8')).toBe('old-first');
        expect(existsSync(secondTargetPath)).toBe(false);
        expect(ledger.promotedFiles).toHaveLength(0);
        expect(ledger.backupPaths).toHaveLength(0);
    });

    it('backs up a destination that appears after export staging', async () => {
        const firstTargetPath = join(tempDir, 'appeared-first.png');
        const secondTargetPath = join(tempDir, 'appeared-second.png');
        const firstStagedPath = join(tempDir, 'appeared-first.staged');
        const secondStagedPath = join(tempDir, 'appeared-second.staged');
        await Promise.all([
            writeFile(firstTargetPath, 'concurrent-first'),
            writeFile(firstStagedPath, 'new-first'),
            writeFile(secondStagedPath, 'new-second'),
        ]);
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (sourcePath === secondStagedPath) {
                throw new Error('second promotion failed');
            }
            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, {force: true});
        });

        await expect(promoteStagedFiles([
            {
                stagedPath: firstStagedPath,
                targetPath: firstTargetPath,
                targetExisted: false,
            },
            {
                stagedPath: secondStagedPath,
                targetPath: secondTargetPath,
                targetExisted: false,
            },
        ])).rejects.toThrow('second promotion failed');

        expect(await readFile(firstTargetPath, 'utf8')).toBe('concurrent-first');
    });

    it('keeps an existing image target when source validation fails before promotion', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const outputPath = join(tempDir, 'source-changed.png');
        await writeFile(outputPath, 'original-output');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath, {beforePublish: async () => {
            throw new Error('source changed during export');
        }})).rejects.toThrow('source changed during export');

        expect(await readFile(outputPath, 'utf8')).toBe('original-output');
        expect(readdirSync(tempDir)).toEqual(['source-changed.png']);
    });

    it('keeps an existing TIFF target when source validation fails before promotion', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const outputPath = join(tempDir, 'source-changed.tiff');
        await writeFile(outputPath, 'original-output');

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {beforePublish: async () => {
            throw new Error('source changed during export');
        }})).rejects.toThrow('source changed during export');

        expect(await readFile(outputPath, 'utf8')).toBe('original-output');
        expect(readdirSync(tempDir)).toEqual(['source-changed.tiff']);
    });

    it('removes staged image outputs when export is canceled before promotion', async () => {
        mocks.renderPageCount = 1;
        mocks.pdfPageCount = 1;
        const controller = new AbortController();
        const defaultRunCommand = mocks.runCommand.getMockImplementation();
        if (!defaultRunCommand) {
            throw new Error('Expected default command mock');
        }

        mocks.runCommand.mockImplementation(async (command: string, args: string[]) => {
            if (command !== '/mock/pdftoppm') {
                return defaultRunCommand(command, args);
            }

            const prefix = args[args.length - 1];
            if (typeof prefix !== 'string') {
                throw new Error('Expected pdftoppm output prefix');
            }
            await writeFile(`${prefix}-1.ppm`, Buffer.concat([
                Buffer.from('P6\n1 1\n255\n'),
                Buffer.from([
                    1,
                    0,
                    0,
                ]),
            ]));
            controller.abort();
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        const outputPath = join(tempDir, 'canceled.png');

        await expect(exportPdfPagesAsImages('/tmp/input.pdf', outputPath, { signal: controller.signal }))
            .rejects
            .toThrow('The operation was aborted');

        expect(existsSync(outputPath)).toBe(false);
        expect(existsSync(`${outputPath}.tmp`)).toBe(false);
    });

    it('removes rendered TIFF page temps during multi-page TIFF combine before promotion', async () => {
        mocks.renderPageCount = 2;
        mocks.pdfPageCount = 2;
        const outputPath = join(tempDir, 'cleanup.tiff');
        let firstRenderedPagePath = '';

        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (targetPath === `${outputPath}.tmp`) {
                expect(firstRenderedPagePath).not.toBe('');
                expect(existsSync(firstRenderedPagePath)).toBe(false);
            }

            await writeFile(targetPath, await readFile(sourcePath));
            await rm(sourcePath, { force: true });
        });

        const recordRenderedPageTemp = (progress: IImageExportProgressForTest) => {
            if (progress.phase === 'rendering' && progress.processed === 2) {
                const renderDir = mocks.managedScratchDirs.find(dir => dir.prefix === 'pdfExport-')?.path;
                const nestedRenderDir = renderDir
                    ? readdirSync(renderDir).find(entry => entry.startsWith('render-pages-'))
                    : undefined;
                firstRenderedPagePath = renderDir && nestedRenderDir
                    ? join(renderDir, nestedRenderDir, 'page-1.tif')
                    : '';
            }
        };

        await expect(exportPdfAsMultiPageTiff('/tmp/input.pdf', outputPath, {onProgress: recordRenderedPageTemp})).resolves.toEqual([outputPath]);

        expect(existsSync(outputPath)).toBe(true);
    });
});
