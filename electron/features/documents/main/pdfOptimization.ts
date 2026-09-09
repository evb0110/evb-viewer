import {
    copyFile,
    mkdtemp,
    readdir,
    rm,
    stat,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    extname,
    join,
} from 'path';
import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    IPdfOptimizeResult,
    TPdfOptimizePreset,
} from '@contracts/electronApiDocuments';
import { isPdfOptimizePreset } from '@contracts/electronApiDocuments';
import { isRecord } from '@contracts/runtimeGuards';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/public';
import { tryWritePdfWithNativeImageCombiner } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
import { optimizePdfForSave } from '@electron/features/documents/main/pdfSaveAsOptimization';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { parseDocumentRef } from '@contracts/documentRef';
import type { TRequestId } from '@contracts/shared';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';

const PDF_OPTIMIZE_RENDER_CHUNK_PAGES = parseIntegerEnv(
    'EVB_PDF_OPTIMIZE_RENDER_CHUNK_PAGES',
    25,
    1,
    100,
);
const PDF_OPTIMIZE_RENDER_TIMEOUT_MS = parseIntegerEnv(
    'EVB_PDF_OPTIMIZE_RENDER_TIMEOUT_MS',
    15 * 60 * 1000,
    10_000,
);
const PDF_OPTIMIZE_MERGE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_PDF_OPTIMIZE_MERGE_TIMEOUT_MS',
    30 * 60 * 1000,
    10_000,
);

interface IPdfRasterOptimizePreset {
    dpi: number;
    jpegQuality: number;
    grayscale: boolean;
}

export interface IPdfOptimizePageRange {
    firstPage: number;
    lastPage: number;
}

interface IOptimizeProgressContext {
    cancelGroup?: string;
    requestId: TRequestId;
    preset: TPdfOptimizePreset;
    signal?: AbortSignal;
    emit?: (progress: IPdfOptimizeProgress) => void;
}

interface IOptimizePdfToFileOptions {
    cancelGroup?: string;
    requestId: TRequestId;
    signal?: AbortSignal;
    onProgress?: (progress: IPdfOptimizeProgress) => void;
}

const RASTER_PRESETS: Record<Exclude<TPdfOptimizePreset, 'lossless'>, IPdfRasterOptimizePreset> = {
    balancedScanned: {
        dpi: 200,
        jpegQuality: 82,
        grayscale: false,
    },
    smallScanned: {
        dpi: 150,
        jpegQuality: 60,
        grayscale: true,
    },
    blackAndWhite: {
        dpi: 200,
        jpegQuality: 68,
        grayscale: true,
    },
};

function requireDocumentRef(value: unknown) {
    const documentRef = parseDocumentRef(value);
    if (documentRef === null) {
        throw new Error('Expected an absolute document ref');
    }
    return documentRef;
}

export function normalizePdfOptimizeOptions(value: unknown): IPdfOptimizeOptions {
    if (!isRecord(value) || !isPdfOptimizePreset(value.preset)) {
        throw new Error('Invalid PDF optimize options');
    }

    return { preset: value.preset };
}

export function* createPageRanges(
    pageCount: number,
    chunkPages = PDF_OPTIMIZE_RENDER_CHUNK_PAGES,
): Generator<IPdfOptimizePageRange> {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pageCount must be a positive safe integer');
    }
    if (!Number.isSafeInteger(chunkPages) || chunkPages < 1) {
        throw new Error('chunkPages must be a positive safe integer');
    }

    let firstPage = 1;
    while (firstPage <= pageCount) {
        const pageSpan = Math.min(chunkPages, pageCount - firstPage + 1);
        const lastPage = firstPage + pageSpan - 1;
        yield {
            firstPage,
            lastPage,
        };
        if (lastPage === pageCount) {
            return;
        }
        firstPage = lastPage + 1;
    }
}

function clampProgress(processed: number, total: number) {
    const normalizedTotal = Math.max(1, Math.trunc(total));
    const normalizedProcessed = Math.max(0, Math.min(normalizedTotal, Math.trunc(processed)));
    return {
        processed: normalizedProcessed,
        total: normalizedTotal,
        percent: Math.round((normalizedProcessed / normalizedTotal) * 100),
    };
}

function emitProgress(
    context: IOptimizeProgressContext,
    phase: IPdfOptimizeProgress['phase'],
    processed: number,
    total: number,
) {
    const progress = clampProgress(processed, total);
    context.emit?.({
        requestId: context.requestId,
        preset: context.preset,
        phase,
        ...progress,
    });
}

function parsePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.[^.]+$/u);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

