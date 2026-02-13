import { ref } from 'vue';
import type {
    IBookmarkItem,
    TBookmarkDisplayMode,
} from '@app/types/pdf-outline';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import {
    findBookmarkLocation,
    findBookmarkById,
    collectBookmarkIds,
    normalizeBookmarkColor,
} from '@app/utils/pdf-outline-helpers';

export const usePdfOutlineEditing = (
    bookmarks: Ref<IBookmarkItem[]>,
    activeItemId: Ref<string | null>,
    expandedBookmarkIds: Ref<Set<string>>,
    displayMode: Ref<TBookmarkDisplayMode>,
    isEditMode: ComputedRef<boolean>,
    parentBookmarkIdMap: ComputedRef<Map<string, string | null>>,
    selectedBookmarkIds: Ref<Set<string>>,
    selectionAnchorBookmarkId: Ref<string | null>,
    styleRangeStartId: Ref<string | null>,
    draggingBookmarkIds: Ref<Set<string>>,
    applySingleSelection: (id: string) => void,
    closeBookmarkContextMenu: () => void,
    resetDragState: () => void,
    currentPage: Ref<number>,
    emitBookmarksChange: () => void,
    createBookmarkId: () => string,
    t: (key: string) => string,
) => {
    const editingItemId = ref<string | null>(null);

    const flatBookmarks = computed(() => {
        const flattened: IBookmarkItem[] = [];

        function visit(items: IBookmarkItem[]) {
            for (const item of items) {
                flattened.push(item);
                visit(item.items);
            }
        }

        visit(bookmarks.value);
        return flattened;
    });

    // Keep flatBookmarks for internal use (pruneStaleState)

    function createDraftBookmark(): IBookmarkItem {
        return {
            id: createBookmarkId(),
            title: t('bookmarks.newBookmark'),
            dest: null,
            pageIndex: Math.max(0, (currentPage.value || 1) - 1),
            bold: false,
            italic: false,
            color: null,
            items: [],
        };
    }

    function ensureBookmarkVisibleInTopLevelMode(id: string) {
        if (displayMode.value !== 'top-level') {
            return;
        }

        const parentId = parentBookmarkIdMap.value.get(id);
        if (!parentId) {
            return;
        }

        const nextExpanded = new Set(expandedBookmarkIds.value);
        nextExpanded.add(parentId);
        expandedBookmarkIds.value = nextExpanded;
    }

    function focusNewBookmark(id: string) {
        activeItemId.value = id;
        editingItemId.value = id;
        applySingleSelection(id);
        closeBookmarkContextMenu();
    }

    function startEditingBookmark(id: string) {
        activeItemId.value = id;
        applySingleSelection(id);
        editingItemId.value = id;
        closeBookmarkContextMenu();
    }

    function cancelEditingBookmark() {
        editingItemId.value = null;
    }

    function renameBookmark(payload: {
        id: string;
        title: string 
    }) {
        const location = findBookmarkLocation(bookmarks.value, payload.id);
        editingItemId.value = null;
        if (!location) {
            return;
        }

        const nextTitle = payload.title.trim();
        if (nextTitle.length === 0) {
            return;
        }

        if (location.item.title === nextTitle) {
            return;
        }

        location.item.title = nextTitle;
        emitBookmarksChange();
    }

    function addRootBookmark() {
        const bookmark = createDraftBookmark();
        bookmarks.value.push(bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addSiblingAbove(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.list.splice(location.index, 0, bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addSiblingBelow(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.list.splice(location.index + 1, 0, bookmark);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function addChildBookmark(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const bookmark = createDraftBookmark();
        location.item.items.push(bookmark);
        ensureBookmarkVisibleInTopLevelMode(bookmark.id);
        focusNewBookmark(bookmark.id);
        emitBookmarksChange();
    }

    function removeBookmark(id: string) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const removedIds = new Set<string>();
        collectBookmarkIds(location.item, removedIds);
        location.list.splice(location.index, 1);

        const nextActive = location.list[location.index] ?? location.list[location.index - 1] ?? location.parent;
        if (activeItemId.value && removedIds.has(activeItemId.value)) {
            activeItemId.value = nextActive?.id ?? null;
        }

        if (editingItemId.value && removedIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }

        if (styleRangeStartId.value && removedIds.has(styleRangeStartId.value)) {
            styleRangeStartId.value = null;
        }

        const nextExpanded = new Set<string>();
        for (const expandedId of expandedBookmarkIds.value) {
            if (!removedIds.has(expandedId)) {
                nextExpanded.add(expandedId);
            }
        }
        expandedBookmarkIds.value = nextExpanded;

        closeBookmarkContextMenu();
        pruneStaleState();
        emitBookmarksChange();
    }

    function updateBookmarkStyle(
        id: string,
        updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
    ) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            return;
        }

        const nextBold = typeof updates.bold === 'boolean' ? updates.bold : location.item.bold;
        const nextItalic = typeof updates.italic === 'boolean' ? updates.italic : location.item.italic;
        const nextColor = updates.color === undefined
            ? location.item.color
            : normalizeBookmarkColor(updates.color);

        if (
            location.item.bold === nextBold
            && location.item.italic === nextItalic
            && location.item.color === nextColor
        ) {
            return;
        }

        location.item.bold = nextBold;
        location.item.italic = nextItalic;
        location.item.color = nextColor;
        emitBookmarksChange();
    }

    function toggleBookmarkBold(id: string) {
        const bookmark = findBookmarkById(bookmarks.value, id);
        if (!bookmark) {
            return;
        }
        updateBookmarkStyle(id, { bold: !bookmark.bold });
    }

    function toggleBookmarkItalic(id: string) {
        const bookmark = findBookmarkById(bookmarks.value, id);
        if (!bookmark) {
            return;
        }
        updateBookmarkStyle(id, { italic: !bookmark.italic });
    }

    function setBookmarkColor(id: string, color: string | null) {
        updateBookmarkStyle(id, { color });
    }

    function pruneStaleState() {
        const validIds = new Set<string>();
        for (const item of flatBookmarks.value) {
            validIds.add(item.id);
        }

        if (activeItemId.value && !validIds.has(activeItemId.value)) {
            activeItemId.value = null;
        }

        if (editingItemId.value && !validIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }

        if (styleRangeStartId.value && !validIds.has(styleRangeStartId.value)) {
            styleRangeStartId.value = null;
        }

        const nextSelected = new Set<string>();
        for (const id of selectedBookmarkIds.value) {
            if (validIds.has(id)) {
                nextSelected.add(id);
            }
        }
        selectedBookmarkIds.value = nextSelected;

        if (selectionAnchorBookmarkId.value && !validIds.has(selectionAnchorBookmarkId.value)) {
            selectionAnchorBookmarkId.value = null;
        }

        let hasInvalidDraggingId = false;
        for (const id of draggingBookmarkIds.value) {
            if (!validIds.has(id)) {
                hasInvalidDraggingId = true;
                break;
            }
        }
        if (hasInvalidDraggingId) {
            resetDragState();
        }

        const nextExpanded = new Set<string>();
        for (const id of expandedBookmarkIds.value) {
            if (validIds.has(id)) {
                nextExpanded.add(id);
            }
        }
        expandedBookmarkIds.value = nextExpanded;
    }

    function mapBookmarksForPersistence(items: IBookmarkItem[]): IPdfBookmarkEntry[] {
        return items.map((item) => {
            const title = item.title.trim();
            return {
                title: title.length > 0 ? title : t('bookmarks.untitled'),
                pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : null,
                namedDest: typeof item.dest === 'string' && item.dest.trim().length > 0 ? item.dest : null,
                bold: item.bold,
                italic: item.italic,
                color: normalizeBookmarkColor(item.color),
                items: mapBookmarksForPersistence(item.items),
            };
        });
    }

    return {
        editingItemId,
        flatBookmarks,
        createDraftBookmark,
        startEditingBookmark,
        cancelEditingBookmark,
        renameBookmark,
        addRootBookmark,
        addSiblingAbove,
        addSiblingBelow,
        addChildBookmark,
        removeBookmark,
        toggleBookmarkBold,
        toggleBookmarkItalic,
        setBookmarkColor,
        updateBookmarkStyle,
        pruneStaleState,
        mapBookmarksForPersistence,
    };
};
