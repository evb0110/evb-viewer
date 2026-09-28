import type {
    IBookmarkItem,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import { requirePageIndex } from '@contracts/pageNumbers';
import { clamp } from 'es-toolkit/math';
import {
    collectBookmarkIds,
    findBookmarkById,
    findBookmarkLocation,
    flattenBookmarks,
    normalizeBookmarkColor,
    summarizeBookmarkStyles,
} from '@app/utils/pdfOutlineHelpers';

export const usePdfOutlineEditing = (
    bookmarks: Ref<IBookmarkItem[]>,
    activeItemId: Ref<string | null>,
    expandedBookmarkIds: Ref<Set<string>>,
    displayMode: Ref<TBookmarkDisplayMode>,
    isEditMode: ComputedRef<boolean>,
    parentBookmarkIdMap: ComputedRef<Map<string, string | null>>,
    bookmarkOrderIndexMap: ComputedRef<Map<string, number>>,
    selectedBookmarkIds: Ref<Set<string>>,
    selectionAnchorBookmarkId: Ref<string | null>,
    draggingBookmarkIds: Ref<Set<string>>,
    applySingleSelection: (id: string) => void,
    closeBookmarkContextMenu: () => void,
    resetDragState: () => void,
    currentPage: Ref<number>,
    emitBookmarksChange: () => void,
    createDraftBookmarkId: () => string,
) => {
    const { t } = useTypedI18n();
    const editingItemId = ref<string | null>(null);

    function createDraftBookmark(): IBookmarkItem {
        return {
            id: createDraftBookmarkId(),
            title: t('bookmarks.newBookmark'),
            dest: null,
            pageIndex: requirePageIndex(Math.max(0, (currentPage.value || 1) - 1)),
            pageYRatio: 0,
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

    function removeIdsFromSet(source: Set<string>, removedIds: Set<string>) {
        const next = new Set<string>();
        for (const id of source) {
            if (!removedIds.has(id)) {
                next.add(id);
            }
        }
        return next;
    }

    function clearRemovedEditingState(removedIds: Set<string>) {
        if (editingItemId.value && removedIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }
    }

    function resolveRootBookmarkIds(ids: Iterable<string>) {
        const selectedIds = new Set(ids);
        const roots = new Set<string>();

        for (const id of selectedIds) {
            if (!findBookmarkLocation(bookmarks.value, id)) {
                continue;
            }

            let hasSelectedAncestor = false;
            let cursor = parentBookmarkIdMap.value.get(id) ?? null;

            while (cursor) {
                if (selectedIds.has(cursor)) {
                    hasSelectedAncestor = true;
                    break;
                }
                cursor = parentBookmarkIdMap.value.get(cursor) ?? null;
            }

            if (!hasSelectedAncestor) {
                roots.add(id);
            }
        }

        const order = bookmarkOrderIndexMap.value;
        return [...roots].sort((left, right) => (
            (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
        ));
    }

    function resolveBookmarkRemovalTargetIds(id: string) {
        if (selectedBookmarkIds.value.has(id)) {
            const selectedRoots = resolveRootBookmarkIds(selectedBookmarkIds.value);
            if (selectedRoots.length > 0) {
                return selectedRoots;
            }
        }

        return resolveRootBookmarkIds([id]);
    }

    function removeBookmarkRoots(
        items: readonly IBookmarkItem[],
        rootIds: ReadonlySet<string>,
        removedIds: Set<string>,
    ): IBookmarkItem[] {
        return items.flatMap((item) => {
            if (rootIds.has(item.id)) {
                collectBookmarkIds(item, removedIds);
                return [];
            }

            return [{
                ...item,
                items: removeBookmarkRoots(item.items, rootIds, removedIds),
            }];
        });
    }

    function resolveNextActiveAfterRemoval(
        flatBeforeRemoval: IBookmarkItem[],
        removedIds: Set<string>,
    ) {
        const validIds = new Set(flattenBookmarks(bookmarks.value).map(item => item.id));
        const activeIndex = activeItemId.value && removedIds.has(activeItemId.value)
            ? flatBeforeRemoval.findIndex(item => item.id === activeItemId.value)
            : -1;
        const firstRemovedIndex = flatBeforeRemoval.findIndex(item => removedIds.has(item.id));
        const startIndex = activeIndex >= 0 ? activeIndex : firstRemovedIndex;

        if (startIndex < 0) {
            return null;
        }

        for (let index = startIndex; index < flatBeforeRemoval.length; index += 1) {
            const id = flatBeforeRemoval[index]?.id;
            if (id && !removedIds.has(id) && validIds.has(id)) {
                return id;
            }
        }

        for (let index = startIndex - 1; index >= 0; index -= 1) {
            const id = flatBeforeRemoval[index]?.id;
            if (id && !removedIds.has(id) && validIds.has(id)) {
                return id;
            }
        }

        return null;
    }

    function updateActiveAfterBookmarksRemoval(
        flatBeforeRemoval: IBookmarkItem[],
        removedIds: Set<string>,
    ) {
        if (!activeItemId.value || !removedIds.has(activeItemId.value)) {
            return;
        }

        activeItemId.value = resolveNextActiveAfterRemoval(flatBeforeRemoval, removedIds);
    }

    function removeBookmarkTargets(targetIds: Iterable<string>) {
        const rootIds = resolveRootBookmarkIds(targetIds);
        if (rootIds.length === 0) {
            return;
        }

        const flatBeforeRemoval = flattenBookmarks(bookmarks.value);
        const removedIds = new Set<string>();
        bookmarks.value = removeBookmarkRoots(bookmarks.value, new Set(rootIds), removedIds);
        if (removedIds.size === 0) {
            return;
        }

        updateActiveAfterBookmarksRemoval(flatBeforeRemoval, removedIds);
        clearRemovedEditingState(removedIds);
        selectedBookmarkIds.value = removeIdsFromSet(selectedBookmarkIds.value, removedIds);
        expandedBookmarkIds.value = removeIdsFromSet(expandedBookmarkIds.value, removedIds);

        closeBookmarkContextMenu();
        pruneStaleState();
        emitBookmarksChange();
    }

    function removeBookmark(id: string) {
        removeBookmarkTargets(resolveBookmarkRemovalTargetIds(id));
    }

    function removeSelectedBookmarks() {
        removeBookmarkTargets(selectedBookmarkIds.value);
    }

    /**
     * Style edits follow the same rule as removal: a context bookmark that is
     * part of the current selection acts on the whole selection, otherwise on
     * itself alone. Unlike removal, descendants are not implied, so every
     * selected id is a target of its own.
     */
    function resolveBookmarkStyleTargetIds(id: string) {
        const ids = selectedBookmarkIds.value.has(id)
            ? [...selectedBookmarkIds.value]
            : [id];
        const order = bookmarkOrderIndexMap.value;
        return ids
            .filter(targetId => findBookmarkById(bookmarks.value, targetId) !== null)
            .sort((left, right) => (
                (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER)
            ));
    }

    function resolveBookmarkStyleTargets(id: string) {
        return resolveBookmarkStyleTargetIds(id)
            .map(targetId => findBookmarkById(bookmarks.value, targetId))
            .filter((item): item is IBookmarkItem => item !== null);
    }

    function resolveBookmarkStyleSummary(id: string) {
        return summarizeBookmarkStyles(resolveBookmarkStyleTargets(id));
    }

    function resolveBookmarkStyle(
        item: IBookmarkItem,
        updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
    ) {
        return {
            bold: typeof updates.bold === 'boolean' ? updates.bold : item.bold,
            italic: typeof updates.italic === 'boolean' ? updates.italic : item.italic,
            color: updates.color === undefined
                ? item.color
                : normalizeBookmarkColor(updates.color),
        };
    }

    function hasBookmarkStyleChanged(
        item: IBookmarkItem,
        nextStyle: Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>,
    ) {
        return item.bold !== nextStyle.bold
            || item.italic !== nextStyle.italic
            || item.color !== nextStyle.color;
    }

    /**
     * Applies one style patch to the context bookmark's style targets in a
     * single bookmarks change, so a multi-selection restyle is one undo step.
     */
    function updateBookmarkStyle(
        id: string,
        updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
    ) {
        let changed = false;
        for (const targetId of resolveBookmarkStyleTargetIds(id)) {
            const item = findBookmarkById(bookmarks.value, targetId);
            if (!item) {
                continue;
            }

            const nextStyle = resolveBookmarkStyle(item, updates);
            if (!hasBookmarkStyleChanged(item, nextStyle)) {
                continue;
            }

            item.bold = nextStyle.bold;
            item.italic = nextStyle.italic;
            item.color = nextStyle.color;
            changed = true;
        }

        if (changed) {
            emitBookmarksChange();
        }
    }

    /**
     * Toggling a mixed selection turns the flag on for every target first, the
     * way word processors treat a partially bold selection; only a uniformly
     * on selection toggles off.
     */
    function toggleBookmarkFlag(id: string, flag: 'bold' | 'italic') {
        const targets = resolveBookmarkStyleTargets(id);
        if (targets.length === 0) {
            return;
        }

        const nextValue = !targets.every(item => item[flag]);
        updateBookmarkStyle(id, { [flag]: nextValue });
    }

    function toggleBookmarkBold(id: string) {
        toggleBookmarkFlag(id, 'bold');
    }

    function toggleBookmarkItalic(id: string) {
        toggleBookmarkFlag(id, 'italic');
    }

    function setBookmarkColor(id: string, color: string | null) {
        updateBookmarkStyle(id, { color });
    }

    function getValidBookmarkIds() {
        const validIds = new Set<string>();
        function visit(items: IBookmarkItem[]) {
            for (const item of items) {
                validIds.add(item.id);
                visit(item.items);
            }
        }
        visit(bookmarks.value);
        return validIds;
    }

    function hasInvalidId(source: Set<string>, validIds: Set<string>) {
        for (const id of source) {
            if (!validIds.has(id)) {
                return true;
            }
        }
        return false;
    }

    function retainValidIds(source: Set<string>, validIds: Set<string>) {
        const next = new Set<string>();
        for (const id of source) {
            if (validIds.has(id)) {
                next.add(id);
            }
        }
        return next;
    }

    function pruneActiveAndEditingState(validIds: Set<string>) {
        if (activeItemId.value && !validIds.has(activeItemId.value)) {
            activeItemId.value = null;
        }

        if (editingItemId.value && !validIds.has(editingItemId.value)) {
            editingItemId.value = null;
        }
    }

    function pruneSelectionState(validIds: Set<string>) {
        selectedBookmarkIds.value = retainValidIds(selectedBookmarkIds.value, validIds);
        if (selectionAnchorBookmarkId.value && !validIds.has(selectionAnchorBookmarkId.value)) {
            selectionAnchorBookmarkId.value = null;
        }
    }

    function pruneDragState(validIds: Set<string>) {
        if (hasInvalidId(draggingBookmarkIds.value, validIds)) {
            resetDragState();
        }
    }

    function pruneStaleState() {
        const validIds = getValidBookmarkIds();
        pruneActiveAndEditingState(validIds);
        pruneSelectionState(validIds);
        pruneDragState(validIds);
        expandedBookmarkIds.value = retainValidIds(expandedBookmarkIds.value, validIds);
    }

    function mapBookmarksForPersistence(items: IBookmarkItem[]): IPdfBookmarkEntry[] {
        return items.map((item) => {
            const title = item.title.trim();
            return {
                title: title.length > 0 ? title : t('bookmarks.untitled'),
                pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : null,
                pageYRatio: typeof item.pageYRatio === 'number' && Number.isFinite(item.pageYRatio)
                    ? clamp(item.pageYRatio, 0, 1)
                    : null,
                namedDest: typeof item.dest === 'string' && item.dest.trim().length > 0 ? item.dest : null,
                bold: item.bold,
                italic: item.italic,
                color: normalizeBookmarkColor(item.color),
                items: mapBookmarksForPersistence(item.items),
            };
        });
    }

    watch(isEditMode, (enabled) => {
        if (enabled) {
            return;
        }
        editingItemId.value = null;
        closeBookmarkContextMenu();
        resetDragState();
    });

    return {
        editingItemId,
        createDraftBookmark,
        startEditingBookmark,
        cancelEditingBookmark,
        renameBookmark,
        addRootBookmark,
        addSiblingAbove,
        addSiblingBelow,
        addChildBookmark,
        resolveRootBookmarkIds,
        resolveBookmarkRemovalTargetIds,
        resolveBookmarkStyleTargetIds,
        resolveBookmarkStyleSummary,
        removeBookmark,
        removeSelectedBookmarks,
        toggleBookmarkBold,
        toggleBookmarkItalic,
        setBookmarkColor,
        updateBookmarkStyle,
        pruneStaleState,
        mapBookmarksForPersistence,
    };
};
