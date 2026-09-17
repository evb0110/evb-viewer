import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
} from '@contracts/scan-cleanup/geometry';

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
    'perLeafRouteMismatch',
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
export type TScanCleanupLayoutByPage = Partial<Record<string, TScanCleanupLayoutClassification>>;
export type TScanCleanupPageOutputMapping = Readonly<Record<string, readonly number[]>>;

export const SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES = -15;
export const SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES = 15;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN = 0.5;
export const SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX = 4;

export interface IScanCleanupClusterDimensions {
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupDocumentPrior {
    dominantLayout: TScanCleanupLayoutClassification;
    cutterRatioMedian: number | null;
    clusterDims: IScanCleanupClusterDimensions;
    agreementStrength: number;
    /** Optional robust body-text calibration carried by the native planner. */
    strokeWidthMedianPx?: number;
    xHeightMedianPx?: number;
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

export interface IScanCleanupPageOverride {
    rotationDegrees: TScanCleanupPageRotation;
    layoutOverride: TScanCleanupPageLayoutOverride;
    excluded: boolean;
    manualSplit: IScanCleanupNormalizedSplit | null;
    manualSkewDegrees?: number | undefined;
    outputModeOverride?: TScanCleanupOutputMode;
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones;
    marginsMm?: IScanCleanupMarginsMm;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
}

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
export interface IScanCleanupOptions {
    preserveOriginalQuality: boolean;
    layoutMode: TScanCleanupLayoutMode;
    outputMode: TScanCleanupOutputModeSetting;
    /** Optional only for bridge compatibility with settings created before advanced output controls. */
    binarization?: TScanCleanupBinarizationMethod;
    /** Optional only for bridge compatibility with settings created before advanced output controls. */
    normalizeIllumination?: boolean;
    thickness: number;
    crop: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    marginsMm: IScanCleanupMarginsMm;
    /** Canonical speckle-removal setting. Older settings may instead provide `despeckle`. */
    despeckleLevel?: TScanCleanupDespeckleLevel;
    despeckle?: boolean;
    /** Experimental automatic page-curvature correction. */
    autoDewarp?: boolean;
    /** Fixed automatic dewarp model depth; absent means automatic depth selection. */
    autoDewarpDepth?: number | undefined;
    readingOrder: TScanCleanupReadingOrder;
    skipBlankPages: boolean;
    pageOverrides: TScanCleanupPageOverrides;
    /**
     * One document-wide page override. Pages in `pageOverrides` remain sparse
     * exceptions to this value, so applying a control to a very large document
     * does not allocate one object per page.
     */
    pageOverrideDefaults?: IScanCleanupPageOverride;
}
