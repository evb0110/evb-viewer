import type { IShapeAnnotation } from '@app/types/annotations';

export function collectEmbeddedShapeAnnotationIds(shapes: IShapeAnnotation[]) {
    const ids = new Set<string>();
    shapes.forEach((shape) => {
        if (shape.source === 'embedded' && shape.annotationId) {
            ids.add(shape.annotationId);
        }
    });
    return ids;
}
