import type * as TViMockOriginalModule from '@electron/resources/jobBroker';

import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    getPageCount: vi.fn(),
    getPageSizeWindows: vi.fn(),
    convertPage: vi.fn(),
    convertPpmToImage: vi.fn(),
    combineTiff: vi.fn(),
    acquire: vi.fn(),
    promoteStagedFiles: vi.fn(),
    createStagedFilePublicationLedger: vi.fn(() => ({
        promotedFiles: [],
        backupPaths: [],
    })),
    commitStagedFilePublications: vi.fn(),
    rollbackStagedFilePublications: vi.fn(),
    estimateTask: vi.fn(),
    appTempDir: '',
}));

vi.mock('@electron/features/djvu/main/metadata', () => ({
    getDjvuPageCount: mocks.getPageCount,
    getDjvuResolution: async () => 300,
}));
vi.mock('@electron/features/djvu/public', () => ({
    cancelConversion: vi.fn(async () => undefined),
    convertDjvuPageToImage: mocks.convertPage,
    createDjvuPdfEstimateTask: mocks.estimateTask,
    DjvuPdfWorkerStartupError: class extends Error {},
    getDjvuPageCount: mocks.getPageCount,
    getDjvuPageSizeForViewing: async () => ({
        width: 1000,
        height: 1400,
    }),
    getDjvuPageSizeWindowsForViewing: mocks.getPageSizeWindows,
}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.appTempDir}));
vi.mock('@electron/features/image-export/main/export', () => ({
    convertRenderedPpmToImage: mocks.convertPpmToImage,
    promoteStagedFiles: mocks.promoteStagedFiles,
    createStagedFilePublicationLedger: mocks.createStagedFilePublicationLedger,
    commitStagedFilePublications: mocks.commitStagedFilePublications,
    rollbackStagedFilePublications: mocks.rollbackStagedFilePublications,
}));
vi.mock('@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner', () => ({tryCombinePagesWithNativeTiffCombiner: mocks.combineTiff}));
vi.mock('@electron/resources/jobBroker', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    mainJobBroker: {acquire: mocks.acquire},
}));

