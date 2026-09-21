<template>
    <div
        v-bind="containerProps"
        class="combine-file-list app-scrollbar app-scroll-region--balanced"
        :class="{ 'is-reordering': isReordering }"
        role="list"
    >
        <div
            :style="wrapperProps.style"
        >
            <div
                v-for="(row, visibleIndex) in virtualRows"
                :key="row.data.id"
                class="combine-file-row"
                :class="{ 'is-row-dragging': reorderDragIndex === visibleIndex }"
                data-combine-row
                :data-combine-row-index="row.index"
                role="listitem"
                :aria-posinset="row.index + 1"
                :aria-setsize="props.files.length"
            >
                <AppTooltip :text="t('combinePdf.dragToReorder')" :delay-duration="600">
                    <span
                        class="combine-drag-handle"
                        aria-hidden="true"
                        @pointerdown="(event) => startReorder(event, visibleIndex)"
                    >
                        <UIcon name="i-ph-dots-six-vertical" class="size-4" />
                    </span>
                </AppTooltip>
                <span class="combine-file-index">{{ row.index + 1 }}</span>
                <FileTypeIcon :kind="row.data.kind" class="combine-file-icon" />
                <span class="combine-file-copy">
                    <strong>{{ row.data.name }}</strong>
                    <span>{{ formatBytes(row.data.size) }}</span>
                </span>
                <span class="combine-row-actions">
                    <AppTooltip :text="t('combinePdf.moveUp')" :delay-duration="600">
                        <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-ph-caret-up"
                            :aria-label="t('combinePdf.moveUp')"
                            :disabled="row.index === 0 || props.queueMutationLocked"
                            @click="emit('move-file', row.index, -1)"
                        />
                    </AppTooltip>
                    <AppTooltip :text="t('combinePdf.moveDown')" :delay-duration="600">
                        <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-ph-caret-down"
                            :aria-label="t('combinePdf.moveDown')"
                            :disabled="row.index === props.files.length - 1 || props.queueMutationLocked"
                            @click="emit('move-file', row.index, 1)"
                        />
                    </AppTooltip>
                    <AppTooltip :text="t('combinePdf.removeFile')" :delay-duration="600">
                        <UButton
                            color="neutral"
                            variant="ghost"
                            size="xs"
                            icon="i-ph-x"
                            :aria-label="t('combinePdf.removeFile')"
                            :disabled="props.queueMutationLocked"
                            @click="emit('remove-file', row.index)"
                        />
                    </AppTooltip>
                </span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    useEventListener,
    useResizeObserver,
    useVirtualList,
} from '@vueuse/core';
import FileTypeIcon from '@app/components/icons/FileTypeIcon.vue';
import type { ICombineFile } from '@app/modules/combine/combinePdfTypes';
import { formatBytes } from '@app/utils/formatters';

const props = defineProps<{
    files: readonly ICombineFile[];
    queueMutationLocked: boolean;
}>();
const emit = defineEmits<{
    'move-file': [index: number, delta: -1 | 1];
    'remove-file': [index: number];
    reorder: [fromIndex: number, toIndex: number];
}>();

const { t } = useTypedI18n();
const DEFAULT_ROW_STRIDE_PX = 60;
const rowStridePx = ref(DEFAULT_ROW_STRIDE_PX);
const fileList = computed(() => props.files);

const {
    list: virtualRows,
    containerProps,
    wrapperProps,
} = useVirtualList(fileList, {
    itemHeight: () => rowStridePx.value,
    overscan: 12,
});
const listRef = containerProps.ref;

function measureRowStride() {
    const row = listRef.value?.querySelector<HTMLElement>('[data-combine-row]');
    if (!row) {
        return;
    }

    const marginBottom = Number.parseFloat(getComputedStyle(row).marginBottom) || 0;
    const nextStride = Math.max(1, Math.round(row.getBoundingClientRect().height + marginBottom));
    if (nextStride !== rowStridePx.value) {
        rowStridePx.value = nextStride;
    }
}

watch(
    virtualRows,
    () => {
        void nextTick(measureRowStride);
    },
    { flush: 'post' },
);
onMounted(() => {
    void nextTick(measureRowStride);
});
useResizeObserver(listRef, measureRowStride);
useEventListener(import.meta.client ? window : undefined, 'resize', measureRowStride);

const {
    isDragging: isReordering,
    dragIndex: reorderDragIndex,
    onPointerDown: onReorderPointerDown,
} = useListDragReorder(listRef, '[data-combine-row]', handleReorder);

function handleReorder(fromVisibleIndex: number, toVisibleIndex: number) {
    const fromRow = virtualRows.value[fromVisibleIndex];
    const toRow = virtualRows.value[toVisibleIndex];
    if (!fromRow || !toRow) {
        return;
    }
    emit('reorder', fromRow.index, toRow.index);
}

function startReorder(event: PointerEvent, visibleIndex: number) {
    if (props.queueMutationLocked) {
        return;
    }
    onReorderPointerDown(event, visibleIndex);
}
</script>

<style scoped>
.combine-file-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
}

.combine-file-row {
    display: grid;
    grid-template-columns: var(--app-combine-file-row-columns);
    align-items: center;
    gap: var(--app-combine-file-row-gap);
    min-height: var(--app-combine-file-row-min-height);
    margin-bottom: var(--app-combine-file-list-gap);
    padding: var(--app-combine-file-row-padding);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-xl);
    background: var(--ui-bg);
}

.combine-drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-text-dimmed);
    cursor: grab;
    touch-action: none;
    user-select: none;
}

.combine-drag-handle:hover {
    color: var(--ui-text-muted);
}

.combine-drag-handle:active {
    cursor: grabbing;
}

.combine-file-list.is-reordering {
    cursor: grabbing;
    user-select: none;
}

.combine-file-row.is-row-dragging {
    position: relative;
    z-index: var(--app-z-local-raised);
    border-color: var(--ui-primary);
    background: var(--ui-bg-elevated);
    box-shadow: var(--shadow-popup);
}

.combine-file-index {
    color: var(--ui-text-dimmed);
    font-variant-numeric: tabular-nums;
    text-align: center;
}

.combine-file-icon {
    width: var(--app-combine-file-icon-width);
    height: var(--app-combine-file-icon-height);
}

.combine-file-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--app-combine-file-copy-gap);
}

.combine-file-copy strong {
    overflow: hidden;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.combine-file-copy span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-meta);
}

.combine-row-actions {
    display: flex;
    align-items: center;
    gap: var(--app-space-2xs);
}

@container (max-width: 520px) {
    .combine-file-row {
        grid-template-columns: var(--app-combine-small-row-columns);
    }

    .combine-row-actions {
        grid-column: 4;
        justify-self: end;
    }
}
</style>
