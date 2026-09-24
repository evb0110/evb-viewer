/**
 * One OCR job: select the pages that need recognition, render and recognize
 * each page under a broker lease, checkpoint every recognized page, write the
 * searchable PDF in one pdf-page-ops pass, and stage the text catalog.
 *
 * The job runs in the main process inside a job-registry record. The native
 * tools do the CPU work in child processes; this code only orchestrates them.
 */

import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    mkdir,
    readFile,
    rm,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import type {
    IOcrPageWithWords,
    IOcrPageProcessingResult,
    IOcrPdfPageRequest,
    IOcrPipelinePaths,
    TOcrJobResult,
    TOcrPdfPageSelection,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {clampDpi} from '@electron/image/imageDpi';
import {
    getPngDimensionsFromFile,
    runOcrFileBased,
} from '@electron/features/ocr/pipeline/tesseractRunner';
import {tryPreprocessOcrImage} from '@electron/features/ocr/pipeline/tryPreprocessOcrImage';
import {writeSearchablePdf} from '@electron/features/ocr/pipeline/writeSearchablePdf';
import {
    buildPopplerEnv,
    createOcrRasterRenderLimits,
    preparePdfForPoppler,
    probeOcrPageSizeInches,
    renderOcrPageToPng,
    type IPreparedPopplerPdf,
} from '@electron/features/ocr/pipeline/popplerStage';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {
    getOcrPageSelectionCount,
    iterateOcrPageRequestBatches,
} from '@electron/features/ocr/contracts';
import {selectOcrPagesForSupersession} from '@electron/features/ocr/pipeline/selectOcrPagesForSupersession';
import {sha256OcrFile} from '@electron/features/ocr/pipeline/sha256OcrFile';
import {
    readOcrPdfPageSizesInches,
    type IOcrPageSizeInches,
    type TOcrPageSizeProbeResult,
} from '@electron/features/ocr/pipeline/pdfPageSizeProbe';
import {
    cleanupStaleOcrJobDirectories,
    createOcrJobManifestController,
} from '@electron/features/ocr/pipeline/ocrJobManifest';
import {
    createOcrJobStorageBudget,
    isOcrStorageFailure,
    type TOcrJobStorageBudget,
} from '@electron/features/ocr/pipeline/ocrJobStorageBudget';
import {cleanupOcrTempFiles} from '@electron/features/ocr/pipeline/cleanupOcrTempFiles';
import {persistOcrPageCheckpoint} from '@electron/features/ocr/pipeline/persistOcrPageCheckpoint';
import {
    getLastOcrSelectionPage,
    iterateCheckpointPageResults,
    normalizeOcrPageSelection,
} from '@electron/features/ocr/pipeline/ocrPageSelectionStream';
import {getOcrRuntimePolicy} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {
    mainJobBroker,
    type IJobBrokerLease,
} from '@electron/resources/jobBroker';

/** One checkpoint directory per job fingerprint; a concurrent twin gets its own. */
const activeCheckpointFingerprints = new Set<string>();
const MAX_JOB_MESSAGES = 10_000;
const MAX_JOB_DIAGNOSTICS = 10_000;
const MAX_TRACKED_TEMP_FILES = 1_024;
const DEFAULT_PAGE_SIZE_INCHES: IOcrPageSizeInches = {
    width: 8.5,
    height: 11,
};
const BYTES_PER_RGBA_PIXEL = 4;
const MAX_RENDERED_PIXELS = 45_000_000;
const HIGH_DPI_THRESHOLD = 450;

export interface IOcrJobProgress {
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: TOcrProgressPhase;
    phaseProgress?: number;
}

export interface IOcrJob {
    jobId: string;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: TOcrPdfPageSelection;
    options: IOcrSearchablePdfOptions;
    paths: IOcrPipelinePaths;
    signal: AbortSignal;
    publish: (progress: IOcrJobProgress) => void;
    log: TWorkerLog;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
    }
}

/**
 * Each page's render, preprocessing and recognition run under one broker
 * lease sized by the raster it will hold. A page that would exceed the pixel
 * cap is refused before anything renders.
 */
