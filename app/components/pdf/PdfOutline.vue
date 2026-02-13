<template>
    <div class="pdf-bookmarks">
        <PdfOutlineToolbar
            :display-mode="displayMode"
            :is-edit-mode="isEditMode"
            @set-display-mode="setDisplayMode"
            @toggle-edit-mode="isEditMode = !isEditMode"
            @add-root-bookmark="editing.addRootBookmark()"
        />

        <div
            v-if="isLoading"
            class="pdf-bookmarks-loading"
        >
            <UIcon
                name="i-lucide-loader-circle"
                class="animate-spin"
            />
            <span>{{ t('bookmarks.loading') }}</span>
        </div>

        <div
            v-else-if="bookmarks.length === 0"
            class="pdf-bookmarks-empty"
        >
            <UIcon name="i-lucide-book-open" />
            <span>{{ t('bookmarks.noBookmarks') }}</span>
            <button
                v-if="isEditMode"
                type="button"
                class="pdf-bookmarks-empty-action"
                :title="t('bookmarks.addFirst')"
                @click="editing.addRootBookmark()"
            >
                <UIcon
                    name="i-lucide-plus"
                    class="size-4"
                />
                <span>{{ t('bookmarks.addFirst') }}</span>
            </button>
        </div>

        <div
            v-else
            class="pdf-bookmarks-tree"
            @click="closeBookmarkContextMenu"
        >
            <PdfOutlineItem
                v-for="(item, index) in bookmarks"
                :key="item.id || index"
                :item="item"
                :pdf-document="pdfDocument"
                @go-to-page="$emit('goToPage', $event)"
                @activate="handleActivate"
                @toggle-expand="toggleExpanded"
                @open-actions="openBookmarkContextMenu"
                @save-edit="editing.renameBookmark($event)"
                @cancel-edit="editing.cancelEditingBookmark()"
                @drag-start="dragDrop.handleBookmarkDragStart($event)"
                @drag-hover="dragDrop.handleBookmarkDragHover($event)"
                @drop-bookmark="handleBookmarkDrop"
                @drag-end="dragDrop.handleBookmarkDragEnd()"
            />
            <div
                v-if="isEditMode"
                class="pdf-bookmarks-drop-end"
                :class="{ 'is-active': dragDrop.isRootAppendDropTarget.value }"
                @dragover.prevent="dragDrop.handleTreeEndDragOver()"
                @drop.prevent="handleTreeEndDrop"
            />
        </div>

        <PdfOutlineContextMenu
            :visible="bookmarkContextMenu.visible"
            :x="bookmarkContextMenu.x"
            :y="bookmarkContextMenu.y"
            :bookmark="selectedContextBookmark"
            :style-range-start-id="styleRangeStartId"
            :can-apply-style-range="canApplyStyleRange"
            :apply-style-range-label="applyStyleRangeLabel"
            @edit="editing.startEditingBookmark($event)"
            @add-sibling-above="editing.addSiblingAbove($event)"
            @add-sibling-below="editing.addSiblingBelow($event)"
            @add-child="editing.addChildBookmark($event)"
            @toggle-bold="editing.toggleBookmarkBold($event)"
            @toggle-italic="editing.toggleBookmarkItalic($event)"
            @set-color="editing.setBookmarkColor($event.id, $event.color)"
            @set-style-range-start="setStyleRangeStart"
            @apply-style-to-range="applyContextStyleToRange"
            @remove="editing.removeBookmark($event)"
        />
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    provide,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IBookmarkItem,
    IBookmarkActivatePayload,
    IBookmarkDropPayload,
    TBookmarkDisplayMode,
} from '@app/types/pdf-outline';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import { buildResolvedOutline } from '@app/utils/pdf-outline-helpers';
import type { IOutlineItemRaw } from '@app/utils/pdf-outline-helpers';
import { usePdfOutlineSelection } from '@app/composables/pdf/usePdfOutlineSelection';
import { usePdfOutlineDragDrop } from '@app/composables/pdf/usePdfOutlineDragDrop';
import { usePdfOutlineEditing } from '@app/composables/pdf/usePdfOutlineEditing';
import { usePdfOutlineContextMenu } from '@app/composables/pdf/usePdfOutlineContextMenu';
import { PDF_OUTLINE_TREE_KEY } from '@app/composables/pdf/usePdfOutlineKeys';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    isEditMode: boolean;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'bookmarks-change', payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }): void;
    (e: 'update:isEditMode', value: boolean): void;
}>();

const { t } = useI18n();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const styleRangeStartId = ref<string | null>(null);

const isEditMode = computed({
    get: () => props.isEditMode,
    set: (value: boolean) => emit('update:isEditMode', value),
});

const currentPageRef = computed(() => props.currentPage);

