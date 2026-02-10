<template>
    <div class="pdf-bookmark-item">
        <div
            class="pdf-bookmark-item-row"
            :class="{
                'is-active': isActive,
                'is-editing': isEditing,
                'is-dragging': isDragging,
                'is-drop-before': isDropTargetBefore,
                'is-drop-after': isDropTargetAfter,
                'is-drop-child': isDropTargetChild,
                'is-style-range-start': isStyleRangeStart,
            }"
            tabindex="0"
            role="button"
            :draggable="isEditMode && !isEditing"
            @click="handleClick"
            @keydown.enter.prevent="handleClick"
            @keydown.space.prevent="handleClick"
            @contextmenu.prevent.stop="openActionsFromPointer"
            @dragstart="handleDragStart"
            @dragover.prevent="handleDragOver"
            @drop.prevent="handleDrop"
            @dragend="handleDragEnd"
        >
            <span
                v-if="isEditMode"
                class="pdf-bookmark-item-drag-handle"
                aria-hidden="true"
            >
                <UIcon
                    name="i-lucide-grip-vertical"
                    class="size-3.5"
                />
            </span>
            <button
                v-if="hasChildren"
                type="button"
                class="pdf-bookmark-item-toggle"
                @click.stop="emit('toggle-expand', item.id)"
            >
                <UIcon
                    :name="isExpanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    class="size-4"
                />
            </button>
            <span
                v-else
                class="pdf-bookmark-item-spacer"
            />

            <input
                v-if="isEditing"
                ref="titleInputRef"
                v-model="editingTitle"
                type="text"
                class="pdf-bookmark-item-input"
                @click.stop
                @keydown.enter.prevent="commitEdit"
                @keydown.escape.prevent="cancelEdit"
                @blur="commitEdit"
            >
            <span
                v-else
                class="pdf-bookmark-item-title"
                :style="bookmarkTitleStyle"
                :title="item.title || 'Untitled Bookmark'"
            >
                {{ item.title || 'Untitled Bookmark' }}
            </span>

            <button
                v-if="isEditMode"
                type="button"
                class="pdf-bookmark-item-actions-trigger"
                aria-label="Bookmark actions"
                @click.stop="openActionsFromButton"
            >
                <UIcon
                    name="i-lucide-ellipsis"
                    class="size-4"
                />
            </button>
        </div>

        <div
            v-if="hasChildren && isExpanded"
            class="pdf-bookmark-item-children"
        >
            <PdfOutlineItem
                v-for="(child, index) in item.items"
                :key="child.id || index"
                :item="child"
                :pdf-document="pdfDocument"
                :active-item-id="activeItemId"
                :editing-item-id="editingItemId"
                :display-mode="displayMode"
                :expanded-bookmark-ids="expandedBookmarkIds"
                :active-path-bookmark-ids="activePathBookmarkIds"
                :is-edit-mode="isEditMode"
                :dragging-item-id="draggingItemId"
                :drop-target="dropTarget"
                :style-range-start-id="styleRangeStartId"
                @go-to-page="emit('go-to-page', $event)"
                @activate="emit('activate', $event)"
                @toggle-expand="emit('toggle-expand', $event)"
                @open-actions="emit('open-actions', $event)"
                @save-edit="emit('save-edit', $event)"
                @cancel-edit="emit('cancel-edit')"
                @drag-start="emit('drag-start', $event)"
                @drag-hover="emit('drag-hover', $event)"
                @drop-bookmark="emit('drop-bookmark', $event)"
                @drag-end="emit('drag-end')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IRefProxy {
    num: number;
    gen: number;
}

type TDropPosition = 'before' | 'after' | 'child';

interface IBookmarkItem {
    title: string;
    dest: string | unknown[] | null;
    id: string;
    pageIndex: number | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IBookmarkItem[];
}

interface IBookmarkMenuPayload {
    id: string;
    x: number;
    y: number;
}

interface IDropTarget {
    id: string;
    position: TDropPosition;
}

interface IDragHoverPayload {
    targetId: string;
    position: TDropPosition;
}

