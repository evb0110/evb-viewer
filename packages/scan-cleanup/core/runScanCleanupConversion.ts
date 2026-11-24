 

import {constants as fsConstants} from 'fs';
import {
    access,
    copyFile,
    link,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import {
    basename,
    dirname,
    join,
} from 'path';
import type {
    INativeScanCleanupInkCalibrationPageV3,
    INativeScanCleanupPageV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupDocumentInkPriorV3,
    TNativeScanCleanupProgressV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {getUnprovenNativeTerminationDetail} from '@contracts/nativeErrors';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';
import {
    resolveSourceDpi,
    type IDetectedPageRaster,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IScanCleanupOutputPageForSummary,
    type IScanCleanupOutputMapping,
    type IScanCleanupProvenanceInputs,
    type IScanCleanupRepresentationReport,
    type IPdfMrcLayers,
    type IPdfPageSize,
    type IScanCleanupRasterRenderLimits,
    type IScanCleanupPageRasterSource,
    type IPdfPageSizeChunk,
    type TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import {
    mapScanCleanupPageScope,
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@evb/scan-cleanup/core/pageBatches';
import {
    computeScanCleanupBatchCheckpointSignature,
    computeScanCleanupCheckpointWitness,
    computeScanCleanupRenderPlanSignature,
    openScanCleanupConversionCheckpoint,
    type IScanCleanupConversionCheckpoint,
    type IScanCleanupPageArtifactInput,
} from '@evb/scan-cleanup/core/conversionCheckpoint';
import {runBoundedRasterProducerConsumer} from '@evb/scan-cleanup/core/streamingRasterHandoff';
import {
    ScanCleanupContractError,
    ScanCleanupInsufficientScratchError,
    ScanCleanupMissingOutputError,
    ScanCleanupNativeToolUnavailableError,
    ScanCleanupPdfValidationError,
    ScanCleanupStreamingEvidenceError,
} from '@evb/scan-cleanup/core/errors';
import {createPdfCombineProgressHandler} from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';
import {
    buildScanCleanupCompactManifest,
    isScanCleanupCliFallbackSentinel,
    serializeLegacyScanCleanupCompactManifest,
    serializeScanCleanupCompactManifest,
} from '@evb/scan-cleanup/core/compactManifest';
import {buildScanCleanupTextLayerPlanFromPageSizeMap} from '@evb/scan-cleanup/core/sourceTextLayer';
import {
    buildScanCleanupStampBuildIds,
    hashScanCleanupNativeBinarySha256s,
} from '@evb/scan-cleanup/core/buildManifest';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    hashScanCleanupBackendMarker,
    materializeScanCleanupStampOptions,
    type IBuildScanCleanupProvenanceStampInput,
    type TScanCleanupProvenanceStamp,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {sha256ScanCleanupFile} from '@evb/scan-cleanup/core/sha256ScanCleanupFile';
import {
    PdfPageSizeStore,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildRunnableNativeScanCleanupManifest';
import {resolveScanCleanupDocumentCanvasRenderDpi} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupPlannedDpi,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    SCAN_CLEANUP_SIZE_PROBE_DPI,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
    resolveSourceMrcLayerRejection,
} from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';
import {
    readPbmDimensions,
    readPgmDimensions,
    readPngDimensions,
    readPpmDimensions,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
    createScanCleanupSummaryWarningReporter,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    estimateRawRasterBytes,
    resolveCombineOutputByteCap,
    resolveScanCleanupCombineEnv,
    resolveRasterHandoff,
    resolveScanCleanupScratchAdmission,
    resolveStreamingRasterHandoffBudget,
    type IScanCleanupRasterHandoffPlan,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {preserveScanCleanupJsonEvidence} from '@evb/scan-cleanup/core/preserveScanCleanupJsonEvidence';
import {runLosslessScanCleanup} from '@evb/scan-cleanup/core/runLosslessScanCleanup';
import {DETECTION_DPI} from '@evb/scan-cleanup/core/detection';
import {SCAN_CLEANUP_RASTER_MAX_PIXELS} from '@evb/scan-cleanup/core/rasterValidation';
import {
    assertScanCleanupInkAnchorCapacity,
    buildBoundedDetectionRequestFields,
    createEmptyPageRasterSource,
    createPageGeometryRasterSource,
    describeScanCleanupFinalPage,
    planScanCleanupFinalPages,
    resolveScanCleanupSourceMrcCandidacy,
    planScanCleanupRunQuality,
    readDetectionResultsForPageNumbers,
    withBoundedDetectionFields,
    type TScanCleanupDocumentCanvas,
    type TScanCleanupFinalPagePlan,
} from '@evb/scan-cleanup/core/scanCleanupConversionPlan';
import {createScanCleanupPageRasterSource} from '@evb/scan-cleanup/core/sourceDpiDetection';
import {createScanCleanupScratchDir} from '@evb/scan-cleanup/core/scratchCleanup';
import {describePageNumbers} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {
    assembleWithCompactSourcePages,
    type IRenderedCleanupOutputPage,
} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
import {
    reportScanCleanupNativeWarnings,
    buildScanCleanupOutputMappings,
    buildScanCleanupRepresentationPage,
    collectScanCleanupPageOutputs,
    describeScanCleanupMixedLayerMismatch,
    planScanCleanupCombinePage,
    resolveCompactSourcePreservation,
    resolveFullSourcePagePreservation,
    resolveScanCleanupMixedLayerExpectation,
    serializeScanCleanupCombinePage,
} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
import {overlayScanCleanupTextLayerAndMeasure} from '@evb/scan-cleanup/core/overlayScanCleanupTextLayerAndMeasure';
import {
    appendJsonLine,
    collectSourceText,
    inspectSkippedScanCleanupSourceText,
    type IScanCleanupSourceTextSink,
    mergeScanCleanupPdfPathSidecar,
    readJsonLines,
} from '@evb/scan-cleanup/core/streamingSidecars';
export {reportScanCleanupNativeWarnings} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupProvenanceInputs,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';


const FALLBACK_MIXED_LAYER_PPM = Uint8Array.from([
    0x50,
    0x36,
    0x0a,
    0x31,
    0x20,
    0x31,
    0x0a,
    0x32,
    0x35,
    0x35,
    0x0a,
    0xff,
    0xff,
    0xff,
]);

// Two output slots retain a composite PNG, a full RGB background and bounded
// bilevel/alpha planes. Six RGB equivalents per source page covers those files
// and their small metadata and encoding overhead conservatively.
const SCAN_CLEANUP_NATIVE_OUTPUT_RASTER_EQUIVALENTS = 6;
// Keep an overflowed per-page output estimate finite while leaving room for a
// complete bounded batch and its fixed merge working set to remain a safe
// integer. A finite estimate lets scratch admission report a real shortfall
// instead of treating the batch as unmeasurable and admitting it.
const SCAN_CLEANUP_UNMEASURABLE_OUTPUT_SCRATCH_BYTES = Math.floor(
    Number.MAX_SAFE_INTEGER / (SCAN_CLEANUP_STREAMING_BATCH_PAGES * 4),
);
const PAGE_GEOMETRY_SIDECAR_FORMAT = 'evb-scan-cleanup-page-geometry';
const PAGE_GEOMETRY_SIDECAR_SCHEMA_VERSION = 1;
// Must match `native/scan-cleanup/src/ink_consistency.rs::MINIMUM_PRIOR_PAGES`.
const MINIMUM_DOCUMENT_INK_PRIOR_PAGES = 12;

const CHECKPOINT_SHA256_HEX_RE = /^[0-9a-f]{64}$/;

async function resolveCheckpointNativeToolIdentity(
    paths: IScanCleanupWorkerPaths,
    hashNativeBinary?: (path: string) => Promise<string>,
): Promise<Record<string, string> | null> {
    const identity: Record<string, string> = {};
    const entries: Array<[string, string | undefined, boolean]> = [
        ['scanCleanup', paths.scanCleanupBinary, false],
        ['pdfImageCombine', paths.pdfImageCombineBinary, true],
        ['pdfPageOps', paths.pdfPageOpsBinary, true],
        ['qpdf', paths.qpdfBinary, false],
        ['pdftoppm', paths.pdftoppmBinary, false],
        ['pdfimages', paths.pdfimagesBinary, false],
    ];
    for (const [
        role,
        toolPath,
        allowsFallbackSentinel,
    ] of entries) {
        if (toolPath === undefined) {
            continue;
        }
        if (allowsFallbackSentinel && isScanCleanupCliFallbackSentinel(toolPath)) {
            const backend = paths.assemblyBackend ?? (
                role === 'pdfPageOps'
                    ? 'cli-fallback-qpdf-page-ops'
                    : 'cli-fallback-wasm-or-img2pdf-qpdf'
            );
            identity[role] = `marker:${hashScanCleanupBackendMarker(role, backend)}`;
            continue;
        }
        try {
            const digest = hashNativeBinary !== undefined
                ? await hashNativeBinary(toolPath)
                : await sha256ScanCleanupFile(toolPath);
            if (!CHECKPOINT_SHA256_HEX_RE.test(digest)) {
                return null;
            }
            identity[role] = `sha256:${digest}`;
        } catch {
            // Never fall back to matching a native binary by file path alone:
            // if a required tool's bytes cannot be verified, disable checkpoint
            // reuse cleanly.
            return null;
        }
    }
    return identity;
}

function collectEligibleInkCalibrationPages(
    pages: readonly INativeScanCleanupPageV3[],
): INativeScanCleanupInkCalibrationPageV3[] {
    const eligible: INativeScanCleanupInkCalibrationPageV3[] = [];
    for (const page of pages) {
        if (
            typeof page.trustedForegroundMaskPath === 'string'
            && typeof page.trustedMrcBackgroundPath === 'string'
            && page.options.outputMode === 'bw'
            && page.options.sourceHasBilevelLayer === true
            && (page.options.thickness ?? 0) === 0
        ) {
            eligible.push({
                sourcePageIndex: page.sourcePageIndex,
                trustedForegroundMaskPath: page.trustedForegroundMaskPath,
                trustedMrcBackgroundPath: page.trustedMrcBackgroundPath,
                maxPixels: page.options.maxPixels,
                maxDimensionPx: page.options.maxDimensionPx,
            });
        }
    }
    return eligible;
}

type TScanCleanupDpiDetails = IScanCleanupPageRasterSource;

function decodePageGeometrySidecarPage(value: unknown, expectedPageNumber: number): IPdfPageSize {
    if (value === null || typeof value !== 'object') {
        throw new Error('Scan cleanup page-geometry sidecar contains a non-object page');
    }
    const page = value as Partial<IPdfPageSize>;
    const {
        pageNumber,
        xPoints,
        yPoints,
        widthPoints,
        heightPoints,
        rotation,
    } = page;
    if (
        pageNumber !== expectedPageNumber
        || !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || !Number.isFinite(xPoints)
        || !Number.isFinite(yPoints)
        || !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || (widthPoints ?? 0) <= 0
        || (heightPoints ?? 0) <= 0
        || !Number.isFinite(rotation)
    ) {
        throw new Error(
            `Scan cleanup page-geometry sidecar has invalid geometry for page ${String(expectedPageNumber)}`,
        );
    }
    // The sidecar is untrusted JSON, so its declared render-box union is a
    // claim to verify rather than a guarantee the compiler may rely on.
    const renderBox: unknown = page.renderBox;
    if (renderBox !== undefined && renderBox !== 'cropbox' && renderBox !== 'mediabox') {
        throw new Error(
            `Scan cleanup page-geometry sidecar has an invalid render box for page ${String(expectedPageNumber)}`,
        );
    }
    return page as IPdfPageSize;
}

async function* readPageGeometrySidecarChunks(
    path: string,
    signal: AbortSignal,
): AsyncGenerator<IPdfPageSizeChunk> {
    let pageCount: number | null = null;
    let expectedPageNumber = 1;
    let chunkIndex = 0;
    let chunkPages: IPdfPageSize[] = [];
    for await (const value of readJsonLines<unknown>(path, signal)) {
        if (pageCount === null) {
            if (
                value === null
                || typeof value !== 'object'
                || (value as {format?: unknown}).format !== PAGE_GEOMETRY_SIDECAR_FORMAT
                || (value as {schemaVersion?: unknown}).schemaVersion !== PAGE_GEOMETRY_SIDECAR_SCHEMA_VERSION
                || !Number.isSafeInteger((value as {pageCount?: unknown}).pageCount)
                || ((value as {pageCount: number}).pageCount) < 1
            ) {
                throw new Error('Scan cleanup page-geometry sidecar has an invalid header');
            }
            pageCount = (value as {pageCount: number}).pageCount;
            continue;
        }
        if (expectedPageNumber > pageCount) {
            throw new Error('Scan cleanup page-geometry sidecar contains too many pages');
        }
        chunkPages.push(decodePageGeometrySidecarPage(value, expectedPageNumber));
        expectedPageNumber += 1;
        if (chunkPages.length >= SCAN_CLEANUP_STREAMING_BATCH_PAGES) {
            yield {
                pageCount,
                chunkIndex,
                firstPageNumber: expectedPageNumber - chunkPages.length,
                offset: 0,
                byteLength: 0,
                pages: chunkPages,
            };
            chunkPages = [];
            chunkIndex += 1;
        }
    }
    if (pageCount === null || expectedPageNumber - 1 !== pageCount) {
        throw new Error('Scan cleanup page-geometry sidecar ended before its declared page count');
    }
    if (chunkPages.length > 0) {
        yield {
            pageCount,
            chunkIndex,
            firstPageNumber: expectedPageNumber - chunkPages.length,
            offset: 0,
            byteLength: 0,
            pages: chunkPages,
        };
    }
}

function createPageSizeStoreFromGeometrySidecar(path: string, signal: AbortSignal) {
    return new PdfPageSizeStore(() => readPageGeometrySidecarChunks(path, signal));
}

/** Build a bounded source from supplied detection metadata without copying all pages. */
function createPageSizeStoreFromMetadata(
    metadataByPage: Partial<Record<string, IScanCleanupSourcePageMetadata>>,
    documentPageCount: number,
) {
    return new PdfPageSizeStore(async function* () {
        // Keep this adapter's execution asynchronous like the native sidecar
        // reader. It consumes supplied detection metadata for bounded runs.
        await Promise.resolve();
        let chunkIndex = 0;
        for (
            let firstPageNumber = 1;
            firstPageNumber <= documentPageCount;
            firstPageNumber += SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ) {
            const pages: IPdfPageSize[] = [];
            const lastPageNumber = Math.min(
                documentPageCount,
                firstPageNumber + SCAN_CLEANUP_STREAMING_BATCH_PAGES - 1,
            );
            for (let pageNumber = firstPageNumber; pageNumber <= lastPageNumber; pageNumber += 1) {
                const page = metadataByPage[String(pageNumber)];
                if (page === undefined) {
                    throw new Error(`Scan cleanup metadata has no geometry for page ${String(pageNumber)}`);
                }
                if (page.pageNumber !== pageNumber) {
                    throw new Error(
                        `Scan cleanup conversion received page geometry out of document order: expected page ${String(pageNumber)} at index ${String(pageNumber - 1)}, received page ${String(page.pageNumber)}`,
                    );
                }
                pages.push(page);
            }
            yield {
                pageCount: documentPageCount,
                chunkIndex,
                firstPageNumber,
                offset: 0,
                byteLength: 0,
                pages,
            };
            chunkIndex += 1;
        }
    });
}

async function readOptionalFileSize(path: string) {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

function isAbortError(error: unknown) {
    return error !== null
        && typeof error === 'object'
        && (
            ('name' in error && error.name === 'AbortError')
            || ('code' in error && error.code === 'ABORT_ERR')
        );
}

export async function observeScanCleanupAnalysisReleasePromises(
    promises: ReadonlyArray<Promise<void>>,
    log: TScanCleanupLog,
) {
    const results = await Promise.allSettled(promises);
    for (const result of results) {
        if (result.status === 'rejected') {
            log('warn', `Failed to release scan cleanup analysis raster: ${getErrorMessage(result.reason)}`);
        }
    }
}

async function requirePublishedRasterFile(path: string | undefined, pageNumber: number, role: string) {
    if (path === undefined) {
        throw new ScanCleanupMissingOutputError(
            pageNumber,
            path,
            role,
            'no output destination was declared',
        );
    }
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, error.message);
    });
    if (!stats.isFile()) throw new ScanCleanupMissingOutputError(pageNumber, path, role, 'path is not a file');
    await access(path, fsConstants.R_OK).catch((error: NodeJS.ErrnoException) => {
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, error.message);
    });
    return path;
}

async function requireProducedRasterFile(
    requirePublishedRaster: NonNullable<IRunScanCleanupPipelineDependencies['requirePublishedRaster']>,
    path: string | undefined,
    pageNumber: number,
    role: string,
) {
    try {
        return await requirePublishedRaster(path, pageNumber, role);
    } catch (error) {
        if (error instanceof ScanCleanupMissingOutputError) throw error;
        throw new ScanCleanupMissingOutputError(pageNumber, path, role, getErrorMessage(error));
    }
}

async function validateStagedPdf(
    qpdfBinary: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    runCommand: IRunScanCleanupPipelineDependencies['runCommand'],
) {
    let result;
    try {
        result = await runCommand(qpdfBinary, [
            '--check',
            stagedPdfPath,
        ], {
            signal,
            // qpdf exits 3 for a structurally valid file with warnings (for
            // example a repaired dictionary); only hard failures block
            // publication.
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(scan-cleanup:publish-structure-check)',
            timeoutMs: 10 * 60 * 1000,
            log,
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new ScanCleanupPdfValidationError(stagedPdfPath, getErrorMessage(error));
    }
    signal.throwIfAborted();
    if (result.exitCode === 3) {
        const warnings = [
            result.stderr,
            result.stdout,
        ]
            .filter(value => value.length > 0)
            .join('\n')
            .trim();
        log('warn', `Published PDF passed structural validation with qpdf warnings: ${warnings}`);
        return;
    }
    if (result.exitCode !== 0) {
        const detail = [
            result.stderr,
            result.stdout,
        ]
            .filter(value => value.length > 0)
            .join('\n')
            .trim();
        throw new ScanCleanupPdfValidationError(
            stagedPdfPath,
            detail.length > 0 ? detail : `qpdf exited with code ${String(result.exitCode)}`,
        );
    }
}

export async function validateScanCleanupBatchSummarySidecar(
    sidecarPath: string,
    expectedBatchCount: number,
    signal: AbortSignal,
    expectedPageScope?: TScanCleanupPageScope,
) {
    let actualBatchCount = 0;
    try {
        if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
            throw new Error('declared batch count is invalid');
        }
        if (expectedPageScope !== undefined && expectedPageScope.length === 0) {
            throw new Error('expected page scope is empty');
        }
        for await (const record of readJsonLines<unknown>(sidecarPath, signal)) {
            if (
                !isRecord(record)
                || typeof record.batchIndex !== 'number'
                || !Number.isSafeInteger(record.batchIndex)
                || typeof record.firstPageNumber !== 'number'
                || !Number.isSafeInteger(record.firstPageNumber)
                || typeof record.inputPages !== 'number'
                || !Number.isSafeInteger(record.inputPages)
                || typeof record.outputPages !== 'number'
                || !Number.isSafeInteger(record.outputPages)
                || record.inputPages < 1
                || record.outputPages < 0
                || record.summary === null
                || typeof record.summary !== 'object'
                || Array.isArray(record.summary)
            ) {
                throw new Error('contains an invalid batch record');
            }
            if (record.batchIndex !== actualBatchCount) {
                throw new Error(
                    `contains out-of-order batch index ${String(record.batchIndex)}`,
                );
            }
            const summary = record.summary as Record<string, unknown>;
            if (
                !Number.isSafeInteger(summary.inputPages)
                || !Number.isSafeInteger(summary.outputPages)
                || summary.inputPages !== record.inputPages
                || summary.outputPages !== record.outputPages
            ) {
                throw new Error('contains a batch summary count mismatch');
            }
            if (expectedPageScope !== undefined) {
                const expectedPageNumbers = collectScanCleanupPageScopeBatch(
                    expectedPageScope,
                    {
                        batchIndex: actualBatchCount,
                        startOffset: actualBatchCount * SCAN_CLEANUP_STREAMING_BATCH_PAGES,
                        endOffsetExclusive: Math.min(
                            expectedPageScope.length,
                            (actualBatchCount + 1) * SCAN_CLEANUP_STREAMING_BATCH_PAGES,
                        ),
                    },
                );
                if (
                    expectedPageNumbers.length === 0
                    || record.firstPageNumber !== expectedPageNumbers[0]
                    || record.inputPages !== expectedPageNumbers.length
                ) {
                    throw new Error('does not match the requested page scope');
                }
            }
            actualBatchCount += 1;
        }
        if (actualBatchCount !== expectedBatchCount) {
            throw new Error(
                `declared ${String(expectedBatchCount)} batches but contained ${String(actualBatchCount)}`,
            );
        }
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScanCleanupStreamingEvidenceError) {
            throw error;
        }
        throw new ScanCleanupStreamingEvidenceError(
            sidecarPath,
            getErrorMessage(error),
        );
    }
}

export async function validateScanCleanupStreamingReport(
    reportPath: string,
    sidecarPath: string,
    expectedBatchCount: number,
    signal: AbortSignal,
    expectedPageScope?: TScanCleanupPageScope,
) {
    try {
        const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
        if (
            !isRecord(report)
            || typeof report.outputMappingsSidecarPath !== 'string'
            || typeof report.pagesSidecarPath !== 'string'
        ) {
            throw new Error('representation report does not name its record sidecars');
        }
        for (const recordSidecarPath of [
            report.outputMappingsSidecarPath,
            report.pagesSidecarPath,
        ]) {
            if ((await stat(recordSidecarPath)).size <= 0) {
                throw new Error('representation report sidecar is empty');
            }
        }
        // Read the sidecar again at the publication boundary. The first
        // validation protects assembly, while this second read detects a
        // deletion or truncation that happened while the report was being
        // written and prevents an apparently successful empty report.
        await validateScanCleanupBatchSummarySidecar(
            sidecarPath,
            expectedBatchCount,
            signal,
            expectedPageScope,
        );
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScanCleanupStreamingEvidenceError) {
            throw error;
        }
        throw new ScanCleanupStreamingEvidenceError(
            reportPath,
            getErrorMessage(error),
        );
    }
}

/** A child's evidence file, or null when the child wrote none (an empty child may not). */
async function readChildJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
        throw error;
    }
}

