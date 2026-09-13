import type { IClientRect } from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';

export function getRectWidth(rect: IClientRect) {
    return Math.max(0, rect.right - rect.left);
}
