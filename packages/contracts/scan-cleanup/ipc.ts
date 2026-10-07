import { requirePageNumber } from '@contracts/pageNumbers';

import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {SERIALIZABLE_ERROR_ENVELOPE_SCHEMA} from '@contracts/serializableError';
import type {
    TScanCleanupBinarizationMethod,
    TScanCleanupContentTrimSide,
    TScanCleanupOutputHalf,
    TScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/domain';
import type {IScanCleanupPixelRect} from '@contracts/scan-cleanup/geometry';
import {
    SCAN_CLEANUP_WARNING_EVENT_SCHEMA,
    type INativeScanCleanupBinarizationDiagnosticsV3,
    type INativeScanCleanupTextToneDiagnosticsV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import * as v from 'valibot';
import type {
    SCAN_CLEANUP_OWNER_CONTEXT_SCHEMA,
    SCAN_CLEANUP_PREVIEW_REQUEST_SCHEMA,
    SCAN_CLEANUP_PREVIEW_CANCEL_REQUEST_SCHEMA,
    SCAN_CLEANUP_DETECTION_REQUEST_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_REQUEST_SCHEMA,
    SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA,
    SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA,
    SCAN_CLEANUP_START_REQUEST_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import type {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/decodeScanCleanupPlacementAnchorSummary';
import type {
    SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA,
    SCAN_CLEANUP_DETECTION_RESULT_SCHEMA,
    SCAN_CLEANUP_DETECTION_START_RESULT_SCHEMA,
    SCAN_CLEANUP_JOB_STATE_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_SCHEMA,
    SCAN_CLEANUP_PREVIEW_METADATA_SCHEMA,
    SCAN_CLEANUP_PREVIEW_PAGE_METADATA_SCHEMA,
    SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA,
    SCAN_CLEANUP_RAW_PREVIEW_EVENT_SCHEMA,
    SCAN_CLEANUP_START_RESULT_SCHEMA,
} from '@contracts/scan-cleanup/ipcResultCodecs';
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

export type IScanCleanupRawPreviewEvent = v.InferOutput<typeof SCAN_CLEANUP_RAW_PREVIEW_EVENT_SCHEMA>;
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
    textToneDiagnostics?: IScanCleanupTextToneDiagnostics;
}

export type IScanCleanupPreviewMetadata = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_METADATA_SCHEMA>;
export type IScanCleanupPreviewPageMetadata = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_PAGE_METADATA_SCHEMA>;
export type IScanCleanupPreviewOutput = Extract<
    v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA>,
    {pageMetadata: unknown}
>['outputs'][number];
export type TScanCleanupPreviewWireResult = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA>;
export type IScanCleanupPreviewResult = Omit<Extract<
    TScanCleanupPreviewWireResult,
    {pageMetadata: unknown}
>, 'rawImageData'> & {rawImageData: Uint8Array};

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
export type IScanCleanupPlacementAnchorSummarySample = IScanCleanupPlacementAnchorSummary['samples'][number];
export type IScanCleanupPlacementAnchorSummaryCluster = IScanCleanupPlacementAnchorSummary['clusters'][number];
export type IScanCleanupPlacementAnchorSummaryIdentity = IScanCleanupPlacementAnchorSummary['identity'];
export type IScanCleanupPlacementAnchorCalibrationRequest = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_REQUEST_SCHEMA>;

export type IScanCleanupPlacementAnchorCalibration = v.InferOutput<typeof SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_SCHEMA>;

export type IScanCleanupDetectionResult = v.InferOutput<typeof SCAN_CLEANUP_DETECTION_RESULT_SCHEMA>;
export type TScanCleanupDetectionJobState = NonNullable<v.InferOutput<typeof SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA>>;
export type TScanCleanupDetectionStartResult = v.InferOutput<typeof SCAN_CLEANUP_DETECTION_START_RESULT_SCHEMA>;

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
    warnings: v.array(v.string()),
    /**
     * Optional so a summary written before this channel existed still decodes:
     * such a run reported its conditions as sentences and has no typed list to
     * offer. A live run always publishes one.
     */
    warningEvents: v.optional(v.array(SCAN_CLEANUP_SUMMARY_WARNING_EVENT_SCHEMA)),
});
export type TScanCleanupSummary = v.InferOutput<typeof SCAN_CLEANUP_SUMMARY_SCHEMA>;

export type TScanCleanupJobState = NonNullable<v.InferOutput<typeof SCAN_CLEANUP_JOB_STATE_SCHEMA>>;
export type TScanCleanupStartResult = v.InferOutput<typeof SCAN_CLEANUP_START_RESULT_SCHEMA>;
