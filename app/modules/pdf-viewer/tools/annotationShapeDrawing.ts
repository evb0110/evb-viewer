import type {
    IAnnotationSettings,
    IShapeAnnotation,
    IShapePoint,
    TDrawableShapeType,
} from '@app/types/annotations';
import type { IShapeAnnotationConstructionOptions } from '@app/types/shapeAnnotationConstructionOptions';
import { generateManagedShapeStableKey } from '@app/modules/pdf-viewer/annotations/pdf-refs/generateManagedShapeStableKey';
import { getPointMinMaxBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getPointMinMaxBounds';
import { toShapeRect } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/toShapeRect';
import { getAllShapePoints } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/getAllShapePoints';
import { createBrowserSafeId } from '@app/utils/browserSafe';

const MIN_DRAWN_SHAPE_SIZE = 0.005;

export interface IBuildShapeAnnotationOptions extends IShapeAnnotationConstructionOptions {pageIndex: number;}

interface IShapeDrawingOrigin {
    x: number;
    y: number;
}

function generateShapeId() {
    return createBrowserSafeId('shape');
}

function resolveShapeBounds(shape: Pick<IShapeAnnotation, 'x' | 'y' | 'width' | 'height' | 'points' | 'strokes'>) {
    const bounds = getPointMinMaxBounds(getAllShapePoints(shape));
    if (!bounds) {
        return {
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
        };
    }

    const rect = toShapeRect(bounds, 0.0001);
    return {
        x: rect.minX,
        y: rect.minY,
        width: rect.maxX - rect.minX,
        height: rect.maxY - rect.minY,
    };
}

function appendDrawPoint(points: IShapePoint[], x: number, y: number) {
    const lastPoint = points[points.length - 1];
    if (!lastPoint) {
        return [
            ...points,
            {
                x,
                y,
            },
        ];
    }

    if (Math.hypot(lastPoint.x - x, lastPoint.y - y) < 0.001) {
        return points;
    }

    return [
        ...points,
        {
            x,
            y,
        },
    ];
}

function getShapePathLength(points: IShapePoint[]) {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (!previous || !current) {
            continue;
        }
        length += Math.hypot(current.x - previous.x, current.y - previous.y);
    }
    return length;
}

function isLineLikeShape(shape: IShapeAnnotation) {
    return shape.type === 'line' || shape.type === 'arrow';
}

function createInitialDrawPoint(x: number, y: number): IShapePoint {
    return {
        x,
        y,
    };
}

function resolveDrawingFillColor(tool: TDrawableShapeType, settings: IAnnotationSettings) {
    if (tool === 'draw' || settings.shapeFillColor === 'transparent') {
        return undefined;
    }
    return settings.shapeFillColor;
}

function resolveDrawingShapeType(tool: TDrawableShapeType) {
    return tool === 'draw' ? 'polyline' : tool;
}

function resolveDrawingStyle(tool: TDrawableShapeType, settings: IAnnotationSettings) {
    if (tool === 'draw') {
        return {
            color: settings.inkColor,
            opacity: settings.inkOpacity,
            strokeWidth: settings.inkThickness,
            fillColor: undefined,
        };
    }

    return {
        color: settings.shapeColor,
        opacity: settings.shapeOpacity,
        strokeWidth: settings.shapeStrokeWidth,
        fillColor: resolveDrawingFillColor(tool, settings),
    };
}

function clampUnit(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

function normalizeOptionalPoint(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? clampUnit(value)
        : fallback;
}

function normalizeOptionalPositiveNumber(value: number | undefined, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, value)
        : fallback;
}

function normalizeStyleColor(value: string | undefined, fallback: string) {
    const color = value?.trim();
    return color && color.length > 0 ? color : fallback;
}

function normalizeGeometryPoint(point: IShapePoint): IShapePoint {
    return {
        x: clampUnit(point.x),
        y: clampUnit(point.y),
    };
}

