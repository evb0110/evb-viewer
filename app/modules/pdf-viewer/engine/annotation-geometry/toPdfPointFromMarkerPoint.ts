import {
    type IPageRectBounds,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/getPageRectBounds';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

export function toPdfPointInPageBounds(
    markerX: number,
    markerY: number,
    bounds: IPageRectBounds,
    pageRotation: TPageRotation,
) {
    let normX = markerX;
    let normY = 1 - markerY;

    switch (pageRotation) {
        case 90:
            normX = markerY;
            normY = markerX;
            break;
        case 180:
            normX = 1 - markerX;
            normY = markerY;
            break;
        case 270:
            normX = 1 - markerY;
            normY = 1 - markerX;
            break;
        case 0:
            break;
    }

    return {
        x: bounds.xMin + normX * bounds.width,
        y: bounds.yMin + normY * bounds.height,
    };
}
