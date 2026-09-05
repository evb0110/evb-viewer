import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    offsetPdfCombineBookmarks,
    PDF_COMBINE_CATALOG_POLICY,
} from '@pdf-core';

describe('PDF combine catalog policy', () => {
    it('offsets outline destinations recursively', () => {
        const bookmarks = [{
            title: 'Chapter',
            pageIndex: 1,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [{
                title: 'Section',
                pageIndex: 2,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
        }];
        expect(offsetPdfCombineBookmarks(bookmarks, 4)).toEqual([expect.objectContaining({
            title: 'Chapter',
            pageIndex: 5,
            items: [expect.objectContaining({pageIndex: 6})],
        })]);
    });

    it('declares every document-catalog semantic used by the planner', () => {
        expect(PDF_COMBINE_CATALOG_POLICY).toEqual(expect.objectContaining({
            pages: 'preserve',
            outlines: 'preserve-and-remap-destinations',
            pageLabels: 'preserve-and-offset-number-tree',
            forms: 'reject',
            attachments: 'reject',
            javascript: 'reject',
        }));
    });
});