const parentBookmarkIdMap = computed(() => {
    const map = new Map<string, string | null>();

    function visit(items: IBookmarkItem[], parentId: string | null) {
        for (const item of items) {
            map.set(item.id, parentId);
            visit(item.items, item.id);
        }
    }

    visit(bookmarks.value, null);
    return map;
});

const activePathBookmarkIds = computed(() => {
    const ids = new Set<string>();
    const map = parentBookmarkIdMap.value;
    let cursor = activeItemId.value;

    while (cursor) {
        ids.add(cursor);
        cursor = map.get(cursor) ?? null;
    }

    return ids;
});

let bookmarkIdCounter = 0;

function resetBookmarkIdCounter() {
    bookmarkIdCounter = 0;
}

function createBookmarkId() {
    const id = `bookmark-${bookmarkIdCounter}`;
    bookmarkIdCounter += 1;
    return id;
}

const flatBookmarks = computed(() => {
    const flattened: IBookmarkItem[] = [];

    function visit(items: IBookmarkItem[]) {
        for (const item of items) {
            flattened.push(item);
            visit(item.items);
        }
    }

    visit(bookmarks.value);
    return flattened;
});

const bookmarkOrderIndexMap = computed(() => {
    const map = new Map<string, number>();
    for (const [
        index,
        item,
    ] of flatBookmarks.value.entries()) {
        map.set(item.id, index);
    }
    return map;
});

const selection = usePdfOutlineSelection(
    bookmarks,
    activeItemId,
    displayMode,
    expandedBookmarkIds,
    activePathBookmarkIds,
);

const contextMenuApi = usePdfOutlineContextMenu(
    bookmarks,
    isEditMode,
    styleRangeStartId,
    () => emitBookmarksChange(),
    () => {
        editing.cancelEditingBookmark();
        dragDrop.resetDragState();
    },
);

const {
    bookmarkContextMenu,
    selectedContextBookmark,
    canApplyStyleRange,
    applyStyleRangeLabel,
    openBookmarkContextMenu,
    closeBookmarkContextMenu,
    setStyleRangeStart,
    applyContextStyleToRange,
} = contextMenuApi;

const dragDrop = usePdfOutlineDragDrop(
    bookmarks,
    expandedBookmarkIds,
    isEditMode,
    selection.selectedBookmarkIds,
    parentBookmarkIdMap,
    bookmarkOrderIndexMap,
    selection.applySingleSelection,
    closeBookmarkContextMenu,
);

const editing = usePdfOutlineEditing(
    bookmarks,
    activeItemId,
    expandedBookmarkIds,
    displayMode,
    isEditMode,
    parentBookmarkIdMap,
    selection.selectedBookmarkIds,
    selection.selectionAnchorBookmarkId,
    styleRangeStartId,
    dragDrop.draggingBookmarkIds,
    selection.applySingleSelection,
    closeBookmarkContextMenu,
    dragDrop.resetDragState,
    currentPageRef,
    emitBookmarksChange,
    createBookmarkId,
    t,
);

provide(PDF_OUTLINE_TREE_KEY, {
    expandedBookmarkIds,
    activeItemId,
    editingItemId: editing.editingItemId,
    selectedBookmarkIds: selection.selectedBookmarkIds,
    displayMode,
    isEditMode,
    draggingItemIds: dragDrop.draggingBookmarkIds,
    dropTarget: dragDrop.bookmarkDropTarget,
    styleRangeStartId,
    activePathBookmarkIds,
});

let outlineRunId = 0;
const initialBookmarkSnapshot = ref('[]');

function emitBookmarksChange() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    const snapshot = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: snapshot !== initialBookmarkSnapshot.value,
    });
}

function setBookmarkBaseline() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    initialBookmarkSnapshot.value = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: false,
    });
}

function updateActiveItemFromCurrentPage() {
    const pageIndex = Math.max(0, (props.currentPage || 1) - 1);
    let active: IBookmarkItem | null = null;

    for (const item of flatBookmarks.value) {
        if (typeof item.pageIndex === 'number' && item.pageIndex <= pageIndex) {
            active = item;
        }
    }

    activeItemId.value = active?.id ?? null;
    if (!isEditMode.value) {
        if (activeItemId.value) {
            selection.applySingleSelection(activeItemId.value);
        } else {
            selection.clearSelection();
        }
    }
}

