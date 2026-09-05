import { isFiniteNumber } from '@contracts/runtimeGuards';

/**
 * Largest normalized anchor-rect side that still classifies a FreeText
 * annotation as an app point-note marker.
 *
 * The unit is a page fraction: width and height are the annotation rect
 * divided by the rotated page box, so `0.02` is 2% of the page side, about 12
 * by 17 points on A4. Third-party FreeText annotations are page content and
 * stay FreeText; only this point-sized anchor shape becomes an app note
 * marker.
 *
 * See `docs/freetext-note-persistence.md` for why the save pipeline rewrites
 * app note rects down to this shape.
 */
// fallow-ignore-next-line unused-export
export const POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE = 0.02;

/**
 * Marker rects are divisions of PDF user-space numbers by page dimensions, so
 * a rect authored at exactly the limit can land a few ulps above it. The
 * comparison absorbs that noise and stays far below any authored size: the
 * documented non-marker example `0.020001` is still rejected.
 */
// fallow-ignore-next-line unused-export
export const POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE = Number.EPSILON * 16;

const POINT_NOTE_MARKER_SIZE_LIMIT
    = POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE + POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE;

/**
 * The single point-note size test. Boundary behaviour is inclusive at the top:
 * a side equal to the threshold is a marker, a side above it (beyond the
 * rounding tolerance) is not. Absent, non-finite and non-positive rects are
 * never markers.
 *
 * The lower bound is strict on purpose. A zero or negative side is not a tiny
 * marker, it is a degenerate rect: nothing can be drawn at it, hit-testing
 * against it always misses, and the import path already expands a genuinely
 * zero-area annotation rect to a real point-marker size. Accepting it here
 * would let malformed geometry survive a save cycle unchanged instead of
 * being rewritten to a usable anchor.
 */
export function isPointNoteMarkerSizedRect(rect: {
    width: number;
    height: number;
} | null | undefined): boolean {
    if (!rect) {
        return false;
    }
    return isFiniteNumber(rect.width)
        && isFiniteNumber(rect.height)
        && rect.width > 0
        && rect.height > 0
        && rect.width <= POINT_NOTE_MARKER_SIZE_LIMIT
        && rect.height <= POINT_NOTE_MARKER_SIZE_LIMIT;
}
