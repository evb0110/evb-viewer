import type { IClientRect } from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';

export function getRectHeight(rect: IClientRect) {
    return Math.max(0, rect.bottom - rect.top);
}
