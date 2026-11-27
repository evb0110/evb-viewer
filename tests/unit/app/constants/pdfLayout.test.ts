import {describe, expect, it} from 'vitest';
import {NOTE_WINDOW, resolveNoteWindowAnchorZIndex} from '@app/constants/pdfLayout';

describe('resolveNoteWindowAnchorZIndex', () => {
    it('bounds minimized note anchors to the reserved stacking slots', () => {
        expect(resolveNoteWindowAnchorZIndex(-4)).toBe(NOTE_WINDOW.ANCHOR_Z_INDEX_BASE);
        expect(resolveNoteWindowAnchorZIndex(Number.NaN)).toBe(NOTE_WINDOW.ANCHOR_Z_INDEX_BASE);
        expect(resolveNoteWindowAnchorZIndex(2.9)).toBe(NOTE_WINDOW.ANCHOR_Z_INDEX_BASE + 2);
        expect(resolveNoteWindowAnchorZIndex(10_000)).toBe(NOTE_WINDOW.ANCHOR_Z_INDEX_BASE + NOTE_WINDOW.ANCHOR_Z_INDEX_SLOTS - 1);
    });
});
