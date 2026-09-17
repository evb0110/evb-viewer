import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import type {ISerializableErrorEnvelope} from '@contracts/serializableError';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupReconciliationMetadata,
    IScanCleanupTextAxis,
    TScanCleanupBinarizationMethod,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutByPage,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupAppliedMargins,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';
import {
    SCAN_CLEANUP_WARNING_EVENT_SCHEMA,
    type INativeScanCleanupBinarizationDiagnosticsV3,
    type INativeScanCleanupOutputModeDiagnosticsV3,
    type INativeScanCleanupSplitDiagnosticsV3,
    type INativeScanCleanupTextToneDiagnosticsV3,
    type IScanCleanupPlacementAnchor,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/progress';
import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    TJobId,
    TRequestId,
} from '@contracts/shared';
import type {TEpochMs} from '@contracts/timestamps';

export interface IScanCleanupOwnerContext {
    /** Stable for one renderer tab/session; Electron combines this with the sending WebContents id. */
    ownerId: string;
    /** Revision token (or mtime-derived token) fencing every recomputable artifact and job. */
    documentRevision: string;
}

export type TScanCleanupErrorCode =
    | TNativeErrorCode
    | 'tools-unavailable'
    /** Not even one page raster fits the scratch budget. Carries scratch figures. */
    | 'insufficient-scratch'
    | 'canceled'
    | 'detection-results-unavailable'
    | 'internal';

export const SCAN_CLEANUP_ERROR_CODES = [
    ...NATIVE_ERROR_CODES,
    'tools-unavailable',
    'insufficient-scratch',
    'canceled',
    'detection-results-unavailable',
    'internal',
] as const satisfies readonly TScanCleanupErrorCode[];

/**
 * Free and required scratch space for an `insufficient-scratch` failure.
 *
 * The renderer owns every word the user reads, so the numbers travel typed
 * beside the error code instead of inside its English message.
 */
export interface IScanCleanupScratchShortfall {
    availableBytes: number | null;
    requiredBytes: number | null;
}

function decodeOptionalByteCount(value: unknown) {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('invalid scan-cleanup scratch shortfall');
    }
    return value;
}

/** Normalizes the two scratch figures, or rejects a payload that is not one. */
export function decodeScanCleanupScratchShortfall(value: unknown): IScanCleanupScratchShortfall {
    if (!isRecord(value)) {
        throw new Error('invalid scan-cleanup scratch shortfall');
    }
    return {
        availableBytes: decodeOptionalByteCount(value.availableBytes),
        requiredBytes: decodeOptionalByteCount(value.requiredBytes),
    };
}

export interface IScanCleanupErrorEnvelope extends ISerializableErrorEnvelope<TScanCleanupErrorCode> {scratchShortfall?: IScanCleanupScratchShortfall;}

export function isScanCleanupErrorEnvelope(value: unknown): value is IScanCleanupErrorEnvelope {
    if (
        !isRecord(value)
        || !isOneOf(SCAN_CLEANUP_ERROR_CODES, value.code)
        || typeof value.message !== 'string'
    ) {
        return false;
    }
    if (value.scratchShortfall === undefined) {
        return true;
    }
    try {
        decodeScanCleanupScratchShortfall(value.scratchShortfall);
        return true;
    } catch {
        return false;
    }
}

export interface IScanCleanupPreviewRequest extends IScanCleanupOwnerContext {
    /** Renderer-created token joining the raw raster to this exact request generation. */
    requestId: TRequestId;
    sourcePdfPath: string;
    pageNumber: TPageNumber;
    options: IScanCleanupOptions;
    documentPrior?: IScanCleanupDocumentPrior;
    /**
     * Automatic output-mode evidence already produced by document detection.
     * Electron resolves it into native page options so preview does not repeat
     * the same mode analysis.
     */
    outputModeRecommendation?: TScanCleanupOutputMode;
    /**
     * Physical Mixed-layer representation selected by the same analysis as the
     * Auto mode. False is meaningful: it locks the stencil path.
     */
    softAlphaForegroundRecommendation?: boolean;
    /**
     * How the caller expects each page of the document to be cut. Matched page
     * size is measured over produced pages, so the preview and the run derive
     * one rectangle only if they are told the same thing about the document.
     */
    layoutByPage?: TScanCleanupLayoutByPage;
    /**
     * True only after document detection has finished reconciling every
     * automatic page. Before that, matched-canvas planning treats layout
     * verdicts as provisional evidence and resists document-wide outliers.
     */
    layoutDetectionComplete?: boolean;
    /**
     * Automatic geometry already established by document detection for this
     * page. Preview replays it just like final conversion, so loading, base
     * preview, detail tiles, and export do not run competing page planners.
     */
    pagePlanEvidence?: IScanCleanupPagePlanEvidence;
    /**
     * Where `ink` alignment has resolved this page's outputs to sit, clustered
     * across the whole document. Preview and the final run are handed the same
     * anchors so the position the user approves is the position that ships.
     */
    placementAnchors?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>;
    detail?: {
        /** Renderer-visible regions keyed by final output half; drives crop rendering and tile identity. */
        viewports: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
        outputMode: TScanCleanupOutputMode;
    };
    /**
     * Set by the request for the page the user is looking at, which is what
     * preview admission ranks against. A prefetch never sets it.
     */
    visible?: boolean;
}

