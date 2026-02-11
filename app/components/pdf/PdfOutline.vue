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
                        @click="addRootBookmark"
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
                :selected-bookmark-ids="selectedBookmarkIds"
                :dragging-item-ids="draggingBookmarkIds"
                :drop-target="bookmarkDropTarget"
                :style-range-start-id="styleRangeStartId"
                @go-to-page="$emit('goToPage', $event)"
                @activate="handleActivate"
                @toggle-expand="toggleExpanded"
                @open-actions="openBookmarkContextMenu"
                @save-edit="renameBookmark"
                @cancel-edit="cancelEditingBookmark"
                @drag-start="handleBookmarkDragStart"
                @drag-hover="handleBookmarkDragHover"
                @drop-bookmark="handleBookmarkDrop"
                @drag-end="handleBookmarkDragEnd"
            />
            <div
                v-if="isEditMode"
                class="pdf-bookmarks-drop-end"
                :class="{ 'is-active': isRootAppendDropTarget }"
                @dragover.prevent="handleTreeEndDragOver"
                @drop.prevent="handleTreeEndDrop"
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
                :title="t('bookmarks.editBookmark')"
                @click="startEditingBookmark(selectedContextBookmark.id)"
            >
                {{ t('bookmarks.editBookmark') }}
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                :title="t('bookmarks.addSiblingAbove')"
                @click="addSiblingAbove(selectedContextBookmark.id)"
            >
                {{ t('bookmarks.addSiblingAbove') }}
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                :title="t('bookmarks.addSiblingBelow')"
                @click="addSiblingBelow(selectedContextBookmark.id)"
            >
                {{ t('bookmarks.addSiblingBelow') }}
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                :title="t('bookmarks.addChild')"
                @click="addChildBookmark(selectedContextBookmark.id)"
            >
                {{ t('bookmarks.addChild') }}
            </button>
            <div class="bookmarks-context-menu-divider" />

            <div class="bookmarks-context-menu-style-block">
                <div class="bookmarks-context-menu-style-row">
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': selectedContextBookmark.bold }"
                        :title="selectedContextBookmark.bold ? t('bookmarks.disableBold') : t('bookmarks.enableBold')"
                        @click="toggleBookmarkBold(selectedContextBookmark.id)"
                    >
                        B
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': selectedContextBookmark.italic }"
                        :title="selectedContextBookmark.italic ? t('bookmarks.disableItalic') : t('bookmarks.enableItalic')"
                        @click="toggleBookmarkItalic(selectedContextBookmark.id)"
                    >
                        I
                    </button>
                    <button
                        type="button"
                        class="bookmarks-style-toggle"
                        :class="{ 'is-active': !selectedContextBookmark.color }"
                        :title="t('bookmarks.defaultColor')"
                        @click="setBookmarkColor(selectedContextBookmark.id, null)"
                    >
                        A
                    </button>
                </div>
                <div class="bookmarks-context-menu-color-row">
                    <button
                        v-for="preset in bookmarkColorPresets"
                        :key="preset"
                        type="button"
                        class="bookmarks-color-swatch"
                        :class="{ 'is-active': selectedContextBookmark.color === preset }"
                        :style="{ background: preset }"
                        :title="`Set color ${preset}`"
                        @click="setBookmarkColor(selectedContextBookmark.id, preset)"
                    />
                </div>
            </div>

            <div class="bookmarks-context-menu-divider" />
            <button
                type="button"
                class="bookmarks-context-menu-action"
                :title="t('bookmarks.setStyleStart')"
                @click="setStyleRangeStart(selectedContextBookmark.id)"
            >
                {{ selectedContextBookmark.id === styleRangeStartId ? 'Range start set' : t('bookmarks.setStyleStart') }}
            </button>
            <button
                type="button"
                class="bookmarks-context-menu-action"
                :disabled="!canApplyStyleRange"
                :title="applyStyleRangeLabel"
                @click="applyContextStyleToRange"
            >
                {{ applyStyleRangeLabel }}
            </button>

            <div class="bookmarks-context-menu-divider" />
            <button
                type="button"
                class="bookmarks-context-menu-action is-danger"
                :title="t('bookmarks.removeBookmark')"
                @click="removeBookmark(selectedContextBookmark.id)"
            >
                {{ t('bookmarks.removeBookmark') }}
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
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';

interface IRefProxy {
    num: number;
    gen: number;
}

type TBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';
type TBookmarkDropPosition = 'before' | 'after' | 'child';

interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    bold?: boolean;
    italic?: boolean;
    color?: ArrayLike<number> | null;
    items?: IOutlineItemRaw[];
}

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

interface IBookmarkDisplayModeOption {
    id: TBookmarkDisplayMode;
    title: string;
    icon: string;
}

interface IBookmarkDropTarget {
    id: string;
    position: TBookmarkDropPosition;
}

interface IBookmarkActivatePayload {
    id: string;
    hasChildren: boolean;
    wasActive: boolean;
    multiSelect: boolean;
    rangeSelect: boolean;
}

interface IBookmarkDropPayload {
    targetId: string;
    position: TBookmarkDropPosition;
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

const bookmarkColorPresets = [
    '#1f2937',
    '#1d4ed8',
    '#b91c1c',
    '#047857',
    '#7c3aed',
    '#c2410c',
] as const;

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const activeItemId = ref<string | null>(null);
const editingItemId = ref<string | null>(null);
const selectedBookmarkIds = ref<Set<string>>(new Set());
const selectionAnchorBookmarkId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const styleRangeStartId = ref<string | null>(null);
const draggingBookmarkIds = ref<Set<string>>(new Set());
const bookmarkDropTarget = ref<IBookmarkDropTarget | null>(null);
const isRootAppendDropTarget = ref(false);
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

function isBookmarkExpandedForVisibility(item: IBookmarkItem) {
    if (displayMode.value === 'all-expanded') {
        return true;
    }
    if (displayMode.value === 'current-expanded') {
        return activePathBookmarkIds.value.has(item.id);
    }
    return expandedBookmarkIds.value.has(item.id);
}

const visibleBookmarkIds = computed(() => {
    const ids: string[] = [];

    function visit(items: IBookmarkItem[]) {
        for (const item of items) {
            ids.push(item.id);
            if (item.items.length > 0 && isBookmarkExpandedForVisibility(item)) {
                visit(item.items);
            }
        }
    }

    visit(bookmarks.value);
    return ids;
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
let bookmarkIdCounter = 0;
const initialBookmarkSnapshot = ref('[]');

function resetBookmarkIdCounter() {
    bookmarkIdCounter = 0;
}

function createBookmarkId() {
    const id = `bookmark-${bookmarkIdCounter}`;
    bookmarkIdCounter += 1;
    return id;
}

function normalizeBookmarkColor(color: string | null | undefined): string | null {
    if (typeof color !== 'string') {
        return null;
    }

    const value = color.trim().toLowerCase();
    const shortHexMatch = /^#([0-9a-f]{3})$/.exec(value);
    if (shortHexMatch) {
        const triple = shortHexMatch[1];
        if (!triple) {
            return null;
        }
        const [
            r,
            g,
            b,
        ] = triple.split('');
        return `#${r}${r}${g}${g}${b}${b}`;
    }

    return /^#[0-9a-f]{6}$/.test(value) ? value : null;
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

function mapBookmarksForPersistence(items: IBookmarkItem[]): IPdfBookmarkEntry[] {
    return items.map((item) => {
        const title = item.title.trim();
        return {
            title: title.length > 0 ? title : 'Untitled Bookmark',
            pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : null,
            namedDest: typeof item.dest === 'string' && item.dest.trim().length > 0 ? item.dest : null,
            bold: item.bold,
            italic: item.italic,
            color: normalizeBookmarkColor(item.color),
            items: mapBookmarksForPersistence(item.items),
        };
    });
}

function emitBookmarksChange() {
    const persisted = mapBookmarksForPersistence(bookmarks.value);
    const snapshot = JSON.stringify(persisted);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: snapshot !== initialBookmarkSnapshot.value,
    });
}

function setBookmarkBaseline() {
    const persisted = mapBookmarksForPersistence(bookmarks.value);
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
            applySingleSelection(activeItemId.value);
        } else {
            selectedBookmarkIds.value = new Set();
            selectionAnchorBookmarkId.value = null;
        }
    }
}

