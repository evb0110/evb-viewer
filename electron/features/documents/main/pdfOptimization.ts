import {
    open,
    readdir,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
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
} from '@electron/features/page-ops/public';
import { writePdfWithNativeImageCombineManifest } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { optimizePdfForSave } from '@electron/features/documents/main/pdfSaveAsOptimization';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { parseDocumentRef } from '@contracts/documentRef';
import type { TRequestId } from '@contracts/shared';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import {
    recompressImages,
    replacePageImages,
    type IReplacementPage,
} from '@electron/features/documents/main/pdfOptimizationPasses';
import {
    analyzePdfConformanceFile,
    validatePdfFile,
} from '@electron/features/documents/main/pdfConformance';
import {
    PDF_OPTIMIZE_RENDER_TIMEOUT_MS,
    RASTER_PRESETS,
    resolvePdfOptimizePercent,
    type IPdfOptimizePageWork,
    type IPdfRasterOptimizePreset,
} from '@pdf-core/pdfOptimization';
import {getPdfLosslessOptimizationSkipReason} from '@pdf-core/pdfConformanceHelpers';

const PDF_OPTIMIZE_RENDER_CHUNK_PAGES = 10;
const NETPBM_HEADER_BYTES = 512;

interface IPdfOptimizePageRange {
    firstPage: number;
    lastPage: number;
}

interface IOptimizeProgressContext {
    cancelGroup?: string;
    requestId: TRequestId;
    preset: TPdfOptimizePreset;
    signal?: AbortSignal;
    emit?: (progress: IPdfOptimizeProgress) => void;
    pages?: IPdfOptimizePageWork;
}

const RENDERED_PAGE_POLL_MS = 300;

interface IOptimizePdfToFileOptions {
    cancelGroup?: string;
    requestId: TRequestId;
    signal?: AbortSignal;
    onProgress?: (progress: IPdfOptimizeProgress) => void;
}

interface IOptimizedCandidate {
    validation: Awaited<ReturnType<typeof validatePdfFile>>;
    optimizedPages: number;
}

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
    };
}

function emitProgress(
    context: IOptimizeProgressContext,
    phase: IPdfOptimizeProgress['phase'],
    processed: number,
    total: number,
) {
    const progress = clampProgress(processed, total);
    if (context.pages !== undefined) {
        if (phase === 'rendering') {
            context.pages.rendered = Math.max(context.pages.rendered, progress.processed);
        } else if (phase === 'assembling') {
            context.pages.assembled = Math.max(context.pages.assembled, progress.processed);
        }
    }
    context.emit?.({
        requestId: context.requestId,
        preset: context.preset,
        phase,
        ...progress,
        percent: resolvePdfOptimizePercent(phase, context.pages),
    });
}

function signalOptions(context: IOptimizeProgressContext) {
    return {
        ...(context.signal ? {signal: context.signal} : {}),
        ...(context.cancelGroup ? {cancelGroup: context.cancelGroup} : {}),
    };
}

/**
 * pdftoppm renders a whole page range before it returns, so the pages it has
 * already written are counted while it runs; otherwise the first stage of a
 * large chunk shows no movement for many seconds.
 */
