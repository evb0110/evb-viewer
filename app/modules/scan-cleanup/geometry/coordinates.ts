import type {
    IScanCleanupAppliedMargins,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPreviewPageMetadata,
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_MANUAL_SPLIT_MAX,
    SCAN_CLEANUP_MANUAL_SPLIT_MIN,
} from '@contracts/scan-cleanup/geometry';

export function scanCleanupAnalysisWidth(
    metadata: Pick<IScanCleanupPreviewPageMetadata, 'rotationDegrees'>,
    rawWidthPx: number,
    rawHeightPx: number,
) {
    return metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270 ? rawHeightPx : rawWidthPx;
}

export function scanCleanupCutterRatio(cutterXPx: number, analysisWidth: number) {
    return Math.min(SCAN_CLEANUP_MANUAL_SPLIT_MAX, Math.max(SCAN_CLEANUP_MANUAL_SPLIT_MIN, cutterXPx / Math.max(1, analysisWidth)));
}

export function scanCleanupCutterXFromRatio(ratio: number, analysisWidth: number) {
    return Math.min(SCAN_CLEANUP_MANUAL_SPLIT_MAX, Math.max(SCAN_CLEANUP_MANUAL_SPLIT_MIN, ratio)) * Math.max(1, analysisWidth);
}

export function resolveNormalizedManualSplitX(
    split: IScanCleanupNormalizedSplit | null | undefined,
    analysisWidth: number,
) {
    return split ? split.xNormalized * Math.max(1, analysisWidth) : null;
}

export function normalizeManualSplitX(
    cutterXPx: number,
    analysisWidth: number,
    rotationDegrees: IScanCleanupPreviewPageMetadata['rotationDegrees'],
): IScanCleanupNormalizedSplit {
    return {
        xNormalized: scanCleanupCutterRatio(cutterXPx, analysisWidth),
        rotationDegrees,
    };
}

export function resolveNormalizedContentBox(
    metadata: IScanCleanupPreviewMetadata,
    rect: IScanCleanupNormalizedRect | null | undefined,
): IScanCleanupPixelRect | null {
    if (!rect || rect.rotationDegrees !== metadata.rotationDegrees) {
        return null;
    }
    const analysisWidth = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputHeightPx
        : metadata.inputWidthPx;
    const analysisHeight = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputWidthPx
        : metadata.inputHeightPx;
    return {
        xPx: rect.xNormalized * analysisWidth,
        yPx: rect.yNormalized * analysisHeight,
        widthPx: rect.widthNormalized * analysisWidth,
        heightPx: rect.heightNormalized * analysisHeight,
    };
}

export function expandPreviewRectByMargins(
    rect: IScanCleanupPixelRect,
    margins: IScanCleanupAppliedMargins,
): IScanCleanupPixelRect {
    return {
        xPx: rect.xPx - margins.leftPx,
        yPx: rect.yPx - margins.topPx,
        widthPx: rect.widthPx + margins.leftPx + margins.rightPx,
        heightPx: rect.heightPx + margins.topPx + margins.bottomPx,
    };
}

export function normalizePreviewContentBox(
    metadata: IScanCleanupPreviewMetadata,
    rect: IScanCleanupPixelRect,
): IScanCleanupNormalizedRect {
    const analysisWidth = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputHeightPx
        : metadata.inputWidthPx;
    const analysisHeight = metadata.rotationDegrees === 90 || metadata.rotationDegrees === 270
        ? metadata.inputWidthPx
        : metadata.inputHeightPx;
    return {
        xNormalized: Math.min(1, Math.max(0, rect.xPx / Math.max(1, analysisWidth))),
        yNormalized: Math.min(1, Math.max(0, rect.yPx / Math.max(1, analysisHeight))),
        widthNormalized: Math.min(1, Math.max(0, rect.widthPx / Math.max(1, analysisWidth))),
        heightNormalized: Math.min(1, Math.max(0, rect.heightPx / Math.max(1, analysisHeight))),
        rotationDegrees: metadata.rotationDegrees,
    };
}

function applyMatrix(matrix: number[][], x: number, y: number) {
    const denominator = (matrix[2]?.[0] ?? 0) * x + (matrix[2]?.[1] ?? 0) * y + (matrix[2]?.[2] ?? 1);
    return {
        x: ((matrix[0]?.[0] ?? 1) * x + (matrix[0]?.[1] ?? 0) * y + (matrix[0]?.[2] ?? 0)) / denominator,
        y: ((matrix[1]?.[0] ?? 0) * x + (matrix[1]?.[1] ?? 1) * y + (matrix[1]?.[2] ?? 0)) / denominator,
    };
}

function invertAffineMatrix(matrix: number[][]) {
    const a = matrix[0]?.[0] ?? 1;
    const b = matrix[0]?.[1] ?? 0;
    const c = matrix[0]?.[2] ?? 0;
    const d = matrix[1]?.[0] ?? 0;
    const e = matrix[1]?.[1] ?? 1;
    const f = matrix[1]?.[2] ?? 0;
    const determinant = a * e - b * d;
    if (Math.abs(determinant) < Number.EPSILON) {
        return null;
    }
    return [
        [
            e / determinant,
            -b / determinant,
            (b * f - e * c) / determinant,
        ],
        [
            -d / determinant,
            a / determinant,
            (d * c - a * f) / determinant,
        ],
        [
            0,
            0,
            1,
        ],
    ];
}

