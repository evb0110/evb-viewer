import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import {
    normalizeBookmarkEntries,
    rewriteBookmarks,
} from '@app/composables/pdf/usePdfBookmarkSerialization';
import type { IPdfBookmarkEntry } from '@app/types/pdf';

function createBookmark(overrides: Partial<IPdfBookmarkEntry> = {}): IPdfBookmarkEntry {
    return {
        title: 'Bookmark',
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
}

describe('normalizeBookmarkEntries', () => {
    it('normalizes titles, page bounds, colors, and nested items', () => {
        const entries = normalizeBookmarkEntries([createBookmark({
            title: '   ',
            pageIndex: 99,
            namedDest: '   ',
            bold: true,
            color: '#abc',
            items: [createBookmark({
                title: ' Child ',
                pageIndex: -3,
                namedDest: 'DestA',
                italic: true,
                color: '#xyz123',
            })],
        })], 5, 'Untitled');

        expect(entries).toEqual([{
            title: 'Untitled',
            pageIndex: 4,
            namedDest: null,
            bold: true,
            italic: false,
            color: '#aabbcc',
            items: [{
                title: 'Child',
                pageIndex: 0,
                namedDest: 'DestA',
                bold: false,
                italic: true,
                color: null,
                items: [],
            }],
        }]);
    });

    it('returns empty array when no pages exist', () => {
        const entries = normalizeBookmarkEntries([createBookmark()], 0, 'Untitled');
        expect(entries).toEqual([]);
    });
});

describe('rewriteBookmarks', () => {
    it('returns input data on invalid PDF payload', async () => {
        const source = Uint8Array.from([
            1,
            2,
            3,
            4,
        ]);

        const result = await rewriteBookmarks(source, {
            bookmarksDirty: ref(true),
            bookmarkItems: ref([createBookmark()]),
            totalPages: ref(1),
            untitledLabel: 'Untitled',
        });

        expect(result).toBe(source);
    });
});