function normalizeGeometryPoints(points: IShapePoint[] | undefined) {
    const normalized = points
        ?.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(normalizeGeometryPoint)
        ?? [];
    return normalized.length > 0 ? normalized : null;
}

function normalizeGeometryStrokes(strokes: IShapePoint[][] | undefined) {
    const normalized = strokes
        ?.map(points => normalizeGeometryPoints(points) ?? [])
        .filter(points => points.length > 0)
        ?? [];
    return normalized.length > 0 ? normalized : null;
}

function resolveGeometryFillColor(
    tool: TDrawableShapeType,
    settings: IAnnotationSettings,
    fillColor: string | null | undefined,
) {
    if (fillColor === null || fillColor === 'transparent') {
        return undefined;
    }

    const normalized = fillColor?.trim();
    return normalized && normalized.length > 0
        ? normalized
        : resolveDrawingFillColor(tool, settings);
}

function applyGeometryStyle(
    shape: IShapeAnnotation,
    tool: TDrawableShapeType,
    settings: IAnnotationSettings,
    options: IBuildShapeAnnotationOptions,
): IShapeAnnotation {
    const style = resolveDrawingStyle(tool, settings);
    return {
        ...shape,
        color: normalizeStyleColor(options.color, style.color),
        fillColor: resolveGeometryFillColor(tool, settings, options.fillColor),
        opacity: Math.min(1, normalizeOptionalPositiveNumber(options.opacity, style.opacity)),
        strokeWidth: normalizeOptionalPositiveNumber(options.strokeWidth, style.strokeWidth),
    };
}

function applyBoxGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
    const startX = clampUnit(options.x);
    const startY = clampUnit(options.y);
    const hasEndPoint = typeof options.x2 === 'number' || typeof options.y2 === 'number';
    if (hasEndPoint) {
        const endX = normalizeOptionalPoint(options.x2, startX);
        const endY = normalizeOptionalPoint(options.y2, startY);
        const minX = Math.min(startX, endX);
        const minY = Math.min(startY, endY);
        return {
            ...shape,
            x: minX,
            y: minY,
            width: Math.abs(endX - startX),
            height: Math.abs(endY - startY),
        };
    }

    return {
        ...shape,
        x: startX,
        y: startY,
        width: Math.min(1 - startX, normalizeOptionalPositiveNumber(options.width, 0)),
        height: Math.min(1 - startY, normalizeOptionalPositiveNumber(options.height, 0)),
    };
}

function applyLineGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
    const x = clampUnit(options.x);
    const y = clampUnit(options.y);
    const x2 = normalizeOptionalPoint(
        options.x2,
        Math.min(1, x + normalizeOptionalPositiveNumber(options.width, 0)),
    );
    const y2 = normalizeOptionalPoint(
        options.y2,
        Math.min(1, y + normalizeOptionalPositiveNumber(options.height, 0)),
    );

    return {
        ...shape,
        x,
        y,
        x2,
        y2,
        width: Math.abs(x2 - x),
        height: Math.abs(y2 - y),
    };
}

function applyInkGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
    const fallbackPoints = [
        {
            x: clampUnit(options.x),
            y: clampUnit(options.y),
        },
        {
            x: normalizeOptionalPoint(options.x2, clampUnit(options.x)),
            y: normalizeOptionalPoint(options.y2, clampUnit(options.y)),
        },
    ];
    const normalizedPoints = normalizeGeometryPoints(options.points);
    const strokes = normalizeGeometryStrokes(options.strokes)
        ?? (normalizedPoints ? [normalizedPoints] : [fallbackPoints]);
    const points = strokes[0] ?? fallbackPoints;
    return {
        ...shape,
        ...resolveShapeBounds({
            ...shape,
            points,
            strokes,
        }),
        points,
        strokes,
        pdfSubtype: 'Ink',
    };
}

