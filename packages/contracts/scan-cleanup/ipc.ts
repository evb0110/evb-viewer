import { requirePageNumber } from '@contracts/pageNumbers';

import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {SERIALIZABLE_ERROR_ENVELOPE_SCHEMA} from '@contracts/serializableError';
import type {
    IScanCleanupDocumentPrior,
    TScanCleanupBinarizationMethod,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/domain';
import {SCAN_CLEANUP_WARNING_EVENT_SCHEMA} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {
    BinarizationDiagnostics,
    CleanupMetadata,
    ContentAcceptedTrim,
    ContentBlockEvidence,
    ContentDiagnostics,
    OutputModeDiagnostics,
    PageResultMetadata,
    SplitDiagnostics,
    SplitSeamPolyline,
    TextAxisHint,
    TextToneDiagnostics,
} from '@contracts/scan-cleanup/nativeWire.generated';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/progress';
import type {
    TJobId,
    TRequestId,
} from '@contracts/shared';
import type {TEpochMs} from '@contracts/timestamps';
import type {TPageNumber} from '@contracts/pageNumbers';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import * as v from 'valibot';
import type {
    SCAN_CLEANUP_OWNER_CONTEXT_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA,
    SCAN_CLEANUP_PREVIEW_REQUEST_SCHEMA,
    SCAN_CLEANUP_PREVIEW_CANCEL_REQUEST_SCHEMA,
    SCAN_CLEANUP_DETECTION_REQUEST_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_REQUEST_SCHEMA,
    SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA,
    SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA,
    SCAN_CLEANUP_START_REQUEST_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import type {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/decodeScanCleanupPlacementAnchorSummary';
export type {
    TScanCleanupCanvasPolicy,
    TScanCleanupContentTrimSide,
} from '@contracts/scan-cleanup/domain';

export type IScanCleanupOwnerContext = v.InferOutput<typeof SCAN_CLEANUP_OWNER_CONTEXT_SCHEMA>;

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

/** The renderer localizes the figures instead of reading them from English text. */
export const SCAN_CLEANUP_SCRATCH_SHORTFALL_SCHEMA = v.message(v.object({
    availableBytes: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
    requiredBytes: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
}), 'invalid scan-cleanup scratch shortfall');
export type IScanCleanupScratchShortfall = v.InferOutput<typeof SCAN_CLEANUP_SCRATCH_SHORTFALL_SCHEMA>;

export const SCAN_CLEANUP_ERROR_DETAILS_SCHEMA = v.object({scratchShortfall: v.optional(SCAN_CLEANUP_SCRATCH_SHORTFALL_SCHEMA)});
export type TScanCleanupErrorDetails = v.InferOutput<typeof SCAN_CLEANUP_ERROR_DETAILS_SCHEMA>;

export const SCAN_CLEANUP_ERROR_ENVELOPE_SCHEMA = v.object({
    ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.picklist(SCAN_CLEANUP_ERROR_CODES),
    details: v.optional(SCAN_CLEANUP_ERROR_DETAILS_SCHEMA),
});
export type IScanCleanupErrorEnvelope = v.InferOutput<typeof SCAN_CLEANUP_ERROR_ENVELOPE_SCHEMA>;

export function isScanCleanupErrorEnvelope(value: unknown): value is IScanCleanupErrorEnvelope {
    return v.safeParse(SCAN_CLEANUP_ERROR_ENVELOPE_SCHEMA, value, {abortEarly: true}).success;
}

export type IScanCleanupPreviewRequest = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_REQUEST_SCHEMA>;

export interface IScanCleanupRawPreviewEvent {
    ownerId: string;
    documentRevision: string;
    requestId: TRequestId;
    pageNumber: TPageNumber;
    totalPages: number;
    rawImageData: Uint8Array;
    rawWidthPx: number;
    rawHeightPx: number;
}
export type IScanCleanupRawPreviewResult = Omit<IScanCleanupRawPreviewEvent, 'ownerId' | 'documentRevision' | 'requestId'>;

export type IScanCleanupPreviewCancelRequest = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_CANCEL_REQUEST_SCHEMA>;

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

export type IScanCleanupContentBlockEvidence = ContentBlockEvidence;
export type IScanCleanupContentAcceptedTrim = ContentAcceptedTrim;
export type IScanCleanupContentDiagnostics = ContentDiagnostics;
export type IScanCleanupBinarizationDiagnostics = BinarizationDiagnostics;
export type IScanCleanupTextToneDiagnostics = TextToneDiagnostics;

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
    textToneDiagnostics?: IScanCleanupTextToneDiagnostics;
}

/** A preview's page record: the engine's page metadata and its first output's diagnostics. */
export interface IScanCleanupPreviewPageMetadata extends IScanCleanupPageDiagnostics, Pick<PageResultMetadata,
    | 'layoutClassification' | 'layoutConfidence' | 'cutterXPx' | 'rotationDegrees' | 'canvasScope'
    | 'excluded' | 'blankOutputsSkipped' | 'tier1Verdict' | 'reconciled' | 'clusterAgreement'> {
    splitSeam?: SplitSeamPolyline;
    splitAbstained?: boolean;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    softAlphaForegroundRecommendation?: boolean;
}

/** A preview output's metadata: the engine's output record as the preview carries it. */
export interface IScanCleanupPreviewMetadata extends Pick<CleanupMetadata,
    | 'half' | 'layoutClassification' | 'layoutConfidence' | 'manualSkew' | 'sourceRegion' | 'contentBox'
    | 'cropRect' | 'contentDiagnostics' | 'appliedMargins' | 'outputWidthPx' | 'outputHeightPx'
    | 'intrinsicRasterWidthPx' | 'intrinsicRasterHeightPx' | 'renderRegion' | 'canvasWidthPx' | 'canvasHeightPx'
    | 'canvasPolicy' | 'canvasOverflow' | 'matchedCanvasTargetWidthPx' | 'matchedCanvasTargetHeightPx'
    | 'matchedCanvasTargetWidthPoints' | 'matchedCanvasTargetHeightPoints' | 'matchedCanvasContentWidthPx'
    | 'matchedCanvasContentHeightPx' | 'matchedCanvasOpticalPlacement' | 'matchedCanvasIntrinsicOverflowLeftPx'
    | 'matchedCanvasIntrinsicOverflowRightPx' | 'matchedCanvasIntrinsicOverflowTopPx' | 'foldClipLeftPx'
    | 'foldClipRightPx' | 'placementOffsetXPx' | 'placementOffsetYPx' | 'forwardTransform' | 'cutterXPx'
    | 'splitSeam' | 'inputWidthPx' | 'inputHeightPx' | 'rotationDegrees' | 'canvasScope' | 'resamplePasses'
    | 'textToneDiagnostics' | 'rasterScaleLimited' | 'warnings'>, Partial<Pick<CleanupMetadata,
    | 'detectedSkewDegrees' | 'skewConfidence' | 'skewApplied' | 'illuminationNormalized' | 'binarizationMode' | 'binarizationDiagnostics' | 'despeckleFallback' | 'dewarpConfidence' | 'sourceDpi'
    | 'renderDpi' | 'requestedRenderDpi'>> {
    matchedCanvasOpticalContentLeftPx: number | null;
    matchedCanvasOpticalContentRightPx: number | null;
    /** What the engine wrote: always a resolved mode. */
    outputMode?: TScanCleanupOutputMode;
    splitAbstained?: boolean;
    dewarpApplied?: boolean;
}

export interface IScanCleanupPreviewOutput {
    imageData: Uint8Array;
    metadata: IScanCleanupPreviewMetadata;
}

interface IScanCleanupPreviewWire {
    canceled?: undefined;
    requestId?: TRequestId;
    pageNumber: TPageNumber;
    totalPages: number;
    rawImageData?: Uint8Array;
    rawWidthPx: number;
    rawHeightPx: number;
    outputs: IScanCleanupPreviewOutput[];
    pageMetadata: IScanCleanupPreviewPageMetadata;
}
export type TScanCleanupPreviewWireResult = {canceled: true} | IScanCleanupPreviewWire;
export type IScanCleanupPreviewResult = Omit<IScanCleanupPreviewWire, 'rawImageData'> & {rawImageData: Uint8Array};

export type IScanCleanupDetectionRequest = v.InferOutput<typeof SCAN_CLEANUP_DETECTION_REQUEST_SCHEMA>;

/**
 * Immutable source geometry measured once when detection opens the document.
 * Preview and final rendering share it over the typed bridge instead of each
 * reopening a hundreds-page PDF to rediscover the same page boxes and raster
 * resolution.
 */
export type IScanCleanupSourcePageMetadata = v.InferOutput<typeof SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA>;

/**
 * Automatic geometry already measured by a base preview under the exact
 * document/settings cache key used to start a final run. Coordinates are
 * clipped to the output half but normalized against the full rotated input, so
 * the same plan can be replayed at the source raster's final DPI without
 * treating it as a user-authored override.
 */
export type IScanCleanupPagePlanEvidence = v.InferOutput<typeof SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA>;

/**
 * Bounded document-wide calibration for `ink` placement. The detection
 * result store keeps the page-local evidence, while this summary carries the
 * calibration needed by a streaming conversion without rebuilding a page map
 * in the renderer or across IPC.
 */
export type IScanCleanupPlacementAnchorSummary = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA>;
export type IScanCleanupPlacementAnchorSummaryCluster = IScanCleanupPlacementAnchorSummary['clusters'][number];
export type IScanCleanupPlacementAnchorSummaryIdentity = IScanCleanupPlacementAnchorSummary['identity'];
export type IScanCleanupPlacementAnchorCalibrationRequest = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_REQUEST_SCHEMA>;

export interface IScanCleanupPlacementAnchorCalibration {
    summary: IScanCleanupPlacementAnchorSummary;
    placementAnchors: v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA>;
}

export interface IScanCleanupDetectionResult {
    pageNumber: TPageNumber;
    revision?: number;
    classification: TScanCleanupLayoutClassification;
    confidence: number;
    cutterXPx: number | null;
    tier1Verdict: TScanCleanupLayoutClassification;
    reconciled: boolean;
    clusterAgreement: number;
    documentPrior: IScanCleanupDocumentPrior | null;
    textAxis?: TextAxisHint;
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
    softAlphaForegroundRecommendation?: boolean;
    outputModeDiagnostics?: OutputModeDiagnostics;
    sourcePageMetadata?: IScanCleanupSourcePageMetadata;
    pagePlanEvidence?: IScanCleanupPagePlanEvidence;
    splitDiagnostics?: SplitDiagnostics;
}

/** Why a job failed, in a form the renderer localizes. */
interface IScanCleanupJobFailure {
    error: string;
    errorCode: TScanCleanupErrorCode;
    scratchShortfall?: IScanCleanupScratchShortfall;
}

export type TScanCleanupDetectionJobState = {
    jobId: TJobId;
    documentCanvasSignature?: string;
    progress: TScanCleanupProgress;
    resultCount?: number;
    /** Final pages recommended as blank, counted over every result, not the window. */
    blankPageCount?: number;
    detectionResultStoreId?: string;
    placementAnchorSummary?: IScanCleanupPlacementAnchorSummary;
    results: IScanCleanupDetectionResult[];
    updatedAtMs: TEpochMs;
} & ({status: 'queued' | 'running' | 'canceling' | 'completed' | 'canceled'} | ({status: 'failed'} & IScanCleanupJobFailure));
export type TScanCleanupDetectionStartResult =
    | {started: true; jobId: TJobId}
    | ({started: false; jobId: TJobId} & IScanCleanupJobFailure);

export type IScanCleanupStartRequest = v.InferOutput<typeof SCAN_CLEANUP_START_REQUEST_SCHEMA>;

const summaryPageNumber = v.message(v.pipe(
    v.number(),
    v.finite(),
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER),
    v.transform(value => requirePageNumber(value)),
), 'invalid scan-cleanup summary');
const summaryCount = v.message(v.pipe(
    v.number(),
    v.finite(),
    v.integer(),
    v.minValue(0),
    v.check((value: number) => Number.isSafeInteger(value)),
), 'invalid scan-cleanup summary');
/**
 * One SC-IMP-003 condition a run reported, with the output it belongs to.
 *
 * `warnings` carries the same conditions as the sentences the user reads, and a
 * consumer that has to know *which* condition a run raised would otherwise have
 * to read English back. The page and half are the run's own attribution, so a
 * per-output condition stays attached to its output across the boundary; a
 * document-wide condition carries neither.
 */
export const SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA = v.object({
    event: SCAN_CLEANUP_WARNING_EVENT_SCHEMA,
    pageNumber: v.optional(summaryPageNumber),
    half: v.optional(v.picklist([
        'full',
        'left',
        'right',
    ] as const)),
});

export type TScanCleanupSummaryWarningEvent = v.InferOutput<typeof SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA>;

/** Positively observed source text omitted by unsafe output geometry. */
const SCAN_CLEANUP_SOURCE_TEXT_OMISSION_SCHEMA = v.pipe(v.object({
    count: v.pipe(summaryCount, v.minValue(1)),
    /** First source pages only; count includes every affected source page. */
    pages: v.pipe(v.array(summaryPageNumber), v.minLength(1), v.maxLength(20)),
}), v.check(value => value.pages.length === Math.min(value.count, 20)
    && value.pages.every((page, index) => index === 0 || page > value.pages[index - 1]!),
'invalid scan-cleanup source text omission'));

export const SCAN_CLEANUP_SUMMARY_SCHEMA = v.object({
    inputPages: summaryCount,
    outputPages: summaryCount,
    spreadsSplit: summaryCount,
    offcutsDiscarded: summaryCount,
    deskewSkipped: summaryCount,
    cropSkipped: summaryCount,
    excludedPages: summaryCount,
    blankPagesSkipped: summaryCount,
    sourceTextOmission: v.optional(SCAN_CLEANUP_SOURCE_TEXT_OMISSION_SCHEMA),
    /** The source structure tree could not safely survive this cleanup. */
    accessibilityTagsRemoved: v.optional(v.boolean()),
    /** Compact source layers desktop would reuse were rebuilt from the page raster. */
    sourceLayersReconstructed: v.optional(v.boolean()),
    warnings: v.array(v.string()),
    /**
     * Optional so a summary written before this channel existed still decodes:
     * such a run reported its conditions as sentences and has no typed list to
     * offer. A live run always publishes one.
     */
    warningEvents: v.optional(v.array(SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA)),
});
export type TScanCleanupSummary = v.InferOutput<typeof SCAN_CLEANUP_SUMMARY_SCHEMA>;

export type TScanCleanupJobState = {
    jobId: TJobId;
    progress: TScanCleanupProgress;
    updatedAtMs: TEpochMs;
} & (
    | {status: 'queued' | 'running' | 'canceling' | 'handoff' | 'committing' | 'canceled'}
    | {
        status: 'completed';
        outputPdfPath: string;
        summary: TScanCleanupSummary;
        partial: boolean;
    }
    | ({
        status: 'failed';
        failure?: FailureReceipt;
    } & IScanCleanupJobFailure)
);
export type TScanCleanupStartResult =
    | {started: true; jobId: TJobId; outputPdfPath: string}
    | ({started: false; jobId: TJobId} & IScanCleanupJobFailure);