function acquireOcrPageLease(
    jobId: string,
    pageNumber: number,
    dpi: number,
    pageSize: IOcrPageSizeInches | undefined,
    signal: AbortSignal,
): Promise<IJobBrokerLease> {
    const {
        width,
        height,
    } = pageSize ?? DEFAULT_PAGE_SIZE_INCHES;
    const pixels = Math.ceil(width * dpi) * Math.ceil(height * dpi);
    if (pixels > MAX_RENDERED_PIXELS) {
        throw new RangeError(
            `OCR page ${pageNumber} at ${dpi} DPI requires ${pixels} rendered pixels; maximum is ${MAX_RENDERED_PIXELS}. Choose a lower quality setting explicitly.`,
        );
    }
    const {globalPageSlots} = getOcrRuntimePolicy();
    const heavy = dpi >= HIGH_DPI_THRESHOLD || pixels > MAX_RENDERED_PIXELS / 2;
    return mainJobBroker.acquire({
        ownerId: `ocr:${jobId}`,
        kind: 'ocr-page',
        priority: 'user',
        perOwnerLimit: globalPageSlots,
        resources: {
            cpuTokens: heavy ? Math.min(2, globalPageSlots) : 1,
            estimatedResidentBytes: pixels * BYTES_PER_RGBA_PIXEL,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal,
    });
}

async function readPngDimensions(imagePath: string) {
    const dims = await getPngDimensionsFromFile(imagePath);
    if (!dims) {
        throw new Error('Failed to determine PNG dimensions from pdftoppm output');
    }
    if (dims.width <= 0 || dims.height <= 0) {
        throw new Error(`Invalid page image dimensions: ${dims.width}x${dims.height}`);
    }
    return dims;
}

function mapOcrWordsThroughInverseTransform(
    words: IOcrPageWithWords['words'],
    matrix: number[][] | undefined,
) {
    if (matrix === undefined) {
        return words;
    }
    const [
        row0,
        row1,
        row2,
    ] = matrix;
    if (!row0 || !row1 || !row2 || row0.length < 3 || row1.length < 3 || row2.length < 3) {
        throw new Error('OCR preprocessing inverse transform is not a 3x3 matrix');
    }
    const apply = (x: number, y: number) => {
        const w = row2[0]! * x + row2[1]! * y + row2[2]!;
        return [
            (row0[0]! * x + row0[1]! * y + row0[2]!) / w,
            (row1[0]! * x + row1[1]! * y + row1[2]!) / w,
        ] as const;
    };
    return words.map(word => {
        const corners = [
            apply(word.x, word.y),
            apply(word.x + word.width, word.y),
            apply(word.x, word.y + word.height),
            apply(word.x + word.width, word.y + word.height),
        ];
        if (corners.some(([
            x,
            y,
        ]) => !Number.isFinite(x) || !Number.isFinite(y))) {
            throw new Error(`OCR preprocessing produced a non-finite inverse-mapped word: ${word.text}`);
        }
        const xs = corners.map(([x]) => x);
        const ys = corners.map(([
            , y,
        ]) => y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const width = Math.max(...xs) - x;
        const height = Math.max(...ys) - y;
        if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
            throw new Error(`OCR preprocessing produced an unusable inverse-mapped word: ${word.text}`);
        }
        return {
            ...word,
            x,
            y,
            width,
            height,
        };
    });
}

export interface IOcrPageProcessingContext {
    jobId: string;
    log: TWorkerLog;
    sessionId: string;
    paths: IOcrPipelinePaths;
    getPopplerSourcePdfPath: () => string;
    preparePopplerFallback: () => Promise<IPreparedPopplerPdf>;
    extractionDpi: number;
    tesseractThreads: number;
    pageSizeByNumber: Map<number, IOcrPageSizeInches>;
    pageSourceDpiByNumber: Map<number, number>;
    options: IOcrSearchablePdfOptions;
    checkpointDir: string;
    checkpointPage: (pageNumber: number) => Promise<void>;
    popplerEnv?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    storageBudget: TOcrJobStorageBudget;
    trackTempFile: (path: string) => string;
}

async function readPageCheckpoint(
    page: IOcrPdfPageRequest,
    context: IOcrPageProcessingContext,
    checkpointJsonPath: string,
    checkpointPdfPath: string,
): Promise<IOcrPageProcessingResult | null> {
    try {
        const checkpoint = JSON.parse(await readFile(checkpointJsonPath, 'utf8')) as {
            version?: number;
            pageData?: IOcrPageWithWords;
            effectiveDpi?: number;
            diagnostics?: IOcrDiagnostic[];
            pdfSize?: number;
            pdfSha256?: string;
        };
        const checkpointPdfStat = await stat(checkpointPdfPath);
        if (
            checkpoint.version === 4
            && checkpointPdfStat.size > 0
            && checkpointPdfStat.size === checkpoint.pdfSize
            && await sha256OcrFile(checkpointPdfPath, context.signal) === checkpoint.pdfSha256
            && checkpoint.pageData?.pageNumber === page.pageNumber
            && checkpoint.pageData.imageWidth > 0
            && checkpoint.pageData.imageHeight > 0
            && typeof checkpoint.effectiveDpi === 'number'
            && checkpoint.effectiveDpi > 0
        ) {
            await context.checkpointPage(page.pageNumber);
            return {
                pageData: checkpoint.pageData,
                pdfPath: checkpointPdfPath,
                effectiveDpi: checkpoint.effectiveDpi,
                diagnostics: checkpoint.diagnostics ?? [],
            };
        }
    } catch {
        // Missing or invalid checkpoints are recomputed.
    }
    await Promise.all([
        rm(checkpointJsonPath, {force: true}),
        rm(checkpointPdfPath, {force: true}),
    ]).catch(() => undefined);
    return null;
}

async function processOcrPage(
    page: IOcrPdfPageRequest,
    context: IOcrPageProcessingContext,
): Promise<IOcrPageProcessingResult> {
    const {
        paths,
        log,
    } = context;
    const checkpointJsonPath = join(context.checkpointDir, `page-${page.pageNumber}.json`);
    const checkpointPdfPath = join(context.checkpointDir, `page-${page.pageNumber}.pdf`);
    const checkpointed = await readPageCheckpoint(page, context, checkpointJsonPath, checkpointPdfPath);
    if (checkpointed) {
        return checkpointed;
    }
    log('debug', 'Processing OCR page', {pageNumber: page.pageNumber});

    const pageImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}.png`));
    const pageSizeProbeImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-size-probe.png`));
    const preprocessedImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.png`));
    const preprocessMetadataPath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.json`));
    let ocrOutputPath: string | null = null;
    let lease: IJobBrokerLease | null = null;
    const diagnostics: IOcrDiagnostic[] = [];

    try {
        // Without a native page size the lease and raster guard would guess.
        const pageSize = context.pageSizeByNumber.get(page.pageNumber)
            ?? await probeOcrPageSizeInches(paths, log, page.pageNumber, {
                ...context,
                popplerSourcePdfPath: context.getPopplerSourcePdfPath(),
            }, pageSizeProbeImagePath);
        lease = await acquireOcrPageLease(context.jobId, page.pageNumber, context.extractionDpi, pageSize, context.signal);
        throwIfAborted(context.signal);
        const pageSourceDpi = context.pageSourceDpiByNumber.get(page.pageNumber);
        const effectiveDpi = Math.min(context.extractionDpi, pageSourceDpi ?? context.extractionDpi);
        if (effectiveDpi < context.extractionDpi) {
            log('debug', 'Reduced OCR render DPI', {
                pageNumber: page.pageNumber,
                requestedDpi: context.extractionDpi,
                effectiveDpi,
            });
            diagnostics.push({
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'info',
                pageNumber: requirePageNumber(page.pageNumber),
                message: `Used ${effectiveDpi} DPI instead of ${context.extractionDpi} DPI to avoid upscaling the embedded page image`,
            });
        }

        await renderOcrPageToPng([
            paths,
            log,
            page.pageNumber,
            context.getPopplerSourcePdfPath(),
            pageImagePath,
            effectiveDpi,
            context.popplerEnv,
            context.signal,
            undefined,
            pageSize === undefined ? undefined : createOcrRasterRenderLimits(pageSize, effectiveDpi),
        ], context.preparePopplerFallback);
        await context.storageBudget.assertWithinBudget();

        const dims = await readPngDimensions(pageImagePath);
        let ocrImagePath = pageImagePath;
        let preprocessInverse: number[][] | undefined;
        if (context.options.preprocessingMode === 'clean' || context.options.preprocessingMode === 'off') {
            const candidateOcrImage = await tryPreprocessOcrImage(
                pageImagePath,
                preprocessedImagePath,
                log,
                context.signal,
                diagnostic => diagnostics.push({
                    ...diagnostic,
                    pageNumber: requirePageNumber(page.pageNumber),
                }),
                paths.scanCleanupBinary,
                preprocessMetadataPath,
                effectiveDpi,
                context.options.preprocessingMode === 'off' ? 'polarity-only' : 'clean',
            );
            if (candidateOcrImage.path !== pageImagePath) {
                const candidateDims = await readPngDimensions(candidateOcrImage.path);
                if (candidateDims.width === dims.width && candidateDims.height === dims.height) {
                    ocrImagePath = candidateOcrImage.path;
                    preprocessInverse = candidateOcrImage.inverseTransform?.matrix;
                } else {
                    const rawSize = `${dims.width}x${dims.height}`;
                    const cleanSize = `${candidateDims.width}x${candidateDims.height}`;
                    log('warn', 'OCR preprocessing changed image dimensions', {
                        pageNumber: page.pageNumber,
                        rawSize,
                        cleanSize,
                        action: 'using raw page render to preserve text-layer alignment',
                    });
                    diagnostics.push({
                        code: 'OCR_PREPROCESSING_GEOMETRY_CHANGED',
                        severity: 'warning',
                        pageNumber: requirePageNumber(page.pageNumber),
                        message: `Preprocessing changed image dimensions from ${rawSize} to ${cleanSize}; used raw render to preserve alignment`,
                    });
                }
            }
        }
        await context.storageBudget.assertWithinBudget();
        const ocrResult = await runOcrFileBased(
            ocrImagePath,
            page.languages,
            dims.width,
            dims.height,
            effectiveDpi,
            paths.tesseractBinary,
            paths.tessdataPath,
            context.tesseractThreads,
            context.signal,
            context.options,
        );

        if (!ocrResult.success || !ocrResult.pageData || !ocrResult.pdfPath) {
            await context.storageBudget.assertFailureWithinBudget(ocrResult.error);
            return {error: `Page ${page.pageNumber}: ${ocrResult.error ?? 'Unknown OCR error'}`};
        }
        ocrOutputPath = context.trackTempFile(ocrResult.pdfPath);
        await context.storageBudget.assertWithinBudget();

        if (ocrResult.unsupportedOptions) {
            const rejected = ocrResult.unsupportedOptions.join(', ');
            log('warn', 'Tesseract rejected OCR options', {
                pageNumber: page.pageNumber,
                rejectedOptions: rejected,
                action: 'selected recognition mode was not fully applied',
            });
            diagnostics.push({
                code: 'OCR_ENGINE_OPTION_UNSUPPORTED',
                severity: 'warning',
                pageNumber: requirePageNumber(page.pageNumber),
                message: `The OCR engine rejected ${rejected}; the selected recognition mode was not fully applied`,
            });
        }

        const pageData: IOcrPageWithWords = {
            pageNumber: page.pageNumber,
            words: mapOcrWordsThroughInverseTransform(ocrResult.pageData.words, preprocessInverse),
            text: ocrResult.pageData.text,
            imageWidth: ocrResult.pageData.imageWidth,
            imageHeight: ocrResult.pageData.imageHeight,
        };
        await persistOcrPageCheckpoint({
            checkpointJsonPath,
            checkpointPdfPath,
            checkpointData: {
                pageData,
                ...(preprocessInverse === undefined ? {} : {preprocessInverse}),
                effectiveDpi,
                diagnostics,
            },
            pageNumber: page.pageNumber,
            sha256File: path => sha256OcrFile(path, context.signal),
            signal: context.signal,
            sourcePdfPath: ocrResult.pdfPath,
            storageBudget: context.storageBudget,
        });
        await context.checkpointPage(page.pageNumber);
        return {
            pageData,
            pdfPath: checkpointPdfPath,
            effectiveDpi,
            diagnostics,
        };
    } catch (err) {
        if (isOcrStorageFailure(err)) {
            throw context.storageBudget.fail(err);
        }
        if (isAbortError(err) || context.signal.aborted) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log('warn', 'Failed to process OCR page', {
            pageNumber: page.pageNumber,
            error: errMsg,
        });
        return {error: `Failed to process page ${page.pageNumber}: ${errMsg}`};
    } finally {
        lease?.release();
        await Promise.all([
            rm(pageImagePath, {force: true}),
            rm(preprocessedImagePath, {force: true}),
            rm(preprocessMetadataPath, {force: true}),
            ...(ocrOutputPath === null ? [] : [rm(ocrOutputPath, {force: true})]),
        ]).catch(() => undefined);
    }
}