describe('DjVu image export limits', () => {
    let tempDir = '';
    afterEach(async () => rm(tempDir, {
        recursive: true,
        force: true,
    }));

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPageCount.mockResolvedValue(1);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: [{
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                }],
            };
        });
    });

    it('refuses an oversized page before starting a PNG render process', async () => {
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: [{
                    width: 8_193,
                    height: 100,
                    dpi: 300,
                }],
            };
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng('/books/large.djvu', '/exports/page.png'))
            .rejects.toThrow('exceeds the image export raster limit');
        expect(mocks.convertPage).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it('allows multiple pages beyond the former aggregate raster budget', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-tiff-batch-test-'));
        mocks.getPageCount.mockResolvedValue(5);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: Array.from({length: 5}, () => ({
                    width: 8_000,
                    height: 8_000,
                    dpi: 300,
                })),
            };
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string) => {
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 3,
            };
        });
        mocks.combineTiff.mockResolvedValue(true);
        const {exportDjvuAsMultiPageTiff} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuAsMultiPageTiff(
            '/books/large.djvu',
            join(tempDir, 'book.tiff'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).resolves.toEqual([join(tempDir, 'book.tiff')]);
        expect(mocks.convertPage).toHaveBeenCalledTimes(5);
        expect(mocks.combineTiff).toHaveBeenCalledOnce();
    });

    it('splits large TIFF exports into bounded output files', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-tiff-split-test-'));
        mocks.getPageCount.mockResolvedValue(9);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: Array.from({length: 9}, () => ({
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                })),
            };
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string) => {
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 3,
            };
        });
        const batchSizes: number[] = [];
        mocks.combineTiff.mockImplementation(async (inputPaths: string[]) => {
            batchSizes.push(inputPaths.length);
            return true;
        });
        const {exportDjvuAsMultiPageTiff} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuAsMultiPageTiff(
            '/books/large.djvu',
            join(tempDir, 'book.tiff'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).resolves.toEqual([
            join(tempDir, 'book-part-001.tiff'),
            join(tempDir, 'book-part-002.tiff'),
        ]);
        expect(batchSizes).toEqual([
            8,
            1,
        ]);
    });

    it('does not promote an early PNG page when a later render fails', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-png-transaction-test-'));
        mocks.getPageCount.mockResolvedValue(2);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: Array.from({length: 2}, () => ({
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                })),
            };
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string, page: number) => {
            if (page === 2) throw new Error('second page failed');
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 3,
            };
        });
        mocks.convertPpmToImage.mockImplementation(async (ppmPath: string) => {
            const pngPath = `${ppmPath}.png`;
            await writeFile(pngPath, 'png');
            return pngPath;
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng(
            '/books/failure.djvu',
            join(tempDir, 'page.png'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).rejects.toThrow('second page failed');

        expect(mocks.promoteStagedFiles).not.toHaveBeenCalled();
    });

    it('rolls back an earlier PNG batch when a later render fails', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-png-rollback-test-'));
        mocks.getPageCount.mockResolvedValue(2);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: Array.from({length: 2}, () => ({
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                })),
            };
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string) => {
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 1.5 * 1024 * 1024 * 1024,
            };
        });
        mocks.convertPpmToImage.mockImplementation(async (ppmPath: string) => {
            if (ppmPath.includes('page-2.ppm')) throw new Error('second page failed');
            const pngPath = `${ppmPath}.png`;
            await writeFile(pngPath, 'png');
            return pngPath;
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng(
            '/books/failure.djvu',
            join(tempDir, 'page.png'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).rejects.toThrow('second page failed');

        expect(mocks.promoteStagedFiles).toHaveBeenCalledOnce();
        expect(mocks.rollbackStagedFilePublications).toHaveBeenCalledOnce();
        expect(mocks.commitStagedFilePublications).not.toHaveBeenCalled();
    });

    it('resets PNG staged-byte accounting after each promoted batch', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-png-batch-test-'));
        mocks.getPageCount.mockResolvedValue(2);
        mocks.getPageSizeWindows.mockImplementation(async function* () {
            yield {
                firstPage: 1,
                sizes: Array.from({length: 2}, () => ({
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                })),
            };
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string) => {
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 1.5 * 1024 * 1024 * 1024,
            };
        });
        mocks.convertPpmToImage.mockImplementation(async (ppmPath: string) => {
            const pngPath = `${ppmPath}.png`;
            await writeFile(pngPath, 'png');
            return pngPath;
        });
        const promotedBatchSizes: number[] = [];
        mocks.promoteStagedFiles.mockImplementation(async (stagedFiles: unknown[]) => {
            promotedBatchSizes.push(stagedFiles.length);
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng(
            '/books/large.djvu',
            join(tempDir, 'page.png'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).resolves.toHaveLength(2);
        expect(promotedBatchSizes).toEqual([
            1,
            1,
        ]);
    });

    it('exports selected pages above 100,000 without creating a dense page list', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-large-page-selection-test-'));
        mocks.getPageCount.mockResolvedValue(100_001);
        mocks.getPageSizeWindows.mockImplementation(async function* (_path: string, pageCount: number) {
            for (let firstPage = 1; firstPage <= pageCount;) {
                const lastPage = Math.min(pageCount, firstPage + 255);
                yield {
                    firstPage,
                    sizes: Array.from({length: lastPage - firstPage + 1}, () => ({
                        width: 1_000,
                        height: 1_000,
                        dpi: 300,
                    })),
                };
                firstPage = lastPage + 1;
            }
        });
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string, page: number) => {
            await writeFile(ppmPath, `ppm-${page}`);
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 3,
            };
        });
        mocks.convertPpmToImage.mockImplementation(async (ppmPath: string) => {
            const pngPath = `${ppmPath}.png`;
            await writeFile(pngPath, 'png');
            return pngPath;
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        const outputPaths = await exportDjvuPagesAsPng(
            '/books/large.djvu',
            join(tempDir, 'page.png'),
            {
                pageNumbers: [
                    100_000,
                    100_001,
                ],
                scratch: {using: async (_prefix, run) => run(tempDir)},
            },
        );

        expect(outputPaths).toEqual([
            join(tempDir, 'page-page-100000.png'),
            join(tempDir, 'page-page-100001.png'),
        ]);
        expect(mocks.convertPage.mock.calls.map(([
            , , page,
        ]) => page)).toEqual([
            100_000,
            100_001,
        ]);
        expect(mocks.getPageSizeWindows).toHaveBeenCalledWith(
            '/books/large.djvu',
            100_001,
            {pageNumbers: [
                100_000,
                100_001,
            ]},
        );
    });

    it('stops a million-page size scan as soon as cancellation arrives', async () => {
        mocks.getPageCount.mockResolvedValue(1_000_001);
        const controller = new AbortController();
        mocks.getPageSizeWindows.mockImplementation(async function* (_path: string, _pageCount: number, options?: {signal?: AbortSignal}) {
            yield {
                firstPage: 1,
                sizes: [{
                    width: 1_000,
                    height: 1_000,
                    dpi: 300,
                }],
            };
            controller.abort();
            if (options?.signal?.aborted) {
                throw new Error('The operation was aborted');
            }
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng(
            '/books/million-page.djvu',
            '/exports/page.png',
            {signal: controller.signal},
        )).rejects.toThrow('aborted');
        expect(mocks.convertPage).not.toHaveBeenCalled();
    });
});

