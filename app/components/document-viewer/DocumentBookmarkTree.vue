<template>
    <div ref="treeRef" class="document-bookmark-tree" @focusin="handleFocusIn" @focusout="handleFocusOut" @keydown="handleKeydown">
        <div
            v-bind="containerProps"
            class="document-bookmark-tree__list app-scrollbar app-scroll-region--balanced"
        >
            <div v-bind="wrapperProps" style="position: relative">
                <DocumentBookmarkTreeItem
                    v-for="row in mountedRows"
                    :key="row.data.item.id"
                    :item="row.data.item"
                    :depth="row.data.depth"
                    :style="row.pinned ? {position: 'absolute', top: `${(row.index - firstVirtualRowIndex) * BOOKMARK_ROW_HEIGHT_PX}px`, insetInline: 0} : undefined"
                    :is-expanded="row.data.isExpanded"
                    :is-active="row.data.item.id === activeId"
                    :edit-mode="editMode"
                    :is-selected="selectedIds?.has(row.data.item.id)"
                    :is-editing="editingId === row.data.item.id"
                    :is-dragging="draggingIds?.has(row.data.item.id)"
                    :drop-position="dropTarget?.id === row.data.item.id ? dropTarget.position : undefined"
                    :can-drop="editMode && Boolean(draggingIds?.size)"
                    @activate="(id, event) => emit('activate', id, event)"
                    @open-actions="emit('open-actions', $event)"
                    @save-edit="emit('save-edit', $event)"
                    @cancel-edit="emit('cancel-edit')"
                    @drag-start="handleDragStart"
                    @drag-hover="emit('drag-hover', $event)"
                    @drop-bookmark="emit('drop-bookmark', $event)"
                    @drag-end="emit('drag-end')"
                    @toggle-expand="emit('toggle-expand', $event)"
                />
            </div>
            <slot name="after" />
        </div>
    </div>
</template>

<script setup lang="ts">
import {useVirtualList} from '@vueuse/core';
import type {
    IBookmarkDropPayload,
    IBookmarkDropTarget,
    IBookmarkMenuPayload,
} from '@app/types/pdfOutline';
import {
    getDocumentBookmarkVisibleRows,
    resolveDocumentBookmarkRevealRowIndex,
    type IDocumentBookmarkTreeItem,
    type TDocumentBookmarkDisplayMode,
} from '@app/modules/document-viewer/public';
import DocumentBookmarkTreeItem from '@app/components/document-viewer/DocumentBookmarkTreeItem.vue';

const props = defineProps<{
    items: readonly IDocumentBookmarkTreeItem[];
    activeId: string | null;
    displayMode: TDocumentBookmarkDisplayMode;
    expandedIds: ReadonlySet<string>;
    activePathIds: ReadonlySet<string>;
    editMode?: boolean;
    editingId?: string | null;
    selectedIds?: ReadonlySet<string>;
    draggingIds?: ReadonlySet<string>;
    dropTarget?: IBookmarkDropTarget | null;
}>();
const emit = defineEmits<{
    activate: [id: string, event?: MouseEvent | KeyboardEvent];
    'open-actions': [payload: IBookmarkMenuPayload];
    'save-edit': [payload: {
        id: string;
        title: string
    }];
    'cancel-edit': [];
    'drag-start': [payload: {id: string}];
    'drag-hover': [payload: IBookmarkDropPayload];
    'drop-bookmark': [payload: IBookmarkDropPayload];
    'drag-end': [];
    'toggle-expand': [id: string];
}>();
const treeRef = ref<HTMLElement | null>(null);

// Must match the fixed row height in DocumentBookmarkTreeItem.vue.
const BOOKMARK_ROW_HEIGHT_PX = 42;

const visibleRows = computed(() => getDocumentBookmarkVisibleRows(props.items, {
    displayMode: props.displayMode,
    expandedIds: props.expandedIds,
    activePathIds: props.activePathIds,
}));

const {
    list: virtualRows,
    containerProps,
    wrapperProps,
    scrollTo: scrollToRow,
} = useVirtualList(visibleRows, {
    itemHeight: BOOKMARK_ROW_HEIGHT_PX,
    overscan: 12,
});

