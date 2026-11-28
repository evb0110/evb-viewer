import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {IImageExportProgress} from '@contracts/imageExportPlatformFeature';
import {convertDjvuPageToImage, getDjvuPageCount, getDjvuPageSizeWindowsForViewing} from '@electron/features/djvu/public';
import {
    commitStagedFilePublications,
    convertRenderedPpmToImage,
    validateImageExportPath,
    createStagedFilePublicationLedger,
    type TImageExportFormat,
    promoteStagedFiles,
    rollbackStagedFilePublications,
} from '@electron/features/image-export/main/export';
import {resolveImageExportConcurrency} from '@electron/features/image-export/main/imageExportResourceLimits';
import {tryCombinePagesWithNativeTiffCombiner} from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';
import type {IStagedImageFile} from '@electron/features/image-export/main/imageExportPathPlanning';
import {makeSiblingTempPath} from '@electron/utils/atomicReplace';
import {buildMultiPageTiffOutputSuffixes} from '@pdf-core/imageExportFileName';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {tryGetHostResourceProfileSnapshot} from '@electron/resources/hostResourceProfile';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {resolvePdfImageCombineResidentBytes, resolvePdfImageCombineThreads} from '@electron/native-tools/pdfImageCombineBudget';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {recordManagedScratchPaths, type TManagedScratchPrefix, usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

interface IDjvuImageExportOptions {
    format?: TImageExportFormat;
    pageNumbers?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    onProgress?: (progress: Pick<IImageExportProgress, 'phase' | 'processed' | 'total' | 'percent'>) => void;
    beforePublish?: () => Promise<void> | void;
    scratch?: {using<T>(prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>): Promise<T>};
}

const DJVU_EXPORT_MAX_EDGE_PIXELS = 8_192;
const DJVU_EXPORT_MAX_PAGE_PIXELS = 80_000_000;
const DJVU_EXPORT_MAX_BATCH_STAGED_BYTES = 2 * 1024 * 1024 * 1024;
const DJVU_TIFF_BATCH_MAX_PAGES = 8;
const DJVU_TIFF_RENDER_PAGE_RESIDENT_BYTES = 128 * 1024 * 1024;
// Matches the shared DjVu engine worker pool ceiling (1 on low tier, 2 otherwise)
// so export waves do not hold idle broker leases waiting on the engine pool.
const DJVU_RENDER_MAX_CONCURRENCY = 2;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export function resolveDjvuImageExportConcurrency(perTaskResidentBytes?: number) {
    const capacity = mainJobBroker.getSnapshot().capacity;
    return resolveImageExportConcurrency({
        capacity,
        hostProfile: tryGetHostResourceProfileSnapshot(),
        perTaskResidentBytes: perTaskResidentBytes ?? resolvePdfImageCombineResidentBytes(capacity),
        perTaskIoWeight: 2,
        maxConcurrency: DJVU_RENDER_MAX_CONCURRENCY,
    });
}

function createLinkedAbortController(parentSignal?: AbortSignal) {
    const controller = new AbortController();
    if (!parentSignal) {
        return {
            controller,
            dispose: () => undefined,
        };
    }
    if (parentSignal.aborted) {
        controller.abort(abortErrorFromSignal(parentSignal));
        return {
            controller,
            dispose: () => undefined,
        };
    }
    const onAbort = () => controller.abort(abortErrorFromSignal(parentSignal));
    parentSignal.addEventListener('abort', onAbort, {once: true});
    return {
        controller,
        dispose: () => parentSignal.removeEventListener('abort', onAbort),
    };
}

function selectPrimaryWaveError(errors: readonly unknown[], firstError: unknown) {
    const unproven = errors.find((error) => getUnprovenNativeTerminationDetail(error) !== undefined);
    return unproven ?? firstError ?? errors[0];
}

function usingDjvuScratch<T>(options: IDjvuImageExportOptions, prefix: TManagedScratchPrefix, run: (scratchPath: string) => Promise<T>) {
    return options.scratch?.using ? options.scratch.using(prefix, run) : usingManagedScratchScope(prefix, getAppTempDir(), run);
}

async function resolvePages(path: string, requested: number[] | undefined, signal?: AbortSignal) {
    const pageCount = await getDjvuPageCount(path, {...(signal ? {signal} : {})});
    if (requested?.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
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

function assertDjvuPageRasterBudget(
    page: number,
    size: {
        width: number;
        height: number;
    },
) {
    const pixels = size.width * size.height;
    if (size.width > DJVU_EXPORT_MAX_EDGE_PIXELS || size.height > DJVU_EXPORT_MAX_EDGE_PIXELS || pixels > DJVU_EXPORT_MAX_PAGE_PIXELS) {
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

async function renderDjvuImagePages(
    djvuPath: string,
    outputTemplatePath: string,
    pageCount: number,
    pages: readonly number[] | null,
    options: IDjvuImageExportOptions,
    pageDpiByNumber: ReadonlyMap<number, number>,
) {
    return usingDjvuScratch(options, 'djvu-image-export-', async (tempDirectory) => {
        let stagedBytes = 0;
        const stagedFiles: IStagedImageFile[] = [];
        const publicationLedger = createStagedFilePublicationLedger(tempDirectory);
        const totalPages = getExportPageCount(pageCount, pages);
        const format = options.format ?? 'png';
        const exportPages = [...iterateExportPages(pageCount, pages)];
        const outputPaths: string[] = [];
        const siblings = exportPages.map(() => makeSiblingTempPath(outputTemplatePath));
        const concurrency = resolveDjvuImageExportConcurrency();
        const ownerId = options.cancelGroup ?? `djvu-image-export:${djvuPath}`;
        let processedPages = 0;
        const promoteBatch = async () => {
            if (stagedFiles.length === 0) {
                return;
            }
            await options.beforePublish?.();
            outputPaths.push(...(await promoteStagedFiles(stagedFiles, options.signal, publicationLedger)));
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
            await recordManagedScratchPaths(tempDirectory, siblings);
            await mkdir(dirname(outputTemplatePath), {recursive: true});

            for (let waveStart = 0; waveStart < exportPages.length; waveStart += concurrency) {
                throwIfAborted(options.signal);
                const wave = exportPages.slice(waveStart, waveStart + concurrency).map((page, offset) => ({
                    index: waveStart + offset,
                    page,
                    sibling: siblings[waveStart + offset]!,
                    ppmPath: join(tempDirectory, `page-${page}.ppm`),
                }));

                // Phase 1: render the bounded wave of DjVu pages to PPM in parallel.
                // Pass only the caller's AbortSignal (not a synthetic sibling abort) so an
                // already-running DjVu engine worker finishes its write cleanly before scratch
                // cleanup, avoiding racing a terminating worker against tempDirectory removal.
                let firstRenderError: unknown;
                let hasRenderError = false;
                const renderResults = await Promise.allSettled(
                    wave.map(async (item) => {
                        try {
                            throwIfAborted(options.signal);
                            const render = await mainJobBroker.run(
                                {
                                    ownerId,
                                    kind: 'djvu-image-export-page',
                                    priority: 'user',
                                    resources: {
                                        cpuTokens: 1,
                                        estimatedResidentBytes: resolvePdfImageCombineResidentBytes(mainJobBroker.getSnapshot().capacity),
                                        nativeProcesses: 1,
                                        ioWeight: 2,
                                    },
                                    ...(options.signal ? {signal: options.signal} : {}),
                                },
                                async (brokerRun) => {
                                    const rendered = await convertDjvuPageToImage(
                                        djvuPath,
                                        item.ppmPath,
                                        item.page,
                                        `djvu-image-export-${randomUUID()}`,
                                        {
                                            format: 'ppm',
                                            onTerminationProof: brokerRun.onTerminationProof,
                                            ...(options.signal ? {signal: options.signal} : {}),
                                        },
                                    );
                                    if (!rendered.success) {
                                        throw rendered.cause instanceof Error
                                            ? rendered.cause
                                            : new Error(rendered.error ?? `Failed to render DjVu page ${item.page}`);
                                    }
                                    return rendered;
                                },
                            );
                            return {
                                ...item,
                                fileSize: render.fileSize,
                            };
                        } catch (error) {
                            if (!hasRenderError) {
                                hasRenderError = true;
                                firstRenderError = error;
                            }
                            throw error;
                        }
                    }),
                );

                const renderErrors = renderResults
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => result.reason);
                if (renderErrors.length > 0) {
                    // Clean up PPM files produced by sibling pages whose render finished cleanly.
                    await Promise.all(
                        renderResults.flatMap((result) =>
                            result.status === 'fulfilled' ? [rm(result.value.ppmPath, {force: true}).catch(() => undefined)] : [],
                        ),
                    );
                    throw selectPrimaryWaveError(renderErrors, firstRenderError);
                }

                const renderedWave = renderResults.map(
                    (result) => (result as PromiseFulfilledResult<(typeof wave)[number] & {fileSize: number}>).value,
                );
                const unconsumedPpmPaths = new Set(renderedWave.map((item) => item.ppmPath));

                try {
                    for (const item of renderedWave) {
                        if (item.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                            throw new Error('DjVu PNG page exceeds the staged-byte limit');
                        }
                    }

                    // Partition the rendered wave into contiguous sub-batches that each stay
                    // within the 2 GiB staged-byte limit before encoding and staging.
                    const subBatches: Array<{items: typeof renderedWave; bytes: number}> = [];
                    for (const item of renderedWave) {
                        const current = subBatches.at(-1);
                        if (!current || current.bytes + item.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                            subBatches.push({
                                items: [item],
                                bytes: item.fileSize,
                            });
                        } else {
                            current.items.push(item);
                            current.bytes += item.fileSize;
                        }
                    }

                    for (const subBatch of subBatches) {
                        throwIfAborted(options.signal);
                        if (stagedFiles.length > 0 && stagedBytes + subBatch.bytes > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                            await promoteBatch();
                        }

                        // Phase 2: encode the sub-batch to the target image format in parallel.
                        const encodeAbort = createLinkedAbortController(options.signal);
                        let firstEncodeError: unknown;
                        let hasEncodeError = false;
                        const encodeResults = await (async () => {
                            try {
                                return await Promise.allSettled(
                                    subBatch.items.map(async (item) => {
                                        let imagePath: string | null = null;
                                        let copiedSibling = false;
                                        let keepUnprovenFiles = false;
                                        try {
                                            throwIfAborted(encodeAbort.controller.signal);
                                            imagePath = await mainJobBroker.run(
                                                {
                                                    ownerId,
                                                    kind: 'djvu-image-export-page',
                                                    priority: 'user',
                                                    resources: {
                                                        cpuTokens: 1,
                                                        estimatedResidentBytes: resolvePdfImageCombineResidentBytes(
                                                            mainJobBroker.getSnapshot().capacity,
                                                        ),
                                                        nativeProcesses: 1,
                                                        ioWeight: 2,
                                                    },
                                                    signal: encodeAbort.controller.signal,
                                                },
                                                (brokerRun) =>
                                                    convertRenderedPpmToImage(
                                                        item.ppmPath,
                                                        format,
                                                        encodeAbort.controller.signal,
                                                        options.cancelGroup,
                                                        pageDpiByNumber.get(item.page),
                                                        brokerRun,
                                                    ),
                                            );
                                            await copyFile(imagePath, item.sibling);
                                            copiedSibling = true;
                                            throwIfAborted(encodeAbort.controller.signal);
                                            return item;
                                        } catch (error) {
                                            if (getUnprovenNativeTerminationDetail(error) !== undefined) {
                                                keepUnprovenFiles = true;
                                            }
                                            if (copiedSibling) {
                                                await rm(item.sibling, {force: true}).catch(() => undefined);
                                            }
                                            if (!hasEncodeError) {
                                                hasEncodeError = true;
                                                firstEncodeError = error;
                                                encodeAbort.controller.abort(error);
                                            }
                                            throw error;
                                        } finally {
                                            unconsumedPpmPaths.delete(item.ppmPath);
                                            if (!keepUnprovenFiles) {
                                                await rm(item.ppmPath, {force: true}).catch(() => undefined);
                                                if (imagePath !== null) {
                                                    await rm(imagePath, {force: true}).catch(() => undefined);
                                                }
                                            }
                                        }
                                    }),
                                );
                            } finally {
                                encodeAbort.dispose();
                            }
                        })();

                        const encodeErrors = encodeResults
                            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                            .map((result) => result.reason);
                        if (encodeErrors.length > 0) {
                            await Promise.all(
                                encodeResults.flatMap((result) =>
                                    result.status === 'fulfilled' ? [rm(result.value.sibling, {force: true}).catch(() => undefined)] : [],
                                ),
                            );
                            throw selectPrimaryWaveError(encodeErrors, firstEncodeError);
                        }

                        // Commit staged entries in exact page order for deterministic filenames.
                        for (const item of subBatch.items) {
                            stagedBytes += item.fileSize;
                            stagedFiles.push({
                                stagedPath: item.sibling,
                                targetPath: outputTemplatePath,
                                suffix: totalPages === 1 ? '' : `-page-${String(item.page).padStart(3, '0')}`,
                                allowOverwrite: totalPages === 1,
                            });
                            processedPages += 1;
                            options.onProgress?.({
                                phase: 'rendering',
                                processed: processedPages,
                                total: totalPages,
                                percent: (processedPages / totalPages) * 100,
                            });
                        }
                    }
                } finally {
                    if (unconsumedPpmPaths.size > 0) {
                        await Promise.all([...unconsumedPpmPaths].map((ppmPath) => rm(ppmPath, {force: true}).catch(() => undefined)));
                    }
                }
            }
            throwIfAborted(options.signal);
            await promoteBatch();
            await commitStagedFilePublications(publicationLedger);
            return outputPaths;
        } catch (error) {
            try {
                await rollbackStagedFilePublications(publicationLedger);
            } catch (rollbackError) {
                // The managed scratch owner keeps a native writer's files only for a marked error.
                throw new AggregateError([error, rollbackError], 'DjVu PNG export failed and rollback was incomplete');
            }
            throw error;
        } finally {
            await Promise.all(stagedFiles.map(({stagedPath}) => rm(stagedPath, {force: true}).catch(() => undefined)));
        }
    });
}

export async function exportDjvuPagesAsImages(djvuPath: string, outputTemplatePath: string, options: IDjvuImageExportOptions = {}) {
    validateImageExportPath(outputTemplatePath, options.format ?? 'png');
    const {pageCount, pages} = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const pageDpiByNumber = await assertDjvuExportPageRasterBudget(djvuPath, pageCount, pages, options.signal);
    return renderDjvuImagePages(djvuPath, outputTemplatePath, pageCount, pages, options, pageDpiByNumber);
}

export async function exportDjvuAsMultiPageTiff(djvuPath: string, outputPath: string, options: IDjvuImageExportOptions = {}) {
    const targetPath = validateImageExportPath(outputPath, 'tiff');
    const {pageCount, pages} = await resolvePages(djvuPath, options.pageNumbers, options.signal);
    const pageDpiByNumber = await assertDjvuExportPageRasterBudget(djvuPath, pageCount, pages, options.signal);
    return usingDjvuScratch(options, 'djvu-tiff-export-', async (tempDirectory) => {
        const pagePaths: string[] = [];
        let batchDpi: number | undefined;
        let stagedBytes = 0;
        const exportPages = [...iterateExportPages(pageCount, pages)];
        const totalPages = exportPages.length;
        const stagedGroups: Array<{stagedPath: string}> = [];
        const concurrency = resolveDjvuImageExportConcurrency(DJVU_TIFF_RENDER_PAGE_RESIDENT_BYTES);
        const ownerId = options.cancelGroup ?? `djvu-tiff-export:${djvuPath}`;
        const combineBatch = async () => {
            if (pagePaths.length === 0) {
                return;
            }
            const batchPaths = pagePaths.splice(0);
            const currentBatchDpi = batchDpi;
            batchDpi = undefined;
            stagedBytes = 0;
            const stagedPath = makeSiblingTempPath(targetPath);
            const nativeTempPath = makeSiblingTempPath(stagedPath);
            await recordManagedScratchPaths(tempDirectory, [stagedPath, nativeTempPath]);
            stagedGroups.push({stagedPath});
            const combined = await mainJobBroker.run(
                {
                    ownerId,
                    kind: 'djvu-tiff-combine',
                    priority: 'user',
                    resources: {
                        cpuTokens: 1,
                        estimatedResidentBytes: resolvePdfImageCombineResidentBytes(mainJobBroker.getSnapshot().capacity),
                        nativeProcesses: 1,
                        ioWeight: 3,
                    },
                    ...(options.signal ? {signal: options.signal} : {}),
                },
                (brokerRun) =>
                    tryCombinePagesWithNativeTiffCombiner(
                        batchPaths,
                        stagedPath,
                        nativeTempPath,
                        options.signal,
                        currentBatchDpi,
                        brokerRun,
                        resolvePdfImageCombineThreads(brokerRun.lease.resources),
                        options.cancelGroup,
                    ),
            );
            if (!combined) {
                throw new Error('Native TIFF output service is unavailable for DjVu export');
            }
            await Promise.all(batchPaths.map((batchPath) => rm(batchPath, {force: true}).catch(() => undefined)));
        };

        let promoted = false;
        try {
            let processedPages = 0;
            let cursor = 0;
            while (cursor < exportPages.length) {
                throwIfAborted(options.signal);
                const waveDpi = pageDpiByNumber.get(exportPages[cursor]!);
                if (pagePaths.length > 0 && waveDpi !== batchDpi) {
                    await combineBatch();
                }
                const remainingBatchSlots = Math.max(1, DJVU_TIFF_BATCH_MAX_PAGES - pagePaths.length);
                const maxWavePages = Math.min(concurrency, remainingBatchSlots);
                let waveEnd = cursor;
                while (
                    waveEnd < exportPages.length &&
                    waveEnd - cursor < maxWavePages &&
                    pageDpiByNumber.get(exportPages[waveEnd]!) === waveDpi
                ) {
                    waveEnd += 1;
                }
                const wave = exportPages.slice(cursor, waveEnd).map((page) => ({
                    page,
                    ppmPath: join(tempDirectory, `page-${page}.ppm`),
                }));
                cursor = waveEnd;

                let firstRenderError: unknown;
                let hasRenderError = false;
                const renderResults = await Promise.allSettled(
                    wave.map(async (item) => {
                        try {
                            throwIfAborted(options.signal);
                            const rendered = await mainJobBroker.run(
                                {
                                    ownerId,
                                    kind: 'djvu-tiff-render-page',
                                    priority: 'user',
                                    resources: {
                                        cpuTokens: 1,
                                        estimatedResidentBytes: DJVU_TIFF_RENDER_PAGE_RESIDENT_BYTES,
                                        nativeProcesses: 1,
                                        ioWeight: 2,
                                    },
                                    ...(options.signal ? {signal: options.signal} : {}),
                                },
                                async ({onTerminationProof}) => {
                                    const result = await convertDjvuPageToImage(
                                        djvuPath,
                                        item.ppmPath,
                                        item.page,
                                        `djvu-tiff-export-${randomUUID()}`,
                                        {
                                            format: 'ppm',
                                            onTerminationProof,
                                            ...(options.signal ? {signal: options.signal} : {}),
                                        },
                                    );
                                    // Thrown inside the lease, so a render not proven gone keeps it charged.
                                    if (!result.success) {
                                        throw result.cause instanceof Error
                                            ? result.cause
                                            : new Error(result.error ?? `Failed to render DjVu page ${item.page}`);
                                    }
                                    return result;
                                },
                            );
                            return {
                                ...item,
                                fileSize: rendered.fileSize,
                            };
                        } catch (error) {
                            if (!hasRenderError) {
                                hasRenderError = true;
                                firstRenderError = error;
                            }
                            throw error;
                        }
                    }),
                );

                const renderErrors = renderResults
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => result.reason);
                if (renderErrors.length > 0) {
                    await Promise.all(
                        renderResults.flatMap((result) =>
                            result.status === 'fulfilled' ? [rm(result.value.ppmPath, {force: true}).catch(() => undefined)] : [],
                        ),
                    );
                    throw selectPrimaryWaveError(renderErrors, firstRenderError);
                }

                const renderedWave = renderResults.map(
                    (result) => (result as PromiseFulfilledResult<(typeof wave)[number] & {fileSize: number}>).value,
                );
                const unconsumedWavePaths = new Set(renderedWave.map((item) => item.ppmPath));
                try {
                    for (const item of renderedWave) {
                        if (
                            pagePaths.length > 0 &&
                            (pagePaths.length >= DJVU_TIFF_BATCH_MAX_PAGES ||
                                stagedBytes + item.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES)
                        ) {
                            await combineBatch();
                        }
                        if (item.fileSize > DJVU_EXPORT_MAX_BATCH_STAGED_BYTES) {
                            throw new Error('DjVu TIFF page exceeds the staged-byte limit');
                        }
                        stagedBytes += item.fileSize;
                        pagePaths.push(item.ppmPath);
                        unconsumedWavePaths.delete(item.ppmPath);
                        batchDpi ??= waveDpi;
                        processedPages += 1;
                        options.onProgress?.({
                            phase: 'rendering',
                            processed: processedPages,
                            total: totalPages,
                            percent: (processedPages / totalPages) * 90,
                        });
                    }
                } finally {
                    if (unconsumedWavePaths.size > 0) {
                        await Promise.all([...unconsumedWavePaths].map((ppmPath) => rm(ppmPath, {force: true}).catch(() => undefined)));
                    }
                }
            }
            await combineBatch();
            const suffixes = buildMultiPageTiffOutputSuffixes(stagedGroups.length);
            const stagedFiles = stagedGroups.map(({stagedPath}, index) => ({
                stagedPath,
                targetPath,
                suffix: suffixes[index]!,
                allowOverwrite: stagedGroups.length === 1,
            }));
            throwIfAborted(options.signal);
            await options.beforePublish?.();
            const outputPaths = await promoteStagedFiles(stagedFiles, options.signal, tempDirectory);
            promoted = true;
            options.onProgress?.({
                phase: 'combining',
                processed: outputPaths.length,
                total: outputPaths.length,
                percent: 100,
            });
            return outputPaths;
        } finally {
            if (!promoted) {
                await Promise.all(stagedGroups.map(({stagedPath}) => rm(stagedPath, {force: true}).catch(() => undefined)));
            }
        }
    });
}

export {exportDjvuPagesAsImages as exportDjvuPagesAsPng};
