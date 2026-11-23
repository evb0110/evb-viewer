import { clamp } from 'es-toolkit/math';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

/** The native writer's note icon edge, `TEXT_NOTE_ICON_SIZE_PT` in native/pdf-page-ops/src/annotations.rs. */
const TEXT_NOTE_ICON_SIZE_PT = 20;

interface ITextNotePageGeometry {
    readonly pageView: readonly number[];
    readonly rotation: TPageRotation;
}

// A start of 1 - span can still end past the page once the span is added back in float64, and the
// native save refuses a marker whose start plus span exceeds 1.
function fitInsidePage(start: number, span: number) {
    let fitted = clamp(start, 0, 1 - span);
    while (fitted > 0 && fitted + span > 1) fitted = Math.max(0, fitted - Number.EPSILON);
    return fitted;
}

/**
 * The rect the native writer saves for a note marker (`text_note_pdf_rect`): a 20 pt square centered on the marker,
 * kept inside the page as displayed with its /Rotate. Null where the writer refuses the note: a page view that is not
 * a positive box, or a page under 20 pt on either side.
 */
export function textNoteIconRect(
    marker: IAnnotationMarkerRect,
    pageView: readonly number[],
    pageRotation: TPageRotation,
): IAnnotationMarkerRect | null {
    const [x1, y1, x2, y2] = pageView;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
        return null;
    }
    const swapped = pageRotation === 90 || pageRotation === 270;
    const width = TEXT_NOTE_ICON_SIZE_PT / (swapped ? y2 - y1 : x2 - x1);
    const height = TEXT_NOTE_ICON_SIZE_PT / (swapped ? x2 - x1 : y2 - y1);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 1 || height > 1) {
        return null;
    }
    return {
        left: fitInsidePage(marker.left + (marker.width - width) / 2, width),
        top: fitInsidePage(marker.top + (marker.height - height) / 2, height),
        width,
        height,
    };
}

/** A note's position as the writer will save it, or the given rect while the page geometry is unknown or refused. */
export function textNotePosition(rect: IAnnotationMarkerRect, geometry: ITextNotePageGeometry | null | undefined) {
    return (geometry && textNoteIconRect(rect, geometry.pageView, geometry.rotation)) ?? rect;
}