export interface IScanCleanupRawPreviewResult {
    pageNumber: TPageNumber;
    totalPages: number;
    rawImageData: Uint8Array;
    rawWidthPx: number;
    rawHeightPx: number;
}

/** The raw raster pushed ahead of the cleaned outputs of the request that asked for it. */
export interface IScanCleanupRawPreviewEvent
    extends IScanCleanupRawPreviewResult, IScanCleanupOwnerContext { requestId: TRequestId; }

export interface IScanCleanupPreviewCancelRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    invalidateRawCache?: boolean;
    /**
     * Pages whose cleaned preview work the renderer still wants. A navigation
     * names the window it is moving into so the work already running for those
     * pages survives instead of being restarted; omitting it cancels the whole
     * document, which is what a settings change or a closing session means.
     */
    retainPages?: readonly number[];
}

export type TScanCleanupCanvasPolicy = 'intrinsic' | 'strict-maximum';

/**
 * The single rectangle and pixel grid every matched output of a document is
 * normalized onto: the same absolute PDF points and the same pixel dimensions
 * for every page, so the run has one output resolution rather than one per
 * page. A page whose paper is smaller than the rectangle is resampled up to it;
 * only the residual aspect-ratio difference is padded.
 */
export interface IScanCleanupDocumentCanvasPlan {
    widthPoints: number;
    heightPoints: number;
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupContentSideConfidence {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface IScanCleanupContentTextMaskSummary {
    analysisWidthPx: number;
    analysisHeightPx: number;
    inkPixels: number;
    lineCount: number;
    bounds?: IScanCleanupPixelRect;
}

export type TScanCleanupContentTrimSide = 'left' | 'top' | 'right' | 'bottom';

export interface IScanCleanupContentBlockEvidence {
    bounds: IScanCleanupPixelRect;
    pictureMaskOverlapPixels: number;
    headingEvidence: boolean;
    grayscaleEvidence: boolean;
    /** Present in current native metadata; absent in artifacts made before text hard-protection. */
    textEvidence?: boolean;
}

export interface IScanCleanupContentAcceptedTrim {
    side: TScanCleanupContentTrimSide;
    iteration: number;
    score: number;
    threshold: number;
    contentDistanceSum: number;
    garbageDistanceSum: number;
    removedBlocks: IScanCleanupContentBlockEvidence[];
}

export interface IScanCleanupContentDiagnostics {
    sideConfidence: IScanCleanupContentSideConfidence;
    textMask: IScanCleanupContentTextMaskSummary;
    /**
     * Exact analysis-space detector box after all native side writers. Export
     * still maps it through source support and margins; this is not output cropRect.
     */
    shippedBounds?: IScanCleanupPixelRect;
    acceptedTrims?: IScanCleanupContentAcceptedTrim[];
    protectedBlocks?: IScanCleanupContentBlockEvidence[];
}

export interface IScanCleanupBinarizationDiagnostics extends INativeScanCleanupBinarizationDiagnosticsV3 {}

export interface IScanCleanupTextToneDiagnostics extends INativeScanCleanupTextToneDiagnosticsV3 {}

/** Renderer-facing per-page diagnostic summary assembled from page and first-output metadata. */
export interface IScanCleanupPageDiagnostics {
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    manualSkew?: boolean;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: IScanCleanupBinarizationDiagnostics | null;
    textToneDiagnostics?: IScanCleanupTextToneDiagnostics;
    despeckleFallback?: boolean;
    autoDewarpAttempted?: boolean;
    dewarpApplied?: boolean;
    dewarpConfidence?: number | null;
    outputDiagnostics?: IScanCleanupPageOutputDiagnostics[];
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
}

export interface IScanCleanupPageOutputDiagnostics {
    half: TScanCleanupOutputHalf;
    contentDiagnostics?: IScanCleanupContentDiagnostics;
}

export interface IScanCleanupPreviewMetadata {
    half: 'full' | 'left' | 'right';
    layoutClassification: TScanCleanupLayoutClassification;
    layoutConfidence: number;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied?: boolean;
    manualSkew?: boolean;
    sourceRegion: IScanCleanupPixelRect;
    contentBox: IScanCleanupPixelRect | null;
    /** Applied crop in deskewed/dewarped page-region coordinates; absent in older metadata. */
    cropRect?: IScanCleanupPixelRect;
    /** Optional for metadata produced before native protocol v2 gained A4 diagnostics. */
    contentDiagnostics?: IScanCleanupContentDiagnostics;
    appliedMargins: IScanCleanupAppliedMargins;
    /** Intrinsic dimensions of the unpadded cleaned raster. */
    outputWidthPx: number;
    outputHeightPx: number;
    /** Intrinsic raster extent before matched-canvas materialization. */
    intrinsicRasterWidthPx?: number;
    intrinsicRasterHeightPx?: number;
    /**
     * Actual image payload bounds inside the intrinsic cleaned raster.
     * Absent payloads cover the complete intrinsic raster.
     */
    renderRegion?: IScanCleanupPixelRect;
    /** Logical matched-page canvas dimensions; never smaller than the intrinsic raster. */
    canvasWidthPx: number;
    canvasHeightPx: number;
    /** Matched-canvas decision; optional only for metadata written by older native binaries. */
    canvasPolicy?: TScanCleanupCanvasPolicy;
    canvasOverflow?: boolean;
    matchedCanvasTargetWidthPx?: number | null;
    matchedCanvasTargetHeightPx?: number | null;
    matchedCanvasTargetWidthPoints?: number | null;
    matchedCanvasTargetHeightPoints?: number | null;
    /**
     * Size the intrinsic raster occupies on the matched canvas, in canvas
     * pixels. It differs from the intrinsic size whenever the page was scaled
     * to the document's common visual scale, which a final run applies to the
     * raster it publishes and a preview leaves for the renderer to apply.
     */
    matchedCanvasContentWidthPx?: number | null;
    matchedCanvasContentHeightPx?: number | null;
    /** True when horizontal placement is anchored to transformed optical content. */
    matchedCanvasOpticalPlacement?: boolean;
    matchedCanvasOpticalContentLeftPx?: number | null;
    matchedCanvasOpticalContentRightPx?: number | null;
    matchedCanvasIntrinsicOverflowLeftPx?: number;
    matchedCanvasIntrinsicOverflowRightPx?: number;
    matchedCanvasIntrinsicOverflowTopPx?: number;
    /** Canvas-grid columns excluded from the source image at the fold edge. */
    foldClipLeftPx?: number;
    foldClipRightPx?: number;
    /** Intrinsic raster origin within the logical canvas. */
    placementOffsetXPx: number;
    placementOffsetYPx: number;
    /** Maps rotated analysis-page coordinates into intrinsic cleaned-raster coordinates. */
    forwardTransform: IScanCleanupPreviewAffine | null;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    inputWidthPx: number;
    inputHeightPx: number;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    resamplePasses: number;
    sourceDpi?: number;
    renderDpi?: number;
    requestedRenderDpi?: number;
    rasterScaleLimited?: boolean;
    /** True when multiplicative illumination normalization affected the rendered raster. */
    illuminationNormalized?: boolean;
    /** Evidence and exact monotone curve shared by preview, export, and detail tiles. */
    textToneDiagnostics?: IScanCleanupTextToneDiagnostics;
    /** Concrete mode that produced this output; absent only for older sidecars. */
    outputMode?: TScanCleanupOutputMode;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: IScanCleanupBinarizationDiagnostics | null;
    /** True when despeckle used top-decile fallback anchors because the page had no calibrated seed. */
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    /** Derived by Electron from native dewarp metadata. */
    dewarpApplied?: boolean;
    warnings: string[];
}

export interface IScanCleanupPreviewPageMetadata extends IScanCleanupReconciliationMetadata, IScanCleanupPageDiagnostics {
    layoutClassification: IScanCleanupPreviewMetadata['layoutClassification'];
    layoutConfidence?: number;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    excluded: boolean;
    blankOutputsSkipped: number;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
    softAlphaForegroundRecommendation?: boolean;
}

export interface IScanCleanupPreviewOutput {
    imageData: Uint8Array;
    metadata: IScanCleanupPreviewMetadata;
}

export interface IScanCleanupPreviewResult {
    /** Request generation that produced this result; present on current IPC results. */
    requestId?: TRequestId;
    pageNumber: TPageNumber;
    totalPages: number;
    rawImageData: Uint8Array;
    rawWidthPx: number;
    rawHeightPx: number;
    pageMetadata: IScanCleanupPreviewPageMetadata;
    outputs: IScanCleanupPreviewOutput[];
}

/**
 * What `preview` puts on the wire. Base previews leave `rawImageData` out:
 * those bytes reached the renderer over `onPreviewRaw` a sidecar run earlier.
 * Detail tiles leave it out too: they reuse the renderer's already-held base
 * raster and carry only the tile outputs and their metadata.
 *
 * A superseded or cancelled request answers with `canceled`. Cancellation is
 * the ordinary outcome of turning a page, so it is a result rather than a
 * rejection: an invoke that rejects is logged by Electron as a handler failure,
 * which would bury the failures that are real.
 */
export type TScanCleanupPreviewWireResult =
    | (Omit<IScanCleanupPreviewResult, 'rawImageData'> & {
        rawImageData?: Uint8Array;
        canceled?: undefined;
    })
    | {canceled: true};

export interface IScanCleanupDetectionRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    options: IScanCleanupOptions;
}

/**
 * Immutable source geometry measured once when detection opens the document.
 * Preview and final rendering share it over the typed bridge instead of each
 * reopening a hundreds-page PDF to rediscover the same page boxes and raster
 * resolution.
 */
export interface IScanCleanupSourcePageMetadata {
    pageNumber: TPageNumber;
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
    sourceDpi: number;
    /** Explicit Poppler box selected by document detection, when it retried a page. */
    renderBox?: 'cropbox' | 'mediabox';
    dominantImageWidthPx?: number;
    dominantImageHeightPx?: number;
    dominantImageWidthPoints?: number;
    dominantImageHeightPoints?: number;
}

/**
 * Automatic geometry already measured by a base preview under the exact
 * document/settings cache key used to start a final run. Coordinates are
 * clipped to the output half but normalized against the full rotated input, so
 * the same plan can be replayed at the source raster's final DPI without
 * treating it as a user-authored override.
 */
export interface IScanCleanupPagePlanEvidence {
    pageNumber: TPageNumber;
    rotationDegrees: TScanCleanupPageRotation;
    layoutClassification: TScanCleanupLayoutClassification;
    automaticSplit?: IScanCleanupNormalizedSplit;
    outputs: Partial<Record<TScanCleanupOutputHalf, {
        contentBox?: IScanCleanupNormalizedRect;
        detectedSkewDegrees?: number;
        textToneDiagnostics?: IScanCleanupTextToneDiagnostics;
    }>>;
}

/**
 * Bounded document-wide calibration for `ink` placement. The detection
 * result store keeps the page-local evidence, while this summary carries the
 * calibration needed by a streaming conversion without rebuilding a page map
 * in the renderer or across IPC.
 */
export interface IScanCleanupPlacementAnchorSummarySample {
    pageNumber: TPageNumber;
    half: TScanCleanupOutputHalf;
    /** The source content-box top, normalized to the document reference height. */
    yNormalized: number;
    /** The resolved offset from the document top edge for this sparse sample. */
    anchor: IScanCleanupPlacementAnchor;
}

export interface IScanCleanupPlacementAnchorSummaryCluster {
    /** First and last normalized values represented by this bounded cluster. */
    startNormalized: number;
    endNormalized: number;
    /** The cluster's deterministic snapped value. */
    valueNormalized: number;
}

export interface IScanCleanupPlacementAnchorSummaryIdentity {
    documentRevision: string;
    detectionSignature: string;
    calibrationSignature: string;
}

export interface IScanCleanupPlacementAnchorSummary {
    schemaVersion: 1;
    /** Number of ink-aligned output samples in the complete detection pass. */
    sampleCount: number;
    /** Tallest rotated included source sheet, in PDF points. */
    referenceHeightPoints: number;
    /** Jitter tolerance expressed against `referenceHeightPoints`. */
    toleranceNormalized: number;
    /** The document top edge selected from the bounded cluster summary. */
    topEdgeNormalized: number;
    /** The document and evidence identity that produced this calibration. */
    identity: IScanCleanupPlacementAnchorSummaryIdentity;
    /** At most one bounded cluster per retained sample bucket. */
    clusters: readonly IScanCleanupPlacementAnchorSummaryCluster[];
    /** Deterministic early, middle, and late evidence samples. */
    samples: readonly IScanCleanupPlacementAnchorSummarySample[];
}

export interface IScanCleanupPlacementAnchorCalibrationRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    detectionResultStoreId: string;
    options: IScanCleanupOptions;
    pageNumber?: TPageNumber;
}