export function clampPreviewRect(rect: IScanCleanupPixelRect, width: number, height: number): IScanCleanupPixelRect {
    const left = Math.max(0, Math.min(width, rect.xPx));
    const top = Math.max(0, Math.min(height, rect.yPx));
    const right = Math.max(left, Math.min(width, rect.xPx + rect.widthPx));
    const bottom = Math.max(top, Math.min(height, rect.yPx + rect.heightPx));
    return {
        xPx: left,
        yPx: top,
        widthPx: right - left,
        heightPx: bottom - top,
    };
}

export function transformPreviewContentBox(metadata: IScanCleanupPreviewMetadata) {
    return transformPreviewSourceHalfRect(metadata, metadata.contentBox);
}

export function transformPreviewSourceHalfRectUnclamped(
    metadata: IScanCleanupPreviewMetadata,
    rect: IScanCleanupPixelRect | null | undefined,
) {
    const matrix = metadata.forwardTransform?.matrix;
    if (!rect || !matrix || matrix.length !== 3) {
        return null;
    }
    const x = rect.xPx + metadata.sourceRegion.xPx;
    const y = rect.yPx + metadata.sourceRegion.yPx;
    const corners = [
        applyMatrix(matrix, x, y),
        applyMatrix(matrix, x + rect.widthPx, y),
        applyMatrix(matrix, x, y + rect.heightPx),
        applyMatrix(matrix, x + rect.widthPx, y + rect.heightPx),
    ];
    const xs = corners.map(point => point.x);
    const ys = corners.map(point => point.y);
    return {
        xPx: Math.min(...xs),
        yPx: Math.min(...ys),
        widthPx: Math.max(...xs) - Math.min(...xs),
        heightPx: Math.max(...ys) - Math.min(...ys),
    };
}

export function transformPreviewSourceHalfRect(
    metadata: IScanCleanupPreviewMetadata,
    rect: IScanCleanupPixelRect | null | undefined,
) {
    const transformed = transformPreviewSourceHalfRectUnclamped(metadata, rect);
    return transformed
        ? clampPreviewRect(transformed, metadata.outputWidthPx, metadata.outputHeightPx)
        : null;
}

export interface IScanCleanupPreviewContentBoxContainment {
    contained: boolean;
    containment: number;
    edgeOverrunPx: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    };
}

export function measurePreviewContentBoxContainment(
    metadata: IScanCleanupPreviewMetadata,
): IScanCleanupPreviewContentBoxContainment | null {
    const rect = transformPreviewSourceHalfRectUnclamped(metadata, metadata.contentBox);
    if (!rect || rect.widthPx <= 0 || rect.heightPx <= 0) {
        return null;
    }
    const left = Math.max(0, rect.xPx);
    const top = Math.max(0, rect.yPx);
    const right = Math.min(metadata.outputWidthPx, rect.xPx + rect.widthPx);
    const bottom = Math.min(metadata.outputHeightPx, rect.yPx + rect.heightPx);
    const intersectionArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    const edgeOverrunPx = {
        left: Math.max(0, -rect.xPx),
        top: Math.max(0, -rect.yPx),
        right: Math.max(0, rect.xPx + rect.widthPx - metadata.outputWidthPx),
        bottom: Math.max(0, rect.yPx + rect.heightPx - metadata.outputHeightPx),
    };
    const epsilon = 1e-6;
    return {
        contained: Object.values(edgeOverrunPx).every(overrun => overrun <= epsilon),
        containment: Math.min(1, intersectionArea / (rect.widthPx * rect.heightPx)),
        edgeOverrunPx,
    };
}

export function previewPointToSourceHalf(
    metadata: IScanCleanupPreviewMetadata,
    point: {
        x: number;
        y: number
    },
) {
    const matrix = metadata.forwardTransform?.matrix;
    const inverse = matrix ? invertAffineMatrix(matrix) : null;
    if (!inverse) {
        return null;
    }
    const source = applyMatrix(inverse, point.x, point.y);
    return {
        x: source.x - metadata.sourceRegion.xPx,
        y: source.y - metadata.sourceRegion.yPx,
    };
}

export function unrotatePreviewRect(
    rect: IScanCleanupPixelRect,
    metadata: IScanCleanupPreviewMetadata,
): IScanCleanupPixelRect {
    const points = [
        {
            x: rect.xPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx,
            y: rect.yPx + rect.heightPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx + rect.heightPx,
        },
    ].map(point => {
        if (metadata.rotationDegrees === 90) {
            return {
                x: point.y,
                y: metadata.inputHeightPx - point.x,
            };
        }
        if (metadata.rotationDegrees === 180) {
            return {
                x: metadata.inputWidthPx - point.x,
                y: metadata.inputHeightPx - point.y,
            };
        }
        if (metadata.rotationDegrees === 270) {
            return {
                x: metadata.inputWidthPx - point.y,
                y: point.x,
            };
        }
        return point;
    });
    const left = Math.min(...points.map(point => point.x));
    const right = Math.max(...points.map(point => point.x));
    const top = Math.min(...points.map(point => point.y));
    const bottom = Math.max(...points.map(point => point.y));
    return {
        xPx: left,
        yPx: top,
        widthPx: right - left,
        heightPx: bottom - top,
    };
}
