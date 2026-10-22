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
import * as v from 'valibot';
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
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import { writePdfWithNativeImageCombineManifest } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { validatePdfFile } from '@electron/features/documents/main/pdfConformance';
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

const PDF_OPTIMIZE_RENDER_CHUNK_PAGES = 10;
const PDF_OPTIMIZE_RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const PDF_OPTIMIZE_REPLACE_TIMEOUT_MS = 30 * 60 * 1000;
const PDF_OPTIMIZE_REPLACE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/**
 * A page is re-encoded only when that saves at least a tenth of its bytes:
 * a smaller gain is not worth replacing the page's own image with a lossy one.
 */
const PDF_OPTIMIZE_MAX_REPLACEMENT_BYTE_RATIO = 0.9;
const NETPBM_HEADER_BYTES = 512;

/**
 * How a raster preset re-encodes a page. Pages are rendered as Netpbm so the
 * image combiner, not the renderer, chooses the stored encoding: JPEG pages
 * are written as one gray channel when the render is gray, and black-and-white
 * pages are binarized with scan cleanup's illumination normalization and
 * Sauvola threshold and stored as lossless 1-bit.
 */
type TRasterPageEncoding =
    | {
        kind: 'jpeg';
        quality: number;
        grayscale: boolean;
    }
    | {kind: 'black-and-white';};

interface IPdfRasterOptimizePreset {
    dpi: number;
    encoding: TRasterPageEncoding;
}

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
    /** Pages rendered and assembled so far; they only grow, so the bar only moves forward. */
    pages?: {
        total: number;
        rendered: number;
        assembled: number;
    };
}

/**
 * The bar's share for each stage. Rendering and assembling pages is most of
 * the work and advances per page; placing the pages, the structure pass and
 * the validity check that follow have no count, so the dialog shows their
 * elapsed time instead.
 */
const OPTIMIZE_PAGE_WORK_PERCENT = 80;
const OPTIMIZE_RENDER_WEIGHT = 3;
const OPTIMIZE_ASSEMBLE_WEIGHT = 1;
const OPTIMIZE_STAGE_PERCENT = {
    preparing: 0,
    optimizing: OPTIMIZE_PAGE_WORK_PERCENT,
    validating: 90,
    complete: 100,
} as const;
const RENDERED_PAGE_POLL_MS = 300;

interface IOptimizePdfToFileOptions {
    cancelGroup?: string;
    requestId: TRequestId;
    signal?: AbortSignal;
    onProgress?: (progress: IPdfOptimizeProgress) => void;
}

const RASTER_PRESETS: Record<Exclude<TPdfOptimizePreset, 'lossless'>, IPdfRasterOptimizePreset> = {
    balancedScanned: {
        dpi: 200,
        encoding: {
            kind: 'jpeg',
            quality: 82,
            grayscale: false,
        },
    },
    smallScanned: {
        dpi: 150,
        encoding: {
            kind: 'jpeg',
            quality: 60,
            grayscale: true,
        },
    },
    blackAndWhite: {
        dpi: 300,
        encoding: {kind: 'black-and-white'},
    },
};

const REPLACE_PAGE_IMAGES_REPORT_SCHEMA = v.object({
    format: v.literal('evb-pdf-replace-page-images'),
    pages: v.array(v.object({
        pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
        outcome: v.picklist([
            'replaced',
            'not-smaller',
            'no-images',
            'visible-text',
            'visible-drawing',
            'form-xobject',
            'unsupported-text',
        ]),
        sourceBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
        replacementBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    })),
});

interface IReplacementPage {
    pageNumber: number;
    replacement: string;
    replacementPageNumber: number;
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

/** Percent of the whole optimization, not of the current stage. */
function resolveOverallPercent(
    context: IOptimizeProgressContext,
    phase: IPdfOptimizeProgress['phase'],
) {
    if (phase !== 'rendering' && phase !== 'assembling') {
        return OPTIMIZE_STAGE_PERCENT[phase];
    }
    const pages = context.pages;
    if (pages === undefined || pages.total <= 0) {
        return OPTIMIZE_STAGE_PERCENT.preparing;
    }
    const work = OPTIMIZE_RENDER_WEIGHT * pages.rendered + OPTIMIZE_ASSEMBLE_WEIGHT * pages.assembled;
    const totalWork = (OPTIMIZE_RENDER_WEIGHT + OPTIMIZE_ASSEMBLE_WEIGHT) * pages.total;
    return Math.min(OPTIMIZE_PAGE_WORK_PERCENT, Math.floor(OPTIMIZE_PAGE_WORK_PERCENT * work / totalWork));
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
        percent: resolveOverallPercent(context, phase),
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

/**
 * Puts each re-encoded page into its source page when that saves enough
 * bytes, and returns how many pages changed. A page keeps its own content
 * otherwise, and when it shows text or vector content that its image would
 * flatten.
 */
async function replacePageImages(
    inputPath: string,
    outputPath: string,
    pages: IReplacementPage[],
    scratchDir: string,
    context: IOptimizeProgressContext,
) {
    const pageOpsPath = resolveNativePageOpsPath();
    if (!pageOpsPath) {
        throw new Error('Native PDF page tool is unavailable');
    }
    const instructionsPath = join(scratchDir, 'replace-page-images.json');
    await writeFile(instructionsPath, JSON.stringify({
        maxByteRatio: PDF_OPTIMIZE_MAX_REPLACEMENT_BYTE_RATIO,
        pages,
    }), 'utf8');
    const result = await runNativeToolCommand(pageOpsPath, [
        'replace-page-images',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--instructions-file',
        instructionsPath,
        '--qpdf',
        getPdfNativeToolPaths().qpdf,
    ], {
        commandLabel: 'evb-pdf-page-ops(replace-page-images)',
        timeoutMs: PDF_OPTIMIZE_REPLACE_TIMEOUT_MS,
        maxStdoutBytes: PDF_OPTIMIZE_REPLACE_MAX_STDOUT_BYTES,
        rejectOnStdoutTruncation: true,
        ...signalOptions(context),
    });
    const report = v.parse(REPLACE_PAGE_IMAGES_REPORT_SCHEMA, JSON.parse(result.stdout));
    return report.pages.filter(page => page.outcome === 'replaced').length;
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

        emitProgress(context, 'optimizing', pageCount, pageCount);
        const optimizedPages = await replacePageImages(
            inputPath,
            tempOutputPath,
            replacements,
            tempDir,
            context,
        );
        if (optimizedPages === 0) {
            await copyFileCopyOnWrite(inputPath, tempOutputPath);
        }
        return {
            validation: await finishCandidate(tempOutputPath, context, pageCount),
            optimizedPages,
        };
    });
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
