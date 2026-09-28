import {
    describe,
    expect,
    it,
} from 'vitest';
import {parseDjvuOutline} from '@electron/features/djvu/main/parseDjvuOutline';

describe('parseDjvuOutline', () => {
    it('preserves nested bookmark structure and page destinations', () => {
        expect(parseDjvuOutline('(bookmarks ("Part" "#2" ("Chapter" "#7")))')).toEqual([{
            title: 'Part',
            pageIndex: 1,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [{
                title: 'Chapter',
                pageIndex: 6,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
        }]);
    });

    it('resolves component ID targets through the DjVu document page map', () => {
        const pageComponents = new Map([
            [
                'p0001.djvu',
                0,
            ],
            [
                'p0002.djvu',
                1,
            ],
        ]);
        expect(parseDjvuOutline('(bookmarks ("Second" "#p0002.djvu"))', pageComponents)[0]?.pageIndex).toBe(1);
    });

    it('rejects outlines deeper than the interactive nesting limit', () => {
        const outline = `${'('.repeat(65)}bookmarks${')'.repeat(65)}`;

        expect(() => parseDjvuOutline(outline)).toThrow('nesting is capped at 64');
    });
});
