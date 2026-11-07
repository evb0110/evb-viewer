import type { IAnnotationNoteWindowBounds } from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowBounds';

import type { IAnnotationMarkerRect } from '@app/types/annotations';

type TPageRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/** Window top-left corner as a fraction of its page box, so scroll and zoom both carry the window with the page. */
export interface IAnnotationNoteWindowPageAnchor {
    u: number;
    v: number;
    marker: IAnnotationMarkerRect | null;
}

const NOTE_WINDOW_SHADOW_REACH = 24;

export function captureAnnotationNoteWindowPageAnchor(
    x: number,
    y: number,
    pageRect: TPageRect,
    marker: IAnnotationMarkerRect | null = null,
): IAnnotationNoteWindowPageAnchor {
    return {
        u: (x - pageRect.left) / pageRect.width,
        v: (y - pageRect.top) / pageRect.height,
        marker,
    };
}

export function resolveAnnotationNoteWindowPagePosition(
    anchor: IAnnotationNoteWindowPageAnchor,
    pageRect: TPageRect,
    marker: IAnnotationMarkerRect | null = null,
) {
    const dx = marker && anchor.marker ? marker.left + marker.width - anchor.marker.left - anchor.marker.width : 0;
    const dy = marker && anchor.marker ? marker.top - anchor.marker.top : 0;
    return {
        x: Math.round(pageRect.left + (anchor.u + dx) * pageRect.width),
        y: Math.round(pageRect.top + (anchor.v + dy) * pageRect.height),
    };
}

/** A note remains available while any part of its anchor page intersects the viewer pane. */
export function isAnnotationNoteWindowPageVisible(
    pageRect: TPageRect,
    bounds: IAnnotationNoteWindowBounds,
) {
    return pageRect.left < bounds.right
        && pageRect.left + pageRect.width > bounds.left
        && pageRect.top < bounds.bottom
        && pageRect.top + pageRect.height > bounds.top;
}

/** The window is fixed-positioned, so a window scrolled past the viewer edge must not paint over the surrounding chrome. */
export function resolveAnnotationNoteWindowClipPath(
    x: number,
    y: number,
    width: number,
    height: number,
    bounds: IAnnotationNoteWindowBounds,
) {
    const insets = [
        bounds.top - y,
        x + width - bounds.right,
        y + height - bounds.bottom,
        bounds.left - x,
    ].map(inset => `${String(Math.max(inset, -NOTE_WINDOW_SHADOW_REACH))}px`);
    return `inset(${insets.join(' ')})`;
}