export async function processOcrPages(
    targetPages: readonly IOcrPdfPageRequest[],
    concurrency: number,
    context: IOcrPageProcessingContext,
    onPageDone: (page: IOcrPdfPageRequest, processedCount: number) => void = () => undefined,
) {
    const errors: string[] = [];
    const diagnostics: IOcrDiagnostic[] = [];
    let successfulPageCount = 0;
    let effectiveRenderDpi = context.extractionDpi;
    let processedCount = 0;
    let nextPageIndex = 0;

    const runLane = async () => {
        while (nextPageIndex < targetPages.length) {
            const page = targetPages[nextPageIndex]!;
            nextPageIndex += 1;
            const result = await processOcrPage(page, context);
            if (result.error) {
                errors.push(result.error);
            }
            if (result.pageData && result.pdfPath) {
                successfulPageCount += 1;
            }
            if (typeof result.effectiveDpi === 'number') {
                effectiveRenderDpi = Math.min(effectiveRenderDpi, result.effectiveDpi);
            }
            if (diagnostics.length < MAX_JOB_DIAGNOSTICS) {
                diagnostics.push(...(result.diagnostics ?? []).slice(0, MAX_JOB_DIAGNOSTICS - diagnostics.length));
            }
            processedCount += 1;
            onPageDone(page, processedCount);
        }
    };
    const lanes = await Promise.allSettled(Array.from(
        {length: Math.min(concurrency, targetPages.length)},
        () => runLane(),
    ));
    const failedLane = lanes.find(lane => lane.status === 'rejected');
    if (failedLane?.status === 'rejected') throw failedLane.reason;

    return {
        errors,
        successfulPageCount,
        effectiveRenderDpi,
        diagnostics,
    };
}

