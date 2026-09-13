import type { IPoint2D } from '@app/types/point2D';
import { getShortestImagePlacementAngleDelta } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/getShortestImagePlacementAngleDelta';
import { normalizeImagePlacementRotationDegrees } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/normalizeImagePlacementRotationDegrees';
import type { IImagePlacementRectPx } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';
import { snapImagePlacementRotationDegrees } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/snapImagePlacementRotationDegrees';

interface IImagePlacementPointerRotateOptions {
    originRectPx: IImagePlacementRectPx;
    containerOrigin: IPoint2D;
    originRotationDegrees?: number;
    startClientX: number;
    startClientY: number;
    clientX: number;
    clientY: number;
    shiftKey?: boolean;
    snapStepDegrees?: number;
}


const DEFAULT_ROTATION_SNAP_STEP_DEGREES = 15;

function getShortestImagePlacementAngleDelta(deltaDegrees: number) {
    let normalized = ((deltaDegrees + 180) % 360 + 360) % 360 - 180;
    if (normalized === -180 && deltaDegrees > 0) {
        normalized = 180;
    }
    return normalized;
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

function getPointerAngleFromCenter(
    center: IPoint2D,
    clientX: number,
    clientY: number,
) {
    return (Math.atan2(clientY - center.y, clientX - center.x) * 180) / Math.PI;
}

export function rotateImagePlacementRect(
    options: IImagePlacementPointerRotateOptions,
) {
    const {
        originRectPx,
        containerOrigin,
        originRotationDegrees = 0,
        startClientX,
        startClientY,
        clientX,
        clientY,
        shiftKey = false,
        snapStepDegrees = DEFAULT_ROTATION_SNAP_STEP_DEGREES,
    } = options;
    const center = getRectCenter(originRectPx);
    const viewportCenter = {
        x: center.x + containerOrigin.x,
        y: center.y + containerOrigin.y,
    };
    const startAngle = getPointerAngleFromCenter(viewportCenter, startClientX, startClientY);
    const nextAngle = getPointerAngleFromCenter(viewportCenter, clientX, clientY);
    const angleDelta = getShortestImagePlacementAngleDelta(nextAngle - startAngle);
    const rawRotation = normalizeImagePlacementRotationDegrees(originRotationDegrees + angleDelta);
    const rotationDegrees = shiftKey
        ? snapImagePlacementRotationDegrees(rawRotation, snapStepDegrees)
        : rawRotation;

    return {
        rectPx: toRectFromCenter(center, originRectPx.width, originRectPx.height),
        rotationDegrees,
    };
}
