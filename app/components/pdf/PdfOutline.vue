<template>
    <div class="pdf-bookmarks">
        <div class="pdf-bookmarks-toolbar">
            <div
                class="pdf-bookmarks-view-modes"
                role="group"
                aria-label="Bookmark display mode"
            >
                <button
                    v-for="option in displayModeOptions"
                    :key="option.id"
                    type="button"
                    class="pdf-bookmarks-view-mode-button"
                    :class="{ 'is-active': displayMode === option.id }"
                    :title="option.title"
                    @click="setDisplayMode(option.id)"
                >
                    <UIcon
                        :name="option.icon"
                        class="size-4"
                    />
                    <span>{{ option.label }}</span>
                </button>
            </div>

            <button
                type="button"
                class="pdf-bookmarks-edit-toggle"
                :class="{ 'is-active': isEditMode }"
                :title="isEditMode ? 'Exit bookmark edit mode' : 'Enter bookmark edit mode'"
                @click="isEditMode = !isEditMode"
            >
                <UIcon
                    name="i-lucide-pen-tool"
                    class="size-4"
                />
                <span>{{ isEditMode ? 'Editing' : 'Edit' }}</span>
            </button>
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
            <span>No bookmarks available</span>
            <button
                v-if="isEditMode"
                type="button"
                class="pdf-bookmarks-empty-action"
                @click="addRootBookmark"
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
                :active-item-id="activeItemId"
                :editing-item-id="editingItemId"
                :display-mode="displayMode"
                :expanded-bookmark-ids="expandedBookmarkIds"
                :active-path-bookmark-ids="activePathBookmarkIds"
                :is-edit-mode="isEditMode"
                @go-to-page="$emit('goToPage', $event)"
                @activate="handleActivate"
                @toggle-expand="toggleExpanded"
                @open-actions="openBookmarkContextMenu"
                @save-edit="renameBookmark"
                @cancel-edit="cancelEditingBookmark"
            />
        </div>

        <div
            v-if="bookmarkContextMenu.visible && selectedContextBookmark"
            class="bookmarks-context-menu"
            :style="bookmarkContextMenuStyle"
            @click.stop
        >
            <button
                type="button"
                class="bookmarks-context-menu-action"
                @click="startEditingBookmark(selectedContextBookmark.id)"
            >
                Edit bookmark
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                @click="addSiblingAbove(selectedContextBookmark.id)"
            >
                Add sibling above
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                @click="addSiblingBelow(selectedContextBookmark.id)"
            >
                Add sibling below
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                @click="addChildBookmark(selectedContextBookmark.id)"
            >
                Add child
            </button>
            <div class="bookmarks-context-menu-divider" />
            <button
                type="button"
                class="bookmarks-context-menu-action is-danger"
                @click="removeBookmark(selectedContextBookmark.id)"
            >
                Remove bookmark
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';

interface IRefProxy {
    num: number;
    gen: number;
}

interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    items?: IOutlineItemRaw[];
}

interface IBookmarkItem extends Omit<IOutlineItemRaw, 'items'> {
    id: string;
    pageIndex: number | null;
    items: IBookmarkItem[];
}

interface IBookmarkLocation {
    parent: IBookmarkItem | null;
    list: IBookmarkItem[];
    index: number;
    item: IBookmarkItem;
}

interface IBookmarkMenuPayload {
    id: string;
    x: number;
    y: number;
}

type TBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';

interface IBookmarkDisplayModeOption {
    id: TBookmarkDisplayMode;
    label: string;
    title: string;
    icon: string;
}

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
}

const props = defineProps<IProps>();

defineEmits<{(e: 'goToPage', page: number): void;}>();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);
const editingItemId = ref<string | null>(null);
const isEditMode = ref(false);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
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

const displayModeOptions = [
    {
        id: 'top-level',
        label: 'Top',
        title: 'Top level only',
        icon: 'i-lucide-list',
    },
    {
        id: 'all-expanded',
        label: 'All',
        title: 'Expand all bookmarks',
        icon: 'i-lucide-chevrons-down',
    },
    {
        id: 'current-expanded',
        label: 'Current',
        title: 'Expand only the current bookmark path',
        icon: 'i-lucide-eye',
    },
] satisfies IBookmarkDisplayModeOption[];

