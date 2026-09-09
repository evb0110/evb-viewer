/**
 * OCR Worker Thread
 *
 * This worker handles all heavy OCR processing off the main Electron thread,
 * preventing UI freezing during long-running OCR operations.
 *
 * Communication protocol:
 * - Receives: { type: 'start', jobId, data: { sourcePdfPath, pages, renderDpi } }
 * - Receives: { type: 'cancel', jobId }
 * - Sends: { type: 'progress', jobId, progress: {...} }
 * - Sends: { type: 'complete', jobId, result: {...} }
 * - Sends: { type: 'log', level, message }
 */

import {
    parentPort,
    workerData,
} from 'worker_threads';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    mkdir,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { join } from 'path';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrErrorEnvelope,
    IOcrSearchablePdfOptions,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '@electron/utils/concurrency';
import type {
    TOcrWorkerCompleteResult,
    IOcrWorkerLogMessage,
    TOcrWorkerOutboundMessage,
    IOcrPageWithWords,
    IOcrPageGeometry,
    IOcrPageProcessingResult,
    IOcrPageTerminationUnproven,
    IOcrPdfPageRequest,
    TOcrPdfPageSelection,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import { detectSourceDpiDetails } from '@electron/pdf/sourceDpiDetection';
import { clampDpi } from '@electron/image/imageDpi';
import {
    getPngDimensionsFromFile,
    runOcrFileBased,
} from '@electron/features/ocr/worker/tesseractRunner';
import { tryPreprocessOcrImage } from '@electron/features/ocr/worker/tryPreprocessOcrImage';
import {
    assembleSearchablePdf,
    getPageCount,
} from '@electron/features/ocr/worker/pdfAssembler';
import type {TOcrPageEntryValue} from '@electron/features/ocr/worker/pdfAssembler';
import {
    parseInvalidOcrWorkerStartMessage,
    parseOcrWorkerInboundMessage,
} from '@electron/features/ocr/worker/inboundMessage';
import { resolveWorkerPaths } from '@electron/features/ocr/worker/resolveWorkerPaths';
import {
    buildPopplerEnv,
    createOcrRasterRenderLimits,
    preparePdfForPoppler,
    probeOcrPageSizeInches,
    renderPdfPageToPng,
} from '@electron/features/ocr/worker/popplerStage';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import {
    buildOcrErrorEnvelope,
    getOcrPageSelectionCount,
    iterateOcrPageRequestBatches,
} from '@electron/features/ocr/contracts';
import {selectOcrPagesForSupersession} from '@electron/features/ocr/worker/selectOcrPagesForSupersession';
import {sha256OcrFile} from '@electron/features/ocr/worker/sha256OcrFile';
import {
    readOcrPdfPageSizesInches,
    type IOcrPageSizeInches,
} from '@electron/features/ocr/worker/pdfPageSizeProbe';
import {
    cleanupStaleOcrJobDirectories,
    createOcrJobManifestController,
} from '@electron/features/ocr/worker/ocrJobManifest';
import {
    createOcrJobStorageBudget,
    isOcrStorageFailure,
    type TOcrJobStorageBudget,
} from '@electron/features/ocr/worker/ocrJobStorageBudget';
import {cleanupOcrTempFiles} from '@electron/features/ocr/worker/cleanupOcrTempFiles';
import {persistOcrPageCheckpoint} from '@electron/features/ocr/worker/persistOcrPageCheckpoint';
import {
    getLastOcrSelectionPage,
    getOcrSelectionLanguages,
    iterateCheckpointPageData,
    iterateCheckpointPdfEntries,
    normalizeOcrPageSelection,
} from '@electron/features/ocr/worker/ocrPageSelectionStream';
import {writeOcrIndexes} from '@electron/ocr/worker/writeOcrIndexes';
import {
    createRequestId,
    requireRequestId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';
import {
    createOcrNativeChildRegistrationProvider,
    getOcrNativeChildRegistrationProvider,
    setOcrNativeChildRegistrationProvider,
} from '@electron/features/ocr/worker/nativeChildRegistration';

const initialWorkerData: unknown = workerData;
const paths = resolveWorkerPaths(initialWorkerData);
const activeJobControllers = new Map<TJobId, AbortController>();
const activeSharedCheckpointFingerprints = new Set<string>();
const OCR_RESOURCE_ACQUIRE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_RESOURCE_ACQUIRE_TIMEOUT_MS ?? '30000', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 30_000;
    }
    return Math.min(Math.max(parsed, 1_000), 120_000);
})();
interface IOcrResourceSlotLease {
    token: string;
    effectiveDpi: number;
}
const pendingResourceAcquires = new Map<TRequestId, {
    resolve: (lease: IOcrResourceSlotLease) => void;
    reject: (error: Error) => void;
}>();
export const OCR_WORKER_PAGE_BATCH_SIZE = 5_000;

const log: TWorkerLog = (level, message) => {
    const timestamp = new Date().toISOString();
    const payload: IOcrWorkerLogMessage = {
        type: 'log',
        level,
        message: `[${timestamp}] [ocr-worker] ${message}`,
    };
    parentPort?.postMessage(payload);
};

function sendProgress(
    jobId: TJobId,
    currentPage: number,
    processedCount: number,
    totalPages: number,
    options: {
        phase?: TOcrProgressPhase;
        phaseProgress?: number;
    } = {},
) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'progress',
        jobId,
        progress: {
            requestId: requireRequestId(jobId),
            currentPage,
            processedCount,
            totalPages,
            ...options,
        },
    };
    parentPort?.postMessage(payload);
}

