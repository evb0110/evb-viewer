import {
    mkdir,
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {randomUUID} from 'crypto';
import {
    isAbsolute,
    join,
} from 'path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupOwnerContext,
    IScanCleanupNormalizedRect,
    IScanCleanupPixelPoint,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
    TScanCleanupDetectionStartResult,
    TScanCleanupDetectionJobState,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
    type TNativeScanCleanupPreviewOutputArtifactMetadataV3,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {projectScanCleanupDetectionStateForRenderer} from '@contracts/scan-cleanup/ipcResultCodecs';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/progress';
import type {
    INativeScanCleanupReusableGeometryV3,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPlacementOffset,
    resolveScanCleanupPageLayout,
    scanCleanupLayoutSignature,
} from '@contracts/scanCleanupPageOverrides';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {
    createPdfPageSizeStore,
    readPdfPageSizes,
    type IPdfPageSize,
    type IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {
    DETECTION_DPI,
    PREVIEW_DPI,
    createScanCleanupDocumentRasterPages,
    resolvePagePreviewDpi,
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
    runScanCleanupDetection,
    SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES,
    type IScanCleanupDetectionDependencies,
    type IScanCleanupDetectionRetention,
    type IScanCleanupDocumentRasterPages,
    completedPageProgress,
} from '@scan-cleanup-core/detection';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {createArrayBackedPdfPageSizeStore} from '@scan-cleanup-core/pdfPageSizes';
import {
    addScanCleanupDocumentCanvasPage,
    CANVAS_CONTENT_SCALE_EPSILON,
    createScanCleanupDocumentCanvasAccumulator,
    fitScanCleanupMarginAxisPx,
    resolveMatchedCanvasResamplePages,
    isScanCleanupPaperLargerThanCanvas,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupOutputPageRect,
    resolveScanCleanupCanvasGridAtDpi,
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupOutputPaperPixels,
    resolveScanCleanupProvisionalDocumentCanvas,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
    type IScanCleanupDocumentCanvasAccumulator,
} from '@scan-cleanup-core/policy/documentCanvas';
import {
    describeScanCleanupNativeWarnings,
    formatScanCleanupWarningEvent,
    toScanCleanupPercentTenths,
} from '@scan-cleanup-core/policy/scanCleanupWarningEvents';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
} from '@scan-cleanup-adapters/extractPdfMrcLayers';
import {resolveNativePdfImageCombinePath} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/ocr/worker/popplerStage';
import type {TWorkerLog} from '@electron/ocr/worker/types';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {renderScanCleanupRasterBatch} from '@electron/features/scan-cleanup/renderScanCleanupRasterBatch';
import {
    logRasterHandoff,
    readAvailableScratchBytes,
    resolveRasterHandoff,
} from '@scan-cleanup-core/resolveRasterHandoff';
import {
    readScanCleanupPngDimensions as readPngDimensions,
    renderScanCleanupRasterToDisk as renderRasterToDisk,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
} from '@scan-cleanup-core/rasterValidation';
import {
    SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
    classifyScanCleanupError,
    type IScanCleanupJobErrorEnvelope,
    scanCleanupScratchShortfall,
    type IScanCleanupRasterAdmissionPolicy,
    resolveScanCleanupRasterAdmissionPolicy,
    resolveScanCleanupPath,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    createStableJobBrokerOwnerId,
    mainJobBroker,
} from '@electron/resources/jobBroker';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {buildRunnableNativeScanCleanupManifest} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    resolveReusablePagePlan,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupRequestedRenderDpi,
} from '@scan-cleanup-core/policy/effectiveOptions';
import type {
    IDetectedPageRaster,
    IPdfMrcLayers,
    IScanCleanupDetectionResultStore,
    IScanCleanupPageRasterSource,
} from '@scan-cleanup-core/types';
import {detectPageRasterFromPageSize} from '@scan-cleanup-core/types';
import {
    registerScanCleanupDetectionResultStore,
    releaseScanCleanupDetectionResultStores,
} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';
import {shouldExtractTrustedMrcForeground} from '@scan-cleanup-core/policy/scanCleanupRepresentationPolicy';
import {
    createMainJobRegistry,
    type IMainJobSender,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyBackingMetadata,
} from '@electron/file-access/workingCopyStore';
import {
    createJobId,
    type TJobId,
} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';

const DETAIL_TILE_MAX_PIXELS = 4_000_000;
const DEFAULT_SOURCE_DPI = 300;
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const BASE_ANALYSIS_CACHE_PAGE_LIMIT = 32;
// Canonical cleaned previews are retained only so detail tiles can replay the
// exact page-global pixel transform. Bound them independently of the renderer
// payloads so browsing a long document cannot turn detail parity into an
// unbounded main-process heap.
const BASE_ANALYSIS_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const RAW_RASTER_RETENTION_PREFIX = 'scan-cleanup-rasters-';
// How long a background prefetch may wait for the machine before it is dropped.
// A prefetch is an optimisation, so it must never be the reason a page the user
// later opens is already committed to a reservation nothing can grant.
const PREVIEW_PREFETCH_LEASE_TIMEOUT_MS = 10_000;
const PREVIEW_ADMISSION_REISSUED = new Error('Scan cleanup preview readmitted at visible priority');
const RASTER_PAGE_SOURCE_CACHE_LIMIT = 32;
// Keep fallback page probes within the same bounded unit as detection and
// source-DPI probing. The raster cache and decoded page window stay bounded
// independently of this page-number batch size.
const RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
const PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES = 1_024;
const PAGE_MEASUREMENT_CACHE_MAX_ENTRIES = 256;

function normalizeDetectionProgress(progress: TScanCleanupProgress): TScanCleanupProgress {
    if (
        progress.completedUnits > 0
        && progress.completedPageNumbers?.length === 0
        && progress.completedPageNumbersTruncated !== true
    ) {
        return {
            ...progress,
            completedPageNumbersTruncated: true,
        };
    }
    return progress;
}
const logger = createLogger('scan-cleanup-preview');
function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}


interface IRetainedDocument {
    dir: Promise<string>;
    documentRevision: string;
    // Aborted when the document is discarded. Every measurement of this
    // document runs under it, so closing the session stops the native work
    // nobody is waiting for any more, without any one caller's cancellation
    // reaching work the others share.
    lifetime: AbortController;
    // Byte size and nanosecond mtime of the source file at admission. An
    // equal-millisecond replacement of the file must not serve rasters
    // rendered from the bytes it replaced.
    sourceStatIdentity: string;
    pageCount: Promise<number> | null;
    // Legacy preview compatibility keeps its injected page-size array here.
    // Production detection and preview geometry use pageSizeStore instead, so
    // a retained document never allocates one record per source page.
    previewPageSizes: Promise<IPdfPageSize[]> | null;
    // Source DPI is a page fact, not a request fact. Keep one native probe per
    // page for this retained document, just like pageCount and preview geometry.
    sourceDpiByPage: Map<number, Promise<number | null>>;
    // Which pages carry a raster of their own, and whether that could be
    // detected at all. A matched lossless run has to re-render a document whose
    // rasters would otherwise sit on the shared sheet at two resolutions, so a
    // preview that promises lossless needs the same answer the run will reach.
    rasterPages: Promise<IScanCleanupDocumentRasterPages> | null;
    // Detection uses this bounded accessor. It is deliberately separate from
    // the legacy aggregate kept by preview compatibility paths.
    rasterPageSource: Promise<IScanCleanupPageRasterSource> | null;
    rasterPageSourceStore: IPdfPageSizeStore | null;
    // Page geometry can carry the only bounded DPI evidence available before
    // pdfimages has visited a page. Keep that evidence as one scalar so the
    // raster source can expose it without retaining a page-indexed map.
    pageGeometryDpi: number | null;
    // Core owns the detection loop, so retention owns every store it asks us
    // to open and closes them when the retained document leaves the cache.
    // Keeping this set small is also what makes repeated direct reads safe.
    pageSizeStores: Set<IPdfPageSizeStore>;
    // Ordinary previews need only the requested page's raster facts. The
    // whole-document result remains separate and lazy for matched lossless
    // decisions.
    rasterPageByPage: Map<number, Promise<IScanCleanupDocumentRasterPages>>;
    pinned: number;
    removeWhenIdle: boolean;
    sourcePdfPath: string;
}

interface IRetainedRawRaster {
    document: IRetainedDocument;
    dpi: number;
    height: number;
    pageNumber: number;
    path: string;
    sizeBytes: number;
    width: number;
}

interface IRawPreview extends IRetainedRawRaster {
    bytes: Uint8Array;
    totalPages: number;
}

type INativePreviewOutputMetadata = TNativeScanCleanupPreviewOutputArtifactMetadataV3;

interface IBasePreviewAnalysis {
    sourcePdfPath: string;
    documentRevision: string;
    sourceStatIdentity: string;
    outputMode?: TScanCleanupOutputMode;
    pageMetadata: IScanCleanupPreviewResult['pageMetadata'];
    outputs: Partial<Record<IScanCleanupPreviewMetadata['half'], INativePreviewOutputMetadata>>;
    analysisDirectory: string;
    canonicalRasterPaths: Partial<Record<IScanCleanupPreviewMetadata['half'], string>>;
    baseMetadataPaths: Partial<Record<IScanCleanupPreviewMetadata['half'], string>>;
    canonicalRasterBytes: number;
    baseRenderDpi: number;
}

// A run's admission is mutable for as long as it is still waiting for one: a
// prefetch the user navigates onto becomes the visible page and must be
// readmitted as one, because the reservation a background run asks for can be
// ungrantable for as long as detection holds the machine.
interface IPreviewAdmission {
    granted: boolean;
    reissue: (() => void) | null;
    visibility: TPreviewVisibility;
}

interface IPreviewEntry {
    admission: IPreviewAdmission;
    controller: AbortController;
    generation: number;
    pageNumber: number;
    request: IScanCleanupPreviewRequest;
    senderId: number;
    tail: Promise<TScanCleanupPreviewWireResult>;
}

interface IPreviewOwnerBinding {
    handleDestroyed: () => void;
    handleRenderProcessGone: () => void;
    sender: IScanCleanupDetectionSubscriber;
}

function rasterFromLegacyProbe(
    source: IScanCleanupDocumentRasterPages,
    pageNumber: number,
): IDetectedPageRaster | undefined {
    if (!source.pages.has(pageNumber)) {
        return undefined;
    }
    const raster: IDetectedPageRaster = {
        // The old injected result has no pixel dimensions. Detection only
        // needs a valid raster record when a test exercises this adapter.
        dpi: source.sourceDpiByPage?.get(pageNumber) ?? DETECTION_DPI,
        width: 1,
        height: 1,
    };
    if (source.bilevelLayerPages?.has(pageNumber)) raster.hasBilevelLayer = true;
    if (source.dominantBilevelLayerPages?.has(pageNumber)) raster.hasDominantBilevelLayer = true;
    const backgroundDpi = source.backgroundDpiByPage?.get(pageNumber);
    if (backgroundDpi !== undefined) raster.backgroundDpi = backgroundDpi;
    return raster;
}

interface IBoundedPreviewGeometry {
    accumulator: IScanCleanupDocumentCanvasAccumulator;
    pageSize: IPdfPageSize | undefined;
    previewDpi: number;
    pageSourceDpi: number | undefined;
}

/**
 * Read the document geometry as bounded chunks and retain only the constant
 * canvas summary plus the requested page. The compatibility array path is
 * kept in runPreview for injected tests; production never enters it.
 */
