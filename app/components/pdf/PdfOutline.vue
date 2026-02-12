<template>
    <div class="pdf-bookmarks">
        <div class="pdf-bookmarks-toolbar">
            <div
                class="pdf-bookmarks-view-modes"
                role="group"
                aria-label="Bookmark controls"
            >
                <UTooltip
                    v-for="option in displayModeOptions"
                    :key="option.id"
                    :text="option.title"
                    :delay-duration="800"
                >
                    <button
                        type="button"
                        class="pdf-bookmarks-view-mode-button"
                        :class="{ 'is-active': displayMode === option.id }"
                        :title="option.title"
                        :aria-label="option.title"
                        @click="setDisplayMode(option.id)"
                    >
                        <UIcon
                            :name="option.icon"
                            class="size-4"
                        />
                    </button>
                </UTooltip>
                <UTooltip
                    :text="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                    :delay-duration="800"
                >
                    <button
                        type="button"
                        class="pdf-bookmarks-view-mode-button"
                        :class="{ 'is-active': isEditMode }"
                        :title="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                        :aria-label="isEditMode ? t('bookmarks.exitEditMode') : t('bookmarks.enterEditMode')"
                        @click="isEditMode = !isEditMode"
                    >
                        <UIcon
                            :name="isEditMode ? 'i-lucide-square-pen' : 'i-lucide-pencil'"
                            class="size-4"
                        />
                    </button>
                </UTooltip>
            </div>

            <div class="pdf-bookmarks-toolbar-actions">
                <UTooltip
                    v-if="isEditMode"
                    :text="t('bookmarks.addTopLevel')"
                    :delay-duration="800"
                >
                    <button
                        type="button"
                        class="pdf-bookmarks-icon-button"
                        :title="t('bookmarks.addTopLevel')"
                        :aria-label="t('bookmarks.addTopLevel')"
                        @click="editing.addRootBookmark()"
                    >
                        <UIcon
                            name="i-lucide-plus"
                            class="size-4"
                        />
                    </button>
                </UTooltip>
            </div>
        </div>

        <div
            v-if="isLoading"
            class="pdf-bookmarks-loading"
        >
            <UIcon
                name="i-lucide-loader-circle"
                class="animate-spin"
            />
            <span>Loading bookmarks...</span>
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
                title="Add first bookmark"
                @click="editing.addRootBookmark()"
            >
                <UIcon
                    name="i-lucide-plus"
                    class="size-4"
                />
                <span>Add first bookmark</span>
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
    onMounted,
    provide,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IBookmarkItem,
    IBookmarkActivatePayload,
    IBookmarkDropPayload,
    IBookmarkMenuPayload,
    TBookmarkDisplayMode,
} from '@app/types/pdf-outline';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import {
    findBookmarkById,
    findBookmarkLocation,
    normalizeBookmarkColor,
} from '@app/utils/pdf-outline-helpers';
import { usePdfOutlineSelection } from '@app/composables/pdf/usePdfOutlineSelection';
import { usePdfOutlineDragDrop } from '@app/composables/pdf/usePdfOutlineDragDrop';
import { usePdfOutlineEditing } from '@app/composables/pdf/usePdfOutlineEditing';
import { PDF_OUTLINE_TREE_KEY } from '@app/composables/pdf/usePdfOutlineKeys';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

interface IRefProxy {
    num: number;
    gen: number;
}

interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    bold?: boolean;
    italic?: boolean;
    color?: ArrayLike<number> | null;
    items?: IOutlineItemRaw[];
}

interface IBookmarkDisplayModeOption {
    id: TBookmarkDisplayMode;
    title: string;
    icon: string;
}

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
const { clampToViewport } = useContextMenuPosition();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const styleRangeStartId = ref<string | null>(null);
const bookmarkContextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    itemId: string | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    itemId: null,
});

const isEditMode = computed({
    get: () => props.isEditMode,
    set: (value: boolean) => emit('update:isEditMode', value),
});

const currentPageRef = computed(() => props.currentPage);

const displayModeOptions = [
    {
        id: 'top-level',
        title: 'Top level only',
        icon: 'i-lucide-list',
    },
    {
        id: 'all-expanded',
        title: 'Expand all bookmarks',
        icon: 'i-lucide-chevrons-down',
    },
    {
        id: 'current-expanded',
        title: 'Expand current bookmark path',
        icon: 'i-lucide-eye',
    },
] satisfies IBookmarkDisplayModeOption[];

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

const selectedContextBookmark = computed(() => {
    const id = bookmarkContextMenu.value.itemId;
    if (!id) {
        return null;
    }

    return findBookmarkById(bookmarks.value, id);
});

const styleRangeInfo = computed(() => {
    const selected = selectedContextBookmark.value;
    const startId = styleRangeStartId.value;
    if (!selected || !startId) {
        return null;
    }

    const startLocation = findBookmarkLocation(bookmarks.value, startId);
    const endLocation = findBookmarkLocation(bookmarks.value, selected.id);
    if (!startLocation || !endLocation || startLocation.list !== endLocation.list) {
        return null;
    }

    const start = Math.min(startLocation.index, endLocation.index);
    const end = Math.max(startLocation.index, endLocation.index);

    return {
        list: startLocation.list,
        start,
        end,
        count: end - start + 1,
    };
});

