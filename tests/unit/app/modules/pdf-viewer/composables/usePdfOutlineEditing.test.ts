import {requirePageIndex} from '@contracts/pageNumbers';
import {
    computed,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import { usePdfOutlineEditing } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineEditing';
import {usePdfOutlineDragDrop} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineDragDrop';
import {
    buildResolvedOutline, parseOutlineItems, resolveBookmarkPageTargets,
} from '@app/utils/pdfOutlineHelpers';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {cast} from '@tests/helpers/cast';

function createBookmark(id: string, items: IBookmarkItem[] = []): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items,
    };
}

function createParentMap(items: IBookmarkItem[]) {
    const parents = new Map<string, string | null>();
    const visit = (bookmarkItems: IBookmarkItem[], parentId: string | null) => {
        bookmarkItems.forEach((item) => {
            parents.set(item.id, parentId);
            visit(item.items, item.id);
        });
    };
    visit(items, null);
    return parents;
}

function createOrderMap(items: IBookmarkItem[]) {
    const order = new Map<string, number>();
    let index = 0;
    const visit = (bookmarkItems: IBookmarkItem[]) => {
        bookmarkItems.forEach((item) => {
            order.set(item.id, index);
            index += 1;
            visit(item.items);
        });
    };
    visit(items);
    return order;
}

function createEditingHarness(initialBookmarks: IBookmarkItem[]) {
    const bookmarks = ref(initialBookmarks);
    const activeItemId = ref<string | null>(null);
    const expandedBookmarkIds = ref(new Set<string>());
    const selectedBookmarkIds = ref(new Set<string>());
    const selectionAnchorBookmarkId = ref<string | null>(null);
    const draggingBookmarkIds = ref(new Set<string>());
    const emitBookmarksChange = vi.fn();

    const editing = usePdfOutlineEditing(
        bookmarks,
        activeItemId,
        expandedBookmarkIds,
        ref('top-level'),
        computed(() => true),
        computed(() => createParentMap(bookmarks.value)),
        computed(() => createOrderMap(bookmarks.value)),
        selectedBookmarkIds,
        selectionAnchorBookmarkId,
        draggingBookmarkIds,
        vi.fn((id: string) => {
            selectedBookmarkIds.value = new Set([id]);
            selectionAnchorBookmarkId.value = id;
        }),
        vi.fn(),
        vi.fn(() => {
            draggingBookmarkIds.value = new Set();
        }),
        ref(1),
        emitBookmarksChange,
        vi.fn(() => 'new-bookmark'),
    );

    return {
        bookmarks,
        activeItemId,
        expandedBookmarkIds,
        selectedBookmarkIds,
        selectionAnchorBookmarkId,
        draggingBookmarkIds,
        emitBookmarksChange,
        editing,
    };
}