function offsetOutputOrdinal(mapping: IScanCleanupOutputMapping, offset: number): IScanCleanupOutputMapping {
    return mapping.outputOrdinal === null
        ? mapping
        : {
            ...mapping,
            outputOrdinal: mapping.outputOrdinal + offset,
        };
}

/**
 * Run the final renderer one native window at a time. Each child conversion
 * retains the existing page-plan and assembly behavior, but its explicit page
 * scope is bounded and its output is published into the coordinator scratch
 * directory. The coordinator only keeps the child PDF paths and scalar
 * counters, then qpdf performs one ordered final merge before the atomic
 * handoff at the caller.
 */
async function runStreamingScanCleanupConversion({
    request,
    paths,
    signal,
    policy,
    log,
    dependencies,
    emitProgress,
    pageNumbers,
    pageCount,
    documentPageCount,
    preparedPdfPath,
    stagedPdfPath,
    scratch,
    summary,
    geometrySidecarPath,
    dpiDetails,
    detectionResultStore,
    documentCanvas,
    options,
    provenance,
    onRecoveryPending,
    sourceText,
    checkpoint,
    checkpointNativeToolIdentity,
}: Omit<IScanCleanupBatchExecution, 'pageSizeStore'> & {
    pageCount: number;
    geometrySidecarPath: string;
    detectionResultStore?: NonNullable<IRunScanCleanupPipelineRequest['detectionResultStore']>;
    provenance: IScanCleanupProvenanceInputs;
}) {
    if (documentPageCount <= SCAN_CLEANUP_STREAMING_BATCH_PAGES) {
        throw new ScanCleanupContractError('Streaming scan cleanup requires an xlarge document');
    }
    // The native geometry sidecar was materialized during the parent canvas
    // pass. Children share a sequential cursor and advance it through each
    // batch; a child serves backward reads from geometry it materialized while
    // planning that batch so no consumer reopens the sidecar from page one.
    const pageSizeStore = createPageSizeStoreFromGeometrySidecar(geometrySidecarPath, signal);
    let documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
    let largestBatchBytes: number | null = 0;
    for (const batch of iterateScanCleanupPageBatches(pageCount, SCAN_CLEANUP_STREAMING_BATCH_PAGES)) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
        if (batchPageNumbers.length === 0) continue;
        const plans: IScanCleanupRasterHandoffPlan[] = [];
        for (const pageNumber of batchPageNumbers) {
            const page = await pageSizeStore.getPage(pageNumber);
            const guardrail = resolveScanCleanupDocumentGuardrail(undefined, undefined, page);
            if (guardrail === undefined) {
                largestBatchBytes = null;
                break;
            }
            if (dpiDetails.documentDpi !== undefined && dpiDetails.documentDpi !== null) {
                documentDpi = Math.max(documentDpi, resolveSourceDpi(dpiDetails.documentDpi));
            }
            if (request.options.preserveOriginalQuality === true) {
                // Lossless children render their analysis page at no more
                // than DETECTION_DPI. A page without source image metadata
                // still has a bounded geometry raster, so the admission does
                // not silently ignore vector or mixed pages.
                plans.push({
                    renderDpi: DETECTION_DPI,
                    raster: guardrail,
                });
                continue;
            }
            const sourceDpi = resolveSourceDpi(undefined, documentDpi);
            const planned = resolveScanCleanupPlannedDpi({
                sourceDpi,
                // An unresolved Auto page may still synthesize a bilevel layer;
                // using that larger pixel allowance keeps this estimate safe.
                outputCarriesBinaryLayer: true,
                sourceRasterDetected: dpiDetails.detected
                    && dpiDetails.documentDpi !== undefined
                    && dpiDetails.documentDpi !== null,
                maxPixels: resolveScanCleanupPipelineMaxPixels(),
                guardrail,
            });
            const renderDpi = planned.dpi < planned.requestedRenderDpi
                ? planned.dpi
                : resolveScanCleanupDocumentCanvasRenderDpi(planned.dpi, documentCanvas);
            const width = Math.max(1, Math.ceil(guardrail.width * renderDpi / guardrail.dpi));
            const height = Math.max(1, Math.ceil(guardrail.height * renderDpi / guardrail.dpi));
            const outputBytes = width * height * 3 * SCAN_CLEANUP_NATIVE_OUTPUT_RASTER_EQUIVALENTS;
            plans.push({
                renderDpi,
                raster: guardrail,
                additionalRenderDpis: [DETECTION_DPI],
                renderCopies: 1,
                additionalScratchBytes: Number.isSafeInteger(outputBytes)
                    ? outputBytes
                    : SCAN_CLEANUP_UNMEASURABLE_OUTPUT_SCRATCH_BYTES,
            });
        }
        if (largestBatchBytes === null) continue;
        const batchBytes = plans.length === batchPageNumbers.length
            ? estimateRawRasterBytes(plans, plans.length)
            : null;
        if (batchBytes === null) {
            largestBatchBytes = null;
        } else {
            largestBatchBytes = Math.max(largestBatchBytes, batchBytes);
        }
    }
    const scratchAdmission = await resolveScanCleanupScratchAdmission(
        largestBatchBytes,
        resolveCombineOutputByteCap(pageCount),
        scratch,
        dependencies.getAvailableScratchBytes,
    );
    log(
        'debug',
        'Scan cleanup run scratch admission '
        + JSON.stringify(scratchAdmission),
    );
    if (!scratchAdmission.admitted) {
        await pageSizeStore.close();
        throw new ScanCleanupInsufficientScratchError(
            scratchAdmission.availableBytes,
            scratchAdmission.requiredBytes,
        );
    }
    const batchOutputsPath = join(scratch, 'scan-cleanup-batch-outputs.jsonl');
    const batchSummariesPath = join(scratch, 'scan-cleanup-batch-summaries.jsonl');
    const outputMappingsPath = join(scratch, 'scan-cleanup-output-mappings.jsonl');
    const outputPagesPath = join(scratch, 'scan-cleanup-output-pages.jsonl');
    const outputHandle = await open(batchOutputsPath, 'w');
    const summaryHandle = await open(batchSummariesPath, 'w');
    const mappingHandle = await open(outputMappingsPath, 'w');
    const pageHandle = await open(outputPagesPath, 'w');
    const completedPageNumbers = new Set<number>();
    // The run's own provenance, gathered from each child's stamp with its
    // output ordinals moved past the children before it.
    const runStamp = {
        effectiveOptions: [] as IBuildScanCleanupProvenanceStampInput['effectiveOptions'][number][],
        outputMappings: [] as IScanCleanupOutputMapping[],
        pagePlanDigests: [] as IBuildScanCleanupProvenanceStampInput['pagePlanDigests'][number][],
        backends: null as null | Pick<TScanCleanupProvenanceStamp['buildIds'], 'assemblerBackend' | 'transportMode'>,
    };
    let batchCount = 0;
    let outputBatchCount = 0;
    try {
        for (const batch of iterateScanCleanupPageBatches(
            pageCount,
            SCAN_CLEANUP_STREAMING_BATCH_PAGES,
        )) {
            signal.throwIfAborted();
            const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
            if (batchPageNumbers.length === 0) continue;
            const batchDetectionResults = await readDetectionResultsForPageNumbers(detectionResultStore, batchPageNumbers, signal);
            const batchOutputPath = join(scratch, `scan-cleanup-batch-${String(batch.batchIndex)}.pdf`);
            const boundedDetectionFields = buildBoundedDetectionRequestFields(
                request,
                batchDetectionResults,
                batchPageNumbers,
            );
            const batchGeometry = checkpoint === undefined
                ? null
                : await Promise.all(batchPageNumbers.map(pageNumber => pageSizeStore.getPage(pageNumber)));
            let batchRasterFacts: Array<IDetectedPageRaster | null> | null = null;
            if (checkpoint !== undefined) {
                batchRasterFacts = [];
                for (const pageNumber of batchPageNumbers) {
                    signal.throwIfAborted();
                    const raster = await dpiDetails.getPageRaster(pageNumber);
                    dpiDetails.recordPageRaster?.(pageNumber, raster);
                    batchRasterFacts.push(raster ?? null);
                }
            }
            const batchSignature = checkpoint === undefined
                ? null
                : computeScanCleanupBatchCheckpointSignature({
                    batchIndex: batch.batchIndex,
                    pageNumbers: batchPageNumbers,
                    boundedDetectionFields,
                    nativeToolIdentity: checkpointNativeToolIdentity,
                    batchGeometry,
                    batchRasterFacts,
                });
            const ordinalOffset = summary.outputPages;
            const restoredCandidate = checkpoint !== undefined && batchSignature !== null
                ? await checkpoint.restoreCompletedBatch(
                    batch.batchIndex,
                    batchSignature,
                    batchPageNumbers,
                    batchOutputPath,
                )
                : null;
            const restoredBatch = restoredCandidate !== null
                && restoredCandidate.hasBatchPdf === (restoredCandidate.summary.outputPages > 0)
                ? restoredCandidate
                : null;
            let childSummary: TScanCleanupSummary;
            let childReport: IScanCleanupRepresentationReport | null;
            let childStamp: TScanCleanupProvenanceStamp | null;
            if (restoredBatch !== null) {
                childSummary = restoredBatch.summary;
                childReport = restoredBatch.representationReport;
                childStamp = restoredBatch.provenanceStamp;
                sourceText.pages.push(...restoredBatch.sourceTextPages.map(page => ({
                    ...page,
                    outputPageIndex: page.outputPageIndex + ordinalOffset,
                })));
                sourceText.skippedNonAffine.push(...restoredBatch.skippedNonAffine);
                for (const pageNumber of batchPageNumbers) completedPageNumbers.add(pageNumber);
                emitProgress('rendering', batch.endOffsetExclusive, pageCount, completedPageNumbers);
                log(
                    'debug',
                    `Scan cleanup resumed bounded output batch ${String(batch.batchIndex)} `
                    + `(${String(childSummary.outputPages)} output page(s)) from checkpoint`,
                );
            } else {
                const {
                    sourcePageRange: _sourcePageRange,
                    ...requestWithoutPageRange
                } = withBoundedDetectionFields(
                    request,
                    boundedDetectionFields,
                );
                const childRequest: IRunScanCleanupPipelineRequest = {
                    ...requestWithoutPageRange,
                    outputPdfPath: batchOutputPath,
                    sourcePageNumbers: batchPageNumbers,
                    options,
                    provenance,
                };
                sourceText.outputPageOffset = summary.outputPages;
                const sourceTextPagesBefore = sourceText.pages.length;
                const skippedNonAffineBefore = sourceText.skippedNonAffine.length;
                // Each child owns a scratch directory of its own, so its source
                // and cleaned rasters go once its PDF and evidence are taken,
                // instead of every child's staying until the whole run ends.
                const childScratch = await mkdtemp(join(scratch, `batch-${String(batch.batchIndex)}-`));
                let childRecoveryPending = false;
                childSummary = await executeScanCleanupBatch({
                    request: childRequest,
                    paths,
                    signal,
                    policy,
                    log,
                    dependencies,
                    pageNumbers: batchPageNumbers,
                    documentPageCount,
                    preparedPdfPath,
                    stagedPdfPath: batchOutputPath,
                    scratch: childScratch,
                    streamingChild: true,
                    summary: createEmptyScanCleanupSummary(batchPageNumbers.length, []),
                    pageSizeStore,
                    dpiDetails: dpiDetails,
                    documentCanvas,
                    options,
                    sourceText,
                    ...(checkpoint === undefined
                        ? {}
                        : {
                            checkpoint,
                            checkpointScopeKey: `batch-${String(batch.batchIndex)}-pages`,
                            ...(checkpointNativeToolIdentity === undefined
                                ? {}
                                : {checkpointNativeToolIdentity}),
                        }),
                    onRecoveryPending: recovery => {
                        childRecoveryPending = true;
                        return onRecoveryPending(recovery);
                    },
                    emitProgress: (_stage, _completedUnits, _totalUnits, completedPages) => {
                        if (completedPages !== undefined) {
                            for (const pageNumber of completedPages) completedPageNumbers.add(pageNumber);
                        }
                        emitProgress(
                            'rendering',
                            completedPageNumbers.size,
                            pageCount,
                            completedPageNumbers,
                        );
                    },
                });
                for (const pageNumber of batchPageNumbers) completedPageNumbers.add(pageNumber);
                emitProgress('rendering', batch.endOffsetExclusive, pageCount, completedPageNumbers);
                childReport = await readChildJson<IScanCleanupRepresentationReport>(
                    join(childScratch, 'scan-cleanup-representation-report.json'),
                );
                childStamp = await readChildJson<TScanCleanupProvenanceStamp>(
                    join(childScratch, 'scan-cleanup-provenance-stamp.json'),
                );
                // Only an empty child may leave either out: pages without their
                // mappings or provenance would publish unaccounted output.
                if (childSummary.outputPages > 0 && (childReport === null || childStamp === null)) {
                    throw new ScanCleanupContractError(
                        `Scan cleanup batch ${String(batch.batchIndex)} produced pages without its representation report or provenance stamp`,
                    );
                }
                if (checkpoint !== undefined && batchSignature !== null && !childRecoveryPending) {
                    const batchSourceTextPages = sourceText.pages
                        .slice(sourceTextPagesBefore)
                        .map(page => ({
                            ...page,
                            outputPageIndex: page.outputPageIndex - ordinalOffset,
                        }));
                    const batchSkippedNonAffine = sourceText.skippedNonAffine.slice(skippedNonAffineBefore);
                    await checkpoint.commitCompletedBatch({
                        batchIndex: batch.batchIndex,
                        firstPageNumber: batchPageNumbers[0]!,
                        batchSignature,
                        batchPdfPath: childSummary.outputPages > 0 ? batchOutputPath : null,
                        summary: childSummary,
                        representationReport: childReport,
                        provenanceStamp: childStamp,
                        sourceTextPages: batchSourceTextPages,
                        skippedNonAffine: batchSkippedNonAffine,
                    });
                }
                if (!childRecoveryPending) {
                    await rm(childScratch, {
                        recursive: true,
                        force: true,
                    });
                }
            }
            // An empty child, every page excluded or blank, accounts for its
            // pages and contributes no PDF to the merge.
            if (childSummary.outputPages > 0) {
                await appendJsonLine(outputHandle, {
                    path: batchOutputPath,
                    pageCount: childSummary.outputPages,
                });
                outputBatchCount += 1;
            }
            // Only an empty child may leave either out: pages without their
            // mappings or provenance would publish unaccounted output.
            if (childSummary.outputPages > 0 && (childReport === null || childStamp === null)) {
                throw new ScanCleanupContractError(
                    `Scan cleanup batch ${String(batch.batchIndex)} produced pages without its representation report or provenance stamp`,
                );
            }
            for (const mapping of childReport?.outputMappings ?? []) {
                await appendJsonLine(mappingHandle, offsetOutputOrdinal(mapping, ordinalOffset));
            }
            for (const page of childReport?.pages ?? []) {
                await appendJsonLine(pageHandle, {
                    ...page,
                    outputPageNumber: page.outputPageNumber + ordinalOffset,
                    outputOrdinal: page.outputOrdinal + ordinalOffset,
                });
            }
            if (childStamp !== null) {
                runStamp.effectiveOptions.push(...childStamp.effectiveOptions.perSourcePage);
                runStamp.pagePlanDigests.push(...childStamp.pagePlanDigests);
                runStamp.outputMappings.push(...childStamp.outputMappings.map(mapping => offsetOutputOrdinal(mapping, ordinalOffset)));
                runStamp.backends ??= {
                    assemblerBackend: childStamp.buildIds.assemblerBackend,
                    transportMode: childStamp.buildIds.transportMode,
                };
            }
            await appendJsonLine(summaryHandle, {
                batchIndex: batch.batchIndex,
                firstPageNumber: batchPageNumbers[0],
                inputPages: childSummary.inputPages,
                outputPages: childSummary.outputPages,
                summary: childSummary,
            });
            batchCount += 1;
            summary.outputPages += childSummary.outputPages;
            summary.spreadsSplit += childSummary.spreadsSplit;
            summary.offcutsDiscarded += childSummary.offcutsDiscarded;
            summary.deskewSkipped += childSummary.deskewSkipped;
            summary.cropSkipped += childSummary.cropSkipped;
            summary.excludedPages += childSummary.excludedPages;
            summary.blankPagesSkipped += childSummary.blankPagesSkipped;
            summary.accessibilityTagsRemoved ||= childSummary.accessibilityTagsRemoved;
            // The caller reads one summary whatever the document size, so a
            // child's conditions reach it as a one-batch run's do.
            summary.warnings.push(...childSummary.warnings);
            summary.warningEvents?.push(...(childSummary.warningEvents ?? []));
            log(
                'debug',
                `Scan cleanup completed bounded output batch ${String(batch.batchIndex)} `
                + `(${String(childSummary.outputPages)} output page(s))`,
            );
        }
        await Promise.all([
            mappingHandle.close(),
            pageHandle.close(),
        ]);
        if (batchCount === 0 || summary.outputPages === 0) {
            throw new ScanCleanupContractError('evb-scan-cleanup produced no output pages');
        }
        // One stamp for the whole document, which the final overlay records
        // after the merge: a merged batch PDF keeps neither batch's own.
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: provenance.sourceSha256,
            effectiveOptions: runStamp.effectiveOptions,
            outputMappings: runStamp.outputMappings,
            pagePlanDigests: runStamp.pagePlanDigests,
            buildIds: await buildScanCleanupStampBuildIds({
                paths,
                assemblerBackend: runStamp.backends?.assemblerBackend ?? 'native-pdf-image-combine',
                transportMode: runStamp.backends?.transportMode ?? 'file-ppm',
                ...(dependencies.hashNativeBinary === undefined
                    ? {}
                    : {hashNativeBinary: dependencies.hashNativeBinary}),
                reusableNativeBinarySha256s: provenance.nativeBinarySha256s,
            }),
        });
        await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
        sourceText.provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
        await validateScanCleanupBatchSummarySidecar(
            batchSummariesPath,
            batchCount,
            signal,
            pageNumbers,
        );
        emitProgress('assembling', 0, summary.outputPages, []);
        await mergeScanCleanupPdfPathSidecar({
            inputPath: batchOutputsPath,
            inputCount: outputBatchCount,
            scratch,
            stagedPdfPath,
            qpdfBinary: paths.qpdfBinary,
            signal,
            log,
            runCommand: dependencies.runCommand,
        });
        // The aggregate completion count is authoritative for this final
        // event. Do not attach an empty page list, which the progress schema
        // correctly rejects as inconsistent with completedUnits.
        emitProgress('assembling', summary.outputPages, summary.outputPages);
        const [
            sourceFile,
            outputFile,
        ] = await Promise.all([
            stat(preparedPdfPath),
            stat(stagedPdfPath),
        ]);
        if (outputFile.size <= 0) throw new ScanCleanupContractError('PDF assembler produced an empty file');
        const fullDocumentRun = request.sourcePageNumbers === undefined
            && request.sourcePageRange === undefined;
        if (
            fullDocumentRun
            && request.options.outputMode === 'auto'
            && dpiDetails.compactLayeredPageCountComplete !== true
        ) {
            throw new ScanCleanupStreamingEvidenceError(
                batchSummariesPath,
                'Automatic scan cleanup could not establish a bounded compact-source budget for the full xlarge document; '
                + 'source raster probing was incomplete, so publication was refused',
            );
        }
        const compactSourceBudget = resolveScanCleanupCompactSourceBudget({
            documentPageCount,
            options: request.options,
            partialRun: !fullDocumentRun,
            sourceBytes: sourceFile.size,
            ...(dpiDetails.compactLayeredPageCount === undefined
                ? {}
                : {compactLayeredPageCount: dpiDetails.compactLayeredPageCount}),
        });
        // Mappings and page records stream to their own sidecars, one record a
        // line. The top-level report remains a small descriptor, so diagnostics
        // can read them without a whole-document parse.
        const representationReport: IScanCleanupRepresentationReport = {
            schemaVersion: 1,
            sourceBytes: sourceFile.size,
            outputBytes: outputFile.size,
            outputToSourceByteRatio: outputFile.size / sourceFile.size,
            compactSourceBudget,
            outputMappings: [],
            pages: [],
            outputMappingsSidecarPath: outputMappingsPath,
            pagesSidecarPath: outputPagesPath,
        };
        const representationReportPath = join(scratch, 'scan-cleanup-representation-report.json');
        await writeFile(
            representationReportPath,
            `${JSON.stringify(representationReport, null, 2)}\n`,
        );
        await validateScanCleanupStreamingReport(
            representationReportPath,
            batchSummariesPath,
            batchCount,
            signal,
            pageNumbers,
        );
        try {
            assertScanCleanupCompactSourceBudget(outputFile.size, compactSourceBudget);
        } catch (error) {
            throw new ScanCleanupStreamingEvidenceError(
                batchSummariesPath,
                getErrorMessage(error),
            );
        }
        return summary;
    } finally {
        await Promise.all([
            outputHandle.close(),
            summaryHandle.close(),
            mappingHandle.close().catch(() => undefined),
            pageHandle.close().catch(() => undefined),
            pageSizeStore.close(),
        ]);
    }
}

