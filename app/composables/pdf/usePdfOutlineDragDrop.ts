import { ref } from 'vue';
import type {
    IBookmarkItem,
    IBookmarkDropTarget,
    IBookmarkDropPayload,
    TBookmarkDropPosition,
} from '@app/types/pdf-outline';
import {
    findBookmarkLocation,
    collectBookmarkIds,
} from '@app/utils/pdf-outline-helpers';

export const usePdfOutlineDragDrop = (
    bookmarks: Ref<IBookmarkItem[]>,
    expandedBookmarkIds: Ref<Set<string>>,
    isEditMode: ComputedRef<boolean>,
    selectedBookmarkIds: Ref<Set<string>>,
    parentBookmarkIdMap: ComputedRef<Map<string, string | null>>,
    bookmarkOrderIndexMap: ComputedRef<Map<string, number>>,
    applySingleSelection: (id: string) => void,
    closeBookmarkContextMenu: () => void,
) => {
    const draggingBookmarkIds = ref<Set<string>>(new Set());
    const bookmarkDropTarget = ref<IBookmarkDropTarget | null>(null);
    const isRootAppendDropTarget = ref(false);

    function resetDragState() {
        draggingBookmarkIds.value = new Set();
        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = false;
    }

    function getSelectedRootIds(selection: Set<string>) {
        const roots = new Set<string>();
        for (const id of selection) {
            let hasSelectedAncestor = false;
            let cursor = parentBookmarkIdMap.value.get(id) ?? null;

            while (cursor) {
                if (selection.has(cursor)) {
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
        return [...roots].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    }

    function collectDraggedBranchIds(draggedRootIds: string[]) {
        const ids = new Set<string>();
        for (const id of draggedRootIds) {
            const location = findBookmarkLocation(bookmarks.value, id);
            if (!location) {
                continue;
            }
            collectBookmarkIds(location.item, ids);
        }
        return ids;
    }

    function canDropBookmarks(draggedRootIds: string[], targetId: string) {
        if (draggedRootIds.includes(targetId)) {
            return false;
        }

        const draggedBranchIds = collectDraggedBranchIds(draggedRootIds);
        return !draggedBranchIds.has(targetId);
    }

    function extractDraggedItems(draggedRootIds: string[]) {
        const order = bookmarkOrderIndexMap.value;
        const descendingIds = [...draggedRootIds].sort((left, right) => (
            (order.get(right) ?? 0) - (order.get(left) ?? 0)
        ));

        const extracted = new Map<string, IBookmarkItem>();
        for (const id of descendingIds) {
            const location = findBookmarkLocation(bookmarks.value, id);
            if (!location) {
                continue;
            }
            location.list.splice(location.index, 1);
            extracted.set(id, location.item);
        }

        return draggedRootIds
            .map(id => extracted.get(id) ?? null)
            .filter((item): item is IBookmarkItem => item !== null);
    }

    function moveBookmarksToTarget(
        draggedRootIds: string[],
        targetId: string,
        position: TBookmarkDropPosition,
    ) {
        if (!canDropBookmarks(draggedRootIds, targetId)) {
            return;
        }

        const targetLocationBeforeExtraction = findBookmarkLocation(bookmarks.value, targetId);
        if (!targetLocationBeforeExtraction) {
            return;
        }

        const draggedItems = extractDraggedItems(draggedRootIds);
        if (draggedItems.length === 0) {
            return;
        }

        const targetLocation = findBookmarkLocation(bookmarks.value, targetId);
        if (!targetLocation) {
            bookmarks.value.push(...draggedItems);
            return;
        }

        if (position === 'child') {
            targetLocation.item.items.push(...draggedItems);
            const nextExpanded = new Set(expandedBookmarkIds.value);
            nextExpanded.add(targetLocation.item.id);
            expandedBookmarkIds.value = nextExpanded;
            return;
        }

        const insertionIndex = position === 'before' ? targetLocation.index : targetLocation.index + 1;
        targetLocation.list.splice(insertionIndex, 0, ...draggedItems);
    }

    function moveBookmarksToRootEnd(draggedRootIds: string[]) {
        const draggedItems = extractDraggedItems(draggedRootIds);
        if (draggedItems.length === 0) {
            return;
        }
        bookmarks.value.push(...draggedItems);
    }

    function handleBookmarkDragStart(payload: { id: string }) {
        if (!isEditMode.value) {
            return;
        }

        if (!selectedBookmarkIds.value.has(payload.id)) {
            applySingleSelection(payload.id);
        }

        const draggedRoots = getSelectedRootIds(selectedBookmarkIds.value);
        draggingBookmarkIds.value = new Set(draggedRoots.length > 0 ? draggedRoots : [payload.id]);
        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = false;
        closeBookmarkContextMenu();
    }

    function handleBookmarkDragHover(payload: IBookmarkDropPayload) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        if (!canDropBookmarks(draggingRoots, payload.targetId)) {
            bookmarkDropTarget.value = null;
            isRootAppendDropTarget.value = false;
            return;
        }

        bookmarkDropTarget.value = {
            id: payload.targetId,
            position: payload.position,
        };
        isRootAppendDropTarget.value = false;
    }

    function handleBookmarkDrop(
        payload: IBookmarkDropPayload,
        activeItemId: Ref<string | null>,
        emitBookmarksChange: () => void,
    ) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        if (!canDropBookmarks(draggingRoots, payload.targetId)) {
            resetDragState();
            return;
        }

        moveBookmarksToTarget(draggingRoots, payload.targetId, payload.position);
        activeItemId.value = draggingRoots[0] ?? null;
        emitBookmarksChange();
        resetDragState();
    }

    function handleTreeEndDragOver() {
        if (!isEditMode.value || draggingBookmarkIds.value.size === 0) {
            return;
        }

        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = true;
    }

    function handleTreeEndDrop(
        activeItemId: Ref<string | null>,
        emitBookmarksChange: () => void,
    ) {
        const draggingRoots = [...draggingBookmarkIds.value];
        if (!isEditMode.value || draggingRoots.length === 0) {
            return;
        }

        moveBookmarksToRootEnd(draggingRoots);
        activeItemId.value = draggingRoots[0] ?? null;
        emitBookmarksChange();
        resetDragState();
    }

    function handleBookmarkDragEnd() {
        resetDragState();
    }

    return {
        draggingBookmarkIds,
        bookmarkDropTarget,
        isRootAppendDropTarget,
        resetDragState,
        getSelectedRootIds,
        handleBookmarkDragStart,
        handleBookmarkDragHover,
        handleBookmarkDrop,
        handleTreeEndDragOver,
        handleTreeEndDrop,
        handleBookmarkDragEnd,
    };
};