describe('usePdfOutlineEditing', () => {
    beforeEach(() => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
    });

    it.each([
        'rename',
        'delete',
        'reorder',
    ])('retains source destinations when %s cancels a held lookup', async (operation) => {
        const held = Promise.withResolvers<undefined>();
        const started = Promise.withResolvers<undefined>();
        const pdf = cast<IPdfDocument>({
            numPages: 2,
            getPageIndex: async () => {
                started.resolve(undefined);
                await held.promise;
                return 0;
            },
        });
        let nextId = 0;
        const items = await buildResolvedOutline(parseOutlineItems([
            {
                title: 'first',
                dest: [
                    {
                        num: 1,
                        gen: 0,
                    },
                    {name: 'XYZ'},
                    null,
                    600,
                    null,
                ],
            },
            {
                title: 'second',
                dest: [
                    {
                        num: 2,
                        gen: 0,
                    },
                    {name: 'XYZ'},
                    null,
                    400,
                    null,
                ],
            },
        ]), pdf, new Map(), new Map(), () => String(++nextId), {resolveDestinations: false});
        const controller = new AbortController();
        const resolution = resolveBookmarkPageTargets(pdf, items, new Map(), new Map(), controller.signal);
        await started.promise;
        const harness = createEditingHarness(items);
        harness.emitBookmarksChange.mockImplementation(() => controller.abort());
        if (operation === 'rename') harness.editing.renameBookmark({
            id: '1',
            title: 'renamed',
        });
        else if (operation === 'delete') harness.editing.removeBookmark('1');
        else {
            harness.selectedBookmarkIds.value = new Set(['1']);
            const dragging = usePdfOutlineDragDrop(
                harness.bookmarks, harness.expandedBookmarkIds, computed(() => true), harness.selectedBookmarkIds,
                computed(() => createParentMap(harness.bookmarks.value)), computed(() => createOrderMap(harness.bookmarks.value)),
                vi.fn(), vi.fn(),
            );
            dragging.handleBookmarkDragStart({id: '1'});
            dragging.handleBookmarkDrop({
                targetId: '2',
                position: 'after',
            }, harness.activeItemId, harness.emitBookmarksChange);
        }
        held.resolve(undefined);
        await expect(resolution).rejects.toMatchObject({name: 'AbortError'});
        const saved = harness.editing.mapBookmarksForPersistence(harness.bookmarks.value);
        expect(saved.map(item => item.title)).toEqual(operation === 'rename' ? [
            'renamed',
            'second',
        ] : operation === 'delete' ? ['second'] : [
            'second',
            'first',
        ]);
        expect(saved.map(item => item.originalDestination)).toEqual(harness.bookmarks.value.map(item => ({
            kind: 'XYZ',
            sourceTarget: Array.isArray(item.dest) ? item.dest[0] : null,
            coordinates: Array.isArray(item.dest) ? item.dest.slice(2) : [],
        })));
        expect(saved.every(item => item.pageIndex === null)).toBe(true);
    });

    it.each([
        [
            'XYZ',
            [
                null,
                null,
                null,
            ],
        ],
        [
            'FitH',
            [null],
        ],
        [
            'FitR',
            [
                100,
                200,
                500,
                600,
            ],
        ],
        [
            'Fit',
            [],
        ],
        [
            'FitV',
            [null],
        ],
        [
            'FitB',
            [],
        ],
        [
            'FitBH',
            [25],
        ],
        [
            'FitBV',
            [null],
        ],
    ])('keeps the original %s destination through unrelated edits before lookup completes', (kind, coordinates) => {
        const sourceTarget = {
            num: 17,
            gen: 0,
        };
        const item = {
            ...createBookmark('original'),
            dest: [
                sourceTarget,
                {name: kind},
                ...coordinates,
            ],
        };
        const harness = createEditingHarness([
            item,
            createBookmark('other'),
        ]);
        harness.editing.renameBookmark({
            id: 'original',
            title: 'Renamed',
        });
        harness.editing.toggleBookmarkBold('original');
        harness.editing.removeBookmark('other');
        expect(harness.editing.mapBookmarksForPersistence(harness.bookmarks.value)[0]).toMatchObject({
            title: 'Renamed',
            pageIndex: null,
            originalDestination: {
                kind,
                sourceTarget,
                coordinates,
            },
        });
        // Passive lookup may derive a convenience anchor, but cannot replace the source destination.
        harness.bookmarks.value[0]!.pageIndex = requirePageIndex(0);
        harness.bookmarks.value[0]!.pageYRatio = 0;
        expect(harness.editing.mapBookmarksForPersistence(harness.bookmarks.value)[0]?.originalDestination)
            .toEqual({
                kind,
                sourceTarget,
                coordinates,
            });
    });

    it('removes selected sibling bookmarks in one edit', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'first';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'third',
        ]);

        harness.editing.removeSelectedBookmarks();

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['second']);
        expect(harness.activeItemId.value).toBe('second');
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('removes a selected parent only once when its child is also selected', () => {
        const harness = createEditingHarness([
            createBookmark('parent', [createBookmark('child')]),
            createBookmark('sibling'),
        ]);
        harness.activeItemId.value = 'child';
        harness.expandedBookmarkIds.value = new Set(['parent']);
        harness.selectedBookmarkIds.value = new Set([
            'parent',
            'child',
        ]);
        harness.selectionAnchorBookmarkId.value = 'child';

        harness.editing.removeSelectedBookmarks();

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['sibling']);
        expect(harness.activeItemId.value).toBe('sibling');
        expect(harness.expandedBookmarkIds.value.size).toBe(0);
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.selectionAnchorBookmarkId.value).toBeNull();
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('keeps an existing batch selection when removing an unselected bookmark', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'third';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.removeBookmark('third');

        expect(harness.bookmarks.value.map(item => item.id)).toEqual([
            'first',
            'second',
        ]);
        expect(harness.activeItemId.value).toBe('second');
        expect([...harness.selectedBookmarkIds.value]).toEqual([
            'first',
            'second',
        ]);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('removes the selected roots from a selected context bookmark', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.activeItemId.value = 'first';
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'third',
        ]);

        harness.editing.removeBookmark('first');

        expect(harness.bookmarks.value.map(item => item.id)).toEqual(['second']);
        expect(harness.activeItemId.value).toBe('second');
        expect(harness.selectedBookmarkIds.value.size).toBe(0);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('styles every selected bookmark from a selected context bookmark in one edit', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second', [createBookmark('child')]),
            createBookmark('third'),
        ]);
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.toggleBookmarkBold('second');

        expect(harness.bookmarks.value.map(item => item.bold)).toEqual([
            true,
            true,
            false,
        ]);
        expect(harness.bookmarks.value[1]?.items[0]?.bold).toBe(false);
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('styles only the context bookmark when it is outside the selection', () => {
        const harness = createEditingHarness([
            createBookmark('first'),
            createBookmark('second'),
            createBookmark('third'),
        ]);
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.setBookmarkColor('third', '#1D4ED8');

        expect(harness.bookmarks.value.map(item => item.color)).toEqual([
            null,
            null,
            '#1d4ed8',
        ]);
        expect(harness.selectedBookmarkIds.value).toEqual(new Set([
            'first',
            'second',
        ]));
        expect(harness.emitBookmarksChange).toHaveBeenCalledOnce();
    });

    it('turns a mixed selection fully on before it toggles off', () => {
        const harness = createEditingHarness([
            {
                ...createBookmark('first'),
                italic: true,
            },
            createBookmark('second'),
        ]);
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.toggleBookmarkItalic('first');
        expect(harness.bookmarks.value.map(item => item.italic)).toEqual([
            true,
            true,
        ]);

        harness.editing.toggleBookmarkItalic('second');
        expect(harness.bookmarks.value.map(item => item.italic)).toEqual([
            false,
            false,
        ]);
        expect(harness.emitBookmarksChange).toHaveBeenCalledTimes(2);
    });

    it('does not emit a change when the selection already has the requested style', () => {
        const harness = createEditingHarness([
            {
                ...createBookmark('first'),
                color: '#b91c1c',
            },
            {
                ...createBookmark('second'),
                color: '#b91c1c',
            },
        ]);
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        harness.editing.setBookmarkColor('first', '#B91C1C');

        expect(harness.emitBookmarksChange).not.toHaveBeenCalled();
    });

    it('summarizes the style shared by the context bookmark targets', () => {
        const harness = createEditingHarness([
            {
                ...createBookmark('first'),
                bold: true,
                color: '#047857',
            },
            {
                ...createBookmark('second'),
                bold: true,
                italic: true,
            },
            createBookmark('third'),
        ]);
        harness.selectedBookmarkIds.value = new Set([
            'first',
            'second',
        ]);

        expect(harness.editing.resolveBookmarkStyleSummary('first')).toEqual({
            targetCount: 2,
            bold: 'on',
            italic: 'mixed',
            color: null,
            colorMixed: true,
        });
        expect(harness.editing.resolveBookmarkStyleSummary('third')).toEqual({
            targetCount: 1,
            bold: 'off',
            italic: 'off',
            color: null,
            colorMixed: false,
        });
    });
});
