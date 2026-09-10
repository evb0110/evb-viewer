import { randomUUID } from 'node:crypto';
import {
    copyFile,
    mkdir,
    rm,
    stat,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
} from 'node:path';
import type { IImageExportProgress } from '@contracts/electronApiDocuments';
import {
    convertDjvuPageToImage,
    getDjvuPageCount,
    getDjvuPageSizeWindowsForViewing,
} from '@electron/features/djvu/public';
import {
    commitStagedFilePublications,
    convertRenderedPpmToImage,
    createStagedFilePublicationLedger,
    type TImageExportFormat,
    promoteStagedFiles,
    rollbackStagedFilePublications,
} from '@electron/features/image-export/main/export';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';
import {
    buildOutputPathWithSuffix,
    resolveOutputPathConflicts,
} from '@electron/features/image-export/main/imageExportPathPlanning';
import { makeSiblingTempPath } from '@electron/utils/atomicReplace';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { mainJobBroker } from '@electron/resources/jobBroker';
import {
    type TManagedScratchPrefix,
    usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';

interface IDjvuImageExportOptions {
    format?: TImageExportFormat;
    pageNumbers?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    onProgress?: (progress: Pick<IImageExportProgress, 'phase' | 'processed' | 'total' | 'percent'>) => void;
    scratch?: {using<T>(prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>): Promise<T>;};
}

const DJVU_EXPORT_MAX_EDGE_PIXELS = 8_192;
const DJVU_EXPORT_MAX_PAGE_PIXELS = 80_000_000;
const DJVU_EXPORT_MAX_BATCH_STAGED_BYTES = 2 * 1024 * 1024 * 1024;
const DJVU_TIFF_BATCH_MAX_PAGES = 8;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

function usingDjvuScratch<T>(
    options: IDjvuImageExportOptions,
    prefix: TManagedScratchPrefix,
    run: (scratchPath: string) => Promise<T>,
) {
    return (options.scratch?.using ?? usingManagedScratchScope)(prefix, run);
}

async function resolvePages(path: string, requested: number[] | undefined, signal?: AbortSignal) {
    const pageCount = await getDjvuPageCount(path, {...(signal ? {signal} : {})});
    if (requested?.some(page => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
        throw new Error(`DjVu export page numbers must be between 1 and ${pageCount}`);
    }
    return {
        pageCount,
        pages: requested ?? null,
    };
}

function getExportPageCount(pageCount: number, pages: readonly number[] | null) {
    return pages?.length ?? pageCount;
}

function* iterateExportPages(pageCount: number, pages: readonly number[] | null) {
    if (pages) {
        yield* pages;
        return;
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        yield pageNumber;
    }
}

function assertDjvuPageRasterBudget(page: number, size: {
    width: number;
    height: number
}) {
    const pixels = size.width * size.height;
    if (
        size.width > DJVU_EXPORT_MAX_EDGE_PIXELS
        || size.height > DJVU_EXPORT_MAX_EDGE_PIXELS
        || pixels > DJVU_EXPORT_MAX_PAGE_PIXELS
    ) {
        throw new Error(`DjVu page ${page} exceeds the image export raster limit`);
    }
}

async function assertDjvuExportPageRasterBudget(
    djvuPath: string,
    pageCount: number,
    pages: readonly number[] | null,
    signal?: AbortSignal,
) {
    const requestedPages = pages ? new Set(pages) : null;
    const pageDpiByNumber = new Map<number, number>();
    const windowOptions = {
        ...(signal ? {signal} : {}),
        ...(pages ? {pageNumbers: pages} : {}),
    };
    for await (const window of getDjvuPageSizeWindowsForViewing(djvuPath, pageCount, windowOptions)) {
        for (let offset = 0; offset < window.sizes.length; offset += 1) {
            const page = window.firstPage + offset;
            if (requestedPages && !requestedPages.has(page)) {
                continue;
            }
            const size = window.sizes[offset];
            if (!size) {
                throw new Error(`DjVu page ${page} dimensions are unavailable`);
            }
            assertDjvuPageRasterBudget(page, size);
            if (Number.isFinite(size.dpi) && size.dpi > 0) {
                pageDpiByNumber.set(page, size.dpi);
            }
            requestedPages?.delete(page);
        }
    }
    const missingPage = requestedPages?.values().next().value;
    if (missingPage !== undefined) {
        throw new Error(`DjVu page ${missingPage} dimensions are unavailable`);
    }
    return pageDpiByNumber;
}

function buildImageOutputPath(templatePath: string, page: number, outputCount: number, format: TImageExportFormat) {
    const outputExtension = format === 'jpeg' ? '.jpg' : format === 'tiff' ? '.tif' : '.png';
    const outputStem = basename(templatePath, extname(templatePath));
    const pngTemplatePath = join(dirname(templatePath), `${outputStem}${outputExtension}`);
    return buildOutputPathWithSuffix(
        pngTemplatePath,
        outputCount === 1 ? '' : `-page-${String(page).padStart(3, '0')}`,
    );
}

function buildDjvuTiffOutputPath(templatePath: string, partNumber: number, splitOutput: boolean) {
    return buildOutputPathWithSuffix(
        templatePath,
        splitOutput ? `-part-${String(partNumber).padStart(3, '0')}` : '',
    );
}

async function renderDjvuImagePages(
    djvuPath: string,
    outputTemplatePath: string,
    pageCount: number,
    pages: readonly number[] | null,
    options: IDjvuImageExportOptions,
    pageDpiByNumber: ReadonlyMap<number, number>,
) {
    return usingDjvuScratch(options, 'djvu-image-export-', async tempDirectory => {
        let stagedBytes = 0;
        const stagedFiles: Array<{
            stagedPath: string;
            targetPath: string;
            targetExisted: boolean;
        }> = [];
        const publicationLedger = createStagedFilePublicationLedger();
        const outputPaths: string[] = [];
        const totalPages = getExportPageCount(pageCount, pages);
        const promoteBatch = async () => {
            if (stagedFiles.length === 0) {
                return;
            }
            await promoteStagedFiles(stagedFiles, options.signal, publicationLedger);
            stagedFiles.length = 0;
            stagedBytes = 0;
        };
        try {
            options.onProgress?.({
                phase: 'rendering',
                processed: 0,
                total: totalPages,
                percent: 0,
            });
            let outputIndex = 0;
            for (const page of iterateExportPages(pageCount, pages)) {
                throwIfAborted(options.signal);
                const format = options.format ?? 'png';
                const plannedOutputPath = buildImageOutputPath(
                    outputTemplatePath,
                    page,
                    totalPages,
                    format,
                );
                const outputPath = resolveOutputPathConflicts([plannedOutputPath], false)[0];
                if (!outputPath) throw new Error('DjVu image export target is missing');
                const brokerLease = await mainJobBroker.acquire({
                    ownerId: options.cancelGroup ?? `djvu-image-export:${djvuPath}`,
                    kind: 'djvu-image-export-page',
                    priority: 'user',
                    resources: {
                        cpuTokens: 1,
                        estimatedResidentBytes: 128 * 1024 * 1024,
                        nativeProcesses: 1,
                        ioWeight: 2,
                    },
                    ...(options.signal ? {signal: options.signal} : {}),
                });
                const ppmPath = join(tempDirectory, `page-${page}.ppm`);
                const imagePath = await (async () => {
                    const render = await convertDjvuPageToImage(
                        djvuPath,
                        ppmPath,
                        page,
                        `djvu-image-export-${randomUUID()}`,
                        {
                            format: 'ppm',
                            ...(options.signal ? {signal: options.signal} : {}),
                        },
                    );
                    if (!render.success) throw new Error(render.error ?? `Failed to render DjVu page ${page}`);
                    if (
                        stagedFiles.length > 0
                        && stagedBytes + render.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES
                    ) {
                        await promoteBatch();
                    }
                    if (render.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                        throw new Error('DjVu PNG page exceeds the staged-byte limit');
                    }
                    stagedBytes += render.fileSize;
                    return convertRenderedPpmToImage(
                        ppmPath,
                        format,
                        options.signal,
                        options.cancelGroup,
                        pageDpiByNumber.get(page),
                    );
                })().finally(() => brokerLease.release());
                await mkdir(dirname(outputPath), {recursive: true});
                const targetExisted = await stat(outputPath).then(() => true).catch(() => false);
                const sibling = makeSiblingTempPath(outputPath);
                try {
                    await copyFile(imagePath, sibling);
                    throwIfAborted(options.signal);
                    stagedFiles.push({
                        stagedPath: sibling,
                        targetPath: outputPath,
                        targetExisted,
                    });
                } catch (error) {
                    await rm(sibling, {force: true}).catch(() => undefined);
                    throw error;
                } finally {
                    await rm(ppmPath, {force: true}).catch(() => undefined);
                    await rm(imagePath, {force: true}).catch(() => undefined);
                }
                outputPaths.push(outputPath);
                outputIndex += 1;
                options.onProgress?.({
                    phase: 'rendering',
                    processed: outputIndex,
                    total: totalPages,
                    percent: (outputIndex / totalPages) * 100,
                });
            }
            throwIfAborted(options.signal);
            await promoteBatch();
            await commitStagedFilePublications(publicationLedger);
            return outputPaths;
        } catch (error) {
            try {
                await rollbackStagedFilePublications(publicationLedger);
            } catch (rollbackError) {
                throw new AggregateError([
                    error,
                    rollbackError,
                ], 'DjVu PNG export failed and rollback was incomplete');
            }
            throw error;
        } finally {
            await Promise.all(stagedFiles.map(({stagedPath}) => rm(stagedPath, {force: true}).catch(() => undefined)));
        }
    });
}

export async function exportDjvuPagesAsPng(
    djvuPath: string,
    outputTemplatePath: string,
    options: IDjvuImageExportOptions = {},
) {
    const {
        pageCount,
        pages,
    } = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const pageDpiByNumber = await assertDjvuExportPageRasterBudget(
        djvuPath,
        pageCount,
        pages,
        options.signal,
    );
    return renderDjvuImagePages(djvuPath, outputTemplatePath, pageCount, pages, options, pageDpiByNumber);
}

export async function exportDjvuPagesAsImages(
    djvuPath: string,
    outputTemplatePath: string,
    options: IDjvuImageExportOptions = {},
) {
    const {
        pageCount,
        pages,
    } = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const pageDpiByNumber = await assertDjvuExportPageRasterBudget(djvuPath, pageCount, pages, options.signal);
    return renderDjvuImagePages(djvuPath, outputTemplatePath, pageCount, pages, options, pageDpiByNumber);
}

export async function exportDjvuAsMultiPageTiff(
    djvuPath: string,
    outputPath: string,
    options: IDjvuImageExportOptions = {},
) {
    const {
        pageCount,
        pages,
    } = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const pageDpiByNumber = await assertDjvuExportPageRasterBudget(
        djvuPath,
        pageCount,
        pages,
        options.signal,
    );
    return usingDjvuScratch(options, 'djvu-tiff-export-', async tempDirectory => {
        const pagePaths: string[] = [];
        let batchDpi: number | undefined;
        let stagedBytes = 0;
        let outputPart = 0;
        const exportPages = [...iterateExportPages(pageCount, pages)];
        const totalPages = exportPages.length;
        const hasMixedPageDpi = new Set(exportPages.map(page => pageDpiByNumber.get(page) ?? null)).size > 1;
        const splitOutput = totalPages > DJVU_TIFF_BATCH_MAX_PAGES || hasMixedPageDpi;
        const targetPath = /\.tiff?$/iu.test(outputPath) ? outputPath : `${outputPath}.tiff`;
        const stagedGroups: Array<{stagedPath: string}> = [];
        const combineBatch = async () => {
            if (pagePaths.length === 0) {
                return;
            }
            const batchPaths = pagePaths.splice(0);
            const currentBatchDpi = batchDpi;
            batchDpi = undefined;
            stagedBytes = 0;
            try {
                const stagedPath = join(
                    tempDirectory,
                    `combined-part-${String(outputPart + 1).padStart(3, '0')}.tiff`,
                );
                const combineLease = await mainJobBroker.acquire({
                    ownerId: options.cancelGroup ?? `djvu-tiff-export:${djvuPath}`,
                    kind: 'djvu-tiff-combine',
                    priority: 'user',
                    resources: {
                        cpuTokens: 1,
                        estimatedResidentBytes: 128 * 1024 * 1024,
                        nativeProcesses: 1,
                        ioWeight: 3,
                    },
                    ...(options.signal ? {signal: options.signal} : {}),
                });
                let combined = false;
                try {
                    combined = await tryCombinePagesWithNativeTiffCombiner(
                        batchPaths,
                        stagedPath,
                        options.signal,
                        currentBatchDpi,
                    );
                } finally {
                    combineLease.release();
                }
                if (!combined) {
                    await rm(stagedPath, {force: true}).catch(() => undefined);
                    throw new Error('Native TIFF output service is unavailable for DjVu export');
                }
                stagedGroups.push({stagedPath});
                outputPart += 1;
            } finally {
                await Promise.all(batchPaths.map(batchPath => rm(batchPath, {force: true}).catch(() => undefined)));
            }
        };

        let processedPages = 0;
        for (const page of exportPages) {
            throwIfAborted(options.signal);
            const pageDpi = pageDpiByNumber.get(page);
            if (pagePaths.length > 0 && pageDpi !== batchDpi) {
                await combineBatch();
            }
            const brokerLease = await mainJobBroker.acquire({
                ownerId: options.cancelGroup ?? `djvu-tiff-export:${djvuPath}`,
                kind: 'djvu-tiff-render-page',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 128 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
                ...(options.signal ? {signal: options.signal} : {}),
            });
            const ppmPath = join(tempDirectory, `page-${page}.ppm`);
            const render = await convertDjvuPageToImage(djvuPath, ppmPath, page, `djvu-tiff-export-${randomUUID()}`, {
                format: 'ppm',
                ...(options.signal ? {signal: options.signal} : {}),
            }).finally(() => brokerLease.release());
            if (!render.success) throw new Error(render.error ?? `Failed to render DjVu page ${page}`);
            if (
                pagePaths.length > 0
                && (
                    pagePaths.length >= DJVU_TIFF_BATCH_MAX_PAGES
                    || stagedBytes + render.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES
                )
            ) {
                await combineBatch();
            }
            if (render.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                throw new Error('DjVu TIFF page exceeds the staged-byte limit');
            }
            stagedBytes += render.fileSize;
            pagePaths.push(ppmPath);
            batchDpi ??= pageDpi;
            processedPages += 1;
            options.onProgress?.({
                phase: 'rendering',
                processed: processedPages,
                total: totalPages,
                percent: (processedPages / totalPages) * 90,
            });
        }
        await combineBatch();
        const outputPaths = resolveOutputPathConflicts(
            stagedGroups.map((_, index) => buildDjvuTiffOutputPath(targetPath, index + 1, splitOutput)),
            false,
        );
        const stagedFiles = stagedGroups.map(({stagedPath}, index) => {
            const targetOutputPath = outputPaths[index];
            if (!targetOutputPath) {
                throw new Error('Multi-page TIFF export target path is missing');
            }
            return {
                stagedPath,
                targetPath: targetOutputPath,
                targetExisted: false,
            };
        });
        let promoted = false;
        try {
            throwIfAborted(options.signal);
            await promoteStagedFiles(stagedFiles, options.signal);
            promoted = true;
        } finally {
            if (!promoted) {
                await Promise.all(stagedGroups.map(({stagedPath}) => rm(stagedPath, {force: true}).catch(() => undefined)));
            }
        }
        options.onProgress?.({
            phase: 'combining',
            processed: outputPaths.length,
            total: outputPaths.length,
            percent: 100,
        });
        return outputPaths;
    });
}
