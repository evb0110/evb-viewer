import type {
    AppliedMargins,
    MarginsMm,
    NormalizedRect,
    NormalizedSplit,
    Point,
    Polygon,
    PixelRect,
    SplitSeamPolyline,
} from '@contracts/scan-cleanup/nativeWire.generated';

export type {TScanCleanupPageRotation} from '@contracts/scan-cleanup/domain';

/** A vertical cutter authored in normalized rotated-analysis-page space. */
export type IScanCleanupNormalizedSplit = NormalizedSplit;

/**
 * A rectangle with an output-half-local origin whose axes and scale are the
 * complete rotated analysis page.
 */
export type IScanCleanupNormalizedRect = NormalizedRect;

/** Shared tolerance for normalized coordinates and rectangle edge sums. */
export const SCAN_CLEANUP_NORMALIZED_BOUNDS_EPSILON = 1e-9;

export type IScanCleanupPixelRect = PixelRect;
export type IScanCleanupPixelPoint = Point;
export type IScanCleanupPixelPolygon = Polygon;
/** Diagnostic curved gutter geometry; straight cutter geometry remains authoritative for rendering. */
export type IScanCleanupSplitSeamPolyline = SplitSeamPolyline;
export type IScanCleanupAppliedMargins = AppliedMargins;
export type IScanCleanupMarginsMm = MarginsMm;

/** Shared ceiling for every hard-margin editor, codec, and clamp. */
export const SCAN_CLEANUP_MARGIN_MAX_MM = 25;

export interface IScanCleanupPreviewAffine {matrix: number[][];}

/** Manual cutters stay inside this interval so both output leaves remain usable. */
export const SCAN_CLEANUP_MANUAL_SPLIT_MIN = 0.02;
export const SCAN_CLEANUP_MANUAL_SPLIT_MAX = 0.98;
