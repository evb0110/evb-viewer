import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

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

export interface IDefaultTextBoxRectOptions {
    readonly pageView?: readonly number[] | null | undefined;
    readonly pageRotation?: TPageRotation | undefined;
    readonly fontSize?: number | undefined;
}

const DEFAULT_TEXT_BOX_FONT_SIZE = 14;
const DEFAULT_TEXT_BOX_WIDTH_EM = 2;
const DEFAULT_TEXT_BOX_HEIGHT_EM = 1.65;
const FALLBACK_PAGE_WIDTH = 612;
const FALLBACK_PAGE_HEIGHT = 792;

function pageDimensions(
    pageView: readonly number[] | null | undefined,
    pageRotation: TPageRotation,
) {
    const xMin = pageView?.[0] ?? 0;
    const yMin = pageView?.[1] ?? 0;
    const xMax = pageView?.[2] ?? FALLBACK_PAGE_WIDTH;
    const yMax = pageView?.[3] ?? FALLBACK_PAGE_HEIGHT;
    const width = xMax - xMin;
    const height = yMax - yMin;
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        return {
            width: FALLBACK_PAGE_WIDTH,
            height: FALLBACK_PAGE_HEIGHT,
        };
    }
    return pageRotation === 90 || pageRotation === 270
        ? {
            width: height,
            height: width,
        }
        : {
            width,
            height,
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
    options: IDefaultTextBoxRectOptions = {},
): IAnnotationMarkerRect {
    const fontSize = Math.max(1, finiteOr(options.fontSize ?? DEFAULT_TEXT_BOX_FONT_SIZE, DEFAULT_TEXT_BOX_FONT_SIZE));
    const page = pageDimensions(options.pageView, options.pageRotation ?? 0);
    const safeWidth = clamp(fontSize * DEFAULT_TEXT_BOX_WIDTH_EM / page.width, 0, 1);
    const safeHeight = clamp(fontSize * DEFAULT_TEXT_BOX_HEIGHT_EM / page.height, 0, 1);
    const nextPoint = clampPoint(point);
    return {
        left: clamp(nextPoint.x, 0, 1 - safeWidth),
        top: clamp(nextPoint.y, 0, 1 - safeHeight),
        width: safeWidth,
        height: safeHeight,
    };
}

export function expandTextBoxRectToContentSize(
    rect: IAnnotationMarkerRect,
    contentWidth: number,
    contentHeight: number,
): IAnnotationMarkerRect {
    const normalized = normalizeRect(rect);
    const width = clamp(
        Math.max(normalized.width, finiteOr(contentWidth, normalized.width)),
        0,
        Math.max(0, 1 - normalized.left),
    );
    const height = clamp(Math.max(normalized.height, finiteOr(contentHeight, normalized.height)), 0, 1);
    return {
        ...normalized,
        left: normalized.left,
        top: clamp(normalized.top, 0, Math.max(0, 1 - height)),
        width,
        height,
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
