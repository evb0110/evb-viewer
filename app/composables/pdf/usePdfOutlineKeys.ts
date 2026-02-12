import type {
    InjectionKey,
    Ref,
    ComputedRef,
} from 'vue';
import type {
    TBookmarkDisplayMode,
    IBookmarkDropTarget,
} from '@app/types/pdf-outline';

export interface IPdfOutlineTreeContext {
    expandedBookmarkIds: Ref<Set<string>>;
    activeItemId: Ref<string | null>;
    editingItemId: Ref<string | null>;
    selectedBookmarkIds: Ref<Set<string>>;
    displayMode: Ref<TBookmarkDisplayMode>;
    isEditMode: ComputedRef<boolean>;
    draggingItemIds: Ref<Set<string>>;
    dropTarget: Ref<IBookmarkDropTarget | null>;
    styleRangeStartId: Ref<string | null>;
    activePathBookmarkIds: ComputedRef<Set<string>>;
}

export const PDF_OUTLINE_TREE_KEY: InjectionKey<IPdfOutlineTreeContext> = Symbol('PdfOutlineTree');
