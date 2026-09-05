import type { IPoint2D } from '@app/types/point2D';
import type {
    IImagePlacementContainerRect,
    IImagePlacementRectPx,
    TImagePlacementResizeHandle,
} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

interface IImagePlacementPointerResizeOptions {
    originRectPx: IImagePlacementRectPx;
    containerRect: IImagePlacementContainerRect;
    handle: TImagePlacementResizeHandle;
    startClientX: number;
    startClientY: number;
    clientX: number;
    clientY: number;
    rotationDegrees?: number;
    shiftKey?: boolean;
    minSizePx?: number;
}


const DEFAULT_MIN_IMAGE_PLACEMENT_SIZE_PX = 32;

const EPSILON = 0.0001;

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
        x: (point.x * cos) - (point.y * sin),
        y: (point.x * sin) + (point.y * cos),
    };
}

function dot(a: IPoint2D, b: IPoint2D) {
    return (a.x * b.x) + (a.y * b.y);
}

function getRectCenter(rect: IImagePlacementRectPx): IPoint2D {
    return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
    };
}

function toRectFromCenter(
    center: IPoint2D,
    width: number,
    height: number,
): IImagePlacementRectPx {
    return {
        left: center.x - (width / 2),
        top: center.y - (height / 2),
        width,
        height,
    };
}

function toLocalVector(point: IPoint2D, rotationDegrees: number) {
    return rotateLocalVector(point, -rotationDegrees);
}

function getHandleVector(handle: TImagePlacementResizeHandle) {
    return IMAGE_PLACEMENT_HANDLE_VECTORS[handle];
}

function getOppositeHandle(handle: TImagePlacementResizeHandle): TImagePlacementResizeHandle {
    switch (handle) {
        case 'n':
            return 's';
        case 'ne':
            return 'sw';
        case 'e':
            return 'w';
        case 'se':
            return 'nw';
        case 's':
            return 'n';
        case 'sw':
            return 'ne';
        case 'w':
            return 'e';
        case 'nw':
            return 'se';
    }
}