function createLineDrawingGeometry(tool: TDrawableShapeType, x: number, y: number) {
    if (tool !== 'line' && tool !== 'arrow') {
        return {};
    }

    return {
        x2: x,
        y2: y,
    };
}

function createInkDrawingGeometry(tool: TDrawableShapeType, x: number, y: number) {
    if (tool !== 'draw') {
        return {};
    }

    return {
        points: [createInitialDrawPoint(x, y)],
        strokes: [[createInitialDrawPoint(x, y)]],
        pdfSubtype: 'Ink' as const,
    };
}

function createArrowDrawingGeometry(tool: TDrawableShapeType) {
    if (tool !== 'arrow') {
        return {};
    }

    return { lineEndStyle: 'closedArrow' as const };
}

export function createDrawingShape(
    pageIndex: number,
    tool: TDrawableShapeType,
    x: number,
    y: number,
    settings: IAnnotationSettings,
): IShapeAnnotation {
    const style = resolveDrawingStyle(tool, settings);
    const createdAt = Date.now();
    return {
        id: generateShapeId(),
        type: resolveDrawingShapeType(tool),
        pageIndex,
        x,
        y,
        width: 0,
        height: 0,
        ...createLineDrawingGeometry(tool, x, y),
        ...style,
        ...createInkDrawingGeometry(tool, x, y),
        source: 'local',
        stableKey: generateManagedShapeStableKey(),
        ...createArrowDrawingGeometry(tool),
        createdAt,
        modifiedAt: createdAt,
    };
}

export function buildShapeAnnotation(
    options: IBuildShapeAnnotationOptions,
    settings: IAnnotationSettings,
): IShapeAnnotation | null {
    const baseShape = applyGeometryStyle(
        createDrawingShape(
            Math.max(0, Math.trunc(options.pageIndex)),
            options.tool,
            clampUnit(options.x),
            clampUnit(options.y),
            settings,
        ),
        options.tool,
        settings,
        options,
    );
    const shape = (() => {
        if (options.tool === 'draw') {
            return applyInkGeometry(baseShape, options);
        }
        if (options.tool === 'line' || options.tool === 'arrow') {
            return applyLineGeometry(baseShape, options);
        }
        return applyBoxGeometry(baseShape, options);
    })();

    return isDrawableFinishedShape(shape)
        ? shape
        : null;
}

export function isDrawableFinishedShape(shape: IShapeAnnotation) {
    if (shape.type === 'polyline') {
        const points = shape.strokes?.[0] ?? shape.points ?? [];
        return points.length >= 2 && getShapePathLength(points) >= MIN_DRAWN_SHAPE_SIZE;
    }

    if (isLineLikeShape(shape)) {
        const dx = (shape.x2 ?? shape.x) - shape.x;
        const dy = (shape.y2 ?? shape.y) - shape.y;
        return Math.hypot(dx, dy) >= MIN_DRAWN_SHAPE_SIZE;
    }

    return shape.width >= MIN_DRAWN_SHAPE_SIZE && shape.height >= MIN_DRAWN_SHAPE_SIZE;
}

export function updateDrawingShapeForPoint(
    shape: IShapeAnnotation,
    drawOrigin: IShapeDrawingOrigin,
    x: number,
    y: number,
): IShapeAnnotation {
    if (shape.type === 'polyline') {
        const points = appendDrawPoint(shape.strokes?.[0] ?? shape.points ?? [], x, y);
        const strokes = [points];
        return {
            ...shape,
            ...resolveShapeBounds({
                ...shape,
                points,
                strokes,
            }),
            points,
            strokes,
        };
    }

    if (isLineLikeShape(shape)) {
        return {
            ...shape,
            x2: x,
            y2: y,
        };
    }

    const minX = Math.min(drawOrigin.x, x);
    const minY = Math.min(drawOrigin.y, y);
    const maxX = Math.max(drawOrigin.x, x);
    const maxY = Math.max(drawOrigin.y, y);
    return {
        ...shape,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}
