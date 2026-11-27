import {describe, expect, it} from 'vitest';
import {
    createAllPageNumbers,
    createPageSelectionFromRange,
    expandPageRange,
    normalizeSelectedPageNumbers,
    resolveThumbnailContextMenuPages,
    shouldSelectPageFromThumbnailClick,
} from '@app/utils/pdfPageSelection';

describe('pdf page selection helpers', () => {
    it('normalizes selected pages by removing duplicates and invalid pages', () => {
        expect(normalizeSelectedPageNumbers([4, 2, 2, 0, 3.5, 6, 1], 4)).toEqual([1, 2, 4]);
    });

    it('expands a parsed page range into page numbers', () => {
        expect(
            expandPageRange({
                startPage: 2,
                endPage: 5,
            }),
        ).toEqual([2, 3, 4, 5]);
    });

    it('keeps null page ranges null', () => {
        expect(expandPageRange(null)).toBeNull();
    });

    it('keeps a million-page parsed range compact', () => {
        expect(
            createPageSelectionFromRange(
                {
                    startPage: 1,
                    endPage: 1_000_000,
                },
                1_000_000,
            ),
        ).toEqual({
            kind: 'range',
            pageCount: 1_000_000,
            startPage: 1,
            endPage: 1_000_000,
        });
    });

    it('creates one-based page numbers', () => {
        expect(createAllPageNumbers(4)).toEqual([1, 2, 3, 4]);
    });

    it('treats plain thumbnail clicks as navigation-only', () => {
        expect(
            shouldSelectPageFromThumbnailClick({
                shiftKey: false,
                metaKey: false,
                ctrlKey: false,
            }),
        ).toBe(false);
    });

    it.each([{shiftKey: true}, {metaKey: true}, {ctrlKey: true}])(
        'selects pages from thumbnail clicks with selection modifier %#',
        (modifiers) => {
            expect(shouldSelectPageFromThumbnailClick(modifiers)).toBe(true);
        },
    );

    it('targets only the clicked page when opening a context menu on an unselected thumbnail', () => {
        expect(resolveThumbnailContextMenuPages(5, [2, 3], 6)).toEqual([5]);
    });

    it('keeps the current selection as the context menu target when right-clicking a selected thumbnail', () => {
        expect(resolveThumbnailContextMenuPages(3, [2, 3], 6)).toEqual([2, 3]);
    });
});