export interface IScanCleanupPlacementAnchorCalibration {
    summary: IScanCleanupPlacementAnchorSummary;
    placementAnchors: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>;
}

export interface IScanCleanupDetectionResult extends IScanCleanupReconciliationMetadata {
    pageNumber: TPageNumber;
    /** Monotonic within one detection job for this page's provisional/reconciled verdicts. */
    revision?: number;
    classification: IScanCleanupPreviewMetadata['layoutClassification'];
    confidence: number;
    cutterXPx: number | null;
    documentPrior: IScanCleanupDocumentPrior | null;
    textAxis?: IScanCleanupTextAxis;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
    softAlphaForegroundRecommendation?: boolean;
    outputModeDiagnostics?: INativeScanCleanupOutputModeDiagnosticsV3;
    splitDiagnostics?: INativeScanCleanupSplitDiagnosticsV3;
    sourcePageMetadata?: IScanCleanupSourcePageMetadata;
    /**
     * Resolution-independent geometry and text-tone decisions measured by the
     * completed document analysis. Final cleanup replays this exact plan rather
     * than silently reclassifying pages the user never opened in preview.
     */
    pagePlanEvidence?: IScanCleanupPagePlanEvidence;
}

interface IScanCleanupDetectionJobBase {
    jobId: TJobId;
    /**
     * Canonical matched-canvas plan identity for the classifications settled
     * so far. The pre-detection plan is represented by the empty string, so
     * merely beginning detection cannot invalidate an identical preview.
     */
    documentCanvasSignature?: string;
    progress: TScanCleanupProgress;
    /** Scalar count for xlarge jobs whose page records stay file-backed. */
    resultCount?: number;
    /** Opaque main-process handoff for xlarge detection results. */
    detectionResultStoreId?: string;
    /** Bounded document-wide calibration for xlarge `ink` placement. */
    placementAnchorSummary?: IScanCleanupPlacementAnchorSummary;
    results: IScanCleanupDetectionResult[];
    updatedAtMs: TEpochMs;
}

