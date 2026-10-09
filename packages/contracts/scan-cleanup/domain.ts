import * as v from 'valibot';
import type {
    SCAN_CLEANUP_LAYOUT_BY_PAGE_SCHEMA,
    SCAN_CLEANUP_OPTIONS_SCHEMA,
    SCAN_CLEANUP_PAGE_OVERRIDE_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';

export const SCAN_CLEANUP_PAGE_ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;
export type TScanCleanupPageRotation = typeof SCAN_CLEANUP_PAGE_ROTATIONS[number];

export const SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS = [
    'single-uncut-page',
    'page-with-offcut',
    'two-page-spread',
] as const;
export type TScanCleanupLayoutClassification = typeof SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS[number];

const safeFiniteNumber = v.pipe(
    v.number(),
    v.finite(),
    v.check(value => Math.abs(value) <= Number.MAX_SAFE_INTEGER),
);
const positiveFiniteNumber = v.pipe(safeFiniteNumber, v.minValue(Number.MIN_VALUE));

export const SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA = v.message(v.pipe(v.strictObject({
    dominantLayout: v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS),
    cutterRatioMedian: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0.2), v.maxValue(0.8))),
    clusterDims: v.strictObject({
        widthPx: positiveFiniteNumber,
        heightPx: positiveFiniteNumber,
    }),
    agreementStrength: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
    strokeWidthMedianPx: v.optional(positiveFiniteNumber),
    xHeightMedianPx: v.optional(positiveFiniteNumber),
}), v.check(value =>
    value.dominantLayout !== 'two-page-spread' || value.cutterRatioMedian !== null,
)), 'invalid scan-cleanup document prior');

export type IScanCleanupDocumentPrior = v.InferOutput<typeof SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA>;

export const SCAN_CLEANUP_LAYOUT_MODES = [
    'auto',
    'force-single',
    'force-two-page',
] as const;
export type TScanCleanupLayoutMode = typeof SCAN_CLEANUP_LAYOUT_MODES[number];

export const SCAN_CLEANUP_OUTPUT_MODES = [
    'bw',
    'mixed',
    'grayscale',
    'color',
] as const;
export type TScanCleanupOutputMode = typeof SCAN_CLEANUP_OUTPUT_MODES[number];

export const SCAN_CLEANUP_OUTPUT_MODE_SETTINGS = [
    'auto',
    ...SCAN_CLEANUP_OUTPUT_MODES,
] as const;
export type TScanCleanupOutputModeSetting = typeof SCAN_CLEANUP_OUTPUT_MODE_SETTINGS[number];

export const SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS = [
    'blank',
    'color-chroma',
    'text-with-pictures',
    'continuous-tone',
    'bimodal-text',
    'uncertain-tonal',
] as const;
export type TScanCleanupOutputModeRecommendationReason =
    typeof SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS[number];

export const SCAN_CLEANUP_BINARIZATION_METHODS = [
    'auto',
    'otsu',
    'sauvola',
    'wolf',
] as const;
export type TScanCleanupBinarizationMethod = typeof SCAN_CLEANUP_BINARIZATION_METHODS[number];

export const SCAN_CLEANUP_DESPECKLE_LEVELS = [
    'off',
    'cautious',
    'normal',
    'aggressive',
] as const;
export type TScanCleanupDespeckleLevel = typeof SCAN_CLEANUP_DESPECKLE_LEVELS[number];

export const SCAN_CLEANUP_READING_ORDERS = [
    'ltr',
    'rtl',
] as const;
export type TScanCleanupReadingOrder = typeof SCAN_CLEANUP_READING_ORDERS[number];

export const SCAN_CLEANUP_PAGE_LAYOUT_OVERRIDES = [
    'auto',
    'single',
    'spread',
    'keep-left',
    'keep-right',
] as const;
export type TScanCleanupPageLayoutOverride = typeof SCAN_CLEANUP_PAGE_LAYOUT_OVERRIDES[number];

export const SCAN_CLEANUP_OUTPUT_HALVES = [
    'full',
    'left',
    'right',
] as const;
export type TScanCleanupOutputHalf = typeof SCAN_CLEANUP_OUTPUT_HALVES[number];

