import type {IAnnotationMarkerRect} from '@app/types/annotations';
import {clamp} from 'es-toolkit/math';

export interface IMarkerRectBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface INormalizeMarkerRectBoundsOptions {
    clampSizeToRemaining?: boolean;
}

export function orderPdfRectBounds(x1: number, y1: number, x2: number, y2: number) {
    return {
        minX: Math.min(x1, x2),
        maxX: Math.max(x1, x2),
        minY: Math.min(y1, y2),
        maxY: Math.max(y1, y2),
    };
}

export function normalizeMarkerRectBounds(
    bounds: IMarkerRectBounds,
    options: INormalizeMarkerRectBoundsOptions = {},
): IAnnotationMarkerRect | null {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }

    const left = clamp(bounds.left, 0, 1);
    const top = clamp(bounds.top, 0, 1);
    const maxWidth = options.clampSizeToRemaining ? 1 - left : 1;
    const maxHeight = options.clampSizeToRemaining ? 1 - top : 1;

    return {
        left,
        top,
        width: clamp(width, 0, maxWidth),
        height: clamp(height, 0, maxHeight),
    };
}