async function collectRenderedJpegPages(renderDir: string) {
    const entries = await readdir(renderDir);
    return entries
        .filter(entry => {
            const extension = extname(entry).toLowerCase();
            return extension === '.jpg' || extension === '.jpeg';
        })
        .sort((left, right) => parsePageNumber(left) - parsePageNumber(right))
        .map(entry => join(renderDir, entry));
}

async function renderPdfRangeToJpegPages(
    inputPath: string,
    renderDir: string,
    range: IPdfOptimizePageRange,
    preset: IPdfRasterOptimizePreset,
    signal?: AbortSignal,
    cancelGroup?: string,
) {
    const paths = getPdfNativeToolPaths();
    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: PDF_OPTIMIZE_RENDER_TIMEOUT_MS,
        commandLabel: 'pdftoppm(pdf-optimize)',
        ...(signal ? {signal} : {}),
        ...(cancelGroup ? {cancelGroup} : {}),
    };
    const popplerEnv = buildPopplerEnv(paths);
    if (popplerEnv !== undefined) {
        commandOptions.env = popplerEnv;
    }

    const args = [
        '-q',
        ...(preset.grayscale ? ['-gray'] : []),
        '-jpeg',
        '-jpegopt',
        `quality=${preset.jpegQuality}`,
        '-r',
        String(preset.dpi),
        '-f',
        String(range.firstPage),
        '-l',
        String(range.lastPage),
        inputPath,
        join(renderDir, 'page'),
    ];
    await runNativeToolCommand(paths.pdftoppm, args, commandOptions);

    const pagePaths = await collectRenderedJpegPages(renderDir);
    const expectedCount = range.lastPage - range.firstPage + 1;
    if (pagePaths.length !== expectedCount) {
        throw new Error(`PDF optimization rendered ${pagePaths.length} pages, expected ${expectedCount}`);
    }
    return pagePaths;
}

async function assembleImageChunk(
    imagePaths: string[],
    chunkPath: string,
    pageOffset: number,
    pageCount: number,
    context: IOptimizeProgressContext,
) {
    const ok = await tryWritePdfWithNativeImageCombiner(imagePaths, chunkPath, {
        maxPages: imagePaths.length,
        onProgress: progress => emitProgress(
            context,
            'assembling',
            pageOffset + progress.processed,
            pageCount,
        ),
        ...(context.signal ? {signal: context.signal} : {}),
    });
    if (!ok) {
        throw new Error('Native PDF image assembler is unavailable');
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Optimizing scanned PDF chunk');
}

async function mergePdfChunks(chunkPaths: string[], outputPath: string, context: IOptimizeProgressContext) {
    if (chunkPaths.length === 1) {
        await copyFile(chunkPaths[0]!, outputPath);
        await assertNonEmptyPdfOutput(outputPath, 'Optimizing scanned PDF');
        return;
    }

    await runQpdfCommand([
        '--empty',
        '--pages',
        ...chunkPaths.flatMap(chunkPath => [
            chunkPath,
            '1-z',
        ]),
        '--',
        outputPath,
    ], {
        timeoutMs: Math.max(QPDF_TIMEOUT_MS, PDF_OPTIMIZE_MERGE_TIMEOUT_MS),
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(pdf-optimize-merge)',
        ...(context.signal ? {signal: context.signal} : {}),
        ...(context.cancelGroup ? {cancelGroup: context.cancelGroup} : {}),
    });
    await assertNonEmptyPdfOutput(outputPath, 'Optimizing scanned PDF');
}

function getRasterPreset(preset: TPdfOptimizePreset): IPdfRasterOptimizePreset {
    if (preset === 'lossless') {
        throw new Error('Lossless PDF optimization preset does not have raster settings');
    }
    return RASTER_PRESETS[preset];
}

async function finalizeOptimizedPdf(
    tempPath: string,
    outputPath: string,
    context: IOptimizeProgressContext,
    pageCount: number,
) {
    emitProgress(context, 'optimizing', pageCount, pageCount);
    await optimizePdfForSave(tempPath, {
        force: true,
        skipSemanticPreflight: true,
        label: 'qpdf(pdf-optimize-final)',
        ...(context.signal ? {signal: context.signal} : {}),
        ...(context.cancelGroup ? {cancelGroup: context.cancelGroup} : {}),
    });

    emitProgress(context, 'validating', pageCount, pageCount);
    const validation = await validatePdfFile(tempPath, {
        ...(context.signal ? {signal: context.signal} : {}),
        ...(context.cancelGroup ? {cancelGroup: context.cancelGroup} : {}),
    });
    if (!validation.isValid) {
        return validation;
    }

    await atomicReplace(tempPath, outputPath);
    emitProgress(context, 'complete', pageCount, pageCount);
    return validation;
}

async function optimizeLosslessCopy(
    inputPath: string,
    tempOutputPath: string,
    outputPath: string,
    context: IOptimizeProgressContext,
) {
    emitProgress(context, 'preparing', 0, 1);
    await copyFileCopyOnWrite(inputPath, tempOutputPath);
    return finalizeOptimizedPdf(tempOutputPath, outputPath, context, 1);
}

async function optimizeRasterCopy(
    inputPath: string,
    tempOutputPath: string,
    outputPath: string,
    pageCount: number,
    preset: IPdfRasterOptimizePreset,
    context: IOptimizeProgressContext,
) {
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-optimize-'));
    const chunkPaths: string[] = [];
    let processedPages = 0;
    let retainNativeCleanup = false;

    try {
        for (const range of createPageRanges(pageCount)) {
            const actualRenderDir = await mkdtemp(join(tempDir, 'render-pages-'));
            let retainRenderCleanup = false;
            try {
                const renderedPages = await renderPdfRangeToJpegPages(
                    inputPath,
                    actualRenderDir,
                    range,
                    preset,
                    context.signal,
                    context.cancelGroup,
                );
                processedPages += renderedPages.length;
                emitProgress(context, 'rendering', processedPages, pageCount);

                const chunkPath = join(tempDir, `chunk-${String(chunkPaths.length + 1).padStart(5, '0')}.pdf`);
                await assembleImageChunk(
                    renderedPages,
                    chunkPath,
                    range.firstPage - 1,
                    pageCount,
                    context,
                );
                chunkPaths.push(chunkPath);
            } catch (error) {
                if (getUnprovenNativeTerminationDetail(error) !== undefined) {
                    retainRenderCleanup = true;
                    retainNativeCleanup = true;
                }
                throw error;
            } finally {
                if (!retainRenderCleanup) {
                    await rm(actualRenderDir, {
                        recursive: true,
                        force: true,
                    }).catch(() => undefined);
                }
            }
        }

        await mergePdfChunks(chunkPaths, tempOutputPath, context);
        return await finalizeOptimizedPdf(tempOutputPath, outputPath, context, pageCount);
    } catch (error) {
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            retainNativeCleanup = true;
        }
        throw error;
    } finally {
        if (!retainNativeCleanup) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }
}