async function readBoundedPreviewGeometry(
    store: IPdfPageSizeStore,
    totalPages: number,
    request: Pick<IScanCleanupPreviewRequest, 'pageNumber' | 'layoutByPage' | 'options'>,
): Promise<IBoundedPreviewGeometry> {
    const accumulator = createScanCleanupDocumentCanvasAccumulator();
    let expectedPageNumber = 1;
    let pageSize: IPdfPageSize | undefined;
    let pageSourceDpi: number | undefined;
    let allPagesHaveRasterMetadata = true as boolean;
    let documentDpi = 0;
    await store.forEachChunk(chunk => {
        if (chunk.pageCount !== totalPages) {
            throw new Error(
                `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(totalPages)} document pages`,
            );
        }
        for (const page of chunk.pages) {
            if (page.pageNumber !== expectedPageNumber) {
                throw new Error(
                    `Scan cleanup page-size store returned page ${String(page.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                );
            }
            addScanCleanupDocumentCanvasPage(
                accumulator,
                page,
                request.options,
                request.layoutByPage?.[String(page.pageNumber)],
            );
            const raster = detectPageRasterFromPageSize(page);
            if (raster === undefined) {
                allPagesHaveRasterMetadata = false;
            } else {
                documentDpi = Math.max(documentDpi, raster.dpi);
                if (page.pageNumber === request.pageNumber) {
                    pageSourceDpi = raster.dpi;
                }
            }
            if (page.pageNumber === request.pageNumber) {
                pageSize = page;
            }
            expectedPageNumber += 1;
        }
    });
    if (expectedPageNumber - 1 !== totalPages) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(expectedPageNumber - 1)} pages for ${String(totalPages)} document pages`,
        );
    }
    const previewDpi = allPagesHaveRasterMetadata && documentDpi > 0
        ? Math.min(PREVIEW_DPI, documentDpi)
        : PREVIEW_DPI;
    return {
        accumulator,
        pageSize,
        previewDpi,
        pageSourceDpi: allPagesHaveRasterMetadata ? pageSourceDpi : undefined,
    };
}

function resolvePreviewPageShares(
    options: IScanCleanupPreviewRequest['options'],
    pageNumber: number,
    layoutByPage: IScanCleanupPreviewRequest['layoutByPage'],
) {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageNumber),
    );
    const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    if (layout === 'force-two-page' || layout === 'keep-left' || layout === 'keep-right') {
        return 2;
    }
    if (layout === 'force-single') {
        return 1;
    }
    if (pageOverride.manualSplit !== null) {
        return 2;
    }
    return layoutByPage?.[String(pageNumber)] === 'two-page-spread' ? 2 : 1;
}

function isScanCleanupSignalAborted(signal: AbortSignal) {
    return signal.aborted;
}

/** Check matched-canvas resampling without building a page-number collection. */
async function hasBoundedMatchedRasterResample(input: {
    canvas: NonNullable<ReturnType<typeof resolveScanCleanupDocumentCanvasFromAccumulator>>;
    layoutByPage: IScanCleanupPreviewRequest['layoutByPage'];
    options: IScanCleanupPreviewRequest['options'];
    pageSizeStore: IPdfPageSizeStore;
    rasterSource: IScanCleanupPageRasterSource;
}) {
    let resampleRequired = false;
    await input.pageSizeStore.forEachChunk(async chunk => {
        if (resampleRequired) {
            return;
        }
        for (
            let offset = 0;
            offset < chunk.pages.length;
            offset += RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES
        ) {
            const pages = chunk.pages.slice(offset, offset + RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES);
            const rasters = input.rasterSource.detected
                ? await Promise.all(
                    pages.map(page => Promise.resolve(input.rasterSource.getPageRaster(page.pageNumber))),
                )
                : pages.map(() => undefined);
            for (const [
                index,
                page,
            ] of pages.entries()) {
                if (getScanCleanupPageOverride(
                    input.options.pageOverrides,
                    requirePageNumber(page.pageNumber),
                ).excluded) {
                    continue;
                }
                const carriesRaster = !input.rasterSource.detected || rasters[index] !== undefined;
                if (!carriesRaster) continue;
                const paper = resolveScanCleanupOutputPageRect(
                    page,
                    resolvePreviewPageShares(input.options, page.pageNumber, input.layoutByPage),
                );
                const scale = resolveScanCleanupCanvasFitScale(input.canvas, paper);
                if (Math.abs(scale - 1) > CANVAS_CONTENT_SCALE_EPSILON) {
                    resampleRequired = true;
                    return;
                }
            }
        }
    });
    return resampleRequired;
}

interface IDetectionResult {
    results: TScanCleanupDetectionJobState['results'];
    resultStore: IScanCleanupDetectionResultStore;
    resultStoreId?: string;
    placementAnchorSummary?: TScanCleanupDetectionJobState['placementAnchorSummary'];
}

type TDetectionError = IScanCleanupJobErrorEnvelope;
type TDetectionSnapshot = TMainJobSnapshot<TScanCleanupDetectionJobState, IDetectionResult, TDetectionError>;
export interface IScanCleanupDetectionSubscriber extends IMainJobSender {id: number;}

type TPreviewVisibility = 'visible' | 'detail' | 'prefetch';

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    getPageSizes: typeof readPdfPageSizes;
    /** Native-backed bounded geometry reader used by production detection. */
    getPageSizeStore?: (
        pdfPath: Parameters<typeof createPdfPageSizeStore>[0],
        options: Parameters<typeof createPdfPageSizeStore>[1],
    ) => IPdfPageSizeStore | Promise<IPdfPageSizeStore>;
    prefetchLeaseTimeoutMs?: number;
    publishRaster: typeof atomicReplace;
    renderPage: typeof renderPdfPageToPng;
    renderPagePpm: typeof renderPdfPageToPpm;
    renderPageBatch?: typeof renderScanCleanupRasterBatch;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<void>;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    resolvePageOpsBinary: () => string | null;
    resolvePdfInfoBinary?: () => string | undefined;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    detectSourceDpi?: (sourcePdfPath: string, pageNumber: number, signal: AbortSignal) => Promise<number | null>;
    detectRasterPages?: (
        sourcePdfPath: string,
        signal: AbortSignal,
        pageNumbers?: readonly number[],
    ) => Promise<IScanCleanupDocumentRasterPages>;
    /** Whether bounded pdfimages probes can distinguish raster from vector pages. */
    isRasterDetectionAvailable?: () => boolean;
    extractMrcLayers?: (
        sourcePdfPath: string,
        pageNumber: number,
        selectionMaskOutputPath: string,
        backgroundOutputPath: string,
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<IPdfMrcLayers | null>;
    acquireDetectionLease?: (
        jobId: string,
        signal: AbortSignal,
        rasterPolicy: IScanCleanupRasterAdmissionPolicy,
    ) => Promise<{release: () => boolean}>;
    acquirePreviewLease?: (
        ownerId: string,
        visibility: TPreviewVisibility,
        signal: AbortSignal,
    ) => Promise<{release: () => boolean}>;
    getSourceStatIdentity?: (sourcePdfPath: string) => Promise<string>;
    materializeWorkingCopy: typeof ensureWorkingCopyMaterialized;
}

const defaultDependencies: IScanCleanupPreviewDependencies = {
    getPageCount: getPdfPageCount,
    getPageSizes: readPdfPageSizes,
    getPageSizeStore: createPdfPageSizeStore,
    publishRaster: atomicReplace,
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    renderPageBatch: renderScanCleanupRasterBatch,
    createRasterPipes: async (paths, signal, log) => {
        await runNativeToolCommand('mkfifo', [...paths], {
            signal,
            commandLabel: 'mkfifo(scan-cleanup-detection-streams)',
            log,
        });
    },
    runSidecar: runScanCleanupSidecar,
    resolveBinary: resolveScanCleanupPath,
    resolvePageOpsBinary: () => (isNativePageOpsDisabled() ? null : resolveNativePageOpsPath()),
    resolvePdfInfoBinary: () => getPdfNativeToolPaths().pdfinfo,
    getTempDir: getAppTempDir,
    getPdftoppmBinary: () => getPdfNativeToolPaths().pdftoppm,
    detectSourceDpi: async (sourcePdfPath, pageNumber, signal) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(
            sourcePdfPath,
            paths.pdfimages,
            logScanCleanupMessage,
            undefined,
            signal,
            [pageNumber],
        );
        return result.pageDpiByNumber.get(pageNumber) ?? null;
    },
    detectRasterPages: async (sourcePdfPath, signal, pageNumbers) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(
            sourcePdfPath,
            paths.pdfimages,
            logScanCleanupMessage,
            undefined,
            signal,
            pageNumbers,
        );
        return createScanCleanupDocumentRasterPages(
            paths.pdfimages !== undefined,
            result.pageRasterByNumber,
        );
    },
    isRasterDetectionAvailable: () => getPdfNativeToolPaths().pdfimages !== undefined,
    extractMrcLayers: async (
        sourcePdfPath,
        pageNumber,
        selectionMaskOutputPath,
        backgroundOutputPath,
        signal,
        log,
    ) => {
        const paths = getPdfNativeToolPaths();
        const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
        if (pdfImageCombineBinary !== null) {
            // The native raster reader intentionally dispatches by extension:
            // compact JBIG2 selections and decoded PPM backgrounds must retain
            // their real formats even though the legacy preview extractor's
            // caller-facing destinations predate those representations.
            const compactSelectionPath = `${selectionMaskOutputPath}.jb2e`;
            const decodedBackgroundPath = `${backgroundOutputPath}.ppm`;
            const extracted = await extractPdfMrcLayersBatch({
                pdfPath: sourcePdfPath,
                targets: [{
                    pageNumber,
                    selectionMaskOutputPath: compactSelectionPath,
                    backgroundOutputPath: decodedBackgroundPath,
                    foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
                }],
                pdfimagesBinary: paths.pdfimages,
                qpdfBinary: paths.qpdf,
                pdfImageCombineBinary,
                pdftoppmBinary: paths.pdftoppm,
                runCommand: runNativeToolCommand,
                log,
                rasterConcurrency: 1,
                signal,
            });
            return extracted.get(pageNumber) ?? null;
        }
        return extractPdfMrcLayers({
            pdfPath: sourcePdfPath,
            pageNumber,
            selectionMaskOutputPath,
            backgroundOutputPath,
            foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
            pdfimagesBinary: paths.pdfimages,
            runCommand: runNativeToolCommand,
            log,
            signal,
        });
    },
    acquireDetectionLease: (ownerId, signal, rasterPolicy) => {
        return mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-detect-all',
            priority: 'user',
            resources: {
                cpuTokens: rasterPolicy.rasterConcurrency,
                estimatedResidentBytes: rasterPolicy.rasterConcurrency
                    * SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                // POSIX detection streams rasterizers into one concurrently
                // running classifier sidecar. Account for that sidecar; the
                // broker's interactive burst stays available to document tabs.
                nativeProcesses: rasterPolicy.rasterConcurrency
                    + Number(rasterPolicy.rasterStreaming),
                ioWeight: 2,
            },
            perOwnerLimit: 1,
            signal,
        });
    },
    acquirePreviewLease: (ownerId, visibility, signal) => {
        // A preview run rasterizes a page and then hands it to one sidecar; it
        // never runs both at once, so a single native process is its true peak.
        // Scan Cleanup owns bulk capacity only. Detection budgets a native slot
        // for its preview work, while the broker's interactive reserve remains
        // exclusively available to other document tabs opening and rendering.
        return mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-preview',
            priority: visibility === 'prefetch' ? 'background' : 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            signal,
        });
    },
    getSourceStatIdentity: async (sourcePdfPath) => {
        const sourceStat = await stat(sourcePdfPath, {bigint: true});
        return `${sourceStat.size}:${sourceStat.mtimeNs}`;
    },
    materializeWorkingCopy: (logicalRef, options) => {
        // Preview work is queued, so the owning tab can close or reopen the
        // document before the tail runs. A registration this owner held and
        // that has since been retired or replaced makes the request moot, and
        // it is reported as a cancellation rather than letting the materializer
        // raise an ownership error out of the IPC handler. A path this owner
        // never held is a real failure and keeps its error, so an unmanaged or
        // wrong-owner source is not hidden behind a spinner.
        if (
            !getWorkingCopyBackingEntry(logicalRef, options.ownerWebContentsId)
            && getWorkingCopyBackingMetadata(logicalRef, options.ownerWebContentsId)?.retired === true
        ) {
            return Promise.reject(new DOMException(
                'Scan cleanup source is no longer available',
                'AbortError',
            ));
        }
        return ensureWorkingCopyMaterialized(logicalRef, options);
    },
};

// Turning a page cancels the render of the page being left. That is the normal
// course of a session, not a failure, so it answers the invoke instead of
// rejecting it: a rejected invoke is logged by Electron as a handler error and
// would bury the failures worth reading.
function isPreviewCancellation(error: unknown) {
    return error instanceof Error
        && (error.name === 'AbortError'
            || (error as {code?: unknown}).code === 'WORKING_COPY_MATERIALIZATION_CANCELLED');
}

async function materializeScanCleanupPreviewRequest<
    T extends IScanCleanupPreviewRequest | IScanCleanupDetectionRequest,
