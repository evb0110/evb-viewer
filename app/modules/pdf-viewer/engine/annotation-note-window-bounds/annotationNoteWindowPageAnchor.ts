import type { IAnnotationNoteWindowBounds } from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowBounds';

type TPageRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/** Window top-left corner as a fraction of its page box, so scroll and zoom both carry the window with the page. */
export interface IAnnotationNoteWindowPageAnchor {
    u: number;
    v: number;
}

const NOTE_WINDOW_SHADOW_REACH = 24;

export function captureAnnotationNoteWindowPageAnchor(
    x: number,
    y: number,
    pageRect: TPageRect,
): IAnnotationNoteWindowPageAnchor {
    return {
        u: (x - pageRect.left) / pageRect.width,
        v: (y - pageRect.top) / pageRect.height,
    };
}

export function resolveAnnotationNoteWindowPagePosition(
    anchor: IAnnotationNoteWindowPageAnchor,
    pageRect: TPageRect,
) {
    return {
        x: Math.round(pageRect.left + anchor.u * pageRect.width),
        y: Math.round(pageRect.top + anchor.v * pageRect.height),
    };
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
