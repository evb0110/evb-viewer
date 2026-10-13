<template>
    <div
        ref="rowRef"
        class="document-bookmark-item__row"
        :class="{
            'pdf-bookmark-item-row': editMode,
            'is-active': isActive,
            'is-selected': editMode && isSelected,
            'is-editing': isEditing,
            'is-dragging': isDragging,
            'is-drop-before': dropPosition === 'before',
            'is-drop-after': dropPosition === 'after',
            'is-drop-child': dropPosition === 'child',
        }"
        :data-bookmark-id="item.id"
        :style="rowStyle"
        tabindex="0"
        role="button"
        :aria-current="isActive ? 'location' : undefined"
        :draggable="editMode && !isEditing"
        @click="activate"
        @keydown.enter.prevent="activate"
        @keydown.space.prevent="activate"
        @contextmenu="openActionsFromPointer"
        @dragstart="handleDragStart"
        @dragover.prevent="handleDragOver"
        @drop.prevent.stop="handleDrop"
        @dragend="emit('drag-end')"
    >
        <span v-if="editMode" class="pdf-bookmark-item-drag-handle" aria-hidden="true">
            <UIcon name="i-ph-dots-six-vertical" class="size-3.5" />
        </span>
        <button
            v-if="item.children.length > 0"
            type="button"
            class="document-bookmark-item__toggle"
            :class="{'pdf-bookmark-item-toggle': editMode}"
            :aria-label="isExpanded ? t('bookmarks.collapse') : t('bookmarks.expand')"
            :aria-expanded="isExpanded"
            @click.stop="emit('toggle-expand', item.id)"
            @keydown.enter.stop
            @keydown.space.stop
        ><UIcon :name="isExpanded ? 'i-ph-caret-down' : 'i-ph-caret-right'" class="size-4" /></button>
        <span v-else class="document-bookmark-item__spacer" />
        <input
            v-if="isEditing"
            ref="titleInputRef"
            v-model="editingTitle"
            type="text"
            dir="auto"
            class="pdf-bookmark-item-input"
            @click.stop
            @keydown.stop
            @keydown.enter.prevent="commitEdit"
            @keydown.escape.prevent="cancelEdit"
            @blur="commitEdit"
        >
        <AppTooltip v-else :text="item.title || t('bookmarks.untitled')" :delay-duration="800">
            <span
                class="document-bookmark-item__title"
                dir="auto"
                :style="titleStyle"
            >{{ item.title || t('bookmarks.untitled') }}</span>
        </AppTooltip>
        <AppTooltip v-if="editMode" :text="t('bookmarks.actions')" :delay-duration="800">
            <button
                type="button"
                class="pdf-bookmark-item-actions-trigger"
                :aria-label="t('bookmarks.actions')"
                @click.stop="openActionsFromButton"
                @keydown.enter.stop
                @keydown.space.stop
            ><UIcon name="i-ph-dots-three" class="size-4" /></button>
        </AppTooltip>
    </div>
</template>

<script setup lang="ts">
import type {IDocumentBookmarkTreeItem} from '@app/modules/document-viewer/public';
import type {
    IBookmarkDropPayload,
    IBookmarkMenuPayload,
    TBookmarkDropPosition,
} from '@app/types/pdfOutline';
import {getEventCurrentTarget} from '@app/utils/getEventCurrentTarget';

const props = defineProps<{
    item: IDocumentBookmarkTreeItem;
    depth: number;
    isExpanded: boolean;
    isActive: boolean;
    editMode?: boolean;
    isSelected?: boolean | undefined;
    isEditing?: boolean;
    isDragging?: boolean | undefined;
    dropPosition?: TBookmarkDropPosition | undefined;
    canDrop?: boolean;
}>();
const emit = defineEmits<{
    activate: [id: string, event: MouseEvent | KeyboardEvent];
    'toggle-expand': [id: string];
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
}>();
const {t} = useTypedI18n();
const rowRef = ref<HTMLElement | null>(null);
const titleInputRef = ref<HTMLInputElement | null>(null);
const editingTitle = ref('');
const rowStyle = computed(() => ({marginInlineStart: `calc(${String(props.depth)} * var(--app-sidebar-outline-depth-indent))`}));
const titleStyle = computed(() => ({
    color: props.item.color ?? undefined,
    fontWeight: props.item.bold ? '600' : '500',
    fontStyle: props.item.italic ? 'italic' : 'normal',
}));

watch(() => props.isEditing, async editing => {
    if (!editing) {
        return;
    }
    editingTitle.value = props.item.title;
    await nextTick();
    titleInputRef.value?.focus();
    titleInputRef.value?.select();
}, {immediate: true});

function activate(event: MouseEvent | KeyboardEvent) {
    if (!props.isEditing && !(event instanceof MouseEvent && event.button !== 0)) {
        emit('activate', props.item.id, event);
    }
}

function openActionsFromPointer(event: MouseEvent) {
    if (props.editMode) {
        event.preventDefault();
        event.stopPropagation();
        emit('open-actions', {
            id: props.item.id,
            x: event.clientX,
            y: event.clientY,
        });
    }
}

function openActionsFromButton(event: MouseEvent) {
    const rect = getEventCurrentTarget(event, HTMLElement)?.getBoundingClientRect();
    emit('open-actions', {
        id: props.item.id,
        x: rect?.right ?? event.clientX,
        y: rect?.bottom ?? event.clientY,
    });
}