export async function runScanCleanupConversion(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    policy: IScanCleanupRuntimePolicy,
    log: TScanCleanupLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies,
): Promise<TScanCleanupSummary> {
    const ownsScratch = paths.scratchDir === undefined;
    const scratch = paths.scratchDir ?? await createScanCleanupScratchDir(paths.tempDir);
    const sessionId = randomUUID();
    const stagedPdfPath = join(scratch, 'cleaned.pdf');
    const publishTempPath = join(dirname(request.outputPdfPath), `.${sessionId}.scan-cleanup.tmp`);
    // Set once the run knows which assembler it is actually using: a matched
    // lossless run whose pages cannot keep their own pixels renders instead.
    let losslessRun = request.options.preserveOriginalQuality === true;
    let preserveScratchForDiagnostics = false;
    let pendingSidecarRecovery: Promise<boolean> | null = null;
    let scratchCleanupPromise: Promise<void> | null = null;
    let pageSizeStore: IPdfPageSizeStore | null = null;
    let checkpoint: IScanCleanupConversionCheckpoint | null = null;
    const cleanupScratch = () => {
        if (!ownsScratch) return Promise.resolve();
        scratchCleanupPromise ??= (pendingSidecarRecovery ?? Promise.resolve(true))
            .then(proven => (proven ? rm(scratch, {
                recursive: true,
                force: true,
            }) : undefined))
            .catch(error => {
                log('warn', `Failed to cleanup scan cleanup recovery scratch: ${getErrorMessage(error)}`);
            });
        return pendingSidecarRecovery === null ? scratchCleanupPromise : Promise.resolve();
    };
    const retainScratchUntilRecovery = (recovery: Promise<boolean>) => {
        const observed = recovery.catch(error => {
            log('warn', `Scan cleanup recovery did not complete: ${getErrorMessage(error)}`);
            return false;
        });
        pendingSidecarRecovery = pendingSidecarRecovery === null ? observed
            : Promise.all([
                pendingSidecarRecovery,
                observed,
            ]).then(proofs => proofs.every(Boolean));
        return observed.then(() => scratchCleanupPromise).then(() => undefined);
    };
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun);
    try {
        emitProgress('normalizing', 0, 1, []);
        // The viewer has already opened this exact revision successfully, and
        // every cleanup read is bounded by the operation signal. Rewriting the
        // entire document through qpdf here used to add almost a second to a
        // one-page cleanup (and repeated work already done at document open)
        // before Poppler or the cleanup engine touched the selected page.
        // Keep qpdf repair in the import/open boundary; this pipeline consumes
        // the validated source directly.
        const prepared = {
            pdfPath: request.sourcePdfPath,
            warnings: [] as string[],
        };
        const documentPageCount = await dependencies.getPageCount(prepared.pdfPath, {signal});
        const pageNumbers = resolveScanCleanupPageScopeLazy(
            request.sourcePageNumbers,
            documentPageCount,
            request.sourcePageRange,
        );
        const pageCount = pageNumbers.length;
        // A document-wide summary carries only bounded calibration. Keep
        // direct callers without that summary on the fail-closed contract
        // instead of allowing a large request to allocate an unbounded anchor
        // map during save.
        assertScanCleanupInkAnchorCapacity(
            pageCount,
            request.options,
            request.placementAnchorSummary,
        );
        const largeStreamingRun = documentPageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES;
        const summary = createEmptyScanCleanupSummary(pageCount, prepared.warnings);
        const warn = createScanCleanupSummaryWarningReporter(summary, log);
        const warnEvent = (event: TScanCleanupWarningEvent, pageNumber?: number) => {
            reportScanCleanupSummaryWarningEvent(summary, {
                event,
                ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
            }, warn);
        };
        emitProgress('normalizing', 1, 1);
        // Page geometry and the lossless assembler both come from
        // evb-pdf-page-ops, so no quality path runs without it.
        const pdfPageOpsBinary = paths.pdfPageOpsBinary;
        if (!pdfPageOpsBinary) {
            throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
        }
        // The same measurement the preview derives its canvas from, read from
        // the prepared document this run renders. The lossless path cannot
        // proceed without it — every crop it writes is expressed in these
        // coordinates. Matching only wants the rectangle, and a document that
        // carries none is still worth cleaning: the run drops matching, names
        // why in the summary, and cleans every page at its own size, which is
        // what it already answers when geometry yields no canvas.
        // A detection store is the decision owner at every document size. A
        // document small enough for one batch materializes its bounded maps
        // from it once, exactly as each streaming child does for its batch.
        const smallStoreFields = !largeStreamingRun && request.detectionResultStore !== undefined
            ? await (async (store, documentPages) => buildBoundedDetectionRequestFields(
                request,
                await readDetectionResultsForPageNumbers(store, documentPages, signal),
                documentPages,
            ))(request.detectionResultStore, Array.from({length: documentPageCount}, (_, index) => index + 1))
            : null;
        const suppliedMetadata = request.detectionResultStore === undefined
            ? request.sourcePageMetadataByPage
            : smallStoreFields?.sourcePageMetadataByPage;
        let suppliedMetadataComplete = suppliedMetadata !== undefined;
        if (suppliedMetadataComplete) {
            for (let pageNumber = 1; pageNumber <= documentPageCount; pageNumber += 1) {
                if (suppliedMetadata?.[String(pageNumber)] === undefined) {
                    suppliedMetadataComplete = false;
                    break;
                }
            }
        }
        const pageSizeOptions = {
            pdfPageOpsBinary,
            qpdfBinary: paths.qpdfBinary,
            log,
            runCommand: dependencies.runCommand,
            signal,
            tempDir: scratch,
        };
        try {
            if (suppliedMetadataComplete && suppliedMetadata !== undefined) {
                if (largeStreamingRun) {
                    throw new Error('Scan cleanup xlarge conversion requires a bounded page-size store, not a metadata map');
                }
                pageSizeStore = createPageSizeStoreFromMetadata(suppliedMetadata, documentPageCount);
            } else {
                pageSizeStore = await dependencies.getPageSizeStore(prepared.pdfPath, pageSizeOptions);
            }
            const openedPageSizeStore = pageSizeStore;
            // Validate geometry once before the document pass admits batches.
            await openedPageSizeStore.getPage(1);
            if (openedPageSizeStore.pageCount !== documentPageCount) {
                throw new Error(
                    `Scan cleanup received geometry for ${String(openedPageSizeStore.pageCount ?? 0)} of ${String(documentPageCount)} pages`,
                );
            }
        } catch (error) {
            if (signal.aborted) throw error;
            throw new Error(
                `Scan cleanup cannot safely rasterize without trusted page geometry (${getErrorMessage(error)})`,
                {cause: error},
            );
        }
        const geometryPageSizeStore = pageSizeStore;
        const probesWholeDocument = request.options.matchPageSize
            || (request.sourcePageNumbers === undefined && request.sourcePageRange === undefined);
        const dpiProbePages = probesWholeDocument
            ? undefined
            : pageNumbers.length <= SCAN_CLEANUP_STREAMING_BATCH_PAGES
                ? collectScanCleanupPageScopeBatch(pageNumbers, {
                    batchIndex: 0,
                    startOffset: 0,
                    endOffsetExclusive: pageNumbers.length,
                })
                : undefined;
        const dpiProbePageCount = dpiProbePages === undefined
            ? documentPageCount
            : pageNumbers.length;
        emitProgress('probing', 0, dpiProbePageCount, []);
        // For scan PDFs the fast geometry pass above also reports the dominant
        // raster and its actual page placement. It answers the same DPI question
        // as pdfimages without reopening and walking every image stream in a
        // second process. Mixed/vector documents keep the existing conservative
        // Poppler fallback.
        const metadataDpiDetails = largeStreamingRun
            ? null
            : await createPageGeometryRasterSource(pageSizeStore, documentPageCount, signal);
        // Page geometry can name the dominant raster but not whether the PDF
        // already carries a compact bilevel foreground. Auto needs that
        // representation fact to distinguish an existing MRC text mask from
        // genuinely antialiased low-resolution text, so retain the pdfimages
        // structure probe whenever it is available.
        const structuralDpiDetails: TScanCleanupDpiDetails = largeStreamingRun
            ? createScanCleanupPageRasterSource({
                pdfPath: prepared.pdfPath,
                pdfimagesBinary: paths.pdfimagesBinary,
                detectSourceDpi: dependencies.detectSourceDpi,
                log,
                signal,
                documentPageCount,
            })
            : metadataDpiDetails !== null && paths.pdfimagesBinary === undefined
                ? createEmptyPageRasterSource()
                : await dependencies.detectSourceDpi(
                    prepared.pdfPath,
                    paths.pdfimagesBinary,
                    log,
                    undefined,
                    signal,
                    Array.isArray(dpiProbePages) ? dpiProbePages : undefined,
                    (completedPages, totalPages) => emitProgress('probing', completedPages, totalPages),
                );
        const dpiDetails = structuralDpiDetails.detected
            ? structuralDpiDetails
            : metadataDpiDetails ?? structuralDpiDetails;
        if (metadataDpiDetails && !structuralDpiDetails.detected) {
            emitProgress('probing', dpiProbePageCount, dpiProbePageCount, dpiProbePages);
        }
        const geometrySidecarPath = largeStreamingRun
            ? join(scratch, 'scan-cleanup-page-geometry.jsonl')
            : null;
        const geometrySidecarHandle = geometrySidecarPath === null
            ? null
            : await open(geometrySidecarPath, 'w');
        let qualityPlan: Awaited<ReturnType<typeof planScanCleanupRunQuality>>;
        try {
            if (geometrySidecarHandle !== null) {
                await appendJsonLine(geometrySidecarHandle, {
                    format: PAGE_GEOMETRY_SIDECAR_FORMAT,
                    schemaVersion: PAGE_GEOMETRY_SIDECAR_SCHEMA_VERSION,
                    pageCount: documentPageCount,
                });
            }
            qualityPlan = await planScanCleanupRunQuality({
                request,
                documentPageCount,
                pageSizeStore,
                rasterSource: dpiDetails,
                rasterDetectionAvailable: paths.pdfimagesBinary !== undefined,
                rasterMaxPixels: policy.rasterMaxPixels,
                signal,
                warn,
                warnEvent,
                ...(geometrySidecarHandle === null
                    ? {}
                    : {onGeometryPage: page => appendJsonLine(geometrySidecarHandle, page)}),
            });
        } finally {
            await geometrySidecarHandle?.close();
        }
        const {
            documentCanvas, options,
        } = qualityPlan;
        losslessRun = qualityPlan.losslessRun;
        let cachedSourceSha256 = request.provenance?.sourceSha256;
        let checkpointNativeToolIdentity: Record<string, string> | undefined;
        if (paths.checkpointDir !== undefined) {
            signal.throwIfAborted();
            // Always hash the actual source PDF on disk for checkpoint admission:
            // caller-supplied provenance digests are advisory and must never
            // authorise resuming against modified source bytes.
            const verifiedSourceSha256 = await sha256ScanCleanupFile(prepared.pdfPath);
            cachedSourceSha256 ??= verifiedSourceSha256;
            const resolvedToolIdentity = await resolveCheckpointNativeToolIdentity(
                paths,
                dependencies.hashNativeBinary,
            );
            if (resolvedToolIdentity === null) {
                log(
                    'debug',
                    'Disabling scan cleanup checkpoint reuse because native tool build identity could not be hashed',
                );
            } else {
                checkpointNativeToolIdentity = resolvedToolIdentity;
                const witness = computeScanCleanupCheckpointWitness({
                    sourceSha256: verifiedSourceSha256,
                    request: smallStoreFields === null ? request : withBoundedDetectionFields(request, smallStoreFields),
                    resolvedOptions: options,
                    pageScope: pageNumbers,
                    documentPageCount,
                    documentCanvas,
                    losslessRun,
                    rasterMaxPixels: policy.rasterMaxPixels,
                    nativeToolIdentity: checkpointNativeToolIdentity,
                    assemblyBackend: request.assemblyBackend ?? paths.assemblyBackend ?? null,
                    transportMode: request.transportMode ?? paths.transportMode ?? null,
                    provenanceStampSupport: paths.provenanceStampSupport ?? null,
                });
                checkpoint = await openScanCleanupConversionCheckpoint({
                    checkpointDir: paths.checkpointDir,
                    sourcePdfPath: prepared.pdfPath,
                    witness,
                    documentPageCount,
                    mode: largeStreamingRun ? 'streaming' : 'batch',
                    log,
                    ...(paths.checkpointOwnerId === undefined ? {} : {ownerId: paths.checkpointOwnerId}),
                });
            }
        }
        const sourceText: IScanCleanupSourceTextSink = {
            outputPageOffset: 0,
            pages: [],
            skippedNonAffine: [],
        };
        if (largeStreamingRun) {
            if (geometrySidecarPath === null) {
                throw new Error('Scan cleanup streaming run has no geometry sidecar');
            }
            const provenance = request.provenance ?? {
                sourceSha256: cachedSourceSha256 ?? await sha256ScanCleanupFile(prepared.pdfPath),
                nativeBinarySha256s: await hashScanCleanupNativeBinarySha256s({
                    paths,
                    ...(dependencies.hashNativeBinary === undefined
                        ? {}
                        : {hashNativeBinary: dependencies.hashNativeBinary}),
                }),
            } satisfies IScanCleanupProvenanceInputs;
            await runStreamingScanCleanupConversion({
                request,
                paths,
                signal,
                policy,
                log,
                dependencies,
                emitProgress,
                pageNumbers,
                pageCount,
                documentPageCount,
                preparedPdfPath: prepared.pdfPath,
                stagedPdfPath,
                scratch,
                summary,
                geometrySidecarPath,
                dpiDetails,
                ...(request.detectionResultStore === undefined
                    ? {}
                    : {detectionResultStore: request.detectionResultStore}),
                documentCanvas,
                options,
                provenance,
                sourceText,
                ...(checkpoint === null
                    ? {}
                    : {
                        checkpoint,
                        ...(checkpointNativeToolIdentity === undefined
                            ? {}
                            : {checkpointNativeToolIdentity}),
                    }),
                onRecoveryPending: retainScratchUntilRecovery,
            });
        } else {
            const batchRequest = smallStoreFields === null
                ? request
                : withBoundedDetectionFields(request, smallStoreFields);
            await executeScanCleanupBatch({
                request: cachedSourceSha256 === undefined || batchRequest.provenance !== undefined
                    ? batchRequest
                    : {
                        ...batchRequest,
                        provenance: {
                            sourceSha256: cachedSourceSha256,
                            nativeBinarySha256s: {},
                        },
                    },
                paths,
                signal,
                policy,
                log,
                dependencies,
                emitProgress,
                pageNumbers,
                documentPageCount,
                preparedPdfPath: prepared.pdfPath,
                stagedPdfPath,
                scratch,
                summary,
                pageSizeStore: geometryPageSizeStore,
                dpiDetails,
                documentCanvas,
                options,
                sourceText,
                ...(checkpoint === null
                    ? {}
                    : {
                        checkpoint,
                        ...(checkpointNativeToolIdentity === undefined
                            ? {}
                            : {checkpointNativeToolIdentity}),
                    }),
                onRecoveryPending: retainScratchUntilRecovery,
            });
        }
        // One overlay over the merged output: a link may name another batch's page.
        const overlaid = await overlayScanCleanupTextLayerAndMeasure(
            sourceText, paths, prepared.pdfPath, stagedPdfPath, scratch, signal, log, dependencies,
            retainScratchUntilRecovery, sourceText.provenanceStampHex,
        );
        summary.sourceTextOmission = await inspectSkippedScanCleanupSourceText({
            pages: overlaid.omittedSourcePages,
            pdfPath: prepared.pdfPath,
            scratch,
            pdfPageOpsBinary: paths.pdfPageOpsBinary,
            qpdfBinary: paths.qpdfBinary,
            signal,
            runCommand: dependencies.runCommand,
            log,
        });
        summary.accessibilityTagsRemoved ||= overlaid.accessibilityTagsRemoved;
        await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
        emitProgress('handoff', 0, pageCount, []);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
        if (checkpoint !== null) {
            if (paths.deferCheckpointCleanup === true) {
                dependencies.onCheckpointReadyForCleanup?.(checkpoint.entryDir);
                await checkpoint.close().catch(error => {
                    log('warn', `Failed to release scan cleanup checkpoint lease: ${getErrorMessage(error)}`);
                });
            } else {
                await checkpoint.complete().catch(error => {
                    log('warn', `Failed to remove completed scan cleanup checkpoint: ${getErrorMessage(error)}`);
                });
            }
            checkpoint = null;
        }
        emitProgress('handoff', pageCount, pageCount, pageNumbers);
        return summary;
    } catch (error) {
        if (
            error instanceof ScanCleanupPdfValidationError
            || error instanceof ScanCleanupStreamingEvidenceError
        ) {
            preserveScratchForDiagnostics = true;
        }
        throw error;
    } finally {
        if (checkpoint !== null) {
            await checkpoint.cleanupTempFiles().catch(error => {
                log('warn', `Failed to cleanup scan cleanup checkpoint temp files: ${getErrorMessage(error)}`);
            });
            await checkpoint.close().catch(error => {
                log('warn', `Failed to release scan cleanup checkpoint lease: ${getErrorMessage(error)}`);
            });
        }
        if (pageSizeStore !== null) {
            await pageSizeStore.close().catch(error => {
                log('warn', `Failed to close scan cleanup page-size store: ${getErrorMessage(error)}`);
            });
        }
        await rm(publishTempPath, {force: true}).catch(() => undefined);
        await preserveScanCleanupJsonEvidence(
            scratch,
            log,
            dependencies.evidenceDirectory,
            undefined,
            dependencies.evidenceFileFilter,
        ).catch(error => {
            log('warn', `Failed to preserve scan cleanup JSON evidence: ${getErrorMessage(error)}`);
        });
        if (preserveScratchForDiagnostics) {
            log('warn', `Preserving invalid staged scan cleanup PDF for diagnostics: ${stagedPdfPath}`);
        } else {
            if (pendingSidecarRecovery !== null) {
                log('warn', `Retaining scan cleanup recovery scratch until producer termination and recovery are proven: ${scratch}`);
            }
            await cleanupScratch();
        }
    }
}