>(
    request: T,
    senderId: number,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<T> {
    signal.throwIfAborted();
    const materialized = await dependencies.materializeWorkingCopy(request.sourcePdfPath, {
        ownerWebContentsId: senderId,
        reason: 'scan-cleanup',
        signal,
    });
    return {
        ...request,
        sourcePdfPath: materialized.physicalWorkingCopyPath,
    };
}

// Detection and preview render the same page at the same DPI with the same
// arguments, so a rendered raster is kept in a document-scoped directory keyed
// by the source path, the document revision and the source byte-size and
// nanosecond-mtime snapshot, and whoever asks for that page next reads the
// file instead of spawning pdftoppm again.
// The directory holds paths and dimensions only: the bytes are read on demand
// and never held, and the retained footprint is bounded by the same scratch
// budget the final-run pipeline spends through resolveRasterHandoff.
// Exported because this is the object detection's bounded window drives as its
// retention: its ownership rules are a contract between the two and are pinned
// directly rather than through whichever window happens to exercise them.
export function createRawRasterRetention(dependencies: IScanCleanupPreviewDependencies) {
    const documents = new Map<string, IRetainedDocument>();
    const opening = new Map<string, Promise<IRetainedDocument>>();
    const rasters = new Map<string, IRetainedRawRaster>();
    // Rasters another consumer has taken since detection staged them. A preview
    // that adopts one names its path in a manifest of its own and then runs a
    // sidecar against it, so detection's bounded window must give up its claim
    // instead of unlinking the file mid-read. Ownership passes to this index,
    // which is where every other retained raster already lives.
    const adoptedRasters = new Set<string>();
    let retainedBytes = 0;
    let root: Promise<string> | null = null;
    let budget: Promise<number> | null = null;
    const pendingStoreClosures = new Set<Promise<void>>();

    // Unlinking a retained raster is best effort: the index has already given
    // the file up, and a filesystem that refuses the unlink must not turn a
    // reclaimed slot into a failed run.
    const removeQuietly = (path: string) => rm(path, {
        force: true,
        recursive: true,
    }).catch(error => logger.warn(`Failed to drop a retained scan cleanup raster: ${getErrorMessage(error)}`));
    const remove = (path: string) => {
        void removeQuietly(path);
    };
    // A raster is a function of the document identity, the page and the DPI
    // alone, so it has exactly one path inside the document's directory. A
    // re-render publishes over that path through atomicReplace, which is the
    // same replace-in-place the rest of the app commits files with: a consumer
    // that captured the path for a sidecar manifest keeps reading a complete
    // raster with the bytes it asked for instead of finding the file another
    // request unlinked underneath it, and on Windows a live destination is
    // moved aside rather than failing the rename with EPERM/EACCES.
    const stableRasterPath = (dir: string, pageNumber: number, dpi: number) => join(dir, `page-${pageNumber}-${dpi}.png`);
    const rasterKey = (document: IRetainedDocument, pageNumber: number, dpi: number) => JSON.stringify([
        document.sourcePdfPath,
        document.documentRevision,
        document.sourceStatIdentity,
        pageNumber,
        dpi,
    ]);
    const forget = (key: string, raster: IRetainedRawRaster) => {
        rasters.delete(key);
        adoptedRasters.delete(key);
        retainedBytes -= raster.sizeBytes;
    };
    const ensureRoot = () => {
        root ??= (async () => {
            // One directory per process run: retention is a within-run cache,
            // not a durable artifact store, and a reused pid must not inherit a
            // dead run's rasters.
            const path = join(dependencies.getTempDir(), `${RAW_RASTER_RETENTION_PREFIX}${process.pid}`);
            await rm(path, {
                force: true,
                recursive: true,
            });
            await mkdir(path, {recursive: true});
            return path;
        })();
        return root;
    };
    const resolveBudgetBytes = () => {
        budget ??= ensureRoot()
            .then(path => resolveRasterHandoff([], path, readAvailableScratchBytes))
            .then(handoff => handoff.budgetBytes ?? 0);
        return budget;
    };
    const closePageSizeStores = (document: IRetainedDocument) => {
        const stores = document.pageSizeStores;
        document.pageSizeStores = new Set();
        document.rasterPageSourceStore = null;
        document.rasterPageSource = null;
        const closing = Promise.all([...stores].map(store => store.close().catch(error => {
            logger.warn(`Scan cleanup could not close the raster page-size store: ${getErrorMessage(error)}`);
        }))).then(() => undefined);
        pendingStoreClosures.add(closing);
        void closing.finally(() => pendingStoreClosures.delete(closing));
        return closing;
    };
    const discard = (document: IRetainedDocument) => {
        for (const [
            key,
            raster,
        ] of rasters) {
            if (raster.document === document) forget(key, raster);
        }
        if (documents.get(document.sourcePdfPath) === document) documents.delete(document.sourcePdfPath);
        document.lifetime.abort(new DOMException('Scan cleanup document was closed', 'AbortError'));
        const storesClosed = closePageSizeStores(document);
        // A request from another window may still be rendering into this
        // directory or feeding one of its rasters to a sidecar, so the files
        // outlive the invalidation that dropped them from the index.
        if (document.pinned > 0) {
            document.removeWhenIdle = true;
            return;
        }
        void Promise.all([
            document.dir,
            storesClosed,
        ]).then(([directory]) => remove(directory), () => undefined);
    };
    const prune = async () => {
        const budgetBytes = await resolveBudgetBytes();
        for (const [
            key,
            raster,
        ] of rasters) {
            if (retainedBytes <= budgetBytes) {
                return;
            }
            if (raster.document.pinned > 0) continue;
            forget(key, raster);
            remove(raster.path);
        }
    };
    const resolveDocument = async (
        request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
    ) => {
        const sourceStatIdentity = await dependencies.getSourceStatIdentity?.(request.sourcePdfPath) ?? '';
        const current = documents.get(request.sourcePdfPath);
        if (
            current
            && current.documentRevision === request.documentRevision
            && current.sourceStatIdentity === sourceStatIdentity
        ) {
            current.pinned += 1;
            return current;
        }
        if (current) discard(current);
        const document: IRetainedDocument = {
            dir: ensureRoot().then(async path => {
                const dir = join(path, randomUUID());
                await mkdir(dir, {recursive: true});
                return dir;
            }),
            documentRevision: request.documentRevision,
            lifetime: new AbortController(),
            sourceStatIdentity,
            pageCount: null,
            previewPageSizes: null,
            sourceDpiByPage: new Map(),
            rasterPages: null,
            rasterPageSource: null,
            rasterPageSourceStore: null,
            pageGeometryDpi: null,
            pageSizeStores: new Set(),
            rasterPageByPage: new Map(),
            pinned: 1,
            removeWhenIdle: false,
            sourcePdfPath: request.sourcePdfPath,
        };
        documents.set(request.sourcePdfPath, document);
        return document;
    };

    // A measurement of the document is shared by everyone who asks for it, so
    // it must not carry any one caller's cancellation. It runs under the
    // document's own lifetime instead, and each awaiter races it against its
    // own signal: a dropped prefetch that started the measurement stops waiting
    // for it while the visible page it was measuring for still gets the answer,
    // and closing the document stops the native process for everyone. A failed
    // measurement is forgotten so the next request measures again; a successful
    // one is kept for the life of the document.
    const resolveDocumentMeasurement = <TValue>(
        slot: {
            read: () => Promise<TValue> | null;
            write: (value: Promise<TValue> | null) => void;
        },
        signal: AbortSignal,
        measure: () => Promise<TValue>,
    ) => {
        signal.throwIfAborted();
        let pending = slot.read();
        if (!pending) {
            pending = measure();
            slot.write(pending);
            const started = pending;
            void started.catch(() => {
                if (slot.read() === started) slot.write(null);
            });
        }
        const shared = pending;
        return new Promise<TValue>((resolve, reject) => {
            const onAbort = () => {
                reject(signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Scan cleanup document measurement was abandoned', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, {once: true});
            shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    };
    const resolveDocumentPageMeasurement = <TValue>(
        slots: Map<number, Promise<TValue>>,
        pageNumber: number,
        signal: AbortSignal,
        measure: () => Promise<TValue>,
    ) => resolveDocumentMeasurement(
        {
            read: () => {
                const pending = slots.get(pageNumber);
                if (pending !== undefined) {
                    slots.delete(pageNumber);
                    slots.set(pageNumber, pending);
                }
                return pending ?? null;
            },
            write: value => {
                if (value === null) {
                    slots.delete(pageNumber);
                } else {
                    slots.delete(pageNumber);
                    slots.set(pageNumber, value);
                    while (slots.size > PAGE_MEASUREMENT_CACHE_MAX_ENTRIES) {
                        const oldest = slots.keys().next().value;
                        if (oldest === undefined) break;
                        slots.delete(oldest);
                    }
                }
            },
        },
        signal,
        measure,
    );
    const resolvePageCount = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.pageCount,
            write: value => {
                document.pageCount = value;
            },
        },
        signal,
        () => dependencies.getPageCount(document.sourcePdfPath, {signal: document.lifetime.signal}),
    );
    // The paper rectangle of every page, which is what a matched canvas is
    // measured from. It answers from page metadata before a single page has
    // been rendered and is the same for every page and for the final run, so
    // the frame does not move as pages are previewed — with one exception the
    // preview names rather than hides: the canvas is also measured from the
    // layouts detection has settled, and a pass that turns a page into a spread
    // does change the rectangle every page is drawn on. That is why a preview
    // is keyed by the spread layouts it was measured against, and why the
    // preview pane says so while detection is still running.
    //
    // A measurement that fails is *not* an answer: it is rejected and
    // forgotten, so the next request measures again instead of the session
    // holding a failure. Its caller drops matching for that request and warns.
    const resolvePreviewPageSizes = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.previewPageSizes,
            write: value => {
                document.previewPageSizes = value;
            },
        },
        signal,
        async () => {
            try {
                const pdfPageOpsBinary = dependencies.resolvePageOpsBinary();
                const pdfinfoBinary = dependencies.resolvePdfInfoBinary?.();
                if (!pdfPageOpsBinary && !pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                return await dependencies.getPageSizes(document.sourcePdfPath, {
                    ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                    ...(pdfinfoBinary ? {pdfinfoBinary} : {}),
                    tempDir: await document.dir,
                    signal: document.lifetime.signal,
                    log: logScanCleanupMessage,
                });
            } catch (error) {
                logger.warn(`Scan cleanup could not measure the document canvas: ${getErrorMessage(error)}`);
                throw new Error(
                    `Scan cleanup could not measure this document's page sizes, which matched page size needs: ${getErrorMessage(error)}`,
                );
            }
        },
    );

    const observePageSize = (document: IRetainedDocument, page: IPdfPageSize) => {
        const raster = detectPageRasterFromPageSize(page);
        if (raster !== undefined) {
            document.pageGeometryDpi = Math.max(document.pageGeometryDpi ?? 0, raster.dpi);
        }
    };
    const observePageSizeStore = (
        document: IRetainedDocument,
        store: IPdfPageSizeStore,
    ): IPdfPageSizeStore => {
        const fork = store.fork === undefined
            ? undefined
            : () => observePageSizeStore(document, store.fork!());
        return {
            get pageCount() {
                return store.pageCount;
            },
            getPage: async pageNumber => {
                const page = await store.getPage(pageNumber);
                observePageSize(document, page);
                return page;
            },
            readRange: async (firstPageNumber, lastPageNumberExclusive) => {
                const pages = await store.readRange(firstPageNumber, lastPageNumberExclusive);
                for (const page of pages) observePageSize(document, page);
                return pages;
            },
            forEachChunk: async onChunk => {
                await store.forEachChunk(async chunk => {
                    for (const page of chunk.pages) observePageSize(document, page);
                    await onChunk(chunk);
                });
            },
            close: () => store.close(),
            ...(fork === undefined ? {} : {fork}),
        };
    };

    const resolvePageSizeStore = async (
        document: IRetainedDocument,
        signal: AbortSignal,
    ): Promise<IPdfPageSizeStore> => {
        signal.throwIfAborted();
        if (dependencies.getPageSizeStore === undefined) {
            // This branch exists for focused tests that inject only the old
            // array dependency. Production supplies getPageSizeStore above.
            const pageCount = await resolvePageCount(document, signal);
            if (pageCount > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
                throw new Error(
                    'Scan cleanup page geometry requires a bounded page-size store for large documents',
                );
            }
            const store = createArrayBackedPdfPageSizeStore(
                await resolvePreviewPageSizes(document, signal),
                pageCount,
            );
            if (document.lifetime.signal.aborted) {
                await store.close();
                throw document.lifetime.signal.reason;
            }
            const observedStore = observePageSizeStore(document, store);
            document.pageSizeStores.add(observedStore);
            return observedStore;
        }
        const paths = getPdfNativeToolPaths();
        const pdfPageOpsBinary = dependencies.resolvePageOpsBinary();
        const pdfinfoBinary = dependencies.resolvePdfInfoBinary?.();
        if (!pdfPageOpsBinary && !pdfinfoBinary) {
            throw new Error('no PDF tool is available to read page geometry');
        }
        const store = await dependencies.getPageSizeStore(document.sourcePdfPath, {
            ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
            ...(pdfinfoBinary ? {pdfinfoBinary} : {}),
            qpdfBinary: paths.qpdf,
            tempDir: await document.dir,
            signal: document.lifetime.signal,
            log: logScanCleanupMessage,
        });
        if (document.lifetime.signal.aborted) {
            await store.close();
            throw document.lifetime.signal.reason;
        }
        const observedStore = observePageSizeStore(document, store);
        document.pageSizeStores.add(observedStore);
        return observedStore;
    };

    const resolveRasterPageSource = (
        document: IRetainedDocument,
        signal: AbortSignal,
    ) => resolveDocumentMeasurement(
        {
            read: () => document.rasterPageSource,
            write: value => {
                document.rasterPageSource = value;
            },
        },
        signal,
        async () => {
            let pageSizeStore: IPdfPageSizeStore | null = null;
            try {
                pageSizeStore = await resolvePageSizeStore(document, signal);
                document.lifetime.signal.throwIfAborted();
                document.rasterPageSourceStore = pageSizeStore;
            } catch (error) {
                // A raster probe remains useful when page-ops is unavailable.
                // The detection retention opens its own geometry store and
                // still reports that failure at the point where geometry is
                // required, so this source never turns a bounded raster probe
                // into an all-pages array fallback.
                logger.warn(`Scan cleanup could not open page geometry for raster facts: ${getErrorMessage(error)}`);
            }
            const rasterPageSizeStore = pageSizeStore?.fork?.() ?? pageSizeStore;
            if (rasterPageSizeStore !== null && rasterPageSizeStore !== pageSizeStore) {
                document.pageSizeStores.add(rasterPageSizeStore);
            }

            // PdfPageSizeStore forks have an independent cursor, but the
            // optional fork() capability is absent from older injected stores.
            // Keep those cursor-only stores safe when two raster windows ask
            // for distant pages at once. A forked store can still serve its
            // requests concurrently.
            const serializePageReads = rasterPageSizeStore === pageSizeStore;
            let pageReadTail = Promise.resolve();
            const readPageSize = async (pageNumber: number) => {
                if (rasterPageSizeStore === null) {
                    return undefined;
                }
                if (!serializePageReads) {
                    return rasterPageSizeStore.getPage(pageNumber);
                }
                const read = pageReadTail.then(() => rasterPageSizeStore.getPage(pageNumber));
                pageReadTail = read.then(() => undefined, () => undefined);
                return read;
            };

            const pageRasterCache = new Map<number, Promise<IDetectedPageRaster | undefined>>();
            const pendingRasterReads = new Map<number, {
                reject: (error: unknown) => void;
                resolve: (raster: IDetectedPageRaster | undefined) => void
            }>();
            let rasterReadFlushScheduled = false;
            let documentDpi: number | null = null;
            const observeRaster = (raster: IDetectedPageRaster | undefined) => {
                if (
                    raster !== undefined
                    && Number.isFinite(raster.dpi)
                    && raster.dpi > 0
                ) {
                    documentDpi = Math.max(documentDpi ?? 0, raster.dpi);
                }
                return raster;
            };
            const flushRasterReads = () => {
                rasterReadFlushScheduled = false;
                if (pendingRasterReads.size === 0) {
                    return;
                }
                const entries = [...pendingRasterReads.entries()]
                    .slice(0, RASTER_PAGE_SOURCE_PROBE_BATCH_PAGES);
                for (const [pageNumber] of entries) pendingRasterReads.delete(pageNumber);
                const pageNumbers = entries.map(([pageNumber]) => pageNumber);
                void Promise.all(pageNumbers.map(async pageNumber => {
                    try {
                        return await readPageSize(pageNumber);
                    } catch (error) {
                        if (document.lifetime.signal.aborted) throw error;
                        logger.warn(`Scan cleanup could not read page ${String(pageNumber)} geometry for raster facts: ${getErrorMessage(error)}`);
                        return undefined;
                    }
                })).then(async pageSizes => {
                    const rasters = pageSizes.map(pageSize => (
                        pageSize === undefined ? undefined : detectPageRasterFromPageSize(pageSize)
                    ));
                    const missingPageNumbers = pageNumbers.filter((_, index) => rasters[index] === undefined);
                    const probed = missingPageNumbers.length === 0 || dependencies.detectRasterPages === undefined
                        ? undefined
                        : await dependencies.detectRasterPages(
                            document.sourcePdfPath,
                            document.lifetime.signal,
                            missingPageNumbers,
                        );
                    for (const dpi of probed?.sourceDpiByPage?.values() ?? []) {
                        if (Number.isFinite(dpi) && dpi > 0) {
                            documentDpi = Math.max(documentDpi ?? 0, dpi);
                        }
                    }
                    for (const [
                        index,
                        [
                            pageNumber,
                            waiter,
                        ],
                    ] of entries.entries()) {
                        waiter.resolve(observeRaster(
                            rasters[index] ?? (probed === undefined
                                ? undefined
                                : rasterFromLegacyProbe(probed, pageNumber)),
                        ));
                    }
                }, error => {
                    for (const [
                        ,
                        waiter,
                    ] of entries) {
                        waiter.reject(error);
                    }
                }).finally(() => {
                    if (pendingRasterReads.size > 0) {
                        rasterReadFlushScheduled = true;
                        void Promise.resolve().then(flushRasterReads);
                    }
                }).catch(() => undefined);
            };
            const readRasterPage = (pageNumber: number) => new Promise<IDetectedPageRaster | undefined>((resolve, reject) => {
                pendingRasterReads.set(pageNumber, {
                    resolve,
                    reject,
                });
                if (!rasterReadFlushScheduled) {
                    rasterReadFlushScheduled = true;
                    void Promise.resolve().then(flushRasterReads);
                }
            });
            const getPageRaster = (pageNumber: number) => {
                const cached = pageRasterCache.get(pageNumber);
                if (cached !== undefined) {
                    pageRasterCache.delete(pageNumber);
                    pageRasterCache.set(pageNumber, cached);
                    return cached;
                }
                const pending = readRasterPage(pageNumber);
                pageRasterCache.set(pageNumber, pending);
                if (pageRasterCache.size > RASTER_PAGE_SOURCE_CACHE_LIMIT) {
                    const oldest = pageRasterCache.keys().next().value;
                    if (oldest !== undefined && oldest !== pageNumber) {
                        pageRasterCache.delete(oldest);
                    }
                }
                void pending.catch(() => {
                    if (pageRasterCache.get(pageNumber) === pending) {
                        pageRasterCache.delete(pageNumber);
                    }
                });
                return pending;
            };

            const source: IScanCleanupPageRasterSource = {
                detected: dependencies.isRasterDetectionAvailable?.()
                    ?? dependencies.detectRasterPages !== undefined,
                get documentDpi() {
                    return Math.max(documentDpi ?? 0, document.pageGeometryDpi ?? 0) || null;
                },
                getPageRaster,
            };
            return source;
        },
    );

    const resolveSourceDpi = (
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
    ) => resolveDocumentPageMeasurement(
        document.sourceDpiByPage,
        pageNumber,
        signal,
        async () => dependencies.detectSourceDpi === undefined
            ? null
            : dependencies.detectSourceDpi(
                document.sourcePdfPath,
                pageNumber,
                document.lifetime.signal,
            ),
    );

    // Where the document's own rasters are, measured once per document. A
    // matched lossless preview needs the whole answer to decide whether the run
    // this preview is standing in for can stay lossless; detection also keeps
    // using this whole-document result for reconciliation.
    const resolvePreviewRasterPages = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.rasterPages,
            write: value => {
                document.rasterPages = value;
            },
        },
        signal,
        async () => {
            if (!dependencies.detectRasterPages) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            const totalPages = await resolvePageCount(document, signal);
            // The aggregate reader is a compatibility seam for focused tests
            // and small injected documents only. Production detection receives
            // rasterPageSource below and never calls this all-page adapter.
            if (totalPages > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
                // A legacy dependency that omits pageNumbers would otherwise
                // turn this call into an implicit all-document pdfimages scan.
                // Large documents use rasterPageSource, whose page accessor
                // probes only the requested bounded window.
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            let pageNumbers: number[] | undefined;
            if (totalPages <= PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
                pageNumbers = [];
                for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
                    pageNumbers.push(pageNumber);
                }
            }
            return dependencies.detectRasterPages(
                document.sourcePdfPath,
                document.lifetime.signal,
                pageNumbers,
            );
        },
    );
    const resolveRasterPage = (
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
    ) => resolveDocumentPageMeasurement(
        document.rasterPageByPage,
        pageNumber,
        signal,
        async () => {
            if (!dependencies.detectRasterPages) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    dominantBilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            return dependencies.detectRasterPages(
                document.sourcePdfPath,
                document.lifetime.signal,
                [pageNumber],
            );
        },
    );

    return {
        // Serialized per source path so two concurrent requests cannot each
        // create a directory for the same document. The returned document is
        // already pinned, so nothing can invalidate its directory between the
        // lookup and the caller's first render; every caller releases it.
        openDocument(request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>) {
            const pending = (opening.get(request.sourcePdfPath) ?? Promise.resolve())
                .then(() => resolveDocument(request), () => resolveDocument(request));
            opening.set(request.sourcePdfPath, pending);
            // Keep only work that is still in flight. The identity check is
            // essential: a later caller may have chained a new open behind
            // this one before it settles, and that newer promise must retain
            // the per-path serialization slot.
            void pending.finally(() => {
                if (opening.get(request.sourcePdfPath) === pending) {
                    opening.delete(request.sourcePdfPath);
                }
            }).catch(() => undefined);
            return pending;
        },
        // qpdf --show-npages costs over a second on a cold document for a value
        // that cannot change while the revision and the mtime hold.
        pageCount: resolvePageCount,
        previewPageSizes: resolvePreviewPageSizes,
        pageSizeStore: resolvePageSizeStore,
        sourceDpi: resolveSourceDpi,
        previewRasterPages: resolvePreviewRasterPages,
        rasterPageSource: resolveRasterPageSource,
        rasterPage: resolveRasterPage,
        // Where a render writes before it is published: private to the render,
        // so an abandoned or failed one leaves the page's retained raster alone.
        // pdftoppm derives its own output name by dropping the extension, so
        // this stays a .png path with the run's identity in front of it.
        async rasterScratchPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            return join(await document.dir, `page-${pageNumber}-${dpi}.${randomUUID()}.part.png`);
        },
        // Where that render will land once it is published. A raster has one
        // path per document, page and DPI, so detection can name every Analyze
        // input in its manifest before it stages the first one, and a page the
        // bounded window dropped is republished at the identical path.
        async stagedRasterPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            return stableRasterPath(await document.dir, pageNumber, dpi);
        },
        // Drops one staged raster and its index entry. The bounded detection
        // window calls this to reclaim a slot and to roll a failed run back, so
        // the page must remain re-renderable at the same path afterwards.
        async releaseRaster(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const key = rasterKey(document, pageNumber, dpi);
            if (adoptedRasters.has(key)) {
                // Someone else is reading this exact file. The window gives its
                // slot back either way; the raster itself stays in the index and
                // leaves with the ordinary budget sweep, which skips it for as
                // long as that consumer keeps the document pinned.
                //
                // The adoption outlives this call. Clearing it here would make
                // the release non-idempotent: a second release of the same page
                // -- a retried eviction, or a rollback that drops what the
                // window still had admitted -- would then unlink a path another
                // consumer has already named in a sidecar manifest. Ownership
                // returns to the window only when `retain` republishes the path
                // or `forget` drops the entry.
                return;
            }
            const raster = rasters.get(key);
            if (raster) forget(key, raster);
            // The index entry is already gone, so the slot is reclaimed even if
            // the unlink is refused; the stale file is then dropped with the
            // document's directory instead of failing the window's rollback.
            await removeQuietly(raster?.path ?? stableRasterPath(await document.dir, pageNumber, dpi));
        },
        // Which of these pages the index can hand over as a file, without
        // reading a byte. A raster is a function of the source, the revision,
        // the mtime, the page and the DPI alone, so a caller that re-renders a
        // page held here would produce the same file it already has.
        async retainedPaths(document: IRetainedDocument, pageNumbers: readonly number[], dpi: number) {
            const retained = new Map<number, IRetainedRawRaster>();
            for (const pageNumber of pageNumbers) {
                const key = rasterKey(document, pageNumber, dpi);
                const raster = rasters.get(key);
                if (!raster) {
                    continue;
                }
                try {
                    await stat(raster.path);
                } catch {
                    forget(key, raster);
                    continue;
                }
                // Re-insert so a reused raster counts as the most recent use and
                // the budget sweep drops a colder page first.
                rasters.delete(key);
                rasters.set(key, raster);
                retained.set(pageNumber, raster);
            }
            return retained;
        },
        async read(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const key = rasterKey(document, pageNumber, dpi);
            const raster = rasters.get(key);
            if (!raster) {
                return null;
            }
            rasters.delete(key);
            try {
                const bytes = await readPreviewBytes(raster.path);
                rasters.set(key, raster);
                adoptedRasters.add(key);
                return {
                    bytes,
                    raster,
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    rasters.set(key, raster);
                    throw error;
                }
                retainedBytes -= raster.sizeBytes;
                return null;
            }
        },
        async readPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const key = rasterKey(document, pageNumber, dpi);
            const raster = rasters.get(key);
            if (!raster) {
                return null;
            }
            rasters.delete(key);
            try {
                const metadata = await readPreviewMetadata(raster.path);
                const refreshed: IRetainedRawRaster = {
                    ...raster,
                    ...metadata,
                };
                retainedBytes += refreshed.sizeBytes - raster.sizeBytes;
                rasters.set(key, refreshed);
                adoptedRasters.add(key);
                return refreshed;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    rasters.set(key, raster);
                    throw error;
                }
                retainedBytes -= raster.sizeBytes;
                return null;
            }
        },
        // Publishes a rendered scratch raster onto the page's stable path. The
        // previous file at that path is replaced, never unlinked, so a manifest
        // another request is still feeding to a sidecar stays readable.
        async retain(rendered: Omit<IRetainedRawRaster, 'path'> & {scratchPath: string}) {
            const path = stableRasterPath(await rendered.document.dir, rendered.pageNumber, rendered.dpi);
            await dependencies.publishRaster(rendered.scratchPath, path, {
                durable: false,
                markMutationCommitStarted: false,
            });
            const key = rasterKey(rendered.document, rendered.pageNumber, rendered.dpi);
            const previous = rasters.get(key);
            if (previous) forget(key, previous);
            adoptedRasters.delete(key);
            const raster: IRetainedRawRaster = {
                document: rendered.document,
                dpi: rendered.dpi,
                height: rendered.height,
                pageNumber: rendered.pageNumber,
                path,
                sizeBytes: rendered.sizeBytes,
                width: rendered.width,
            };
            rasters.set(key, raster);
            retainedBytes += raster.sizeBytes;
            await prune();
            return raster;
        },
        remove,
        // A request holds its document for as long as it may render into the
        // directory or hand one of its rasters to a sidecar: the budget sweep
        // skips a pinned document, and an invalidated one is removed only once
        // the last request using it has finished.
        async release(document: IRetainedDocument) {
            document.pinned = Math.max(0, document.pinned - 1);
            if (document.pinned > 0) {
                return;
            }
            if (document.removeWhenIdle) {
                const storesClosed = closePageSizeStores(document);
                void Promise.all([
                    document.dir,
                    storesClosed,
                ]).then(([directory]) => remove(directory), () => undefined);
                return;
            }
            await closePageSizeStores(document);
            await prune();
        },
        invalidate(sourcePdfPath: string, documentRevision: string) {
            const document = documents.get(sourcePdfPath);
            if (document?.documentRevision === documentRevision) discard(document);
        },
        async dispose() {
            for (const document of [...documents.values()]) discard(document);
            documents.clear();
            opening.clear();
            await Promise.all([...pendingStoreClosures]);
            rasters.clear();
            adoptedRasters.clear();
            retainedBytes = 0;
            const rootPath = await root?.catch(() => null);
            if (rootPath !== null && rootPath !== undefined) {
                await rm(rootPath, {
                    recursive: true,
                    force: true,
                });
            }
            root = null;
            budget = null;
        },
    };
}

