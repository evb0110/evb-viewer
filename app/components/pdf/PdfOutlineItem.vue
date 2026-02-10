<template>
    <div class="pdf-bookmark-item">
        <div
            class="pdf-bookmark-item-row"
            :class="{
                'is-active': isActive,
                'is-editing': isEditing,
            }"
            tabindex="0"
            role="button"
            @click="handleClick"
            @keydown.enter.prevent="handleClick"
            @keydown.space.prevent="handleClick"
            @contextmenu.prevent.stop="openActionsFromPointer"
        >
            <button
                v-if="hasChildren"
                type="button"
                class="pdf-bookmark-item-toggle"
                :disabled="isToggleDisabled"
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
            />
            <span
                v-else
                class="pdf-bookmark-item-title"
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
                @go-to-page="emit('go-to-page', $event)"
                @activate="emit('activate', $event)"
                @toggle-expand="emit('toggle-expand', $event)"
                @open-actions="emit('open-actions', $event)"
                @save-edit="emit('save-edit', $event)"
                @cancel-edit="emit('cancel-edit')"
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

interface IBookmarkItem {
    title: string;
    dest: string | unknown[] | null;
    id: string;
    pageIndex: number | null;
    items: IBookmarkItem[];
}

interface IBookmarkMenuPayload {
    id: string;
    x: number;
    y: number;
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
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'go-to-page', page: number): void;
    (e: 'activate', id: string): void;
    (e: 'toggle-expand', id: string): void;
    (e: 'open-actions', payload: IBookmarkMenuPayload): void;
    (e: 'save-edit', payload: {
        id: string;
        title: string 
    }): void;
    (e: 'cancel-edit'): void;
}>();

const editingTitle = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

const hasChildren = computed(() => props.item.items.length > 0);
const isActive = computed(() => props.item.id === props.activeItemId);
const isEditing = computed(() => props.item.id === props.editingItemId);
const isToggleDisabled = computed(() => props.displayMode !== 'top-level');
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
        typeof value === 'object' &&
        value !== null &&
        'num' in value &&
        'gen' in value &&
        typeof (value as IRefProxy).num === 'number' &&
        typeof (value as IRefProxy).gen === 'number'
    );
}

function openActions(payload: IBookmarkMenuPayload) {
    emit('open-actions', payload);
}

function openActionsFromPointer(event: MouseEvent) {
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

async function handleClick() {
    emit('activate', props.item.id);

    if (isEditing.value) {
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
        // Silently ignore known PDF issues (malformed destinations, missing pages)
        // These are PDF authoring problems, not application errors
        const message = error instanceof Error ? error.message : String(error);
        const isKnownPdfIssue =
            message.includes('does not point to a /Page dictionary') ||
            message.includes('page must be a reference');

        if (!isKnownPdfIssue) {
            console.error('Failed to navigate to bookmark destination:', error);
        }
    }
}
</script>

<style scoped>
.pdf-bookmark-item-row {
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
    font-weight: 600;
}

.pdf-bookmark-item-row.is-editing {
    background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg) 90%);
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

.pdf-bookmark-item-toggle:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.pdf-bookmark-item-toggle:hover:not(:disabled) {
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
    width: 22px;
    height: 22px;
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
