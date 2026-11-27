import type {TPageRotation} from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

export function normalizePageRotation(value: number): TPageRotation {
    if (!Number.isFinite(value)) {
        return 0;
    }

    const snapped = Math.round(value / 90) * 90;
    const normalized = ((snapped % 360) + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }
    return 0;
}