const canApplyStyleRange = computed(() => Boolean(styleRangeInfo.value));
const applyStyleRangeLabel = computed(() => {
    const info = styleRangeInfo.value;
    if (!info) {
        return 'Apply style to range';
    }
    return `Apply style to ${info.count} bookmarks`;
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

function convertOutlineColorToHex(color: ArrayLike<number> | null | undefined): string | null {
    if (!color || typeof color.length !== 'number' || color.length < 3) {
        return null;
    }

    const parts = [
        color[0],
        color[1],
        color[2],
    ];

    const rgb = parts.map((value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return 0;
        }
        return Math.max(0, Math.min(255, Math.round(numeric)));
    });

    return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

async function resolvePageIndex(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    let destinationArray: unknown[] | null = null;

    if (typeof dest === 'string') {
        if (destinationCache.has(dest)) {
            destinationArray = destinationCache.get(dest) ?? null;
        } else {
            try {
                destinationArray = await pdfDocument.getDestination(dest);
            } catch {
                destinationArray = null;
            }
            destinationCache.set(dest, destinationArray);
        }
    } else if (Array.isArray(dest)) {
        destinationArray = dest;
    }

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        const maybeIndex = Math.trunc(pageRef);
        if (maybeIndex >= 0 && maybeIndex < pdfDocument.numPages) {
            return maybeIndex;
        }
        if (maybeIndex > 0 && maybeIndex <= pdfDocument.numPages) {
            return maybeIndex - 1;
        }
        return null;
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    const refKey = `${pageRef.num}:${pageRef.gen}`;
    if (refIndexCache.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        refIndexCache.set(refKey, pageIndex);
        return pageIndex;
    } catch {
        refIndexCache.set(refKey, null);
        return null;
    }
}

async function buildResolvedOutline(
    items: IOutlineItemRaw[],
    pdfDocument: PDFDocumentProxy,
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<IBookmarkItem[]> {
    return Promise.all(
        items.map(async (item) => {
            const pageIndex = await resolvePageIndex(
                pdfDocument,
                item.dest,
                destinationCache,
                refIndexCache,
            );
            const children = item.items?.length
                ? await buildResolvedOutline(
                    item.items,
                    pdfDocument,
                    destinationCache,
                    refIndexCache,
                )
                : [];

            return {
                title: item.title,
                dest: item.dest,
                id: createBookmarkId(),
                pageIndex,
                bold: item.bold === true,
                italic: item.italic === true,
                color: convertOutlineColorToHex(item.color),
                items: children,
            };
        }),
    );
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

function openBookmarkContextMenu(payload: IBookmarkMenuPayload) {
    if (!isEditMode.value) {
        return;
    }

    const clamped = clampToViewport(payload.x, payload.y, 228, 380);

    bookmarkContextMenu.value = {
        visible: true,
        x: clamped.x,
        y: clamped.y,
        itemId: payload.id,
    };
}

function closeBookmarkContextMenu() {
    if (!bookmarkContextMenu.value.visible) {
        return;
    }

    bookmarkContextMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        itemId: null,
    };
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

function setStyleRangeStart(id: string) {
    styleRangeStartId.value = id;
}

function applyContextStyleToRange() {
    const selected = selectedContextBookmark.value;
    const range = styleRangeInfo.value;
    if (!selected || !range) {
        return;
    }

    let changed = false;
    for (let index = range.start; index <= range.end; index += 1) {
        const target = range.list[index];
        if (!target) {
            continue;
        }

        const nextColor = normalizeBookmarkColor(selected.color);
        if (
            target.bold === selected.bold
            && target.italic === selected.italic
            && target.color === nextColor
        ) {
            continue;
        }

        target.bold = selected.bold;
        target.italic = selected.italic;
        target.color = nextColor;
        changed = true;
    }

    if (changed) {
        emitBookmarksChange();
    }
}

function handleBookmarkDrop(payload: IBookmarkDropPayload) {
    dragDrop.handleBookmarkDrop(payload, activeItemId, emitBookmarksChange);
}

function handleTreeEndDrop() {
    dragDrop.handleTreeEndDrop(activeItemId, emitBookmarksChange);
}

function handleGlobalPointerDown(event: PointerEvent) {
    if (!bookmarkContextMenu.value.visible) {
        return;
    }

    const target = event.target as HTMLElement | null;
    if (!target?.closest('.bookmarks-context-menu')) {
        closeBookmarkContextMenu();
    }
}

function handleGlobalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        closeBookmarkContextMenu();
        editing.cancelEditingBookmark();
        dragDrop.resetDragState();
    }
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

onMounted(() => {
    window.addEventListener('pointerdown', handleGlobalPointerDown, true);
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('resize', closeBookmarkContextMenu);
    window.addEventListener('scroll', closeBookmarkContextMenu, true);
});

onBeforeUnmount(() => {
    outlineRunId += 1;
    window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
    window.removeEventListener('keydown', handleGlobalKeydown);
    window.removeEventListener('resize', closeBookmarkContextMenu);
    window.removeEventListener('scroll', closeBookmarkContextMenu, true);
});
</script>

<style scoped>
.pdf-bookmarks {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.pdf-bookmarks-toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px;
}

.pdf-bookmarks-view-modes {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.pdf-bookmarks-view-mode-button,
.pdf-bookmarks-icon-button {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    cursor: pointer;
}

.pdf-bookmarks-view-mode-button:hover,
.pdf-bookmarks-icon-button:hover {
    background: var(--ui-bg-muted);
    color: var(--ui-text-highlighted);
}

.pdf-bookmarks-view-mode-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg) 92%);
}

.pdf-bookmarks-toolbar-actions {
    display: inline-flex;
    gap: 4px;
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

@media (width <= 780px) {
    .pdf-bookmarks-toolbar {
        grid-template-columns: 1fr;
    }

    .pdf-bookmarks-toolbar-actions {
        justify-content: flex-end;
    }
}
</style>
