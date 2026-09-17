import type {
    IScanCleanupNormalizedZonePoint,
    IScanCleanupNormalizedZonePolygon,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/electronApiScanCleanup';

export type TScanCleanupZoneKind = 'picture' | 'fill';
export type TScanCleanupZoneCorner = 'nw' | 'ne' | 'se' | 'sw';

export interface IScanCleanupZoneSelection {
    index: number;
    kind: TScanCleanupZoneKind;
}

export interface IScanCleanupZonePreviewFrame {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface IScanCleanupZonePreviewPoint {
    xPx: number;
    yPx: number;
}

export interface IScanCleanupZoneBounds {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
}

const DEFAULT_MINIMUM_ZONE_SIZE = 0.01;

function clampNormalized(value: number) {
    return Math.min(1, Math.max(0, value));
}

export function normalizedZonePointToPreviewPx(
    point: IScanCleanupNormalizedZonePoint,
    frame: IScanCleanupZonePreviewFrame,
): IScanCleanupZonePreviewPoint {
    return {
        xPx: frame.left + point.xNormalized * frame.width,
        yPx: frame.top + point.yNormalized * frame.height,
    };
}

export function previewPxToNormalizedZonePoint(
    point: IScanCleanupZonePreviewPoint,
    frame: IScanCleanupZonePreviewFrame,
): IScanCleanupNormalizedZonePoint {
    return {
        xNormalized: clampNormalized((point.xPx - frame.left) / Math.max(1, frame.width)),
        yNormalized: clampNormalized((point.yPx - frame.top) / Math.max(1, frame.height)),
    };
}

export function resolveScanCleanupZoneBounds(
    polygon: IScanCleanupNormalizedZonePolygon,
): IScanCleanupZoneBounds {
    const xs = polygon.points.map(point => point.xNormalized);
    const ys = polygon.points.map(point => point.yNormalized);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return {
        bottom,
        height: bottom - top,
        left,
        right,
        top,
        width: right - left,
    };
}

export function cloneScanCleanupZonePolygon(
    polygon: IScanCleanupNormalizedZonePolygon,
): IScanCleanupNormalizedZonePolygon {
    return {
        points: polygon.points.map(point => ({...point})),
        rotationDegrees: polygon.rotationDegrees,
    };
}

export function createScanCleanupRectangleZone(
    start: IScanCleanupNormalizedZonePoint,
    end: IScanCleanupNormalizedZonePoint,
    rotationDegrees: TScanCleanupPageRotation,
    minimumSize = DEFAULT_MINIMUM_ZONE_SIZE,
): IScanCleanupNormalizedZonePolygon | null {
    const left = Math.min(start.xNormalized, end.xNormalized);
    const right = Math.max(start.xNormalized, end.xNormalized);
    const top = Math.min(start.yNormalized, end.yNormalized);
    const bottom = Math.max(start.yNormalized, end.yNormalized);
    if (right - left < minimumSize || bottom - top < minimumSize) {
        return null;
    }
    return {
        points: [
            {
                xNormalized: left,
                yNormalized: top,
            },
            {
                xNormalized: right,
                yNormalized: top,
            },
            {
                xNormalized: right,
                yNormalized: bottom,
            },
            {
                xNormalized: left,
                yNormalized: bottom,
            },
        ],
        rotationDegrees,
    };
}

export function moveScanCleanupZonePolygon(
    polygon: IScanCleanupNormalizedZonePolygon,
    deltaX: number,
    deltaY: number,
): IScanCleanupNormalizedZonePolygon {
    const bounds = resolveScanCleanupZoneBounds(polygon);
    const clampedDeltaX = Math.min(1 - bounds.right, Math.max(-bounds.left, deltaX));
    const clampedDeltaY = Math.min(1 - bounds.bottom, Math.max(-bounds.top, deltaY));
    return {
        ...polygon,
        points: polygon.points.map(point => ({
            xNormalized: clampNormalized(point.xNormalized + clampedDeltaX),
            yNormalized: clampNormalized(point.yNormalized + clampedDeltaY),
        })),
    };
}

export function resizeScanCleanupZonePolygon(
    polygon: IScanCleanupNormalizedZonePolygon,
    corner: TScanCleanupZoneCorner,
    target: IScanCleanupNormalizedZonePoint,
    minimumSize = DEFAULT_MINIMUM_ZONE_SIZE,
): IScanCleanupNormalizedZonePolygon {
    const bounds = resolveScanCleanupZoneBounds(polygon);
    let left = bounds.left;
    let right = bounds.right;
    let top = bounds.top;
    let bottom = bounds.bottom;
    const x = clampNormalized(target.xNormalized);
    const y = clampNormalized(target.yNormalized);

    if (corner.includes('w')) left = Math.min(right - minimumSize, x);
    if (corner.includes('e')) right = Math.max(left + minimumSize, x);
    if (corner.includes('n')) top = Math.min(bottom - minimumSize, y);
    if (corner.includes('s')) bottom = Math.max(top + minimumSize, y);
    left = clampNormalized(left);
    right = clampNormalized(right);
    top = clampNormalized(top);
    bottom = clampNormalized(bottom);

    const sourceWidth = Math.max(Number.EPSILON, bounds.width);
    const sourceHeight = Math.max(Number.EPSILON, bounds.height);
    return {
        ...polygon,
        points: polygon.points.map(point => ({
            xNormalized: clampNormalized(left
                + (point.xNormalized - bounds.left) / sourceWidth * (right - left)),
            yNormalized: clampNormalized(top
                + (point.yNormalized - bounds.top) / sourceHeight * (bottom - top)),
        })),
    };
}
