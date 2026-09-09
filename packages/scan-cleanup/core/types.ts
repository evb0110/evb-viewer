import type {
    INativeScanCleanupOutputMetadataV3,
    IScanCleanupDocumentPrior,
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPlacementAnchor,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupProgressV3,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';

export type TScanCleanupLog = (
    level: 'debug' | 'warn' | 'error',
    message: string,
) => void;

export type TScanCleanupAssemblerBackend =
    | 'native-pdf-image-combine'
    | 'native-pdf-page-ops'
    | 'cli-wasm-pdf-image-combine'
    | 'cli-fallback-img2pdf-qpdf'
    | 'cli-fallback-wasm-or-img2pdf-qpdf'
    | 'cli-fallback-qpdf-page-ops'
    | 'source-preserved';

export type TScanCleanupTransportMode =
    | 'fifo-ppm'
    | 'file-ppm'
    | 'file-png'
    | 'source-preserved';

export interface IPdfPageSize {
    pageNumber: number;
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
    /**
     * The page's physical MediaBox, when a PDF tool exposed it separately
     * from the CropBox view. Most consumers should use the effective
     * x/width fields above. These fields let the raster adapter reject a
     * clearly broken, undersized CropBox without changing ordinary crops.
     */
    mediaXPoints?: number;
    mediaYPoints?: number;
    mediaWidthPoints?: number;
    mediaHeightPoints?: number;
    /** The original CropBox, retained when a compatibility fallback chose MediaBox. */
    cropXPoints?: number;
    cropYPoints?: number;
    cropWidthPoints?: number;
    cropHeightPoints?: number;
    /** The rectangle the caller must ask Poppler to render for this page. */
    renderBox?: 'cropbox' | 'mediabox';
    dominantImageWidthPx?: number;
    dominantImageHeightPx?: number;
    dominantImageWidthPoints?: number;
    dominantImageHeightPoints?: number;
}

/** Whether a page-size sidecar inspected image streams for dominant-raster facts. */
export type TPdfPageSizeDominantImageAnalysis =
    | 'performed'
    | 'unavailable'
    | 'skipped'
    | 'unknown';

/**
 * One bounded window from the file-backed page geometry protocol. `offset`
 * and `byteLength` identify the JSONL record in the sidecar. They are safe
 * JavaScript numbers after checked u64 conversion by the reader.
 */
export interface IPdfPageSizeChunk {
    pageCount: number;
    /** `/Pages /Count` declared by the native page tree, when present. */
    declaredPageCount?: number;
    /** Number of reachable leaf pages validated by the native walker. */
    reachablePageCount?: number;
    chunkIndex: number;
    firstPageNumber: number;
    offset: number;
    byteLength: number;
    pages: IPdfPageSize[];
    /** Old JSON/fallback producers omit this header-only capability. */
    dominantImageAnalysis?: TPdfPageSizeDominantImageAnalysis;
}

/**
 * Positional consumers read this geometry as `pageSizes[pageNumber - 1]`, so a
 * full-length array whose records are out of order hands one page another
 * page's paper, DPI, placement and text-layer matrix without ever looking
 * wrong. The two real decoders already answer `1..N`; this is the admission
 * check for an injected or directly supplied array, and it rejects rather than
 * sorts so the broken producer is the thing that surfaces.
 */
export function assertCanonicalPdfPageSizes(
    pageSizes: readonly IPdfPageSize[],
    context: string,
) {
    for (const [
        index,
        pageSize,
    ] of pageSizes.entries()) {
        if (pageSize.pageNumber !== index + 1) {
            throw new Error(
                `${context} received page geometry out of document order: expected page ${String(index + 1)} at index ${String(index)}, received page ${String(pageSize.pageNumber)}`,
            );
        }
    }
}

export interface IDetectedPageRaster {
    dpi: number;
    width: number;
    height: number;
    hasBilevelLayer?: boolean;
    hasDominantBilevelLayer?: boolean;
    backgroundDpi?: number;
}

/**
 * Bounded access to the source's raster facts. Native retention must expose
 * one page at a time so a long document never leaves a raster map in memory.
 * `documentDpi` is the optional scalar fallback for pages without a detected
 * raster record.
 */
export interface IScanCleanupPageRasterSource {
    detected: boolean;
    documentDpi?: number | null;
    /** Counted without retaining the page-indexed raster facts. */
    compactLayeredPageCount?: number;
    /** True once every document page has had a raster fact lookup. */
    compactLayeredPageCountComplete?: boolean;
    getPageRaster: (
        pageNumber: number,
    ) => Promise<IDetectedPageRaster | undefined> | IDetectedPageRaster | undefined;
}

/**
 * File-backed detection results for document-scale runs. The implementation
 * keeps the JSON records on disk and exposes only the requested page window;
 * callers must not turn the whole document back into a JavaScript collection.
 */
export interface IScanCleanupResultStore<TRecord> {
    readonly pageCount: number;
    readonly resultCount: number;
    append: (result: TRecord) => Promise<void>;
    replace: (pageNumber: number, result: TRecord) => Promise<void>;
    getPage: (pageNumber: number) => Promise<TRecord | undefined>;
    readRange: (
        firstPageNumber: number,
        lastPageNumberExclusive: number,
    ) => Promise<TRecord[]>;
    forEachChunk: (
        onChunk: (
            results: readonly TRecord[],
            firstPageNumber: number,
        ) => Promise<void> | void,
    ) => Promise<void>;
    close: () => Promise<void>;
}

/**
 * Detection returns this store open on success. Reconciliation, preview, and
 * conversion consumers own the successful handoff and must close it after
 * their last bounded read. Detection closes it itself on cancellation or
 * failure, before releasing the source document.
 */
export interface IScanCleanupDetectionResultStore
    extends IScanCleanupResultStore<IScanCleanupDetectionResult> {}

export interface ISourceDpiDetectionResult {
    documentDpi: number | null;
    pageDpiByNumber: Map<number, number>;
    pageRasterByNumber: Map<number, IDetectedPageRaster>;
}

export function resolveSourceDpi(value: number | null | undefined, fallback = 300) {
    const candidate = value ?? fallback;
    return Number.isFinite(candidate) && candidate > 0
        ? Math.max(1, Math.round(candidate))
        : fallback;
}

/** Read verified dominant-image metadata as one bounded page raster fact. */
export function detectPageRasterFromPageSize(
    page: IPdfPageSize,
): IDetectedPageRaster | undefined {
    const {
        dominantImageWidthPx: width,
        dominantImageHeightPx: height,
        dominantImageWidthPoints: widthPoints,
        dominantImageHeightPoints: heightPoints,
    } = page;
    if (
        width === undefined
        || height === undefined
        || widthPoints === undefined
        || heightPoints === undefined
        || !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || width <= 0
        || height <= 0
        || !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || widthPoints <= 0
        || heightPoints <= 0
    ) {
        return undefined;
    }
    const dpi = Math.max(
        width / widthPoints * 72,
        height / heightPoints * 72,
    );
    if (!Number.isFinite(dpi) || dpi <= 0) {
        return undefined;
    }
    return {
        dpi: Math.max(1, Math.round(dpi)),
        width,
        height,
    };
}

export function detectSourceDpiFromPageSizes(
    pageSizes: readonly IPdfPageSize[],
): ISourceDpiDetectionResult | null {
    if (pageSizes.length === 0) {
        return null;
    }
    const pageRasterByNumber = new Map<number, IDetectedPageRaster>();
    for (const page of pageSizes) {
        const raster = detectPageRasterFromPageSize(page);
        if (raster === undefined) {
            return null;
        }
        pageRasterByNumber.set(page.pageNumber, raster);
    }
    const pageDpiByNumber = new Map<number, number>();
    let documentDpi = 0;
    for (const [
        pageNumber,
        raster,
    ] of pageRasterByNumber) {
        pageDpiByNumber.set(pageNumber, raster.dpi);
        documentDpi = Math.max(documentDpi, raster.dpi);
    }
    return {
        documentDpi: documentDpi > 0 ? documentDpi : null,
        pageDpiByNumber,
        pageRasterByNumber,
    };
}

export interface IPdfMrcLayers {
    backgroundDpi: number;
    backgroundPath: string;
    foregroundDpi: number;
    foregroundHeight: number;
    foregroundPath: string;
    foregroundWidth: number;
    selectionMaskDecode: 'default' | 'inverted';
    selectionMaskPath: string;
}

export interface IScanCleanupRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    onStdout?: (chunk: string) => void;
    log?: TScanCleanupLog;
}

