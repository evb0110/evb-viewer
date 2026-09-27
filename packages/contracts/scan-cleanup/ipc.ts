import { requirePageNumber } from '@contracts/pageNumbers';

import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import type {ISerializableErrorEnvelope} from '@contracts/serializableError';
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
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
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

export const SCAN_CLEANUP_SUMMARY_SCHEMA = v.object({
    inputPages: summaryCount,
    outputPages: summaryCount,
    spreadsSplit: summaryCount,
    offcutsDiscarded: summaryCount,
    deskewSkipped: summaryCount,
    cropSkipped: summaryCount,
    excludedPages: summaryCount,
    blankPagesSkipped: summaryCount,
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
