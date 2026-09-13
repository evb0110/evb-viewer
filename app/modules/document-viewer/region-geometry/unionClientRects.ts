import type { IClientRect } from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';

export function unionClientRects(a: IClientRect, b: IClientRect): IClientRect {
    return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
    };
}
