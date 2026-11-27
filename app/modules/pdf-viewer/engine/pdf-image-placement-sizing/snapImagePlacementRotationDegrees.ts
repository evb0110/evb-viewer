import {normalizeImagePlacementRotationDegrees} from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/normalizeImagePlacementRotationDegrees';

const DEFAULT_ROTATION_SNAP_STEP_DEGREES = 15;

export function snapImagePlacementRotationDegrees(value: number, stepDegrees: number = DEFAULT_ROTATION_SNAP_STEP_DEGREES) {
    const normalized = normalizeImagePlacementRotationDegrees(value);
    if (!Number.isFinite(stepDegrees) || stepDegrees <= 0) {
        return normalized;
    }

    return normalizeImagePlacementRotationDegrees(Math.round(normalized / stepDegrees) * stepDegrees);
}
