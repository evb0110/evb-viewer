import {describe, expect, it} from 'vitest';
import {buildDjvuPageComponentMap, normalizeDjvuOutlineTree, resolveDjvuOutlineUrlToPageIndex} from '@djvu-core/djvuOutline';
import type {IDjvuOutlineRawItem} from '@djvu-core/djvuLibreTypes';

describe('djvuOutline', () => {
    it('preserves Unicode and punctuation in bookmark titles', () => {
        const raw: IDjvuOutlineRawItem[] = [
            {
                title: 'Глава café 📖 続き',
                url: '#2',
                children: [],
            },
            {
                title: 'line\nnext\t"quoted" \\n \\folder',
                url: '#1',
                children: [],
            },
        ];

        expect(normalizeDjvuOutlineTree(raw)).toMatchObject([
            {
                title: 'Глава café 📖 続き',
                pageIndex: 1,
                items: [],
            },
            {
                title: 'line\nnext\t"quoted" \\n \\folder',
                pageIndex: 0,
                items: [],
            },
        ]);
    });

    it('preserves nested bookmark structure and page destinations', () => {
        const raw: IDjvuOutlineRawItem[] = [
            {
                title: 'Part',
                url: '#2',
                children: [
                    {
                        title: 'Chapter',
                        url: '#7',
                        children: [],
                    },
                ],
            },
        ];

        expect(normalizeDjvuOutlineTree(raw)).toEqual([
            {
                title: 'Part',
                pageIndex: 1,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [
                    {
                        title: 'Chapter',
                        pageIndex: 6,
                        namedDest: null,
                        bold: false,
                        italic: false,
                        color: null,
                        items: [],
                    },
                ],
            },
        ]);
    });

    it('resolves component ID targets through the DjVu document page map', () => {
        const pageComponents = buildDjvuPageComponentMap([
            {
                id: 'p0001.djvu',
                name: 'p0001.djvu',
                title: '',
                pageNumber: 1,
                size: 100,
                type: 'page',
            },
            {
                id: 'p0002.djvu',
                name: 'p0002.djvu',
                title: '',
                pageNumber: 2,
                size: 100,
                type: 'page',
            },
            {
                id: 'shared.djbz',
                name: 'shared.djbz',
                title: '',
                pageNumber: null,
                size: 50,
                type: 'include',
            },
            {
                id: 'nb0003.djvu',
                name: 'nb0003.djvu',
                title: '',
                pageNumber: 3,
                size: 100,
                type: 'page',
            },
        ]);

        expect(resolveDjvuOutlineUrlToPageIndex('#p0002.djvu', pageComponents)).toBe(1);
        expect(resolveDjvuOutlineUrlToPageIndex('#nb0003.djvu', pageComponents)).toBe(2);
        expect(resolveDjvuOutlineUrlToPageIndex('#shared.djbz', pageComponents)).toBeNull();
        expect(resolveDjvuOutlineUrlToPageIndex('#99', pageComponents, 3)).toBeNull();
    });

    it('rejects outlines deeper than the interactive nesting limit', () => {
        let node: IDjvuOutlineRawItem = {
            title: 'Leaf',
            url: '#1',
            children: [],
        };
        for (let depth = 0; depth < 65; depth += 1) {
            node = {
                title: `Level ${depth}`,
                url: '#1',
                children: [node],
            };
        }

        expect(() => normalizeDjvuOutlineTree([node])).toThrow('nesting is capped at 64');
    });
});
