import {
    type IPageRectBounds,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/getPageRectBounds';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

export function toMarkerPointInPageBounds(
    x: number,
    y: number,
    bounds: IPageRectBounds,
    pageRotation: TPageRotation,
) {
    const normX = (x - bounds.xMin) / bounds.width;
    const normY = (y - bounds.yMin) / bounds.height;

    switch (pageRotation) {
        case 90:
            return {
                x: normY,
                y: normX,
            };
        case 180:
            return {
                x: 1 - normX,
                y: normY,
            };
        case 270:
            return {
                x: 1 - normY,
                y: 1 - normX,
            };
        case 0:
            return {
                x: normX,
                y: 1 - normY,
            };
    }
}
