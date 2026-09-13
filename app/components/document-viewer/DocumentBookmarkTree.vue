<template>
    <div ref="treeRef" class="document-bookmark-tree">
        <div
            v-bind="containerProps"
            class="document-bookmark-tree__list app-scrollbar app-scroll-region--balanced"
        >
            <div v-bind="wrapperProps">
                <DocumentBookmarkTreeItem
                    v-for="row in virtualRows"
                    :key="row.data.item.id"
                    :item="row.data.item"
                    :depth="row.data.depth"
                    :is-expanded="row.data.isExpanded"
                    :is-active="row.data.item.id === activeId"
                    @activate="emit('activate', $event)"
                    @toggle-expand="emit('toggle-expand', $event)"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {useVirtualList} from '@vueuse/core';
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
}>();
const emit = defineEmits<{
    activate: [id: string];
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
    ],
    () => {
        const rowId = revealRowId.value;
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
