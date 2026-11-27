import type {IShapeBounds} from '@app/modules/pdf-viewer/engine/pdf-shape-resize/shapeBounds';

export function toShapeRect(bounds: IShapeBounds, minSize = 0.01): IShapeBounds {
    return {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.minX + Math.max(minSize, bounds.maxX - bounds.minX),
        maxY: bounds.minY + Math.max(minSize, bounds.maxY - bounds.minY),
    };
}