type TRawRasterRetention = ReturnType<typeof createRawRasterRetention>;

async function renderUnretainedRawRaster(
    document: IRetainedDocument,
    pageNumber: number,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages: number | undefined,
    dpi: number,
    pageSize: IPdfPageSize | undefined,
) {
    const totalPages = knownTotalPages ?? await retention.pageCount(document, signal);
    if (pageNumber > totalPages) throw new Error('Scan cleanup preview page is out of range');
    const scratchPath = await retention.rasterScratchPath(document, pageNumber, dpi);
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        logScanCleanupMessage,
        pageNumber,
        document.sourcePdfPath,
        scratchPath,
        dpi,
        undefined,
        signal,
        undefined,
        resolveRasterRenderLimits(pageSize, dpi),
    );
    return {
        scratchPath,
        totalPages,
    };
}

async function materializeRawRaster(
    document: IRetainedDocument,
    pageNumber: number,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages?: number,
    dpi = PREVIEW_DPI,
    pageSize?: IPdfPageSize,
): Promise<IRawPreview> {
    const retained = await retention.read(document, pageNumber, dpi);
    if (retained) {
        return {
            ...retained.raster,
            bytes: retained.bytes,
            totalPages: knownTotalPages ?? await retention.pageCount(document, signal),
        };
    }
    const {
        scratchPath,
        totalPages,
    } = await renderUnretainedRawRaster(
        document,
        pageNumber,
        signal,
        retention,
        dependencies,
        knownTotalPages,
        dpi,
        pageSize,
    );
    const bytes = await readPreviewBytes(scratchPath);
    if (signal.aborted) {
        retention.remove(scratchPath);
        throw signal.reason;
    }
    const raster = await retention.retain({
        document,
        dpi,
        ...readPngDimensions(bytes, undefined, 'preview'),
        pageNumber,
        scratchPath,
        sizeBytes: bytes.byteLength,
    });
    return {
        ...raster,
        bytes,
        totalPages,
    };
}

// Native analysis only needs a stable path. Validate the PNG header and file
// size without allocating its compressed payload; the displayed base raster
// still goes through materializeRawRaster so its bytes remain available to the
// renderer.
async function materializeRawRasterPath(
    document: IRetainedDocument,
    pageNumber: number,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages?: number,
    dpi = PREVIEW_DPI,
    pageSize?: IPdfPageSize,
): Promise<IRetainedRawRaster> {
    const retained = await retention.readPath(document, pageNumber, dpi);
    if (retained) {
        return retained;
    }
    const {scratchPath} = await renderUnretainedRawRaster(
        document,
        pageNumber,
        signal,
        retention,
        dependencies,
        knownTotalPages,
        dpi,
        pageSize,
    );
    const metadata = await readPreviewMetadata(scratchPath);
    if (signal.aborted) {
        retention.remove(scratchPath);
        throw signal.reason;
    }
    return retention.retain({
        document,
        dpi,
        ...metadata,
        pageNumber,
        scratchPath,
    });
}

/**
 * The page and the settings that decide what a render would produce — including
 * the layouts the matched canvas is measured from, because a request that would
 * be placed on another rectangle is not the same request.
 */
function previewIdentityKey(request: Omit<IScanCleanupPreviewRequest, 'detail'>) {
    return JSON.stringify({
        sourcePdfPath: request.sourcePdfPath,
        documentRevision: request.documentRevision,
        pageNumber: request.pageNumber,
        options: request.options,
        documentPrior: request.documentPrior ?? null,
        // This resolves Auto before the sidecar runs. Two otherwise identical
        // requests with different recommendations produce different pixels and
        // must neither share nor adopt the same in-flight render.
        outputModeRecommendation: request.outputModeRecommendation ?? null,
        softAlphaForegroundRecommendation: request.softAlphaForegroundRecommendation ?? null,
        pagePlanEvidence: request.pagePlanEvidence ?? null,
        placementAnchors: request.placementAnchors ?? null,
        layoutDetectionComplete: request.options.matchPageSize
            ? request.layoutDetectionComplete === true
            : false,
        layouts: request.options.matchPageSize
            ? scanCleanupLayoutSignature(request.layoutByPage ?? {})
            : '',
    });
}

/**
 * The identity above plus the rectangle and grid the page was actually
 * normalized onto. The canvas is derived from the document alone, so it rarely
 * moves — but an entry is keyed by what the render placed the page on rather
 * than by the reasoning that produced it.
 */
function baseAnalysisKey(
    request: Omit<IScanCleanupPreviewRequest, 'detail'>,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    // Output mode changes pixels, but not the reusable geometric analysis a
    // detail tile consumes. Keep adoption identity mode-sensitive while
    // letting a tile find the base geometry even when Auto was resolved after
    // that base run started.
    const {
        outputModeRecommendation: _outputModeRecommendation,
        softAlphaForegroundRecommendation: _softAlphaForegroundRecommendation,
        ...geometryRequest
    } = request;
    return JSON.stringify({
        identity: previewIdentityKey(geometryRequest),
        documentCanvas,
    });
}

async function persistBaseAnalysisArtifacts(
    outputs: IBasePreviewAnalysis['outputs'],
    canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>>,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
) {
    const analysisDirectory = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-analysis-'));
    const canonicalRasterPaths: IBasePreviewAnalysis['canonicalRasterPaths'] = {};
    const baseMetadataPaths: IBasePreviewAnalysis['baseMetadataPaths'] = {};
    try {
        for (const half of [
            'full',
            'left',
            'right',
        ] as const) {
            const raster = canonicalRasters[half];
            const metadata = outputs[half];
            if (!raster || !metadata) continue;
            signal.throwIfAborted();
            const rasterPath = join(analysisDirectory, `base-cleaned-${half}.png`);
            const metadataPath = join(analysisDirectory, `base-metadata-${half}.json`);
            await writeFile(rasterPath, raster);
            await writeFile(metadataPath, JSON.stringify(metadata));
            canonicalRasterPaths[half] = rasterPath;
            baseMetadataPaths[half] = metadataPath;
        }
        signal.throwIfAborted();
        return {
            analysisDirectory,
            canonicalRasterPaths,
            baseMetadataPaths,
        };
    } catch (error) {
        await rm(analysisDirectory, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

function removeBaseAnalysisArtifacts(analysis: IBasePreviewAnalysis) {
    return rm(analysis.analysisDirectory, {
        recursive: true,
        force: true,
    }).catch(error => {
        logger.warn(`Failed to drop scan cleanup base analysis artifacts: ${getErrorMessage(error)}`);
    });
}

async function pruneBaseAnalysisCache(cache: Map<string, IBasePreviewAnalysis>) {
    let retainedBytes = [...cache.values()]
        .reduce((total, analysis) => total + analysis.canonicalRasterBytes, 0);
    while (
        cache.size > BASE_ANALYSIS_CACHE_PAGE_LIMIT
        || retainedBytes > BASE_ANALYSIS_CACHE_BYTE_LIMIT
    ) {
        const oldest = cache.entries().next().value;
        if (!oldest) {
            return;
        }
        cache.delete(oldest[0]);
        await removeBaseAnalysisArtifacts(oldest[1]);
        retainedBytes -= oldest[1].canonicalRasterBytes;
    }
}

function resolveFallbackDetailDpi(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    raw: Pick<IRawPreview, 'width' | 'height' | 'dpi'>,
    sourceDpi: number,
    sourceRasterDetected: boolean,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const swapsAxes = pageOverride.rotationDegrees === 90 || pageOverride.rotationDegrees === 270;
    const margins = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
    const widthAtPreviewDpi = (swapsAxes ? raw.height : raw.width)
        + (margins.leftMm + margins.rightMm) / 25.4 * raw.dpi;
    const heightAtPreviewDpi = (swapsAxes ? raw.width : raw.height)
        + (margins.topMm + margins.bottomMm) / 25.4 * raw.dpi;
    const canvasWidth = request.options.matchPageSize && documentCanvas ? documentCanvas.widthPx : 0;
    const canvasHeight = request.options.matchPageSize && documentCanvas ? documentCanvas.heightPx : 0;
    const budgetDpi = raw.dpi * Math.sqrt(
        DETAIL_TILE_MAX_PIXELS * 0.98
        / (Math.max(1, widthAtPreviewDpi, canvasWidth)
            * Math.max(1, heightAtPreviewDpi, canvasHeight)),
    );
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi: Math.max(sourceDpi, raw.dpi),
        outputCarriesBinaryLayer:
            request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed',
        sourceRasterDetected,
    });
    return {
        renderDpi: Math.max(1, Math.floor(Math.min(requestedRenderDpi, budgetDpi))),
        requestedRenderDpi,
    };
}

function applyPreviewAffine(
    affine: NonNullable<IScanCleanupPreviewMetadata['forwardTransform']>,
    point: IScanCleanupPixelPoint,
) {
    return {
        x: affine.matrix[0]![0]! * point.x
            + affine.matrix[0]![1]! * point.y
            + affine.matrix[0]![2]!,
        y: affine.matrix[1]![0]! * point.x
            + affine.matrix[1]![1]! * point.y
            + affine.matrix[1]![2]!,
    };
}

function interpolateDewarpOutputToSource(
    mapping: NonNullable<INativeScanCleanupReusableGeometryV3['dewarpMapping']>,
    point: IScanCleanupPixelPoint,
) {
    if (
        mapping.columns < 2
        || mapping.rows < 2
        || mapping.outputWidth <= 0
        || mapping.outputHeight <= 0
        || mapping.outputToSource.length !== mapping.columns * mapping.rows
    ) {
        throw new Error('Scan cleanup base preview has an invalid dewarp mapping');
    }
    const gridX = Math.max(0, Math.min(
        mapping.columns - 1,
        point.x / mapping.outputWidth * (mapping.columns - 1),
    ));
    const gridY = Math.max(0, Math.min(
        mapping.rows - 1,
        point.y / mapping.outputHeight * (mapping.rows - 1),
    ));
    const left = Math.floor(gridX);
    const top = Math.floor(gridY);
    const right = Math.min(mapping.columns - 1, left + 1);
    const bottom = Math.min(mapping.rows - 1, top + 1);
    const tx = gridX - left;
    const ty = gridY - top;
    const at = (column: number, row: number) => mapping.outputToSource[row * mapping.columns + column]!;
    const topLeft = at(left, top);
    const topRight = at(right, top);
    const bottomLeft = at(left, bottom);
    const bottomRight = at(right, bottom);
    return {
        x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
            + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
        y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
            + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
    };
}

function inverseRotatePreviewPoint(
    point: IScanCleanupPixelPoint,
    metadata: Pick<
        IScanCleanupPreviewMetadata,
        'inputWidthPx' | 'inputHeightPx' | 'rotationDegrees'
    >,
) {
    switch (metadata.rotationDegrees) {
        case 0:
            return point;
        case 90:
            return {
                x: point.y,
                y: metadata.inputHeightPx - point.x,
            };
        case 180:
            return {
                x: metadata.inputWidthPx - point.x,
                y: metadata.inputHeightPx - point.y,
            };
        case 270:
            return {
                x: metadata.inputWidthPx - point.y,
                y: point.x,
            };
    }
}

function mapBaseOutputToRawSource(
    metadata: INativePreviewOutputMetadata,
    point: IScanCleanupPixelPoint,
) {
    const rotated = metadata.inverseTransform
        ? applyPreviewAffine(metadata.inverseTransform, point)
        : metadata.dewarpMapping
            ? interpolateDewarpOutputToSource(metadata.dewarpMapping, point)
            : null;
    if (!rotated) {
        throw new Error('Scan cleanup base preview has no reusable detail geometry');
    }
    return inverseRotatePreviewPoint(rotated, metadata);
}

function resolveDetailRenderDpi(
    viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
    outputs: IBasePreviewAnalysis['outputs'],
    requestedRenderDpi: number,
    baseDpi = PREVIEW_DPI,
) {
    let renderDpi = requestedRenderDpi;
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = viewports[half];
        const metadata = outputs[half];
        if (!viewport || !metadata) continue;
        const visiblePixelsAtPreviewDpi = Math.max(
            1,
            metadata.outputWidthPx
                * metadata.outputHeightPx
                * viewport.widthNormalized
                * viewport.heightNormalized,
        );
        const budgetDpi = baseDpi * Math.sqrt(
            DETAIL_TILE_MAX_PIXELS * 0.98 / visiblePixelsAtPreviewDpi,
        );
        renderDpi = Math.min(renderDpi, budgetDpi);
    }
    return Math.max(1, Math.floor(renderDpi));
}

function resolveDetailViewport(
    viewport: IScanCleanupNormalizedRect,
    metadata: INativePreviewOutputMetadata,
    renderScale: number,
) {
    const targetWidth = metadata.outputWidthPx * renderScale;
    const targetHeight = metadata.outputHeightPx * renderScale;
    const left = Math.max(0, Math.floor(viewport.xNormalized * targetWidth));
    const top = Math.max(0, Math.floor(viewport.yNormalized * targetHeight));
    const right = Math.min(
        Math.round(targetWidth),
        Math.ceil((viewport.xNormalized + viewport.widthNormalized) * targetWidth),
    );
    const bottom = Math.min(
        Math.round(targetHeight),
        Math.ceil((viewport.yNormalized + viewport.heightNormalized) * targetHeight),
    );
    return {
        xPx: left,
        yPx: top,
        widthPx: Math.max(1, right - left),
        heightPx: Math.max(1, bottom - top),
    };
}

function resolveDetailSourceCrop(
    metadata: INativePreviewOutputMetadata,
    sampledRegion: IScanCleanupPreviewMetadata['sourceRegion'],
    renderScale: number,
    fullWidth: number,
    fullHeight: number,
) {
    const baseLeft = sampledRegion.xPx / renderScale;
    const baseTop = sampledRegion.yPx / renderScale;
    const baseRight = (sampledRegion.xPx + sampledRegion.widthPx) / renderScale;
    const baseBottom = (sampledRegion.yPx + sampledRegion.heightPx) / renderScale;
    const xSamples = [
        baseLeft,
        baseRight,
    ];
    const ySamples = [
        baseTop,
        baseBottom,
    ];
    const mapping = metadata.inverseTransform ? null : metadata.dewarpMapping;
    if (mapping) {
        for (let column = 1; column < mapping.columns - 1; column += 1) {
            const x = mapping.outputWidth * column / (mapping.columns - 1);
            if (x > baseLeft && x < baseRight) xSamples.push(x);
        }
        for (let row = 1; row < mapping.rows - 1; row += 1) {
            const y = mapping.outputHeight * row / (mapping.rows - 1);
            if (y > baseTop && y < baseBottom) ySamples.push(y);
        }
    }
    // An affine reaches its extrema at the rectangle corners. A bilinear
    // dewarp cell does too, so including every crossed grid boundary is exact.
    const points = xSamples.flatMap(x => ySamples.map(y => mapBaseOutputToRawSource(metadata, {
        x,
        y,
    })));
    const padding = 24;
    const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) * renderScale) - padding);
    const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) * renderScale) - padding);
    const right = Math.min(
        fullWidth,
        Math.ceil(Math.max(...points.map(point => point.x)) * renderScale) + padding,
    );
    const bottom = Math.min(
        fullHeight,
        Math.ceil(Math.max(...points.map(point => point.y)) * renderScale) + padding,
    );
    if (right <= left || bottom <= top) {
        throw new Error('Scan cleanup detail geometry resolved outside the source page');
    }
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

async function readPreviewMetadata(path: string) {
    const file = await stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            throw new Error('Scan cleanup raster produced a truncated PNG');
        }
        return {
            ...readPngDimensions(header, undefined, 'preview'),
            sizeBytes: file.size,
        };
    } finally {
        await handle.close();
    }
}

async function readPreviewBytes(path: string) {
    const file = await stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await readFile(path));
    readPngDimensions(bytes, undefined, 'preview');
    return bytes;
}