export type TScanCleanupDetectionJobState =
    | IScanCleanupDetectionJobBase & {status: 'queued' | 'running' | 'canceling' | 'completed' | 'canceled'}
    | IScanCleanupDetectionJobBase & {
        status: 'failed';
        error: string;
        errorCode: TScanCleanupErrorCode;
        /**
         * Free and required scratch space for an `insufficient-scratch`
         * failure. The renderer states both figures in the user's language
         * instead of quoting the English exception.
         */
        scratchShortfall?: IScanCleanupScratchShortfall
    };

export type TScanCleanupDetectionStartResult =
    | {
        started: true;
        jobId: TJobId
    }
    | {
        started: false;
        jobId: TJobId;
        error: string;
        errorCode: TScanCleanupErrorCode;
        scratchShortfall?: IScanCleanupScratchShortfall
    };

export interface IScanCleanupStartRequest extends IScanCleanupOwnerContext {
    sourcePdfPath: string;
    options: IScanCleanupOptions;
    /** Ordered one-based source pages included in this output. Omitted means the full document. */
    sourcePageNumbers?: number[];
    /** A contiguous partial selection, used when its page count exceeds one IPC list budget. */
    sourcePageRange?: {
        startPageNumber: number;
        endPageNumber: number
    };
    /** Opaque id for the completed file-backed detection result store. */
    detectionResultStoreId?: string;
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
    softAlphaForegroundRecommendations?: Partial<Record<string, boolean>>;
    /** Document-level calibration priors settled by the completed detection pass. */
    documentPriorByPage?: Partial<Record<string, IScanCleanupDocumentPrior>>;
    /** The layouts the preview was measured against, so this run matches the same rectangle. */
    layoutByPage?: TScanCleanupLayoutByPage;
    sourcePageMetadataByPage?: Partial<Record<string, IScanCleanupSourcePageMetadata>>;
    /** Valid base-preview geometry that lets final rendering skip duplicate page analysis. */
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
    /** Document-wide `ink` placement positions, resolved by the renderer the preview used. */
    placementAnchorsByPage?: Partial<Record<
        string,
        Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>
    >>;
    /** Bounded document-wide calibration for xlarge `ink` placement. */
    placementAnchorSummary?: IScanCleanupPlacementAnchorSummary;
}