export interface IScanCleanupProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type TScanCleanupRunCommand = (
    command: string,
    args: string[],
    options?: IScanCleanupRunCommandOptions,
) => Promise<IScanCleanupProcessResult>;

export type TScanCleanupGetPageCount = (
    pdfPath: string,
    options?: {signal?: AbortSignal},
) => Promise<number>;

export interface IReadPdfPageSizesOptions {
    pdfPageOpsBinary?: string;
    qpdfBinary?: string;
    pdfinfoBinary?: string;
    tempDir: string;
    signal?: AbortSignal;
    log: TScanCleanupLog;
    runCommand: TScanCleanupRunCommand;
    /** Detection reads raw CropBoxes so its native retry can test MediaBox. */
    resolveSuspiciousCropBoxFallback?: boolean;
}

export type TScanCleanupGetPageSizes = (
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) => Promise<IPdfPageSize[]>;

/**
 * Open a bounded page-geometry view. The returned store owns its current
 * chunk and must be closed by the conversion or detection caller.
 */
export type TScanCleanupGetPageSizeStore = (
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) => Promise<IPdfPageSizeStore> | IPdfPageSizeStore;

export type TScanCleanupGetPageSizeChunks = (
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) => AsyncGenerator<IPdfPageSizeChunk>;

export type TScanCleanupDetectSourceDpi = (
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TScanCleanupLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pageNumbers?: readonly number[],
    onProgress?: (completedPages: number, totalPages: number) => void,
    runCommand?: TScanCleanupRunCommand,
) => Promise<IScanCleanupPageRasterSource | ISourceDpiDetectionResult>;

