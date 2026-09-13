import { getRectHeight } from '@app/modules/document-viewer/region-geometry/getRectHeight';
import { getRectWidth } from '@app/modules/document-viewer/region-geometry/getRectWidth';
import type { IClientRect } from '@app/modules/document-viewer/region-geometry/regionGeometryTypes';

export function intersectClientRects(a: IClientRect, b: IClientRect): IClientRect | null {
    const intersection: IClientRect = {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };

    return getRectWidth(intersection) > 0 && getRectHeight(intersection) > 0
        ? intersection
        : null;
}
