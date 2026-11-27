import type {IShapePoint} from '@app/types/annotations';

export function getPointMinMaxBounds(points: IShapePoint[]) {
    if (points.length === 0) {
        return null;
    }

    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}
