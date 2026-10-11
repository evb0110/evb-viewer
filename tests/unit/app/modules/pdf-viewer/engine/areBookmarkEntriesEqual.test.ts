import { requirePageIndex } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import { areBookmarkEntriesEqual } from '@app/modules/pdf-viewer/engine/pdf-outline-tree/areBookmarkEntriesEqual';
import { cast } from '@tests/helpers/cast';

function createEntry(
    title: string,
    overrides: Partial<IPdfBookmarkEntry> = {},
): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: requirePageIndex(3),
        pageYRatio: 0.5,
        namedDest: 'anchor',
        bold: false,
        italic: false,
        color: '#112233',
        items: [],
        ...overrides,
    };
}

function createTree(): IPdfBookmarkEntry[] {
    return [
        createEntry('Cover', {
            pageIndex: requirePageIndex(0),
            pageYRatio: null,
            namedDest: null,
            color: null,
        }),
        createEntry('Chapter', { items: [
            createEntry('Section one'),
            createEntry('Section two', {
                pageIndex: requirePageIndex(4),
                bold: true,
            }),
        ] }),
    ];
}

function expectSymmetricEquality(
    left: IPdfBookmarkEntry[],
    right: IPdfBookmarkEntry[],
    expected: boolean,
) {
    expect(areBookmarkEntriesEqual(left, right)).toBe(expected);
    expect(areBookmarkEntriesEqual(right, left)).toBe(expected);
}