const bookmarkContextMenuStyle = computed(() => ({
    left: `${bookmarkContextMenu.value.x}px`,
    top: `${bookmarkContextMenu.value.y}px`,
}));

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

const selectedContextBookmark = computed(() => {
    const id = bookmarkContextMenu.value.itemId;
    if (!id) {
        return null;
    }

    return findBookmarkById(bookmarks.value, id);
});

let outlineRunId = 0;
let bookmarkIdCounter = 0;

function resetBookmarkIdCounter() {
    bookmarkIdCounter = 0;
}

function createBookmarkId() {
    const id = `bookmark-${bookmarkIdCounter}`;
    bookmarkIdCounter += 1;
    return id;
}

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
}

async function loadOutline() {
    const pdfDocument = props.pdfDocument;
    outlineRunId += 1;
    const runId = outlineRunId;
    closeBookmarkContextMenu();
    cancelEditingBookmark();
    expandedBookmarkIds.value = new Set();

    if (!pdfDocument || !isPdfDocumentUsable(pdfDocument)) {
        isLoading.value = false;
        bookmarks.value = [];
        activeItemId.value = null;
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

function createDraftBookmark(): IBookmarkItem {
    return {
        id: createBookmarkId(),
        title: 'New Bookmark',
        dest: null,
        pageIndex: Math.max(0, (props.currentPage || 1) - 1),
        items: [],
    };
}

function findBookmarkLocation(
    items: IBookmarkItem[],
    id: string,
    parent: IBookmarkItem | null = null,
): IBookmarkLocation | null {
    for (const [
        index,
        item,
    ] of items.entries()) {
        if (item.id === id) {
            return {
                parent,
                list: items,
                index,
                item,
            };
        }

        const child = findBookmarkLocation(item.items, id, item);
        if (child) {
            return child;
        }
    }

    return null;
}

function findBookmarkById(items: IBookmarkItem[], id: string): IBookmarkItem | null {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }
        const child = findBookmarkById(item.items, id);
        if (child) {
            return child;
        }
    }

    return null;
}

function collectBookmarkIds(item: IBookmarkItem, ids: Set<string>) {
    ids.add(item.id);
    for (const child of item.items) {
        collectBookmarkIds(child, ids);
    }
}

function pruneStaleState() {
    const validIds = new Set<string>();
    for (const item of flatBookmarks.value) {
        validIds.add(item.id);
    }

    if (activeItemId.value && !validIds.has(activeItemId.value)) {
        activeItemId.value = null;
    }

    if (editingItemId.value && !validIds.has(editingItemId.value)) {
        editingItemId.value = null;
    }

    const nextExpanded = new Set<string>();
    for (const id of expandedBookmarkIds.value) {
        if (validIds.has(id)) {
            nextExpanded.add(id);
        }
    }
    expandedBookmarkIds.value = nextExpanded;

    if (bookmarkContextMenu.value.itemId && !validIds.has(bookmarkContextMenu.value.itemId)) {
        closeBookmarkContextMenu();
    }
}

function ensureBookmarkVisibleInTopLevelMode(id: string) {
    if (displayMode.value !== 'top-level') {
        return;
    }

    const parentId = parentBookmarkIdMap.value.get(id);
    if (!parentId) {
        return;
    }

    const nextExpanded = new Set(expandedBookmarkIds.value);
    nextExpanded.add(parentId);
    expandedBookmarkIds.value = nextExpanded;
}