function getHandleWorldPoint(
    rectPx: IImagePlacementRectPx,
    handle: TImagePlacementResizeHandle,
    rotationDegrees: number,
) {
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

function getRotatedRectCorners(
    rectPx: IImagePlacementRectPx,
    rotationDegrees: number,
) {
    const center = getRectCenter(rectPx);
    const halfWidth = rectPx.width / 2;
    const halfHeight = rectPx.height / 2;

    return [
        {
            x: -halfWidth,
            y: -halfHeight,
        },
        {
            x: halfWidth,
            y: -halfHeight,
        },
        {
            x: halfWidth,
            y: halfHeight,
        },
        {
            x: -halfWidth,
            y: halfHeight,
        },
    ].map((corner) => {
        const rotated = rotateLocalVector(corner, rotationDegrees);

        return {
            x: center.x + rotated.x,
            y: center.y + rotated.y,
        };
    });
}

function isRotatedRectInsideContainer(
    rectPx: IImagePlacementRectPx,
    containerRect: IImagePlacementContainerRect,
    rotationDegrees: number,
) {
    return getRotatedRectCorners(rectPx, rotationDegrees).every((corner) => (
        corner.x >= 0
        && corner.x <= containerRect.width
        && corner.y >= 0
        && corner.y <= containerRect.height
    ));
}

function getRectFromFixedAnchor(
    anchorWorld: IPoint2D,
    handle: TImagePlacementResizeHandle,
    width: number,
    height: number,
    rotationDegrees: number,
) {
    const handleVector = getHandleVector(handle);
    const centerOffset = rotateLocalVector({
        x: (handleVector.x * width) / 2,
        y: (handleVector.y * height) / 2,
    }, rotationDegrees);

    return toRectFromCenter({
        x: anchorWorld.x + centerOffset.x,
        y: anchorWorld.y + centerOffset.y,
    }, width, height);
}

function constrainResizeRectToContainer(
    originRectPx: IImagePlacementRectPx,
    desiredWidth: number,
    desiredHeight: number,
    anchorWorld: IPoint2D,
    handle: TImagePlacementResizeHandle,
    containerRect: IImagePlacementContainerRect,
    rotationDegrees: number,
) {
    const desiredRect = getRectFromFixedAnchor(
        anchorWorld,
        handle,
        desiredWidth,
        desiredHeight,
        rotationDegrees,
    );
    if (isRotatedRectInsideContainer(desiredRect, containerRect, rotationDegrees)) {
        return desiredRect;
    }

    let low = 0;
    let high = 1;
    let bestRect = originRectPx;

    for (let index = 0; index < 24; index += 1) {
        const ratio = (low + high) / 2;
        const rect = getRectFromFixedAnchor(
            anchorWorld,
            handle,
            originRectPx.width + ((desiredWidth - originRectPx.width) * ratio),
            originRectPx.height + ((desiredHeight - originRectPx.height) * ratio),
            rotationDegrees,
        );

        if (isRotatedRectInsideContainer(rect, containerRect, rotationDegrees)) {
            low = ratio;
            bestRect = rect;
            continue;
        }

        high = ratio;
    }

    return bestRect;
}

function resolveLockedAspectSize(
    width: number,
    height: number,
    aspectRatio: number,
    minSizePx: number,
) {
    const direction = {
        x: aspectRatio,
        y: 1,
    };
    const t = Math.max(EPSILON, dot({
        x: width,
        y: height,
    }, direction) / dot(direction, direction));

    let resolvedWidth = t * direction.x;
    let resolvedHeight = t * direction.y;
    const minScale = Math.max(
        minSizePx / Math.max(EPSILON, resolvedWidth),
        minSizePx / Math.max(EPSILON, resolvedHeight),
        1,
    );

    resolvedWidth *= minScale;
    resolvedHeight *= minScale;

    return {
        width: resolvedWidth,
        height: resolvedHeight,
    };
}

export function resizeImagePlacementRect(
    options: IImagePlacementPointerResizeOptions,
): IImagePlacementRectPx {
    const {
        originRectPx,
        containerRect,
        handle,
        startClientX,
        startClientY,
        clientX,
        clientY,
        rotationDegrees = 0,
        shiftKey = false,
        minSizePx = DEFAULT_MIN_IMAGE_PLACEMENT_SIZE_PX,
    } = options;
    const aspectRatio = originRectPx.width / Math.max(EPSILON, originRectPx.height);
    const handleVector = getHandleVector(handle);
    const oppositeHandle = getOppositeHandle(handle);
    const anchorWorld = getHandleWorldPoint(originRectPx, oppositeHandle, rotationDegrees);
    const originHandleWorld = getHandleWorldPoint(originRectPx, handle, rotationDegrees);
    const targetHandleWorld = {
        x: clientX - (startClientX - originHandleWorld.x),
        y: clientY - (startClientY - originHandleWorld.y),
    };
    const handleLocalFromAnchor = toLocalVector({
        x: targetHandleWorld.x - anchorWorld.x,
        y: targetHandleWorld.y - anchorWorld.y,
    }, rotationDegrees);
    let desiredWidth = originRectPx.width;
    let desiredHeight = originRectPx.height;

    if (handleVector.x === 0 || handleVector.y === 0) {
        if (handleVector.x !== 0) {
            desiredWidth = Math.max(minSizePx, handleVector.x * handleLocalFromAnchor.x);
        }
        if (handleVector.y !== 0) {
            desiredHeight = Math.max(minSizePx, handleVector.y * handleLocalFromAnchor.y);
        }
    } else {
        const rawWidth = Math.max(EPSILON, handleVector.x * handleLocalFromAnchor.x);
        const rawHeight = Math.max(EPSILON, handleVector.y * handleLocalFromAnchor.y);
        const locked = shiftKey
            ? resolveLockedAspectSize(rawWidth, rawHeight, aspectRatio, minSizePx)
            : {
                width: Math.max(minSizePx, rawWidth),
                height: Math.max(minSizePx, rawHeight),
            };

        desiredWidth = locked.width;
        desiredHeight = locked.height;
    }

    return constrainResizeRectToContainer(
        originRectPx,
        desiredWidth,
        desiredHeight,
        anchorWorld,
        handle,
        containerRect,
        rotationDegrees,
    );
}
