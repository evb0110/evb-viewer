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
        pageIndex: 3,
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
            pageIndex: 0,
            pageYRatio: null,
            namedDest: null,
            color: null,
        }),
        createEntry('Chapter', { items: [
            createEntry('Section one'),
            createEntry('Section two', {
                pageIndex: 4,
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
    it('ignores key order, untrimmed titles, and equivalent color spellings', () => {
        const rebuilt: IPdfBookmarkEntry[] = [
            {
                items: [],
                color: null,
                italic: false,
                bold: false,
                namedDest: null,
                pageIndex: 0,
                title: 'Cover',
            },
            {
                title: '  Chapter  ',
                namedDest: 'anchor',
                pageIndex: 3,
                pageYRatio: 0.5,
                bold: false,
                italic: false,
                color: '#112233',
                items: [
                    createEntry('Section one'),
                    {
                        title: 'Section two',
                        pageIndex: 4,
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
        const withoutRatio = [createEntry('Chapter')];
        delete withoutRatio[0]?.pageYRatio;

        expectSymmetricEquality(withNull, withoutRatio, true);
    });

    it.each([
        [
            'title',
            { title: 'Renamed' },
        ],
        [
            'pageIndex',
            { pageIndex: 9 },
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
            section.italic = true;
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
        added[1]?.items.push(createEntry('Section three'));
        const removed = createTree();
        removed[1]?.items.pop();

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
                pageIndex: index,
                items: Array.from({ length: 4 }, (_child, childIndex) => createEntry(`Section ${index}.${childIndex}`, { pageIndex: index })),
            }));
        }

        const left = createLargeTree();
        const right = createLargeTree();
        const divergent = createLargeTree();
        const lastChild = divergent.at(-1)?.items.at(-1);
        expect(lastChild).toBeDefined();
        if (lastChild) {
            lastChild.bold = true;
        }

        expect(areBookmarkEntriesEqual(left, right)).toBe(true);
        expect(areBookmarkEntriesEqual(left, divergent)).toBe(false);
    });
});