export const SCAN_CLEANUP_CANVAS_SCOPES = [
    'page',
    'document',
] as const;
export type TScanCleanupCanvasScope = typeof SCAN_CLEANUP_CANVAS_SCOPES[number];

export const SCAN_CLEANUP_CANVAS_POLICIES = [
    'intrinsic',
    'strict-maximum',
] as const;
export type TScanCleanupCanvasPolicy = typeof SCAN_CLEANUP_CANVAS_POLICIES[number];

export const SCAN_CLEANUP_TEXT_TONE_RULES = [
    'applied',
    'picture-evidence',
    'insufficient-text',
    'tonal-mass-outside-text',
    'already-dark',
] as const;
export type TScanCleanupTextToneRule = typeof SCAN_CLEANUP_TEXT_TONE_RULES[number];

export const SCAN_CLEANUP_CONTENT_TRIM_SIDES = [
    'left',
    'top',
    'right',
    'bottom',
] as const;
export type TScanCleanupContentTrimSide = typeof SCAN_CLEANUP_CONTENT_TRIM_SIDES[number];

export const SCAN_CLEANUP_PICTURE_ZONE_LAYERS = [
    'eraser1',
    'painter2',
    'eraser3',
] as const;
export const SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS = [
    'sharedJoint',
    'perLeafAnchorDrift',
    'perLeafRadiusDrift',
    'perLeafFaintInkDrift',
] as const;
export type TScanCleanupSpreadBinarizationDecision = typeof SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS[number];
/**
 * The single source of truth every alignment validator, migration and picker
 * reads. `ink` is not a nine-way anchor: it asks each output to keep its
 * content where the source ink was, snapped across pages that agree.
 */
export const SCAN_CLEANUP_ALIGNMENTS = [
    'ink',
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
] as const;
export type TScanCleanupPageAlignment = typeof SCAN_CLEANUP_ALIGNMENTS[number];
export type TScanCleanupPictureZoneLayer = typeof SCAN_CLEANUP_PICTURE_ZONE_LAYERS[number];

/**
 * What the renderer already knows about how each page will be cut, keyed by
 * page number. Matched page size is measured over the pages a run *produces*,
 * so a spread that becomes two half-sheet pages has to be measured as such, and
 * the only place that knows a page is a spread before it is rendered is the
 * detection the user has already watched run. Passing it to the preview and to
 * the run alike is what makes the two agree on one rectangle.
 */
export type TScanCleanupLayoutByPage = v.InferOutput<typeof SCAN_CLEANUP_LAYOUT_BY_PAGE_SCHEMA>;
export type TScanCleanupPageOutputMapping = Readonly<Record<string, readonly number[]>>;

export const SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES = -15;
export const SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES = 15;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN = 0.5;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX = 4;

export interface IScanCleanupClusterDimensions {
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupReconciliationMetadata {
    tier1Verdict: TScanCleanupLayoutClassification;
    reconciled: boolean;
    /** Positive when the page agrees with its cluster, negative when it remains in disagreement. */
    clusterAgreement: number;
}

export interface IScanCleanupTextAxis {
    sideways: boolean;
    confidence: number;
}

export type IScanCleanupPageOverride = v.InferOutput<typeof SCAN_CLEANUP_PAGE_OVERRIDE_SCHEMA>;

export interface IScanCleanupNormalizedZonePoint {
    xNormalized: number;
    yNormalized: number;
}

/** A polygon authored in normalized rotated-page coordinates. */
export interface IScanCleanupNormalizedZonePolygon {
    points: IScanCleanupNormalizedZonePoint[];
    rotationDegrees: TScanCleanupPageRotation;
}

export interface IScanCleanupPictureZone {
    polygon: IScanCleanupNormalizedZonePolygon;
    layer: TScanCleanupPictureZoneLayer;
}

/** Picture layers apply in eraser1 → painter2 → eraser3 order; fill is binary. */
export interface IScanCleanupManualZones {
    picture: IScanCleanupPictureZone[];
    fill: IScanCleanupNormalizedZonePolygon[];
}

export type TScanCleanupPageOverrides = Record<string, IScanCleanupPageOverride>;

/** Stable renderer/Electron options. Experimental native policy is Electron-internal. */
export type IScanCleanupOptions = v.InferOutput<typeof SCAN_CLEANUP_OPTIONS_SCHEMA>;