describe('areBookmarkEntriesEqual', () => {
    it('distinguishes original destination kinds and null coordinates that change saved navigation', () => {
        const originalDestination = {
            kind: 'FitH' as const,
            sourceTarget: 0,
            coordinates: [null],
        };
        const left = [createEntry('Source', {originalDestination})];
        expectSymmetricEquality(left, [createEntry('Source', {originalDestination: {...originalDestination}})], true);
        expectSymmetricEquality(left, [createEntry('Source', {originalDestination: {
            ...originalDestination,
            coordinates: [0],
        }})], false);
        expectSymmetricEquality(left, [createEntry('Source')], false);
    });

    it('ignores key order, untrimmed titles, and equivalent color spellings', () => {
        const rebuilt: IPdfBookmarkEntry[] = [
            {
                items: [],
                color: null,
                italic: false,
                bold: false,
                namedDest: null,
                pageIndex: requirePageIndex(0),
                title: 'Cover',
            },
            {
                title: '  Chapter  ',
                namedDest: 'anchor',
                pageIndex: requirePageIndex(3),
                pageYRatio: 0.5,
                bold: false,
                italic: false,
                color: '#112233',
                items: [
                    createEntry('Section one'),
                    {
                        title: 'Section two',
                        pageIndex: requirePageIndex(4),
                        pageYRatio: 0.5,
                        namedDest: 'anchor',
                        bold: true,
                        italic: false,
                        color: '#123',
                        items: [],
                    },
                ],
            },
        ];

        expectSymmetricEquality(createTree(), rebuilt, true);
    });

    it('ignores serialization artifacts that persistence would normalize away', () => {
        const artifacts = [cast<IPdfBookmarkEntry>({
            title: 'Chapter',
            pageIndex: 3,
            pageYRatio: 0.5,
            namedDest: 'anchor',
            bold: false,
            italic: false,
            items: [],
            unknownField: 'ignored',
        })];

        expectSymmetricEquality([createEntry('Chapter', { color: null })], artifacts, true);
    });

    it('treats a missing pageYRatio the same as an explicit null', () => {
        const withNull = [createEntry('Chapter', { pageYRatio: null })];
        const {
            pageYRatio: unusedPageYRatio,
            ...withoutRatioEntry
        } = createEntry('Chapter');
        void unusedPageYRatio;
        const withoutRatio = [withoutRatioEntry];

        expectSymmetricEquality(withNull, withoutRatio, true);
    });

    it.each([
        [
            'title',
            { title: 'Renamed' },
        ],
        [
            'pageIndex',
            { pageIndex: requirePageIndex(9) },
        ],
        [
            'pageYRatio',
            { pageYRatio: 0.75 },
        ],
        [
            'namedDest',
            { namedDest: 'other-anchor' },
        ],
        [
            'bold',
            { bold: true },
        ],
        [
            'italic',
            { italic: true },
        ],
        [
            'color',
            { color: '#445566' },
        ],
    ])('detects a change to the persisted %s field', (_field, overrides) => {
        const changed = createTree();
        changed[1] = createEntry('Chapter', {
            items: changed[1]?.items ?? [],
            ...overrides,
        });

        expectSymmetricEquality(createTree(), changed, false);
    });

    it('detects a change nested deep in the tree', () => {
        const changed = createTree();
        const section = changed[1]?.items[1];
        expect(section).toBeDefined();
        if (section) {
            const chapter = changed[1];
            if (chapter) {
                changed[1] = {
                    ...chapter,
                    items: chapter.items.map(entry => entry === section
                        ? {
                            ...entry,
                            italic: true,
                        }
                        : entry),
                };
            }
        }

        expectSymmetricEquality(createTree(), changed, false);
    });

    it('detects meaningful sibling reordering at any depth', () => {
        const rootSwapped = createTree().toReversed();
        const childSwapped = createTree();
        const children = childSwapped[1]?.items ?? [];
        childSwapped[1] = createEntry('Chapter', { items: children.toReversed() });

        expectSymmetricEquality(createTree(), rootSwapped, false);
        expectSymmetricEquality(createTree(), childSwapped, false);
    });

    it('detects added and removed nodes', () => {
        const added = createTree();
        const addedChapter = added[1];
        if (addedChapter) {
            added[1] = {
                ...addedChapter,
                items: [
                    ...addedChapter.items,
                    createEntry('Section three'),
                ],
            };
        }
        const removed = createTree();
        const removedChapter = removed[1];
        if (removedChapter) {
            removed[1] = {
                ...removedChapter,
                items: removedChapter.items.slice(0, -1),
            };
        }

        expectSymmetricEquality(createTree(), added, false);
        expectSymmetricEquality(createTree(), removed, false);
    });

    it('survives entries whose title never made it through a malformed payload', () => {
        const malformed = [cast<IPdfBookmarkEntry>({
            pageIndex: 3,
            pageYRatio: 0.5,
            namedDest: 'anchor',
            bold: false,
            italic: false,
            color: '#112233',
            items: [],
        })];

        expectSymmetricEquality([createEntry('')], malformed, true);
        expectSymmetricEquality([createEntry('Chapter')], malformed, false);
    });

    it('treats empty, null, and undefined outlines as equal', () => {
        expect(areBookmarkEntriesEqual([], [])).toBe(true);
        expect(areBookmarkEntriesEqual(null, [])).toBe(true);
        expect(areBookmarkEntriesEqual(undefined, null)).toBe(true);
        expect(areBookmarkEntriesEqual([createEntry('Chapter')], [])).toBe(false);
    });

    it('compares large outlines without quadratic work', () => {
        function createLargeTree(): IPdfBookmarkEntry[] {
            return Array.from({ length: 2000 }, (_unused, index) => createEntry(`Section ${index}`, {
                pageIndex: requirePageIndex(index),
                items: Array.from({ length: 4 }, (_child, childIndex) => createEntry(`Section ${index}.${childIndex}`, { pageIndex: requirePageIndex(index)})),
            }));
        }

        const left = createLargeTree();
        const right = createLargeTree();
        const divergent = createLargeTree();
        const lastRoot = divergent.at(-1);
        const lastChild = lastRoot?.items.at(-1);
        expect(lastChild).toBeDefined();
        if (lastRoot && lastChild) {
            divergent[divergent.length - 1] = {
                ...lastRoot,
                items: lastRoot.items.map(entry => entry === lastChild
                    ? {
                        ...entry,
                        bold: true,
                    }
                    : entry),
            };
        }

        expect(areBookmarkEntriesEqual(left, right)).toBe(true);
        expect(areBookmarkEntriesEqual(left, divergent)).toBe(false);
    });
});
