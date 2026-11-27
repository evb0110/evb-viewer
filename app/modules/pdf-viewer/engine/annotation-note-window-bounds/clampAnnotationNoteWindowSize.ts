import {NOTE_WINDOW} from '@app/constants/pdfLayout';
import {clamp} from 'es-toolkit/math';
import type {IAnnotationNoteWindowBounds} from '@app/modules/pdf-viewer/engine/annotation-note-window-bounds/annotationNoteWindowBounds';

export function clampAnnotationNoteWindowSize(nextWidth: number, nextHeight: number, bounds: IAnnotationNoteWindowBounds | null) {
    if (!bounds) {
        return {
            width: Math.max(NOTE_WINDOW.MIN_WIDTH, Math.round(nextWidth)),
            height: Math.max(NOTE_WINDOW.MIN_HEIGHT, Math.round(nextHeight)),
        };
    }

    const maxWidth = Math.max(1, Math.round(bounds.width - NOTE_WINDOW.MARGIN * 2));
    const maxHeight = Math.max(1, Math.round(bounds.height - NOTE_WINDOW.MARGIN * 2));
    const minWidth = Math.min(NOTE_WINDOW.MIN_WIDTH, maxWidth);
    const minHeight = Math.min(NOTE_WINDOW.MIN_HEIGHT, maxHeight);

    return {
        width: clamp(Math.round(nextWidth), minWidth, maxWidth),
        height: clamp(Math.round(nextHeight), minHeight, maxHeight),
    };
}