async function runDetailPreview(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    signal: AbortSignal,
    baseRaw: IRawPreview,
    baseRasterPath: string,
    analysis: IBasePreviewAnalysis,
    sourceDpiCandidate: number | null | undefined,
    sourceRasterDetected: boolean,
    scratch: string,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<TScanCleanupPreviewWireResult> {
    const sourceDpiDetected = sourceDpiCandidate !== null
        && sourceDpiCandidate !== undefined
        && Number.isFinite(sourceDpiCandidate)
        && sourceDpiCandidate > 0;
    const sourceDpi = sourceDpiDetected ? Number(sourceDpiCandidate) : DEFAULT_SOURCE_DPI;
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi: Math.max(sourceDpi, analysis.baseRenderDpi),
        outputCarriesBinaryLayer: request.detail.outputMode === 'bw',
        sourceRasterDetected,
    });
    const renderDpi = resolveDetailRenderDpi(
        request.detail.viewports,
        analysis.outputs,
        requestedRenderDpi,
        analysis.baseRenderDpi,
    );
    if (renderDpi <= analysis.baseRenderDpi) {
        return {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: analysis.pageMetadata,
            outputs: [],
        };
    }
    const renderScale = renderDpi / analysis.baseRenderDpi;
    const rawRenderScale = renderDpi / baseRaw.dpi;
    const fullSourceWidth = Math.max(1, Math.round(baseRaw.width * rawRenderScale));
    const fullSourceHeight = Math.max(1, Math.round(baseRaw.height * rawRenderScale));
    const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(request.detail.outputMode);
    const binary = dependencies.resolveBinary();
    if (!binary) throw new Error('Scan cleanup native tool is unavailable');

    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const pageInputs = [];
    const outputFiles: Array<{
        outputPath: string;
        metadataPath: string;
    }> = [];
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = request.detail.viewports[half];
        const baseMetadata = analysis.outputs[half];
        if (!viewport || !baseMetadata) continue;
        if (viewport.rotationDegrees !== pageOverride.rotationDegrees) {
            throw new Error('Scan cleanup detail viewport rotation is stale');
        }
        const renderRegion = resolveDetailViewport(
            viewport,
            baseMetadata,
            renderScale,
        );
        const outputWidth = Math.max(1, Math.round(baseMetadata.outputWidthPx * renderScale));
        const outputHeight = Math.max(1, Math.round(baseMetadata.outputHeightPx * renderScale));
        const processingApron = request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed'
            ? 256
            : 8;
        const sampledRegion = {
            xPx: Math.max(0, renderRegion.xPx - processingApron),
            yPx: Math.max(0, renderRegion.yPx - processingApron),
            widthPx: 0,
            heightPx: 0,
        };
        const sampledRight = Math.min(
            outputWidth,
            renderRegion.xPx + renderRegion.widthPx + processingApron,
        );
        const sampledBottom = Math.min(
            outputHeight,
            renderRegion.yPx + renderRegion.heightPx + processingApron,
        );
        sampledRegion.widthPx = sampledRight - sampledRegion.xPx;
        sampledRegion.heightPx = sampledBottom - sampledRegion.yPx;
        const sourceCrop = resolveDetailSourceCrop(
            baseMetadata,
            sampledRegion,
            renderScale,
            fullSourceWidth,
            fullSourceHeight,
        );
        if (
            sourceCrop.width > 40_000
            || sourceCrop.height > 40_000
            || sourceCrop.width * sourceCrop.height > maxSourcePixels
        ) {
            throw new Error(
                `Scan cleanup detail source crop ${sourceCrop.width}x${sourceCrop.height} exceeds native limits`,
            );
        }
        // The tile crop is the sidecar's input and nothing else reads it, so it
        // takes the same handoff the final run takes: raw when the crop fits the
        // scratch budget, PNG when it does not.
        const handoff = await resolveRasterHandoff([{
            renderDpi,
            raster: {
                dpi: renderDpi,
                width: sourceCrop.width,
                height: sourceCrop.height,
            },
        }], scratch, readAvailableScratchBytes);
        logRasterHandoff(logScanCleanupMessage, 'detail tile', handoff);
        const inputPath = join(scratch, `detail-source-${half}.${handoff.format}`);
        const renderedSource = await renderRasterToDisk(
            request.sourcePdfPath,
            request.pageNumber,
            inputPath,
            signal,
            dependencies,
            logScanCleanupMessage,
            renderDpi,
            maxSourcePixels,
            sourceCrop,
            handoff.format,
            {
                expectedWidthPx: sourceCrop.width,
                expectedHeightPx: sourceCrop.height,
                maxPixels: maxSourcePixels,
                maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
            },
            'raster',
            'preview',
        );
        // Poppler clips -W/-H at the physical page edge. The 150-DPI base
        // dimensions can round up by a few scaled pixels, so trust the actual
        // cropped raster dimensions passed to native.
        sourceCrop.width = renderedSource.width;
        sourceCrop.height = renderedSource.height;
        const baseMetadataPath = analysis.baseMetadataPaths[half];
        const baseCleanedRasterPath = analysis.canonicalRasterPaths[half];
        if (!baseMetadataPath || !baseCleanedRasterPath) {
            throw new Error(`Scan cleanup detail has no canonical ${half} base raster`);
        }
        const output = {
            outputPath: join(scratch, `detail-clean-${half}.png`),
            metadataPath: join(scratch, `detail-clean-${half}.json`),
        };
        outputFiles.push(output);
        pageInputs.push({
            inputPath,
            pageNumber: request.pageNumber,
            dpi: renderDpi,
            sourceDpi,
            requestedRenderDpi,
            resolvedOutputMode: request.detail.outputMode,
            pageMetadataPath: join(scratch, `detail-page-${half}.json`),
            outputs: [output],
            detailRenderPlan: {
                baseMetadataPath,
                baseRasterPath,
                baseCleanedRasterPath,
                sourceCrop: {
                    xPx: sourceCrop.x,
                    yPx: sourceCrop.y,
                    widthPx: sourceCrop.width,
                    heightPx: sourceCrop.height,
                },
                fullSourceWidthPx: fullSourceWidth,
                fullSourceHeightPx: fullSourceHeight,
                scale: renderScale,
                renderRegion,
                sampledRegion,
            },
        });
    }
    if (pageInputs.length === 0) {
        throw new Error('Scan cleanup detail request has no matching base output');
    }
    const manifest = buildRunnableNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: effectiveOptions,
        experimental: {autoDewarp: false},
        pages: pageInputs,
        // Detail render reads the retained base analysis rasters, which live in
        // a sibling of this scratch under the app-owned temp root.
        allowedPathRoot: dependencies.getTempDir(),
    });
    const manifestPath = join(scratch, 'detail-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await dependencies.runSidecar(
        binary,
        manifestPath,
        signal,
        logScanCleanupMessage,
        () => undefined,
        {allowedPathRoot: dependencies.getTempDir()},
    );
    const cleaned = [] as IScanCleanupPreviewResult['outputs'];
    for (const output of outputFiles) {
        const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(
            await readFile(output.metadataPath, 'utf8'),
        );
        cleaned.push({
            imageData: await readPreviewBytes(output.outputPath),
            metadata: {
                ...nativeMetadata,
                ...(nativeMetadata.dewarpModel === undefined
                    ? {}
                    : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
            },
        });
    }
    return {
        pageNumber: request.pageNumber,
        totalPages: baseRaw.totalPages,
        rawWidthPx: baseRaw.width,
        rawHeightPx: baseRaw.height,
        pageMetadata: analysis.pageMetadata,
        outputs: cleaned,
    };
}

