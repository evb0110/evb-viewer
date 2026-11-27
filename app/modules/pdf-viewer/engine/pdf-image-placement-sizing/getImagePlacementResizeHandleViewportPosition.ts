import type {IPoint2D} from '@app/types/point2D';
import type {
    IImagePlacementRectPx,
    TImagePlacementResizeHandle,
} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

const IMAGE_PLACEMENT_HANDLE_VECTORS: Record<TImagePlacementResizeHandle, IPoint2D> = {
    n: {
        x: 0,
        y: -1,
    },
    ne: {
        x: 1,
        y: -1,
    },
    e: {
        x: 1,
        y: 0,
    },
    se: {
        x: 1,
        y: 1,
    },
    s: {
        x: 0,
        y: 1,
    },
    sw: {
        x: -1,
        y: 1,
    },
    w: {
        x: -1,
        y: 0,
    },
    nw: {
        x: -1,
        y: -1,
    },
};

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

function getHandleVector(handle: TImagePlacementResizeHandle) {
    return IMAGE_PLACEMENT_HANDLE_VECTORS[handle];
}

function getHandleWorldPoint(rectPx: IImagePlacementRectPx, handle: TImagePlacementResizeHandle, rotationDegrees: number) {
    const center = getRectCenter(rectPx);
    const handleVector = getHandleVector(handle);
    const localOffset = {
        x: (handleVector.x * rectPx.width) / 2,
        y: (handleVector.y * rectPx.height) / 2,
    };
    const worldOffset = rotateLocalVector(localOffset, rotationDegrees);

    return {
        x: center.x + worldOffset.x,
        y: center.y + worldOffset.y,
    };
}

export function getImagePlacementResizeHandleViewportPosition(
    rectPx: IImagePlacementRectPx,
    handle: TImagePlacementResizeHandle,
    rotationDegrees: number,
    containerOrigin: IPoint2D,
): IPoint2D {
    const world = getHandleWorldPoint(rectPx, handle, rotationDegrees);
    return {
        x: world.x + containerOrigin.x,
        y: world.y + containerOrigin.y,
    };
}
