import {NOTE_WINDOW} from '@app/constants/pdfLayout';
import {clamp} from 'es-toolkit/math';
import type {IAnnotationNoteWindowBounds} from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowBounds';

export function clampAnnotationNoteWindowPosition(
    x: number,
    y: number,
    nextWidth: number,
    nextHeight: number,
    bounds: IAnnotationNoteWindowBounds | null,
) {
    if (!bounds) {
        return {
            x,
            y,
        };
    }

    const minX = bounds.left + NOTE_WINDOW.MARGIN;
    const minY = bounds.top + NOTE_WINDOW.MARGIN;
    const maxX = Math.max(minX, bounds.right - nextWidth - NOTE_WINDOW.MARGIN);
    const maxY = Math.max(minY, bounds.bottom - nextHeight - NOTE_WINDOW.MARGIN);

    return {
        x: Math.round(clamp(x, minX, maxX)),
        y: Math.round(clamp(y, minY, maxY)),
    };
}
