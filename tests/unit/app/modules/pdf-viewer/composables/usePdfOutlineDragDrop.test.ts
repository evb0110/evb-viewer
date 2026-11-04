import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import { usePdfOutlineDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineDragDrop';

function createBookmark(id: string): IBookmarkItem {
    return {
        id,
        title: id,
        dest: null,
        pageIndex: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
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

describe('usePdfOutlineDragDrop', () => {
    it('refuses a drop inside a dragged branch and accepts one beside it', () => {
        const child = createBookmark('child');
        const grandchild = createBookmark('grandchild');
        child.items = [grandchild];
        const parent = {
            ...createBookmark('parent'),
            items: [child],
        };
        const bookmarks = ref([
            parent,
            createBookmark('other'),
        ]);
        const dragDrop = usePdfOutlineDragDrop(
            bookmarks,
            ref(new Set()),
            computed(() => true),
            ref(new Set(['parent'])),
            computed(() => createParentMap(bookmarks.value)),
            computed(() => createOrderMap(bookmarks.value)),
            vi.fn(),
            vi.fn(),
        );
        dragDrop.handleBookmarkDragStart({id: 'parent'});

        for (const targetId of [
            'parent',
            'child',
            'grandchild',
        ]) {
            dragDrop.handleBookmarkDragHover({
                targetId,
                position: 'child',
            });
            expect(dragDrop.bookmarkDropTarget.value, targetId).toBeNull();
        }
        dragDrop.handleBookmarkDragHover({
            targetId: 'other',
            position: 'child',
        });
        expect(dragDrop.bookmarkDropTarget.value).toEqual({
            id: 'other',
            position: 'child',
        });
    });

    it('does not emit bookmark changes for no-op root-end drops', () => {
        const bookmarks = ref([
            createBookmark('first'),
            createBookmark('last'),
        ]);
        const selectedBookmarkIds = ref(new Set(['last']));
        const activeItemId = ref<string | null>('last');
        const emitBookmarksChange = vi.fn();

        const dragDrop = usePdfOutlineDragDrop(
            bookmarks,
            ref(new Set()),
            computed(() => true),
            selectedBookmarkIds,
            computed(() => createParentMap(bookmarks.value)),
            computed(() => createOrderMap(bookmarks.value)),
            vi.fn(),
            vi.fn(),
        );

        dragDrop.handleBookmarkDragStart({ id: 'last' });
        dragDrop.handleTreeEndDrop(activeItemId, emitBookmarksChange);

        expect(bookmarks.value.map(item => item.id)).toEqual([
            'first',
            'last',
        ]);
        expect(activeItemId.value).toBe('last');
        expect(emitBookmarksChange).not.toHaveBeenCalled();
        expect(dragDrop.draggingBookmarkIds.value.size).toBe(0);
    });

    it('does not emit bookmark changes for target drops that keep the same order', () => {
        const bookmarks = ref([
            createBookmark('first'),
            createBookmark('last'),
        ]);
        const selectedBookmarkIds = ref(new Set(['first']));
        const activeItemId = ref<string | null>('last');
        const emitBookmarksChange = vi.fn();

        const dragDrop = usePdfOutlineDragDrop(
            bookmarks,
            ref(new Set()),
            computed(() => true),
            selectedBookmarkIds,
            computed(() => createParentMap(bookmarks.value)),
            computed(() => createOrderMap(bookmarks.value)),
            vi.fn(),
            vi.fn(),
        );

        dragDrop.handleBookmarkDragStart({ id: 'first' });
        dragDrop.handleBookmarkDrop({
            targetId: 'last',
            position: 'before',
        }, activeItemId, emitBookmarksChange);

        expect(bookmarks.value.map(item => item.id)).toEqual([
            'first',
            'last',
        ]);
        expect(activeItemId.value).toBe('last');
        expect(emitBookmarksChange).not.toHaveBeenCalled();
        expect(dragDrop.draggingBookmarkIds.value.size).toBe(0);
    });
});