export interface IScanCleanupRasterRenderLimits {
    expectedWidthPx: number;
    expectedHeightPx: number;
    maxPixels: number;
    maxDimensionPx: number;
    scaleToFitPx?: number;
}

export type TScanCleanupRenderPage = (
    paths: Pick<IScanCleanupWorkerPaths, 'pdftoppmBinary'>,
    log: TScanCleanupLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number
    },
    limits?: IScanCleanupRasterRenderLimits,
    renderBox?: 'auto' | 'cropbox' | 'mediabox',
) => Promise<void>;

/**
 * The sidecar adapter is a transport: it reports the decoded native frame and
 * nothing else. Stage naming, percentage, ETA, and weighted bands belong to the
 * workflow that ran the sidecar, which is the only owner that knows what the
 * frame means for the run the user is watching.
 */
export type TScanCleanupSidecarProgress = (nativeProgress: TNativeScanCleanupProgressV3) => void;

export interface IScanCleanupSidecarProtocolCapabilities {structuredWarningEventsSupported: boolean;}

export type TScanCleanupRunSidecar = (
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    onProgress: TScanCleanupSidecarProgress,
    options?: {
        priority?: 'background';
        allowedPathRoot?: string;
    },
) => Promise<IScanCleanupSidecarProtocolCapabilities | undefined> | Promise<void>;

export type TScanCleanupRequirePublishedRaster = (
    path: string | undefined,
    pageNumber: number,
    role: string,
) => Promise<string>;

export type TScanCleanupExtractMrcLayers = (input: {
    pdfPath: string;
    pageNumber: number;
    backgroundOutputPath: string;
    foregroundOutputPath: string;
    selectionMaskOutputPath: string;
    pdfimagesBinary: string | undefined;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    signal?: AbortSignal;
}) => Promise<IPdfMrcLayers | null>;

export type TScanCleanupExtractMrcLayersBatch = (input: {
    pdfPath: string;
    targets: Array<{
        backgroundOutputPath: string;
        foregroundOutputPath: string;
        pageNumber: number;
        selectionMaskOutputPath: string;
    }>;
    pdfimagesBinary: string | undefined;
    qpdfBinary: string;
    pdfImageCombineBinary: string;
    pdftoppmBinary: string;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    rasterConcurrency: number;
    signal?: AbortSignal;
    onProgress?: (completedPages: number, totalPages: number) => void;
}) => Promise<Map<number, IPdfMrcLayers>>;

export interface IScanCleanupWorkerPaths {
    qpdfBinary: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    pdfinfoBinary?: string;
    scanCleanupBinary: string;
    pdfImageCombineBinary: string;
    pdfPageOpsBinary?: string;
    /** Whether the selected assembler accepts the Wave 1a JSON envelope. */
    provenanceStampSupport?: boolean;
    assemblyBackend?: TScanCleanupAssemblerBackend;
    transportMode?: TScanCleanupTransportMode;
    tempDir: string;
}

