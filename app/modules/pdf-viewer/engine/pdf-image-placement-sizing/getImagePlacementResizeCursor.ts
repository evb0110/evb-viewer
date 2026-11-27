import type {TImagePlacementResizeHandle} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

const IMAGE_PLACEMENT_HANDLE_ANGLES: Record<TImagePlacementResizeHandle, number> = {
    n: -90,
    ne: -45,
    e: 0,
    se: 45,
    s: 90,
    sw: 135,
    w: 180,
    nw: 225,
};

export function getImagePlacementResizeCursor(handle: TImagePlacementResizeHandle, rotationDegrees: number) {
    const handleAngle = IMAGE_PLACEMENT_HANDLE_ANGLES[handle];
    const normalizedAngle = (((handleAngle + rotationDegrees) % 360) + 360) % 360;
    const snappedAngle = (Math.round(normalizedAngle / 45) * 45) % 360;

    switch (snappedAngle) {
        case 0:
        case 180:
            return 'ew-resize';
        case 45:
        case 225:
            return 'nwse-resize';
        case 90:
        case 270:
            return 'ns-resize';
        case 135:
        case 315:
            return 'nesw-resize';
        default:
            return 'move';
    }
}
