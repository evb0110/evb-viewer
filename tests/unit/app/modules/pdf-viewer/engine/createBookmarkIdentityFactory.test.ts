import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IBookmarkIdentityInput,
    IBookmarkItem,
} from '@app/types/pdfOutline';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import {
    buildOutlineFromBookmarkEntries,
    buildResolvedOutline,
    parseOutlineItems,
} from '@app/utils/pdfOutlineHelpers';
import { createBookmarkIdentityFactory } from '@app/modules/pdf-viewer/engine/pdf-outline-identity/createBookmarkIdentityFactory';
import { cast } from '@tests/helpers/cast';

function createEntry(
    title: string,
    overrides: Partial<IPdfBookmarkEntry> = {},
): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: 0,
        pageYRatio: null,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
        ...overrides,
    };
}

function buildOutline(entries: IPdfBookmarkEntry[]) {
    const identity = createBookmarkIdentityFactory();
    return buildOutlineFromBookmarkEntries(entries, identity.createBookmarkId);
}

function collectIdsByTitlePath(
    items: readonly IBookmarkItem[],
    prefix = '',
) {
    const ids = new Map<string, string>();
    for (const item of items) {
        const path = `${prefix}/${item.title}`;
        ids.set(path, item.id);
        for (const [
            childPath,
            childId,
        ] of collectIdsByTitlePath(item.items, path)) {
            ids.set(childPath, childId);
        }
    }
    return ids;
}

function createPdfDocumentStub() {
    return cast<IPdfDocument>({
        numPages: 10,
        getDestination: vi.fn(async (_name: string) => [
            {
                num: 12,
                gen: 0,
            },
            { name: 'Fit' },
        ]),
        getPageIndex: vi.fn(async (_ref: unknown) => 3),
        getPage: vi.fn(async (_pageNumber: number) => cast<IPdfPage>({
            view: [
                0,
                0,
                612,
                792,
            ],
            getViewport: vi.fn(() => ({ height: 792 })),
        })),
    });
}

function collectAllIds(items: readonly IBookmarkItem[]): string[] {
    return items.flatMap(item => [
        item.id,
        ...collectAllIds(item.items),
    ]);
}

