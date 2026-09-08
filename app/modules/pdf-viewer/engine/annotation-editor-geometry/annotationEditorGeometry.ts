import { clamp } from 'es-toolkit/math';
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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

export function annotationPageDimensions(
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
    const page = annotationPageDimensions(options.pageView, options.pageRotation ?? 0);
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

/** Display rotation is transient. Store geometry remains in the page's own rotation. */
export function rotateAnnotationPoint(point: IAnnotationEditorPoint, rotation: number): IAnnotationEditorPoint {
    switch (((rotation % 360) + 360) % 360) {
        case 90: return {
            x: 1 - point.y,
            y: point.x,
        };
        case 180: return {
            x: 1 - point.x,
            y: 1 - point.y,
        };
        case 270: return {
            x: point.y,
            y: 1 - point.x,
        };
        default: return {...point};
    }
}

export function rotateAnnotationRect(rect: IAnnotationMarkerRect, rotation: number): IAnnotationMarkerRect {
    const first = rotateAnnotationPoint({
        x: rect.left,
        y: rect.top,
    }, rotation);
    const last = rotateAnnotationPoint({
        x: rect.left + rect.width,
        y: rect.top + rect.height,
    }, rotation);
    return {
        left: Math.min(first.x, last.x),
        top: Math.min(first.y, last.y),
        width: Math.abs(last.x - first.x),
        height: Math.abs(last.y - first.y),
    };
}

export interface IAnnotationPageDimensions {
    width: number;
    height: number;
}

/** CSS rotations operate in physical page units, not anisotropic normalized axes. */
export function rotateAnnotationPointAround(
    point: IAnnotationEditorPoint,
    center: IAnnotationEditorPoint,
    rotation: number,
    page: IAnnotationPageDimensions,
): IAnnotationEditorPoint {
    const angle = rotation * Math.PI / 180;
    const cosine = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
    const sine = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
    const x = (point.x - center.x) * page.width;
    const y = (point.y - center.y) * page.height;
    return {
        x: center.x + (x * cosine - y * sine) / page.width,
        y: center.y + (x * sine + y * cosine) / page.height,
    };
}

export function rotatedAnnotationBounds(rect: IAnnotationMarkerRect, rotation: number, page: IAnnotationPageDimensions): IAnnotationMarkerRect {
    const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
    const corners = [
        {
            x: rect.left,
            y: rect.top,
        },
        {
            x: rect.left + rect.width,
            y: rect.top,
        },
        {
            x: rect.left,
            y: rect.top + rect.height,
        },
        {
            x: rect.left + rect.width,
            y: rect.top + rect.height,
        },
    ].map(point => rotateAnnotationPointAround(point, center, rotation, page));
    const left = Math.min(...corners.map(point => point.x));
    const top = Math.min(...corners.map(point => point.y));
    return {
        left,
        top,
        width: Math.max(...corners.map(point => point.x)) - left,
        height: Math.max(...corners.map(point => point.y)) - top,
    };
}

export function clampAnnotationMoveDelta(rects: readonly IAnnotationMarkerRect[], delta: IAnnotationEditorPoint): IAnnotationEditorPoint {
    if (!rects.length) {
        return delta;
    }
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.left + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.top + rect.height));
    return {
        x: clamp(delta.x, Math.min(0, -left), Math.max(0, 1 - right)),
        y: clamp(delta.y, Math.min(0, -top), Math.max(0, 1 - bottom)),
    };
}

