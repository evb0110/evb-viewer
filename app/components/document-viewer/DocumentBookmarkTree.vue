<template>
    <div
        ref="treeRef"
        class="document-bookmark-tree"
        @focusin="handleFocusIn"
        @focusout="handleFocusOut"
        @keydown="handleKeydown"
    >
        <div
            ref="rowMeasureRef"
            class="document-bookmark-tree__row-measure"
            aria-hidden="true"
        />
        <div
            v-bind="containerProps"
            class="document-bookmark-tree__list app-scrollbar app-scroll-region--balanced"
            @wheel="handleWheel"
        >
            <div
                v-bind="wrapperProps"
                style="position: relative"
            >
                <DocumentBookmarkTreeItem
                    v-for="row in mountedRows"
                    :key="row.id"
                    :item="row.item"
                    :depth="row.depth"
                    :style="row.style"
                    :is-expanded="row.isExpanded"
                    :is-active="row.isActive"
                    :edit-mode="editMode"
                    :is-selected="row.isSelected"
                    :is-editing="row.isEditing"
                    :is-dragging="row.isDragging"
                    :drop-position="row.dropPosition"
                    :can-drop="canDrop"
                    @activate="handleActivate"
                    @open-actions="emit('open-actions', $event)"
                    @save-edit="completeEdit"
                    @cancel-edit="completeEdit()"
                    @drag-start="handleDragStart"
                    @drag-hover="emit('drag-hover', $event)"
                    @drop-bookmark="emit('drop-bookmark', $event)"
                    @drag-end="emit('drag-end')"
                    @toggle-expand="emit('toggle-expand', $event)"
                />
            </div>
            <slot name="after">
                <div style="padding-block-end: var(--app-space-xs)" />
            </slot>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {CSSProperties} from 'vue';
import {useElementSize, useVirtualList} from '@vueuse/core';
import type {IBookmarkDropPayload, IBookmarkDropTarget, IBookmarkMenuPayload, TBookmarkDropPosition} from '@app/types/pdfOutline';
import {
    getDocumentBookmarkVisibleRows,
    resolveDocumentBookmarkRevealRowIndex,
    resolveDocumentWheelInteraction,
    type IDocumentBookmarkTreeItem,
    type TDocumentBookmarkDisplayMode,
} from '@app/modules/document-viewer/public';
import DocumentBookmarkTreeItem from '@app/components/document-viewer/DocumentBookmarkTreeItem.vue';

const {
    items,
    activeId,
    displayMode,
    expandedIds,
    activePathIds,
    editMode = false,
    editingId,
    selectedIds,
    draggingIds,
    dropTarget,
} = defineProps<{
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
    'save-edit': [
        payload: {
            id: string;
            title: string;
        },
    ];
    'cancel-edit': [];
    'drag-start': [payload: {id: string}];
    'drag-hover': [payload: IBookmarkDropPayload];
    'drop-bookmark': [payload: IBookmarkDropPayload];
    'drag-end': [];
    'toggle-expand': [id: string];
}>();
const treeRef = ref<HTMLElement | null>(null);

const rowMeasureRef = ref<HTMLElement | null>(null);
const {height: measuredRowHeight} = useElementSize(rowMeasureRef);
const rowHeight = computed(() => measuredRowHeight.value || 42);

const visibleRows = computed(() =>
    getDocumentBookmarkVisibleRows(items, {
        displayMode,
        expandedIds,
        activePathIds,
    }),
);

const {
    list: virtualRows,
    containerProps,
    wrapperProps,
    scrollTo: scrollToRow,
} = useVirtualList(visibleRows, {
    itemHeight: () => rowHeight.value,
    overscan: 12,
});

// Keep the actual DOM row for focus, an unfinished rename, and the native drag
// source. Chromium cancels a drag if its source unmounts. These at most three
// rows sit at their original list positions while the viewport keeps scrolling.
const focusedId = ref<string | null>(null);
const dragSourceId = ref<string | null>(null);
const canDrop = computed(() => Boolean(editMode && draggingIds?.size));

interface IMountedBookmarkRow {
    id: string;
    item: IDocumentBookmarkTreeItem;
    depth: number;
    isExpanded: boolean;
    style: CSSProperties | undefined;
    isActive: boolean;
    isSelected: boolean;
    isEditing: boolean;
    isDragging: boolean;
    dropPosition: TBookmarkDropPosition | undefined;
}