function logPopplerEnvironment(log: TWorkerLog, popplerEnv?: NodeJS.ProcessEnv) {
    if (popplerEnv) {
        log('debug', 'Poppler environment configured', {
            popplerDataDir: popplerEnv.POPPLER_DATADIR?.length ? popplerEnv.POPPLER_DATADIR : 'unset',
            fontConfigPath: popplerEnv.FONTCONFIG_PATH?.length ? popplerEnv.FONTCONFIG_PATH : 'unset',
            fontConfigFile: popplerEnv.FONTCONFIG_FILE?.length ? popplerEnv.FONTCONFIG_FILE : 'unset',
        });
        return;
    }
    if (process.platform === 'win32') {
        log('warn', 'Poppler environment paths unavailable', {
            platform: process.platform,
            impact: 'Windows builds may crash if Poppler runtime assets are missing',
        });
    }
}

type TOcrPlanContext = Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads' | 'pageSizeByNumber' | 'pageSourceDpiByNumber'>;

async function buildOcrPageProcessingPlan(
    pages: IOcrPdfPageRequest[],
    popplerSourcePdfPath: string,
    renderDpi: number | undefined,
    baseContext: TOcrPlanContext,
    sendStage: (phase: TOcrProgressPhase) => void,
): Promise<{
    concurrency: number;
    pageSizeProbe: TOcrPageSizeProbeResult;
    pageContext: IOcrPageProcessingContext;
}> {
    const {
        paths,
        log,
    } = baseContext;
    sendStage('dpi-inspection');
    const detectedSourceDpi = renderDpi === undefined
        ? await detectSourceDpiDetails(
            popplerSourcePdfPath,
            paths.pdfimagesBinary,
            log,
            baseContext.popplerEnv,
            baseContext.signal,
            pages.map(page => page.pageNumber),
        )
        : null;
    const detectedDpi = detectedSourceDpi?.documentDpi ?? renderDpi;
    const pageSourceDpiByNumber = new Map<number, number>();
    if (detectedSourceDpi !== null) {
        for (const page of pages) {
            const raster = await detectedSourceDpi.getPageRaster(page.pageNumber);
            if (raster !== undefined) pageSourceDpiByNumber.set(page.pageNumber, raster.dpi);
        }
    }
    const extractionDpi = clampDpi(detectedDpi ?? 300);
    const concurrency = getOcrConcurrency(pages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);
    sendStage('page-size-probing');
    const pageSizeProbe = await readOcrPdfPageSizesInches({
        pdfPath: popplerSourcePdfPath,
        ...(paths.pdfPageOpsBinary ? {pdfPageOpsBinary: paths.pdfPageOpsBinary} : {}),
        qpdfBinary: paths.qpdfBinary,
        tempDir: paths.tempDir,
        pageNumbers: pages.map(page => page.pageNumber),
        signal: baseContext.signal,
        log,
    });

    if (pageSizeProbe.status === 'degraded' && pageSizeProbe.reason === 'native-tool-failed') {
        const prepared = await baseContext.preparePopplerFallback();
        if (prepared.pdfPath !== popplerSourcePdfPath) {
            return buildOcrPageProcessingPlan(pages, prepared.pdfPath, renderDpi, baseContext, sendStage);
        }
    }

    log('debug', 'OCR page processing plan ready', {
        pages: pages.length,
        dpi: extractionDpi,
        concurrency,
        threads: tesseractThreads,
    });

    return {
        concurrency,
        pageSizeProbe,
        pageContext: {
            ...baseContext,
            extractionDpi,
            tesseractThreads,
            pageSizeByNumber: pageSizeProbe.pageSizes,
            pageSourceDpiByNumber,
        },
    };
}