function sendStageProgress(
    jobId: TJobId,
    selection: TOcrPdfPageSelection,
    phase: TOcrProgressPhase,
) {
    const firstPage = Array.isArray(selection)
        ? selection[0]?.pageNumber ?? 0
        : selection.kind === 'all'
            ? 1
            : selection.kind === 'range'
                ? selection.firstPage
                : selection.kind === 'ranges'
                    ? selection.ranges[0]?.firstPage ?? 0
                    : selection.pages[0]?.pageNumber ?? 0;
    sendProgress(
        jobId,
        firstPage,
        0,
        getOcrPageSelectionCount(selection),
        { phase },
    );
}

function sendComplete(jobId: TJobId, result: TOcrWorkerCompleteResult) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'complete',
        jobId,
        result,
    };
    parentPort?.postMessage(payload);
}

function sendCleanupComplete(jobId: TJobId) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'cleanup-complete',
        jobId,
    };
    parentPort?.postMessage(payload);
}

async function acquireOcrResourceSlot(
    jobId: TJobId,
    pageNumber: number,
    requestedDpi: number,
    pageSizeInches: IOcrPageSizeInches | undefined,
    signal: AbortSignal,
) {
    const requestId = createRequestId('ocr-resource');
    const payload: Extract<TOcrWorkerOutboundMessage, {type: 'resource-acquire'}> = {
        type: 'resource-acquire',
        jobId,
        requestId,
        pageNumber,
        requestedDpi,
        ...(pageSizeInches === undefined ? {} : {
            pageWidthIn: pageSizeInches.width,
            pageHeightIn: pageSizeInches.height,
        }),
    };

    throwIfAborted(signal);
    const leasePromise = new Promise<IOcrResourceSlotLease>((resolve, reject) => {
        pendingResourceAcquires.set(requestId, {
            resolve,
            reject,
        });
    });

    const timeout = setTimeout(() => {
        const pending = pendingResourceAcquires.get(requestId);
        pendingResourceAcquires.delete(requestId);
        pending?.reject(new Error(`OCR resource acquire timed out after ${OCR_RESOURCE_ACQUIRE_TIMEOUT_MS}ms`));
    }, OCR_RESOURCE_ACQUIRE_TIMEOUT_MS);
    timeout.unref();

    const abortListener = () => {
        const pending = pendingResourceAcquires.get(requestId);
        pendingResourceAcquires.delete(requestId);
        pending?.reject(signal.reason instanceof Error
            ? signal.reason
            : new Error('OCR job aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
    parentPort?.postMessage(payload);

    try {
        return await leasePromise;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortListener);
        pendingResourceAcquires.delete(requestId);
    }
}

function releaseOcrResourceSlot(jobId: TJobId, token: string) {
    const payload: TOcrWorkerOutboundMessage = {
        type: 'resource-release',
        jobId,
        token,
    };
    parentPort?.postMessage(payload);
}

function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('OCR job aborted');
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
    const row0 = matrix[0];
    const row1 = matrix[1];
    const row2 = matrix[2];
    if (!row0 || !row1 || !row2 || row0.length < 3 || row1.length < 3 || row2.length < 3) {
        throw new Error('OCR preprocessing inverse transform is not a 3x3 matrix');
    }
    const validatedMatrix = [
        row0,
        row1,
        row2,
    ] as [
        [number, number, number],
        [number, number, number],
        [number, number, number],
    ];
    return words.map(word => {
        const corners = [
            [
                word.x,
                word.y,
            ],
            [
                word.x + word.width,
                word.y,
            ],
            [
                word.x,
                word.y + word.height,
            ],
            [
                word.x + word.width,
                word.y + word.height,
            ],
        ].map(([
            x,
            y,
        ]) => {
            const pointX = x!;
            const pointY = y!;
            const w = validatedMatrix[2][0] * pointX + validatedMatrix[2][1] * pointY + validatedMatrix[2][2];
            const mappedX = (validatedMatrix[0][0] * pointX + validatedMatrix[0][1] * pointY + validatedMatrix[0][2]) / w;
            const mappedY = (validatedMatrix[1][0] * pointX + validatedMatrix[1][1] * pointY + validatedMatrix[1][2]) / w;
            if (!Number.isFinite(mappedX) || !Number.isFinite(mappedY)) {
                throw new Error(`OCR preprocessing produced a non-finite inverse-mapped word: ${word.text}`);
            }
            return [
                mappedX,
                mappedY,
            ] as const;
        });
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

interface IOcrPageProcessingContext {
    jobId: TJobId;
    sessionId: string;
    popplerSourcePdfPath: string;
    extractionDpi: number;
    tesseractThreads: number;
    pageSizeByNumber: Map<number, IOcrPageSizeInches>;
    pageSourceDpiByNumber: Map<number, number>;
    preprocessInverseByPageNumber?: Map<number, IOcrPageGeometry['preprocessInverseTransform']>;
    options: IOcrSearchablePdfOptions;
    checkpointDir: string;
    checkpointPage: (pageNumber: number) => Promise<void>;
    popplerEnv?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    storageBudget: TOcrJobStorageBudget;
    trackTempFile: (path: string) => string;
    retainTempFile?: (path: string) => void;
}

type TOcrPageProcessingResult = IOcrPageProcessingResult;

async function processOcrPage(
    page: IOcrPdfPageRequest,
    context: IOcrPageProcessingContext,
) {
    const checkpointJsonPath = join(context.checkpointDir, `page-${page.pageNumber}.json`);
    const checkpointPdfPath = join(context.checkpointDir, `page-${page.pageNumber}.pdf`);
    try {
        const checkpoint = JSON.parse(await readFile(checkpointJsonPath, 'utf8')) as {
            version?: number;
            pageData?: IOcrPageWithWords;
            effectiveDpi?: number;
            diagnostics?: IOcrDiagnostic[];
            pageGeometry?: IOcrPageGeometry;
            pdfSize?: number;
            pdfSha256?: string;
        };
        const checkpointPdfStat = await stat(checkpointPdfPath);
        if (
            checkpoint.version === 3
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
                checkpointJsonPath,
                checkpointPdfPath,
                effectiveDpi: checkpoint.effectiveDpi,
                diagnostics: checkpoint.diagnostics ?? [],
                ...(checkpoint.pageGeometry === undefined ? {} : {pageGeometry: checkpoint.pageGeometry}),
            };
        }
    } catch {
        // Missing or invalid checkpoints are recomputed.
    }
    await Promise.all([
        rm(checkpointJsonPath, {force: true}),
        rm(checkpointPdfPath, {force: true}),
    ]).catch(() => undefined);
    log('debug', `Processing page ${page.pageNumber}`);

    const pageImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}.png`));
    const pageSizeProbeImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-size-probe.png`));
    const preprocessedImagePath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.png`));
    const preprocessMetadataPath = context.trackTempFile(join(paths.tempDir, `${context.sessionId}-page-${page.pageNumber}-clean.json`));
    let ocrOutputPath: string | null = null;
    let ocrImagePath: string | null = null;
    let resourceToken: string | null = null;
    let terminationUnprovenDetail: string | undefined;
    const diagnostics: IOcrDiagnostic[] = [];

    try {
        // Without a native page size the governor and raster guard would guess.
        const pageSize = context.pageSizeByNumber.get(page.pageNumber)
            ?? await probeOcrPageSizeInches(paths, log, page.pageNumber, context, pageSizeProbeImagePath);
        const resourceLease = await acquireOcrResourceSlot(
            context.jobId,
            page.pageNumber,
            context.extractionDpi,
            pageSize,
            context.signal,
        );
        resourceToken = resourceLease.token;
        const pageSourceDpi = context.pageSourceDpiByNumber.get(page.pageNumber);
        const effectiveDpi = Math.min(resourceLease.effectiveDpi, pageSourceDpi ?? resourceLease.effectiveDpi);
        if (effectiveDpi < context.extractionDpi) {
            const reason = pageSourceDpi !== undefined && pageSourceDpi <= effectiveDpi
                ? 'to avoid upscaling the embedded page image'
                : 'to stay within native resource budget';
            log('debug', `Reduced OCR render DPI for page ${page.pageNumber} from ${context.extractionDpi} to ${effectiveDpi} ${reason}`);
            diagnostics.push({
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'info',
                pageNumber: requirePageNumber(page.pageNumber),
                message: `Used ${effectiveDpi} DPI instead of ${context.extractionDpi} DPI ${reason}`,
            });
        }

        await renderPdfPageToPng(
            paths,
            log,
            page.pageNumber,
            context.popplerSourcePdfPath,
            pageImagePath,
            effectiveDpi,
            context.popplerEnv,
            context.signal,
            undefined,
            pageSize === undefined ? undefined : createOcrRasterRenderLimits(pageSize, effectiveDpi),
        );
        await context.storageBudget.assertWithinBudget();

        const dims = await readPngDimensions(pageImagePath);
        ocrImagePath = pageImagePath;
        let ocrDims = dims;
        if (context.options.preprocessingMode === 'clean') {
            context.preprocessInverseByPageNumber?.delete(page.pageNumber);
            const candidateOcrImage = await tryPreprocessOcrImage(
                paths.unpaperBinary,
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
            );
            if (candidateOcrImage.path !== pageImagePath) {
                const candidateDims = await readPngDimensions(candidateOcrImage.path);
                if (candidateDims.width === dims.width && candidateDims.height === dims.height) {
                    ocrImagePath = candidateOcrImage.path;
                    ocrDims = candidateDims;
                    context.preprocessInverseByPageNumber?.set(page.pageNumber, candidateOcrImage.inverseTransform);
                } else {
                    const rawSize = `${dims.width}x${dims.height}`;
                    const cleanSize = `${candidateDims.width}x${candidateDims.height}`;
                    log('warn', [
                        `OCR preprocessing changed page ${page.pageNumber} image dimensions`,
                        `from ${rawSize} to ${cleanSize};`,
                        'using raw page render to preserve text-layer alignment',
                    ].join(' '));
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
            ocrDims.width,
            ocrDims.height,
            effectiveDpi,
            paths.tesseractBinary,
            paths.tessdataPath,
            context.tesseractThreads,
            context.signal,
            context.options,
        );

        if (!ocrResult.success || !ocrResult.pageData) {
            terminationUnprovenDetail = ocrResult.terminationUnproven;
            await context.storageBudget.assertFailureWithinBudget(ocrResult.error);
            return {
                error: `Page ${page.pageNumber}: ${ocrResult.error ?? 'Unknown OCR error'}`,
                checkpointJsonPath,
                checkpointPdfPath,
                ...(ocrResult.terminationUnproven === undefined ? {} : {terminationUnproven: {
                    pageNumber: page.pageNumber,
                    detail: ocrResult.terminationUnproven,
                } satisfies IOcrPageTerminationUnproven}),
            };
        }
        await context.storageBudget.assertWithinBudget();

        const pageData: IOcrPageWithWords = {
            pageNumber: page.pageNumber,
            words: mapOcrWordsThroughInverseTransform(
                ocrResult.pageData.words,
                context.preprocessInverseByPageNumber?.get(page.pageNumber)?.matrix,
            ),
            text: ocrResult.pageData.text,
            imageWidth: ocrResult.pageData.imageWidth,
            imageHeight: ocrResult.pageData.imageHeight,
        };

        const pageGeometry: IOcrPageGeometry | undefined = pageSize !== undefined
            && typeof pageSize.xPoints === 'number'
            && typeof pageSize.yPoints === 'number'
            && typeof pageSize.widthPoints === 'number'
            && typeof pageSize.heightPoints === 'number'
            && (pageSize.rotation === 0 || pageSize.rotation === 90 || pageSize.rotation === 180 || pageSize.rotation === 270)
            ? {
                xPoints: pageSize.xPoints,
                yPoints: pageSize.yPoints,
                widthPoints: pageSize.widthPoints,
                heightPoints: pageSize.heightPoints,
                rotation: pageSize.rotation,
                rasterWidthPx: ocrResult.pageData.imageWidth,
                rasterHeightPx: ocrResult.pageData.imageHeight,
                ...(context.preprocessInverseByPageNumber?.get(page.pageNumber) === undefined ? {} : {preprocessInverseTransform: context.preprocessInverseByPageNumber.get(page.pageNumber)!}),
            }
            : undefined;

        if (!ocrResult.pdfPath) {
            return {
                pageData,
                error: `Page ${page.pageNumber}: Tesseract did not produce PDF output`,
                checkpointJsonPath,
                checkpointPdfPath,
            };
        }

        ocrOutputPath = context.trackTempFile(ocrResult.pdfPath);
        await persistOcrPageCheckpoint({
            checkpointJsonPath,
            checkpointPdfPath,
            checkpointData: {
                pageData,
                ...(pageGeometry === undefined ? {} : {pageGeometry}),
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
            ...(pageGeometry === undefined ? {} : {pageGeometry}),
            pdfPath: checkpointPdfPath,
            checkpointJsonPath,
            checkpointPdfPath,
            effectiveDpi,
            diagnostics,
        };
    } catch (err) {
        if (isOcrStorageFailure(err)) {
            throw context.storageBudget.fail(err);
        }
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log('warn', `Failed to process page ${page.pageNumber}: ${errMsg}`);
        return {
            error: `Failed to process page ${page.pageNumber}: ${errMsg}`,
            checkpointJsonPath,
            checkpointPdfPath,
        };
    } finally {
        if (terminationUnprovenDetail !== undefined) {
            const tesseractOutputBase = ocrImagePath?.replace(/\.png$/, '');
            for (const artifactPath of [
                pageImagePath,
                pageSizeProbeImagePath,
                preprocessedImagePath,
                preprocessMetadataPath,
                checkpointJsonPath,
                checkpointPdfPath,
                ocrOutputPath,
                ...(tesseractOutputBase === undefined ? [] : [
                    `${tesseractOutputBase}-ocr.tsv`,
                    `${tesseractOutputBase}-ocr.pdf`,
                ]),
            ]) {
                if (artifactPath !== null) {
                    context.retainTempFile?.(artifactPath);
                }
            }
        } else if (resourceToken) {
            releaseOcrResourceSlot(context.jobId, resourceToken);
        }
        if (terminationUnprovenDetail === undefined) {
            await Promise.all([
                rm(pageImagePath, {force: true}),
                rm(preprocessedImagePath, {force: true}),
                rm(preprocessMetadataPath, {force: true}),
                ...(ocrOutputPath === null ? [] : [rm(ocrOutputPath, {force: true})]),
            ]).catch(() => undefined);
        }
    }
}

export async function processOcrPages(
    jobId: TJobId,
    targetPages: readonly IOcrPdfPageRequest[],
    concurrency: number,
    context: IOcrPageProcessingContext,
    progress: {
        processedOffset?: number;
        totalPages?: number;
    } = {},
) {
    let processedCount = 0;
    const processedOffset = progress.processedOffset ?? 0;
    const totalPages = progress.totalPages ?? targetPages.length;

    sendProgress(
        jobId,
        targetPages[0]?.pageNumber ?? 0,
        processedOffset,
        totalPages,
        { phase: 'processing' },
    );

    const errors: string[] = [];
    const ocrPageData: IOcrPageWithWords[] = [];
    const ocrPdfMap = new Map<number, string>();
    const pageResults: Array<{
        pageNumber: number;
        pageDataPath: string;
        pdfPath: string;
        pageGeometry?: IOcrPageGeometry;
        effectiveDpi?: number;
    }> = [];
    let effectiveRenderDpi = context.extractionDpi;
    const diagnostics: IOcrDiagnostic[] = [];
    let terminationUnproven: IOcrPageTerminationUnproven | undefined;
    const MAX_AGGREGATED_DIAGNOSTICS = 10_000;
    let nextPageIndex = 0;

    const aggregateResult = (pageNumber: number, result: TOcrPageProcessingResult) => {
        if (result.error) {
            errors.push(result.error);
        }
        if (result.pageData) {
            ocrPageData.push(result.pageData);
            if (result.pdfPath) {
                ocrPdfMap.set(pageNumber, result.pdfPath);
                pageResults.push({
                    pageNumber,
                    pageDataPath: result.checkpointJsonPath,
                    pdfPath: result.pdfPath,
                    ...(result.pageGeometry === undefined ? {} : {pageGeometry: result.pageGeometry}),
                    ...(typeof result.effectiveDpi === 'number' ? {effectiveDpi: result.effectiveDpi} : {}),
                });
            }
        }
        terminationUnproven ??= result.terminationUnproven;
        if (typeof result.effectiveDpi === 'number') {
            effectiveRenderDpi = Math.min(effectiveRenderDpi, result.effectiveDpi);
        }
        if (diagnostics.length < MAX_AGGREGATED_DIAGNOSTICS) {
            diagnostics.push(...(result.diagnostics ?? []).slice(0, MAX_AGGREGATED_DIAGNOSTICS - diagnostics.length));
        }
    };

    const runWorker = async () => {
        while (nextPageIndex < targetPages.length) {
            if (terminationUnproven !== undefined) {
                return;
            }
            const page = targetPages[nextPageIndex];
            nextPageIndex += 1;
            if (!page) {
                continue;
            }
            const result = await processOcrPage(page, context);
            aggregateResult(page.pageNumber, result);
            processedCount += 1;
            sendProgress(
                jobId,
                getSequentialProgressPage(targetPages as IOcrPdfPageRequest[], processedCount),
                processedOffset + processedCount,
                totalPages,
                { phase: 'processing' },
            );
            if (terminationUnproven !== undefined) {
                return;
            }
        }
    };
    const workerResults = await Promise.allSettled(Array.from(
        {length: Math.min(concurrency, targetPages.length)},
        () => runWorker(),
    ));
    const failedWorker = workerResults.find(result => result.status === 'rejected');
    if (failedWorker?.status === 'rejected') throw failedWorker.reason;

    return {
        errors,
        // Keep the legacy fields for direct callers. They are bounded by the
        // 5,000-page worker window; the job-level path uses pageResults and
        // file-backed checkpoint streams instead of concatenating them.
        ocrPageData: ocrPageData.sort((left, right) => left.pageNumber - right.pageNumber),
        ocrPdfMap,
        pageResults: pageResults.sort((left, right) => left.pageNumber - right.pageNumber),
        successfulPageCount: pageResults.length,
        effectiveRenderDpi,
        diagnostics,
        ...(terminationUnproven === undefined ? {} : {terminationUnproven}),
    };
}

export {iterateCheckpointPageResults} from '@electron/features/ocr/worker/ocrPageSelectionStream';

async function validateSourcePdf(jobId: TJobId, sourcePdfPath: string, pageCount: number) {
    const sourceStat = await stat(sourcePdfPath);
    if (sourceStat.size <= 0) {
        throw new Error(`Source PDF is empty: ${sourcePdfPath}`);
    }
    log('debug', `Processing OCR job ${jobId}: sourcePath=${sourcePdfPath}, pdfBytes=${sourceStat.size}, pages=${pageCount}`);
}

function logPopplerEnvironment(popplerEnv?: NodeJS.ProcessEnv) {
    if (popplerEnv) {
        log(
            'debug',
            `Poppler env: POPPLER_DATADIR=${popplerEnv.POPPLER_DATADIR?.length ? popplerEnv.POPPLER_DATADIR : 'unset'}, FONTCONFIG_PATH=${popplerEnv.FONTCONFIG_PATH?.length ? popplerEnv.FONTCONFIG_PATH : 'unset'}, FONTCONFIG_FILE=${popplerEnv.FONTCONFIG_FILE?.length ? popplerEnv.FONTCONFIG_FILE : 'unset'}`,
        );
        return;
    }

    if (process.platform === 'win32') {
        log('warn', 'Poppler env data/config paths are unavailable; Windows builds may crash if Poppler runtime assets are missing');
    }
}

async function buildOcrPageProcessingPlan(
    pages: IOcrPdfPageRequest[],
    popplerSourcePdfPath: string,
    renderDpi: number | undefined,
    popplerEnv: NodeJS.ProcessEnv | undefined,
    baseContext: Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads' | 'pageSizeByNumber' | 'pageSourceDpiByNumber'>,
    sendStage: (phase: TOcrProgressPhase) => void,
) {
    const targetPages = pages;
    sendStage('dpi-inspection');
    const detectedSourceDpi = renderDpi === undefined
        ? await detectSourceDpiDetails(
            popplerSourcePdfPath,
            paths.pdfimagesBinary,
            log,
            popplerEnv,
            baseContext.signal,
            targetPages.map(page => page.pageNumber),
        )
        : {
            documentDpi: renderDpi,
            pageDpiByNumber: new Map<number, number>(),
        };
    const detectedDpi = detectedSourceDpi.documentDpi;
    const extractionDpi = clampDpi(detectedDpi ?? 300);
    const concurrency = getOcrConcurrency(targetPages.length);
    const tesseractThreads = getTesseractThreadLimit(concurrency);
    sendStage('page-size-probing');
    const pageSizeProbe = await readOcrPdfPageSizesInches({
        pdfPath: popplerSourcePdfPath,
        ...(paths.pdfPageOpsBinary ? {pdfPageOpsBinary: paths.pdfPageOpsBinary} : {}),
        qpdfBinary: paths.qpdfBinary,
        tempDir: paths.tempDir,
        pageNumbers: targetPages.map(page => page.pageNumber),
        signal: baseContext.signal,
        log,
    });

    log('debug', `OCR PDF: pages=${targetPages.length}, dpi=${extractionDpi}, concurrency=${concurrency}, threads=${tesseractThreads}`);

    return {
        targetPages,
        concurrency,
        effectiveRenderDpi: extractionDpi,
        pageSizeProbe,
        pageContext: {
            ...baseContext,
            extractionDpi,
            tesseractThreads,
            pageSizeByNumber: pageSizeProbe.pageSizes,
            pageSourceDpiByNumber: detectedSourceDpi.pageDpiByNumber,
        },
    };
}

function sendEmptyOcrResultFailure(
    jobId: TJobId,
    errors: string[],
    errorEnvelope?: IOcrErrorEnvelope,
) {
    log('error', `OCR failed to produce searchable output. errors=${errors.join(' | ') || 'none'}`);
    sendComplete(jobId, {
        success: false,
        errors,
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    });
}

async function assembleMergedOcrPdf(
    jobId: TJobId,
    sourcePdfPath: string,
    ocrPdfEntries: Map<number, TOcrPageEntryValue> | AsyncIterable<readonly [number, TOcrPageEntryValue]>,
    pageCount: number,
    sessionId: string,
    trackTempFile: (path: string) => string,
    errors: string[],
    signal: AbortSignal,
) {
    try {
        return await assembleSearchablePdf(
            paths.qpdfBinary,
            sourcePdfPath,
            ocrPdfEntries,
            pageCount,
            paths.tempDir,
            sessionId,
            log,
            trackTempFile,
            signal,
        );
    } catch (mergeErr) {
        if (isAbortError(mergeErr) || signal.aborted) {
            throw mergeErr;
        }
        const errMsg = getErrorMessage(mergeErr);
        errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
        sendComplete(jobId, {
            success: false,
            errors,
        });
        return null;
    }
}

async function processOcrJob(
    jobId: TJobId,
    sourcePdfPath: string,
    documentRevision: IDocumentRevisionInfo,
    pages: TOcrPdfPageSelection,
    options: IOcrSearchablePdfOptions = {},
) {
    const abortController = new AbortController();
    activeJobControllers.set(jobId, abortController);
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();
    const jobWarnings: string[] = [];
    const jobErrors: string[] = [];
    const jobDiagnostics: IOcrDiagnostic[] = [];
    const MAX_JOB_MESSAGES = 10_000;
    const MAX_JOB_DIAGNOSTICS = 10_000;
    const MAX_TRACKED_TEMP_FILES = 1_024;
    let omittedMessageCount = 0;
    let sessionId: string | null = null;
    let tempFileTrackingOverflow = false;
    let durableManifest: Awaited<ReturnType<typeof createOcrJobManifestController>> | null = null;
    let storageBudget: TOcrJobStorageBudget | null = null;
    let ownedSharedCheckpointFingerprint: string | null = null;

    const trackTempFile = (filePath: string) => {
        if (tempFiles.size < MAX_TRACKED_TEMP_FILES) {
            tempFiles.add(filePath);
        } else {
            tempFileTrackingOverflow = true;
        }
        return filePath;
    };

    const appendMessages = (target: string[], messages: readonly string[]) => {
        if (target.length >= MAX_JOB_MESSAGES) {
            omittedMessageCount += messages.length;
            return;
        }
        const remaining = MAX_JOB_MESSAGES - target.length;
        target.push(...messages.slice(0, remaining));
        omittedMessageCount += Math.max(0, messages.length - remaining);
    };

    const appendDiagnostics = (diagnostics: readonly IOcrDiagnostic[]) => {
        if (jobDiagnostics.length >= MAX_JOB_DIAGNOSTICS) {
            return;
        }
        const remaining = MAX_JOB_DIAGNOSTICS - jobDiagnostics.length;
        jobDiagnostics.push(...diagnostics.slice(0, remaining));
    };

    try {
        const requestedSelection = normalizeOcrPageSelection(pages);
        const requestedPageCount = getOcrPageSelectionCount(requestedSelection);
        await validateSourcePdf(jobId, sourcePdfPath, requestedPageCount);

        const supersessionPolicy = options.supersessionPolicy ?? 'missing-only';
        if (supersessionPolicy === 'replace-all' && options.replaceAllAcknowledged !== true) {
            throw new Error('replace-all OCR requires explicit acknowledgement');
        }

        const activeSessionId = `ocr-${randomUUID()}`;
        sessionId = activeSessionId;
        const checkpointFingerprint = createHash('sha256').update(JSON.stringify({
            sourcePdfPath,
            documentRevision: documentRevision.token,
            pages: requestedSelection,
            options,
        })).digest('hex');
        const checkpointRoot = join(paths.tempDir, 'ocr-checkpoints');
        const useSharedCheckpoint = !activeSharedCheckpointFingerprints.has(checkpointFingerprint);
        if (useSharedCheckpoint) {
            activeSharedCheckpointFingerprints.add(checkpointFingerprint);
            ownedSharedCheckpointFingerprint = checkpointFingerprint;
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
            abortController,
            checkpointDir,
            sessionId: activeSessionId,
            tempDir: paths.tempDir,
        });
        await storageBudget.assertWithinBudget();
        log('debug', `OCR storage budget: ${JSON.stringify(storageBudget.describe())}`);
        durableManifest = await createOcrJobManifestController(checkpointDir, checkpointFingerprint);
        await durableManifest.markNode('model', 'verified');
        await durableManifest.markNode('normalized-source', 'running');
        sendStageProgress(jobId, requestedSelection, 'pdf-prep');
        const preparedPopplerPdf = await storageBudget.withReservation(
            (await stat(sourcePdfPath)).size,
            () => preparePdfForPoppler(
                paths,
                log,
                sourcePdfPath,
                activeSessionId,
                trackTempFile,
                abortController.signal,
            ),
        );
        await storageBudget.assertWithinBudget();
        const popplerSourcePdfPath = preparedPopplerPdf.pdfPath;
        await durableManifest.markNode('normalized-source', 'verified');
        appendMessages(jobWarnings, preparedPopplerPdf.warnings);
        const popplerEnv = buildPopplerEnv(paths);
        logPopplerEnvironment(popplerEnv);

        let firstCheckpointMarked = false;
        const planOptions: Omit<IOcrPageProcessingContext, 'extractionDpi' | 'tesseractThreads' | 'pageSizeByNumber' | 'pageSourceDpiByNumber'> = {
            sessionId: activeSessionId,
            jobId,
            popplerSourcePdfPath,
            signal: abortController.signal,
            options,
            checkpointDir,
            preprocessInverseByPageNumber: new Map(),
            // Per-page manifest rewrites are quadratic for a large scalar
            // selection. Page files are the durable source of truth; retain a
            // bounded manifest breadcrumb for diagnostics and resume tooling.
            checkpointPage: pageNumber => {
                if (firstCheckpointMarked) {
                    return Promise.resolve();
                }
                firstCheckpointMarked = true;
                return durableManifest!.markPageVerified(pageNumber);
            },
            storageBudget,
            trackTempFile,
            retainTempFile: filePath => keepFiles.add(filePath),
        };
        if (popplerEnv !== undefined) {
            planOptions.popplerEnv = popplerEnv;
        }
        await durableManifest.markNode('page-raster', 'running');
        await durableManifest.markNode('preprocessed', 'running');
        await durableManifest.markNode('recognized-page', 'running');
        let processedPageCount = 0;
        let successfulPageCount = 0;
        let actualRenderDpi = clampDpi(options.renderDpi ?? 300);
        let pageSizeWarningReported = false;
        let hadTargetPages = false;

        for (const requestBatch of iterateOcrPageRequestBatches(requestedSelection)) {
            throwIfAborted(abortController.signal);
            let targetPages = requestBatch;
            const selection = await selectOcrPagesForSupersession({
                sourcePdfPath,
                documentRevisionToken: documentRevision.token,
                pages: requestBatch,
                supersessionPolicy,
                ...(paths.pdftotextBinary ? {pdftotextBinary: paths.pdftotextBinary} : {}),
                qpdfBinary: paths.qpdfBinary,
                log,
                signal: abortController.signal,
            });
            appendMessages(jobWarnings, selection.warnings);
            appendDiagnostics(selection.diagnostics);
            targetPages = selection.pages.map(page => ({
                ...page,
                pageNumber: requirePageNumber(page.pageNumber),
            }));

            if (targetPages.length === 0) {
                processedPageCount += requestBatch.length;
                sendProgress(
                    jobId,
                    requestBatch.at(-1)?.pageNumber ?? 0,
                    processedPageCount,
                    requestedPageCount,
                    {phase: 'processing'},
                );
                continue;
            }
            hadTargetPages = true;

            const batchFirstPage = targetPages[0]?.pageNumber ?? requestBatch[0]?.pageNumber ?? 0;
            const {
                targetPages: plannedPages,
                concurrency,
                pageSizeProbe,
                pageContext,
            } = await buildOcrPageProcessingPlan(
                targetPages,
                popplerSourcePdfPath,
                options.renderDpi,
                popplerEnv,
                planOptions,
                phase => sendProgress(
                    jobId,
                    batchFirstPage,
                    processedPageCount,
                    requestedPageCount,
                    {phase},
                ),
            );
            if (pageSizeProbe.status === 'degraded' && !pageSizeWarningReported) {
                appendMessages(jobWarnings, [pageSizeProbe.message]);
                pageSizeWarningReported = true;
            }
            const batchResult = await processOcrPages(
                jobId,
                plannedPages,
                concurrency,
                pageContext,
                {
                    processedOffset: processedPageCount,
                    totalPages: requestedPageCount,
                },
            );
            appendMessages(jobErrors, batchResult.errors);
            appendDiagnostics(batchResult.diagnostics);
            if (batchResult.terminationUnproven !== undefined) {
                const {
                    pageNumber, detail,
                } = batchResult.terminationUnproven;
                const fatalMessage = `OCR page ${pageNumber} stopped before Tesseract termination was proven: ${detail}`;
                appendMessages(jobErrors, [fatalMessage]);
                await durableManifest.setTerminal('failed').catch(() => undefined);
                sendEmptyOcrResultFailure(
                    jobId,
                    [
                        ...jobWarnings,
                        ...jobErrors,
                    ],
                    buildOcrErrorEnvelope('OCR_INTERNAL_ERROR', fatalMessage, {details: detail}),
                );
                return;
            }
            successfulPageCount += batchResult.successfulPageCount;
            actualRenderDpi = Math.min(actualRenderDpi, batchResult.effectiveRenderDpi);
            processedPageCount += requestBatch.length;
            await durableManifest.markPageVerified(plannedPages.at(-1)?.pageNumber ?? batchFirstPage);
            sendProgress(
                jobId,
                requestBatch.at(-1)?.pageNumber ?? batchFirstPage,
                processedPageCount,
                requestedPageCount,
                {phase: 'processing'},
            );
        }

        await durableManifest.markNode('page-raster', 'verified');
        await durableManifest.markNode('preprocessed', 'verified');
        await durableManifest.markNode('recognized-page', 'verified');
        const completionMessages: string[] = [];
        appendMessages(completionMessages, jobWarnings);
        appendMessages(completionMessages, jobErrors);
        if (omittedMessageCount > 0) {
            appendMessages(completionMessages, [`${omittedMessageCount} OCR diagnostic message(s) omitted from the completion payload`]);
        }

        log('debug', `OCR done. successfulPages=${successfulPageCount}, requestedPages=${requestedPageCount}, errors=${jobErrors.length}, renderDpi=${actualRenderDpi}`);

        sendProgress(
            jobId,
            getLastOcrSelectionPage(requestedSelection),
            requestedPageCount,
            requestedPageCount,
            { phase: 'processing' },
        );

        if (successfulPageCount === 0) {
            if (!hadTargetPages) {
                appendMessages(completionMessages, ['No pages require OCR under the selected text supersession policy']);
            }
            sendEmptyOcrResultFailure(jobId, completionMessages);
            return;
        }

        const pageCountResult = await getPageCount(
            paths.qpdfBinary,
            sourcePdfPath,
            getLastOcrSelectionPage(requestedSelection),
            abortController.signal,
        );
        const pageCount = pageCountResult.pageCount;
        appendMessages(completionMessages, pageCountResult.warnings);

        throwIfAborted(abortController.signal);
        sendStageProgress(jobId, requestedSelection, 'merging');
        await durableManifest.markNode('assembled-document', 'running');
        const mergedPdfPath = await storageBudget.withReservation(
            (await stat(sourcePdfPath)).size,
            () => assembleMergedOcrPdf(
                jobId,
                sourcePdfPath,
                iterateCheckpointPdfEntries(requestedSelection, checkpointDir, abortController.signal),
                pageCount,
                activeSessionId,
                trackTempFile,
                completionMessages,
                abortController.signal,
            ),
        );
        await storageBudget.assertWithinBudget();
        if (!mergedPdfPath) {
            await durableManifest.setTerminal('failed');
            return;
        }
        await durableManifest.markNode('assembled-document', 'verified');

        const allLanguages = getOcrSelectionLanguages(requestedSelection);
        throwIfAborted(abortController.signal);
        const resultSha256 = await sha256OcrFile(mergedPdfPath, abortController.signal);
        sendStageProgress(jobId, requestedSelection, 'indexing');
        await durableManifest.markNode('text-catalog', 'running');
        appendMessages(completionMessages, await writeOcrIndexes({
            sourcePdfPath,
            stagedResultPdfPath: mergedPdfPath,
            resultIdentity: resultSha256,
            documentRevision,
            ocrPageData: iterateCheckpointPageData(
                requestedSelection,
                checkpointDir,
                abortController.signal,
            ),
            successfulPageCount,
            pageCount,
            allLanguages,
            effectiveRenderDpi: actualRenderDpi,
            signal: abortController.signal,
            tempDir: paths.tempDir,
            log,
            storageBudget,
        }));
        await durableManifest.markNode('text-catalog', 'verified');
        await durableManifest.markNode('verified-result', 'verified');
        sendProgress(
            jobId,
            getLastOcrSelectionPage(requestedSelection),
            requestedPageCount,
            requestedPageCount,
            {
                phase: 'indexing',
                phaseProgress: 100,
            },
        );

        keepFiles.add(mergedPdfPath);
        // v4 writes a small authenticated descriptor beside the staged PDF.
        // Keep it with the PDF until the renderer acknowledges both artifacts.
        keepFiles.add(`${mergedPdfPath}.ocr-v4-prepared.json`);
        await durableManifest.setTerminal('completed');
        sendComplete(jobId, {
            success: true,
            pdfPath: mergedPdfPath,
            sourceDocumentRevisionToken: documentRevision.token,
            resultSha256,
            requiresCleanupAck: true,
            errors: completionMessages,
            diagnostics: jobDiagnostics,
        });
    } catch (caughtError) {
        const err = storageBudget?.violation
            ?? (storageBudget && isOcrStorageFailure(caughtError)
                ? storageBudget.fail(caughtError)
                : caughtError);
        const errMsg = getErrorMessage(err);
        if (isAbortError(err)) {
            await durableManifest?.setTerminal('cancelled').catch(() => undefined);
            log('debug', `OCR job ${jobId} aborted: ${errMsg}`);
            sendComplete(jobId, {
                success: false,
                errors: [errMsg],
            });
            return;
        }
        log('error', `CRITICAL ERROR in processOcrJob: ${errMsg}`);
        await durableManifest?.setTerminal('failed').catch(() => undefined);
        sendComplete(jobId, {
            success: false,
            errors: [`Critical error: ${errMsg}`],
        });
    } finally {
        await storageBudget?.stop();
        if (ownedSharedCheckpointFingerprint) {
            activeSharedCheckpointFingerprints.delete(ownedSharedCheckpointFingerprint);
        }
        activeJobControllers.delete(jobId);
        await cleanupOcrTempFiles(
            tempFiles,
            keepFiles,
            tempFileTrackingOverflow,
            paths.tempDir,
            sessionId,
        );
        sendCleanupComplete(jobId);
    }
}

parentPort?.on('message', async (rawMessage: unknown) => {
    const message = parseOcrWorkerInboundMessage(rawMessage);
    if (!message) {
        const invalidStart = parseInvalidOcrWorkerStartMessage(rawMessage);
        if (invalidStart) {
            log('warn', invalidStart.error);
            sendComplete(invalidStart.jobId, {
                success: false,
                errors: [invalidStart.error],
                errorEnvelope: buildOcrErrorEnvelope(
                    'OCR_INVALID_PAYLOAD',
                    invalidStart.error,
                ),
            });
            sendCleanupComplete(invalidStart.jobId);
            parentPort?.close();
            return;
        }

        log('warn', 'Ignoring malformed inbound OCR worker message');
        return;
    }

    switch (message.type) {
        case 'start': {
            const nativeChildRegistrationProvider = createOcrNativeChildRegistrationProvider(
                message.jobId,
                outboundMessage => parentPort?.postMessage(outboundMessage),
            );
            setOcrNativeChildRegistrationProvider(nativeChildRegistrationProvider);
            try {
                await processOcrJob(
                    message.jobId,
                    message.data.sourcePdfPath,
                    message.data.documentRevision,
                    message.data.pages,
                    message.data.options ?? (message.data.renderDpi !== undefined ? {renderDpi: message.data.renderDpi} : {}),
                );
            } finally {
                if (getOcrNativeChildRegistrationProvider() === nativeChildRegistrationProvider) {
                    setOcrNativeChildRegistrationProvider(null);
                }
                parentPort?.close();
            }
            return;
        }
        case 'cancel':
            activeJobControllers.get(message.jobId)?.abort();
            return;
        case 'native-child-intent-ack':
        case 'native-child-register-ack':
        case 'native-child-exit-ack':
            getOcrNativeChildRegistrationProvider()?.handleMessage(message);
            return;
        case 'resource-acquired': {
            const pending = pendingResourceAcquires.get(message.requestId);
            if (!pending) {
                releaseOcrResourceSlot(message.jobId, message.token);
                return;
            }
            pending.resolve({
                token: message.token,
                effectiveDpi: message.effectiveDpi,
            });
            return;
        }
        case 'resource-denied': {
            const pending = pendingResourceAcquires.get(message.requestId);
            pendingResourceAcquires.delete(message.requestId);
            pending?.reject(new Error(message.reason));
            return;
        }
    }
});

log('debug', 'OCR worker initialized and ready');
