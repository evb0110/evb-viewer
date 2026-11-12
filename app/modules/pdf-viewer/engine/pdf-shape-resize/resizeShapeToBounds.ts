import type {
    IShapeAnnotation,
    IShapePoint,
} from '@app/types/annotations';
import type { IShapeBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/shapeBounds';

function scalePointToBounds(point: IShapePoint, baselineBounds: IShapeBounds, nextBounds: IShapeBounds) {
    const baselineWidth = Math.max(0.01, baselineBounds.maxX - baselineBounds.minX);
    const baselineHeight = Math.max(0.01, baselineBounds.maxY - baselineBounds.minY);
    const nextWidth = Math.max(0.01, nextBounds.maxX - nextBounds.minX);
    const nextHeight = Math.max(0.01, nextBounds.maxY - nextBounds.minY);
    const ratioX = (point.x - baselineBounds.minX) / baselineWidth;
    const ratioY = (point.y - baselineBounds.minY) / baselineHeight;

    return {
        x: nextBounds.minX + ratioX * nextWidth,
        y: nextBounds.minY + ratioY * nextHeight,
    };
}

export function resizeShapeToBounds(
    shape: IShapeAnnotation,
    baselineBounds: IShapeBounds,
    nextBounds: IShapeBounds,
): IShapeAnnotation {
    if (shape.type === 'rectangle' || shape.type === 'circle') {
        return {
            ...shape,
            x: nextBounds.minX,
            y: nextBounds.minY,
            width: nextBounds.maxX - nextBounds.minX,
            height: nextBounds.maxY - nextBounds.minY,
        };
    }

    if (shape.type === 'line' || shape.type === 'arrow') {
        const start = scalePointToBounds({
            x: shape.x,
            y: shape.y,
        }, baselineBounds, nextBounds);
        const end = scalePointToBounds({
            x: shape.x2 ?? shape.x,
            y: shape.y2 ?? shape.y,
        }, baselineBounds, nextBounds);

        return {
            ...shape,
            x: start.x,
            y: start.y,
            x2: end.x,
            y2: end.y,
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y),
        };
    }

    {
        const strokes = shape.strokes?.map(points => points.map(point => scalePointToBounds(point, baselineBounds, nextBounds)))
            ?? null;
        const points = shape.points?.map(point => scalePointToBounds(point, baselineBounds, nextBounds))
            ?? strokes?.[0]
            ?? [];
        if (points.length === 0) {
            return shape;
        }

        const allPoints = strokes?.flatMap(path => path) ?? points;
        const bounds = {
            minX: Math.min(...allPoints.map(point => point.x)),
            minY: Math.min(...allPoints.map(point => point.y)),
            maxX: Math.max(...allPoints.map(point => point.x)),
            maxY: Math.max(...allPoints.map(point => point.y)),
        };

        return {
            ...shape,
            x: bounds.minX,
            y: bounds.minY,
            width: Math.max(0.01, bounds.maxX - bounds.minX),
            height: Math.max(0.01, bounds.maxY - bounds.minY),
            points,
            strokes: strokes ?? shape.strokes,
        };
    }

}
