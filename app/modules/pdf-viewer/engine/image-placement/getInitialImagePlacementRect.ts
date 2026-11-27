import type {TPageNumber} from '@contracts/pageNumbers';

import {clamp} from 'es-toolkit/math';
import type {IImagePlacementDimensions} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

export interface IImagePlacementTarget {
    pageNumber: TPageNumber;
    pageX: number;
    pageY: number;
    pageWidthPx: number | null;
    pageHeightPx: number | null;
}

export function getInitialImagePlacementRect(target: IImagePlacementTarget, dimensions: IImagePlacementDimensions) {
    const x = clamp(target.pageX - dimensions.width / 2, 0, Math.max(0, 1 - dimensions.width));
    const y = clamp(target.pageY - dimensions.height / 2, 0, Math.max(0, 1 - dimensions.height));

    return {
        pageNumber: target.pageNumber,
        x,
        y,
        width: dimensions.width,
        height: dimensions.height,
    };
}