const mountedRows = computed<IMountedBookmarkRow[]>(() => {
    const firstVirtualIndex = virtualRows.value[0]?.index ?? 0;
    const rows = virtualRows.value.map((row) => ({
        ...row,
        pinned: false,
    }));
    const retainedIds = new Set([focusedId.value, editingId, dragSourceId.value]);
    for (const id of retainedIds) {
        if (!id || rows.some((row) => row.data.item.id === id)) {
            continue;
        }
        const index = visibleRows.value.findIndex((row) => row.item.id === id);
        const data = visibleRows.value[index];
        if (data) {
            rows.push({
                data,
                index,
                pinned: true,
            });
        }
    }
    rows.sort((left, right) => left.index - right.index);
    return rows.map((row): IMountedBookmarkRow => {
        const {item, depth, isExpanded} = row.data;
        const id = item.id;
        return {
            id,
            item,
            depth,
            isExpanded,
            style: row.pinned
                ? {
                      position: 'absolute',
                      top: `${(row.index - firstVirtualIndex) * rowHeight.value}px`,
                      insetInline: 0,
                  }
                : undefined,
            isActive: id === activeId,
            isSelected: Boolean(selectedIds?.has(id)),
            isEditing: editingId === id,
            isDragging: Boolean(draggingIds?.has(id)),
            dropPosition: dropTarget?.id === id ? dropTarget.position : undefined,
        };
    });
});

function handleActivate(id: string, event?: MouseEvent | KeyboardEvent) {
    emit('activate', id, event);
}

function handleFocusIn(event: FocusEvent) {
    if (event.target instanceof Element) {
        focusedId.value = event.target.closest<HTMLElement>('[data-bookmark-id]')?.dataset.bookmarkId ?? null;
    }
}

function handleFocusOut(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !treeRef.value?.contains(event.relatedTarget)) {
        focusedId.value = null;
    }
}

function completeEdit(payload?: {id: string; title: string}) {
    const rowId = editingId ?? null;
    const input = document.activeElement;
    const restoreFocus =
        input?.matches('.pdf-bookmark-item-input') && input.closest<HTMLElement>('[data-bookmark-id]')?.dataset.bookmarkId === rowId;
    if (payload) {
        emit('save-edit', payload);
    } else {
        emit('cancel-edit');
    }
    // Pointer blur leaves its next target in charge. Keyboard completion uses
    // the tree's reveal while the edited row is still retained for this flush.
    if (restoreFocus) {
        void focusRow(rowId);
    }
}

function handleWheel(event: WheelEvent) {
    const list = containerProps.ref.value;
    if (!editingId || !list || !event.cancelable || event.shiftKey) {
        return;
    }
    if (event.deltaX !== 0 || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        return;
    }
    const interaction = resolveDocumentWheelInteraction(event, list);
    if (interaction.intent !== 'scroll') {
        return;
    }
    // Apply editing input in event order. The compositor's delayed default can
    // otherwise overtake the subsequent keyboard completion reveal.
    event.preventDefault();
    list.scrollBy({
        top: interaction.deltaPx,
        behavior: 'instant',
    });
    containerProps.onScroll();
}

function handleDragStart(payload: {id: string}) {
    dragSourceId.value = payload.id;
    emit('drag-start', payload);
}

watch(
    () => draggingIds?.size,
    (size) => {
        if (!size) {
            dragSourceId.value = null;
        }
    },
);

async function handleTabKeydown(event: KeyboardEvent, currentRow: HTMLElement, index: number) {
    const controls = currentRow.querySelectorAll<HTMLElement>('button, input');
    const lastControl = controls.item(controls.length - 1) ?? currentRow;
    // Preserve the full tree's tab order at the virtual window's edges,
    // including the row controls when travelling backwards.
    if (event.target !== (event.shiftKey ? currentRow : lastControl)) {
        return;
    }
    const nextRow = visibleRows.value[index + (event.shiftKey ? -1 : 1)];
    if (!nextRow) {
        return;
    }
    event.preventDefault();
    await focusRow(nextRow.item.id, event.shiftKey);
}

function resolveNavigationTargetIndex(key: string, index: number, current: (typeof visibleRows.value)[number]): number {
    switch (key) {
        case 'ArrowDown':
            return index + 1;
        case 'ArrowUp':
            return index - 1;
        case 'ArrowRight':
            return current.item.children.length > 0 && current.isExpanded ? index + 1 : -1;
        case 'ArrowLeft':
            return visibleRows.value.findLastIndex((row, rowIndex) => rowIndex < index && row.depth < current.depth);
        case 'Home':
            return 0;
        case 'End':
            return visibleRows.value.length - 1;
        default:
            return -1;
    }
}