export async function optimizePdfToFile(
    inputPath: string,
    outputPath: string,
    options: IPdfOptimizeOptions,
    optimizeOptions: IOptimizePdfToFileOptions,
): Promise<IPdfOptimizeResult> {
    const normalizedOptions = normalizePdfOptimizeOptions(options);
    const requestId = optimizeOptions.requestId;
    const context: IOptimizeProgressContext = {
        ...(optimizeOptions.cancelGroup ? {cancelGroup: optimizeOptions.cancelGroup} : {}),
        requestId,
        preset: normalizedOptions.preset,
        ...(optimizeOptions.signal ? {signal: optimizeOptions.signal} : {}),
        ...(optimizeOptions.onProgress ? {emit: optimizeOptions.onProgress} : {}),
    };
    const originalBytes = await stat(inputPath).then(stats => stats.size).catch(() => null);
    const pageCount = normalizedOptions.preset === 'lossless'
        ? null
        : await getPdfPageCount(inputPath, {
            ...(optimizeOptions.signal ? {signal: optimizeOptions.signal} : {}),
            ...(optimizeOptions.cancelGroup ? {cancelGroup: optimizeOptions.cancelGroup} : {}),
        });
    const tempOutputPath = makeSiblingTempPath(outputPath);
    let replaced = false;

    try {
        const validation = normalizedOptions.preset === 'lossless'
            ? await optimizeLosslessCopy(inputPath, tempOutputPath, outputPath, context)
            : await optimizeRasterCopy(
                inputPath,
                tempOutputPath,
                outputPath,
                pageCount ?? await getPdfPageCount(inputPath, {
                    ...(optimizeOptions.signal ? {signal: optimizeOptions.signal} : {}),
                    ...(optimizeOptions.cancelGroup ? {cancelGroup: optimizeOptions.cancelGroup} : {}),
                }),
                getRasterPreset(normalizedOptions.preset),
                context,
            );
        if (!validation.isValid) {
            return {
                path: null,
                validation,
                preset: normalizedOptions.preset,
                originalBytes,
                optimizedBytes: null,
                pageCount,
            };
        }

        replaced = true;
        const optimizedBytes = await stat(outputPath).then(stats => stats.size).catch(() => null);
        return {
            path: requireDocumentRef(outputPath),
            validation,
            preset: normalizedOptions.preset,
            originalBytes,
            optimizedBytes,
            pageCount,
        };
    } finally {
        if (!replaced) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}