interface IProps {
    item: IBookmarkItem;
    pdfDocument: PDFDocumentProxy | null;
    activeItemId: string | null;
    editingItemId: string | null;
    displayMode: 'top-level' | 'all-expanded' | 'current-expanded';
    expandedBookmarkIds: Set<string>;
    activePathBookmarkIds: Set<string>;
    isEditMode: boolean;
    draggingItemId: string | null;
    dropTarget: IDropTarget | null;
    styleRangeStartId: string | null;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'go-to-page', page: number): void;
    (e: 'activate', payload: {
        id: string;
        hasChildren: boolean;
        wasActive: boolean;
    }): void;
    (e: 'toggle-expand', id: string): void;
    (e: 'open-actions', payload: IBookmarkMenuPayload): void;
    (e: 'save-edit', payload: {
        id: string;
        title: string;
    }): void;
    (e: 'cancel-edit'): void;
    (e: 'drag-start', payload: { id: string }): void;
    (e: 'drag-hover', payload: IDragHoverPayload): void;
    (e: 'drop-bookmark', payload: IDragHoverPayload): void;
    (e: 'drag-end'): void;
}>();

const editingTitle = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

const hasChildren = computed(() => props.item.items.length > 0);
const isActive = computed(() => props.item.id === props.activeItemId);
const isEditing = computed(() => props.item.id === props.editingItemId);
const isDragging = computed(() => props.item.id === props.draggingItemId);
const isDropTargetBefore = computed(() => (
    props.dropTarget?.id === props.item.id
    && props.dropTarget.position === 'before'
));
const isDropTargetAfter = computed(() => (
    props.dropTarget?.id === props.item.id
    && props.dropTarget.position === 'after'
));
const isDropTargetChild = computed(() => (
    props.dropTarget?.id === props.item.id
    && props.dropTarget.position === 'child'
));
const isStyleRangeStart = computed(() => props.styleRangeStartId === props.item.id);

const bookmarkTitleStyle = computed(() => ({
    color: props.item.color ?? undefined,
    fontWeight: props.item.bold ? '600' : '500',
    fontStyle: props.item.italic ? 'italic' : 'normal',
}));

const isExpanded = computed(() => {
    if (!hasChildren.value) {
        return false;
    }

    if (props.displayMode === 'all-expanded') {
        return true;
    }

    if (props.displayMode === 'current-expanded') {
        return props.activePathBookmarkIds.has(props.item.id);
    }

    return props.expandedBookmarkIds.has(props.item.id);
});

watch(
    isEditing,
    async (value) => {
        if (!value) {
            return;
        }

        editingTitle.value = props.item.title;
        await nextTick();
        titleInputRef.value?.focus();
        titleInputRef.value?.select();
    },
    { immediate: true },
);

watch(
    () => props.item.title,
    (value) => {
        if (!isEditing.value) {
            editingTitle.value = value;
        }
    },
    { immediate: true },
);

function isRefProxy(value: unknown): value is IRefProxy {
    return (
        typeof value === 'object'
        && value !== null
        && 'num' in value
        && 'gen' in value
        && typeof (value as IRefProxy).num === 'number'
        && typeof (value as IRefProxy).gen === 'number'
    );
}

function openActions(payload: IBookmarkMenuPayload) {
    emit('open-actions', payload);
}

function openActionsFromPointer(event: MouseEvent) {
    if (!props.isEditMode) {
        return;
    }

    openActions({
        id: props.item.id,
        x: event.clientX,
        y: event.clientY,
    });
}

function openActionsFromButton(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    openActions({
        id: props.item.id,
        x: rect ? rect.right : event.clientX,
        y: rect ? rect.bottom : event.clientY,
    });
}

function commitEdit() {
    emit('save-edit', {
        id: props.item.id,
        title: editingTitle.value,
    });
}

function cancelEdit() {
    editingTitle.value = props.item.title;
    emit('cancel-edit');
}

function detectDropPosition(event: DragEvent): TDropPosition {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
        return 'after';
    }

    const rect = target.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const ratio = rect.height > 0 ? offsetY / rect.height : 0.5;

    if (ratio < 0.28) {
        return 'before';
    }
    if (ratio > 0.72) {
        return 'after';
    }
    return 'child';
}

function handleDragStart(event: DragEvent) {
    if (!props.isEditMode || isEditing.value) {
        event.preventDefault();
        return;
    }

    event.dataTransfer?.setData('text/plain', props.item.id);
    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
    }
    emit('drag-start', { id: props.item.id });
}

function handleDragOver(event: DragEvent) {
    if (!props.isEditMode || !props.draggingItemId) {
        return;
    }

    const position = detectDropPosition(event);
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
    }
    emit('drag-hover', {
        targetId: props.item.id,
        position,
    });
}

function handleDrop(event: DragEvent) {
    if (!props.isEditMode || !props.draggingItemId) {
        return;
    }

    const position = detectDropPosition(event);
    emit('drop-bookmark', {
        targetId: props.item.id,
        position,
    });
}