async function runPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    baseAnalysisCache: Map<string, IBasePreviewAnalysis>,
    dependencies: IScanCleanupPreviewDependencies,
    emitRawRaster: (raw: IScanCleanupRawPreviewEvent) => void,
): Promise<TScanCleanupPreviewWireResult> {
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    const document = await retention.openDocument(request);
    // Created after the document is open, so a failed open does not leave a
    // scratch directory behind with nothing to remove it.
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-preview-'))
        .catch(async (error: unknown) => {
            await retention.release(document);
            throw error;
        });
    try {
        // A scan whose embedded pixels are described as PDF points is a
        // 72-DPI source, not a reason to synthesize a 100-megapixel "150-DPI
        // preview". Page metadata answers without decoding the page and also
        // gives matching its document-wide grid. Only lower the preview grid
        // when every page is proven to be a full-page raster; mixed/vector
        // documents keep the conservative 150-DPI preview.
        const previewWarningEvents: TScanCleanupWarningEvent[] = [];
        const totalPages = await retention.pageCount(document, signal);
        const legacyGeometry = dependencies.getPageSizeStore === undefined;
        if (legacyGeometry && totalPages > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            throw new Error(
                'Scan cleanup preview requires a bounded page-size store for large documents',
            );
        }
        let compatibilityPageSizes: IPdfPageSize[] | null = null;
        let pageSizeStore: IPdfPageSizeStore | null = null;
        let pageSize: IPdfPageSize | undefined;
        let boundedGeometry: IBoundedPreviewGeometry | null = null;
        let previewRasterPlan = resolvePreviewRasterPlan(null, new Map<number, number>());
        try {
            if (legacyGeometry) {
                // The old array reader remains a compatibility seam for
                // focused tests. Production opens the bounded native store.
                compatibilityPageSizes = await retention.previewPageSizes(document, signal);
                pageSize = compatibilityPageSizes.find(candidate => candidate.pageNumber === request.pageNumber);
                previewRasterPlan = resolvePreviewRasterPlan(compatibilityPageSizes);
            } else {
                pageSizeStore = await retention.pageSizeStore(document, signal);
                boundedGeometry = await readBoundedPreviewGeometry(
                    pageSizeStore,
                    totalPages,
                    request,
                );
                pageSize = boundedGeometry.pageSize;
                const pageDpiByNumber = new Map<number, number>();
                if (boundedGeometry.pageSourceDpi !== undefined) {
                    pageDpiByNumber.set(request.pageNumber, boundedGeometry.pageSourceDpi);
                }
                const renderDpiByPageNumber = new Map<number, number>();
                if (pageSize !== undefined) {
                    renderDpiByPageNumber.set(
                        request.pageNumber,
                        resolvePagePreviewDpi(
                            pageSize,
                            Math.min(
                                PREVIEW_DPI,
                                boundedGeometry.pageSourceDpi ?? boundedGeometry.previewDpi,
                            ),
                        ),
                    );
                }
                previewRasterPlan = {
                    dpi: boundedGeometry.previewDpi,
                    pageDpiByNumber,
                    renderDpiByPageNumber,
                };
            }
        } catch (error) {
            if (isScanCleanupSignalAborted(signal)) throw error;
            if (request.options.matchPageSize) {
                const detail = getErrorMessage(error);
                previewWarningEvents.push({
                    code: 'matched-canvas-geometry-unmeasured',
                    detail,
                });
                logger.warn(`Scan cleanup preview dropped matched page size: ${detail}`);
            } else {
                logger.debug(
                    `Scan cleanup preview kept the 150-DPI geometry fallback: ${getErrorMessage(error)}`,
                );
            }
        }
        let sourceDpiCandidate: number | null | undefined;
        if (!request.options.matchPageSize || request.detail !== undefined) {
            sourceDpiCandidate = await retention.sourceDpi(
                document,
                request.pageNumber,
                signal,
            );
        }
        if (!request.options.matchPageSize) {
            if (
                sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
            ) {
                const dpi = Math.min(PREVIEW_DPI, sourceDpiCandidate);
                const renderDpi = pageSize === undefined
                    ? dpi
                    : resolvePagePreviewDpi(pageSize, dpi);
                previewRasterPlan = {
                    dpi,
                    pageDpiByNumber: new Map([[
                        request.pageNumber,
                        sourceDpiCandidate,
                    ]]),
                    renderDpiByPageNumber: new Map([[
                        request.pageNumber,
                        renderDpi,
                    ]]),
                };
            }
        }
        // Preview canvas planning is evidence-backed: known output pages
        // determine the provisional rectangle, while unresolved automatic
        // sheets are omitted rather than guessed whole or split. Final runs
        // retain the full-document conservative planner.
        //
        // The grid is the document's own resolution, not the resolution one
        // oversized sheet's raster budget lowered that sheet to. The canvas is
        // the page the run will produce, and planning its grid from a preview
        // budget presented a 146-DPI frame for a page the output carries at
        // 150 — every placement decision on it, margins included, quantized on
        // a grid the output never has.
        const documentCanvas = request.options.matchPageSize
            ? legacyGeometry && compatibilityPageSizes !== null
                ? resolveScanCleanupProvisionalDocumentCanvas(
                    compatibilityPageSizes,
                    previewRasterPlan.dpi,
                    request.options,
                    request.layoutByPage,
                    request.layoutDetectionComplete === true,
                )
                : boundedGeometry === null
                    ? null
                    : resolveScanCleanupDocumentCanvasFromAccumulator(
                        boundedGeometry.accumulator,
                        previewRasterPlan.dpi,
                        request.options,
                        request.layoutDetectionComplete === true,
                    )
            : null;
        let boundedRasterSource: IScanCleanupPageRasterSource | null = null;
        let boundedRasterPage: IDetectedPageRaster | undefined;
        let boundedRasterizedByMatching = false;
        if (!legacyGeometry) {
            boundedRasterSource = await retention.rasterPageSource(document, signal);
            boundedRasterPage = await boundedRasterSource.getPageRaster(request.pageNumber);
            if (
                request.options.preserveOriginalQuality === true
                && request.options.matchPageSize
                && documentCanvas !== null
                && pageSizeStore !== null
            ) {
                boundedRasterizedByMatching = await hasBoundedMatchedRasterResample({
                    canvas: documentCanvas,
                    layoutByPage: request.layoutByPage,
                    options: request.options,
                    pageSizeStore,
                    rasterSource: boundedRasterSource,
                });
            }
        }
        const pagePreviewRenderDpi = previewRasterPlan.renderDpiByPageNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        // Matched pages must share the preview's document grid. Rendering a
        // proven lower-resolution page at its own DPI makes native rebuild the
        // common physical canvas on a smaller pixel grid, so changing pages
        // visibly changes the frame and disagrees with the final document. The
        // raster still stays inside the pixel budget its own sheet has, which
        // is a bound on this raster and not on the document's rectangle.
        // Source DPI remains separate below and governs only the working grid;
        // analysis is materialized on the canonical grid after this raster.
        const basePreviewDpi = documentCanvas === null
            ? pagePreviewRenderDpi
            : Math.min(
                pagePreviewRenderDpi,
                Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(documentCanvas))),
            );
        const baseRaw = await materializeRawRaster(
            document,
            request.pageNumber,
            signal,
            retention,
            dependencies,
            totalPages,
            basePreviewDpi,
            pageSize,
        );
        // A base preview pushes its raster the moment it exists — a whole
        // sidecar run ahead of the cleaned outputs — and then leaves those
        // bytes out of its result, because the renderer already holds them.
        // A detail tile renders from geometry the base run established and
        // answers with only the tile outputs; the renderer already holds the
        // base raster for this page.
        const streamedRaw = request.detail === undefined;
        if (streamedRaw) {
            emitRawRaster({
                ownerId: request.ownerId,
                documentRevision: request.documentRevision,
                requestId: request.requestId,
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                rawImageData: baseRaw.bytes,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
            });
        }
        const rawImage = {};
        // Measured from the document's own geometry and the layouts the caller
        // has observed, at the resolution the preview renders with: every
        // matched page of this session is presented on one rectangle and one
        // pixel grid — the same rectangle the final run writes, from the same
        // inputs, at its own resolution — from the first page of a cold session
        // onwards.
        //
        // Geometry is what matching needs, and nothing else about cleaning a
        // page depends on it. A document no tool here can measure therefore
        // previews with matching dropped and says so, rather than answering a
        // page the user asked to clean with an error about page sizes.
        let inputPath = baseRaw.path;
        let renderDpi = basePreviewDpi;
        let requestedRenderDpi = basePreviewDpi;
        let sourceDpi = previewRasterPlan.pageDpiByNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        // A matched preserve-original run needs the document-wide raster facts
        // below. Reuse that result for this page instead of starting a second
        // single-page probe merely to choose its render grid.
        const rasterPages = request.options.preserveOriginalQuality === true
            && request.options.matchPageSize
            && compatibilityPageSizes?.length
            ? await retention.previewRasterPages(document, signal)
            : null;
        const sourceRasterPage = legacyGeometry
            ? rasterPages ?? await retention.rasterPage(document, request.pageNumber, signal)
            : null;
        const sourceRasterDetected = legacyGeometry
            ? sourceRasterPage!.pages.has(request.pageNumber)
            : boundedRasterPage !== undefined;
        sourceDpi = legacyGeometry
            ? sourceRasterPage!.sourceDpiByPage?.get(request.pageNumber) ?? sourceDpi
            : boundedRasterPage?.dpi ?? sourceDpi;
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        if (request.detail === undefined) {
            const outputMode = resolveScanCleanupEffectiveOutputMode({
                options: request.options,
                pageOverride,
                detectedOutputMode: request.outputModeRecommendation,
            });
            const requestedPreviewProcessingDpi = resolvePreviewProcessingDpi({
                displayDpi: basePreviewDpi,
                outputMode,
                sourceDpi,
            });
            const processingDocumentCanvas = documentCanvas !== null
                && requestedPreviewProcessingDpi > basePreviewDpi
                ? legacyGeometry && compatibilityPageSizes !== null
                    ? resolveScanCleanupProvisionalDocumentCanvas(
                        compatibilityPageSizes,
                        requestedPreviewProcessingDpi,
                        request.options,
                        request.layoutByPage,
                        request.layoutDetectionComplete === true,
                    )
                    : boundedGeometry === null
                        ? null
                        : resolveScanCleanupDocumentCanvasFromAccumulator(
                            boundedGeometry.accumulator,
                            requestedPreviewProcessingDpi,
                            request.options,
                            request.layoutDetectionComplete === true,
                        )
                : null;
            const previewProcessingDpi = processingDocumentCanvas === null
                ? requestedPreviewProcessingDpi
                : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(processingDocumentCanvas)));
            if (previewProcessingDpi !== basePreviewDpi) {
                ({path: inputPath} = await materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    retention,
                    dependencies,
                    baseRaw.totalPages,
                    previewProcessingDpi,
                    pageSize,
                ));
                renderDpi = previewProcessingDpi;
                requestedRenderDpi = previewProcessingDpi;
            }
        }
        let fallbackDetail = false;
        if (request.detail) {
            const {
                detail: _detail,
                ...baseRequest
            } = request;
            const analysisKey = baseAnalysisKey(baseRequest, documentCanvas);
            const analysis = baseAnalysisCache.get(analysisKey);
            if (analysis) {
                baseAnalysisCache.delete(analysisKey);
                baseAnalysisCache.set(analysisKey, analysis);
            }
            if (
                !analysis
                || analysis.sourceStatIdentity !== baseRaw.document.sourceStatIdentity
                || (
                    request.detail.outputMode !== 'mixed'
                    && analysis.outputMode !== request.detail.outputMode
                )
            ) {
                throw new Error(
                    'Scan cleanup detail geometry is unavailable; rebuild the base preview'
                    + ` (base mode ${analysis?.outputMode ?? 'unknown'}, detail ${JSON.stringify(request.detail)})`,
                );
            }
            if (analysis.baseRenderDpi !== baseRaw.dpi) {
                ({path: inputPath} = await materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    retention,
                    dependencies,
                    baseRaw.totalPages,
                    analysis.baseRenderDpi,
                    pageSize,
                ));
            }
            const detailRequest = request as IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>;};
            const hasManualZones = (pageOverride.manualZones?.picture.length ?? 0) > 0
                || (pageOverride.manualZones?.fill.length ?? 0) > 0;
            if (request.detail.outputMode !== 'mixed' && !hasManualZones) {
                return await runDetailPreview(
                    detailRequest,
                    signal,
                    baseRaw,
                    inputPath,
                    analysis,
                    sourceDpiCandidate,
                    sourceRasterDetected,
                    scratch,
                    dependencies,
                );
            }
            fallbackDetail = true;
            sourceDpi = sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
                ? sourceDpiCandidate
                : DEFAULT_SOURCE_DPI;
            ({
                renderDpi,
                requestedRenderDpi,
            } = resolveFallbackDetailDpi(
                detailRequest,
                baseRaw,
                sourceDpi,
                sourceRasterDetected,
                documentCanvas,
            ));
            if (renderDpi !== baseRaw.dpi) {
                ({path: inputPath} = await materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    retention,
                    dependencies,
                    baseRaw.totalPages,
                    renderDpi,
                    pageSize,
                ));
            }
        }
        if (isScanCleanupSignalAborted(signal)) throw signal.reason;
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const canonicalRaw = baseRaw.dpi === DETECTION_DPI
            ? baseRaw
            : await materializeRawRasterPath(
                document,
                request.pageNumber,
                signal,
                retention,
                dependencies,
                baseRaw.totalPages,
                DETECTION_DPI,
                pageSize,
            );
        const outputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(scratch, `clean-${index}.png`),
            metadataPath: join(scratch, `clean-${index}.json`),
        }));
        const manifestPath = join(scratch, 'manifest.json');
        const pageMetadataPath = join(scratch, 'page.json');
        const reusablePagePlan = resolveReusablePagePlan(
            request.options,
            request.layoutByPage,
            request.pagePlanEvidence === undefined
                ? undefined
                : {[String(request.pageNumber)]: request.pagePlanEvidence},
            request.pageNumber,
        );
        // Matching a document onto one rectangle also means one pixel grid, and
        // the lossless assembler cannot give a page that carries its own raster
        // the document's grid without resampling it. Where the two collide the
        // final run renders the whole document — so this preview renders it too,
        // rather than presenting the untouched page a lossless run would have
        // produced and calling it what the user will get.
        // The ordinary preview path needs only the requested page's raster
        // facts. A whole-document probe is reserved for the preserve-original
        // quality decision above, where matched-canvas resampling can change
        // the answer for every page.
        const rasterizedByMatching = legacyGeometry
            ? compatibilityPageSizes !== null
                && rasterPages !== null
                && resolveMatchedCanvasResamplePages(
                    compatibilityPageSizes,
                    compatibilityPageSizes.map(pageSize => pageSize.pageNumber),
                    request.options,
                    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                    rasterPages.pages,
                    rasterPages.detected,
                    request.layoutByPage,
                ).length > 0
            : boundedRasterizedByMatching;
        const lossless = request.options.preserveOriginalQuality === true && !rasterizedByMatching;
        // Every detail request that reaches this far fell back to a full
        // render, so this is the base render's canvas in both cases.
        const matchedCanvas = documentCanvas ?? undefined;
        const effectiveOptions = (matchedCanvas === undefined && request.options.matchPageSize)
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        const sourceBackgroundDpi = legacyGeometry
            ? sourceRasterPage!.backgroundDpiByPage?.get(request.pageNumber)
            : boundedRasterPage?.backgroundDpi;
        const sourceHasBilevelLayer = legacyGeometry
            ? sourceRasterPage!.bilevelLayerPages?.has(request.pageNumber) === true
            : boundedRasterPage?.hasBilevelLayer === true;
        let trustedMrcLayers: IPdfMrcLayers | null = null;
        if (
            shouldExtractTrustedMrcForeground(
                request.options.outputMode,
                pageOverride.outputModeOverride,
            )
            && request.options.thickness === 0
            && request.options.autoDewarp !== true
            && pageOverride.rotationDegrees === 0
            && (pageOverride.manualZones?.picture.length ?? 0) === 0
            && (pageOverride.manualZones?.fill.length ?? 0) === 0
            && sourceHasBilevelLayer
            && dependencies.extractMrcLayers !== undefined
        ) {
            const extractionStartedAt = performance.now();
            try {
                trustedMrcLayers = await dependencies.extractMrcLayers(
                    document.sourcePdfPath,
                    request.pageNumber,
                    join(scratch, 'source-mrc-selection.png'),
                    join(scratch, 'source-mrc-background.png'),
                    signal,
                    logScanCleanupMessage,
                );
                logger.debug(
                    `Scan cleanup preview source-layer extraction page ${String(request.pageNumber)} `
                    + `reused=${String(trustedMrcLayers !== null)} `
                    + `durationMs=${(performance.now() - extractionStartedAt).toFixed(0)}`,
                );
            } catch (error) {
                // Cancellation is not evidence that this page lacks reusable
                // layers. Falling through started an ordinary raster cleanup
                // for a request the renderer had already superseded, leaving a
                // gray raw frame visible under the selected Cleaned tab.
                signal.throwIfAborted();
                logger.warn(
                    `Scan cleanup preview could not reuse page ${String(request.pageNumber)}'s `
                    + `compact MRC foreground; using raster reconstruction (${getErrorMessage(error)})`,
                );
            }
        }
        const manifest = buildRunnableNativeScanCleanupManifest({
            operation: lossless ? 'analyze' : 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: lossless ? 'lossless' : 'raster',
            options: effectiveOptions,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            ...(matchedCanvas === undefined ? {} : {documentCanvas: matchedCanvas}),
            pages: [{
                inputPath: lossless ? canonicalRaw.path : inputPath,
                analysisInputPath: canonicalRaw.path,
                analysisDpi: DETECTION_DPI,
                ...(trustedMrcLayers === null
                    ? {}
                    : {
                        trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                        trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                    }),
                pageNumber: request.pageNumber,
                dpi: lossless ? DETECTION_DPI : renderDpi,
                sourceDpi,
                sourceHasBilevelLayer,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                requestedRenderDpi,
                ...(request.detail === undefined
                    ? (request.outputModeRecommendation === undefined
                        ? {}
                        : {resolvedOutputMode: request.outputModeRecommendation})
                    : {resolvedOutputMode: request.detail.outputMode}),
                ...(request.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {preferSoftAlphaForeground: request.softAlphaForegroundRecommendation}),
                ...(request.layoutByPage?.[String(request.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(request.pageNumber)]}),
                ...reusablePagePlan,
                ...(request.placementAnchors === undefined
                    ? {}
                    : {placementAnchors: request.placementAnchors}),
                pageMetadataPath,
                outputs,
                ...(request.documentPrior === undefined ? {} : {documentPrior: request.documentPrior}),
            }],
            // Preview reads canonical rasters retained beside this scratch, so
            // the app-owned temp root is the narrowest root that holds them all.
            allowedPathRoot: dependencies.getTempDir(),
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        await dependencies.runSidecar(
            binary,
            manifestPath,
            signal,
            logScanCleanupMessage,
            () => undefined,
            {allowedPathRoot: dependencies.getTempDir()},
        );
        const pageMetadata = decodeNativeScanCleanupPreviewPageMetadataJson(
            await readFile(pageMetadataPath, 'utf8'),
        );
        if (lossless) {
            const analyzedOutputs = pageMetadata.outputs ?? [];
            // The canvas is the shared rectangle sampled at the document's own
            // grid resolution, by the one rule the final page is sampled by.
            // Rescaling the plan's pixel counts instead landed a whole pixel
            // away from the page the run produces — a 297 px preview of a
            // 296 px page — and decided the margin-fitting boundary on a canvas
            // the output never had.
            const canvasGridDpi = matchedCanvas === undefined
                ? renderDpi
                : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(matchedCanvas)));
            const previewCanvasGrid = matchedCanvas === undefined
                ? null
                : resolveScanCleanupCanvasGridAtDpi(matchedCanvas, canvasGridDpi);
            const canvasWidthPx = previewCanvasGrid?.widthPx ?? null;
            const canvasHeightPx = previewCanvasGrid?.heightPx ?? null;
            const previewPageSize = pageSize;
            const marginsMm = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
            const requestedMargins = matchedCanvas === undefined
                ? {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                }
                : {
                    leftPx: Math.max(0, Math.round(marginsMm.leftMm / 25.4 * canvasGridDpi)),
                    topPx: Math.max(0, Math.round(marginsMm.topMm / 25.4 * canvasGridDpi)),
                    rightPx: Math.max(0, Math.round(marginsMm.rightMm / 25.4 * canvasGridDpi)),
                    bottomPx: Math.max(0, Math.round(marginsMm.bottomMm / 25.4 * canvasGridDpi)),
                };
            const marginsRequested = Object.values(requestedMargins).some(margin => margin > 0);
            const plannedOutputs = analyzedOutputs.map(output => {
                const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
                const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
                // The canvas is strict: it already contains every page's
                // content and margins, measured document-wide before this
                // page was rendered, so growing it here for one output would
                // be the per-page frame drift it exists to prevent.
                const resolvedCanvasWidth = canvasWidthPx ?? outputWidthPx;
                const resolvedCanvasHeight = canvasHeightPx ?? outputHeightPx;
                const marginsAvailable = request.options.crop;
                const appliedMargins = matchedCanvas === undefined
                    ? output.appliedMargins
                    : marginsAvailable ? requestedMargins : {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    };
                const [
                    marginLeft,
                    marginRight,
                ] = fitScanCleanupMarginAxisPx(appliedMargins.leftPx, appliedMargins.rightPx, resolvedCanvasWidth);
                const [
                    marginTop,
                    marginBottom,
                ] = fitScanCleanupMarginAxisPx(appliedMargins.topPx, appliedMargins.bottomPx, resolvedCanvasHeight);
                const deliveredMargins = {
                    leftPx: marginLeft,
                    topPx: marginTop,
                    rightPx: marginRight,
                    bottomPx: marginBottom,
                };
                const innerCanvasWidth = Math.max(1, resolvedCanvasWidth - marginLeft - marginRight);
                const innerCanvasHeight = Math.max(1, resolvedCanvasHeight - marginTop - marginBottom);
                // The assembler scales this output's own objects from the
                // paper it was cut from onto the canvas, so the preview
                // presents it at the same scale. Measuring from the paper and
                // not from the cropped content is what makes a spread half and
                // a page scanned on its own land the same size.
                const outputPaper = resolveScanCleanupOutputPaperPixels({
                    half: output.half,
                    inputWidthPx: output.inputWidthPx,
                    inputHeightPx: output.inputHeightPx,
                    rotationDegrees: pageMetadata.rotationDegrees,
                });
                // The paper this output carries is the sheet the document
                // declares, divided across the outputs it is cut into. Deriving
                // it from analysis pixels instead compared a 150-DPI raster
                // against a canvas measured on another grid and called a half
                // sheet larger than the half-sheet canvas it exactly is.
                const paperPoints = previewPageSize === undefined
                    ? null
                    : resolveScanCleanupOutputPageRect(
                        previewPageSize,
                        output.half === 'full' ? 1 : 2,
                    );
                const paperScale = canvasWidthPx === null || canvasHeightPx === null
                    ? 1
                    : resolveScanCleanupCanvasFitScale({
                        widthPoints: canvasWidthPx,
                        heightPoints: canvasHeightPx,
                    }, {
                        widthPoints: Math.max(1, outputPaper.widthPx),
                        heightPoints: Math.max(1, outputPaper.heightPx),
                    });
                const paperLargerThanCanvas = matchedCanvas !== undefined
                    && previewCanvasGrid !== null
                    && paperPoints !== null
                    && isScanCleanupPaperLargerThanCanvas({
                        ...matchedCanvas,
                        ...previewCanvasGrid,
                    }, paperPoints);
                const contentScale = paperScale * Math.min(1, resolveScanCleanupCanvasFitScale({
                    widthPoints: innerCanvasWidth,
                    heightPoints: innerCanvasHeight,
                }, {
                    widthPoints: Math.max(1, outputWidthPx * paperScale),
                    heightPoints: Math.max(1, outputHeightPx * paperScale),
                }));
                return {
                    appliedMargins,
                    contentScale,
                    deliveredMargins,
                    innerCanvasHeight,
                    innerCanvasWidth,
                    marginLeft,
                    marginTop,
                    marginsAvailable,
                    output,
                    outputHeightPx,
                    outputWidthPx,
                    paperLargerThanCanvas,
                    paperScale,
                    resolvedCanvasHeight,
                    resolvedCanvasWidth,
                };
            });
            const spreadContentScale = plannedOutputs.length === 2
                && plannedOutputs.some(({output}) => output.half === 'left')
                && plannedOutputs.some(({output}) => output.half === 'right')
                ? Math.min(...plannedOutputs.map(({contentScale}) => contentScale))
                : null;
            return {
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                ...rawImage,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
                pageMetadata: {
                    ...pageMetadata,
                    outputDiagnostics: analyzedOutputs.map(output => ({
                        half: output.half,
                        ...(output.contentDiagnostics === undefined
                            ? {}
                            : {contentDiagnostics: output.contentDiagnostics}),
                        ...(output.textToneDiagnostics === undefined
                            ? {}
                            : {textToneDiagnostics: output.textToneDiagnostics}),
                    })),
                },
                outputs: plannedOutputs.map(({
                    appliedMargins,
                    contentScale: leafContentScale,
                    deliveredMargins,
                    innerCanvasHeight,
                    innerCanvasWidth,
                    marginLeft,
                    marginTop,
                    marginsAvailable,
                    output,
                    outputHeightPx,
                    outputWidthPx,
                    paperLargerThanCanvas,
                    paperScale,
                    resolvedCanvasHeight,
                    resolvedCanvasWidth,
                }) => {
                    // Matched margins are final-canvas insets, so content is
                    // fitted into the remaining inner rectangle. Intrinsic
                    // previews already carry their outward crop margins in the
                    // raster and therefore use the whole output rectangle here.
                    const contentScale = spreadContentScale ?? leafContentScale;
                    const contentWidthPx = Math.min(
                        innerCanvasWidth,
                        Math.max(1, Math.round(outputWidthPx * contentScale)),
                    );
                    const contentHeightPx = Math.min(
                        innerCanvasHeight,
                        Math.max(1, Math.round(outputHeightPx * contentScale)),
                    );
                    const canvasOverflow = contentScale < paperScale * (1 - CANVAS_CONTENT_SCALE_EPSILON);
                    const placementAnchor = request.placementAnchors?.[output.half];
                    const placement = resolveScanCleanupPlacementOffset(
                        innerCanvasWidth - contentWidthPx,
                        innerCanvasHeight - contentHeightPx,
                        pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment,
                        placementAnchor === undefined
                            ? undefined
                            : {
                                anchor: placementAnchor,
                                contentHeight: contentHeightPx,
                            },
                    );
                    return {
                        imageData: baseRaw.bytes,
                        metadata: {
                            half: output.half,
                            layoutClassification: pageMetadata.layoutClassification,
                            layoutConfidence: pageMetadata.layoutConfidence ?? 0,
                            sourceRegion: output.sourceRegion,
                            contentBox: output.contentBox,
                            cropRect: output.cropRect,
                            ...(output.contentDiagnostics === undefined
                                ? {}
                                : {contentDiagnostics: output.contentDiagnostics}),
                            appliedMargins: deliveredMargins,
                            outputWidthPx,
                            outputHeightPx,
                            canvasWidthPx: resolvedCanvasWidth,
                            canvasHeightPx: resolvedCanvasHeight,
                            // Native placement is fractional in the shared
                            // geometry contract; preview metadata is a pixel
                            // artifact, so quantize only at this boundary.
                            placementOffsetXPx: marginLeft + Math.floor(placement.x),
                            placementOffsetYPx: marginTop + Math.floor(placement.y),
                            forwardTransform: null,
                            cutterXPx: pageMetadata.cutterXPx,
                            inputWidthPx: output.inputWidthPx,
                            inputHeightPx: output.inputHeightPx,
                            rotationDegrees: pageMetadata.rotationDegrees,
                            canvasScope: 'page',
                            resamplePasses: 0,
                            sourceDpi,
                            renderDpi,
                            requestedRenderDpi,
                            rasterScaleLimited: false,
                            canvasPolicy: matchedCanvas === undefined ? 'intrinsic' : 'strict-maximum',
                            canvasOverflow,
                            matchedCanvasTargetWidthPx: canvasWidthPx,
                            matchedCanvasTargetHeightPx: canvasHeightPx,
                            matchedCanvasTargetWidthPoints: matchedCanvas?.widthPoints ?? null,
                            matchedCanvasTargetHeightPoints: matchedCanvas?.heightPoints ?? null,
                            // A lossless run hands the original page objects to
                            // the assembler, which scales them onto the canvas
                            // without resampling them: the content changes size
                            // with the sheet, and the renderer presents it at
                            // exactly the size the output page will carry.
                            matchedCanvasContentWidthPx: contentWidthPx,
                            matchedCanvasContentHeightPx: contentHeightPx,
                            // The renderer presents sentences, not conditions.
                            // Preview names the same conditions the final run
                            // does, through the same formatter, so the two can
                            // never describe one placement differently.
                            warnings: [
                                ...previewWarningEvents,
                                ...(matchedCanvas !== undefined && marginsRequested && !marginsAvailable
                                    ? [{code: 'matched-canvas-margins-unavailable'} as const]
                                    : []),
                                ...(deliveredMargins.leftPx !== appliedMargins.leftPx
                                    || deliveredMargins.topPx !== appliedMargins.topPx
                                    || deliveredMargins.rightPx !== appliedMargins.rightPx
                                    || deliveredMargins.bottomPx !== appliedMargins.bottomPx
                                    ? [{code: 'matched-canvas-margins-reduced'} as const]
                                    : []),
                                // Paper the shared canvas cannot hold at the
                                // document's scale is a condition the final
                                // run reports for the same page, so the
                                // preview that stands in for it reports it
                                // too. Reporting only the fitted-content
                                // condition let a page arrive at 77% of the
                                // document's scale with nothing said about
                                // why.
                                ...(paperLargerThanCanvas
                                    ? [{
                                        code: 'matched-canvas-paper-downscaled',
                                        unit: 'px',
                                        scalePercentTenths: toScanCleanupPercentTenths(paperScale * 100),
                                        documentCanvasWidth: resolvedCanvasWidth,
                                        documentCanvasHeight: resolvedCanvasHeight,
                                    } as const]
                                    : []),
                                ...(canvasOverflow
                                    ? [{
                                        code: 'matched-canvas-content-fitted',
                                        unit: 'px',
                                        contentWidth: contentWidthPx,
                                        contentHeight: contentHeightPx,
                                        innerWidth: innerCanvasWidth,
                                        innerHeight: innerCanvasHeight,
                                        // The rectangle the margin box was cut
                                        // out of, which is what makes this
                                        // sentence name the same canvas the
                                        // raster path names for the same
                                        // placement instead of stopping at the
                                        // margin box.
                                        documentCanvasWidth: resolvedCanvasWidth,
                                        documentCanvasHeight: resolvedCanvasHeight,
                                    } as const]
                                    : []),
                            ].map(event => formatScanCleanupWarningEvent(event)),
                        },
                    };
                }),
            };
        }
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        const nativeOutputs: IBasePreviewAnalysis['outputs'] = {};
        const canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>> = {};
        let canonicalRasterBytes = 0;
        for (const output of outputs) {
            try {
                const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(
                    await readFile(output.metadataPath, 'utf8'),
                );
                nativeOutputs[nativeMetadata.half] = nativeMetadata;
                const imageData = await readPreviewBytes(output.outputPath);
                canonicalRasters[nativeMetadata.half] = imageData;
                canonicalRasterBytes += imageData.byteLength;
                cleaned.push({
                    imageData,
                    metadata: {
                        ...nativeMetadata,
                        ...(nativeMetadata.dewarpModel === undefined
                            ? {}
                            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
                        // What Electron decided before the render — matching
                        // dropped for want of geometry — belongs beside what
                        // the engine reported about the page itself. Both are
                        // conditions, so both travel as typed events and are
                        // read as one list; only the engine's unstructured
                        // diagnostics stay string-only.
                        warnings: [
                            ...[
                                ...previewWarningEvents,
                                ...nativeMetadata.warningEvents ?? [],
                            ].map(event => formatScanCleanupWarningEvent(event)),
                            ...describeScanCleanupNativeWarnings({warnings: nativeMetadata.warnings}),
                        ],
                    },
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        const diagnosticMetadata = cleaned[0]?.metadata;
        const result: TScanCleanupPreviewWireResult = {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            ...rawImage,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: {
                ...pageMetadata,
                ...(diagnosticMetadata?.detectedSkewDegrees === undefined
                    ? {}
                    : {detectedSkewDegrees: diagnosticMetadata.detectedSkewDegrees}),
                ...(diagnosticMetadata?.skewConfidence === undefined
                    ? {}
                    : {skewConfidence: diagnosticMetadata.skewConfidence}),
                ...(diagnosticMetadata?.manualSkew === undefined
                    ? {}
                    : {manualSkew: diagnosticMetadata.manualSkew}),
                ...(diagnosticMetadata?.binarizationMode === undefined
                    ? {}
                    : {binarizationMode: diagnosticMetadata.binarizationMode}),
                ...(diagnosticMetadata?.binarizationDiagnostics === undefined
                    ? {}
                    : {binarizationDiagnostics: diagnosticMetadata.binarizationDiagnostics}),
                ...(diagnosticMetadata?.textToneDiagnostics === undefined
                    ? {}
                    : {textToneDiagnostics: diagnosticMetadata.textToneDiagnostics}),
                ...(diagnosticMetadata?.despeckleFallback === undefined
                    ? {}
                    : {despeckleFallback: diagnosticMetadata.despeckleFallback}),
                ...(diagnosticMetadata?.dewarpConfidence === undefined
                    ? {}
                    : {dewarpConfidence: diagnosticMetadata.dewarpConfidence}),
                ...(diagnosticMetadata?.dewarpApplied === undefined
                    ? {}
                    : {dewarpApplied: diagnosticMetadata.dewarpApplied}),
                outputDiagnostics: cleaned.map(output => ({
                    half: output.metadata.half,
                    ...(output.metadata.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: output.metadata.contentDiagnostics}),
                    ...(output.metadata.textToneDiagnostics === undefined
                        ? {}
                        : {textToneDiagnostics: output.metadata.textToneDiagnostics}),
                })),
                autoDewarpAttempted: request.options.autoDewarp === true,
            },
            outputs: cleaned,
        };
        if (!fallbackDetail) {
            signal.throwIfAborted();
            const analysisKey = baseAnalysisKey(request, documentCanvas);
            const artifacts = await persistBaseAnalysisArtifacts(
                nativeOutputs,
                canonicalRasters,
                signal,
                dependencies,
            );
            const previous = baseAnalysisCache.get(analysisKey);
            if (previous) {
                baseAnalysisCache.delete(analysisKey);
                void removeBaseAnalysisArtifacts(previous);
            }
            baseAnalysisCache.set(analysisKey, {
                sourcePdfPath: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                sourceStatIdentity: baseRaw.document.sourceStatIdentity,
                ...(result.outputs[0]?.metadata.outputMode === undefined
                    ? {}
                    : {outputMode: result.outputs[0].metadata.outputMode}),
                pageMetadata: result.pageMetadata,
                outputs: nativeOutputs,
                ...artifacts,
                canonicalRasterBytes,
                baseRenderDpi: renderDpi,
            });
            await pruneBaseAnalysisCache(baseAnalysisCache);
        }
        return result;
    } finally {
        await retention.release(document);
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}


export interface IScanCleanupPreviewService {
    preview: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewRequest) => Promise<TScanCleanupPreviewWireResult>;
    cancel: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewCancelRequest) => boolean;
    dispose: () => Promise<void>;
    detectAll: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupDetectionRequest) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getDetectionJobState: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
}

