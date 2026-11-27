import type {IShapeAnnotation} from '@app/types/annotations';

export function getShapeStrokePointSets(shape: Pick<IShapeAnnotation, 'points' | 'strokes'>) {
    if (shape.strokes && shape.strokes.length > 0) {
        return shape.strokes.filter((points) => points.length > 0);
    }

    if (shape.points && shape.points.length > 0) {
        return [shape.points];
    }

    return [];
}
