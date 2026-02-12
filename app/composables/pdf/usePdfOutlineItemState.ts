import {
    computed,
    type Ref,
    inject,
} from 'vue';
import type { IBookmarkItem } from '@app/types/pdf-outline';
import { PDF_OUTLINE_TREE_KEY } from '@app/composables/pdf/usePdfOutlineKeys';

export const usePdfOutlineItemState = (item: Ref<IBookmarkItem>) => {
    const treeContext = inject(PDF_OUTLINE_TREE_KEY)!;

    const hasChildren = computed(() => item.value.items.length > 0);
    const isActive = computed(() => item.value.id === treeContext.activeItemId.value);
    const isSelected = computed(() => treeContext.selectedBookmarkIds.value.has(item.value.id));
    const isEditing = computed(() => item.value.id === treeContext.editingItemId.value);
    const isDragging = computed(() => treeContext.draggingItemIds.value.has(item.value.id));
    const isDropTargetBefore = computed(() => (
        treeContext.dropTarget.value?.id === item.value.id
        && treeContext.dropTarget.value.position === 'before'
    ));
    const isDropTargetAfter = computed(() => (
        treeContext.dropTarget.value?.id === item.value.id
        && treeContext.dropTarget.value.position === 'after'
    ));
    const isDropTargetChild = computed(() => (
        treeContext.dropTarget.value?.id === item.value.id
        && treeContext.dropTarget.value.position === 'child'
    ));
    const isStyleRangeStart = computed(() => treeContext.styleRangeStartId.value === item.value.id);

    const bookmarkTitleStyle = computed(() => ({
        color: item.value.color ?? undefined,
        fontWeight: item.value.bold ? '600' : '500',
        fontStyle: item.value.italic ? 'italic' : 'normal',
    }));

    const isExpanded = computed(() => {
        if (!hasChildren.value) {
            return false;
        }

        if (treeContext.displayMode.value === 'all-expanded') {
            return true;
        }

        if (treeContext.displayMode.value === 'current-expanded') {
            return treeContext.activePathBookmarkIds.value.has(item.value.id);
        }

        return treeContext.expandedBookmarkIds.value.has(item.value.id);
    });

    return {
        treeContext,
        hasChildren,
        isActive,
        isSelected,
        isEditing,
        isDragging,
        isDropTargetBefore,
        isDropTargetAfter,
        isDropTargetChild,
        isStyleRangeStart,
        bookmarkTitleStyle,
        isExpanded,
    };
};
