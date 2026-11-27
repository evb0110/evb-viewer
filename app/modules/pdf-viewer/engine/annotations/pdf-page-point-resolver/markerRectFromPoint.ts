import type {IAnnotationMarkerRect} from '@app/types/annotations';
import {clamp01} from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import {normalizeMarkerRect} from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';

const DEFAULT_POINT_MARKER_SIZE = 0.0016;

export function markerRectFromPoint(pageX: number, pageY: number): IAnnotationMarkerRect | null {
    return normalizeMarkerRect({
        left: clamp01(pageX) - DEFAULT_POINT_MARKER_SIZE / 2,
        top: clamp01(pageY) - DEFAULT_POINT_MARKER_SIZE / 2,
        width: DEFAULT_POINT_MARKER_SIZE,
        height: DEFAULT_POINT_MARKER_SIZE,
    });
}