function openBookmarkContextMenu(payload: IBookmarkMenuPayload) {
    const width = 200;
    const height = 208;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

    activeItemId.value = payload.id;
    bookmarkContextMenu.value = {
        visible: true,
        x: Math.min(Math.max(margin, payload.x), maxX),
        y: Math.min(Math.max(margin, payload.y), maxY),
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

function handleActivate(id: string) {
    activeItemId.value = id;
    closeBookmarkContextMenu();
}

function toggleExpanded(id: string) {
    if (displayMode.value !== 'top-level') {
        return;
    }

    const nextExpanded = new Set(expandedBookmarkIds.value);
    if (nextExpanded.has(id)) {
        nextExpanded.delete(id);
    } else {
        nextExpanded.add(id);
    }
    expandedBookmarkIds.value = nextExpanded;
}

function startEditingBookmark(id: string) {
    isEditMode.value = true;
    activeItemId.value = id;
    editingItemId.value = id;
    closeBookmarkContextMenu();
}

function cancelEditingBookmark() {
    editingItemId.value = null;
}

function renameBookmark(payload: {
    id: string;
    title: string 
}) {
    const location = findBookmarkLocation(bookmarks.value, payload.id);
    editingItemId.value = null;
    if (!location) {
        return;
    }

    const nextTitle = payload.title.trim();
    if (nextTitle.length === 0) {
        return;
    }

    location.item.title = nextTitle;
}

function focusNewBookmark(id: string) {
    activeItemId.value = id;
    editingItemId.value = id;
    isEditMode.value = true;
    closeBookmarkContextMenu();
}

function addRootBookmark() {
    const bookmark = createDraftBookmark();
    bookmarks.value.push(bookmark);
    focusNewBookmark(bookmark.id);
}

function addSiblingAbove(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const bookmark = createDraftBookmark();
    location.list.splice(location.index, 0, bookmark);
    focusNewBookmark(bookmark.id);
}

function addSiblingBelow(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const bookmark = createDraftBookmark();
    location.list.splice(location.index + 1, 0, bookmark);
    focusNewBookmark(bookmark.id);
}

function addChildBookmark(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const bookmark = createDraftBookmark();
    location.item.items.push(bookmark);
    ensureBookmarkVisibleInTopLevelMode(bookmark.id);
    focusNewBookmark(bookmark.id);
}

function removeBookmark(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const removedIds = new Set<string>();
    collectBookmarkIds(location.item, removedIds);
    location.list.splice(location.index, 1);

    const nextActive = location.list[location.index] ?? location.list[location.index - 1] ?? location.parent;
    if (activeItemId.value && removedIds.has(activeItemId.value)) {
        activeItemId.value = nextActive?.id ?? null;
    }

    if (editingItemId.value && removedIds.has(editingItemId.value)) {
        editingItemId.value = null;
    }

    const nextExpanded = new Set<string>();
    for (const expandedId of expandedBookmarkIds.value) {
        if (!removedIds.has(expandedId)) {
            nextExpanded.add(expandedId);
        }
    }
    expandedBookmarkIds.value = nextExpanded;

    closeBookmarkContextMenu();
    pruneStaleState();
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
        cancelEditingBookmark();
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
            cancelEditingBookmark();
            closeBookmarkContextMenu();
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

.pdf-bookmarks-view-mode-button {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 6px;
    cursor: pointer;
}

.pdf-bookmarks-view-mode-button:hover {
    background: var(--ui-bg-muted);
    color: var(--ui-text-highlighted);
}

.pdf-bookmarks-view-mode-button.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg) 92%);
}

.pdf-bookmarks-edit-toggle {
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 700;
    padding: 5px 8px;
    cursor: pointer;
}

.pdf-bookmarks-edit-toggle:hover {
    background: var(--ui-bg-muted);
    color: var(--ui-text-highlighted);
}

.pdf-bookmarks-edit-toggle.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border) 55%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg) 90%);
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

.bookmarks-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 180px;
    border: 1px solid var(--ui-border);
    border-radius: 10px;
    background: var(--ui-bg);
    box-shadow: 0 14px 30px color-mix(in srgb, var(--ui-bg-inverted) 20%, transparent 80%);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.bookmarks-context-menu-action {
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--ui-text-highlighted);
    font-size: 12px;
    text-align: left;
    padding: 6px 8px;
    cursor: pointer;
}

.bookmarks-context-menu-action:hover {
    border-color: var(--ui-border);
    background: color-mix(in srgb, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
}

.bookmarks-context-menu-action.is-danger {
    color: color-mix(in srgb, #ef4444 68%, var(--ui-text-highlighted) 32%);
}

.bookmarks-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 3px 2px;
}

@media (width <= 780px) {
    .pdf-bookmarks-toolbar {
        grid-template-columns: 1fr;
    }

    .pdf-bookmarks-edit-toggle {
        justify-content: center;
    }
}
</style>
