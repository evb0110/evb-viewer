 

import {
    createReadStream,
    constants as fsConstants,
} from 'fs';
import {
    access,
    copyFile,
    open,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import {
    dirname,
    join,
} from 'path';
import type {
    INativeScanCleanupPageV3,
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupDetectionResult,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupProgressV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupSummaryWarningEvent,
    TScanCleanupWarningEvent,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupOutputPlacement,
} from '@contracts/scanCleanupPageOverrides';
import {
    resolveScanCleanupPlacementAnchorFromSummary,
    resolveScanCleanupSheetHeightPoints,
} from '@evb/scan-cleanup/core/placementAnchors';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {
    assertCanonicalPdfPageSizes,
    detectSourceDpiFromPageSizes,
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IScanCleanupOutputPageForSummary,
    type IScanCleanupOutputMapping,
    type IScanCleanupRepresentationReport,
    type IPdfMrcLayers,
    type IPdfPageSize,
    type IDetectedPageRaster,
    type IScanCleanupRasterRenderLimits,
    type IScanCleanupPageRasterSource,
    type IScanCleanupSidecarProtocolCapabilities,
    type ISourceDpiDetectionResult,
    type IPdfPageSizeChunk,
    type TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import {
    mapScanCleanupPageScope,
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {
    collectScanCleanupPageBatch,
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
    runScanCleanupPageBatches,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@evb/scan-cleanup/core/pageBatches';
import {
    ScanCleanupContractError,
    ScanCleanupMissingOutputError,
    ScanCleanupNativeToolUnavailableError,
    ScanCleanupPdfValidationError,
    SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE,
    ScanCleanupStreamingEvidenceError,
} from '@evb/scan-cleanup/core/errors';
import {createPdfCombineProgressHandler} from '@evb/scan-cleanup/core/createPdfCombineProgressHandler';
import {
    buildScanCleanupCompactManifest,
    isScanCleanupCliFallbackSentinel,
    serializeScanCleanupTextLayerInstructions,
    serializeLegacyScanCleanupCompactManifest,
    serializeScanCleanupCompactManifest,
} from '@evb/scan-cleanup/core/compactManifest';
import {
    buildScanCleanupTextLayerPlan,
    buildScanCleanupTextLayerPlanFromPageSizeStore,
} from '@evb/scan-cleanup/core/sourceTextLayer';
import {buildScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/buildManifest';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    sha256ScanCleanupFile,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {
    createPdfPageSizeStore,
    PDF_PAGE_SIZE_STORE_MAX_READ_PAGES,
    PdfPageSizeStore,
    toCropBoxPageSize,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    buildGeometryOnlyNativeScanCleanupManifest,
    buildRunnableNativeScanCleanupManifest,
} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {assertNativeScanCleanupManifestGeometry} from '@evb/scan-cleanup/core/policy/assertNativeScanCleanupManifestGeometry';
import {
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupDocumentCanvasRenderDpi,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDroppedMatchWarningEventFromAccumulator,
    resolveMatchedCanvasResamplePages,
    resolveScanCleanupUnclassifiedPages,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {
    resolveTonalJpegQuality,
    SCAN_CLEANUP_COLOR_JPEG_QUALITY,
    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
    resolveScanCleanupCanvasPageDpi,
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupPlannedDpi,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    SCAN_CLEANUP_SIZE_PROBE_DPI,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
    shouldExtractTrustedMrcForeground,
} from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';
import {
    readPbmDimensions,
    readPngDimensions,
    readPpmDimensions,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    resolveCombineOutputByteCap,
    resolveRasterHandoff,
    runRasterProducerConsumer,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {preserveScanCleanupJsonEvidence} from '@evb/scan-cleanup/core/preserveScanCleanupJsonEvidence';
import {runLosslessScanCleanup} from '@evb/scan-cleanup/core/runLosslessScanCleanup';
import {DETECTION_DPI} from '@evb/scan-cleanup/core/detection';
import {createScanCleanupScratchDir} from '@evb/scan-cleanup/core/scratchCleanup';
import {
    describePageNumbers,
    formatScanCleanupWarningEvent,
    toScanCleanupDpiThousandths,
} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {
    assembleWithCompactSourcePages,
    type IRenderedCleanupOutputPage,
    resolveCompactSourcePreservation,
    resolveFullSourcePagePreservation,
    sourceMrcForegroundPdfMatrix,
} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';

export function reportScanCleanupNativeWarnings(
    summary: TScanCleanupSummary,
    metadata: Pick<INativeScanCleanupOutputMetadataV3, 'half' | 'warnings' | 'warningEvents'>,
    pageNumber: number,
    sidecarCapabilities: IScanCleanupSidecarProtocolCapabilities | undefined,
    fittedMarginBoxPages: Set<number>,
    report: (message: string) => void,
) {
    if (sidecarCapabilities?.structuredWarningEventsSupported === true) {
        for (const event of metadata.warningEvents ?? []) {
            // One aggregate names every page the document's scale could not
            // hold; per-page lines would bury it.
            if (event.code === 'matched-canvas-content-fitted') {
                fittedMarginBoxPages.add(pageNumber);
                continue;
            }
            reportScanCleanupSummaryWarningEvent(summary, {
                event,
                pageNumber: requirePageNumber(pageNumber),
                ...(metadata.half === undefined ? {} : {half: metadata.half}),
            }, report);
        }
    }
    // Diagnostics the engine carries no structure for. An artifact written
    // before runtime revision 10 still carries these sentences.
    for (const warning of metadata.warnings ?? []) {
        report(`Page ${String(pageNumber)}: ${warning}`);
    }
}

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

// Native manifests admit a larger transport window, but the production
// coordinator keeps its page plans, raster facts, and qpdf arguments to one
// smaller resident batch. The larger native limit is not a document limit.
const PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
const QPDF_MERGE_INPUT_WINDOW = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
const STREAMING_JSONL_MAX_LINE_BYTES = 4 * 1024 * 1024;
const PAGE_GEOMETRY_SIDECAR_FORMAT = 'evb-scan-cleanup-page-geometry';
const PAGE_GEOMETRY_SIDECAR_SCHEMA_VERSION = 1;

type TJsonlFileHandle = Awaited<ReturnType<typeof open>>;

type TScanCleanupDpiDetails = IScanCleanupPageRasterSource | ISourceDpiDetectionResult;
type TScanCleanupDocumentCanvas = NonNullable<
    ReturnType<typeof resolveScanCleanupDocumentCanvasFromAccumulator>
>;

function hasCompletePageRasterCoverage(
    pageRasterByNumber: ReadonlyMap<number, IDetectedPageRaster>,
    documentPageCount: number,
) {
    if (pageRasterByNumber.size !== documentPageCount) {
        return false;
    }
    for (let pageNumber = 1; pageNumber <= documentPageCount; pageNumber += 1) {
        if (!pageRasterByNumber.has(pageNumber)) {
            return false;
        }
    }
    return true;
}

/**
 * The old pdfimages result is still accepted by direct callers. Production
 * retention can return the bounded accessor instead, which lets final page
 * work ask for one raster fact without retaining a document-sized Map.
 */
function resolvePageRasterSource(
    source: TScanCleanupDpiDetails,
    documentPageCount: number,
): IScanCleanupPageRasterSource {
    if ('getPageRaster' in source) {
        return source;
    }
    let compactLayeredPageCount = 0;
    for (const raster of source.pageRasterByNumber.values()) {
        if (
            raster.hasBilevelLayer === true
            && raster.backgroundDpi !== undefined
            && Number.isFinite(raster.backgroundDpi)
            && raster.backgroundDpi > 0
        ) {
            compactLayeredPageCount += 1;
        }
    }
    const hasCompleteCoverage = hasCompletePageRasterCoverage(
        source.pageRasterByNumber,
        documentPageCount,
    );
    return {
        detected: source.pageRasterByNumber.size > 0,
        documentDpi: source.documentDpi,
        compactLayeredPageCount,
        compactLayeredPageCountComplete: hasCompleteCoverage,
        getPageRaster: pageNumber => source.pageRasterByNumber.get(pageNumber),
    };
}

function scanCleanupUsesInkPlacement(
    options: IRunScanCleanupPipelineRequest['options'],
) {
    if (!options.matchPageSize) {
        return false;
    }
    if (options.pageAlignment === 'ink') {
        return true;
    }
    if (Object.values(options.pageOverrideDefaults?.placementOverrides ?? {})
        .some(alignment => alignment === 'ink')) {
        return true;
    }
    return Object.values(options.pageOverrides).some(override => Object
        .values(override.placementOverrides ?? {})
        .some(alignment => alignment === 'ink'));
}

function assertScanCleanupInkAnchorCapacity(
    pageCount: number,
    options: IRunScanCleanupPipelineRequest['options'],
    placementAnchorSummary: IRunScanCleanupPipelineRequest['placementAnchorSummary'],
) {
    if (
        pageCount > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
        && scanCleanupUsesInkPlacement(options)
        && placementAnchorSummary === undefined
    ) {
        throw new ScanCleanupContractError(SCAN_CLEANUP_INK_ANCHOR_CAPACITY_MESSAGE);
    }
}

interface IScanCleanupConversionContext {
    /** Internal child-run context. It is never serialized across IPC. */
    documentCanvas?: TScanCleanupDocumentCanvas | null;
    dpiDetails?: TScanCleanupDpiDetails;
    /** Child runs already have the parent document canvas. */
    skipDocumentCanvasMeasurement?: boolean;
    /** Child runs use the parent's sequential geometry sidecar cursor. */
    skipPageSizeValidation?: boolean;
    smallCompatibilityRun?: boolean;
}

async function appendJsonLine(handle: TJsonlFileHandle, value: unknown) {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, 'utf8') > STREAMING_JSONL_MAX_LINE_BYTES) {
        throw new Error(`Scan cleanup JSONL record exceeds ${String(STREAMING_JSONL_MAX_LINE_BYTES)} bytes`);
    }
    await handle.write(line);
}

async function* readJsonLines<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
    const stream = createReadStream(path, {highWaterMark: 512 * 1024});
    let pending = Buffer.alloc(0);
    try {
        for await (const chunk of stream) {
            signal?.throwIfAborted();
            pending = pending.length === 0
                ? Buffer.from(chunk as Uint8Array)
                : Buffer.concat([
                    pending,
                    Buffer.from(chunk as Uint8Array),
                ]);
            if (pending.length > STREAMING_JSONL_MAX_LINE_BYTES) {
                throw new Error(`Scan cleanup JSONL record exceeds ${String(STREAMING_JSONL_MAX_LINE_BYTES)} bytes`);
            }
            let newline = pending.indexOf(0x0a);
            while (newline >= 0) {
                signal?.throwIfAborted();
                const line = pending.subarray(0, newline).toString('utf8').trim();
                pending = pending.subarray(newline + 1);
                if (line.length > 0) {
                    yield JSON.parse(line) as T;
                }
                newline = pending.indexOf(0x0a);
            }
        }
        signal?.throwIfAborted();
        if (pending.length > 0) {
            const line = pending.toString('utf8').trim();
            if (line.length > 0) yield JSON.parse(line) as T;
        }
    } finally {
        stream.destroy();
    }
}

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
        if (chunkPages.length >= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
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

/**
 * Keep the old injectable array reader usable for focused tests and small
 * callers. The production path never enters this adapter. The returned store
 * still exposes bounded chunks to the rest of the conversion.
 */
function createPageSizeStoreFromArrayReader(
    readPageSizes: NonNullable<IRunScanCleanupPipelineDependencies['getPageSizes']>,
    pdfPath: string,
    options: Parameters<NonNullable<IRunScanCleanupPipelineDependencies['getPageSizes']>>[1],
) {
    return new PdfPageSizeStore(async function* () {
        const pageSizes = await readPageSizes(pdfPath, options);
        assertCanonicalPdfPageSizes(pageSizes, 'Scan cleanup conversion');
        if (pageSizes.length > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            throw new RangeError(
                `Scan cleanup legacy page-size arrays are limited to ${String(PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES)} pages`,
            );
        }
        for (let start = 0; start < pageSizes.length; start += PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            const pages = pageSizes.slice(start, start + PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES);
            yield {
                pageCount: pageSizes.length,
                chunkIndex: Math.floor(start / PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES),
                firstPageNumber: start + 1,
                offset: 0,
                byteLength: 0,
                pages,
            };
        }
    });
}

/** Build a bounded source from detection metadata without copying all pages. */
function createPageSizeStoreFromMetadata(
    metadataByPage: Partial<Record<string, IScanCleanupSourcePageMetadata>>,
    documentPageCount: number,
) {
    return new PdfPageSizeStore(async function* () {
        // Keep this adapter's execution asynchronous like the native sidecar
        // reader. It is only used for supplied test/detection metadata.
        await Promise.resolve();
        let chunkIndex = 0;
        for (
            let firstPageNumber = 1;
            firstPageNumber <= documentPageCount;
            firstPageNumber += PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES
        ) {
            const pages: IPdfPageSize[] = [];
            const lastPageNumber = Math.min(
                documentPageCount,
                firstPageNumber + PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES - 1,
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

function resolveBlankOutputHalves(
    pageMetadata: INativeScanCleanupPageMetadataV3,
    pageOutputPages: readonly IRenderedCleanupOutputPage[],
    missingOutputCount: number,
): Array<IScanCleanupOutputMapping['half']> {
    if (missingOutputCount <= 0) {
        return [];
    }
    if (pageMetadata.layoutClassification !== 'two-page-spread') {
        return Array.from({length: missingOutputCount}, () => 'full');
    }
    const producedHalves = new Set(
        pageOutputPages
            .map(output => output.metadata.half)
            .filter((half): half is 'left' | 'right' => half === 'left' || half === 'right'),
    );
    const unproducedHalves = ([
        'left',
        'right',
    ] as const).filter(half => !producedHalves.has(half));
    return Array.from(
        {length: missingOutputCount},
        (_, index) => unproducedHalves[index] ?? 'full',
    );
}

function validatePdfImagePlacement(
    placement: NonNullable<INativeScanCleanupOutputMetadataV3['pdfImagePlacement']>,
    pageWidthPoints: number,
    pageHeightPoints: number,
    pageNumber: number,
) {
    const values = [
        placement.xPoints,
        placement.yPoints,
        placement.widthPoints,
        placement.heightPoints,
    ];
    const tolerancePoints = 0.0001;
    if (
        !values.every(Number.isFinite)
        || placement.xPoints < 0
        || placement.yPoints < 0
        || placement.widthPoints <= 0
        || placement.heightPoints <= 0
        || placement.xPoints + placement.widthPoints > pageWidthPoints + tolerancePoints
        || placement.yPoints + placement.heightPoints > pageHeightPoints + tolerancePoints
    ) {
        throw new Error(`Page ${String(pageNumber)} PDF image placement is outside its MediaBox`);
    }
    return values;
}

const SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS = 0.001;

function resolveSourceMrcReuseRejection(
    page: IPdfPageSize,
    detectedRaster: IDetectedPageRaster | undefined,
): string | undefined {
    const samePoints = (left: number | undefined, right: number | undefined) =>
        left !== undefined
        && right !== undefined
        && Number.isFinite(left)
        && Number.isFinite(right)
        && Math.abs(left - right) <= SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS;
    const hasMediaGeometry = page.mediaXPoints !== undefined
        && page.mediaYPoints !== undefined
        && page.mediaWidthPoints !== undefined
        && page.mediaHeightPoints !== undefined;
    const hasCropGeometry = page.cropXPoints !== undefined
        && page.cropYPoints !== undefined
        && page.cropWidthPoints !== undefined
        && page.cropHeightPoints !== undefined;
    if (page.rotation % 360 !== 0) {
        return 'source page rotation is not zero';
    }
    if (page.xPoints !== 0 || page.yPoints !== 0) {
        return 'source page origin is not zero';
    }
    if (!hasMediaGeometry || !samePoints(page.mediaXPoints, 0) || !samePoints(page.mediaYPoints, 0)) {
        return 'source MediaBox geometry is unavailable or offset';
    }
    if (
        !samePoints(page.mediaWidthPoints, page.widthPoints)
        || !samePoints(page.mediaHeightPoints, page.heightPoints)
    ) {
        return 'source MediaBox does not match the displayed page';
    }
    if (hasCropGeometry && (
        !samePoints(page.cropXPoints, page.xPoints)
        || !samePoints(page.cropYPoints, page.yPoints)
        || !samePoints(page.cropWidthPoints, page.widthPoints)
        || !samePoints(page.cropHeightPoints, page.heightPoints)
    )) {
        return 'source CropBox does not match the displayed page';
    }
    if (
        detectedRaster?.width === undefined
        || detectedRaster.height === undefined
        || detectedRaster.width <= 0
        || detectedRaster.height <= 0
        || detectedRaster.dpi <= 0
        || !samePoints(detectedRaster.width / detectedRaster.dpi * 72, page.widthPoints)
        || !samePoints(detectedRaster.height / detectedRaster.dpi * 72, page.heightPoints)
    ) {
        return 'dominant source image placement is not proven';
    }
    if (
        !samePoints(page.dominantImageWidthPoints, page.widthPoints)
        || !samePoints(page.dominantImageHeightPoints, page.heightPoints)
        || page.dominantImageWidthPx === undefined
        || page.dominantImageHeightPx === undefined
        || page.dominantImageWidthPx <= 0
        || page.dominantImageHeightPx <= 0
    ) {
        return 'dominant source image placement is not proven';
    }
    return undefined;
}

function resolveSourceMrcLayerRejection(
    page: IPdfPageSize,
    layers: IPdfMrcLayers,
): string | undefined {
    const widthPoints = layers.foregroundWidth / layers.foregroundDpi * 72;
    const heightPoints = layers.foregroundHeight / layers.foregroundDpi * 72;
    if (
        !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || Math.abs(widthPoints - page.widthPoints) > SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS
        || Math.abs(heightPoints - page.heightPoints) > SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS
    ) {
        return 'extracted foreground dimensions do not match the displayed page';
    }
    return undefined;
}

type TResolvedPagePlan = ReturnType<ReturnType<typeof createPagePlanResolver>['resolve']>;

function buildConversionPageMetadata({
    documentPriorByPage,
    layoutByPage,
    pageMetadataPath,
    pageNumber,
    resolvedPagePlan,
}: {
    documentPriorByPage: IRunScanCleanupPipelineRequest['documentPriorByPage'];
    layoutByPage: IRunScanCleanupPipelineRequest['layoutByPage'];
    pageMetadataPath: string;
    pageNumber: number;
    resolvedPagePlan: TResolvedPagePlan | undefined;
}) {
    return {
        ...(layoutByPage?.[String(pageNumber)] === undefined
            ? {}
            : {observedLayout: layoutByPage[String(pageNumber)]}),
        ...(documentPriorByPage?.[String(pageNumber)] === undefined
            ? {}
            : {documentPrior: documentPriorByPage[String(pageNumber)]}),
        ...resolvedPagePlan,
        pageMetadataPath,
    };
}

function createNonClosingPageSizeStore(store: IPdfPageSizeStore): IPdfPageSizeStore {
    return {
        get pageCount() {
            return store.pageCount;
        },
        getPage: pageNumber => store.getPage(pageNumber),
        readRange: (firstPageNumber, lastPageNumberExclusive) =>
            store.readRange(firstPageNumber, lastPageNumberExclusive),
        forEachChunk: onChunk => store.forEachChunk(onChunk),
        close: () => Promise.resolve(),
    };
}

async function mergeScanCleanupPdfPathSidecarUnchecked({
    inputPath,
    inputCount,
    scratch,
    stagedPdfPath,
    qpdfBinary,
    signal,
    log,
    runCommand,
}: {
    inputPath: string;
    inputCount: number;
    scratch: string;
    stagedPdfPath: string;
    qpdfBinary: string;
    signal: AbortSignal;
    log: TScanCleanupLog;
    runCommand: IRunScanCleanupPipelineDependencies['runCommand'];
}) {
    let currentPath = inputPath;
    let currentCount = inputCount;
    let level = 0;
    while (currentCount > 1) {
        signal.throwIfAborted();
        const nextPath = join(scratch, `scan-cleanup-merge-${String(level)}.jsonl`);
        const nextHandle = await open(nextPath, 'w');
        let nextCount = 0;
        let groupIndex = 0;
        let group: string[] = [];
        let seenCount = 0;
        const flushGroup = async () => {
            if (group.length === 0) {
                return;
            }
            signal.throwIfAborted();
            const mergedPath = join(
                scratch,
                `scan-cleanup-merge-${String(level)}-${String(groupIndex)}.pdf`,
            );
            const qpdfArgs = [
                '--empty',
                '--pages',
                ...group,
                '--',
                mergedPath,
            ];
            await runCommand(qpdfBinary, qpdfArgs, {
                signal,
                commandLabel: 'qpdf(scan-cleanup:merge-bounded-batches)',
                timeoutMs: 10 * 60 * 1000,
                log,
            });
            await appendJsonLine(nextHandle, {path: mergedPath});
            nextCount += 1;
            groupIndex += 1;
            group = [];
        };
        try {
            for await (const record of readJsonLines<{path?: unknown}>(currentPath, signal)) {
                if (typeof record.path !== 'string' || record.path.length === 0) {
                    throw new Error('Scan cleanup batch output sidecar contains an invalid path');
                }
                seenCount += 1;
                group.push(record.path);
                if (group.length >= QPDF_MERGE_INPUT_WINDOW) {
                    await flushGroup();
                }
            }
            await flushGroup();
        } finally {
            await nextHandle.close();
        }
        if (seenCount !== currentCount) {
            throw new Error(
                `Scan cleanup batch output sidecar declared ${String(currentCount)} paths but contained ${String(seenCount)}`,
            );
        }
        if (nextCount === 0) {
            throw new Error('Scan cleanup batch output sidecar contained no PDF paths');
        }
        currentPath = nextPath;
        currentCount = nextCount;
        level += 1;
    }
    let finalPath: string | null = null;
    for await (const record of readJsonLines<{path?: unknown}>(currentPath, signal)) {
        if (typeof record.path !== 'string' || record.path.length === 0) {
            throw new Error('Scan cleanup merged output sidecar contains an invalid path');
        }
        if (finalPath !== null) {
            throw new Error('Scan cleanup merged output sidecar contains too many paths');
        }
        finalPath = record.path;
    }
    if (finalPath === null) {
        throw new Error('Scan cleanup merged output sidecar contained no PDF paths');
    }
    await copyFile(finalPath, stagedPdfPath);
}

export async function mergeScanCleanupPdfPathSidecar(
    args: Parameters<typeof mergeScanCleanupPdfPathSidecarUnchecked>[0],
) {
    try {
        return await mergeScanCleanupPdfPathSidecarUnchecked(args);
    } catch (error) {
        args.signal.throwIfAborted();
        if (error instanceof ScanCleanupStreamingEvidenceError) {
            throw error;
        }
        throw new ScanCleanupStreamingEvidenceError(
            args.inputPath,
            getErrorMessage(error),
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
                        startOffset: actualBatchCount * PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
                        endOffsetExclusive: Math.min(
                            expectedPageScope.length,
                            (actualBatchCount + 1) * PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
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
            || report.outputMappingsSidecarPath !== sidecarPath
            || report.pagesSidecarPath !== sidecarPath
        ) {
            throw new Error('representation report does not point to its batch-summary sidecar');
        }
        const sidecar = await stat(sidecarPath);
        if (sidecar.size <= 0) {
            throw new Error('representation report sidecar is empty');
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

function createLazyPageRasterSource({
    pdfPath,
    pdfimagesBinary,
    dependencies,
    log,
    signal,
    documentPageCount,
}: {
    pdfPath: string;
    pdfimagesBinary: string | undefined;
    dependencies: IRunScanCleanupPipelineDependencies;
    log: TScanCleanupLog;
    signal: AbortSignal;
    documentPageCount: number;
}): IScanCleanupPageRasterSource {
    const cache = new Map<number, Promise<IDetectedPageRaster | undefined>>();
    let compactLayeredPageCount = 0;
    let nextExpectedPageNumber = 1;
    let rasterProbeFailed = false;
    let observedLegacyRasterMap = false;
    let legacyRasterMapCoverageComplete = true;
    let documentDpi: number | null = null;
    const getPageRaster = (pageNumber: number) => {
        const cached = cache.get(pageNumber);
        if (cached !== undefined) {
            return cached;
        }
        const pending = (async () => {
            signal.throwIfAborted();
            const markObserved = (raster: IDetectedPageRaster | undefined) => {
                // Full conversion probes pages in document order. A later
                // child repeats the same pages after the parent's canvas pass,
                // so a scalar high-water mark counts each page once without a
                // document-sized Set or Map. Any other order is refused rather
                // than turning the budget into an unverified partial count.
                if (pageNumber < nextExpectedPageNumber) {
                    return raster;
                }
                if (pageNumber !== nextExpectedPageNumber) {
                    rasterProbeFailed = true;
                    return raster;
                }
                nextExpectedPageNumber += 1;
                if (
                    raster?.hasBilevelLayer === true
                    && raster.backgroundDpi !== undefined
                    && Number.isFinite(raster.backgroundDpi)
                    && raster.backgroundDpi > 0
                ) {
                    compactLayeredPageCount += 1;
                }
                return raster;
            };
            if (pdfimagesBinary === undefined) {
                rasterProbeFailed = true;
                return markObserved(undefined);
            }
            try {
                const result = await dependencies.detectSourceDpi(
                    pdfPath,
                    pdfimagesBinary,
                    log,
                    undefined,
                    signal,
                    [pageNumber],
                );
                documentDpi = Math.max(documentDpi ?? 0, result.documentDpi ?? 0) || null;
                if ('getPageRaster' in result) {
                    return markObserved(await result.getPageRaster(pageNumber));
                }
                observedLegacyRasterMap = true;
                legacyRasterMapCoverageComplete = legacyRasterMapCoverageComplete
                    && hasCompletePageRasterCoverage(
                        result.pageRasterByNumber,
                        documentPageCount,
                    );
                return markObserved(result.pageRasterByNumber.get(pageNumber));
            } catch (error) {
                signal.throwIfAborted();
                rasterProbeFailed = true;
                log('debug', `Scan cleanup could not detect source raster for page ${String(pageNumber)}: ${getErrorMessage(error)}`);
                return markObserved(undefined);
            }
        })();
        cache.set(pageNumber, pending);
        if (cache.size > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined && oldest !== pageNumber) cache.delete(oldest);
        }
        return pending;
    };
    return {
        get detected() {
            return pdfimagesBinary !== undefined;
        },
        get documentDpi() {
            return documentDpi;
        },
        get compactLayeredPageCount() {
            return compactLayeredPageCount;
        },
        get compactLayeredPageCountComplete() {
            return !rasterProbeFailed
                && nextExpectedPageNumber > documentPageCount
                && (!observedLegacyRasterMap || legacyRasterMapCoverageComplete);
        },
        getPageRaster,
    };
}

type TScanCleanupBoundedDetectionRequestFields = Pick<IRunScanCleanupPipelineRequest,
    | 'documentPriorByPage'
    | 'layoutByPage'
    | 'outputModeRecommendations'
    | 'pagePlanEvidenceByPage'
    | 'placementAnchorsByPage'
    | 'softAlphaForegroundRecommendations'
    | 'sourcePageMetadataByPage'
>;

function resolveBatchPlacementAnchors(
    baseRequest: IRunScanCleanupPipelineRequest,
    results: ReadonlyMap<number, IScanCleanupDetectionResult>,
    pageNumbers: readonly number[],
    summary: IScanCleanupPlacementAnchorSummary | undefined,
) {
    const anchorsByPage: NonNullable<IRunScanCleanupPipelineRequest['placementAnchorsByPage']> = {};
    for (const pageNumber of pageNumbers) {
        const key = String(pageNumber);
        const result = results.get(pageNumber);
        const pageOverride = getScanCleanupPageOverride(
            baseRequest.options.pageOverrides,
            requirePageNumber(pageNumber),
        );
        const evidence = result?.pagePlanEvidence ?? baseRequest.pagePlanEvidenceByPage?.[key];
        const metadata = result?.sourcePageMetadata ?? baseRequest.sourcePageMetadataByPage?.[key];
        const explicit = baseRequest.placementAnchorsByPage?.[key];
        const resolved: Partial<Record<
            IScanCleanupPlacementAnchorSummary['samples'][number]['half'],
            {yNormalized: number}
        >> = explicit === undefined ? {} : {...explicit};
        if (summary !== undefined) {
            const sheetHeightPoints = resolveScanCleanupSheetHeightPoints(metadata);
            const scale = summary.referenceHeightPoints > 0 && sheetHeightPoints > 0
                ? sheetHeightPoints / summary.referenceHeightPoints
                : 1;
            for (const half of [
                'full',
                'left',
                'right',
            ] as const) {
                if (resolved[half] !== undefined) continue;
                if (resolveScanCleanupOutputPlacement(
                    baseRequest.options.pageAlignment,
                    pageOverride,
                    half,
                ) !== 'ink') {
                    continue;
                }
                const contentBox = pageOverride.manualContentBoxes?.[half]
                    ?? evidence?.outputs[half]?.contentBox;
                if (contentBox === undefined) continue;
                resolved[half] = resolveScanCleanupPlacementAnchorFromSummary(
                    summary,
                    contentBox.yNormalized * scale,
                );
            }
        }
        if (Object.keys(resolved).length > 0) {
            anchorsByPage[key] = resolved;
        }
    }
    return anchorsByPage;
}

/** Read only one bounded conversion window from the detection sidecar. */
export async function readDetectionResultsForPageNumbers(
    store: NonNullable<IRunScanCleanupPipelineRequest['detectionResultStore']>,
    pageNumbers: readonly number[],
    signal: AbortSignal,
) {
    const results: IScanCleanupDetectionResult[] = [];
    if (pageNumbers.length === 0) {
        return results;
    }
    let contiguous = true;
    for (let index = 1; index < pageNumbers.length; index += 1) {
        if (pageNumbers[index] !== pageNumbers[0]! + index) {
            contiguous = false;
            break;
        }
    }
    if (!contiguous) {
        for (const pageNumber of pageNumbers) {
            signal.throwIfAborted();
            const result = await store.getPage(pageNumber);
            if (result !== undefined) results.push(result);
        }
        return results;
    }
    for (let start = 0; start < pageNumbers.length; start += PDF_PAGE_SIZE_STORE_MAX_READ_PAGES) {
        signal.throwIfAborted();
        const firstPageNumber = pageNumbers[start]!;
        const lastPageNumberExclusive = pageNumbers[
            Math.min(pageNumbers.length, start + PDF_PAGE_SIZE_STORE_MAX_READ_PAGES) - 1
        ]! + 1;
        results.push(...await store.readRange(firstPageNumber, lastPageNumberExclusive));
    }
    return results;
}

function buildBoundedDetectionRequestFields(
    baseRequest: IRunScanCleanupPipelineRequest,
    results: readonly IScanCleanupDetectionResult[],
    pageNumbers: readonly number[],
): TScanCleanupBoundedDetectionRequestFields {
    const resultByPage = new Map(results.map(result => [
        result.pageNumber,
        result,
    ] as const));
    const layoutByPage: NonNullable<IRunScanCleanupPipelineRequest['layoutByPage']> = {};
    const pagePlanEvidenceByPage: NonNullable<IRunScanCleanupPipelineRequest['pagePlanEvidenceByPage']> = {};
    const outputModeRecommendations: NonNullable<IRunScanCleanupPipelineRequest['outputModeRecommendations']> = {};
    const softAlphaForegroundRecommendations: NonNullable<IRunScanCleanupPipelineRequest['softAlphaForegroundRecommendations']> = {};
    const sourcePageMetadataByPage: NonNullable<IRunScanCleanupPipelineRequest['sourcePageMetadataByPage']> = {};
    const documentPriorByPage: NonNullable<IRunScanCleanupPipelineRequest['documentPriorByPage']> = {};
    for (const pageNumber of pageNumbers) {
        const key = String(pageNumber);
        const result = resultByPage.get(requirePageNumber(pageNumber));
        const layout = result?.classification ?? baseRequest.layoutByPage?.[key];
        if (layout !== undefined) layoutByPage[key] = layout;
        const pagePlanEvidence = result?.pagePlanEvidence ?? baseRequest.pagePlanEvidenceByPage?.[key];
        if (pagePlanEvidence !== undefined) pagePlanEvidenceByPage[key] = pagePlanEvidence;
        const outputMode = result?.recommendedOutputMode ?? baseRequest.outputModeRecommendations?.[key];
        if (outputMode !== undefined) outputModeRecommendations[key] = outputMode;
        const softAlpha = result?.softAlphaForegroundRecommendation
            ?? baseRequest.softAlphaForegroundRecommendations?.[key];
        if (softAlpha !== undefined) softAlphaForegroundRecommendations[key] = softAlpha;
        const sourcePageMetadata = result?.sourcePageMetadata ?? baseRequest.sourcePageMetadataByPage?.[key];
        if (sourcePageMetadata !== undefined) sourcePageMetadataByPage[key] = sourcePageMetadata;
        const documentPrior = result?.documentPrior ?? baseRequest.documentPriorByPage?.[key];
        if (documentPrior !== undefined) documentPriorByPage[key] = documentPrior;
    }
    return {
        documentPriorByPage,
        layoutByPage,
        outputModeRecommendations,
        pagePlanEvidenceByPage,
        placementAnchorsByPage: resolveBatchPlacementAnchors(
            baseRequest,
            resultByPage,
            pageNumbers,
            baseRequest.placementAnchorSummary,
        ),
        softAlphaForegroundRecommendations,
        sourcePageMetadataByPage,
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
    publishTempPath,
    scratch,
    warnings,
    warningEvents,
    geometrySidecarPath,
    dpiDetails,
    detectionResultStore,
    documentCanvas,
    options,
    requirePublishedRaster,
}: {
    request: IRunScanCleanupPipelineRequest;
    paths: IScanCleanupWorkerPaths;
    signal: AbortSignal;
    policy: IScanCleanupRuntimePolicy;
    log: TScanCleanupLog;
    dependencies: IRunScanCleanupPipelineDependencies;
    emitProgress: ReturnType<typeof createScanCleanupProgressReporter>;
    pageNumbers: TScanCleanupPageScope;
    pageCount: number;
    documentPageCount: number;
    preparedPdfPath: string;
    stagedPdfPath: string;
    publishTempPath: string;
    scratch: string;
    warnings: string[];
    warningEvents: TScanCleanupSummaryWarningEvent[];
    geometrySidecarPath: string;
    dpiDetails: TScanCleanupDpiDetails;
    detectionResultStore?: NonNullable<IRunScanCleanupPipelineRequest['detectionResultStore']>;
    documentCanvas: TScanCleanupDocumentCanvas | null;
    options: IRunScanCleanupPipelineRequest['options'];
    requirePublishedRaster: NonNullable<IRunScanCleanupPipelineDependencies['requirePublishedRaster']>;
}) {
    if (documentPageCount <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
        throw new Error('Streaming scan cleanup requires an xlarge document');
    }
    // The native geometry sidecar has already been consumed once by the
    // parent canvas pass. A separate sequential reader lets each bounded
    // child advance through exactly its own range without reopening qpdf or
    // retaining all page records in JavaScript.
    const pageSizeStore = createPageSizeStoreFromGeometrySidecar(geometrySidecarPath, signal);
    const boundedDpiSource = resolvePageRasterSource(dpiDetails, documentPageCount);
    const batchOutputsPath = join(scratch, 'scan-cleanup-batch-outputs.jsonl');
    const batchSummariesPath = join(scratch, 'scan-cleanup-batch-summaries.jsonl');
    const outputHandle = await open(batchOutputsPath, 'w');
    const summaryHandle = await open(batchSummariesPath, 'w');
    const summary = createEmptyScanCleanupSummary(pageCount, warnings, warningEvents);
    let batchCount = 0;
    try {
        for (const batch of iterateScanCleanupPageBatches(
            pageCount,
            PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
        )) {
            signal.throwIfAborted();
            const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
            if (batchPageNumbers.length === 0) continue;
            const batchDetectionResults = detectionResultStore === undefined
                ? []
                : await readDetectionResultsForPageNumbers(
                    detectionResultStore,
                    batchPageNumbers,
                    signal,
                );
            const batchOutputPath = join(scratch, `scan-cleanup-batch-${String(batch.batchIndex)}.pdf`);
            const {
                detectionResultStore: _detectionResultStore,
                documentPriorByPage: _documentPriorByPage,
                layoutByPage: _layoutByPage,
                outputModeRecommendations: _outputModeRecommendations,
                pagePlanEvidenceByPage: _pagePlanEvidenceByPage,
                placementAnchorsByPage: _placementAnchorsByPage,
                sourcePageRange: _sourcePageRange,
                softAlphaForegroundRecommendations: _softAlphaForegroundRecommendations,
                sourcePageMetadataByPage: _sourcePageMetadataByPage,
                ...requestWithoutPageRange
            } = request;
            const childRequest: IRunScanCleanupPipelineRequest = {
                ...requestWithoutPageRange,
                outputPdfPath: batchOutputPath,
                sourcePageNumbers: batchPageNumbers,
                options,
                ...buildBoundedDetectionRequestFields(request, batchDetectionResults, batchPageNumbers),
            };
            const {
                getPageSizeStore: _getPageSizeStore,
                getPageSizes: _getPageSizes,
                detectSourceDpi: _detectSourceDpi,
                ...dependenciesWithoutGeometryOverrides
            } = dependencies;
            const childDependencies: IRunScanCleanupPipelineDependencies = {
                ...dependenciesWithoutGeometryOverrides,
                // A child owns no geometry lifecycle. The parent closes the
                // one native sidecar store in its outer finally block.
                getPageSizeStore: () => createNonClosingPageSizeStore(pageSizeStore),
                // Reuse the parent's bounded source accessor. In the legacy
                // test shape this adapter still reads only the current batch.
                detectSourceDpi: () => Promise.resolve(boundedDpiSource),
                requirePublishedRaster,
            };
            const childSummary = await runScanCleanupConversion(
                childRequest,
                paths,
                signal,
                progress => emitProgress(
                    progress.stage,
                    Math.min(pageCount, batch.startOffset + progress.completedUnits),
                    pageCount,
                ),
                policy,
                log,
                childDependencies,
                {
                    documentCanvas,
                    dpiDetails: boundedDpiSource,
                    skipDocumentCanvasMeasurement: true,
                    skipPageSizeValidation: true,
                    smallCompatibilityRun: true,
                },
            );
            await appendJsonLine(outputHandle, {
                path: batchOutputPath,
                pageCount: childSummary.outputPages,
            });
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
            // Page-level warning lists are intentionally owned by each child
            // evidence file. Keep the coordinator summary bounded and retain
            // only the initial run warnings here.
            log(
                'debug',
                `Scan cleanup completed bounded output batch ${String(batch.batchIndex)} `
                + `(${String(childSummary.outputPages)} output page(s))`,
            );
        }
        if (batchCount === 0 || summary.outputPages === 0) {
            throw new Error('evb-scan-cleanup produced no output pages');
        }
        await validateScanCleanupBatchSummarySidecar(
            batchSummariesPath,
            batchCount,
            signal,
            pageNumbers,
        );
        emitProgress('assembling', 0, summary.outputPages, []);
        await mergeScanCleanupPdfPathSidecar({
            inputPath: batchOutputsPath,
            inputCount: batchCount,
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
        if (outputFile.size <= 0) throw new Error('PDF assembler produced an empty file');
        const fullDocumentRun = request.sourcePageNumbers === undefined
            && request.sourcePageRange === undefined;
        if (
            fullDocumentRun
            && request.options.outputMode === 'auto'
            && boundedDpiSource.compactLayeredPageCountComplete !== true
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
            pageRasterByNumber: new Map(),
            partialRun: !fullDocumentRun,
            sourceBytes: sourceFile.size,
            ...(boundedDpiSource.compactLayeredPageCount === undefined
                ? {}
                : {compactLayeredPageCount: boundedDpiSource.compactLayeredPageCount}),
        });
        // The detailed per-page report lives in the bounded batch summaries.
        // The top-level report remains a small descriptor, so diagnostics can
        // choose to consume the sidecar without forcing a whole-document parse.
        const representationReport: IScanCleanupRepresentationReport = {
            schemaVersion: 1,
            sourceBytes: sourceFile.size,
            outputBytes: outputFile.size,
            outputToSourceByteRatio: outputFile.size / sourceFile.size,
            compactSourceBudget,
            outputMappings: [],
            pages: [],
            outputMappingsSidecarPath: batchSummariesPath,
            pagesSidecarPath: batchSummariesPath,
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
        await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
        emitProgress('handoff', 0, pageCount, []);
        await copyFile(stagedPdfPath, publishTempPath);
        signal.throwIfAborted();
        await rename(publishTempPath, request.outputPdfPath);
        // Publication completed, so report the aggregate count without an
        // empty page list that would contradict completedUnits.
        emitProgress('handoff', pageCount, pageCount);
        return summary;
    } finally {
        await Promise.all([
            outputHandle.close(),
            summaryHandle.close(),
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
    context?: IScanCleanupConversionContext,
): Promise<TScanCleanupSummary> {
    const scratch = await createScanCleanupScratchDir(paths.tempDir);
    const sessionId = randomUUID();
    const stagedPdfPath = join(scratch, 'cleaned.pdf');
    const publishTempPath = join(dirname(request.outputPdfPath), `.${sessionId}.scan-cleanup.tmp`);
    // Set once the run knows which assembler it is actually using: a matched
    // lossless run whose pages cannot keep their own pixels renders instead.
    let losslessRun = request.options.preserveOriginalQuality === true;
    const supportsRasterStreaming = policy.rasterStreaming
        && process.platform !== 'win32'
        && dependencies.createRasterPipes !== undefined;
    let rasterStreamingRun = supportsRasterStreaming;
    let preserveScratchForDiagnostics = false;
    let pageSizeStore: IPdfPageSizeStore | null = null;
    const analysisReleasePromises: Array<Promise<void>> = [];
    const requirePublishedRaster = dependencies.requirePublishedRaster ?? requirePublishedRasterFile;
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun, {isRasterStreaming: () => rasterStreamingRun});
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
        const largeStreamingRun = documentPageCount > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES
            && context?.smallCompatibilityRun !== true;
        const warnings = [...prepared.warnings];
        // Conditions raised before the summary exists still belong to it, so
        // they are collected in the same typed shape and handed over with the
        // sentences they produced.
        const warningEvents: TScanCleanupSummaryWarningEvent[] = [];
        // What the run tells the user reaches them through the summary, and
        // the same sentence belongs in the log.
        const warn = (message: string) => {
            warnings.push(message);
            log('warn', `Scan cleanup: ${message}`);
        };
        const warnEvent = (event: TScanCleanupWarningEvent, pageNumber?: number) => {
            warningEvents.push({
                event,
                ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
            });
            warn(formatScanCleanupWarningEvent(event, pageNumber));
        };
        emitProgress('normalizing', 1, 1);
        // The lossless path assembles with evb-pdf-page-ops, so it needs the
        // tool itself. Matching only needs the geometry, which Poppler reports
        // too — a default matched run on an installation without page-ops is
        // measured rather than degraded.
        if (request.options.preserveOriginalQuality === true && !paths.pdfPageOpsBinary) {
            throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
        }
        // The same measurement the preview derives its canvas from, read from
        // the prepared document this run renders. The lossless path cannot
        // proceed without it — every crop it writes is expressed in these
        // coordinates. Matching only wants the rectangle, and a document that
        // carries none is still worth cleaning: the run drops matching, names
        // why in the summary, and cleans every page at its own size, which is
        // what it already answers when geometry yields no canvas.
        const suppliedMetadata = request.detectionResultStore === undefined
            ? request.sourcePageMetadataByPage
            : undefined;
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
            ...(paths.pdfPageOpsBinary === undefined
                ? {}
                : {pdfPageOpsBinary: paths.pdfPageOpsBinary}),
            qpdfBinary: paths.qpdfBinary,
            ...(paths.pdfinfoBinary === undefined
                ? {}
                : {pdfinfoBinary: paths.pdfinfoBinary}),
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
            } else if (dependencies.getPageSizeStore !== undefined) {
                pageSizeStore = await dependencies.getPageSizeStore(prepared.pdfPath, pageSizeOptions);
            } else if (dependencies.getPageSizes !== undefined) {
                if (largeStreamingRun) {
                    throw new Error('Scan cleanup xlarge conversion requires getPageSizeStore');
                }
                pageSizeStore = createPageSizeStoreFromArrayReader(
                    dependencies.getPageSizes,
                    prepared.pdfPath,
                    pageSizeOptions,
                );
            } else {
                if (!paths.pdfPageOpsBinary && !paths.pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                pageSizeStore = createPdfPageSizeStore(prepared.pdfPath, pageSizeOptions);
            }
            const openedPageSizeStore = pageSizeStore;
            // Pull one scalar to validate the first chunk and discover the
            // document count without retaining a document-sized geometry array.
            // A streaming child deliberately skips this probe. Its shared
            // geometry sidecar cursor is already positioned at the beginning
            // of the current batch and must advance monotonically.
            if (context?.skipPageSizeValidation !== true) {
                await openedPageSizeStore.getPage(1);
                if (openedPageSizeStore.pageCount !== documentPageCount) {
                    throw new Error(
                        `Scan cleanup received geometry for ${String(openedPageSizeStore.pageCount ?? 0)} of ${String(documentPageCount)} pages`,
                    );
                }
            }
        } catch (error) {
            if (signal.aborted) throw error;
            throw new Error(
                `Scan cleanup cannot safely rasterize without trusted page geometry (${getErrorMessage(error)})`,
                {cause: error},
            );
        }
        const geometryPageSizeStore = pageSizeStore;
        // The old array contract remains an explicitly small adapter. The
        // production path keeps no page-sized geometry array once the source
        // exceeds one resident streaming batch.
        const pageSizes = documentPageCount <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES
            ? await pageSizeStore.readRange(1, documentPageCount + 1)
            : null;
        const renderBoxByPage = pageSizes === null
            ? null
            : new Map(pageSizes.map(page => [
                page.pageNumber,
                page.renderBox ?? 'cropbox',
            ] as const));
        const probesWholeDocument = request.options.matchPageSize
            || (request.sourcePageNumbers === undefined && request.sourcePageRange === undefined);
        const dpiProbePages = probesWholeDocument
            ? undefined
            : pageNumbers.length <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES
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
        const metadataDpiDetails = pageSizes
            ? detectSourceDpiFromPageSizes(pageSizes)
            : null;
        // Page geometry can name the dominant raster but not whether the PDF
        // already carries a compact bilevel foreground. Auto needs that
        // representation fact to distinguish an existing MRC text mask from
        // genuinely antialiased low-resolution text, so retain the pdfimages
        // structure probe whenever it is available.
        const structuralDpiDetails: TScanCleanupDpiDetails = context?.dpiDetails
            ?? (largeStreamingRun
                ? createLazyPageRasterSource({
                    pdfPath: prepared.pdfPath,
                    pdfimagesBinary: paths.pdfimagesBinary,
                    dependencies,
                    log,
                    signal,
                    documentPageCount,
                })
                : metadataDpiDetails !== null && paths.pdfimagesBinary === undefined
                    ? {
                        documentDpi: null,
                        pageDpiByNumber: new Map<number, number>(),
                        pageRasterByNumber: new Map(),
                    }
                    : await dependencies.detectSourceDpi(
                        prepared.pdfPath,
                        paths.pdfimagesBinary,
                        log,
                        undefined,
                        signal,
                        Array.isArray(dpiProbePages) ? dpiProbePages : undefined,
                        (completedPages, totalPages) => emitProgress('probing', completedPages, totalPages),
                    ));
        const structuralRasterSource = resolvePageRasterSource(structuralDpiDetails, documentPageCount);
        const dpiDetails = structuralRasterSource.detected
            ? structuralDpiDetails
            : metadataDpiDetails ?? structuralDpiDetails;
        const dpiSource = resolvePageRasterSource(dpiDetails, documentPageCount);
        if (metadataDpiDetails && !structuralRasterSource.detected) {
            emitProgress('probing', dpiProbePageCount, dpiProbePageCount, dpiProbePages);
        }
        let documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
        const documentCanvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
        let layoutEvidenceComplete = true;
        let finestCanvasDpi = 0;
        const geometrySidecarPath = largeStreamingRun
            ? join(scratch, 'scan-cleanup-page-geometry.jsonl')
            : null;
        const geometrySidecarHandle = geometrySidecarPath === null
            ? null
            : await open(geometrySidecarPath, 'w');
        try {
            if (geometrySidecarHandle !== null) {
                await appendJsonLine(geometrySidecarHandle, {
                    format: PAGE_GEOMETRY_SIDECAR_FORMAT,
                    schemaVersion: PAGE_GEOMETRY_SIDECAR_SCHEMA_VERSION,
                    pageCount: documentPageCount,
                });
            }
            if (context?.skipDocumentCanvasMeasurement !== true
                && (largeStreamingRun || request.options.matchPageSize)) {
                let expectedGeometryPageNumber = 1;
                await pageSizeStore.forEachChunk(async chunk => {
                    signal.throwIfAborted();
                    if (chunk.pageCount !== documentPageCount) {
                        throw new Error(
                            `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(documentPageCount)} document pages`,
                        );
                    }
                    const detectionByPage = request.detectionResultStore === undefined
                        ? null
                        : new Map((await readDetectionResultsForPageNumbers(
                            request.detectionResultStore,
                            chunk.pages.map(page => page.pageNumber),
                            signal,
                        )).map(result => [
                            result.pageNumber,
                            result,
                        ] as const));
                    for (const measuredPage of chunk.pages) {
                        if (measuredPage.pageNumber !== expectedGeometryPageNumber) {
                            throw new Error(
                                `Scan cleanup page-size store returned page ${String(measuredPage.pageNumber)} where page ${String(expectedGeometryPageNumber)} was expected`,
                            );
                        }
                        expectedGeometryPageNumber += 1;
                        const detectionResult = detectionByPage?.get(
                            requirePageNumber(measuredPage.pageNumber),
                        );
                        const detectedPageMetadata = detectionResult?.sourcePageMetadata;
                        const page = detectedPageMetadata?.renderBox === 'mediabox'
                            ? detectedPageMetadata
                            : toCropBoxPageSize(detectedPageMetadata ?? measuredPage);
                        if (geometrySidecarHandle !== null) await appendJsonLine(geometrySidecarHandle, page);
                        if (!request.options.matchPageSize) continue;
                        const pageNumber = page.pageNumber;
                        const observedLayout = detectionResult?.classification
                            ?? request.layoutByPage?.[String(pageNumber)];
                        if (observedLayout === undefined) layoutEvidenceComplete = false;
                        addScanCleanupDocumentCanvasPage(
                            documentCanvasAccumulator,
                            page,
                            request.options,
                            observedLayout,
                        );
                        const pageOverride = getScanCleanupPageOverride(
                            request.options.pageOverrides,
                            requirePageNumber(pageNumber),
                        );
                        // Probe every page in the ordered geometry pass, even
                        // when an override excludes its output. The full-run
                        // Auto budget describes the source document, and the
                        // scalar observer must not mistake an excluded page
                        // for a failed or out-of-order raster probe.
                        const sourceRaster = await dpiSource.getPageRaster(pageNumber);
                        if (!pageOverride.excluded) {
                            if (dpiSource.documentDpi !== undefined && dpiSource.documentDpi !== null) {
                                documentDpi = Math.max(documentDpi, resolveSourceDpi(dpiSource.documentDpi));
                            }
                            const sourceDpi = resolveSourceDpi(sourceRaster?.dpi, documentDpi);
                            const outputMode = resolveScanCleanupEffectiveOutputMode({
                                options: request.options,
                                pageOverride,
                                detectedOutputMode: detectionResult?.recommendedOutputMode
                                    ?? request.outputModeRecommendations?.[String(pageNumber)],
                            });
                            finestCanvasDpi = Math.max(finestCanvasDpi, resolveScanCleanupCanvasPageDpi({
                                configuredMode: outputMode
                                    ?? pageOverride.outputModeOverride
                                    ?? request.options.outputMode,
                                sourceDpi,
                                sourceRasterDetected: sourceRaster !== undefined,
                                guardrail: resolveScanCleanupDocumentGuardrail(
                                    sourceRaster,
                                    sourceDpi,
                                    page,
                                ),
                            }));
                        }
                    }
                });
                if (expectedGeometryPageNumber - 1 !== documentPageCount) {
                    throw new Error(
                        `Scan cleanup page-size store returned ${String(expectedGeometryPageNumber - 1)} pages for ${String(documentPageCount)} document pages`,
                    );
                }
            }
        } finally {
            await geometrySidecarHandle?.close();
        }
        // A page left on automatic that detection has not classified is
        // measured as the whole sheet it is: assuming it is a spread because
        // its neighbours are would halve the document rectangle and place every
        // page that is not a spread at half the document's scale. Measuring the
        // sheet can only leave such a page padded, and the run names the pages
        // it had to measure that way.
        const unclassifiedPages = request.options.matchPageSize && pageSizes
            ? resolveScanCleanupUnclassifiedPages(pageSizes, request.options, request.layoutByPage)
            : [];
        const unclassifiedPageCount = pageSizes === null
            ? documentCanvasAccumulator.unclassifiedAutomaticPageCount
            : unclassifiedPages.length;
        if (unclassifiedPageCount > 0) {
            warn(
                `Matched page size measured ${String(unclassifiedPageCount)} page(s) as whole sheets `
                + 'because layout detection had not classified them when the run started; '
                + 'a page among them that is a two-page spread is placed on the document rectangle '
                + (unclassifiedPages.length > 0
                    ? `without being scaled to it: ${describePageNumbers(unclassifiedPages)}`
                    : 'without being scaled to it on the document rectangle'),
            );
        }
        // Matching a document onto one rectangle also means one content scale.
        // The lossless assembler can carry a page's own objects at a different
        // scale, but it cannot give a page that was scanned at a lower
        // resolution the document's pixel grid without resampling it. Where the
        // two promises collide, matched page size wins and this run renders,
        // and it says so rather than shipping a document whose pages are the
        // same paper at visibly different resolutions.
        const resampledRasterByPage = 'pageRasterByNumber' in dpiDetails
            ? dpiDetails.pageRasterByNumber
            : new Map<number, IDetectedPageRaster>();
        const resampledPages = request.options.preserveOriginalQuality === true && pageSizes
            ? resolveMatchedCanvasResamplePages(
                pageSizes,
                // Every page of the document, not only the ones this run
                // produces: one page of a document that cannot share a pixel
                // grid cannot be cleaned as if the rest of it could.
                pageSizes.map(pageSize => pageSize.pageNumber),
                request.options,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                resampledRasterByPage,
                paths.pdfimagesBinary !== undefined,
                request.layoutByPage,
            )
            : [];
        if (resampledPages.length > 0) {
            losslessRun = false;
            warnEvent({
                code: 'matched-canvas-pages-resampled',
                pages: resampledPages.map(pageNumber => requirePageNumber(pageNumber)),
            });
        }
        if (largeStreamingRun) {
            // The parent run is a coordinator only. Each bounded child keeps
            // the requested quality path, while the parent itself must not
            // enter the legacy document-sized lossless planner.
            losslessRun = false;
        }
        if (request.options.preserveOriginalQuality && !largeStreamingRun && resampledPages.length === 0) {
            const summary = await runLosslessScanCleanup(
                request,
                paths,
                prepared.pdfPath,
                warnings,
                pageNumbers,
                geometryPageSizeStore,
                dpiDetails,
                scratch,
                stagedPdfPath,
                signal,
                emitProgress,
                log,
                policy,
                dependencies,
                context === undefined
                    ? undefined
                    : {
                        ...(context.documentCanvas === undefined
                            ? {}
                            : {documentCanvas: context.documentCanvas}),
                        ...(context.skipDocumentCanvasMeasurement === undefined
                            ? {}
                            : {skipDocumentCanvasMeasurement: context.skipDocumentCanvasMeasurement}),
                    },
            );
            if ((await stat(stagedPdfPath)).size <= 0) throw new Error('Lossless PDF assembler produced an empty file');
            await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
            emitProgress('handoff', 0, pageCount, []);
            await copyFile(stagedPdfPath, publishTempPath);
            signal.throwIfAborted();
            await rename(publishTempPath, request.outputPdfPath);
            emitProgress('handoff', pageCount, pageCount, pageNumbers);
            return summary;
        }
        // A compatibility map is populated only for the bounded child run or
        // a genuinely small document. The xlarge parent keeps the accessor
        // open and asks it for the current native batch instead.
        const detectedRasterByPage = new Map<number, IDetectedPageRaster>();
        if (documentPageCount <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES || context?.smallCompatibilityRun === true) {
            for (const pageNumber of pageNumbers) {
                const raster = await dpiSource.getPageRaster(pageNumber);
                if (raster !== undefined) detectedRasterByPage.set(pageNumber, raster);
            }
        }
        // The pixel grid is a property of the document, so it is derived over
        // every page of it rather than over the pages this run was asked to
        // clean: cleaning page 2 of a 300-DPI scan on its own otherwise writes
        // a page at page 2's own resolution.
        const canvasPageNumbers: TScanCleanupPageScope = request.options.matchPageSize
            && documentCanvasAccumulator.producedPageCount > 0
            ? resolveScanCleanupPageScopeLazy(undefined, documentPageCount)
            : [];
        const isOutputPageNumber = (pageNumber: number) => {
            if ('startPageNumber' in pageNumbers) {
                return pageNumber >= pageNumbers.startPageNumber
                    && pageNumber <= pageNumbers.endPageNumber;
            }
            return pageNumbers.includes(pageNumber);
        };
        const resolvePageSourceDpi = (pageNumber: number) => resolveSourceDpi(
            detectedRasterByPage.get(pageNumber)?.dpi,
            dpiSource.documentDpi === undefined || dpiSource.documentDpi === null
                ? documentDpi
                : Math.max(documentDpi, resolveSourceDpi(dpiSource.documentDpi)),
        );
        const resolvePageOutputMode = (pageNumber: number) => {
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                requirePageNumber(pageNumber),
            );
            if (pageOverride.excluded) {
                return 'color' as const;
            }
            const outputMode = resolveScanCleanupEffectiveOutputMode({
                options: request.options,
                pageOverride,
                detectedOutputMode: request.outputModeRecommendations?.[String(pageNumber)],
            });
            // Final rendering consumes the durable decision detection already
            // exposed in preview. An unselected page may remain unresolved
            // solely for document-canvas planning; a rendered page may not.
            if (outputMode !== undefined) {
                return outputMode;
            }
            if (isOutputPageNumber(pageNumber)) {
                throw new Error(
                    `Scan cleanup page ${String(pageNumber)} has no locked Auto output-mode decision`,
                );
            }
            return undefined;
        };
        const requiresBilevelQuality = (pageNumber: number) => {
            const mode = resolvePageOutputMode(pageNumber);
            return mode === undefined || mode === 'bw' || mode === 'mixed';
        };
        // Every final output mode is preflighted from trusted geometry before
        // any Poppler producer starts. A detected source raster is the most
        // exact guardrail; otherwise the PDF page view is the same CropBox
        // rectangle pdftoppm will materialize.
        interface IScanCleanupGuardrail {
            dpi: number;
            width: number;
            height: number
        }
        const guardrailByPage = new Map<number, IScanCleanupGuardrail>();
        const pageGeometryByNumber = new Map<number, IPdfPageSize>();
        const readPageGeometry = async (pageNumber: number) => {
            if (pageSizes !== null) {
                const page = pageSizes[pageNumber - 1];
                if (page === undefined) {
                    throw new Error(`Scan cleanup has no geometry for page ${String(pageNumber)}`);
                }
                return page;
            }
            return geometryPageSizeStore.getPage(pageNumber);
        };
        const ensureGuardrail = async (
            pageNumber: number,
            cache: Map<number, IScanCleanupGuardrail> = guardrailByPage,
        ) => {
            const cached = cache.get(pageNumber);
            if (cached !== undefined) {
                return cached;
            }
            const detected = detectedRasterByPage.get(pageNumber);
            const sourceDpi = resolvePageSourceDpi(pageNumber);
            const page = await readPageGeometry(pageNumber);
            pageGeometryByNumber.set(pageNumber, page);
            let guardrail = resolveScanCleanupDocumentGuardrail(detected, sourceDpi, page);
            if (guardrail === undefined && requiresBilevelQuality(pageNumber)) {
                signal.throwIfAborted();
                const probePath = join(scratch, `size-probe-${pageNumber}.png`);
                await dependencies.renderPage(
                    paths,
                    log,
                    pageNumber,
                    prepared.pdfPath,
                    probePath,
                    SCAN_CLEANUP_SIZE_PROBE_DPI,
                    undefined,
                    signal,
                    undefined,
                    undefined,
                    page.renderBox ?? 'cropbox',
                );
                guardrail = {
                    dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
                    ...await readPngDimensions(probePath),
                };
            }
            if (guardrail === undefined) {
                throw new Error(`Scan cleanup has no trusted raster geometry for page ${String(pageNumber)}`);
            }
            cache.set(pageNumber, guardrail);
            return guardrail;
        };
        // What this run renders each page at, read off the mode the run
        // resolved for it. The shared canvas may not read that mode: see
        // resolveScanCleanupCanvasPageDpi. Keep this as a page function so
        // only the active native batch becomes a JS work list.
        const resolveRasterPlan = (
            pageNumber: number,
            guardrail: IScanCleanupGuardrail,
            renderBox: 'cropbox' | 'mediabox',
        ) => {
            const resolvedOutputMode = resolvePageOutputMode(pageNumber);
            return {
                pageNumber,
                renderBox,
                resolvedOutputMode,
                ...resolveScanCleanupPlannedDpi({
                    sourceDpi: resolvePageSourceDpi(pageNumber),
                    outputCarriesBinaryLayer: requiresBilevelQuality(pageNumber),
                    sourceRasterDetected: detectedRasterByPage.has(pageNumber),
                    maxPixels: resolveScanCleanupPipelineMaxPixels(resolvedOutputMode),
                    guardrail,
                }),
                guardrail,
            };
        };
        // The rectangle the preview presented, on the finest resolution the
        // *document* is rendered at, so it has one output DPI and no page is
        // resampled below the detail it arrived with. Auto decisions are already
        // locked at this point; canvas planning must consume those same modes or
        // a Color/Gray book is silently allocated on the binary synthesis grid.
        // Run scope still cannot affect the grid because decisions and source
        // raster facts are supplied for the complete document.
        const computedDocumentCanvas = canvasPageNumbers.length > 0
            ? resolveScanCleanupDocumentCanvasFromAccumulator(
                documentCanvasAccumulator,
                finestCanvasDpi,
                request.options,
                layoutEvidenceComplete,
            )
            : null;
        const documentCanvas = context?.documentCanvas === undefined
            ? computedDocumentCanvas
            : context.documentCanvas;
        // One page scanned far finer than the rest raises the grid the whole
        // document is normalized onto, and the pixel budget its output modes
        // allow is what stops that becoming a document nothing can render —
        // a real loss against what the finest page asked for, so the run names
        // the resolution it actually normalized at.
        const canvasDpi = documentCanvas === null
            ? finestCanvasDpi
            : resolveScanCleanupDocumentCanvasDpi(documentCanvas);
        if (canvasDpi < finestCanvasDpi * 0.99) {
            warnEvent({
                code: 'matched-canvas-document-dpi-normalized',
                canvasDpi,
                finestPageDpi: finestCanvasDpi,
            });
        }
        // Native reconstructs the final uniform canvas from each page's render
        // DPI and the document rectangle. The plan's pixel fields alone cannot
        // constrain that reconstruction, so every page that would recreate a
        // different grid is normalized before its raster is rendered. This
        // raises coarse scans onto the document grid as well as capping pages
        // that would exceed it, so a partial run cannot silently fall back to
        // the selected page's lower resolution.
        const capRasterPlanDpi = (plan: ReturnType<typeof resolveRasterPlan>) => {
            // A page already lowered by its own raster guardrail cannot safely
            // be raised again merely to reach the document grid. Native will
            // fit that bounded raster onto the shared physical canvas.
            const dpi = plan.dpi < plan.requestedRenderDpi
                ? plan.dpi
                : resolveScanCleanupDocumentCanvasRenderDpi(plan.dpi, documentCanvas);
            if (dpi < plan.dpi) {
                warnEvent({
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: requirePageNumber(plan.pageNumber),
                    appliedDpiThousandths: toScanCleanupDpiThousandths(dpi),
                    requestedDpiThousandths: toScanCleanupDpiThousandths(plan.dpi),
                });
            }
            return dpi === plan.dpi ? plan : {
                ...plan,
                dpi,
            };
        };
        const options = documentCanvas === null && request.options.matchPageSize
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        if (options !== request.options) {
            const droppedEvent = resolveScanCleanupDroppedMatchWarningEventFromAccumulator(documentCanvasAccumulator);
            if (droppedEvent) warnEvent(droppedEvent);
        }
        if (largeStreamingRun) {
            if (geometrySidecarPath === null) {
                throw new Error('Scan cleanup streaming run has no geometry sidecar');
            }
            return await runStreamingScanCleanupConversion({
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
                publishTempPath,
                scratch,
                warnings,
                warningEvents,
                geometrySidecarPath,
                dpiDetails,
                ...(request.detectionResultStore === undefined
                    ? {}
                    : {detectionResultStore: request.detectionResultStore}),
                documentCanvas,
                options,
                requirePublishedRaster,
            });
        }
        const pagePlanResolver = createPagePlanResolver(request, log, 'final');
        const resolvePagePlan = (pageNumber: number) => pagePlanResolver.resolve(pageNumber);
        const rasterPlans: Array<ReturnType<typeof capRasterPlanDpi>> = [];
        for (const pageNumber of pageNumbers) {
            const guardrail = await ensureGuardrail(pageNumber);
            const page = await readPageGeometry(pageNumber);
            rasterPlans.push(capRasterPlanDpi(resolveRasterPlan(
                pageNumber,
                guardrail,
                page.renderBox ?? 'cropbox',
            )));
        }
        const resolvedPagePlanByNumber = new Map(rasterPlans.map(plan => [
            plan.pageNumber,
            resolvePagePlan(plan.pageNumber),
        ]));
        pagePlanResolver.report();
        // Resolve and validate the complete effective geometry before touching
        // compact source layers or starting any final raster producer. The
        // source can contain hundreds of expensive MRC masks; discovering one
        // malformed page only after extracting all of them made a validation
        // error look like a hung cleanup.
        const geometryPageInputs = rasterPlans.map(plan => {
            const detectedRaster = detectedRasterByPage.get(plan.pageNumber);
            return {
                inputPath: '',
                pageNumber: plan.pageNumber,
                dpi: plan.dpi,
                sourceDpi: plan.sourceDpi,
                sourceHasBilevelLayer: detectedRaster?.hasBilevelLayer ?? false,
                ...(detectedRaster?.backgroundDpi === undefined
                    ? {}
                    : {sourceBackgroundDpi: detectedRaster.backgroundDpi}),
                requestedRenderDpi: plan.requestedRenderDpi,
                ...(plan.resolvedOutputMode === undefined
                    ? {}
                    : {resolvedOutputMode: plan.resolvedOutputMode}),
                ...buildConversionPageMetadata({
                    documentPriorByPage: request.documentPriorByPage,
                    layoutByPage: request.layoutByPage,
                    pageMetadataPath: '',
                    pageNumber: plan.pageNumber,
                    resolvedPagePlan: resolvedPagePlanByNumber.get(plan.pageNumber),
                }),
            };
        });
        for (const batch of iterateScanCleanupPageBatches(geometryPageInputs.length)) {
            assertNativeScanCleanupManifestGeometry(buildGeometryOnlyNativeScanCleanupManifest({
                operation: 'render',
                renderMode: 'final',
                canvasScope: 'document',
                qualityPath: 'raster',
                hostMemoryBytes: policy.totalRamBytes,
                options: request.options,
                experimental: {
                    autoDewarp: request.options.autoDewarp ?? false,
                    ...(request.options.autoDewarpDepth === undefined
                        ? {}
                        : {autoDewarpDepth: request.options.autoDewarpDepth}),
                },
                pages: collectScanCleanupPageBatch(geometryPageInputs, batch),
            }));
        }
        const canonicalAnalysisDpi = DETECTION_DPI;
        const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: plan.dpi,
            raster: plan.guardrail,
            additionalRenderDpis: [canonicalAnalysisDpi],
            // A streaming slot can hold the producer/native working copies and
            // one canonical file until native reports that page complete.
            renderCopies: supportsRasterStreaming ? 2 : 1,
        })), scratch, dependencies.getAvailableScratchBytes, supportsRasterStreaming
            ? policy.rasterConcurrency
            : rasterPlans.length);
        logRasterHandoff(log, 'final', rasterHandoff);
        const pageDpi = new Map<number, number>();
        const trustedMrcLayersByPage = new Map<number, IPdfMrcLayers>();
        const trustedForegroundCandidates = rasterPlans.filter(plan => {
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                requirePageNumber(plan.pageNumber),
            );
            const geometryRejection = resolveSourceMrcReuseRejection(
                pageGeometryByNumber.get(plan.pageNumber)!,
                detectedRasterByPage.get(plan.pageNumber),
            );
            if (geometryRejection !== undefined) {
                log(
                    'debug',
                    `Page ${String(plan.pageNumber)} will use raster reconstruction; `
                    + `source MRC reuse is not proven (${geometryRejection})`,
                );
                return false;
            }
            return shouldExtractTrustedMrcForeground(
                request.options.outputMode,
                pageOverride.outputModeOverride,
            )
                && request.options.thickness === 0
                && request.options.autoDewarp !== true
                && pageOverride.rotationDegrees === 0
                && (pageOverride.manualZones?.picture.length ?? 0) === 0
                && (pageOverride.manualZones?.fill.length ?? 0) === 0
                && detectedRasterByPage.get(plan.pageNumber)?.hasBilevelLayer === true
                && (
                    plan.resolvedOutputMode === 'bw'
                    || plan.resolvedOutputMode === 'mixed'
                );
        });
        if (trustedForegroundCandidates.length > 0) {
            emitProgress('extracting', 0, trustedForegroundCandidates.length, []);
            const extractionStartedAt = performance.now();
            if (dependencies.extractMrcLayersBatch !== undefined) {
                try {
                    const layers = await dependencies.extractMrcLayersBatch({
                        pdfPath: prepared.pdfPath,
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
                                pdfPath: prepared.pdfPath,
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
            return {
                inputPath,
                analysisInputPath: join(
                    scratch,
                    `source-${plan.pageNumber}-analysis-${canonicalAnalysisDpi}dpi.${extension}`,
                ),
                analysisDpi: canonicalAnalysisDpi,
                ...(trustedMrcLayers === undefined
                    ? {}
                    : {
                        trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                        trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                    }),
                pageNumber: plan.pageNumber,
                dpi: plan.dpi,
                sourceDpi: plan.sourceDpi,
                sourceHasBilevelLayer: detectedRaster?.hasBilevelLayer ?? false,
                ...(detectedRaster?.backgroundDpi === undefined
                    ? {}
                    : {sourceBackgroundDpi: detectedRaster.backgroundDpi}),
                requestedRenderDpi: plan.requestedRenderDpi,
                ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
                ...(request.softAlphaForegroundRecommendations?.[String(plan.pageNumber)] === undefined
                    ? {}
                    : {preferSoftAlphaForeground:
                        request.softAlphaForegroundRecommendations[String(plan.pageNumber)]}),
                ...buildConversionPageMetadata({
                    documentPriorByPage: request.documentPriorByPage,
                    layoutByPage: request.layoutByPage,
                    pageMetadataPath: join(scratch, `clean-${plan.pageNumber}-page.json`),
                    pageNumber: plan.pageNumber,
                    resolvedPagePlan: resolvedPagePlanByNumber.get(plan.pageNumber),
                }),
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
        const canStreamRasters = supportsRasterStreaming
            && rasterHandoff.format === 'ppm'
            && dependencies.createRasterPipes !== undefined;
        const outputPages: IRenderedCleanupOutputPage[] = [];
        const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
        const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
        const summary = createEmptyScanCleanupSummary(pageCount, warnings, warningEvents);
        // The engine's own account of what it had to do to a page, a page it
        // could not hold at the document's scale, a raster it could not
        // publish. It travels with the summary and is logged here, so a run
        // that quietly compromised says where.
        const report = (message: string) => {
            summary.warnings.push(message);
            log('warn', `Scan cleanup: ${message}`);
        };
        const fittedMarginBoxPages = new Set<number>();
        const renderedPageNumbers = new Set<number>();
        const releasedAnalysisPages = new Set<number>();
        const manifestPageBySource = new Map<number, INativeScanCleanupPageV3>();
        let collectedPages = 0;
        rasterStreamingRun = canStreamRasters;
        await runScanCleanupPageBatches(rasterPlans.length, async batch => {
            const batchRasterPlans = collectScanCleanupPageBatch(rasterPlans, batch);
            const batchPageInputs = collectScanCleanupPageBatch(pageInputs, batch);
            // On POSIX, raw PPM inputs are FIFOs: Poppler produces each page
            // while the native worker consumes it. Replaying only this window
            // keeps both the manifest and the producer's path list bounded.
            const manifest = buildRunnableNativeScanCleanupManifest({
                operation: 'render',
                renderMode: 'final',
                canvasScope: 'document',
                qualityPath: 'raster',
                hostMemoryBytes: policy.totalRamBytes,
                ...(canStreamRasters ? {rasterWindow: policy.rasterConcurrency} : {}),
                options,
                ...(documentCanvas === null ? {} : {documentCanvas}),
                experimental: {
                    autoDewarp: request.options.autoDewarp ?? false,
                    ...(request.options.autoDewarpDepth === undefined
                        ? {}
                        : {autoDewarpDepth: request.options.autoDewarpDepth}),
                },
                pages: batchPageInputs,
                allowedPathRoot: paths.tempDir,
            });
            const pages = manifest.pages;
            for (const page of pages) manifestPageBySource.set(page.sourcePageIndex + 1, page);
            const manifestPath = join(scratch, `cleanup-manifest-${String(batch.batchIndex)}.json`);
            await writeFile(manifestPath, JSON.stringify(manifest));
            let rasterizedCount = batch.startOffset;
            const rasterizedPageNumbers = new Set<number>();
            emitProgress(
                canStreamRasters ? 'rendering' : 'rasterizing',
                batch.startOffset,
                pageCount,
                renderedPageNumbers,
            );
            const rasterize = async (operationSignal: AbortSignal) => {
                await mapScanCleanupRasterPages(batchRasterPlans, policy.rasterConcurrency, async (plan, index) => {
                    operationSignal.throwIfAborted();
                    const page = batchPageInputs[index]!;
                    const renderer = rasterHandoff.format === 'ppm'
                        ? dependencies.renderPagePpm
                        : dependencies.renderPage;
                    const guardrail = plan.guardrail;
                    const limits: IScanCleanupRasterRenderLimits = {
                        expectedWidthPx: Math.max(1, Math.ceil(guardrail.width * plan.dpi / guardrail.dpi)),
                        expectedHeightPx: Math.max(1, Math.ceil(guardrail.height * plan.dpi / guardrail.dpi)),
                        maxPixels: resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode),
                        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                    };
                    const analysisLimits: IScanCleanupRasterRenderLimits = {
                        expectedWidthPx: Math.max(
                            1,
                            Math.ceil(guardrail.width * canonicalAnalysisDpi / guardrail.dpi),
                        ),
                        expectedHeightPx: Math.max(
                            1,
                            Math.ceil(guardrail.height * canonicalAnalysisDpi / guardrail.dpi),
                        ),
                        maxPixels: resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode),
                        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
                    };
                    await renderer(
                        paths,
                        log,
                        plan.pageNumber,
                        prepared.pdfPath,
                        page.analysisInputPath,
                        canonicalAnalysisDpi,
                        undefined,
                        operationSignal,
                        undefined,
                        analysisLimits,
                        renderBoxByPage?.get(plan.pageNumber) ?? 'cropbox',
                    );
                    await renderer(
                        paths,
                        log,
                        plan.pageNumber,
                        prepared.pdfPath,
                        page.inputPath,
                        plan.dpi,
                        undefined,
                        operationSignal,
                        undefined,
                        limits,
                        renderBoxByPage?.get(plan.pageNumber) ?? 'cropbox',
                    );
                    if (!canStreamRasters) {
                        const dimensions = rasterHandoff.format === 'ppm'
                            ? await readPpmDimensions(page.inputPath)
                            : await readPngDimensions(page.inputPath);
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
                    }
                    rasterizedCount += 1;
                    rasterizedPageNumbers.add(plan.pageNumber);
                    if (!canStreamRasters) {
                        emitProgress('rasterizing', rasterizedCount, pageCount, rasterizedPageNumbers);
                    }
                });
            };
            const sourcePageNumberByManifestIndex = new Map(pages.map((page, index) => [
                index + 1,
                page.sourcePageIndex + 1,
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
                        const analysisPath = batchPageInputs.find(page => page.pageNumber === sourcePageNumber)
                            ?.analysisInputPath;
                        if (analysisPath !== undefined) {
                            const release = rm(analysisPath, {force: true});
                            // Attach a handler immediately so a sidecar failure
                            // cannot turn a best-effort scratch release into an
                            // unhandled rejection before the outer finally block
                            // has a chance to observe it.
                            void release.catch(() => undefined);
                            analysisReleasePromises.push(release);
                        }
                    }
                }
                emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
            };
            const sidecarCapabilities = await runRasterProducerConsumer<IScanCleanupSidecarProtocolCapabilities | undefined>({
                signal,
                stream: canStreamRasters,
                ...(canStreamRasters ? {createStreams: () => dependencies.createRasterPipes!(
                    batchPageInputs.map(page => page.inputPath),
                    signal,
                    log,
                )} : {}),
                produce: rasterize,
                consume: operationSignal => dependencies.runSidecar(
                    paths.scanCleanupBinary,
                    manifestPath,
                    operationSignal,
                    log,
                    reportNativeProgress,
                    {allowedPathRoot: paths.tempDir},
                ),
                onProducerComplete: () => {
                    if (!canStreamRasters) {
                        emitProgress('rendering', renderedPageNumbers.size, pageCount, renderedPageNumbers);
                    }
                },
            });
            // Rejections are observed and reported by the outer finally block;
            // this barrier only ensures every scratch release has settled before
            // collection begins.
            await Promise.allSettled(analysisReleasePromises);
            emitProgress('collecting', collectedPages, pageCount, []);
            for (const [
                pageIndex,
                page,
            ] of pages.entries()) {
                const {outputs} = page;
                const pageMetadata = decodeNativeScanCleanupPageMetadataJson(
                    await readFile(page.pageMetadataPath, 'utf8'),
                );
                const sourcePageNumber = page.sourcePageIndex + 1;
                pageMetadataBySource.set(sourcePageNumber, pageMetadata);
                emitProgress('collecting', collectedPages + pageIndex + 1, pageCount);
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
                            output.backgroundOutputPath,
                            requirePageNumber(pageNumber),
                            'mixed background layer',
                        );
                        if (metadata.layeredForegroundKind === 'soft-alpha') {
                            foregroundAlphaPath = await requireProducedRasterFile(
                                requirePublishedRaster,
                                output.foregroundAlphaOutputPath,
                                pageNumber,
                                'mixed soft foreground alpha',
                            );
                        } else {
                            foregroundMaskPath = await requireProducedRasterFile(
                                requirePublishedRaster,
                                output.foregroundMaskOutputPath,
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
                                : readPpmDimensions(foregroundAlphaPath),
                        ]);
                        const renderDpi = metadata.renderDpi
                        ?? pageDpi.get(pageNumber)
                        ?? documentDpi;
                        const backgroundDpi = metadata.layeredBackgroundDpi;
                        const foregroundDpi = metadata.layeredForegroundKind === 'soft-alpha'
                            ? metadata.layeredForegroundDpi
                            : renderDpi;
                        if (
                            !Number.isFinite(renderDpi)
                        || renderDpi <= 0
                        || backgroundDpi === undefined
                        || !Number.isFinite(backgroundDpi)
                        || backgroundDpi <= 0
                        || foregroundDpi === undefined
                        || !Number.isFinite(foregroundDpi)
                        || foregroundDpi <= 0
                        ) {
                            throw new Error(`Page ${pageNumber} mixed layer DPI metadata is invalid`);
                        }
                        const expectedBackgroundWidth = Math.max(
                            1,
                            metadata.matchedCanvasTargetWidthPoints !== null
                            && metadata.matchedCanvasTargetWidthPoints !== undefined
                            && Number.isFinite(metadata.matchedCanvasTargetWidthPoints)
                            && metadata.matchedCanvasTargetWidthPoints > 0
                                ? Math.round(metadata.matchedCanvasTargetWidthPoints / 72 * backgroundDpi)
                                : Math.round(metadata.canvasWidthPx * backgroundDpi / renderDpi),
                        );
                        const expectedBackgroundHeight = Math.max(
                            1,
                            metadata.matchedCanvasTargetHeightPoints !== null
                            && metadata.matchedCanvasTargetHeightPoints !== undefined
                            && Number.isFinite(metadata.matchedCanvasTargetHeightPoints)
                            && metadata.matchedCanvasTargetHeightPoints > 0
                                ? Math.round(metadata.matchedCanvasTargetHeightPoints / 72 * backgroundDpi)
                                : Math.round(metadata.canvasHeightPx * backgroundDpi / renderDpi),
                        );
                        const expectedForegroundWidth = Math.max(
                            1,
                            Math.round(metadata.canvasWidthPx * foregroundDpi / renderDpi),
                        );
                        const expectedForegroundHeight = Math.max(
                            1,
                            Math.round(metadata.canvasHeightPx * foregroundDpi / renderDpi),
                        );
                        const dimensionsMismatch =
                            foregroundHeader.width !== expectedForegroundWidth
                        || foregroundHeader.height !== expectedForegroundHeight
                        || backgroundHeader.width !== expectedBackgroundWidth
                        || backgroundHeader.height !== expectedBackgroundHeight;
                        if (dimensionsMismatch) {
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
                                        pageSizes?.[pageNumber - 1],
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
                            const warning =
                                `Page ${pageNumber} mixed layer dimensions do not match metadata `
                            + `(background ${backgroundHeader.width}x${backgroundHeader.height}, `
                            + `expected ${expectedBackgroundWidth}x${expectedBackgroundHeight}; `
                            + `foreground ${foregroundHeader.width}x${foregroundHeader.height}, `
                            + `expected ${expectedForegroundWidth}x${expectedForegroundHeight}); `
                            + `using ${fallbackDescription}`;
                            summary.warnings.push(warning);
                            log('error', `Scan cleanup: ${warning}`);
                        } else {
                            backgroundPath = candidateBackgroundPath;
                            backgroundIsColor = backgroundHeader.isColor;
                        }
                    } else if (metadata.bilevelWritten) {
                        bilevelPath = await requireProducedRasterFile(
                            requirePublishedRaster,
                            output.bilevelOutputPath,
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
                        resolvedOutputMode: metadata.outputMode
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
                        pageSizes?.[pageNumber - 1],
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
                        sidecarCapabilities,
                        fittedMarginBoxPages,
                        report,
                    );
                }
                if (request.options.readingOrder === 'rtl' && pageMetadata.layoutClassification === 'two-page-spread') {
                    pageOutputPages.reverse();
                }
                outputPages.push(...pageOutputPages);
                if (intentionallyBlankOutputCount > 0 && pageOutputPages.length > 0) {
                    for (const half of resolveBlankOutputHalves(
                        pageMetadata,
                        pageOutputPages,
                        intentionallyBlankOutputCount,
                    )) {
                        emptyOutputMappings.push({
                            sourcePage: sourcePageNumber,
                            half,
                            outputOrdinal: null,
                            rotationDegrees: pageMetadata.rotationDegrees,
                            excluded: false,
                            blank: true,
                        });
                    }
                } else if (pageOutputPages.length === 0) {
                    emptyOutputMappings.push({
                        sourcePage: sourcePageNumber,
                        half: 'full',
                        outputOrdinal: null,
                        rotationDegrees: pageMetadata.rotationDegrees,
                        excluded: false,
                        blank: true,
                    });
                }
                if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
                if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
            }
            collectedPages += pages.length;
        });
        if (fittedMarginBoxPages.size > 0) {
            reportScanCleanupSummaryWarningEvent(summary, {event: {
                code: 'matched-canvas-content-fitted-pages',
                pages: [...fittedMarginBoxPages].map(pageNumber => requirePageNumber(pageNumber)),
            }}, report);
        }
        summary.outputPages = outputPages.length;
        if (outputPages.length === 0) throw new Error('evb-scan-cleanup produced no output pages');
        const combineManifestPages = outputPages.map(output => {
            const pageWidthPoints = output.metadata.matchedCanvasTargetWidthPoints
                ?? output.metadata.canvasWidthPx / output.dpi * 72;
            const pageHeightPoints = output.metadata.matchedCanvasTargetHeightPoints
                ?? output.metadata.canvasHeightPx / output.dpi * 72;
            const pageSize = [
                pageWidthPoints.toFixed(6),
                pageHeightPoints.toFixed(6),
            ];
            const imagePlacement = output.metadata.pdfImagePlacement;
            if (
                imagePlacement !== undefined
                && (output.bilevelPath !== undefined || output.backgroundPath !== undefined)
            ) {
                throw new Error(
                    `Page ${String(output.sourcePageNumber)} attached continuous-tone placement `
                    + 'to a bilevel or layered page',
                );
            }
            const placementFields = imagePlacement === undefined
                ? []
                : validatePdfImagePlacement(
                    imagePlacement,
                    pageWidthPoints,
                    pageHeightPoints,
                    output.sourcePageNumber,
                ).map(value => value.toFixed(6));
            if (output.bilevelPath !== undefined) {
                return [
                    'image-bilevel',
                    ...pageSize,
                    output.bilevelPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundAlphaPath !== undefined
            ) {
                return [
                    'soft-layered-jpeg',
                    ...pageSize,
                    output.backgroundIsColor
                        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                    output.backgroundPath,
                    output.foregroundAlphaPath,
                ].join('\t');
            }
            if (
                output.backgroundPath !== undefined
                && output.foregroundMaskPath !== undefined
            ) {
                if (output.metadata.layeredForegroundKind === 'source-mrc') {
                    const layers = trustedMrcLayersByPage.get(output.sourcePageNumber);
                    if (layers === undefined) {
                        throw new Error(
                            `Page ${String(output.sourcePageNumber)} published source-MRC metadata `
                            + 'without its extracted source layers',
                        );
                    }
                    const matrix = sourceMrcForegroundPdfMatrix(
                        output,
                        layers,
                        pageWidthPoints,
                        pageHeightPoints,
                    );
                    return [
                        'affine-masked-layered-jpeg',
                        ...pageSize,
                        output.backgroundIsColor
                            ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                            : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                        output.backgroundPath,
                        layers.foregroundPath,
                        layers.selectionMaskPath,
                        ...matrix.map(value => value.toFixed(10)),
                        layers.selectionMaskDecode,
                    ].join('\t');
                }
                return [
                    'layered-jpeg',
                    ...pageSize,
                    output.backgroundIsColor
                        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
                        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
                    output.backgroundPath,
                    output.foregroundMaskPath,
                ].join('\t');
            }
            const jpegQuality = resolveTonalJpegQuality(output.resolvedOutputMode);
            return (jpegQuality === undefined
                ? [
                    'image',
                    ...pageSize,
                    output.path,
                    ...placementFields,
                ]
                : [
                    'image-jpeg',
                    ...pageSize,
                    jpegQuality,
                    output.path,
                    ...placementFields,
                ]).join('\t');
        });
        const hasCompactSourcePages = outputPages.some(output => output.preservedSource !== undefined);
        const outputMappings: IScanCleanupOutputMapping[] = outputPages.map((output, outputIndex) => ({
            sourcePage: output.sourcePageNumber,
            half: output.metadata.half ?? 'full',
            outputOrdinal: outputIndex + 1,
            rotationDegrees: output.metadata.rotationDegrees,
            excluded: false,
            blank: false,
        }));
        outputMappings.push(...emptyOutputMappings);
        const effectiveOptions = mapScanCleanupPageScope(pageNumbers, (sourcePage) => {
            const page = manifestPageBySource.get(sourcePage);
            if (page === undefined) {
                throw new Error(`Scan cleanup lost manifest page ${String(sourcePage)} during batching`);
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
            ?? (canStreamRasters && rasterHandoff.format === 'ppm'
                ? 'fifo-ppm'
                : rasterHandoff.format === 'ppm' ? 'file-ppm' : 'file-png');
        const buildIds = await buildScanCleanupStampBuildIds({
            paths,
            assemblerBackend,
            transportMode,
            ...(dependencies.hashNativeBinary === undefined
                ? {}
                : {hashNativeBinary: dependencies.hashNativeBinary}),
        });
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: await sha256ScanCleanupFile(prepared.pdfPath),
            effectiveOptions,
            outputMappings,
            pagePlanDigests,
            buildIds,
        });
        const provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
        await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
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
                EVB_PDF_COMBINE_MAX_PAGES: String(Math.max(outputPages.length, 1)),
                EVB_PDF_COMBINE_MAX_OUTPUT_BYTES: String(resolveCombineOutputByteCap(outputPages.length)),
            },
            onStdout: createPdfCombineProgressHandler(
                outputPages.length,
                (processed, total) => emitProgress('assembling', processed, total),
                line => log('debug', `Ignoring malformed scan cleanup combine progress: ${line}`),
            ),
            log,
        });
        await assembleWithCompactSourcePages(
            outputPages,
            paths,
            prepared.pdfPath,
            rasterizedPdfPath,
            stagedPdfPath,
            scratch,
            signal,
            log,
            dependencies,
            provenanceStampHex,
        );
        // Source OCR is positioned in PDF user space. Native cleanup publishes
        // the exact affine from the rendered source raster into each output,
        // so affine pages can retain that searchable layer without retaining
        // any source image or paint operators. Cylindrically dewarped pages do
        // not have one PDF matrix and intentionally remain raster-only.
        const textLayerPlan = pageSizes === null
            ? await buildScanCleanupTextLayerPlanFromPageSizeStore(
                outputPages,
                geometryPageSizeStore,
                signal,
            )
            : buildScanCleanupTextLayerPlan(outputPages, pageSizes);
        if (
            textLayerPlan.pages.length > 0
            && paths.pdfPageOpsBinary !== undefined
            && !isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
        ) {
            const textLayerInstructionsPath = join(scratch, 'source-text-layer.json');
            const textLayerPdfPath = join(scratch, 'text-layer-cleaned.pdf');
            await writeFile(
                textLayerInstructionsPath,
                serializeScanCleanupTextLayerInstructions(textLayerPlan.pages),
            );
            await dependencies.runCommand(paths.pdfPageOpsBinary, [
                'overlay-text',
                '--input',
                stagedPdfPath,
                '--source',
                prepared.pdfPath,
                '--qpdf',
                paths.qpdfBinary,
                '--output',
                textLayerPdfPath,
                '--instructions-file',
                textLayerInstructionsPath,
            ], {
                signal,
                commandLabel: 'evb-pdf-page-ops(overlay-text:scan-cleanup)',
                timeoutMs: 10 * 60 * 1000,
                log,
            });
            await rename(textLayerPdfPath, stagedPdfPath);
            log(
                'debug',
                `Scan cleanup retained source text on ${String(textLayerPlan.pages.length)} output page(s)`,
            );
        } else if (textLayerPlan.pages.length > 0) {
            log(
                'debug',
                'Scan cleanup could not retain source text because native PDF page ops is unavailable',
            );
        }
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
            stat(prepared.pdfPath),
            stat(stagedPdfPath),
        ]);
        if (outputFile.size <= 0) throw new Error('PDF assembler produced an empty file');
        const compactSourceBudget = resolveScanCleanupCompactSourceBudget({
            documentPageCount,
            options: request.options,
            pageRasterByNumber: detectedRasterByPage,
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
            pages: outputPages.map((output, outputIndex) => {
                const sourceRaster = detectedRasterByPage.get(output.sourcePageNumber);
                return {
                    outputPageNumber: outputIndex + 1,
                    outputOrdinal: outputIndex + 1,
                    sourcePageNumber: output.sourcePageNumber,
                    semanticMode: output.resolvedOutputMode,
                    representation: output.preservedSource !== undefined
                        ? 'preserved-compact-source'
                        : output.bilevelPath !== undefined
                            ? 'bilevel'
                            : output.backgroundPath !== undefined
                                ? 'mixed'
                                : output.resolvedOutputMode,
                    preservationReason: output.preservedSource?.reason ?? null,
                    sourceDpi: resolvePageSourceDpi(output.sourcePageNumber),
                    sourceBackgroundDpi: sourceRaster?.backgroundDpi ?? null,
                    renderDpi: output.dpi,
                    illuminationNormalized: output.metadata.illuminationNormalized === true,
                    textToneApplied: output.metadata.textToneDiagnostics?.applied === true,
                    binarizationMode: output.metadata.binarizationMode ?? null,
                    half: output.metadata.half ?? 'full',
                    rotationDegrees: output.metadata.rotationDegrees,
                    excluded: false,
                    blank: false,
                    renderGeometry: {
                        canvasHeightPx: output.metadata.canvasHeightPx,
                        canvasWidthPx: output.metadata.canvasWidthPx,
                        ...(output.metadata.cropRect === undefined
                            ? {}
                            : {cropRect: output.metadata.cropRect}),
                        ...(output.metadata.dewarpMapping === undefined
                            ? {}
                            : {dewarpMapping: output.metadata.dewarpMapping}),
                        ...(output.metadata.foldClipLeftPx === undefined
                            ? {}
                            : {foldClipLeftPx: output.metadata.foldClipLeftPx}),
                        ...(output.metadata.foldClipRightPx === undefined
                            ? {}
                            : {foldClipRightPx: output.metadata.foldClipRightPx}),
                        dewarped: output.metadata.dewarpMapping != null,
                        forwardTransform: output.metadata.forwardTransform,
                        ...(output.metadata.inputHeightPx === undefined
                            ? {}
                            : {inputHeightPx: output.metadata.inputHeightPx}),
                        ...(output.metadata.inputWidthPx === undefined
                            ? {}
                            : {inputWidthPx: output.metadata.inputWidthPx}),
                        ...(output.metadata.intrinsicRasterHeightPx === undefined
                            ? {}
                            : {intrinsicRasterHeightPx: output.metadata.intrinsicRasterHeightPx}),
                        ...(output.metadata.intrinsicRasterWidthPx === undefined
                            ? {}
                            : {intrinsicRasterWidthPx: output.metadata.intrinsicRasterWidthPx}),
                        ...(output.metadata.matchedCanvasContentHeightPx === undefined
                            ? {}
                            : {matchedCanvasContentHeightPx: output.metadata.matchedCanvasContentHeightPx}),
                        ...(output.metadata.matchedCanvasContentWidthPx === undefined
                            ? {}
                            : {matchedCanvasContentWidthPx: output.metadata.matchedCanvasContentWidthPx}),
                        ...(output.metadata.matchedCanvasIntrinsicOverflowLeftPx === undefined
                            ? {}
                            : {matchedCanvasIntrinsicOverflowLeftPx: output.metadata.matchedCanvasIntrinsicOverflowLeftPx}),
                        ...(output.metadata.matchedCanvasIntrinsicOverflowRightPx === undefined
                            ? {}
                            : {matchedCanvasIntrinsicOverflowRightPx: output.metadata.matchedCanvasIntrinsicOverflowRightPx}),
                        ...(output.metadata.matchedCanvasIntrinsicOverflowTopPx === undefined
                            ? {}
                            : {matchedCanvasIntrinsicOverflowTopPx: output.metadata.matchedCanvasIntrinsicOverflowTopPx}),
                        outputHeightPx: output.metadata.outputHeightPx,
                        outputWidthPx: output.metadata.outputWidthPx,
                        placementOffsetXPx: output.metadata.placementOffsetXPx,
                        placementOffsetYPx: output.metadata.placementOffsetYPx,
                        ...(output.metadata.sourceRegion === undefined
                            ? {}
                            : {sourceRegion: output.metadata.sourceRegion}),
                    },
                    ...(streamBytesByOutput.get(output) === undefined
                        ? {}
                        : {streamBytes: streamBytesByOutput.get(output)!}),
                };
            }),
        } satisfies IScanCleanupRepresentationReport;
        await writeFile(
            join(scratch, 'scan-cleanup-representation-report.json'),
            JSON.stringify(representationReport, null, 2),
        );
        assertScanCleanupCompactSourceBudget(outputFile.size, compactSourceBudget);
        await validateStagedPdf(paths.qpdfBinary, stagedPdfPath, signal, log, dependencies.runCommand);
        emitProgress('handoff', 0, pageCount, []);
        await copyFile(stagedPdfPath, publishTempPath);
        if (signal.aborted) throw signal.reason;
        await rename(publishTempPath, request.outputPdfPath);
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
        if (pageSizeStore !== null) {
            await pageSizeStore.close().catch(error => {
                log('warn', `Failed to close scan cleanup page-size store: ${getErrorMessage(error)}`);
            });
        }
        await observeScanCleanupAnalysisReleasePromises(analysisReleasePromises, log);
        await rm(publishTempPath, {force: true}).catch(() => undefined);
        await preserveScanCleanupJsonEvidence(scratch, log).catch(error => {
            log('warn', `Failed to preserve scan cleanup JSON evidence: ${getErrorMessage(error)}`);
        });
        if (!preserveScratchForDiagnostics) {
            await rm(scratch, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        } else {
            log('warn', `Preserving invalid staged scan cleanup PDF for diagnostics: ${stagedPdfPath}`);
        }
    }
}
