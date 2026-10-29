import type {
    IBookmarkDropPayload,
    IBookmarkDropTarget,
    IBookmarkItem,
} from '@app/types/pdfOutline';
import {
    collectBookmarkIds,
    findBookmarkLocation,
} from '@app/utils/pdfOutlineHelpers';

type TBookmarkDropDestination =
    | { kind: 'root-end' }
    | {
        kind: 'target';
        payload: IBookmarkDropPayload;
    };

/** Removes the dragged roots, collecting them in tree order into `draggedItems`. */
function removeDraggedBookmarkItems(
    items: readonly IBookmarkItem[],
    draggedIds: ReadonlySet<string>,
    draggedItems: IBookmarkItem[],
): IBookmarkItem[] {
    const remaining: IBookmarkItem[] = [];
    for (const item of items) {
        if (draggedIds.has(item.id)) {
            draggedItems.push(item);
            continue;
        }
        remaining.push({
            ...item,
            items: removeDraggedBookmarkItems(item.items, draggedIds, draggedItems),
        });
    }
    return remaining;
}

/** `inserted` is whether the destination was found; `draggedItems` is never empty. */
function insertBookmarkItems(
    items: readonly IBookmarkItem[],
    draggedItems: readonly IBookmarkItem[],
    destination: TBookmarkDropDestination,
): {
    items: IBookmarkItem[];
    expandedBookmarkId: string | null;
    inserted: boolean;
} {
    if (destination.kind === 'root-end') {
        return {
            items: [
                ...items,
                ...draggedItems,
            ],
            expandedBookmarkId: null,
            inserted: true,
        };
    }

    let inserted = false;
    const nextItems = items.flatMap((item) => {
        if (item.id === destination.payload.targetId) {
            inserted = true;
            if (destination.payload.position === 'before') {
                return [
                    ...draggedItems,
                    item,
                ];
            }
            if (destination.payload.position === 'after') {
                return [
                    item,
                    ...draggedItems,
                ];
            }
            return [{
                ...item,
                items: [
                    ...item.items,
                    ...draggedItems,
                ],
            }];
        }

        const childResult = insertBookmarkItems(item.items, draggedItems, destination);
        inserted ||= childResult.inserted;
        return [{
            ...item,
            items: childResult.items,
        }];
    });
    const targetExpanded = destination.payload.position === 'child'
        ? destination.payload.targetId
        : null;

    return {
        items: nextItems,
        expandedBookmarkId: inserted ? targetExpanded : null,
        inserted,
    };
}

/**
 * A move only reorders nodes, so it is a no-op exactly when every position
 * holds the same id with the same children. Serializing both trees to learn
 * that cost more than the move itself on a broad outline.
 */
function haveSameBookmarkOrder(left: readonly IBookmarkItem[], right: readonly IBookmarkItem[]): boolean {
    return left.length === right.length && left.every((item, index) => {
        const other = right[index];
        return other !== undefined && other.id === item.id && haveSameBookmarkOrder(item.items, other.items);
    });
}

function moveBookmarkNodes(
    items: readonly IBookmarkItem[],
    draggedRootIds: readonly string[],
    destination: TBookmarkDropDestination,
) {
    const extractedItems: IBookmarkItem[] = [];
    const remainingItems = removeDraggedBookmarkItems(items, new Set(draggedRootIds), extractedItems);
    const draggedById = new Map(extractedItems.map(item => [
        item.id,
        item,
    ]));
    const draggedItems = draggedRootIds.flatMap((id) => {
        const item = draggedById.get(id) ?? null;
        return item ? [item] : [];
    });

    if (draggedItems.length === 0) {
        return {
            bookmarks: [...items],
            expandedBookmarkId: null,
            moved: false,
        };
    }

    const insertion = insertBookmarkItems(remainingItems, draggedItems, destination);
    const moved = insertion.inserted && !haveSameBookmarkOrder(insertion.items, items);
    return {
        bookmarks: insertion.items,
        expandedBookmarkId: insertion.expandedBookmarkId,
        moved,
    };
}

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

    function resolveSelectedRootIds(selection: Set<string>) {
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

    function moveBookmarksToRootEnd(draggedRootIds: string[]) {
        const result = moveBookmarkNodes(bookmarks.value, draggedRootIds, { kind: 'root-end' });
        if (!result.moved) {
            return false;
        }
        bookmarks.value = result.bookmarks;
        return true;
    }

    function handleBookmarkDragStart(payload: { id: string }) {
        if (!isEditMode.value) {
            return;
        }

        if (!selectedBookmarkIds.value.has(payload.id)) {
            applySingleSelection(payload.id);
        }

        const draggedRoots = resolveSelectedRootIds(selectedBookmarkIds.value);
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

        const targetLocationBeforeExtraction = findBookmarkLocation(bookmarks.value, payload.targetId);
        let moved = false;
        if (targetLocationBeforeExtraction) {
            const result = moveBookmarkNodes(bookmarks.value, draggingRoots, {
                kind: 'target',
                payload,
            });
            if (result.moved) {
                bookmarks.value = result.bookmarks;
                moved = true;
            }
            if (result.expandedBookmarkId) {
                expandedBookmarkIds.value = new Set([
                    ...expandedBookmarkIds.value,
                    result.expandedBookmarkId,
                ]);
            }
        }

        if (moved) {
            activeItemId.value = draggingRoots[0] ?? null;
            emitBookmarksChange();
        }
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

        if (moveBookmarksToRootEnd(draggingRoots)) {
            activeItemId.value = draggingRoots[0] ?? null;
            emitBookmarksChange();
        }
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
        handleBookmarkDragStart,
        handleBookmarkDragHover,
        handleBookmarkDrop,
        handleTreeEndDragOver,
        handleTreeEndDrop,
        handleBookmarkDragEnd,
    };
};
