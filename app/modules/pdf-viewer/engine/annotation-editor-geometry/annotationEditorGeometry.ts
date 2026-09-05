import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';

export type TAnnotationResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface IAnnotationEditorPoint {
    x: number;
    y: number;
}

function finiteOr(value: number, fallback: number) {
    return Number.isFinite(value) ? value : fallback;
}

function normalizeRect(rect: IAnnotationMarkerRect): IAnnotationMarkerRect {
    const left = clamp(finiteOr(rect.left, 0), 0, 1);
    const top = clamp(finiteOr(rect.top, 0), 0, 1);
    return {
        left,
        top,
        width: clamp(finiteOr(rect.width, 0), 0, 1 - left),
        height: clamp(finiteOr(rect.height, 0), 0, 1 - top),
    };
}

function safeMinimum(minSize: number) {
    return clamp(finiteOr(minSize, 0.01), 0, 1);
}

function clampPoint(point: IAnnotationEditorPoint): IAnnotationEditorPoint {
    return {
        x: clamp(finiteOr(point.x, 0), 0, 1),
        y: clamp(finiteOr(point.y, 0), 0, 1),
    };
}

function rectFromEdges(left: number, top: number, right: number, bottom: number): IAnnotationMarkerRect {
    return {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
}

export function moveAnnotationRect(
    rect: IAnnotationMarkerRect,
    deltaX: number,
    deltaY: number,
): IAnnotationMarkerRect {
    const normalized = normalizeRect(rect);
    const left = clamp(
        normalized.left + finiteOr(deltaX, 0),
        0,
        Math.max(0, 1 - normalized.width),
    );
    const top = clamp(
        normalized.top + finiteOr(deltaY, 0),
        0,
        Math.max(0, 1 - normalized.height),
    );
    return {
        ...normalized,
        left,
        top,
    };
}

export function applyAnnotationHandleResize(
    rect: IAnnotationMarkerRect,
    handle: TAnnotationResizeHandle,
    point: IAnnotationEditorPoint,
    minSize = 0.01,
): IAnnotationMarkerRect {
    const normalized = normalizeRect(rect);
    const minimum = safeMinimum(minSize);
    const nextPoint = clampPoint(point);
    const right = normalized.left + normalized.width;
    const bottom = normalized.top + normalized.height;
    let left = normalized.left;
    let top = normalized.top;
    let nextRight = right;
    let nextBottom = bottom;

    if (handle.includes('w')) {
        left = clamp(nextPoint.x, 0, Math.max(0, right - minimum));
    } else if (handle.includes('e')) {
        nextRight = clamp(nextPoint.x, Math.min(1, left + minimum), 1);
    }
    if (handle.includes('n')) {
        top = clamp(nextPoint.y, 0, Math.max(0, bottom - minimum));
    } else if (handle.includes('s')) {
        nextBottom = clamp(nextPoint.y, Math.min(1, top + minimum), 1);
    }

    return rectFromEdges(left, top, nextRight, nextBottom);
}

function createAxisBounds(start: number, end: number, minimum: number) {
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    if (high - low >= minimum) {
        return {
            low,
            high,
        };
    }
    if (start <= end) {
        const nextLow = clamp(start, 0, Math.max(0, 1 - minimum));
        return {
            low: nextLow,
            high: nextLow + minimum,
        };
    }
    const nextHigh = clamp(end, minimum, 1);
    return {
        low: nextHigh - minimum,
        high: nextHigh,
    };
}

export function createAnnotationRectFromPoints(
    start: IAnnotationEditorPoint,
    end: IAnnotationEditorPoint,
    minSize = 0.01,
): IAnnotationMarkerRect {
    const minimum = safeMinimum(minSize);
    const first = clampPoint(start);
    const second = clampPoint(end);
    const x = createAxisBounds(first.x, second.x, minimum);
    const y = createAxisBounds(first.y, second.y, minimum);
    return rectFromEdges(x.low, y.low, x.high, y.high);
}

export function createDefaultTextBoxRect(
    point: IAnnotationEditorPoint,
    width = 0.28,
    height = 0.1,
): IAnnotationMarkerRect {
    const safeWidth = clamp(finiteOr(width, 0.28), 0, 1);
    const safeHeight = clamp(finiteOr(height, 0.1), 0, 1);
    const nextPoint = clampPoint(point);
    return {
        left: clamp(nextPoint.x - safeWidth / 2, 0, 1 - safeWidth),
        top: clamp(nextPoint.y - safeHeight / 2, 0, 1 - safeHeight),
        width: safeWidth,
        height: safeHeight,
    };
}

export function annotationRectsEqual(
    left: IAnnotationMarkerRect,
    right: IAnnotationMarkerRect,
) {
    return left.left === right.left
        && left.top === right.top
        && left.width === right.width
        && left.height === right.height;
}

export function annotationRectContainsPoint(
    rect: IAnnotationMarkerRect,
    point: IAnnotationEditorPoint,
) {
    const normalized = normalizeRect(rect);
    return Number.isFinite(point.x)
        && Number.isFinite(point.y)
        && point.x >= normalized.left
        && point.x <= normalized.left + normalized.width
        && point.y >= normalized.top
        && point.y <= normalized.top + normalized.height;
}
