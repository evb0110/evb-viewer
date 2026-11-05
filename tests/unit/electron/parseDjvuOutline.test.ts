import {
    describe,
    expect,
    it,
} from 'vitest';
import {parseDjvuOutline} from '@electron/features/djvu/main/parseDjvuOutline';

describe('parseDjvuOutline', () => {
    it.each([
        {
            label: 'octal UTF-8',
            raw: String.raw`\320\223\320\273\320\260\320\262\320\260 caf\303\251`,
            title: 'Глава café',
        },
        {
            label: 'escaped controls, quotes and backslashes decoded once',
            raw: String.raw`line\nnext\t\"quoted\" \\n \\folder`,
            title: 'line\nnext\t"quoted" \\n \\folder',
        },
        {
            label: 'literal Unicode mixed with escapes',
            raw: String.raw`Глава 📖\t続き`,
            title: 'Глава 📖\t続き',
        },
    ])('preserves $label in bookmark titles', ({
        raw, title,
    }) => {
        expect(parseDjvuOutline(`(bookmarks ("${raw}" "#2"))`)).toMatchObject([{
            title,
            pageIndex: 1,
            items: [],
        }]);
    });

    it('preserves literal Unicode without escape sequences', () => {
        expect(parseDjvuOutline('(bookmarks ("Глава café 📖 続き" "#1"))')[0]?.title)
            .toBe('Глава café 📖 続き');
    });

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
        expect(parseDjvuOutline('(bookmarks ("Named" "#nb0003.djvu"))', new Map([[
            'nb0003.djvu',
            2,
        ]]))[0]?.pageIndex).toBe(2);
    });

    it('rejects outlines deeper than the interactive nesting limit', () => {
        const outline = `${'('.repeat(65)}bookmarks${')'.repeat(65)}`;

        expect(() => parseDjvuOutline(outline)).toThrow('nesting is capped at 64');
    });
});