export function resizeRotatedAnnotationRect(
    rect: IAnnotationMarkerRect,
    handle: TAnnotationResizeHandle,
    point: IAnnotationEditorPoint,
    rotation: number,
    page: IAnnotationPageDimensions,
): IAnnotationMarkerRect {
    if (!rotation) {
        return applyAnnotationHandleResize(rect, handle, point);
    }
    const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
    const localPoint = rotateAnnotationPointAround(point, center, -rotation, page);
    const start = {
        x: rect.left + rect.width * (handle.includes('w') ? 0 : handle.includes('e') ? 1 : 0.5),
        y: rect.top + rect.height * (handle.includes('n') ? 0 : handle.includes('s') ? 1 : 0.5),
    };
    function candidate(fraction: number) {
        const point = {
            x: start.x + (localPoint.x - start.x) * fraction,
            y: start.y + (localPoint.y - start.y) * fraction,
        };
        const left = handle.includes('w') ? Math.min(point.x, rect.left + rect.width - 0.01) : rect.left;
        const top = handle.includes('n') ? Math.min(point.y, rect.top + rect.height - 0.01) : rect.top;
        const right = handle.includes('e') ? Math.max(point.x, rect.left + 0.01) : rect.left + rect.width;
        const bottom = handle.includes('s') ? Math.max(point.y, rect.top + 0.01) : rect.top + rect.height;
        const local = {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
        const nextCenter = rotateAnnotationPointAround({
            x: local.left + local.width / 2,
            y: local.top + local.height / 2,
        }, center, rotation, page);
        return {
            ...local,
            left: nextCenter.x - local.width / 2,
            top: nextCenter.y - local.height / 2,
        };
    }
    function inside(value: IAnnotationMarkerRect) {
        const bounds = rotatedAnnotationBounds(value, rotation, page);
        return bounds.left >= -1e-8 && bounds.top >= -1e-8 && bounds.left + bounds.width <= 1 + 1e-8 && bounds.top + bounds.height <= 1 + 1e-8;
    }
    const requested = candidate(1);
    if (inside(requested)) {
        return requested;
    }
    if (!inside(rect)) {
        return rect;
    }
    let lower = 0;
    let upper = 1;
    for (let iteration = 0; iteration < 32; iteration += 1) {
        const middle = (lower + upper) / 2;
        if (inside(candidate(middle))) { lower = middle; } else { upper = middle; }
    }
    return candidate(lower);
}

/** Inverse placement for entities whose rotation is stored separately from their size. */
export function unrotateAnnotationPlacementRect(
    rect: IAnnotationMarkerRect,
    viewRotation: number,
    page: IAnnotationPageDimensions,
): IAnnotationMarkerRect {
    const center = rotateAnnotationPoint({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    }, -viewRotation);
    const swapped = Math.abs(viewRotation % 180) === 90;
    const width = rect.width * (swapped ? page.height / page.width : 1);
    const height = rect.height * (swapped ? page.width / page.height : 1);
    return {
        left: center.x - width / 2,
        top: center.y - height / 2,
        width,
        height,
    };
}

export function transformShapeToRect(
    entity: IShapeEntity,
    rect: IAnnotationMarkerRect,
    mode: 'move' | 'resize',
) {
    const line = entity.tool === 'line' || entity.tool === 'arrow';
    function points(values: readonly IAnnotationEditorPoint[]) {
        return values.map((point, index) => {
            if (mode === 'move') {
                return {
                    x: point.x + rect.left - entity.rect.left,
                    y: point.y + rect.top - entity.rect.top,
                };
            }
            const fallback = line && values.length > 1 ? index / (values.length - 1) : 0;
            const x = entity.rect.width ? (point.x - entity.rect.left) / entity.rect.width : fallback;
            const y = entity.rect.height ? (point.y - entity.rect.top) / entity.rect.height : fallback;
            return {
                x: rect.left + x * rect.width,
                y: rect.top + y * rect.height,
            };
        });
    }
    return {
        ...entity,
        rect,
        ...(entity.points ? {points: points(entity.points)} : {}),
        ...(entity.strokes ? {strokes: entity.strokes.map(points)} : {}),
    };
}

export function annotationInlineCapacity(rect: IAnnotationMarkerRect, rotation: number, page: IAnnotationPageDimensions) {
    const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
    const angle = rotation * Math.PI / 180;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const origins = [
        rect.top,
        rect.top + rect.height,
    ].map(y => rotateAnnotationPointAround({
        x: rect.left,
        y,
    }, center, rotation, page));
    const capacity = Math.min(...origins.map(point => Math.min(
        Math.abs(dx) < 1e-8 ? Infinity : (dx > 0 ? 1 - point.x : point.x) * page.width / Math.abs(dx),
        Math.abs(dy) < 1e-8 ? Infinity : (dy > 0 ? 1 - point.y : point.y) * page.height / Math.abs(dy),
    )));
    return Math.max(rect.width, capacity / page.width);
}

export function rotateAnnotationPlacementRect(
    rect: IAnnotationMarkerRect,
    viewRotation: number,
    page: IAnnotationPageDimensions,
): IAnnotationMarkerRect {
    const center = rotateAnnotationPoint({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    }, viewRotation);
    const swapped = Math.abs(viewRotation % 180) === 90;
    const width = rect.width * (swapped ? page.width / page.height : 1);
    const height = rect.height * (swapped ? page.height / page.width : 1);
    return {
        left: center.x - width / 2,
        top: center.y - height / 2,
        width,
        height,
    };
}