export function createScanCleanupPreviewService(
    dependencies: IScanCleanupPreviewDependencies = defaultDependencies,
): IScanCleanupPreviewService {
    const active = new Map<string, IPreviewEntry>();
    const previewOwnerBindings = new Map<number, IPreviewOwnerBinding>();
    const rawRasterRetention = createRawRasterRetention(dependencies);
    const baseAnalysisCache = new Map<string, IBasePreviewAnalysis>();
    // Streamed detection events carry new *and revised* page classifications.
    // Native first publishes an independent verdict, then may replace it after
    // document reconciliation. A count cursor loses that replacement because
    // it sits below the append position; page signatures retain the bandwidth
    // bound without making revisions invisible to the renderer.
    const deliveredDetectionResults = new Map<string, Map<number, number | string>>();
    // A successful core run transfers its file-backed result store to this
    // service. Keep it alive until the registry settles so terminal progress
    // can read its scalar count, then close and remove it at the lifecycle
    // boundary. The store never crosses the IPC boundary.
    const ownedDetectionResultStores = new Map<string, IScanCleanupDetectionResultStore>();
    const registeredDetectionResultStoreIds = new Set<string>();
    const detectionResultVersion = (result: IScanCleanupDetectionResult) => result.revision ?? JSON.stringify([
        result.classification,
        result.confidence,
        result.cutterXPx,
        result.tier1Verdict,
        result.reconciled,
        result.clusterAgreement,
        result.documentPrior,
        result.textAxis,
        result.recommendedOutputMode,
        result.recommendedOutputModeConfidence,
        result.recommendedOutputModeReason,
        result.softAlphaForegroundRecommendation,
        result.pagePlanEvidence,
    ]);
    const rendererDetectionState = (state: TScanCleanupDetectionJobState | null) => (
        state === null ? null : projectScanCleanupDetectionStateForRenderer(state)
    );
    const detectionDeliveryKey = (senderId: number, jobId: string) => `${senderId}\u0000${jobId}`;
    const detectionJobs = createMainJobRegistry<
        TScanCleanupDetectionJobState,
        IDetectionResult,
        TDetectionError,
        IScanCleanupDetectionSubscriber
    >({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        progress: {
            channel: SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState,
            getEventKey: state => state.jobId,
            send: (subscriber, channel, state) => {
                const deliveryKey = detectionDeliveryKey(subscriber.id, state.jobId);
                if (state.status === 'queued' || state.status === 'running' || state.status === 'canceling') {
                    if (state.progress.totalUnits > SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES) {
                        // Large runs already publish a bounded batch from core.
                        // The renderer needs only the newest classifications it
                        // can display. Full page plans remain in the file-backed
                        // result store for persistence and final cleanup.
                        deliveredDetectionResults.delete(deliveryKey);
                        subscriber.send(channel, rendererDetectionState(state));
                        return;
                    }
                    const delivered = deliveredDetectionResults.get(deliveryKey)
                        ?? new Map<number, number | string>();
                    const changed = state.results.filter(result => {
                        const signature = detectionResultVersion(result);
                        if (delivered.get(result.pageNumber) === signature) {
                            return false;
                        }
                        delivered.set(result.pageNumber, signature);
                        return true;
                    });
                    deliveredDetectionResults.set(deliveryKey, delivered);
                    subscriber.send(channel, {
                        ...state,
                        results: changed,
                    });
                    return;
                }
                deliveredDetectionResults.delete(deliveryKey);
                // Terminal states can be reconstructed from the file-backed
                // result store after a restart. Project them through the same
                // bounded window as live xlarge progress before they cross
                // into the renderer.
                subscriber.send(channel, rendererDetectionState(state));
            },
        },
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause),
            ...scanCleanupScratchShortfall(cause),
        }),
        terminalProgress: {
            completed: (latest, result) => {
                const resultCount = result.resultStore.resultCount;
                const pageCount = result.resultStore.pageCount;
                const results = resultCount <= SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES
                    ? result.results
                    : [];
                return {
                    jobId: latest.jobId,
                    status: 'completed',
                    documentCanvasSignature: latest.documentCanvasSignature ?? '',
                    progress: {
                        stage: 'detecting',
                        completedUnits: resultCount,
                        totalUnits: pageCount,
                        percent: pageCount === 0 ? 100 : resultCount / pageCount * 100,
                        ...completedPageProgress(new Set(results.map(item => item.pageNumber)), resultCount),
                    },
                    resultCount,
                    ...(result.resultStoreId === undefined
                        ? {}
                        : {detectionResultStoreId: result.resultStoreId}),
                    ...(result.placementAnchorSummary === undefined
                        ? {}
                        : {placementAnchorSummary: result.placementAnchorSummary}),
                    results,
                    updatedAtMs: createEpochMs(),
                };
            },
            canceled: latest => ({
                ...latest,
                status: 'canceled',
                updatedAtMs: createEpochMs(),
            }),
            failed: (latest, error) => ({
                ...latest,
                status: 'failed',
                error: error.message,
                errorCode: error.code,
                // The renderer states this refusal in the user's language, so
                // the figures behind it travel typed rather than in the
                // English message.
                ...(error.scratchShortfall === undefined
                    ? {}
                    : {scratchShortfall: error.scratchShortfall}),
                updatedAtMs: createEpochMs(),
            }),
        },
    });
    const activeDetectionJobsByBrokerOwner = new Map<string, {
        jobId: TJobId;
        request: IScanCleanupDetectionRequest;
        signature: string;
    }>();
    const detectionActor = (sender: IScanCleanupDetectionSubscriber, owner: IScanCleanupOwnerContext) => ({
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    });
    const publicDetectionState = (snapshot: TDetectionSnapshot | null) => snapshot?.progress ?? null;
    const subscribeDetection = (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => {
        // The registry pumps every state change to the job owner, so subscribing
        // only has to authorize the sender and restart its result cursor: the
        // caller is handed the whole state and must be able to rebuild from it.
        if (!detectionJobs.get(jobId, detectionActor(sender, owner))) {
            return false;
        }
        deliveredDetectionResults.delete(detectionDeliveryKey(sender.id, jobId));
        return true;
    };
    const disposeBaseAnalysisCache = async () => {
        const analyses = [...baseAnalysisCache.values()];
        baseAnalysisCache.clear();
        await Promise.all(analyses.map(analysis => removeBaseAnalysisArtifacts(analysis)));
    };
    const previewOwnerPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => `${sender.id}\u0000${owner.ownerId}\u0000`;
    const brokerOwnerId = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => createStableJobBrokerOwnerId('scan-cleanup', sender.id, owner.ownerId);
    const previewDocumentPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => `${previewOwnerPrefix(sender, request)}${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`;
    // The page the user navigated onto, named by the request that streams its
    // raw raster back, so the adjacent prefetches that do not are admitted
    // behind it. One entry per document an owner is working on, dropped when
    // that owner moves on or cancels the document.
    const visiblePages = new Map<string, number>();
    const abortStalePreviewRequests = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => {
        const ownerPrefix = previewOwnerPrefix(sender, request);
        const documentPrefix = previewDocumentPrefix(sender, request);
        for (const [
            key,
            entry,
        ] of active) {
            if (key.startsWith(ownerPrefix) && !key.startsWith(documentPrefix)) {
                entry.controller.abort(new DOMException('Stale scan cleanup preview document', 'AbortError'));
            }
        }
        // The owner moved to another document or revision, so the page it was
        // looking at in the old one is not a visible page any more. Without
        // this the map keeps one entry per document a session ever opened.
        for (const key of visiblePages.keys()) {
            if (key.startsWith(ownerPrefix) && key !== documentPrefix) visiblePages.delete(key);
        }
        return documentPrefix;
    };
    const previewLanePrefix = (
        documentPrefix: string,
        request: IScanCleanupPreviewRequest,
    ) => `${documentPrefix}${request.detail === undefined ? 'base' : 'detail'}\u0000`;
    const withPreviewLease = async <T>(
        documentPrefix: string,
        admission: IPreviewAdmission,
        signal: AbortSignal,
        run: () => Promise<T>,
    ) => {
        signal.throwIfAborted();
        const acquire = dependencies.acquirePreviewLease ?? defaultDependencies.acquirePreviewLease!;
        let lease: {release: () => boolean};
        for (;;) {
            const attempt = new AbortController();
            const abortAttempt = () => attempt.abort(signal.reason);
            signal.addEventListener('abort', abortAttempt, {once: true});
            admission.reissue = () => attempt.abort(PREVIEW_ADMISSION_REISSUED);
            try {
                lease = await acquire(documentPrefix, admission.visibility, attempt.signal);
                admission.granted = true;
                break;
            } catch (error) {
                signal.throwIfAborted();
                // Anything but a readmission is the request's own failure.
                if (attempt.signal.reason !== PREVIEW_ADMISSION_REISSUED) throw error;
            } finally {
                signal.removeEventListener('abort', abortAttempt);
                admission.reissue = null;
            }
        }
        try {
            return await run();
        } finally {
            lease.release();
        }
    };
    // Request identity is the page and the content that would be rendered, not
    // just the document and the lane. Two requests that would produce the same
    // result now share one run instead of the second aborting the first.
    const previewRequestKey = (documentPrefix: string, request: IScanCleanupPreviewRequest) => {
        const {
            detail,
            ...base
        } = request;
        return `${previewLanePrefix(documentPrefix, request)}${previewIdentityKey(base)}\u0000${
            detail === undefined ? '' : JSON.stringify(detail)
        }`;
    };
    const removePreviewOwnerBinding = (senderId: number) => {
        const binding = previewOwnerBindings.get(senderId);
        if (!binding) {
            return;
        }
        binding.sender.removeListener('destroyed', binding.handleDestroyed);
        binding.sender.removeListener('render-process-gone', binding.handleRenderProcessGone);
        previewOwnerBindings.delete(senderId);
    };
    const unregisterPreviewOwnerIfIdle = (senderId: number) => {
        for (const entry of active.values()) {
            if (entry.senderId === senderId) {
                return;
            }
        }
        removePreviewOwnerBinding(senderId);
    };
    const cancelPreviewRequest = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewCancelRequest,
        reason: string,
    ) => {
        const documentPrefix = previewDocumentPrefix(sender, request);
        // A navigation names the pages it is moving into; only work for
        // pages outside that window is discarded. Without a window the
        // caller means the whole document: a settings change, a new
        // revision, a session shutting down, or a renderer that is gone.
        const retained = new Set(request.retainPages ?? []);
        let canceled = false;
        for (const [
            key,
            entry,
        ] of active) {
            if (key.startsWith(documentPrefix) && !retained.has(entry.pageNumber)) {
                entry.controller.abort(new DOMException(reason, 'AbortError'));
                canceled = true;
            }
        }
        // A windowed cancellation is always issued for a navigation that
        // still wants the visible page, so only a whole-document
        // cancellation forgets which page that is.
        if (request.retainPages === undefined) visiblePages.delete(documentPrefix);
        if (request.invalidateRawCache !== false) {
            rawRasterRetention.invalidate(request.sourcePdfPath, request.documentRevision);
            for (const [
                key,
                analysis,
            ] of baseAnalysisCache) {
                if (
                    analysis.sourcePdfPath === request.sourcePdfPath
                    && analysis.documentRevision === request.documentRevision
                ) {
                    baseAnalysisCache.delete(key);
                    void removeBaseAnalysisArtifacts(analysis);
                }
            }
        }
        unregisterPreviewOwnerIfIdle(sender.id);
        return canceled;
    };
    const cancelPreviewOwner = (sender: IScanCleanupDetectionSubscriber, reason: string) => {
        const requests = new Map<string, IScanCleanupPreviewCancelRequest>();
        for (const entry of active.values()) {
            if (entry.senderId !== sender.id) continue;
            const request = {
                ownerId: entry.request.ownerId,
                documentRevision: entry.request.documentRevision,
                sourcePdfPath: entry.request.sourcePdfPath,
            } satisfies IScanCleanupPreviewCancelRequest;
            requests.set(previewDocumentPrefix(sender, request), request);
        }
        for (const request of requests.values()) cancelPreviewRequest(sender, request, reason);
        removePreviewOwnerBinding(sender.id);
    };
    const registerPreviewOwner = (sender: IScanCleanupDetectionSubscriber) => {
        if (previewOwnerBindings.has(sender.id)) {
            return;
        }
        if (sender.isDestroyed()) {
            cancelPreviewOwner(sender, 'Renderer destroyed');
            return;
        }
        const handleDestroyed = () => cancelPreviewOwner(sender, 'Renderer destroyed');
        const handleRenderProcessGone = () => cancelPreviewOwner(sender, 'Renderer process gone');
        previewOwnerBindings.set(sender.id, {
            handleDestroyed,
            handleRenderProcessGone,
            sender,
        });
        sender.once('destroyed', handleDestroyed);
        sender.once('render-process-gone', handleRenderProcessGone);
        if (sender.isDestroyed()) handleDestroyed();
    };
    return {
        async dispose() {
            for (const entry of active.values()) {
                entry.controller.abort(new DOMException('Scan cleanup preview service disposed', 'AbortError'));
            }
            await Promise.allSettled([...active.values()].map(entry => entry.tail));
            active.clear();
            for (const senderId of previewOwnerBindings.keys()) removePreviewOwnerBinding(senderId);
            await detectionJobs.clearForTests();
            const detectionStores = [...ownedDetectionResultStores.values()];
            ownedDetectionResultStores.clear();
            await Promise.allSettled(detectionStores.map(store => store.close()));
            const registeredStoreIds = [...registeredDetectionResultStoreIds];
            registeredDetectionResultStoreIds.clear();
            await releaseScanCleanupDetectionResultStores(registeredStoreIds);
            visiblePages.clear();
            deliveredDetectionResults.clear();
            await disposeBaseAnalysisCache();
            await rawRasterRetention.dispose();
        },
        preview(sender, request) {
            if (sender.isDestroyed()) {
                cancelPreviewOwner(sender, 'Renderer destroyed');
                return Promise.resolve({canceled: true} as const);
            }
            const documentPrefix = abortStalePreviewRequests(sender, request);
            // The renderer names the page the user is looking at on the request
            // that will display it; everything else is an adjacent prefetch.
            if (request.visible === true) visiblePages.set(documentPrefix, request.pageNumber);
            const activeKey = previewRequestKey(documentPrefix, request);
            // Navigating onto a page whose prefetch is still running adopts that
            // run: no second raster, no second sidecar, and the caller inherits
            // the progress already made rather than restarting it. A run that
            // has already been aborted has nothing to inherit and is left to
            // retire; this request starts its own.
            const adopted = active.get(activeKey);
            if (adopted && !adopted.controller.signal.aborted) {
                // The adopted run was admitted as background work. It is now the
                // page the user is waiting on, so it is readmitted as one rather
                // than holding its place in a queue behind detection.
                if (request.visible === true && adopted.admission.visibility === 'prefetch') {
                    adopted.admission.visibility = 'visible';
                    adopted.admission.reissue?.();
                }
                return adopted.tail;
            }
            // A base request only supersedes work for its own page: a stale
            // options generation for the page being rendered. Adjacent prefetches
            // for other pages are the renderer's to retire, through `cancel`.
            // A detail tile is the one visible viewport, so it supersedes the
            // whole detail lane and still never touches the base lane.
            const lanePrefix = previewLanePrefix(documentPrefix, request);
            const superseded: IPreviewEntry[] = [];
            for (const [
                key,
                entry,
            ] of active) {
                if (
                    key.startsWith(lanePrefix)
                    && (request.detail !== undefined || entry.pageNumber === request.pageNumber)
                ) {
                    superseded.push(entry);
                    entry.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
                }
            }
            const controller = new AbortController();
            // The generation counts replacements of *this* key. Taking it from
            // whichever superseded entry the lane happened to iterate first
            // could hand a live entry the generation an older one is still
            // carrying, and that entry's late tail would then delete the
            // replacement out of the index.
            const generation = (active.get(activeKey)?.generation ?? 0) + 1;
            const priorTail = Promise.all(superseded.map(entry => entry.tail.catch(() => undefined)));
            // A detail tile is the viewport the user is looking at. The renderer
            // names normal visible pages explicitly; page one is the safe
            // startup fallback for older callers that have not done so yet.
            // Every other unnamed page is an adjacent prefetch.
            const visiblePage = visiblePages.get(documentPrefix);
            const admission: IPreviewAdmission = {
                granted: false,
                reissue: null,
                visibility: request.detail !== undefined
                    ? 'detail'
                    : request.visible === true
                    || (visiblePage === undefined && request.pageNumber === 1)
                    || visiblePage === request.pageNumber
                        ? 'visible'
                        : 'prefetch',
            };
            const tail: Promise<TScanCleanupPreviewWireResult> = priorTail.then(async () => {
                const materialized = await materializeScanCleanupPreviewRequest(
                    request,
                    sender.id,
                    controller.signal,
                    dependencies,
                );
                return withPreviewLease(brokerOwnerId(sender, request), admission, controller.signal, async () => {
                    const result = await runPreview(
                        materialized,
                        controller.signal,
                        rawRasterRetention,
                        baseAnalysisCache,
                        dependencies,
                        raw => sender.send(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw, raw),
                    );
                    return result.canceled === true
                        ? result
                        : {
                            ...result,
                            requestId: materialized.requestId,
                        };
                });
            }).catch(error => {
                // A tab/pane can retire its working-copy registration after the
                // materialization abort check but before the queued request
                // reaches the registry. In that race the registry correctly
                // reports an ownership error, but the request has already been
                // canceled and must settle like every other superseded preview
                // instead of surfacing as an IPC handler failure.
                if (controller.signal.aborted || isPreviewCancellation(error)) {
                    return {canceled: true} as const;
                }
                throw new Error(encodeSerializableErrorEnvelope({
                    code: classifyScanCleanupError(error, false),
                    message: getErrorMessage(error) || 'Scan cleanup preview failed',
                }));
            });
            active.set(activeKey, {
                admission,
                controller,
                generation,
                pageNumber: request.pageNumber,
                request,
                senderId: sender.id,
                tail,
            });
            registerPreviewOwner(sender);
            if (admission.visibility === 'prefetch') {
                const drop = setTimeout(() => {
                    if (admission.granted || admission.visibility !== 'prefetch') {
                        return;
                    }
                    controller.abort(new DOMException('Dropped scan cleanup preview prefetch', 'AbortError'));
                }, dependencies.prefetchLeaseTimeoutMs ?? PREVIEW_PREFETCH_LEASE_TIMEOUT_MS);
                void tail.catch(() => undefined).finally(() => clearTimeout(drop));
            }
            void tail.finally(() => {
                if (active.get(activeKey)?.generation === generation) active.delete(activeKey);
                unregisterPreviewOwnerIfIdle(sender.id);
            }).catch(() => undefined);
            return tail;
        },
        cancel(sender, request) {
            return cancelPreviewRequest(sender, request, 'Canceled scan cleanup preview');
        },
        detectAll(sender, request) {
            const jobId = createJobId('scan-cleanup-detect');
            if (!isAbsolute(request.sourcePdfPath)) {
                return Promise.resolve({
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                });
            }
            const ownerId = brokerOwnerId(sender, request);
            const signature = JSON.stringify(request);
            const previous = activeDetectionJobsByBrokerOwner.get(ownerId);
            if (previous) {
                const previousState = publicDetectionState(detectionJobs.get(
                    previous.jobId,
                    detectionActor(sender, previous.request),
                ));
                if (previousState && (
                    previousState.status === 'queued'
                    || previousState.status === 'running'
                    || previousState.status === 'canceling'
                )) {
                    if (
                        previous.signature === signature
                        && previousState.status !== 'canceling'
                    ) {
                        subscribeDetection(sender, previous.jobId, request);
                        return Promise.resolve({
                            started: true,
                            jobId: previous.jobId,
                        });
                    }
                    if (previous.signature !== signature) {
                        detectionJobs.cancel(
                            previous.jobId,
                            detectionActor(sender, previous.request),
                            'Superseded scan cleanup detection request',
                        );
                    }
                }
            }
            const handle = detectionJobs.start({
                jobId,
                owner: detectionActor(sender, request),
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                },
                initialProgress: {
                    jobId,
                    status: 'queued',
                    documentCanvasSignature: '',
                    progress: {
                        stage: 'queued',
                        completedUnits: 0,
                        totalUnits: 0,
                        percent: 0,
                        completedPageNumbers: [],
                    },
                    resultCount: 0,
                    results: [],
                    updatedAtMs: createEpochMs(),
                },
                ownerLifecycle: {
                    destroyed: 'cancel',
                    renderProcessGone: 'cancel',
                    mainFrameNavigation: 'cancel',
                },
                run: async job => {
                    let lease: {release: () => boolean} | null = null;
                    try {
                        const acquire = dependencies.acquireDetectionLease ?? defaultDependencies.acquireDetectionLease!;
                        const {capacity} = mainJobBroker.getSnapshot();
                        const rasterPolicy = resolveScanCleanupRasterAdmissionPolicy(
                            capacity,
                            process.platform !== 'win32'
                                && dependencies.createRasterPipes !== undefined,
                        );
                        lease = await acquire(brokerOwnerId(sender, request), job.signal, rasterPolicy);
                        const materializedRequest = await materializeScanCleanupPreviewRequest(
                            request,
                            sender.id,
                            job.signal,
                            dependencies,
                        );
                        attachScanCleanupPageOverrideDefaults(
                            materializedRequest.options.pageOverrides,
                            materializedRequest.options.pageOverrideDefaults,
                            materializedRequest.options.marginsMm,
                        );
                        const detectionDependencies: IScanCleanupDetectionDependencies = {
                            getTempDir: dependencies.getTempDir,
                            getPdftoppmBinary: dependencies.getPdftoppmBinary,
                            resolveBinary: dependencies.resolveBinary,
                            renderPage: dependencies.renderPage,
                            renderPagePpm: dependencies.renderPagePpm,
                            ...(dependencies.renderPageBatch === undefined
                                ? {}
                                : {renderPageBatch: dependencies.renderPageBatch}),
                            ...(!rasterPolicy.rasterStreaming || dependencies.createRasterPipes === undefined
                                ? {}
                                : {createRasterPipes: dependencies.createRasterPipes}),
                            runSidecar: dependencies.runSidecar,
                        };
                        // Keep production detection on bounded stores. The
                        // preview-only aggregate readers remain on the raw
                        // retention object for compatibility with the preview
                        // pipeline and focused tests, but never cross this
                        // boundary into document-scale detection.
                        const detectionRetention: IScanCleanupDetectionRetention<IRetainedDocument> = {
                            openDocument: rawRasterRetention.openDocument,
                            pageCount: rawRasterRetention.pageCount,
                            pageSizeStore: rawRasterRetention.pageSizeStore,
                            rasterPages: rawRasterRetention.rasterPageSource,
                            retainedPaths: rawRasterRetention.retainedPaths,
                            rasterScratchPath: rawRasterRetention.rasterScratchPath,
                            stagedRasterPath: rawRasterRetention.stagedRasterPath,
                            retain: rawRasterRetention.retain,
                            releaseRaster: rawRasterRetention.releaseRaster,
                            release: rawRasterRetention.release,
                        };
                        const detection = await runScanCleanupDetection(
                            materializedRequest,
                            job.signal,
                            detectionRetention,
                            detectionDependencies,
                            {rasterConcurrency: rasterPolicy.rasterConcurrency},
                            (nextResults, progress, documentCanvasSignature) => {
                                const normalizedProgress = normalizeDetectionProgress(progress);
                                job.publish({
                                    jobId,
                                    status: 'running',
                                    documentCanvasSignature,
                                    progress: normalizedProgress,
                                    resultCount: normalizedProgress.completedUnits,
                                    results: nextResults,
                                    updatedAtMs: createEpochMs(),
                                });
                            },
                            logScanCleanupMessage,
                        );
                        if (detection.resultStore.pageCount > SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES) {
                            const resultStoreId = registerScanCleanupDetectionResultStore({
                                documentRevision: request.documentRevision,
                                ownerId: request.ownerId,
                                resultStore: detection.resultStore,
                                sourcePdfPath: request.sourcePdfPath,
                            });
                            registeredDetectionResultStoreIds.add(resultStoreId);
                            return {
                                ...detection,
                                resultStoreId,
                            };
                        }
                        ownedDetectionResultStores.set(jobId, detection.resultStore);
                        return detection;
                    } finally {
                        lease?.release();
                    }
                },
            });
            subscribeDetection(sender, jobId, request);
            const activeEntry = {
                jobId,
                request,
                signature,
            };
            activeDetectionJobsByBrokerOwner.set(ownerId, activeEntry);
            void handle.settled.finally(async () => {
                // A destroyed sender makes the progress pump drop the
                // terminal frame before the delivery callback can clear its
                // per-job result cursor. Release it at job settlement as the
                // lifecycle owner, while keeping terminal delivery idempotent.
                deliveredDetectionResults.delete(detectionDeliveryKey(sender.id, jobId));
                const resultStore = ownedDetectionResultStores.get(jobId);
                ownedDetectionResultStores.delete(jobId);
                if (resultStore !== undefined) {
                    await resultStore.close().catch(error => {
                        logger.warn(`Scan cleanup could not close detection results: ${getErrorMessage(error)}`);
                    });
                }
                if (activeDetectionJobsByBrokerOwner.get(ownerId) === activeEntry) {
                    activeDetectionJobsByBrokerOwner.delete(ownerId);
                }
            }).catch(() => undefined);
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(sender, jobId, owner) {
            const actor = detectionActor(sender, owner);
            const state = publicDetectionState(detectionJobs.get(jobId, actor));
            if (!state || [
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return false;
            }
            const canceled = detectionJobs.cancel(jobId, actor, 'Scan cleanup detection canceled');
            if (canceled) {
                const ownerId = brokerOwnerId(sender, owner);
                if (activeDetectionJobsByBrokerOwner.get(ownerId)?.jobId === jobId) {
                    // The registry exposes canceling on its envelope while the
                    // detection progress payload still carries its last
                    // queued/running status. Remove the join candidate at the
                    // same boundary that acknowledges cancellation, so a new
                    // identical request cannot inherit the retiring job.
                    activeDetectionJobsByBrokerOwner.delete(ownerId);
                }
            }
            return canceled;
        },
        getDetectionJobState(sender, jobId, owner) {
            return rendererDetectionState(publicDetectionState(
                detectionJobs.get(jobId, detectionActor(sender, owner)),
            ));
        },
        subscribeDetectionJob(sender, jobId, owner) {
            return subscribeDetection(sender, jobId, owner)
                ? rendererDetectionState(publicDetectionState(
                    detectionJobs.get(jobId, detectionActor(sender, owner)),
                ))
                : null;
        },
    };
}
