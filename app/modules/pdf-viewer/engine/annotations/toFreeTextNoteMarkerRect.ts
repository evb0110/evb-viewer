import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { isPointNoteMarkerSizedRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy';
import { isAnnotationMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/isAnnotationMarkerRect';

/**
 * Normalized side the save pipeline writes for an app note anchor that is not
 * already point-sized. It is deliberately far below
 * `POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE`: the anchor only has to be a
 * non-degenerate rect the import path can classify back as a marker, not a
 * shape anything draws.
 */
const POINT_NOTE_MARKER_SIZE = 0.0016;

export function toFreeTextNoteMarkerRect(
    value: IAnnotationCommentSummary['markerRect'],
): IAnnotationMarkerRect | null {
    if (!isAnnotationMarkerRect(value)) {
        return null;
    }

    if (isPointNoteMarkerSizedRect(value)) {
        return value;
    }

    return {
        left: value.left,
        top: value.top,
        width: POINT_NOTE_MARKER_SIZE,
        height: POINT_NOTE_MARKER_SIZE,
    };
}