async function handleKeydown(event: KeyboardEvent) {
    if (!(event.target instanceof HTMLElement)) {
        return;
    }
    const currentRow = event.target.closest<HTMLElement>('[data-bookmark-id]');
    if (!currentRow) {
        return;
    }
    const index = visibleRows.value.findIndex((row) => row.item.id === currentRow.dataset.bookmarkId);
    const current = visibleRows.value[index];
    if (!current) {
        return;
    }
    if (event.key === 'Tab') {
        await handleTabKeydown(event, currentRow, index);
        return;
    }
    if (event.target !== currentRow) {
        return;
    }
    const shouldToggleExpand =
        (event.key === 'ArrowRight' && current.item.children.length > 0 && !current.isExpanded) ||
        (event.key === 'ArrowLeft' && current.isExpanded);
    if (shouldToggleExpand) {
        event.preventDefault();
        emit('toggle-expand', current.item.id);
        await focusRow(current.item.id);
        return;
    }
    const nextRow = visibleRows.value[resolveNavigationTargetIndex(event.key, index, current)];
    if (!nextRow) {
        return;
    }
    event.preventDefault();
    await focusRow(nextRow.item.id);
}

const revealRowId = computed(
    () => visibleRows.value[resolveDocumentBookmarkRevealRowIndex(visibleRows.value, activeId, activePathIds)]?.item.id ?? null,
);

function revealRow(rowId: string) {
    const renderedRow = treeRef.value?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(rowId)}"]`);
    if (renderedRow) {
        // Preserve the user's scroll position when the row is already rendered;
        // the virtual-list scroll helper aligns to an absolute row instead.
        renderedRow.scrollIntoView({
            block: 'nearest',
            behavior: 'instant',
        });
        containerProps.onScroll();
        return;
    }
    const rowIndex = visibleRows.value.findIndex((row) => row.item.id === rowId);
    if (rowIndex >= 0) {
        scrollToRow(rowIndex, {behavior: 'instant'});
    }
}

async function focusRow(rowId: string | null, lastControl = false) {
    if (!rowId) {
        return;
    }
    revealRow(rowId);
    await nextTick();
    const row = treeRef.value?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(rowId)}"]`);
    const controls = row?.querySelectorAll<HTMLElement>('button, input');
    const target = lastControl ? (controls?.item(controls.length - 1) ?? row) : row;
    target?.focus({preventScroll: true});
}

// Undo can replace a focused row or hide it behind a collapsed parent. Capture
// DOM ownership before Vue removes it, then focus a surviving visible neighbor.
watch(visibleRows, async (rows, previousRows) => {
    const element = document.activeElement;
    if (!element || !treeRef.value?.contains(element) || editingId) {
        return;
    }
    const index = previousRows.findIndex((row) => row.item.id === focusedId.value);
    const ids = new Set(rows.map((row) => row.item.id));
    const survives = (row: (typeof rows)[number]) => ids.has(row.item.id);
    const row =
        rows.find((candidate) => candidate.item.id === focusedId.value) ??
        previousRows.slice(index + 1).find(survives) ??
        previousRows.slice(0, index).findLast(survives);
    await nextTick();
    if (row && !element.isConnected && document.activeElement === document.body) {
        await focusRow(row.item.id);
    }
});

defineExpose({focusActiveRow: () => focusRow(revealRowId.value)});

// Follow the active bookmark whenever it moves, and whenever a display-mode or
// expansion change moves which row stands in for it. Expansion itself stays
// under the user's control: nothing here rewrites `expandedIds`.
watch(
    [() => activeId, revealRowId],
    () => {
        // Passive page resolution after Undo must not scroll away from the
        // row the person is using. A clicked row already owns DOM focus.
        const rowId = treeRef.value?.contains(document.activeElement) ? focusedId.value : revealRowId.value;
        if (rowId) {
            revealRow(rowId);
        }
    },
    {flush: 'post'},
);
</script>

<style scoped>
.document-bookmark-tree {
    --bookmark-row-height: calc(var(--app-sidebar-action-size) + 2 * var(--app-sidebar-row-padding-block) + 2px);

    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    user-select: none;
}

.document-bookmark-tree__row-measure {
    position: absolute;
    height: var(--bookmark-row-height);
    visibility: hidden;
}

.document-bookmark-tree__list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
}
</style>