interface IScanCleanupBatchExecution {
    request: IRunScanCleanupPipelineRequest;
    paths: IScanCleanupWorkerPaths;
    signal: AbortSignal;
    policy: IScanCleanupRuntimePolicy;
    log: TScanCleanupLog;
    dependencies: IRunScanCleanupPipelineDependencies;
    emitProgress: ReturnType<typeof createScanCleanupProgressReporter>;
    pageNumbers: TScanCleanupPageScope;
    documentPageCount: number;
    preparedPdfPath: string;
    stagedPdfPath: string;
    scratch: string;
    summary: TScanCleanupSummary;
    pageSizeStore: IPdfPageSizeStore;
    dpiDetails: TScanCleanupDpiDetails;
    documentCanvas: TScanCleanupDocumentCanvas | null;
    options: IRunScanCleanupPipelineRequest['options'];
    onRecoveryPending: (recovery: Promise<boolean>) => Promise<void>;
    sourceText: IScanCleanupSourceTextSink;
    /**
     * One batch of a multi-batch run: it may produce no pages, as long as the
     * run produces some, and its navigation is rebuilt by the run's overlay.
     */
    streamingChild?: boolean;
    checkpoint?: IScanCleanupConversionCheckpoint;
    checkpointScopeKey?: string;
    checkpointNativeToolIdentity?: Readonly<Record<string, string>>;
}