export interface IRunScanCleanupPipelineRequest {
    sourcePdfPath: string;
    outputPdfPath: string;
    options: IScanCleanupOptions;
    /**
     * Internal file-backed detection handoff. The conversion reads only the
     * current bounded batch from this store. IPC callers keep using the
     * compatibility page-keyed fields below until they adopt the handoff.
     */
    detectionResultStore?: IScanCleanupDetectionResultStore;
    sourcePageNumbers?: number[];
    sourcePageRange?: {
        startPageNumber: number;
        endPageNumber: number
    };
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
    softAlphaForegroundRecommendations?: Partial<Record<string, boolean>>;
    layoutByPage?: TScanCleanupLayoutByPage;
    sourcePageMetadataByPage?: Partial<Record<string, IScanCleanupSourcePageMetadata>>;
    /** Document-level calibration priors produced by the completed analysis pass. */
    documentPriorByPage?: Partial<Record<string, IScanCleanupDocumentPrior>>;
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
    /** Resolved `ink` placement positions for the outputs of each page. */
    placementAnchorsByPage?: Partial<Record<
        string,
        Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>
    >>;
    /** Bounded document-wide calibration for xlarge `ink` placement. */
    placementAnchorSummary?: IScanCleanupPlacementAnchorSummary;
    assemblyBackend?: TScanCleanupAssemblerBackend;
    transportMode?: TScanCleanupTransportMode;
}

export interface IRunScanCleanupPipelineDependencies {
    getPageCount: TScanCleanupGetPageCount;
    getPageSizeStore?: TScanCleanupGetPageSizeStore;
    /** Small-document/test compatibility adapter. Production uses getPageSizeStore. */
    getPageSizes?: TScanCleanupGetPageSizes;
    detectSourceDpi: TScanCleanupDetectSourceDpi;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TScanCleanupLog,
    ) => Promise<void>;
    renderPage: TScanCleanupRenderPage;
    renderPagePpm: TScanCleanupRenderPage;
    runSidecar: TScanCleanupRunSidecar;
    runCommand: TScanCleanupRunCommand;
    getAvailableScratchBytes: (directory: string) => Promise<number | null>;
    extractMrcLayers?: TScanCleanupExtractMrcLayers;
    extractMrcLayersBatch?: TScanCleanupExtractMrcLayersBatch;
    requirePublishedRaster?: TScanCleanupRequirePublishedRaster;
    hashNativeBinary?: (path: string) => Promise<string>;
}

export interface IScanCleanupCorePolicy {
    totalRamBytes: IScanCleanupRuntimePolicy['totalRamBytes'];
    rasterConcurrency: IScanCleanupRuntimePolicy['rasterConcurrency'];
    logicalCpus: IScanCleanupRuntimePolicy['logicalCpus'];
}

export interface IScanCleanupOutputPageForSummary {
    outputPageNumber: number;
    sourcePageNumber: number;
    semanticMode: TScanCleanupOutputMode;
    representation: string;
    preservationReason: string | null;
    sourceDpi: number | null;
    sourceBackgroundDpi: number | null;
    renderDpi: number;
    illuminationNormalized: boolean;
    textToneApplied: boolean;
    binarizationMode: string | null;
    half: TScanCleanupOutputHalf;
    outputOrdinal: number;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    blank: boolean;
    streamBytes?: {
        composite?: number;
        bilevel?: number;
        background?: number;
        foregroundMask?: number;
        foregroundAlpha?: number;
    };
    /** Canonical affine geometry used by diagnostics to compare source and output grids. */
    renderGeometry?: Pick<INativeScanCleanupOutputMetadataV3,
        | 'canvasHeightPx'
        | 'canvasWidthPx'
        | 'cropRect'
        | 'dewarpMapping'
        | 'foldClipLeftPx'
        | 'foldClipRightPx'
        | 'forwardTransform'
        | 'inputHeightPx'
        | 'inputWidthPx'
        | 'intrinsicRasterHeightPx'
        | 'intrinsicRasterWidthPx'
        | 'matchedCanvasContentHeightPx'
        | 'matchedCanvasContentWidthPx'
        | 'matchedCanvasIntrinsicOverflowLeftPx'
        | 'matchedCanvasIntrinsicOverflowRightPx'
        | 'matchedCanvasIntrinsicOverflowTopPx'
        | 'outputHeightPx'
        | 'outputWidthPx'
        | 'placementOffsetXPx'
        | 'placementOffsetYPx'
        | 'sourceRegion'
    > & {dewarped: boolean;};
}

export interface IScanCleanupOutputMapping {
    sourcePage: number;
    half: TScanCleanupOutputHalf;
    outputOrdinal: number | null;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    blank: boolean;
}

export interface IScanCleanupRepresentationReport {
    schemaVersion: 1;
    sourceBytes: number;
    outputBytes: number;
    outputToSourceByteRatio: number;
    compactSourceBudget: unknown;
    outputMappings: IScanCleanupOutputMapping[];
    pages: IScanCleanupOutputPageForSummary[];
    /** Xlarge runs keep the detailed records in bounded JSONL sidecars. */
    outputMappingsSidecarPath?: string;
    pagesSidecarPath?: string;
}