function watchRenderedPageCount(renderDir: string, onCount: (count: number) => void) {
    let reported = 0;
    let reading = false;
    let stopped = false;
    const timer = setInterval(() => {
        if (reading || stopped) {
            return;
        }
        reading = true;
        void collectRenderedPages(renderDir)
            .then(pages => {
                // A read that finishes after the range returned would report a
                // stale rendering stage over the assembly that followed it.
                if (!stopped && pages.length > reported) {
                    reported = pages.length;
                    onCount(reported);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                reading = false;
            });
    }, RENDERED_PAGE_POLL_MS);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

function parsePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.[^.]+$/u);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

async function collectRenderedPages(renderDir: string) {
    const entries = await readdir(renderDir);
    return entries
        .filter(entry => {
            const extension = extname(entry).toLowerCase();
            return extension === '.ppm' || extension === '.pgm';
        })
        .sort((left, right) => parsePageNumber(left) - parsePageNumber(right))
        .map(entry => join(renderDir, entry));
}

/** Width and height in pixels from the header pdftoppm writes. */
async function readNetpbmDimensions(path: string) {
    const handle = await open(path, 'r');
    let header: string;
    try {
        const buffer = Buffer.alloc(NETPBM_HEADER_BYTES);
        const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, 0);
        header = buffer.toString('latin1', 0, bytesRead);
    } finally {
        await handle.close();
    }
    const fields = header.replace(/#[^\n]*\n/gu, ' ').match(/^P[56]\s+(\d+)\s+(\d+)\s+255\s/u);
    const width = Number(fields?.[1]);
    const height = Number(fields?.[2]);
    if (!(width > 0 && height > 0)) {
        throw new Error(`Rendered page is not an 8-bit Netpbm image: ${path}`);
    }
    return {
        width,
        height,
    };
}

async function renderPdfRange(
    inputPath: string,
    renderDir: string,
    range: IPdfOptimizePageRange,
    preset: IPdfRasterOptimizePreset,
    context: IOptimizeProgressContext,
) {
    const paths = getPdfNativeToolPaths();
    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: PDF_OPTIMIZE_RENDER_TIMEOUT_MS,
        commandLabel: 'pdftoppm(pdf-optimize)',
        ...signalOptions(context),
    };
    const popplerEnv = buildPopplerEnv(paths);
    if (popplerEnv !== undefined) {
        commandOptions.env = popplerEnv;
    }

    const grayscale = preset.encoding.kind === 'black-and-white' || preset.encoding.grayscale;
    // The page's view, as a viewer shows it. Annotations stay live on the
    // page, so they are not painted into its image too.
    const args = [
        '-q',
        '-cropbox',
        '-hide-annotations',
        ...(grayscale ? ['-gray'] : []),
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

    const pagePaths = await collectRenderedPages(renderDir);
    const expectedCount = range.lastPage - range.firstPage + 1;
    if (pagePaths.length !== expectedCount) {
        throw new Error(`PDF optimization rendered ${pagePaths.length} pages, expected ${expectedCount}`);
    }
    return pagePaths;
}

async function writeChunkManifest(
    pagePaths: string[],
    manifestPath: string,
    preset: IPdfRasterOptimizePreset,
) {
    const lines: string[] = [];
    for (const pagePath of pagePaths) {
        const {
            width, height,
        } = await readNetpbmDimensions(pagePath);
        const pageSize = [
            (width / preset.dpi * 72).toFixed(6),
            (height / preset.dpi * 72).toFixed(6),
        ];
        lines.push(preset.encoding.kind === 'black-and-white'
            ? [
                'image-bw',
                ...pageSize,
                pagePath,
            ].join('\t')
            : [
                'image-jpeg',
                ...pageSize,
                String(preset.encoding.quality),
                pagePath,
            ].join('\t'));
    }
    await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
}

async function assembleRenderedChunk(
    pagePaths: string[],
    renderDir: string,
    chunkPath: string,
    pageOffset: number,
    pageCount: number,
    preset: IPdfRasterOptimizePreset,
    context: IOptimizeProgressContext,
) {
    const manifestPath = join(renderDir, 'pages.tsv');
    await writeChunkManifest(pagePaths, manifestPath, preset);
    // Chunks stay files until the pages are placed, so they are not held to
    // the cap on bytes returned into memory.
    const ok = await writePdfWithNativeImageCombineManifest(manifestPath, chunkPath, {
        maxPages: pagePaths.length,
        outputMode: 'file-backed',
        onProgress: progress => emitProgress(
            context,
            'assembling',
            pageOffset + progress.processed,
            pageCount,
        ),
        ...(context.signal ? {signal: context.signal} : {}),
    });
    if (!ok) {
        throw new Error('Native PDF image assembler failed to write the re-encoded pages');
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Optimizing scanned PDF chunk');
}

function getRasterPreset(preset: TPdfOptimizePreset): IPdfRasterOptimizePreset {
    if (preset === 'lossless') {
        throw new Error('Lossless PDF optimization preset does not have raster settings');
    }
    return RASTER_PRESETS[preset];
}

/** Rewrites the candidate's structure and checks it; publishing is the caller's. */
async function finishCandidate(
    tempPath: string,
    context: IOptimizeProgressContext,
    pageCount: number,
) {
    emitProgress(context, 'optimizing', pageCount, pageCount);
    await optimizePdfForSave(tempPath, {
        force: true,
        skipSemanticPreflight: true,
        label: 'qpdf(pdf-optimize-final)',
        ...signalOptions(context),
    });

    emitProgress(context, 'validating', pageCount, pageCount);
    return validatePdfFile(tempPath, signalOptions(context));
}

async function optimizeLosslessCopy(
    inputPath: string,
    tempOutputPath: string,
    context: IOptimizeProgressContext,
): Promise<IOptimizedCandidate> {
    emitProgress(context, 'preparing', 0, 1);
    await copyFileCopyOnWrite(inputPath, tempOutputPath);
    return {
        validation: await finishCandidate(tempOutputPath, context, 1),
        optimizedPages: 0,
    };
}

async function optimizeRasterCopy(
    inputPath: string,
    tempOutputPath: string,
    pageCount: number,
    preset: IPdfRasterOptimizePreset,
    context: IOptimizeProgressContext,
): Promise<IOptimizedCandidate> {
    const replacements: IReplacementPage[] = [];
    let processedPages = 0;
    context.pages = {
        total: pageCount,
        rendered: 0,
        assembled: 0,
    };
    emitProgress(context, 'rendering', 0, pageCount);
    return usingManagedScratchScope('pdfExport-scope-', getAppTempDir(), async tempDir => {
        for (const range of createPageRanges(pageCount)) {
            const chunkPath = join(tempDir, `chunk-${String(range.firstPage).padStart(6, '0')}.pdf`);
            await usingManagedScratchScope('pdfExport-', tempDir, async renderDir => {
                const pagesBeforeRange = processedPages;
                const stopWatching = watchRenderedPageCount(renderDir, count => emitProgress(
                    context,
                    'rendering',
                    pagesBeforeRange + count,
                    pageCount,
                ));
                let renderedPages: string[];
                try {
                    renderedPages = await renderPdfRange(inputPath, renderDir, range, preset, context);
                } finally {
                    stopWatching();
                }
                processedPages += renderedPages.length;
                emitProgress(context, 'rendering', processedPages, pageCount);
                await assembleRenderedChunk(
                    renderedPages,
                    renderDir,
                    chunkPath,
                    range.firstPage - 1,
                    pageCount,
                    preset,
                    context,
                );
            });
            for (let pageNumber = range.firstPage; pageNumber <= range.lastPage; pageNumber += 1) {
                replacements.push({
                    pageNumber,
                    replacement: chunkPath,
                    replacementPageNumber: pageNumber - range.firstPage + 1,
                });
            }
        }

        emitProgress(context, 'compressingImages', pageCount, pageCount);
        const replacedPath = join(tempDir, 'replaced-pages.pdf');
        const replacedPages = await replacePageImages({
            input: inputPath,
            output: replacedPath,
            scratchDir: tempDir,
        }, replacements, signalOptions(context));
        const imageSourcePath = replacedPages.length > 0 ? replacedPath : inputPath;
        const imagePages = await recompressImages({
            input: imageSourcePath,
            output: tempOutputPath,
            scratchDir: tempDir,
        }, replacedPages, preset.images, signalOptions(context));
        if (imagePages.length === 0) {
            await copyFileCopyOnWrite(imageSourcePath, tempOutputPath);
        }
        return {
            validation: await finishCandidate(tempOutputPath, context, pageCount),
            optimizedPages: new Set([
                ...replacedPages,
                ...imagePages,
            ]).size,
        };
    });
}

/**
 * Rewriting a signed, encrypted, PDF/A or XFA document breaks what makes it
 * one, so Optimize refuses it before any work, as Save As skips it. A failed
 * analysis proves nothing and refuses too.
 */
async function assertPdfOptimizationEligible(inputPath: string) {
    const skipReason = getPdfLosslessOptimizationSkipReason(await analyzePdfConformanceFile(inputPath));
    if (skipReason) {
        throw new Error(`Optimize PDF does not rewrite a ${skipReason}: it would no longer be one.`);
    }
}

/**
 * Writes an optimized copy of `inputPath` to `outputPath` only when the copy
 * is smaller. Otherwise nothing is written and the result says so with the
 * size the best attempt reached.
 */
export async function optimizePdfToFile(
    inputPath: string,
    outputPath: string,
    options: IPdfOptimizeOptions,
    optimizeOptions: IOptimizePdfToFileOptions,
): Promise<IPdfOptimizeResult> {
    const normalizedOptions = normalizePdfOptimizeOptions(options);
    const context: IOptimizeProgressContext = {
        ...(optimizeOptions.cancelGroup ? {cancelGroup: optimizeOptions.cancelGroup} : {}),
        requestId: optimizeOptions.requestId,
        preset: normalizedOptions.preset,
        ...(optimizeOptions.signal ? {signal: optimizeOptions.signal} : {}),
        ...(optimizeOptions.onProgress ? {emit: optimizeOptions.onProgress} : {}),
    };
    const originalBytes = (await stat(inputPath)).size;
    await assertPdfOptimizationEligible(inputPath);
    const pageCount = normalizedOptions.preset === 'lossless'
        ? null
        : await getPdfPageCount(inputPath, signalOptions(context));
    const tempOutputPath = makeSiblingTempPath(outputPath);
    const result = {
        preset: normalizedOptions.preset,
        originalBytes,
        pageCount,
    };

    try {
        const candidate = pageCount === null
            ? await optimizeLosslessCopy(inputPath, tempOutputPath, context)
            : await optimizeRasterCopy(
                inputPath,
                tempOutputPath,
                pageCount,
                getRasterPreset(normalizedOptions.preset),
                context,
            );
        if (!candidate.validation.isValid) {
            return {
                ...result,
                outcome: 'invalid',
                path: null,
                validation: candidate.validation,
                optimizedBytes: null,
                optimizedPages: candidate.optimizedPages,
            };
        }
        const optimizedBytes = (await stat(tempOutputPath)).size;
        if (optimizedBytes >= originalBytes) {
            emitProgress(context, 'complete', 1, 1);
            return {
                ...result,
                outcome: 'not-smaller',
                path: null,
                validation: candidate.validation,
                optimizedBytes,
                optimizedPages: candidate.optimizedPages,
            };
        }

        await atomicReplace(tempOutputPath, outputPath);
        emitProgress(context, 'complete', 1, 1);
        return {
            ...result,
            outcome: 'saved',
            path: requireDocumentRef(outputPath),
            validation: candidate.validation,
            optimizedBytes,
            optimizedPages: candidate.optimizedPages,
        };
    } finally {
        await rm(tempOutputPath, { force: true }).catch(() => undefined);
    }
}