// Keep the actual DOM row for focus, an unfinished rename, and the native drag
// source. Chromium cancels a drag if its source unmounts. These at most three
// rows sit at their original list positions while the viewport keeps scrolling.
const focusedId = ref<string | null>(null);
const dragSourceId = ref<string | null>(null);
const firstVirtualRowIndex = computed(() => virtualRows.value[0]?.index ?? 0);
const mountedRows = computed(() => {
    const rows = virtualRows.value.map(row => ({
        ...row,
        pinned: false,
    }));
    const retainedIds = new Set([
        focusedId.value,
        props.editingId,
        dragSourceId.value,
    ]);
    for (const id of retainedIds) {
        if (!id || rows.some(row => row.data.item.id === id)) {
            continue;
        }
        const index = visibleRows.value.findIndex(row => row.item.id === id);
        const data = visibleRows.value[index];
        if (data) {
            rows.push({
                data,
                index,
                pinned: true,
            });
        }
    }
    return rows.sort((left, right) => left.index - right.index);
});

function handleFocusIn(event: FocusEvent) {
    if (event.target instanceof Element) {
        focusedId.value = event.target.closest<HTMLElement>('[data-bookmark-id]')?.dataset.bookmarkId ?? null;
    }
}

function handleFocusOut(event: FocusEvent) {
    // A rename removes its input before the row restores focus on the next
    // tick. Retain that row through the temporary body focus in between.
    if (event.relatedTarget instanceof Node && !treeRef.value?.contains(event.relatedTarget)) {
        focusedId.value = null;
    }
}

function handleDragStart(payload: {id: string}) {
    dragSourceId.value = payload.id;
    emit('drag-start', payload);
}

watch(() => props.draggingIds?.size, size => {
    if (!size) {
        dragSourceId.value = null;
    }
});

async function handleKeydown(event: KeyboardEvent) {
    if (!(event.target instanceof HTMLElement)) {
        return;
    }
    const currentRow = event.target.closest<HTMLElement>('[data-bookmark-id]');
    if (!currentRow) {
        return;
    }
    const index = visibleRows.value.findIndex(row => row.item.id === currentRow.dataset.bookmarkId);
    let nextIndex: number;
    if (event.key === 'Tab') {
        const controls = currentRow.querySelectorAll<HTMLElement>('button, input');
        const lastControl = controls.item(controls.length - 1) ?? currentRow;
        // Preserve the full tree's tab order at the virtual window's edges,
        // including the row controls when travelling backwards.
        if (event.target !== (event.shiftKey ? currentRow : lastControl)) {
            return;
        }
        nextIndex = index + (event.shiftKey ? -1 : 1);
    } else {
        if (event.target !== currentRow) {
            return;
        }
        switch (event.key) {
            case 'ArrowDown': nextIndex = index + 1; break;
            case 'ArrowUp': nextIndex = index - 1; break;
            case 'Home': nextIndex = 0; break;
            case 'End': nextIndex = visibleRows.value.length - 1; break;
            default: return;
        }
    }
    const row = visibleRows.value[nextIndex];
    if (!row) {
        return;
    }
    event.preventDefault();
    await revealRow(row.item.id);
    await nextTick();
    const nextRow = treeRef.value?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(row.item.id)}"]`);
    const controls = nextRow?.querySelectorAll<HTMLElement>('button, input');
    const target = event.key === 'Tab' && event.shiftKey ? controls?.item(controls.length - 1) ?? nextRow : nextRow;
    target?.focus({preventScroll: true});
}

const revealRowIndex = computed(() => resolveDocumentBookmarkRevealRowIndex(
    visibleRows.value,
    props.activeId,
    props.activePathIds,
));
const revealRowId = computed(() => visibleRows.value[revealRowIndex.value]?.item.id ?? null);

async function revealRow(rowId: string) {
    await nextTick();
    const renderedRow = treeRef.value
        ?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(rowId)}"]`);
    if (renderedRow) {
        // Preserve the user's scroll position when the row is already rendered;
        // the virtual-list scroll helper aligns to an absolute row instead.
        renderedRow.scrollIntoView({block: 'nearest'});
        return;
    }
    const rowIndex = visibleRows.value.findIndex(row => row.item.id === rowId);
    if (rowIndex >= 0) {
        scrollToRow(rowIndex);
    }
}

// Follow the active bookmark whenever it moves, and whenever a display-mode or
// expansion change moves which row stands in for it. Expansion itself stays
// under the user's control: nothing here rewrites `expandedIds`.
watch(
    [
        () => props.activeId,
        revealRowId,
        () => props.editingId,
    ],
    () => {
        const rowId = props.editingId ?? revealRowId.value;
        if (!rowId) {
            return;
        }
        void revealRow(rowId);
    },
    {flush: 'post'},
);
</script>

<style scoped>
.document-bookmark-tree {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    user-select: none;
}

.document-bookmark-tree__list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
}
</style>