async function collectExistingPageCheckpointArtifacts(
    page: INativeScanCleanupPageV3,
): Promise<IScanCleanupPageArtifactInput[]> {
    const candidatePaths = new Set<string>([page.pageMetadataPath]);
    for (const output of page.outputs) {
        candidatePaths.add(output.metadataPath);
        candidatePaths.add(output.outputPath);
        if (typeof output.bilevelOutputPath === 'string') candidatePaths.add(output.bilevelOutputPath);
        if (typeof output.backgroundOutputPath === 'string') candidatePaths.add(output.backgroundOutputPath);
        if (typeof output.foregroundMaskOutputPath === 'string') candidatePaths.add(output.foregroundMaskOutputPath);
        if (typeof output.foregroundAlphaOutputPath === 'string') candidatePaths.add(output.foregroundAlphaOutputPath);
    }
    const artifacts: IScanCleanupPageArtifactInput[] = [];
    for (const candidatePath of candidatePaths) {
        try {
            const fileStat = await stat(candidatePath);
            if (fileStat.isFile()) {
                artifacts.push({
                    scratchPath: candidatePath,
                    fileName: basename(candidatePath),
                });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return artifacts;
}

// Executes an admitted page batch in the job's scratch. The caller owns geometry,
// progress, recovery retention and publication; this body owns bounded conversion.
async function executeScanCleanupBatch({
    request, paths, signal, policy, log, dependencies, emitProgress, pageNumbers,
    documentPageCount, preparedPdfPath, stagedPdfPath, scratch, summary,
    pageSizeStore, dpiDetails, documentCanvas, options, onRecoveryPending, sourceText,
    streamingChild = false, checkpoint, checkpointScopeKey, checkpointNativeToolIdentity,
}: IScanCleanupBatchExecution): Promise<TScanCleanupSummary> {
    const pageCount = pageNumbers.length;
    const requirePublishedRaster = dependencies.requirePublishedRaster ?? requirePublishedRasterFile;
    const warn = createScanCleanupSummaryWarningReporter(summary, log);
    const warnEvent = (event: TScanCleanupWarningEvent, pageNumber?: number) => {
        reportScanCleanupSummaryWarningEvent(summary, {
            event,
            ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
        }, warn);
    };
    if (options.preserveOriginalQuality) {
        await runLosslessScanCleanup(
            request, paths, preparedPdfPath, [], pageNumbers, pageSizeStore,
            dpiDetails, scratch, stagedPdfPath, signal, emitProgress, log, policy,
            dependencies, {
                documentCanvas,
                onRecoveryPending,
                ...(streamingChild ? {streamingChildSourceText: sourceText} : {}),
            }, summary,
        );
        if (streamingChild && summary.outputPages === 0) return summary;
        if ((await stat(stagedPdfPath)).size <= 0) {
            throw new ScanCleanupContractError('Lossless PDF assembler produced an empty file');
        }
        await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
        return summary;
    }
    const {
        documentDpi,
        rasterPlans,
        pageGeometryByNumber,
        detectedRasterByPage,
        resolvedPagePlanByNumber,
        analysisDpiByPage,
        resolvePageOutputMode,
        resolvePageSourceDpi,
    } = await planScanCleanupFinalPages({
        request,
        documentCanvas,
        rasterSource: dpiDetails,
        pageSizeStore,
        rasterMaxPixels: policy.rasterMaxPixels,
        log,
        signal,
        warnEvent,
        probeGuardrail: async (pageNumber, page) => {
            const probePath = join(scratch, `size-probe-${pageNumber}.png`);
            await dependencies.renderPage(
                paths,
                log,
                pageNumber,
                preparedPdfPath,
                probePath,
                SCAN_CLEANUP_SIZE_PROBE_DPI,
                undefined,
                signal,
                undefined,
                undefined,
                page.renderBox ?? 'cropbox',
                'exclude',
                onRecoveryPending,
            );
            const guardrail = {
                dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
                ...await readPngDimensions(probePath),
            };
            await rm(probePath, {force: true}).catch(() => undefined);
            return guardrail;
        },
    }, pageNumbers);
    const estimateNativeOutputScratchBytes = (plan: TScanCleanupFinalPagePlan) => {
        const width = Math.max(1, Math.ceil(plan.guardrail.width * plan.dpi / plan.guardrail.dpi));
        const height = Math.max(1, Math.ceil(plan.guardrail.height * plan.dpi / plan.guardrail.dpi));
        const pixelBytes = width * height * 3;
        const outputBytes = pixelBytes * SCAN_CLEANUP_NATIVE_OUTPUT_RASTER_EQUIVALENTS;
        return Number.isSafeInteger(outputBytes)
            ? outputBytes
            : SCAN_CLEANUP_UNMEASURABLE_OUTPUT_SCRATCH_BYTES;
    };
    let availableScratchBytesPromise: Promise<number | null> | undefined;
    const readAvailableScratchBytesOnce = (directory: string) => (
        availableScratchBytesPromise ??= dependencies.getAvailableScratchBytes(directory)
    );
    const availableScratchBytes = await readAvailableScratchBytesOnce(scratch);
    const streamingBudget = resolveStreamingRasterHandoffBudget({
        availableScratchBytes,
        rasterConcurrency: policy.rasterConcurrency,
        totalPages: Math.max(1, rasterPlans.length),
        ...(dependencies.streamingHandoff === undefined ? {} : {overrides: dependencies.streamingHandoff}),
    });
    const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
        renderDpi: plan.dpi,
        raster: plan.guardrail,
        additionalRenderDpis: [analysisDpiByPage.get(plan.pageNumber)!],
        additionalScratchBytes: estimateNativeOutputScratchBytes(plan),
        renderCopies: 1,
    })), scratch, readAvailableScratchBytesOnce, Math.min(rasterPlans.length, streamingBudget.maxInFlightPages));
    logRasterHandoff(log, 'final', rasterHandoff);
    const pageDpi = new Map<number, number>();
    const trustedMrcLayersByPage = new Map<number, IPdfMrcLayers>();
    const trustedForegroundCandidates = rasterPlans.filter(plan => {
        const candidacy = resolveScanCleanupSourceMrcCandidacy(
            request,
            plan,
            pageGeometryByNumber.get(plan.pageNumber)!,
            detectedRasterByPage.get(plan.pageNumber),
        );
        if (candidacy.geometryRejection !== undefined) {
            log(
                'debug',
                `Page ${String(plan.pageNumber)} will use raster reconstruction; `
                + `source MRC reuse is not proven (${candidacy.geometryRejection})`,
            );
        }
        return candidacy.eligible;
    });
    if (trustedForegroundCandidates.length > 0) {
        emitProgress('extracting', 0, trustedForegroundCandidates.length, []);
        const extractionStartedAt = performance.now();
        if (dependencies.extractMrcLayersBatch !== undefined) {
            try {
                const layers = await dependencies.extractMrcLayersBatch({
                    pdfPath: preparedPdfPath,
                    targets: trustedForegroundCandidates.map(plan => ({
                        pageNumber: plan.pageNumber,
                        selectionMaskOutputPath:
                            join(scratch, `source-${plan.pageNumber}-mrc-selection.jb2e`),
                        backgroundOutputPath:
                            join(scratch, `source-${plan.pageNumber}-mrc-background.ppm`),
                        foregroundOutputPath:
                            join(scratch, `source-${plan.pageNumber}-mrc-foreground.jp2`),
                    })),
                    pdfimagesBinary: paths.pdfimagesBinary,
                    qpdfBinary: paths.qpdfBinary,
                    pdfImageCombineBinary: paths.pdfImageCombineBinary,
                    pdftoppmBinary: paths.pdftoppmBinary,
                    runCommand: dependencies.runCommand,
                    log,
                    rasterConcurrency: policy.rasterConcurrency,
                    signal,
                    onProgress: (completedPages, totalPages) =>
                        emitProgress('extracting', completedPages, totalPages),
                });
                for (const [
                    pageNumber,
                    layer,
                ] of layers) {
                    const geometryRejection = resolveSourceMrcLayerRejection(
                        pageGeometryByNumber.get(pageNumber)!,
                        layer,
                    );
                    if (geometryRejection === undefined) {
                        trustedMrcLayersByPage.set(pageNumber, layer);
                    } else {
                        log(
                            'debug',
                            `Page ${String(pageNumber)} will use raster reconstruction; `
                            + `source MRC reuse is not proven (${geometryRejection})`,
                        );
                    }
                }
            } catch (error) {
                signal.throwIfAborted();
                if (isAbortError(error)) throw error;
                warn(
                    'Compact source layers could not be read in a batch; '
                    + `using raster reconstruction (${getErrorMessage(error)})`,
                );
                emitProgress(
                    'extracting',
                    trustedForegroundCandidates.length,
                    trustedForegroundCandidates.length,
                );
            }
        } else {
            if (dependencies.extractMrcLayers === undefined) {
                throw new Error('PDF MRC layer extraction is unavailable');
            }
            const extractMrcLayers = dependencies.extractMrcLayers;
            let completedExtractions = 0;
            await mapScanCleanupRasterPages(
                trustedForegroundCandidates,
                policy.rasterConcurrency,
                async plan => {
                    try {
                        const layers = await extractMrcLayers({
                            pdfPath: preparedPdfPath,
                            pageNumber: plan.pageNumber,
                            selectionMaskOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-selection.png`),
                            backgroundOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-background.png`),
                            foregroundOutputPath:
                                join(scratch, `source-${plan.pageNumber}-mrc-foreground.jp2`),
                            pdfimagesBinary: paths.pdfimagesBinary,
                            runCommand: dependencies.runCommand,
                            log,
                            signal,
                        });
                        if (layers !== null) {
                            const geometryRejection = resolveSourceMrcLayerRejection(
                                pageGeometryByNumber.get(plan.pageNumber)!,
                                layers,
                            );
                            if (geometryRejection === undefined) {
                                trustedMrcLayersByPage.set(plan.pageNumber, layers);
                            } else {
                                log(
                                    'debug',
                                    `Page ${String(plan.pageNumber)} will use raster reconstruction; `
                                    + `source MRC reuse is not proven (${geometryRejection})`,
                                );
                            }
                        }
                    } catch (error) {
                        signal.throwIfAborted();
                        if (isAbortError(error)) throw error;
                        warn(
                            `Page ${String(plan.pageNumber)} could not reuse its compact MRC foreground; `
                            + `using raster reconstruction (${getErrorMessage(error)})`,
                        );
                    } finally {
                        completedExtractions += 1;
                        emitProgress(
                            'extracting',
                            completedExtractions,
                            trustedForegroundCandidates.length,
                        );
                    }
                },
            );
        }
        log(
            'debug',
            'Scan cleanup source-layer extraction reused '
            + `${String(trustedMrcLayersByPage.size)}/${String(trustedForegroundCandidates.length)} `
            + `candidate page(s) [${[...trustedMrcLayersByPage.keys()].join(',')}] `
            + `in ${(performance.now() - extractionStartedAt).toFixed(0)} ms`,
        );
    }
    const pageInputs = rasterPlans.map(plan => {
        pageDpi.set(plan.pageNumber, plan.dpi);
        const extension = rasterHandoff.format;
        const inputPath = join(scratch, `source-${plan.pageNumber}.${extension}`);
        const detectedRaster = detectedRasterByPage.get(plan.pageNumber);
        const trustedMrcLayers = trustedMrcLayersByPage.get(plan.pageNumber);
        const pageGeometry = pageGeometryByNumber.get(plan.pageNumber);
        return {
            inputPath,
            analysisInputPath: join(
                scratch,
                `source-${plan.pageNumber}-analysis-${analysisDpiByPage.get(plan.pageNumber)!}dpi.${extension}`,
            ),
            ...(trustedMrcLayers === undefined
                ? {}
                : {
                    trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                    trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                }),
            ...describeScanCleanupFinalPage(request, plan, {
                analysisDpi: analysisDpiByPage.get(plan.pageNumber)!,
                detectedRaster,
                pageGeometry,
                resolvedPagePlan: resolvedPagePlanByNumber.get(plan.pageNumber),
            }),
            pageMetadataPath: join(scratch, `clean-${plan.pageNumber}-page.json`),
            outputs: [
                0,
                1,
            ].map(outputIndex => ({
                outputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.png`),
                metadataPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.json`),
                bilevelOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}.pbm`),
                backgroundOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-background.ppm`),
                foregroundMaskOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-mask.pbm`),
                foregroundAlphaOutputPath: join(scratch, `clean-${plan.pageNumber}-${outputIndex}-alpha.pgm`),
            })),
        };
    });
    // The document-wide planning above is intentionally complete before
    // any native work starts. Native page work is replayed in bounded
    // manifests below, so a long source document keeps the same canvas,
    // modes, and placement while native residency remains bounded.
    const outputPages: IRenderedCleanupOutputPage[] = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
    // The engine's own account of what it had to do to a page, a page it
    // could not hold at the document's scale, a raster it could not
    // publish. It travels with the summary and is logged here, so a run
    // that quietly compromised says where.
    const report = createScanCleanupSummaryWarningReporter(summary, log);
    const fittedMarginBoxPages = new Set<number>();
    const renderedPageNumbers = new Set<number>();
    const rasterizedPageNumbers = new Set<number>();
    const collectedPageNumbers = new Set<number>();
    const manifestPageBySource = new Map<number, INativeScanCleanupPageV3>();
    const fullManifest = pageInputs.length === 0
        ? null
        : buildRunnableNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            hostMemoryBytes: policy.totalRamBytes,
            options,
            ...(policy.rasterMaxPixels === undefined ? {} : {rasterMaxPixels: policy.rasterMaxPixels}),
            ...(documentCanvas === null ? {} : {documentCanvas}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
            allowedPathRoot: scratch,
        });
    const allManifestPages = fullManifest?.pages ?? [];
    for (const page of allManifestPages) {
        manifestPageBySource.set(page.sourcePageIndex + 1, page);
    }
    const renderPlanSignature = checkpoint === undefined
        ? null
        : computeScanCleanupRenderPlanSignature({
            documentCanvas,
            rasterFormat: rasterHandoff.format,
            nativeToolIdentity: checkpointNativeToolIdentity,
            pages: allManifestPages.map(page => ({
                sourcePageIndex: page.sourcePageIndex,
                analysisDpi: page.analysisDpi ?? null,
                options: page.options,
                documentPrior: page.documentPrior ?? null,
                pdfPage: page.pdfPage ?? null,
                hasTrustedMrc: page.trustedForegroundMaskPath != null && page.trustedMrcBackgroundPath != null,
            })),
        });
    const restoredPages = checkpoint === undefined || renderPlanSignature === null
        ? new Set<number>()
        : await checkpoint.restoreCompletedPages(
            scratch,
            rasterPlans.map(plan => plan.pageNumber),
            renderPlanSignature,
            checkpointScopeKey,
        );
    for (const restoredPageNumber of restoredPages) {
        rasterizedPageNumbers.add(restoredPageNumber);
        renderedPageNumbers.add(restoredPageNumber);
    }
    if (restoredPages.size > 0) {
        log(
            'debug',
            `Scan cleanup resumed ${String(restoredPages.size)}/${String(rasterPlans.length)} `
            + 'completed page(s) from witness-bound checkpoint',
        );
        emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
    }

    interface IStreamingPageWorkItem {
        plan: TScanCleanupFinalPagePlan;
        pageInput: typeof pageInputs[number];
        manifestPage: INativeScanCleanupPageV3;
    }

    const pendingItems: IStreamingPageWorkItem[] = [];
    for (let index = 0; index < rasterPlans.length; index += 1) {
        const plan = rasterPlans[index]!;
        if (restoredPages.has(plan.pageNumber)) {
            continue;
        }
        pendingItems.push({
            plan,
            pageInput: pageInputs[index]!,
            manifestPage: allManifestPages[index]!,
        });
    }

    if (pendingItems.length > 0 && fullManifest !== null) {
        const activeStreamingBudget = resolveStreamingRasterHandoffBudget({
            availableScratchBytes,
            rasterConcurrency: policy.rasterConcurrency,
            totalPages: pendingItems.length,
            ...(dependencies.streamingHandoff === undefined ? {} : {overrides: dependencies.streamingHandoff}),
        });
        const eligibleInkCalibrationPages = collectEligibleInkCalibrationPages(allManifestPages);
        const inkPriorEligible = eligibleInkCalibrationPages.length >= MINIMUM_DOCUMENT_INK_PRIOR_PAGES;
        let resolvedDocumentInkPrior: TNativeScanCleanupDocumentInkPriorV3 | null =
            inkPriorEligible && checkpoint !== undefined && renderPlanSignature !== null
                ? await checkpoint.getDocumentInkPrior(renderPlanSignature, checkpointScopeKey)
                : null;
        let renderingStarted = restoredPages.size > 0;
        if (!renderingStarted) {
            emitProgress('rasterizing', rasterizedPageNumbers.size, pageCount, renderedPageNumbers);
        }
        const renderer = rasterHandoff.format === 'ppm'
            ? dependencies.renderPagePpm
            : dependencies.renderPage;
        const estimateStagedPageBytes = (item: IStreamingPageWorkItem) => {
            const analysisDpi = analysisDpiByPage.get(item.plan.pageNumber)!;
            const rawEstimate = estimateRawRasterBytes([{
                renderDpi: item.plan.dpi,
                raster: item.plan.guardrail,
                // Always reserve conservatively for both primary and analysis
                // rasters: even at equal DPI, link() may fall back to
                // copyFile(), and PNG fallback may be incompressible. Actual
                // stat() bytes reconcile the reservation right after staging.
                additionalRenderDpis: [analysisDpi],
                renderCopies: 1,
            }], 1);
            return rawEstimate === null ? 1 : rawEstimate;
        };
        const stagedFileSizes = new Map<number, {
            inputBytes: number;
            analysisBytes: number;
            sharedInode: boolean;
        }>();
        const cleanupStagedItems = async (stagedItems: readonly IStreamingPageWorkItem[]) => {
            const targets: Array<{
                pageNumber: number;
                kind: 'input' | 'analysis';
                path: string;
            }> = [];
            for (const item of stagedItems) {
                targets.push(
                    {
                        pageNumber: item.plan.pageNumber,
                        kind: 'input',
                        path: item.pageInput.inputPath,
                    },
                    {
                        pageNumber: item.plan.pageNumber,
                        kind: 'analysis',
                        path: item.pageInput.analysisInputPath,
                    },
                );
            }
            const results = await Promise.allSettled(targets.map(target => rm(target.path, {force: true})));
            const failedByPage = new Map<number, {
                inputFailed: boolean;
                analysisFailed: boolean;
            }>();
            let firstError: unknown;
            for (const [
                index,
                outcome,
            ] of results.entries()) {
                if (outcome.status === 'fulfilled') {
                    continue;
                }
                const code = (outcome.reason as NodeJS.ErrnoException | null)?.code;
                if (code === 'ENOENT') {
                    continue;
                }
                const target = targets[index]!;
                firstError ??= outcome.reason;
                const entry = failedByPage.get(target.pageNumber) ?? {
                    inputFailed: false,
                    analysisFailed: false,
                };
                if (target.kind === 'input') {
                    entry.inputFailed = true;
                } else {
                    entry.analysisFailed = true;
                }
                failedByPage.set(target.pageNumber, entry);
                log(
                    'warn',
                    `Failed to remove consumed scan cleanup scratch raster ${target.path}: ${getErrorMessage(outcome.reason)}`,
                );
            }
            let unreclaimedBytes = 0;
            for (const item of stagedItems) {
                const pageNumber = item.plan.pageNumber;
                const sizes = stagedFileSizes.get(pageNumber);
                const failed = failedByPage.get(pageNumber);
                if (failed === undefined) {
                    stagedFileSizes.delete(pageNumber);
                    continue;
                }
                if (sizes !== undefined) {
                    if (sizes.sharedInode) {
                        if (failed.inputFailed || failed.analysisFailed) {
                            unreclaimedBytes += sizes.inputBytes;
                        }
                    } else {
                        if (failed.inputFailed) unreclaimedBytes += sizes.inputBytes;
                        if (failed.analysisFailed) unreclaimedBytes += sizes.analysisBytes;
                    }
                }
            }
            return {
                unreclaimedBytes,
                ...(firstError === undefined ? {} : {error: firstError}),
            };
        };
        await runBoundedRasterProducerConsumer({
            items: pendingItems,
            budget: activeStreamingBudget,
            signal,
            estimateItemBytes: estimateStagedPageBytes,
            produce: async (item, _index, operationSignal) => {
                operationSignal.throwIfAborted();
                const {
                    plan, pageInput,
                } = item;
                const guardrail = plan.guardrail;
                const analysisDpi = analysisDpiByPage.get(plan.pageNumber)!;
                const limits: IScanCleanupRasterRenderLimits = {
                    expectedWidthPx: Math.max(1, Math.ceil(guardrail.width * plan.dpi / guardrail.dpi)),
                    expectedHeightPx: Math.max(1, Math.ceil(guardrail.height * plan.dpi / guardrail.dpi)),
                    maxPixels: resolveScanCleanupPipelineMaxPixels(
                        plan.resolvedOutputMode,
                        policy.rasterMaxPixels,
                    ),
                    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                };
                const analysisLimits: IScanCleanupRasterRenderLimits = {
                    expectedWidthPx: Math.max(
                        1,
                        Math.ceil(guardrail.width * analysisDpi / guardrail.dpi),
                    ),
                    expectedHeightPx: Math.max(
                        1,
                        Math.ceil(guardrail.height * analysisDpi / guardrail.dpi),
                    ),
                    maxPixels: Math.min(
                        resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode, policy.rasterMaxPixels),
                        SCAN_CLEANUP_RASTER_MAX_PIXELS,
                    ),
                    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                };
                try {
                    await renderer(
                        paths,
                        log,
                        plan.pageNumber,
                        preparedPdfPath,
                        pageInput.inputPath,
                        plan.dpi,
                        undefined,
                        operationSignal,
                        undefined,
                        limits,
                        pageGeometryByNumber.get(plan.pageNumber)?.renderBox ?? 'cropbox',
                        'exclude',
                        onRecoveryPending,
                    );
                    const dimensions = rasterHandoff.format === 'ppm'
                        ? await readPpmDimensions(pageInput.inputPath)
                        : await readPngDimensions(pageInput.inputPath);
                    if (
                        dimensions.width > limits.maxDimensionPx
                        || dimensions.height > limits.maxDimensionPx
                        || dimensions.width * dimensions.height > limits.maxPixels
                    ) {
                        throw new Error(
                            `Scan cleanup page ${String(plan.pageNumber)} raster dimensions `
                            + `${String(dimensions.width)}x${String(dimensions.height)} exceed limits`,
                        );
                    }
                    // At the same DPI the canonical analysis raster is the same
                    // render of the same page box, byte for byte. Link it
                    // instead of rendering the page again; the analysis entry
                    // is released at page completion, which leaves the working
                    // input's own entry in place.
                    if (
                        analysisDpi === plan.dpi
                        && dimensions.width <= analysisLimits.maxDimensionPx
                        && dimensions.height <= analysisLimits.maxDimensionPx
                        && dimensions.width * dimensions.height <= analysisLimits.maxPixels
                    ) {
                        await link(pageInput.inputPath, pageInput.analysisInputPath)
                            .catch(() => copyFile(pageInput.inputPath, pageInput.analysisInputPath));
                    } else {
                        await renderer(
                            paths,
                            log,
                            plan.pageNumber,
                            preparedPdfPath,
                            pageInput.analysisInputPath,
                            analysisDpi,
                            undefined,
                            operationSignal,
                            undefined,
                            analysisLimits,
                            pageGeometryByNumber.get(plan.pageNumber)?.renderBox ?? 'cropbox',
                            'exclude',
                            onRecoveryPending,
                        );
                    }
                    const [
                        inputStat,
                        analysisStat,
                    ] = await Promise.all([
                        stat(pageInput.inputPath),
                        stat(pageInput.analysisInputPath),
                    ]);
                    const sharedInode = inputStat.ino !== 0 && inputStat.ino === analysisStat.ino;
                    const actualBytes = sharedInode
                        ? inputStat.size
                        : inputStat.size + analysisStat.size;
                    stagedFileSizes.set(plan.pageNumber, {
                        inputBytes: inputStat.size,
                        analysisBytes: analysisStat.size,
                        sharedInode,
                    });
                    rasterizedPageNumbers.add(plan.pageNumber);
                    if (!renderingStarted) {
                        emitProgress('rasterizing', rasterizedPageNumbers.size, pageCount, rasterizedPageNumbers);
                    }
                    return {
                        staged: item,
                        actualBytes,
                    };
                } catch (error) {
                    if (getUnprovenNativeTerminationDetail(error) === undefined) {
                        await cleanupStagedItems([item]);
                    }
                    throw error;
                }
            },
            consumeChunk: async (chunkItems, chunkIndex, operationSignal) => {
                const needsInkPriorForChunk = inkPriorEligible && (
                    chunkItems.length < allManifestPages.length
                    || checkpoint !== undefined
                    || resolvedDocumentInkPrior !== null
                );
                const chunkManifest = {
                    ...fullManifest,
                    ...(needsInkPriorForChunk
                        ? resolvedDocumentInkPrior !== null
                            ? {documentInkPrior: resolvedDocumentInkPrior}
                            : {inkCalibrationPages: eligibleInkCalibrationPages}
                        : {}),
                    pages: chunkItems.map(item => item.manifestPage),
                };
                const manifestPath = join(scratch, `cleanup-manifest-${String(chunkIndex)}.json`);
                await writeFile(manifestPath, JSON.stringify(chunkManifest));
                const analysisReleasePromises: Array<Promise<void>> = [];
                const releasedAnalysisPages = new Set<number>();
                const sourcePageNumberByManifestIndex = new Map(chunkItems.map((item, index) => [
                    index + 1,
                    item.plan.pageNumber,
                ]));
                const analysisPathBySourcePage = new Map(chunkItems.map(item => [
                    item.plan.pageNumber,
                    item.pageInput.analysisInputPath,
                ]));
                const reportNativeProgress = (nativeProgress: TNativeScanCleanupProgressV3) => {
                    if (nativeProgress.stage !== 'page-complete') {
                        return;
                    }
                    if (nativeProgress.pageNumber !== undefined) {
                        const sourcePageNumber = sourcePageNumberByManifestIndex.get(nativeProgress.pageNumber);
                        if (sourcePageNumber === undefined) {
                            throw new Error(
                                `Native cleanup reported unknown manifest page index ${String(nativeProgress.pageNumber)}`,
                            );
                        }
                        renderedPageNumbers.add(sourcePageNumber);
                        if (!releasedAnalysisPages.has(sourcePageNumber)) {
                            releasedAnalysisPages.add(sourcePageNumber);
                            const analysisPath = analysisPathBySourcePage.get(sourcePageNumber);
                            if (analysisPath !== undefined) {
                                const release = rm(analysisPath, {force: true});
                                // Attach a handler immediately so a sidecar failure
                                // cannot turn a best-effort scratch release into an
                                // unhandled rejection before the chunk barrier
                                // has a chance to observe it.
                                void release.catch(() => undefined);
                                analysisReleasePromises.push(release);
                            }
                        }
                    }
                    emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
                };
                renderingStarted = true;
                emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
                try {
                    await dependencies.runSidecar(
                        paths.scanCleanupBinary,
                        manifestPath,
                        operationSignal,
                        log,
                        reportNativeProgress,
                        {
                            allowedPathRoot: scratch,
                            onRecoveryPending,
                            onResult: result => {
                                if (result.documentInkPrior !== undefined) {
                                    resolvedDocumentInkPrior = result.documentInkPrior;
                                }
                            },
                        },
                    );
                } finally {
                    await observeScanCleanupAnalysisReleasePromises(analysisReleasePromises, log);
                }
                for (const item of chunkItems) {
                    renderedPageNumbers.add(item.plan.pageNumber);
                }
                if (checkpoint !== undefined && renderPlanSignature !== null) {
                    const commitEntries = await Promise.all(chunkItems.map(async item => ({
                        pageNumber: item.plan.pageNumber,
                        artifacts: await collectExistingPageCheckpointArtifacts(item.manifestPage),
                    })));
                    await checkpoint.commitCompletedPages(
                        commitEntries,
                        renderPlanSignature,
                        checkpointScopeKey,
                        resolvedDocumentInkPrior,
                    );
                }
            },
            cleanupStaged: cleanupStagedItems,
        });
    }
    emitProgress('collecting', 0, pageCount, collectedPageNumbers);
    for (const [
        pageIndex,
        page,
    ] of allManifestPages.entries()) {
        const {outputs} = page;
        const pageMetadata = decodeNativeScanCleanupPageMetadataJson(
            await readFile(page.pageMetadataPath, 'utf8'),
        );
        const sourcePageNumber = page.sourcePageIndex + 1;
        collectedPageNumbers.add(sourcePageNumber);
        pageMetadataBySource.set(sourcePageNumber, pageMetadata);
        emitProgress('collecting', pageIndex + 1, pageCount, collectedPageNumbers);
            if (pageMetadata.excluded) {
                summary.excludedPages += 1;
                emptyOutputMappings.push({
                    sourcePage: sourcePageNumber,
                    half: 'full',
                    outputOrdinal: null,
                    rotationDegrees: pageMetadata.rotationDegrees,
                    excluded: true,
                    blank: false,
                });
                continue;
            }
            summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
            const pageOutputPages: typeof outputPages = [];
            let intentionallyBlankOutputCount = 0;
            for (const [
                outputIndex,
                output,
            ] of outputs.entries()) {
            // The sidecar publishes one raster per output and writes this
            // metadata beside it, so its absence means the output half was
            // never produced.
                let metadataJson: string;
                try {
                    metadataJson = await readFile(output.metadataPath, 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    // Native resolves only the first output_count destinations
                    // for this page. The remaining plan entries are not
                    // produced outputs; when native also reports blank outputs,
                    // retain their explicit empty mapping below.
                    if (outputIndex >= pageMetadata.outputCount) {
                        if (pageMetadata.blankOutputsSkipped > 0) {
                            intentionallyBlankOutputCount += 1;
                        }
                        continue;
                    }
                    throw new ScanCleanupMissingOutputError(
                        sourcePageNumber,
                        output.metadataPath,
                        'output metadata',
                        getErrorMessage(error),
                    );
                }
                const metadata = decodeNativeScanCleanupOutputMetadataJson(metadataJson);
                const pageNumber = sourcePageNumber;
                let bilevelPath: string | undefined;
                let backgroundPath: string | undefined;
                let foregroundMaskPath: string | undefined;
                let foregroundAlphaPath: string | undefined;
                let backgroundIsColor: boolean | undefined;
                let compositePath = output.outputPath;
                let validationFallbackSource: IRenderedCleanupOutputPage['preservedSource'];
                if (metadata.layeredWritten) {
                    const candidateBackgroundPath = await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.backgroundOutputPath ?? undefined,
                        requirePageNumber(pageNumber),
                        'mixed background layer',
                    );
                    if (metadata.layeredForegroundKind === 'soft-alpha') {
                        foregroundAlphaPath = await requireProducedRasterFile(
                            requirePublishedRaster,
                            output.foregroundAlphaOutputPath ?? undefined,
                            pageNumber,
                            'mixed soft foreground alpha',
                        );
                    } else {
                        foregroundMaskPath = await requireProducedRasterFile(
                            requirePublishedRaster,
                            output.foregroundMaskOutputPath ?? undefined,
                            pageNumber,
                            'mixed foreground mask',
                        );
                    }
                    const [
                        backgroundHeader,
                        foregroundHeader,
                    ] = await Promise.all([
                        readPpmDimensions(candidateBackgroundPath),
                        foregroundAlphaPath === undefined
                            ? readPbmDimensions(foregroundMaskPath!)
                            : readPgmDimensions(foregroundAlphaPath),
                    ]);
                    const layerMismatch = describeScanCleanupMixedLayerMismatch(
                        resolveScanCleanupMixedLayerExpectation(
                            metadata,
                            metadata.renderDpi ?? pageDpi.get(pageNumber) ?? documentDpi,
                            pageNumber,
                        ),
                        backgroundHeader,
                        foregroundHeader,
                    );
                    if (layerMismatch !== null) {
                        backgroundPath = undefined;
                        foregroundMaskPath = undefined;
                        foregroundAlphaPath = undefined;
                        backgroundIsColor = undefined;
                        let fallbackDescription = 'the non-MRC composite path';
                        try {
                            compositePath = await requireProducedRasterFile(
                                requirePublishedRaster,
                                output.outputPath,
                                pageNumber,
                                'non-MRC composite fallback after invalid mixed layers',
                            );
                        } catch (error) {
                            if (!(error instanceof ScanCleanupMissingOutputError)) throw error;
                            validationFallbackSource = pageMetadata.layoutClassification === 'single-uncut-page'
                            && pageMetadata.outputCount === 1
                            && metadata.half === 'full'
                                ? resolveFullSourcePagePreservation(
                                    pageNumber,
                                    pageGeometryByNumber.get(pageNumber),
                                )
                                : undefined;
                            if (
                                validationFallbackSource === undefined
                            || paths.pdfPageOpsBinary === undefined
                            ) {
                                throw error;
                            }
                            compositePath = join(
                                scratch,
                                `mixed-layer-fallback-${String(pageNumber)}-${String(outputIndex)}.ppm`,
                            );
                            await writeFile(compositePath, FALLBACK_MIXED_LAYER_PPM);
                            fallbackDescription = 'the original source page';
                        }
                        const warning = `Page ${pageNumber} mixed layer dimensions do not match metadata `
                            + `${layerMismatch}; using ${fallbackDescription}`;
                        report(warning, 'error');
                    } else {
                        backgroundPath = candidateBackgroundPath;
                        backgroundIsColor = backgroundHeader.isColor;
                    }
                } else if (metadata.bilevelWritten) {
                    bilevelPath = await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.bilevelOutputPath ?? undefined,
                        pageNumber,
                        'bilevel output',
                    );
                } else {
                    await requireProducedRasterFile(
                        requirePublishedRaster,
                        output.outputPath,
                        pageNumber,
                        'composite output',
                    );
                }
                const renderedOutput: Omit<IRenderedCleanupOutputPage, 'preservedSource'> = {
                    sourcePageNumber: pageNumber,
                    path: compositePath,
                    ...(bilevelPath === undefined ? {} : {bilevelPath}),
                    ...(backgroundPath === undefined ? {} : {backgroundPath}),
                    ...(foregroundMaskPath === undefined ? {} : {foregroundMaskPath}),
                    ...(foregroundAlphaPath === undefined ? {} : {foregroundAlphaPath}),
                    ...(backgroundIsColor === undefined ? {} : {backgroundIsColor}),
                    dpi: metadata.renderDpi
                    ?? pageDpi.get(pageNumber)
                    ?? documentDpi,
                    // The engine reports the mode it actually rendered with,
                    // which is the only authority once `auto` resolves natively.
                    resolvedOutputMode: (metadata.outputMode === 'auto' ? undefined : metadata.outputMode)
                    ?? resolvePageOutputMode(pageNumber)
                    ?? 'color',
                    metadata,
                };
                const preservedSource = validationFallbackSource
                ?? resolveCompactSourcePreservation(
                    request,
                    pageNumber,
                    pageMetadata,
                    renderedOutput,
                    pageGeometryByNumber.get(pageNumber),
                    detectedRasterByPage.get(pageNumber),
                );
                pageOutputPages.push({
                    ...renderedOutput,
                    ...(preservedSource === undefined ? {} : {preservedSource}),
                });
                if (!metadata.skewApplied) summary.deskewSkipped += 1;
                if (request.options.crop && metadata.contentBox == null) summary.cropSkipped += 1;
                reportScanCleanupNativeWarnings(
                    summary,
                    metadata,
                    pageNumber,
                    fittedMarginBoxPages,
                    report,
                );
            }
            outputPages.push(...collectScanCleanupPageOutputs({
                request,
                sourcePageNumber,
                pageMetadata,
                pageOutputPages,
                intentionallyBlankOutputCount,
                emptyOutputMappings,
            }));
            if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
    }
    if (fittedMarginBoxPages.size > 0) {
        reportScanCleanupSummaryWarningEvent(summary, {event: {
            code: 'matched-canvas-content-fitted-pages',
            pages: [...fittedMarginBoxPages].map(pageNumber => requirePageNumber(pageNumber)),
        }}, report);
    }
    summary.outputPages = outputPages.length;
    if (outputPages.length === 0 && !streamingChild) {
        throw new ScanCleanupContractError('evb-scan-cleanup produced no output pages');
    }
    const combineManifestPages = outputPages.map(output => serializeScanCleanupCombinePage(
        planScanCleanupCombinePage(output, trustedMrcLayersByPage.get(output.sourcePageNumber)),
    ));
    const hasCompactSourcePages = outputPages.some(output => output.preservedSource !== undefined);
    const outputMappings = buildScanCleanupOutputMappings(outputPages, emptyOutputMappings);
    const effectiveOptions = mapScanCleanupPageScope(pageNumbers, (sourcePage) => {
        const page = manifestPageBySource.get(sourcePage);
        if (page === undefined) {
            throw new ScanCleanupContractError(
                `Scan cleanup lost manifest page ${String(sourcePage)} during batching`,
            );
        }
        return {
            sourcePage,
            options: materializeScanCleanupStampOptions({
                nativeOptions: page.options,
                options,
                qualityPath: 'raster',
            }),
        };
    });
    const pagePlanDigests = effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
        record.sourcePage,
        record.options,
        pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
    ));
    const assemblerBackend = request.assemblyBackend
        ?? paths.assemblyBackend
        ?? (hasCompactSourcePages
            ? isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
                ? 'cli-fallback-qpdf-page-ops'
                : 'native-pdf-page-ops'
            : isScanCleanupCliFallbackSentinel(paths.pdfImageCombineBinary)
                ? 'cli-fallback-wasm-or-img2pdf-qpdf'
                : 'native-pdf-image-combine');
    const transportMode = request.transportMode
        ?? paths.transportMode
        ?? (rasterHandoff.format === 'ppm' ? 'file-ppm' : 'file-png');
    const buildIds = await buildScanCleanupStampBuildIds({
        paths,
        assemblerBackend,
        transportMode,
        ...(dependencies.hashNativeBinary === undefined
            ? {}
            : {hashNativeBinary: dependencies.hashNativeBinary}),
        ...(request.provenance === undefined
            ? {}
            : {reusableNativeBinarySha256s: request.provenance.nativeBinarySha256s}),
    });
    const stamp = buildScanCleanupProvenanceStamp({
        sourceSha256: request.provenance?.sourceSha256 ?? await sha256ScanCleanupFile(preparedPdfPath),
        effectiveOptions,
        outputMappings,
        pagePlanDigests,
        buildIds,
    });
    const provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
    await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    if (outputPages.length === 0) {
        // An empty batch of a multi-batch run still accounts for its pages in
        // the run's stamp and mappings; it has no PDF to assemble.
        await writeFile(join(scratch, 'scan-cleanup-representation-report.json'), JSON.stringify({
            outputMappings,
            pages: [],
        }));
        return summary;
    }
    const combineManifest = buildScanCleanupCompactManifest(
        combineManifestPages,
        provenanceStampHex,
    );
    const combineManifestEnvelopePath = join(scratch, 'combine-manifest.json');
    const combineManifestLegacyPath = join(scratch, 'combine-manifest.tsv');
    await Promise.all([
        writeFile(
            combineManifestEnvelopePath,
            serializeScanCleanupCompactManifest(combineManifest),
        ),
        writeFile(
            combineManifestLegacyPath,
            serializeLegacyScanCleanupCompactManifest(combineManifest),
        ),
    ]);
    const combineManifestPath = paths.provenanceStampSupport === false
        ? combineManifestLegacyPath
        : combineManifestEnvelopePath;
    emitProgress('assembling', 0, outputPages.length, []);
    const rasterizedPdfPath = hasCompactSourcePages
        ? join(scratch, 'rasterized-cleaned.pdf')
        : stagedPdfPath;
    await dependencies.runCommand(paths.pdfImageCombineBinary, [
        '--output',
        rasterizedPdfPath,
        '--compact-manifest',
        combineManifestPath,
        '--json-progress',
    ], {
        signal,
        commandLabel: 'evb-pdf-image-combine(scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        env: {
            ...process.env,
            ...resolveScanCleanupCombineEnv(outputPages.length),
        },
        onStdout: createPdfCombineProgressHandler(
            outputPages.length,
            (processed, total) => emitProgress('assembling', processed, total),
            line => log('debug', `Ignoring malformed scan cleanup combine progress: ${line}`),
        ),
        log,
    });
    const textLayerPlan = buildScanCleanupTextLayerPlanFromPageSizeMap(outputPages, pageGeometryByNumber);
    await assembleWithCompactSourcePages(
        outputPages,
        paths,
        preparedPdfPath,
        rasterizedPdfPath,
        stagedPdfPath,
        scratch,
        signal,
        log,
        dependencies,
        provenanceStampHex,
        textLayerPlan,
        onRecoveryPending,
    );
    collectSourceText(sourceText, textLayerPlan);
    if (textLayerPlan.skippedNonAffine.length > 0) {
        log(
            'debug',
            'Scan cleanup skipped source text on pages without safe affine geometry: '
            + describePageNumbers(textLayerPlan.skippedNonAffine),
        );
    }
    const [
        sourceFile,
        outputFile,
    ] = await Promise.all([
        stat(preparedPdfPath),
        stat(stagedPdfPath),
    ]);
    if (outputFile.size <= 0) throw new ScanCleanupContractError('PDF assembler produced an empty file');
    const compactSourceBudget = resolveScanCleanupCompactSourceBudget({
        documentPageCount,
        options: request.options,
        rasterByPage: detectedRasterByPage,
        partialRun: request.sourcePageNumbers !== undefined
            || request.sourcePageRange !== undefined,
        sourceBytes: sourceFile.size,
    });
    const streamBytesByOutput = new Map<IRenderedCleanupOutputPage, NonNullable<
        IScanCleanupOutputPageForSummary['streamBytes']
    >>();
    await Promise.all(outputPages.map(async output => {
        const [
            composite,
            bilevel,
            background,
            foregroundMask,
            foregroundAlpha,
        ] = await Promise.all([
            readOptionalFileSize(output.path),
            output.bilevelPath === undefined
                ? Promise.resolve(undefined)
                : readOptionalFileSize(output.bilevelPath),
            output.backgroundPath === undefined
                ? Promise.resolve(undefined)
                : readOptionalFileSize(output.backgroundPath),
            output.foregroundMaskPath === undefined
                ? Promise.resolve(undefined)
                : readOptionalFileSize(output.foregroundMaskPath),
            output.foregroundAlphaPath === undefined
                ? Promise.resolve(undefined)
                : readOptionalFileSize(output.foregroundAlphaPath),
        ]);
        streamBytesByOutput.set(output, {
            ...(composite === undefined ? {} : {composite}),
            ...(bilevel === undefined ? {} : {bilevel}),
            ...(background === undefined ? {} : {background}),
            ...(foregroundMask === undefined ? {} : {foregroundMask}),
            ...(foregroundAlpha === undefined ? {} : {foregroundAlpha}),
        });
    }));
    const representationReport = {
        schemaVersion: 1 as const,
        sourceBytes: sourceFile.size,
        outputBytes: outputFile.size,
        outputToSourceByteRatio: outputFile.size / sourceFile.size,
        compactSourceBudget,
        outputMappings,
        pages: outputPages.map((output, outputIndex) => buildScanCleanupRepresentationPage(output, outputIndex, {
            sourceDpi: resolvePageSourceDpi(output.sourcePageNumber),
            sourceRaster: detectedRasterByPage.get(output.sourcePageNumber),
            streamBytes: streamBytesByOutput.get(output),
        })),
    } satisfies IScanCleanupRepresentationReport;
    await writeFile(
        join(scratch, 'scan-cleanup-representation-report.json'),
        JSON.stringify(representationReport, null, 2),
    );
    assertScanCleanupCompactSourceBudget(outputFile.size, compactSourceBudget);
    await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
    return summary;
}