async function commitEdit() {
    if (!props.isEditing) {
        return;
    }
    const restoreFocus = document.activeElement === titleInputRef.value;
    emit('save-edit', {
        id: props.item.id,
        title: editingTitle.value,
    });
    await nextTick();
    if (restoreFocus) {
        rowRef.value?.focus();
    }
}

async function cancelEdit() {
    emit('cancel-edit');
    await nextTick();
    rowRef.value?.focus();
}

function detectDropPosition(event: DragEvent): TBookmarkDropPosition {
    const rect = getEventCurrentTarget(event, HTMLElement)?.getBoundingClientRect();
    const ratio = rect && rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    if (ratio < 0.28) {
        return 'before';
    }
    return ratio > 0.72 ? 'after' : 'child';
}

function handleDragStart(event: DragEvent) {
    if (!props.editMode || props.isEditing) {
        event.preventDefault();
        return;
    }
    event.dataTransfer?.setData('text/plain', props.item.id);
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
    }
    emit('drag-start', {id: props.item.id});
}

function handleDragOver(event: DragEvent) {
    if (!props.canDrop) {
        return;
    }
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
    }
    emit('drag-hover', {
        targetId: props.item.id,
        position: detectDropPosition(event),
    });
}

function handleDrop(event: DragEvent) {
    if (props.canDrop) {
        emit('drop-bookmark', {
            targetId: props.item.id,
            position: detectDropPosition(event),
        });
    }
}
</script>

<style scoped>
.document-bookmark-item__row {
    position: relative;
    box-sizing: border-box;
    scroll-margin-block: var(--app-space-xs);

    /* Fixed row height shared with DocumentBookmarkTree. */
    height: calc(var(--app-sidebar-action-size) + 2 * var(--app-sidebar-row-padding-block) + 2px);
    display: flex;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    border-radius: var(--app-outline-row-radius);
    cursor: pointer;
    border: 1px solid transparent;
    transition:
        background-color 0.15s,
        border-color 0.15s,
        color 0.15s,
        outline-color 0.15s;
    user-select: none;
    outline: none;
}

.document-bookmark-item__row:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.document-bookmark-item__row:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 35%, transparent 65%);
}

.document-bookmark-item__row.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
    color: var(--ui-text);
}

.document-bookmark-item__row.is-selected {
    border-color: color-mix(in srgb, var(--ui-primary) 24%, var(--ui-border) 76%);
    background: color-mix(in srgb, var(--ui-primary) 10%, var(--app-sidebar-bg) 90%);
    outline: 1px solid color-mix(in srgb, var(--ui-primary) 28%, transparent 72%);
    outline-offset: -1px;
}

.document-bookmark-item__row.is-active.is-selected {
    border-color: color-mix(in srgb, var(--ui-primary) 36%, var(--app-control-active-border) 64%);
    background: color-mix(in srgb, var(--ui-primary) 12%, var(--app-sidebar-bg) 88%);
    outline-color: color-mix(in srgb, var(--ui-primary) 42%, transparent 58%);
}

.document-bookmark-item__row.is-editing {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
}

.document-bookmark-item__row.is-dragging {
    opacity: 0.55;
}

.document-bookmark-item__row.is-drop-before::before,
.document-bookmark-item__row.is-drop-after::after {
    content: '';
    position: absolute;
    left: var(--app-outline-row-inset);
    right: var(--app-outline-row-inset);
    height: var(--app-drop-indicator-height);
    border-radius: var(--app-outline-drop-indicator-radius);
    background: color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

.document-bookmark-item__row.is-drop-before::before {
    top: calc(var(--app-drop-indicator-height) * -1);
}

.document-bookmark-item__row.is-drop-after::after {
    bottom: calc(var(--app-drop-indicator-height) * -1);
}

.document-bookmark-item__row.is-drop-child {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 45%, transparent 55%);
}

.pdf-bookmark-item-drag-handle {
    width: var(--app-outline-expand-icon-width);
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-text-dimmed);
    opacity: 0.8;
}

.document-bookmark-item__toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    padding: 0;
    border: none;
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
    border-radius: var(--app-outline-action-radius);
}

.document-bookmark-item__toggle:hover {
    background: var(--ui-bg-elevated);
}

.document-bookmark-item__spacer {
    width: var(--app-sidebar-action-size);
    flex-shrink: 0;
}

.document-bookmark-item__title {
    flex: 1;
    min-width: 0;
    font-size: var(--app-sidebar-row-font-size);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pdf-bookmark-item-input {
    flex: 1;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    border-radius: var(--app-outline-action-radius);
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    font-size: var(--app-sidebar-caption-font-size);
    line-height: 1.4;
    padding: var(--app-space-3xs) var(--app-space-2xl);
}

.pdf-bookmark-item-input:focus {
    outline: none;
    border-color: var(--ui-primary);
}

.pdf-bookmark-item-actions-trigger {
    flex-shrink: 0;
    width: var(--app-sidebar-action-size);
    height: var(--app-sidebar-action-size);
    border: 1px solid transparent;
    border-radius: var(--app-radius-sm);
    background: transparent;
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
}

.pdf-bookmark-item-actions-trigger:hover {
    color: var(--ui-text-highlighted);
    border-color: var(--ui-border);
    background: var(--ui-bg-elevated);
}

.document-bookmark-item__row:hover .pdf-bookmark-item-actions-trigger,
.document-bookmark-item__row.is-active .pdf-bookmark-item-actions-trigger,
.document-bookmark-item__row:focus-within .pdf-bookmark-item-actions-trigger {
    opacity: 1;
    pointer-events: auto;
}

</style>