function getFirstSelectionPage(selection: TOcrPdfPageSelection) {
    if (Array.isArray(selection)) {
        return selection[0]?.pageNumber ?? 0;
    }
    switch (selection.kind) {
        case 'all':
            return 1;
        case 'range':
            return selection.firstPage;
        case 'ranges':
            return selection.ranges[0]?.firstPage ?? 0;
        case 'pages':
            return selection.pages[0]?.pageNumber ?? 0;
    }
}

export async function runOcrJob(job: IOcrJob): Promise<TOcrJobResult> {
    const {
        paths,
        signal,
        sourcePdfPath,
        documentRevision,
        options,
        log,
    } = job;
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();
    const jobWarnings: string[] = [];
    const jobErrors: string[] = [];
    const jobDiagnostics: IOcrDiagnostic[] = [];
    let omittedMessageCount = 0;
    let tempFileTrackingOverflow = false;
    let durableManifest: Awaited<ReturnType<typeof createOcrJobManifestController>> | null = null;
    let storageBudget: TOcrJobStorageBudget | null = null;
    let ownedCheckpointFingerprint: string | null = null;
    const sessionId = `ocr-${randomUUID()}`;
    // The storage budget aborts the job through this controller when disk
    // use crosses its limit.
    const budgetAbort = new AbortController();
    const jobSignal = AbortSignal.any([
        signal,
        budgetAbort.signal,
    ]);

    const trackTempFile = (filePath: string) => {
        if (tempFiles.size < MAX_TRACKED_TEMP_FILES) {
            tempFiles.add(filePath);
        } else {
            tempFileTrackingOverflow = true;
        }
        return filePath;
    };
    const appendMessages = (target: string[], messages: readonly string[]) => {
        const remaining = Math.max(0, MAX_JOB_MESSAGES - target.length);
        target.push(...messages.slice(0, remaining));
        omittedMessageCount += Math.max(0, messages.length - remaining);
    };
    const appendDiagnostics = (diagnostics: readonly IOcrDiagnostic[]) => {
        jobDiagnostics.push(...diagnostics.slice(0, Math.max(0, MAX_JOB_DIAGNOSTICS - jobDiagnostics.length)));
    };

    const requestedSelection = normalizeOcrPageSelection(job.pages);
    const requestedPageCount = getOcrPageSelectionCount(requestedSelection);
    const publish = (currentPage: number, processedCount: number, extra: Pick<IOcrJobProgress, 'phase' | 'phaseProgress'>) => {
        job.publish({
            currentPage,
            processedCount,
            totalPages: requestedPageCount,
            ...extra,
        });
    };

    try {
        const sourceStat = await stat(sourcePdfPath);
        if (sourceStat.size <= 0) {
            throw new Error(`Source PDF is empty: ${sourcePdfPath}`);
        }
        log('debug', 'Processing OCR job', {
            jobId: job.jobId,
            sourcePath: sourcePdfPath,
            pdfBytes: sourceStat.size,
            pages: requestedPageCount,
        });
        const supersessionPolicy = options.supersessionPolicy ?? 'missing-only';
        if (supersessionPolicy === 'replace-all' && options.replaceAllAcknowledged !== true) {
            throw new Error('replace-all OCR requires explicit acknowledgement');
        }

        const checkpointFingerprint = createHash('sha256').update(JSON.stringify({
            sourcePdfPath,
            documentRevision: documentRevision.token,
            pages: requestedSelection,
            options,
        })).digest('hex');
        const checkpointRoot = join(paths.tempDir, 'ocr-checkpoints');
        const useSharedCheckpoint = !activeCheckpointFingerprints.has(checkpointFingerprint);
        if (useSharedCheckpoint) {
            activeCheckpointFingerprints.add(checkpointFingerprint);
            ownedCheckpointFingerprint = checkpointFingerprint;
        }
        const checkpointDir = join(
            checkpointRoot,
            useSharedCheckpoint
                ? checkpointFingerprint
                : `${checkpointFingerprint}-concurrent-${randomUUID()}`,
        );
        await mkdir(checkpointDir, {recursive: true});
        await cleanupStaleOcrJobDirectories(checkpointRoot);
        storageBudget = createOcrJobStorageBudget({
            abortController: budgetAbort,
            checkpointDir,
            sessionId,
            tempDir: paths.tempDir,
        });
        await storageBudget.assertWithinBudget();
        log('debug', 'OCR storage budget', storageBudget.describe());
        durableManifest = await createOcrJobManifestController(checkpointDir, checkpointFingerprint);
        await durableManifest.markNode('model', 'verified');
        await durableManifest.markNode('normalized-source', 'running');
        publish(getFirstSelectionPage(requestedSelection), 0, {phase: 'pdf-prep'});
        let popplerSourcePdfPath = sourcePdfPath;
        const jobStorageBudget = storageBudget;
        let popplerFallback: Promise<IPreparedPopplerPdf> | undefined;
        const preparePopplerFallback = () => popplerFallback ??= (async () => {
            const prepared = await jobStorageBudget.withReservation(
                (await stat(sourcePdfPath)).size,
                () => preparePdfForPoppler(paths, log, sourcePdfPath, sessionId, trackTempFile, jobSignal),
            );
            await jobStorageBudget.assertWithinBudget();
            appendMessages(jobWarnings, prepared.warnings);
            popplerSourcePdfPath = prepared.pdfPath;
            return prepared;
        })();
        await durableManifest.markNode('normalized-source', 'verified');
        const popplerEnv = buildPopplerEnv(paths);
        logPopplerEnvironment(log, popplerEnv);

        let firstCheckpointMarked = false;
        const manifest = durableManifest;
        const planContext: TOcrPlanContext = {
            jobId: job.jobId,
            log,
            sessionId,
            paths,
            getPopplerSourcePdfPath: () => popplerSourcePdfPath,
            preparePopplerFallback,
            signal: jobSignal,
            options,
            checkpointDir,
            // Per-page manifest rewrites are quadratic for a large selection.
            // Page files are the durable source of truth; the manifest keeps
            // a bounded breadcrumb for diagnostics and resume tooling.
            checkpointPage: (pageNumber) => {
                if (firstCheckpointMarked) {
                    return Promise.resolve();
                }
                firstCheckpointMarked = true;
                return manifest.markPageVerified(pageNumber);
            },
            storageBudget,
            trackTempFile,
            ...(popplerEnv === undefined ? {} : {popplerEnv}),
        };
        await durableManifest.markNode('page-raster', 'running');
        await durableManifest.markNode('preprocessed', 'running');
        await durableManifest.markNode('recognized-page', 'running');
        let processedPageCount = 0;
        let successfulPageCount = 0;
        let actualRenderDpi = clampDpi(options.renderDpi ?? 300);
        let pageSizeWarningReported = false;
        let hadTargetPages = false;

        for (const requestBatch of iterateOcrPageRequestBatches(requestedSelection)) {
            throwIfAborted(jobSignal);
            const selection = await selectOcrPagesForSupersession({
                sourcePdfPath,
                pages: requestBatch,
                supersessionPolicy,
                ...(paths.pdftotextBinary ? {pdftotextBinary: paths.pdftotextBinary} : {}),
                qpdfBinary: paths.qpdfBinary,
                log,
                signal: jobSignal,
            });
            appendMessages(jobWarnings, selection.warnings);
            appendDiagnostics(selection.diagnostics);
            const targetPages = selection.pages.map(page => ({
                ...page,
                pageNumber: requirePageNumber(page.pageNumber),
            }));
            const batchOffset = processedPageCount;
            if (targetPages.length === 0) {
                processedPageCount += requestBatch.length;
                publish(requestBatch.at(-1)?.pageNumber ?? 0, processedPageCount, {phase: 'processing'});
                continue;
            }
            hadTargetPages = true;

            const batchFirstPage = targetPages[0]?.pageNumber ?? requestBatch[0]?.pageNumber ?? 0;
            const {
                concurrency,
                pageSizeProbe,
                pageContext,
            } = await buildOcrPageProcessingPlan(
                targetPages,
                popplerSourcePdfPath,
                options.renderDpi,
                planContext,
                phase => publish(batchFirstPage, processedPageCount, {phase}),
            );
            if (pageSizeProbe.status === 'degraded' && !pageSizeWarningReported) {
                appendMessages(jobWarnings, [pageSizeProbe.message]);
                pageSizeWarningReported = true;
            }
            publish(batchFirstPage, batchOffset, {phase: 'processing'});
            const batchResult = await processOcrPages(
                targetPages,
                concurrency,
                pageContext,
                (_page, processed) => publish(
                    getSequentialProgressPage(targetPages, processed),
                    batchOffset + processed,
                    {phase: 'processing'},
                ),
            );
            appendMessages(jobErrors, batchResult.errors);
            appendDiagnostics(batchResult.diagnostics);
            successfulPageCount += batchResult.successfulPageCount;
            actualRenderDpi = Math.min(actualRenderDpi, batchResult.effectiveRenderDpi);
            processedPageCount += requestBatch.length;
            await durableManifest.markPageVerified(targetPages.at(-1)?.pageNumber ?? batchFirstPage);
            publish(requestBatch.at(-1)?.pageNumber ?? batchFirstPage, processedPageCount, {phase: 'processing'});
        }

        await durableManifest.markNode('page-raster', 'verified');
        await durableManifest.markNode('preprocessed', 'verified');
        await durableManifest.markNode('recognized-page', 'verified');
        const completionMessages: string[] = [];
        appendMessages(completionMessages, jobWarnings);
        appendMessages(completionMessages, jobErrors);
        if (omittedMessageCount > 0) {
            completionMessages.push(`${omittedMessageCount} OCR diagnostic message(s) omitted from the completion payload`);
        }
        log('debug', 'OCR recognition finished', {
            successfulPages: successfulPageCount,
            requestedPages: requestedPageCount,
            errors: jobErrors.length,
            renderDpi: actualRenderDpi,
        });
        const lastPage = getLastOcrSelectionPage(requestedSelection);
        publish(lastPage, requestedPageCount, {phase: 'processing'});

        if (successfulPageCount === 0) {
            if (!hadTargetPages) {
                return {
                    success: false,
                    errors: [],
                    outcome: 'no-pages-to-process',
                    ...(jobDiagnostics.length === 0 ? {} : {diagnostics: jobDiagnostics}),
                };
            }
            log('error', 'OCR failed to produce searchable output', {errors: completionMessages});
            return {
                success: false,
                errors: completionMessages,
            };
        }

        throwIfAborted(jobSignal);
        publish(getFirstSelectionPage(requestedSelection), 0, {phase: 'merging'});
        await durableManifest.markNode('assembled-document', 'running');
        let mergedPdfPath: string;
        try {
            if (!paths.pdfPageOpsBinary) {
                throw new Error('evb-pdf-page-ops is unavailable');
            }
            const pdfPageOpsBinary = paths.pdfPageOpsBinary;
            mergedPdfPath = await storageBudget.withReservation(
                sourceStat.size,
                () => writeSearchablePdf({
                    pdfPageOpsBinary,
                    qpdfBinary: paths.qpdfBinary,
                    sourcePdfPath,
                    pages: iterateCheckpointPageResults(requestedSelection, checkpointDir, jobSignal),
                    tempDir: paths.tempDir,
                    sessionId,
                    trackTempFile,
                    signal: jobSignal,
                }),
            );
        } catch (mergeError) {
            if (isAbortError(mergeError) || jobSignal.aborted || isOcrStorageFailure(mergeError)) {
                throw mergeError;
            }
            await durableManifest.setTerminal('failed');
            return {
                success: false,
                errors: [
                    ...completionMessages,
                    `Failed to merge OCR'd pages with original PDF: ${getErrorMessage(mergeError)}`,
                ],
            };
        }
        await storageBudget.assertWithinBudget();
        await durableManifest.markNode('assembled-document', 'verified');

        throwIfAborted(jobSignal);
        const resultSha256 = await sha256OcrFile(mergedPdfPath, jobSignal);
        await durableManifest.markNode('verified-result', 'verified');
        publish(lastPage, requestedPageCount, {
            phase: 'indexing',
            phaseProgress: 100,
        });

        keepFiles.add(mergedPdfPath);
        await durableManifest.setTerminal('completed');
        return {
            success: true,
            pdfPath: mergedPdfPath,
            sourceDocumentRevisionToken: documentRevision.token,
            resultSha256,
            requiresCleanupAck: true,
            errors: completionMessages,
            diagnostics: jobDiagnostics,
        };
    } catch (caughtError) {
        const error = storageBudget?.violation
            ?? (storageBudget && isOcrStorageFailure(caughtError)
                ? storageBudget.fail(caughtError)
                : caughtError);
        if (signal.aborted) {
            await durableManifest?.setTerminal('cancelled').catch(() => undefined);
            throw error;
        }
        const errMsg = getErrorMessage(error);
        log('error', 'Critical OCR job failure', {
            jobId: job.jobId,
            error: errMsg,
        });
        await durableManifest?.setTerminal('failed').catch(() => undefined);
        return {
            success: false,
            errors: [`Critical error: ${errMsg}`],
        };
    } finally {
        await storageBudget?.stop();
        if (ownedCheckpointFingerprint) {
            activeCheckpointFingerprints.delete(ownedCheckpointFingerprint);
        }
        await cleanupOcrTempFiles(
            tempFiles,
            keepFiles,
            tempFileTrackingOverflow,
            paths.tempDir,
            sessionId,
        );
    }
}
