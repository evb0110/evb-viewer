import type { Ref } from 'vue';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import type { IPdfOutlineTreeContext } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeContext';
import { pdfOutlineTreeKey } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeKey';
import { isDocumentBookmarkExpanded } from '@app/modules/document-viewer/public';

function requirePdfOutlineTreeContext(): IPdfOutlineTreeContext {
    const treeContext = inject(pdfOutlineTreeKey, null);
    if (!treeContext) {
        throw new Error('usePdfOutlineItemState must be used within a PDF outline tree provider');
    }

    return treeContext;
}

export const usePdfOutlineItemState = (item: Ref<IBookmarkItem>) => {
    const treeContext = requirePdfOutlineTreeContext();

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

    const bookmarkTitleStyle = computed(() => ({
        color: item.value.color ?? undefined,
        fontWeight: item.value.bold ? '600' : '500',
        fontStyle: item.value.italic ? 'italic' : 'normal',
    }));

    const isExpanded = computed(() => {
        if (!hasChildren.value) {
            return false;
        }

        return isDocumentBookmarkExpanded(item.value.id, {
            displayMode: treeContext.displayMode.value,
            expandedIds: treeContext.expandedBookmarkIds.value,
            activePathIds: treeContext.activePathBookmarkIds.value,
        });
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
        bookmarkTitleStyle,
        isExpanded,
    };
};