async function loadOutline() {
    const pdfDocument = props.pdfDocument;
    outlineRunId += 1;
    const runId = outlineRunId;
    closeBookmarkContextMenu();
    editing.cancelEditingBookmark();
    dragDrop.resetDragState();
    styleRangeStartId.value = null;
    selection.clearSelection();
    expandedBookmarkIds.value = new Set();

    if (!pdfDocument || !isPdfDocumentUsable(pdfDocument)) {
        isLoading.value = false;
        bookmarks.value = [];
        activeItemId.value = null;
        selection.clearSelection();
        setBookmarkBaseline();
        return;
    }

    isLoading.value = true;
    try {
        const result = await pdfDocument.getOutline();
        if (
            runId !== outlineRunId
            || props.pdfDocument !== pdfDocument
            || !isPdfDocumentUsable(pdfDocument)
        ) {
            return;
        }

        const rawOutline = (result ?? []) as IOutlineItemRaw[];
        const destinationCache = new Map<string, unknown[] | null>();
        const refIndexCache = new Map<string, number | null>();

        resetBookmarkIdCounter();
        const resolved = await buildResolvedOutline(
            rawOutline,
            pdfDocument,
            destinationCache,
            refIndexCache,
            createBookmarkId,
        );
        if (
            runId !== outlineRunId
            || props.pdfDocument !== pdfDocument
            || !isPdfDocumentUsable(pdfDocument)
        ) {
            return;
        }

        bookmarks.value = resolved;
        updateActiveItemFromCurrentPage();
        if (activeItemId.value) {
            selection.applySingleSelection(activeItemId.value);
        }
        setBookmarkBaseline();
    } catch (error) {
        if (
            runId !== outlineRunId
            || props.pdfDocument !== pdfDocument
            || !isPdfDocumentUsable(pdfDocument)
        ) {
            return;
        }
        console.error('Failed to load bookmarks:', error);
        bookmarks.value = [];
        activeItemId.value = null;
        selection.clearSelection();
        setBookmarkBaseline();
    } finally {
        if (runId === outlineRunId) {
            isLoading.value = false;
        }
    }
}

function setDisplayMode(mode: TBookmarkDisplayMode) {
    displayMode.value = mode;

    if (mode === 'top-level') {
        expandedBookmarkIds.value = new Set();
    }
}

function handleActivate(payload: IBookmarkActivatePayload) {
    activeItemId.value = payload.id;
    if (isEditMode.value) {
        if (payload.rangeSelect) {
            selection.applyRangeSelection(payload.id);
        } else if (payload.multiSelect) {
            const nextSelection = new Set(selection.selectedBookmarkIds.value);
            if (nextSelection.has(payload.id)) {
                nextSelection.delete(payload.id);
            } else {
                nextSelection.add(payload.id);
            }
            selection.selectedBookmarkIds.value = nextSelection;
            selection.selectionAnchorBookmarkId.value = payload.id;
        } else {
            selection.applySingleSelection(payload.id);
        }
    } else {
        selection.applySingleSelection(payload.id);
    }

    closeBookmarkContextMenu();
}

function toggleExpanded(id: string) {
    if (displayMode.value !== 'top-level') {
        displayMode.value = 'top-level';
    }

    const nextExpanded = new Set(expandedBookmarkIds.value);
    if (nextExpanded.has(id)) {
        nextExpanded.delete(id);
    } else {
        nextExpanded.add(id);
    }
    expandedBookmarkIds.value = nextExpanded;
}

function handleBookmarkDrop(payload: IBookmarkDropPayload) {
    dragDrop.handleBookmarkDrop(payload, activeItemId, emitBookmarksChange);
}

function handleTreeEndDrop() {
    dragDrop.handleTreeEndDrop(activeItemId, emitBookmarksChange);
}

watch(
    () => props.pdfDocument,
    () => loadOutline(),
    { immediate: true },
);

watch(
    () => props.currentPage,
    () => updateActiveItemFromCurrentPage(),
);

watch(
    () => isEditMode.value,
    (value) => {
        if (!value) {
            editing.cancelEditingBookmark();
            closeBookmarkContextMenu();
            dragDrop.resetDragState();
            styleRangeStartId.value = null;
            if (activeItemId.value) {
                selection.applySingleSelection(activeItemId.value);
            } else {
                selection.clearSelection();
            }
        }
    },
);

onBeforeUnmount(() => {
    outlineRunId += 1;
});
</script>

<style scoped>
.pdf-bookmarks {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.pdf-bookmarks-loading,
.pdf-bookmarks-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-bookmarks-empty-action {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-highlighted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 10px;
    cursor: pointer;
}

.pdf-bookmarks-empty-action:hover {
    background: var(--ui-bg-muted);
}

.pdf-bookmarks-tree {
    display: flex;
    flex-direction: column;
    user-select: none;
}

.pdf-bookmarks-drop-end {
    height: 18px;
    margin-top: 2px;
    border-radius: 6px;
}

.pdf-bookmarks-drop-end.is-active {
    background: color-mix(in srgb, var(--ui-primary) 12%, transparent 88%);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

</style>
