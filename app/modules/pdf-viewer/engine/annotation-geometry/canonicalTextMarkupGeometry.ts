import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { normalizeMarkerRectBounds } from '@app/utils/pdfMarkerRect';
import {
    MIN_MARKER_RECT_SIZE,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';

/**
 * The one boundary where PDF text-markup geometry becomes canonical.
 *
 * Authored geometry and reopened geometry reach the save verifier from two
 * different worlds. Authored geometry is a list of page-normalized selection
 * boxes the store holds. Reopened geometry is a `/QuadPoints` array read back
 * from the saved file. The two only compare if a single documented mapping owns
 * every representational difference between them:
 *
 * - **Coordinate frame.** Canonical geometry is a page-display marker rect: the
 *   same frame `toMarkerRectFromPdfRect` produces and `toPdfRectFromMarkerRect`
 *   consumes, with the page's `/Rotate` already applied. That is the frame the
 *   overlay, the comment list and every other marker rect in this project use,
 *   so a rotated page needs no special case anywhere else. Both sides of the
 *   comparison therefore cross `toMarkerRectFromPdfRect` with the same page
 *   view box and the same rotation.
 * - **Corner order.** The PDF specification orders a quad's four points
 *   upper-left, upper-right, lower-left, lower-right; PDF.js writes the same
 *   order but many producers do not, and PDF.js's own reader re-sorts them.
 *   {@link toCanonicalTextMarkupRectFromQuad} therefore projects each quad
 *   through its own min/max corners, so any corner order yields one rect.
 * - **Quad order.** Nothing in the format pins the order of quads inside
 *   `/QuadPoints`. {@link matchCanonicalTextMarkupGeometry} compares the two
 *   lists as multisets instead of index by index, so a reordered array is not
 *   a fidelity failure while a moved rect still is.
 * - **Float representation.** A quad round trip loses precision twice: PDF.js
 *   keeps quad points in a `Float32Array`, and its writer emits at most two
 *   decimals of a PDF unit. Canonical coordinates are rounded to
 *   {@link CANONICAL_COORDINATE_STEP} so equal geometry compares equal, and
 *   the residue is bounded by {@link TEXT_MARKUP_COORDINATE_TOLERANCE}.
 * - **Degenerate rects.** A selection fragment can be narrower than the
 *   overlay's minimum marker size, and the marker mapping widens it around its
 *   centre. The canonical rule applies that same widening — the one
 *   `MIN_MARKER_RECT_SIZE` the overlay uses, not a second copy of the number —
 *   idempotently, so a rect that already crossed the marker mapping is
 *   unchanged by crossing it again.
 *
 * The mapping is deliberately *not* a tolerance: it is a normal form, and both
 * sides pass through it. A highlight that actually moved changes its canonical
 * rect and still fails verification.
 */

/** Canonical coordinates are rounded to this many normalized units. */
const CANONICAL_COORDINATE_STEP = 1e-6;

/**
 * Largest per-coordinate difference a faithful text-markup round trip may show,
 * in page-normalized units. PDF.js writes coordinates with `numberToString`,
 * which rounds to two decimals of a PDF unit, and stores quad points as
 * `Float32Array`. On the smallest page this project supports that is well under
 * 1e-4 of the page box (≈0.06 pt on US Letter, roughly a fifteenth of a text
 * pixel at 100% zoom), so the tolerance covers representation loss without
 * covering any movement a reader could see.
 */
export const TEXT_MARKUP_COORDINATE_TOLERANCE = 0.0001;

export interface ICanonicalGeometryMatch {
    readonly countMatches: boolean;
    readonly matched: boolean;
    readonly expectedCount: number;
    readonly reopenedCount: number;
    /** Largest coordinate delta over the matched rects, or over the best available pairing. */
    readonly maxCoordinateDelta: number;
    /** Index into the expected geometry whose closest reopened rect was worst. */
    readonly worstRectIndex: number | null;
}

function roundCanonicalCoordinate(value: number) {
    return Math.round(value / CANONICAL_COORDINATE_STEP) * CANONICAL_COORDINATE_STEP;
}

/**
 * Applies the canonical normal form to one page-display marker rect. The rule
 * is idempotent, so geometry that already passed through it — or through
 * `toMarkerRectFromPdfRect`, which widens degenerate rects the same way — is
 * unchanged by a second pass.
 */
export function toCanonicalTextMarkupRect(
    rect: IAnnotationMarkerRect | null | undefined,
): IAnnotationMarkerRect | null {
    if (!rect || ![
        rect.left,
        rect.top,
        rect.width,
        rect.height,
    ].every(value => typeof value === 'number' && Number.isFinite(value))) {
        return null;
    }
    // Clamp into the page box first, then widen, so a degenerate rect on the
    // far page edge settles instead of oscillating between the two rules.
    const clamped = normalizeMarkerRectBounds({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
    }, { clampSizeToRemaining: true });
    if (!clamped) {
        return null;
    }
    let {
        left,
        top,
        width,
        height,
    } = clamped;
    if (width < MIN_MARKER_RECT_SIZE) {
        left = clamp(left + width / 2 - MIN_MARKER_RECT_SIZE / 2, 0, 1 - MIN_MARKER_RECT_SIZE);
        width = MIN_MARKER_RECT_SIZE;
    }
    if (height < MIN_MARKER_RECT_SIZE) {
        top = clamp(top + height / 2 - MIN_MARKER_RECT_SIZE / 2, 0, 1 - MIN_MARKER_RECT_SIZE);
        height = MIN_MARKER_RECT_SIZE;
    }
    return {
        left: roundCanonicalCoordinate(left),
        top: roundCanonicalCoordinate(top),
        width: roundCanonicalCoordinate(width),
        height: roundCanonicalCoordinate(height),
    };
}

/** Applies the canonical normal form to authored marker geometry. */
export function toCanonicalTextMarkupGeometry(geometry: readonly IAnnotationMarkerRect[]) {
    return geometry.flatMap((rect) => {
        const canonical = toCanonicalTextMarkupRect(rect);
        return canonical ? [canonical] : [];
    });
}

function coordinateDelta(left: IAnnotationMarkerRect, right: IAnnotationMarkerRect) {
    return Math.max(
        Math.abs(left.left - right.left),
        Math.abs(left.top - right.top),
        Math.abs(left.width - right.width),
        Math.abs(left.height - right.height),
    );
}

/**
 * Pairs authored geometry with reopened geometry as multisets. Each expected
 * rect claims its closest unclaimed reopened rect, so quad reordering is not a
 * fidelity failure, and the worst pairing distance is reported either way.
 */
export function matchCanonicalTextMarkupGeometry(
    expected: readonly IAnnotationMarkerRect[],
    reopened: readonly IAnnotationMarkerRect[],
    tolerance = TEXT_MARKUP_COORDINATE_TOLERANCE,
): ICanonicalGeometryMatch {
    const claimed = new Set<number>();
    let maxCoordinateDelta = 0;
    let worstRectIndex: number | null = null;
    let matched = true;
    for (const [
        expectedIndex,
        expectedRect,
    ] of expected.entries()) {
        let bestIndex: number | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const [
            reopenedIndex,
            reopenedRect,
        ] of reopened.entries()) {
            if (claimed.has(reopenedIndex)) {
                continue;
            }
            const delta = coordinateDelta(expectedRect, reopenedRect);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestIndex = reopenedIndex;
            }
        }
        if (bestIndex === null) {
            matched = false;
            continue;
        }
        claimed.add(bestIndex);
        if (bestDelta > tolerance) {
            matched = false;
        }
        if (bestDelta > maxCoordinateDelta) {
            maxCoordinateDelta = bestDelta;
            worstRectIndex = expectedIndex;
        }
    }
    const countMatches = expected.length === reopened.length;
    return {
        countMatches,
        matched: Boolean(matched) && countMatches,
        expectedCount: expected.length,
        reopenedCount: reopened.length,
        maxCoordinateDelta,
        worstRectIndex,
    };
}