const s = runtimeSchema;
const summaryPageNumberValue = s.number({
    integer: true,
    min: 1,
    message: 'invalid scan-cleanup summary',
});
const summaryPageNumber = s.fromParser<TPageNumber>(
    value => requirePageNumber(summaryPageNumberValue.decode(value)),
    () => requirePageNumber(1),
);
const summaryCount = s.number({
    integer: true,
    min: 0,
    message: 'invalid scan-cleanup summary',
});
/**
 * One SC-IMP-003 condition a run reported, with the output it belongs to.
 *
 * `warnings` carries the same conditions as the sentences the user reads, and a
 * consumer that has to know *which* condition a run raised would otherwise have
 * to read English back. The page and half are the run's own attribution, so a
 * per-output condition stays attached to its output across the boundary; a
 * document-wide condition carries neither.
 */
export const SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA = s.object({
    event: SCAN_CLEANUP_WARNING_EVENT_SCHEMA,
    pageNumber: s.optional(summaryPageNumber),
    half: s.optional(s.oneOf([
        'full',
        'left',
        'right',
    ] as const, 'invalid scan-cleanup summary')),
});

export type TScanCleanupSummaryWarningEvent = TInferSchema<
    typeof SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA
>;

export const SCAN_CLEANUP_SUMMARY_SCHEMA = s.object({
    inputPages: summaryCount,
    outputPages: summaryCount,
    spreadsSplit: summaryCount,
    offcutsDiscarded: summaryCount,
    deskewSkipped: summaryCount,
    cropSkipped: summaryCount,
    excludedPages: summaryCount,
    blankPagesSkipped: summaryCount,
    warnings: s.array(s.string()),
    /**
     * Optional so a summary written before this channel existed still decodes:
     * such a run reported its conditions as sentences and has no typed list to
     * offer. A live run always publishes one.
     */
    warningEvents: s.optional(s.array(SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA)),
});
export type TScanCleanupSummary = TInferSchema<typeof SCAN_CLEANUP_SUMMARY_SCHEMA>;

interface IScanCleanupJobBase {
    jobId: TJobId;
    progress: TScanCleanupProgress;
    updatedAtMs: TEpochMs;
}

export type TScanCleanupJobState =
    | IScanCleanupJobBase & {status: 'queued' | 'running' | 'canceling' | 'handoff' | 'committing'}
    | IScanCleanupJobBase & {
        status: 'completed';
        outputPdfPath: string;
        summary: TScanCleanupSummary;
        partial: boolean
    }
    | IScanCleanupJobBase & {status: 'canceled'}
    | IScanCleanupJobBase & {
        status: 'failed';
        error: string;
        errorCode: TScanCleanupErrorCode;
        /** Free and required scratch space for an insufficient-scratch run. */
        scratchShortfall?: IScanCleanupScratchShortfall;
        failure?: FailureReceipt;
    };

export type TScanCleanupStartResult =
    | {
        started: true;
        jobId: TJobId;
        outputPdfPath: string
    }
    | {
        started: false;
        jobId: TJobId;
        error: string;
        errorCode: TScanCleanupErrorCode;
        scratchShortfall?: IScanCleanupScratchShortfall
    };