describe('createBookmarkIdentityFactory', () => {
    it('keeps identity stable when unrelated siblings are inserted, removed, or reordered', () => {
        const first = createEntry('Alpha', { pageIndex: 1 });
        const second = createEntry('Beta', { pageIndex: 2 });
        const third = createEntry('Gamma', { pageIndex: 3 });

        const baseline = collectIdsByTitlePath(buildOutline([
            first,
            second,
            third,
        ]));
        const withInsertion = collectIdsByTitlePath(buildOutline([
            createEntry('Inserted', { pageIndex: 0 }),
            first,
            second,
            third,
        ]));
        const withRemoval = collectIdsByTitlePath(buildOutline([
            first,
            third,
        ]));
        const reordered = collectIdsByTitlePath(buildOutline([
            third,
            second,
            first,
        ]));

        for (const path of [
            '/Alpha',
            '/Gamma',
        ]) {
            expect(withInsertion.get(path)).toBe(baseline.get(path));
            expect(withRemoval.get(path)).toBe(baseline.get(path));
            expect(reordered.get(path)).toBe(baseline.get(path));
        }
        expect(withInsertion.get('/Beta')).toBe(baseline.get('/Beta'));
        expect(reordered.get('/Beta')).toBe(baseline.get('/Beta'));
    });

    it('separates identical labels and targets living under different ancestors', () => {
        const child = createEntry('Introduction', {
            pageIndex: 7,
            namedDest: 'intro',
        });
        const outline = buildOutline([
            createEntry('Part one', { items: [child] }),
            createEntry('Part two', { items: [child] }),
        ]);

        const firstChildId = outline[0]?.items[0]?.id;
        const secondChildId = outline[1]?.items[0]?.id;
        expect(firstChildId).toBeTruthy();
        expect(secondChildId).toBeTruthy();
        expect(firstChildId).not.toBe(secondChildId);
    });

    it('separates duplicate siblings and keeps their identity across unrelated edits', () => {
        const duplicate = createEntry('Plate', {
            pageIndex: 12,
            namedDest: 'plate',
        });
        const baseline = collectAllIds(buildOutline([
            duplicate,
            duplicate,
            createEntry('Notes', { pageIndex: 20 }),
        ]));
        const withUnrelatedInsertion = collectAllIds(buildOutline([
            createEntry('Preface', { pageIndex: 1 }),
            duplicate,
            duplicate,
            createEntry('Notes', { pageIndex: 20 }),
        ]));

        expect(new Set(baseline).size).toBe(baseline.length);
        expect(withUnrelatedInsertion.slice(1)).toEqual(baseline);
        // Duplicates are told apart by their occurrence, which is part of the
        // hashed content path. The uniqueness suffix is a last resort for hash
        // collisions and must not be what carries ordinary duplicate labels.
        expect(baseline.filter(id => id.includes('~'))).toEqual([]);
    });

    it('rebuilds the same identity from persisted entries after a reload', () => {
        const entries = [
            createEntry('Cover', { pageIndex: 0 }),
            createEntry('Chapter', {
                pageIndex: 4,
                namedDest: 'chapter-1',
                items: [createEntry('Section', {
                    pageIndex: 5,
                    pageYRatio: 0.25,
                })],
            }),
        ];

        expect(collectAllIds(buildOutline(entries)))
            .toEqual(collectAllIds(buildOutline(structuredClone(entries))));
    });

    it('matches identity between a PDF-resolved outline and its persisted projection', async () => {
        const pdfDocument = createPdfDocumentStub();
        const rawItems = parseOutlineItems([{
            title: 'Chapter',
            dest: 'chapter-1',
            items: [{
                title: 'Section',
                dest: null,
            }],
        }]);

        const resolved = await buildResolvedOutline(
            rawItems,
            pdfDocument,
            new Map(),
            new Map(),
            createBookmarkIdentityFactory().createBookmarkId,
        );
        expect(resolved[0]?.pageIndex).toBe(3);
        const persisted = buildOutline([createEntry('Chapter', {
            pageIndex: 3,
            namedDest: 'chapter-1',
            items: [createEntry('Section', { pageIndex: null })],
        })]);

        expect(collectAllIds(resolved)).toEqual(collectAllIds(persisted));
    });

    it('leaves array destinations out of identity, since persistence cannot round trip them', async () => {
        const resolved = await buildResolvedOutline(
            parseOutlineItems([{
                title: 'Chapter',
                dest: [
                    {
                        num: 12,
                        gen: 0,
                    },
                    { name: 'Fit' },
                ],
                items: [{
                    title: 'Section',
                    dest: null,
                }],
            }]),
            createPdfDocumentStub(),
            new Map(),
            new Map(),
            createBookmarkIdentityFactory().createBookmarkId,
        );

        // The array destination is dropped on save, so the reloaded entry
        // carries no `namedDest`; identity has to reach the same ids from both.
        expect(Array.isArray(resolved[0]?.dest)).toBe(true);
        expect(collectAllIds(resolved)).toEqual(collectAllIds(buildOutline([createEntry('Chapter', {
            pageIndex: 3,
            namedDest: null,
            items: [createEntry('Section', { pageIndex: null })],
        })])));
    });

    it('normalizes the title exactly as persistence writes it', () => {
        function mintId(title: string) {
            return createBookmarkIdentityFactory({ untitledLabel: 'Untitled' }).createBookmarkId({
                parentId: null,
                title,
                pageIndex: 2,
                dest: null,
            });
        }

        // Persistence trims titles and substitutes its untitled label for a
        // blank one, so identity has to do both or a reload would rename the
        // bookmark out of its own id.
        expect(mintId('  Chapter  ')).toBe(mintId('Chapter'));
        expect(mintId('   ')).toBe(mintId('Untitled'));
        expect(mintId('')).not.toBe(mintId('Chapter'));
    });

    it('keeps deep-path identity distinct per branch and stable across root insertions', () => {
        function createChain(rootTitle: string, depth: number): IPdfBookmarkEntry {
            let entry = createEntry('Leaf', { pageIndex: depth });
            for (let level = depth; level > 0; level -= 1) {
                entry = createEntry(`Level ${level}`, { items: [entry] });
            }
            return createEntry(rootTitle, { items: [entry] });
        }

        const branches = [
            createChain('Branch A', 60),
            createChain('Branch B', 60),
        ];
        const baseline = buildOutline(branches);
        const withRootInsertion = buildOutline([
            createEntry('New root', { pageIndex: 0 }),
            ...branches,
        ]);

        const baselineIds = collectAllIds(baseline);
        const insertionIds = collectAllIds(withRootInsertion);
        expect(new Set(baselineIds).size).toBe(baselineIds.length);
        expect(insertionIds.slice(1)).toEqual(baselineIds);
    });

    it('issues collision-free ids for a large synthetic outline', () => {
        const entries = Array.from({ length: 600 }, (_unused, sectionIndex) => createEntry('Section', {
            pageIndex: sectionIndex % 7,
            items: Array.from({ length: 5 }, () => createEntry('Figure', { pageIndex: sectionIndex % 7 })),
        }));

        const ids = collectAllIds(buildOutline(entries));

        expect(ids).toHaveLength(600 * 6);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('still issues ids when a malformed entry carries no title', () => {
        const outline = buildOutline([
            cast<IPdfBookmarkEntry>({
                pageIndex: 2,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }),
            createEntry('Named', { pageIndex: 2 }),
        ]);

        const ids = collectAllIds(outline);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
    });

    it('issues unique draft ids that never collide with content-derived ids', () => {
        const identity = createBookmarkIdentityFactory();
        const contentId = identity.createBookmarkId({
            parentId: null,
            title: 'Draft',
            pageIndex: 0,
            dest: null,
        });
        const drafts = [
            identity.createDraftBookmarkId(),
            identity.createDraftBookmarkId(),
        ];

        expect(new Set([
            contentId,
            ...drafts,
        ]).size).toBe(3);
    });

    it('keeps identity fields unambiguous when a title carries the separator and adjacent-looking digits', () => {
        const cases: Array<{
            label: string;
            input: IBookmarkIdentityInput;
        }> = [
            {
                label: 'page index folded into the title',
                input: {
                    parentId: null,
                    title: 'Intro|7',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'the same values as separate fields',
                input: {
                    parentId: null,
                    title: 'Intro',
                    pageIndex: 7,
                    dest: null,
                },
            },
            {
                label: 'the same digits carried by the destination instead',
                input: {
                    parentId: null,
                    title: 'Intro',
                    pageIndex: null,
                    dest: '7',
                },
            },
            {
                label: 'title swallowing the page index and the empty-destination marker',
                input: {
                    parentId: null,
                    title: 'Intro|7|n',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'title opening with a length prefix of its own',
                input: {
                    parentId: null,
                    title: '5|Intro',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'the length prefix and the label split across title and destination',
                input: {
                    parentId: null,
                    title: '5',
                    pageIndex: null,
                    dest: 'Intro',
                },
            },
            {
                label: 'title impersonating the trailing occurrence field',
                input: {
                    parentId: null,
                    title: 'Plate',
                    pageIndex: null,
                    dest: '1|0',
                },
            },
            {
                label: 'the same label with no destination at occurrence zero',
                input: {
                    parentId: null,
                    title: 'Plate',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'title spelling the null marker',
                input: {
                    parentId: null,
                    title: 'n',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'empty title, which normalizes to the empty string rather than null',
                input: {
                    parentId: null,
                    title: '',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'a parent path whose tail is folded into the label',
                input: {
                    parentId: 'chapter|section',
                    title: 'Figure 7',
                    pageIndex: 7,
                    dest: null,
                },
            },
            {
                label: 'the same path split one boundary earlier',
                input: {
                    parentId: 'chapter',
                    title: 'section|Figure 7',
                    pageIndex: 7,
                    dest: null,
                },
            },
            {
                label: 'digits that read as a page index carried by the label',
                input: {
                    parentId: 'bookmark-1',
                    title: 'Intro|7',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'the same digits sitting at the end of the parent id',
                input: {
                    parentId: 'bookmark-1|Intro',
                    title: '7',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'parent id and label as separate fields',
                input: {
                    parentId: 'bookmark-1',
                    title: 'Section',
                    pageIndex: null,
                    dest: null,
                },
            },
            {
                label: 'the same parent id and label folded into one title',
                input: {
                    parentId: null,
                    title: 'bookmark-1|Section',
                    pageIndex: null,
                    dest: null,
                },
            },
        ];

        const isolatedIds = cases.map(({input}) => createBookmarkIdentityFactory().createBookmarkId(input));
        const labelsById = new Map<string, string[]>();
        for (const [
            index,
            id,
        ] of isolatedIds.entries()) {
            labelsById.set(id, [
                ...labelsById.get(id) ?? [],
                cases[index]?.label ?? '',
            ]);
        }
        const collisions = [...labelsById.values()].filter(labels => labels.length > 1);
        expect(collisions).toEqual([]);

        // Minted from one factory the ids must be identical, which they can only
        // be if no pair needed the uniqueness suffix to be told apart.
        const sharedIdentity = createBookmarkIdentityFactory();
        expect(cases.map(({input}) => sharedIdentity.createBookmarkId(input))).toEqual(isolatedIds);
    });

    it('keeps outline ids distinct when a label impersonates a sibling\'s page index', () => {
        const ids = collectAllIds(buildOutline([
            createEntry('Chapter|7', { pageIndex: null }),
            createEntry('Chapter', { pageIndex: 7 }),
            createEntry('Chapter', {
                pageIndex: null,
                namedDest: '7',
            }),
        ]));

        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3);
        expect(ids.filter(id => id.includes('~'))).toEqual([]);
    });
});
