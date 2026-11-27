import type {IPoint2D} from '@app/types/point2D';
import type {IImagePlacementRectPx} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

function toRadians(degrees: number) {
    return (degrees * Math.PI) / 180;
}

function rotateLocalVector(point: IPoint2D, rotationDegrees: number): IPoint2D {
    const radians = toRadians(rotationDegrees);
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
    };
}

function getRectCenter(rect: IImagePlacementRectPx): IPoint2D {
    return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
}

export function getImagePlacementRotateHandleViewportPosition(
    rectPx: IImagePlacementRectPx,
    rotationDegrees: number,
    containerOrigin: IPoint2D,
    handleOffsetPx: number,
): IPoint2D {
    const center = getRectCenter(rectPx);
    const localOffset = {
        x: 0,
        y: -(rectPx.height / 2 + handleOffsetPx),
    };
    const worldOffset = rotateLocalVector(localOffset, rotationDegrees);
    return {
        x: center.x + worldOffset.x + containerOrigin.x,
        y: center.y + worldOffset.y + containerOrigin.y,
    };
}