function handleDragEnd() {
    if (!props.isEditMode) {
        return;
    }
    emit('drag-end');
}

async function handleClick(event?: MouseEvent | KeyboardEvent) {
    if (event instanceof MouseEvent && event.button !== 0) {
        return;
    }

    const wasActive = isActive.value;
    emit('activate', {
        id: props.item.id,
        hasChildren: hasChildren.value,
        wasActive,
    });

    if (isEditing.value) {
        return;
    }

    if (wasActive && hasChildren.value) {
        emit('toggle-expand', props.item.id);
        return;
    }

    if (typeof props.item.pageIndex === 'number') {
        emit('go-to-page', props.item.pageIndex + 1);
        return;
    }

    if (!props.pdfDocument || !props.item.dest) {
        return;
    }

    try {
        let dest: unknown[] | null = null;

        if (typeof props.item.dest === 'string') {
            dest = await props.pdfDocument.getDestination(props.item.dest);
        } else if (Array.isArray(props.item.dest)) {
            dest = props.item.dest;
        }

        if (!dest || dest.length === 0) {
            return;
        }

        const pageRef = dest[0];
        if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
            const maybeIndex = Math.trunc(pageRef);
            if (maybeIndex >= 0 && maybeIndex < props.pdfDocument.numPages) {
                emit('go-to-page', maybeIndex + 1);
                return;
            }
            if (maybeIndex > 0 && maybeIndex <= props.pdfDocument.numPages) {
                emit('go-to-page', maybeIndex);
                return;
            }
            return;
        }

        if (!isRefProxy(pageRef)) {
            return;
        }

        const pageIndex = await props.pdfDocument.getPageIndex(pageRef);
        emit('go-to-page', pageIndex + 1);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isKnownPdfIssue =
            message.includes('does not point to a /Page dictionary')
            || message.includes('page must be a reference');

        if (!isKnownPdfIssue) {
            console.error('Failed to navigate to bookmark destination:', error);
        }
    }
}
</script>

<style scoped>
.pdf-bookmark-item-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s;
    user-select: none;
    outline: none;
}

.pdf-bookmark-item-row:hover {
    background: var(--ui-bg-muted);
}

.pdf-bookmark-item-row:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 35%, transparent 65%);
}

.pdf-bookmark-item-row.is-active {
    background: var(--ui-bg-accented);
    color: var(--ui-primary);
}

.pdf-bookmark-item-row.is-editing {
    background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg) 90%);
}

.pdf-bookmark-item-row.is-dragging {
    opacity: 0.55;
}

.pdf-bookmark-item-row.is-drop-before::before,
.pdf-bookmark-item-row.is-drop-after::after {
    content: '';
    position: absolute;
    left: 4px;
    right: 4px;
    height: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

.pdf-bookmark-item-row.is-drop-before::before {
    top: -2px;
}

.pdf-bookmark-item-row.is-drop-after::after {
    bottom: -2px;
}

.pdf-bookmark-item-row.is-drop-child {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 45%, transparent 55%);
}

.pdf-bookmark-item-row.is-style-range-start {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #f59e0b 52%, transparent 48%);
}

.pdf-bookmark-item-drag-handle {
    width: 12px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-text-dimmed);
    opacity: 0.8;
}

.pdf-bookmark-item-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: none;
    color: var(--ui-text-muted);
    cursor: pointer;
    border-radius: 4px;
}

.pdf-bookmark-item-toggle:hover {
    background: var(--ui-bg-elevated);
}

.pdf-bookmark-item-spacer {
    width: 20px;
    flex-shrink: 0;
}

.pdf-bookmark-item-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pdf-bookmark-item-input {
    flex: 1;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    font-size: 12px;
    line-height: 1.4;
    padding: 3px 6px;
}

.pdf-bookmark-item-input:focus {
    outline: none;
    border-color: var(--ui-primary);
}

.pdf-bookmark-item-actions-trigger {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border: 1px solid transparent;
    border-radius: 5px;
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

.pdf-bookmark-item-row:hover .pdf-bookmark-item-actions-trigger,
.pdf-bookmark-item-row.is-active .pdf-bookmark-item-actions-trigger,
.pdf-bookmark-item-row:focus-within .pdf-bookmark-item-actions-trigger {
    opacity: 1;
    pointer-events: auto;
}

.pdf-bookmark-item-children {
    padding-left: 16px;
}
</style>