describe('DjVu size estimates', () => {
    let estimateDir = '';
    let pathCounter = 0;
    const freshDjvuPath = () => `/books/estimate-${pathCounter++}.djvu`;
    const keptScratchDirs = async () => (await readdir(estimateDir))
        .filter(entry => entry.startsWith('djvu-export-'));
    const writeSample = async (outputPath: string) => {
        await writeFile(outputPath, 'ppm');
        return {success: true};
    };

    beforeEach(async () => {
        estimateDir = await mkdtemp(join(tmpdir(), 'djvu-estimate-test-'));
        mocks.appTempDir = estimateDir;
        mocks.estimateTask.mockImplementation(() => ({promise: Promise.resolve(1000)}));
        mocks.convertPage.mockImplementation(async (_source: string, outputPath: string) => writeSample(outputPath));
    });

    afterEach(async () => rm(estimateDir, {
        recursive: true,
        force: true,
    }));

    it('keeps the other presets when one preset termination is unproven and retains only its scratch', async () => {
        mocks.convertPage.mockImplementation(async (_source: string, outputPath: string) => {
            if (outputPath.endsWith('sample-s2.ppm')) {
                return {
                    success: false,
                    cause: markUnprovenNativeTermination(new Error('tool tree outlived kill'), 'process group alive'),
                };
            }
            return writeSample(outputPath);
        });
        const {estimateSizes} = await import('@electron/features/djvu/main/estimateSizes');

        const estimates = await estimateSizes(freshDjvuPath(), 10);

        expect(estimates.map(estimate => estimate.subsample)).toEqual([
            1,
            2,
            4,
        ]);
        expect(estimates[0]?.estimatedBytes).toBeGreaterThan(0);
        expect(estimates[1]?.estimatedBytes).toBe(0);
        expect(estimates[2]?.estimatedBytes).toBeGreaterThan(0);
        expect(await keptScratchDirs()).toHaveLength(1);
    });

    it('reports a user cancel as an abort even when the termination it caused is unproven', async () => {
        const controller = new AbortController();
        mocks.convertPage.mockImplementation(async () => {
            controller.abort();
            return {
                success: false,
                cause: markUnprovenNativeTermination(new Error('tool tree outlived kill'), 'process group alive'),
            };
        });
        const {estimateSizes} = await import('@electron/features/djvu/main/estimateSizes');

        await expect(estimateSizes(freshDjvuPath(), 10, {signal: controller.signal}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(await keptScratchDirs()).toHaveLength(1);
    });
});
