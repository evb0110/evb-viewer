import type {IPoint2D} from '@app/types/point2D';
import type {
    IImagePlacementContainerRect,
    IImagePlacementRectPx,
} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

interface IImagePlacementMoveOptions {
    originRectPx: IImagePlacementRectPx;
    containerRect: IImagePlacementContainerRect;
    deltaX: number;
    deltaY: number;
    rotationDegrees?: number;
}

function toRadians(degrees: number) {
    return (degrees * Math.PI) / 180;
}

function getRectCenter(rect: IImagePlacementRectPx): IPoint2D {
    return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
}

function getRotatedBoundingSize(width: number, height: number, rotationDegrees: number) {
    const radians = toRadians(rotationDegrees);
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));

    return {
        width: width * absCos + height * absSin,
        height: width * absSin + height * absCos,
    };
}

function clampCenterToContainer(
    center: IPoint2D,
    containerRect: IImagePlacementContainerRect,
    width: number,
    height: number,
    rotationDegrees: number,
) {
    const bounding = getRotatedBoundingSize(width, height, rotationDegrees);

    return {
        x: Math.min(Math.max(center.x, bounding.width / 2), containerRect.width - bounding.width / 2),
        y: Math.min(Math.max(center.y, bounding.height / 2), containerRect.height - bounding.height / 2),
    };
}

function toRectFromCenter(center: IPoint2D, width: number, height: number): IImagePlacementRectPx {
    return {
        left: center.x - width / 2,
        top: center.y - height / 2,
        width,
        height,
    };
}

export function moveImagePlacementRect(options: IImagePlacementMoveOptions): IImagePlacementRectPx {
    const {originRectPx, containerRect, deltaX, deltaY, rotationDegrees = 0} = options;
    const originCenter = getRectCenter(originRectPx);
    const nextCenter = clampCenterToContainer(
        {
            x: originCenter.x + deltaX,
            y: originCenter.y + deltaY,
        },
        containerRect,
        originRectPx.width,
        originRectPx.height,
        rotationDegrees,
    );

    return toRectFromCenter(nextCenter, originRectPx.width, originRectPx.height);
}
