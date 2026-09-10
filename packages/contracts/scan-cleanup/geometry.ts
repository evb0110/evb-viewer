export type TScanCleanupPageRotation = 0 | 90 | 180 | 270;

/** A vertical cutter authored in normalized rotated-analysis-page space. */
export interface IScanCleanupNormalizedSplit {
    xNormalized: number;
    rotationDegrees: TScanCleanupPageRotation;
}

/**
 * A rectangle with an output-half-local origin whose axes and scale are the
 * complete rotated analysis page.
 */
export interface IScanCleanupNormalizedRect {
    xNormalized: number;
    yNormalized: number;
    widthNormalized: number;
    heightNormalized: number;
    rotationDegrees: TScanCleanupPageRotation;
}

export interface IScanCleanupPixelRect {
    xPx: number;
    yPx: number;
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupPixelPoint {
    x: number;
    y: number;
}

export interface IScanCleanupPixelPolygon {points: IScanCleanupPixelPoint[]}

/** Diagnostic curved gutter geometry; straight cutter geometry remains authoritative for rendering. */
export interface IScanCleanupSplitSeamPolyline {points: IScanCleanupPixelPoint[]}

export interface IScanCleanupAppliedMargins {
    leftPx: number;
    topPx: number;
    rightPx: number;
    bottomPx: number;
}

export interface IScanCleanupMarginsMm {
    leftMm: number;
    topMm: number;
    rightMm: number;
    bottomMm: number;
}

/** Shared ceiling for every hard-margin editor, codec, and clamp. */
export const SCAN_CLEANUP_MARGIN_MAX_MM = 25;

export interface IScanCleanupPreviewAffine {matrix: number[][];}

/** Manual cutters stay inside this interval so both output leaves remain usable. */
export const SCAN_CLEANUP_MANUAL_SPLIT_MIN = 0.02;
export const SCAN_CLEANUP_MANUAL_SPLIT_MAX = 0.98;
