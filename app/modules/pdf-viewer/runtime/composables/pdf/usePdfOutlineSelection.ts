import type {
    IBookmarkItem,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import { isDocumentBookmarkExpanded } from '@app/modules/document-viewer/public';

export const usePdfOutlineSelection = (
    bookmarks: Ref<IBookmarkItem[]>,
    activeItemId: Ref<string | null>,
    displayMode: Ref<TBookmarkDisplayMode>,
    expandedBookmarkIds: Ref<Set<string>>,
    activePathBookmarkIds: ComputedRef<Set<string>>,
) => {
    const multiSelection = useMultiSelection<string>();

    function isBookmarkExpandedForVisibility(item: IBookmarkItem) {
        return isDocumentBookmarkExpanded(item.id, {
            displayMode: displayMode.value,
            expandedIds: expandedBookmarkIds.value,
            activePathIds: activePathBookmarkIds.value,
        });
    }

    const visibleBookmarkIds = computed(() => {
        const ids: string[] = [];

        function visit(items: IBookmarkItem[]) {
            for (const item of items) {
                ids.push(item.id);
                if (item.items.length > 0 && isBookmarkExpandedForVisibility(item)) {
                    visit(item.items);
                }
            }
        }

        visit(bookmarks.value);
        return ids;
    });

    function applySingleSelection(id: string) {
        multiSelection.selected.value = new Set([id]);
        multiSelection.anchor.value = id;
    }

    function applyRangeSelection(id: string) {
        multiSelection.toggle(id, visibleBookmarkIds.value, { shift: true });
    }

    function clearSelection() {
        multiSelection.clear();
    }

    return {
        selectedBookmarkIds: multiSelection.selected,
        selectionAnchorBookmarkId: multiSelection.anchor,
        visibleBookmarkIds,
        applySingleSelection,
        applyRangeSelection,
        clearSelection,
    };
};