async function loadOutline() {
    const pdfDocument = props.pdfDocument;
    outlineRunId += 1;
    const runId = outlineRunId;
    closeBookmarkContextMenu();
    cancelEditingBookmark();
    resetDragState();
    styleRangeStartId.value = null;
    selectedBookmarkIds.value = new Set();
    selectionAnchorBookmarkId.value = null;
    expandedBookmarkIds.value = new Set();

    if (!pdfDocument || !isPdfDocumentUsable(pdfDocument)) {
        isLoading.value = false;
        bookmarks.value = [];
        activeItemId.value = null;
        selectedBookmarkIds.value = new Set();
        selectionAnchorBookmarkId.value = null;
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
            applySingleSelection(activeItemId.value);
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
        selectedBookmarkIds.value = new Set();
        selectionAnchorBookmarkId.value = null;
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

function createDraftBookmark(): IBookmarkItem {
    return {
        id: createBookmarkId(),
        title: t('bookmarks.newBookmark'),
        dest: null,
        pageIndex: Math.max(0, (props.currentPage || 1) - 1),
        bold: false,
        italic: false,
        color: null,
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

function getSelectedRootIds(selection: Set<string>) {
    const roots = new Set<string>();
    for (const id of selection) {
        let hasSelectedAncestor = false;
        let cursor = parentBookmarkIdMap.value.get(id) ?? null;

        while (cursor) {
            if (selection.has(cursor)) {
                hasSelectedAncestor = true;
                break;
            }
            cursor = parentBookmarkIdMap.value.get(cursor) ?? null;
        }

        if (!hasSelectedAncestor) {
            roots.add(id);
        }
    }

    const order = bookmarkOrderIndexMap.value;
    return [...roots].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

function applySingleSelection(id: string) {
    selectedBookmarkIds.value = new Set([id]);
    selectionAnchorBookmarkId.value = id;
}

function applyRangeSelection(id: string) {
    const anchorId = selectionAnchorBookmarkId.value;
    if (!anchorId) {
        applySingleSelection(id);
        return;
    }

    const visibleIds = visibleBookmarkIds.value;
    const anchorIndex = visibleIds.indexOf(anchorId);
    const targetIndex = visibleIds.indexOf(id);
    if (anchorIndex < 0 || targetIndex < 0) {
        applySingleSelection(id);
        return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const nextSelection = new Set<string>();
    for (let index = start; index <= end; index += 1) {
        const currentId = visibleIds[index];
        if (currentId) {
            nextSelection.add(currentId);
        }
    }
    selectedBookmarkIds.value = nextSelection;
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

    if (styleRangeStartId.value && !validIds.has(styleRangeStartId.value)) {
        styleRangeStartId.value = null;
    }

    const nextSelected = new Set<string>();
    for (const id of selectedBookmarkIds.value) {
        if (validIds.has(id)) {
            nextSelected.add(id);
        }
    }
    selectedBookmarkIds.value = nextSelected;

    if (selectionAnchorBookmarkId.value && !validIds.has(selectionAnchorBookmarkId.value)) {
        selectionAnchorBookmarkId.value = null;
    }

    let hasInvalidDraggingId = false;
    for (const id of draggingBookmarkIds.value) {
        if (!validIds.has(id)) {
            hasInvalidDraggingId = true;
            break;
        }
    }
    if (hasInvalidDraggingId) {
        resetDragState();
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
    if (!isEditMode.value) {
        return;
    }

    const width = 228;
    const height = 380;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

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

function handleActivate(payload: IBookmarkActivatePayload) {
    activeItemId.value = payload.id;
    if (isEditMode.value) {
        if (payload.rangeSelect) {
            applyRangeSelection(payload.id);
        } else if (payload.multiSelect) {
            const nextSelection = new Set(selectedBookmarkIds.value);
            if (nextSelection.has(payload.id)) {
                nextSelection.delete(payload.id);
            } else {
                nextSelection.add(payload.id);
            }
            selectedBookmarkIds.value = nextSelection;
            selectionAnchorBookmarkId.value = payload.id;
        } else {
            applySingleSelection(payload.id);
        }
    } else {
        applySingleSelection(payload.id);
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

function startEditingBookmark(id: string) {
    isEditMode.value = true;
    activeItemId.value = id;
    applySingleSelection(id);
    editingItemId.value = id;
    closeBookmarkContextMenu();
}

function cancelEditingBookmark() {
    editingItemId.value = null;
}

function renameBookmark(payload: {
    id: string;
    title: string;
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

    if (location.item.title === nextTitle) {
        return;
    }

    location.item.title = nextTitle;
    emitBookmarksChange();
}

function focusNewBookmark(id: string) {
    activeItemId.value = id;
    editingItemId.value = id;
    isEditMode.value = true;
    applySingleSelection(id);
    closeBookmarkContextMenu();
}

function addRootBookmark() {
    const bookmark = createDraftBookmark();
    bookmarks.value.push(bookmark);
    focusNewBookmark(bookmark.id);
    emitBookmarksChange();
}

function addSiblingAbove(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const bookmark = createDraftBookmark();
    location.list.splice(location.index, 0, bookmark);
    focusNewBookmark(bookmark.id);
    emitBookmarksChange();
}

function addSiblingBelow(id: string) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const bookmark = createDraftBookmark();
    location.list.splice(location.index + 1, 0, bookmark);
    focusNewBookmark(bookmark.id);
    emitBookmarksChange();
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
    emitBookmarksChange();
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

    if (styleRangeStartId.value && removedIds.has(styleRangeStartId.value)) {
        styleRangeStartId.value = null;
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
    emitBookmarksChange();
}

function updateBookmarkStyle(
    id: string,
    updates: Partial<Pick<IBookmarkItem, 'bold' | 'italic' | 'color'>>,
) {
    const location = findBookmarkLocation(bookmarks.value, id);
    if (!location) {
        return;
    }

    const nextBold = typeof updates.bold === 'boolean' ? updates.bold : location.item.bold;
    const nextItalic = typeof updates.italic === 'boolean' ? updates.italic : location.item.italic;
    const nextColor = updates.color === undefined
        ? location.item.color
        : normalizeBookmarkColor(updates.color);

    if (
        location.item.bold === nextBold
        && location.item.italic === nextItalic
        && location.item.color === nextColor
    ) {
        return;
    }

    location.item.bold = nextBold;
    location.item.italic = nextItalic;
    location.item.color = nextColor;
    emitBookmarksChange();
}

function toggleBookmarkBold(id: string) {
    const bookmark = findBookmarkById(bookmarks.value, id);
    if (!bookmark) {
        return;
    }
    updateBookmarkStyle(id, { bold: !bookmark.bold });
}

function toggleBookmarkItalic(id: string) {
    const bookmark = findBookmarkById(bookmarks.value, id);
    if (!bookmark) {
        return;
    }
    updateBookmarkStyle(id, { italic: !bookmark.italic });
}

function setBookmarkColor(id: string, color: string | null) {
    updateBookmarkStyle(id, { color });
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

function resetDragState() {
    draggingBookmarkIds.value = new Set();
    bookmarkDropTarget.value = null;
    isRootAppendDropTarget.value = false;
}

function collectDraggedBranchIds(draggedRootIds: string[]) {
    const ids = new Set<string>();
    for (const id of draggedRootIds) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            continue;
        }
        collectBookmarkIds(location.item, ids);
    }
    return ids;
}

function canDropBookmarks(draggedRootIds: string[], targetId: string) {
    if (draggedRootIds.includes(targetId)) {
        return false;
    }

    const draggedBranchIds = collectDraggedBranchIds(draggedRootIds);
    return !draggedBranchIds.has(targetId);
}

function extractDraggedItems(draggedRootIds: string[]) {
    const order = bookmarkOrderIndexMap.value;
    const descendingIds = [...draggedRootIds].sort((left, right) => (
        (order.get(right) ?? 0) - (order.get(left) ?? 0)
    ));

    const extracted = new Map<string, IBookmarkItem>();
    for (const id of descendingIds) {
        const location = findBookmarkLocation(bookmarks.value, id);
        if (!location) {
            continue;
        }
        location.list.splice(location.index, 1);
        extracted.set(id, location.item);
    }

    return draggedRootIds
        .map(id => extracted.get(id) ?? null)
        .filter((item): item is IBookmarkItem => item !== null);
}

function moveBookmarksToTarget(
    draggedRootIds: string[],
    targetId: string,
    position: TBookmarkDropPosition,
) {
    if (!canDropBookmarks(draggedRootIds, targetId)) {
        return;
    }

    const targetLocationBeforeExtraction = findBookmarkLocation(bookmarks.value, targetId);
    if (!targetLocationBeforeExtraction) {
        return;
    }

    const draggedItems = extractDraggedItems(draggedRootIds);
    if (draggedItems.length === 0) {
        return;
    }

    const targetLocation = findBookmarkLocation(bookmarks.value, targetId);
    if (!targetLocation) {
        bookmarks.value.push(...draggedItems);
        return;
    }

    if (position === 'child') {
        targetLocation.item.items.push(...draggedItems);
        const nextExpanded = new Set(expandedBookmarkIds.value);
        nextExpanded.add(targetLocation.item.id);
        expandedBookmarkIds.value = nextExpanded;
        return;
    }

    const insertionIndex = position === 'before' ? targetLocation.index : targetLocation.index + 1;
    targetLocation.list.splice(insertionIndex, 0, ...draggedItems);
}

function moveBookmarksToRootEnd(draggedRootIds: string[]) {
    const draggedItems = extractDraggedItems(draggedRootIds);
    if (draggedItems.length === 0) {
        return;
    }
    bookmarks.value.push(...draggedItems);
}

function handleBookmarkDragStart(payload: { id: string }) {
    if (!isEditMode.value) {
        return;
    }

    if (!selectedBookmarkIds.value.has(payload.id)) {
        applySingleSelection(payload.id);
    }

    const draggedRoots = getSelectedRootIds(selectedBookmarkIds.value);
    draggingBookmarkIds.value = new Set(draggedRoots.length > 0 ? draggedRoots : [payload.id]);
    bookmarkDropTarget.value = null;
    isRootAppendDropTarget.value = false;
    closeBookmarkContextMenu();
}

function handleBookmarkDragHover(payload: IBookmarkDropPayload) {
    const draggingRoots = [...draggingBookmarkIds.value];
    if (!isEditMode.value || draggingRoots.length === 0) {
        return;
    }

    if (!canDropBookmarks(draggingRoots, payload.targetId)) {
        bookmarkDropTarget.value = null;
        isRootAppendDropTarget.value = false;
        return;
    }

    bookmarkDropTarget.value = {
        id: payload.targetId,
        position: payload.position,
    };
    isRootAppendDropTarget.value = false;
}

function handleBookmarkDrop(payload: IBookmarkDropPayload) {
    const draggingRoots = [...draggingBookmarkIds.value];
    if (!isEditMode.value || draggingRoots.length === 0) {
        return;
    }

    if (!canDropBookmarks(draggingRoots, payload.targetId)) {
        resetDragState();
        return;
    }

    moveBookmarksToTarget(draggingRoots, payload.targetId, payload.position);
    activeItemId.value = draggingRoots[0] ?? null;
    emitBookmarksChange();
    resetDragState();
}

function handleTreeEndDragOver() {
    if (!isEditMode.value || draggingBookmarkIds.value.size === 0) {
        return;
    }

    bookmarkDropTarget.value = null;
    isRootAppendDropTarget.value = true;
}

function handleTreeEndDrop() {
    const draggingRoots = [...draggingBookmarkIds.value];
    if (!isEditMode.value || draggingRoots.length === 0) {
        return;
    }

    moveBookmarksToRootEnd(draggingRoots);
    activeItemId.value = draggingRoots[0] ?? null;
    emitBookmarksChange();
    resetDragState();
}

function handleBookmarkDragEnd() {
    resetDragState();
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
        resetDragState();
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
            resetDragState();
            styleRangeStartId.value = null;
            if (activeItemId.value) {
                applySingleSelection(activeItemId.value);
            } else {
                selectedBookmarkIds.value = new Set();
                selectionAnchorBookmarkId.value = null;
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

.bookmarks-context-menu {
    position: fixed;
    z-index: 1400;
    min-width: 210px;
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

.bookmarks-context-menu-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.bookmarks-context-menu-action:hover:not(:disabled) {
    border-color: var(--ui-border);
    background: color-mix(in srgb, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
}

.bookmarks-context-menu-action.is-danger {
    color: color-mix(in srgb, var(--ui-error) 68%, var(--ui-text-highlighted) 32%);
}

.bookmarks-context-menu-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 3px 2px;
}

.bookmarks-context-menu-style-block {
    padding: 3px 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.bookmarks-context-menu-style-row {
    display: flex;
    gap: 6px;
}

.bookmarks-style-toggle {
    width: 24px;
    height: 24px;
    border: 1px solid var(--ui-border);
    border-radius: 5px;
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.bookmarks-style-toggle:nth-child(2) {
    font-style: italic;
}

.bookmarks-style-toggle.is-active {
    border-color: color-mix(in srgb, var(--ui-primary) 50%, var(--ui-border) 50%);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 9%, var(--ui-bg) 91%);
}

.bookmarks-context-menu-color-row {
    display: flex;
    gap: 6px;
}

.bookmarks-color-swatch {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ui-bg-inverted) 16%, transparent 84%);
    cursor: pointer;
}

.bookmarks-color-swatch.is-active {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 45%, transparent 55%);
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
const isEditMode = computed({
    get: () => props.isEditMode,
    set: (value: boolean) => emit('update:isEditMode', value),
});
