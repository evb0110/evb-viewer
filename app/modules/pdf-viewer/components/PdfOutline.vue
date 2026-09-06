<template>
    <div class="pdf-bookmarks flex flex-col gap-3">
        <DocumentBookmarkToolbar
            v-if="isBookmarkToolbarVisible"
            :display-mode="displayMode"
            :editable="bookmarkStatus !== 'unpersistable'"
            :is-edit-mode="isEditMode"
            :selected-delete-count="selectedBookmarkDeleteCount"
            @set-display-mode="setDisplayMode"
            @toggle-edit-mode="toggleEditMode"
            @add-root-bookmark="addRootBookmark"
            @remove-selected-bookmarks="removeSelectedBookmarks"
        />

        <template v-if="bookmarkStatus === 'loading'">
            <div
                v-if="isLoadingIndicatorVisible"
                class="pdf-bookmarks-loading"
            >
                <AppSpinner size="md" tone="muted" />
                <span>{{ t('bookmarks.loading') }}</span>
            </div>
        </template>

        <DocumentPanelEmptyState
            v-else-if="bookmarkStatus === 'error'"
            icon="i-ph-warning"
            :title="t('bookmarks.unavailable')"
        />

        <DocumentPanelEmptyState
            v-else-if="bookmarkStatus === 'empty'"
            icon="i-ph-book-open"
            :title="t('bookmarks.noBookmarks')"
        >
            <template v-if="isEditMode" #action>
                <UButton
                    type="button"
                    icon="i-ph-plus"
                    size="xs"
                    variant="soft"
                    color="neutral"
                    :label="t('bookmarks.addFirst')"
                    :aria-label="t('bookmarks.addFirst')"
                    @click="addRootBookmark"
                />
            </template>
        </DocumentPanelEmptyState>

        <div
            v-if="bookmarkStatus === 'unpersistable'"
            class="pdf-bookmarks-persistence-refusal"
            data-bookmark-persistence-refusal
            :data-bookmark-persistence-reason="outlinePersistenceRefusal?.reason"
            role="status"
        >
            {{ outlinePersistenceRefusalMessage }}
        </div>

        <div
            v-else-if="isEditMode"
            class="pdf-bookmarks-tree flex flex-col app-scrollbar app-scroll-region--balanced"
            @click="closeBookmarkContextMenu"
        >
            <PdfOutlineItem
                v-for="(item, index) in bookmarks"
                :key="item.id || index"
                :item="item"
                :pdf-document="props.pdfDocument"
                @go-to-page="goToPage"
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
                :class="{ 'is-active': dragDrop.isRootAppendDropTarget.value }"
                @dragover.prevent="handleTreeEndDragOver"
                @drop.prevent="handleTreeEndDrop"
            />
        </div>

        <DocumentBookmarkTree
            v-else
            :items="sharedBookmarkItems"
            :active-id="activeItemId"
            :display-mode="displayMode"
            :expanded-ids="expandedBookmarkIds"
            :active-path-ids="activePathBookmarkIds"
            @activate="activateSharedBookmark"
            @toggle-expand="toggleExpanded"
        />

        <PdfOutlineContextMenu
            :visible="bookmarkContextMenu.visible"
            :x="bookmarkContextMenu.x"
            :y="bookmarkContextMenu.y"
            :bookmark="selectedContextBookmark"
            :style-summary="contextStyleSummary"
            :remove-label="contextRemoveBookmarkLabel"
            @edit="startEditingBookmark"
            @add-sibling-above="addSiblingAbove"
            @add-sibling-below="addSiblingBelow"
            @add-child="addChildBookmark"
            @toggle-bold="toggleBookmarkBold"
            @toggle-italic="toggleBookmarkItalic"
            @set-color="setBookmarkColor"
            @remove="removeBookmark"
        />
    </div>
</template>

<script setup lang="ts">
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';


import type {
    IBookmarkItem,
    IBookmarkActivatePayload,
    IBookmarkDropPayload,
    IBookmarkIdentityInput,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import type {
    IDocumentBookmarkTreeItem,
    TDocumentBookmarkPersistenceRefusal,
    TDocumentBookmarkStatus,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import {
    buildOutlineFromBookmarkEntries,
    buildResolvedOutline,
    flattenBookmarks,
    parseOutlineItems,
    resolveActiveBookmarkForPage,
    resolveMaxBookmarkDepth,
} from '@app/utils/pdfOutlineHelpers';
import { usePdfOutlineSelection } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineSelection';
import { BrowserLogger } from '@app/utils/browserLogger';
import { usePdfOutlineDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineDragDrop';
import { usePdfOutlineEditing } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineEditing';
import { usePdfOutlineContextMenu } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfOutlineContextMenu';
import { pdfOutlineTreeKey } from '@app/modules/pdf-viewer/engine/pdf-outline-tree-context/pdfOutlineTreeKey';
import AppSpinner from '@app/components/AppSpinner.vue';
import PdfOutlineContextMenu from '@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue';
import PdfOutlineItem from '@app/modules/pdf-viewer/components/PdfOutlineItem.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentBookmarkToolbar from '@app/components/document-viewer/DocumentBookmarkToolbar.vue';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';
import { createBookmarkIdentityFactory } from '@app/modules/pdf-viewer/engine/pdf-outline-identity/createBookmarkIdentityFactory';
import { areBookmarkEntriesEqual } from '@app/modules/pdf-viewer/engine/pdf-outline-tree/areBookmarkEntriesEqual';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';

interface IProps {
    pdfDocument: IPdfDocument | null;
    currentPage: number;
    isEditMode: boolean;
    bookmarkItems?: IPdfBookmarkEntry[] | undefined;
    bookmarksDirty?: boolean | undefined;
    navigationIntentVersion?: number | undefined;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    goToPage: [page: number, options?: IScrollToPageOptions];
    'bookmarks-change': [payload: IPdfBookmarkChangePayload];
    'update:isEditMode': [value: boolean];
}>();

function goToPage(page: number, options?: IScrollToPageOptions) {
    emit('goToPage', page, options);
}

function toggleEditMode() {
    isEditMode.value = !isEditMode.value;
}

const { t } = useTypedI18n();

const bookmarks = ref<IBookmarkItem[]>([]);
const isLoading = ref(false);
const isLoadingIndicatorVisible = ref(false);
const outlineError = ref(false);
const activeItemId = ref<string | null>(null);
const displayMode = ref<TBookmarkDisplayMode>('current-expanded');
const expandedBookmarkIds = ref<Set<string>>(new Set());
const nativeBookmarkDepthLimit = PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth;
const flatBookmarks = computed(() => flattenBookmarks(bookmarks.value));
const outlinePersistenceRefusal = computed<{
    count: number;
    limit: number;
    reason: TDocumentBookmarkPersistenceRefusal;
} | null>(() => {
    const count = flatBookmarks.value.length;
    if (resolveMaxBookmarkDepth(bookmarks.value) > nativeBookmarkDepthLimit) {
        return {
            count,
            limit: nativeBookmarkDepthLimit,
            reason: 'depth',
        };
    }
    return null;
});
const outlinePersistenceBlocked = computed(() => outlinePersistenceRefusal.value !== null);
const outlinePersistenceRefusalMessage = computed(() => {
    const refusal = outlinePersistenceRefusal.value;
    if (!refusal) {
        return '';
    }
    return t('bookmarks.persistenceRefusalDepth', {
        count: refusal.count,
        limit: refusal.limit,
    });
});

const bookmarkStatus = computed<TDocumentBookmarkStatus>(() => {
    if (isLoading.value) {
        return 'loading';
    }
    if (outlineError.value) {
        return 'error';
    }
    if (outlinePersistenceBlocked.value) {
        return 'unpersistable';
    }
    return bookmarks.value.length === 0 ? 'empty' : 'ready';
});
const isBookmarkToolbarVisible = computed(() => (
    bookmarkStatus.value === 'ready'
        || bookmarkStatus.value === 'empty'
        || bookmarkStatus.value === 'unpersistable'
));

watch(outlinePersistenceBlocked, blocked => {
    if (blocked && props.isEditMode) {
        emit('update:isEditMode', false);
    }
}, {flush: 'post'});

const isEditMode = computed({
    get: () => props.isEditMode && !outlinePersistenceBlocked.value,
    set: (value: boolean) => {
        if (value && outlinePersistenceBlocked.value) {
            BrowserLogger.warn('pdfOutline', 'Refused bookmark editing outside native persistence limits', {
                itemCount: flatBookmarks.value.length,
                maxDepth: nativeBookmarkDepthLimit,
                reason: outlinePersistenceRefusal.value?.reason,
            });
            emit('update:isEditMode', false);
            return;
        }
        emit('update:isEditMode', value);
    },
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

/**
 * Bookmark ids are derived from each bookmark's content path, so an outline
 * rebuilt from the same entries reproduces the ids that selection, expansion,
 * row keys, and drag state are held under. A rebuild starts a fresh factory
 * because duplicate-sibling counters belong to one tree.
 */
function createBookmarkIdentity() {
    return createBookmarkIdentityFactory({untitledLabel: t('bookmarks.untitled')});
}

let bookmarkIdentity = createBookmarkIdentity();

const BOOKMARK_LOADING_INDICATOR_DELAY_MS = 150;
let loadingIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

function cancelLoadingIndicatorDelay() {
    if (loadingIndicatorTimer !== null) {
        clearTimeout(loadingIndicatorTimer);
        loadingIndicatorTimer = null;
    }
}

function stopOutlineLoading() {
    cancelLoadingIndicatorDelay();
    isLoading.value = false;
    isLoadingIndicatorVisible.value = false;
}

function beginOutlineLoading() {
    cancelLoadingIndicatorDelay();
    isLoading.value = true;
    isLoadingIndicatorVisible.value = false;
    loadingIndicatorTimer = setTimeout(() => {
        loadingIndicatorTimer = null;
        if (isLoading.value) {
            isLoadingIndicatorVisible.value = true;
        }
    }, BOOKMARK_LOADING_INDICATOR_DELAY_MS);
}

onScopeDispose(cancelLoadingIndicatorDelay);

function resetBookmarkIdentity() {
    bookmarkIdentity = createBookmarkIdentity();
}

function createBookmarkId(input: IBookmarkIdentityInput) {
    return bookmarkIdentity.createBookmarkId(input);
}

function createDraftBookmarkId() {
    return bookmarkIdentity.createDraftBookmarkId();
}

function isBookmarkGrowthRefused() {
    const refusal = outlinePersistenceRefusal.value;
    if (!refusal) {
        return false;
    }

    BrowserLogger.warn('pdfOutline', 'Refused bookmark mutation outside the native persistence limits', {
        itemCount: flatBookmarks.value.length,
        maxDepth: nativeBookmarkDepthLimit,
        reason: refusal.reason,
    });
    return true;
}

const sharedBookmarkItems = computed<IDocumentBookmarkTreeItem[]>(() => {
    function mapItems(items: readonly IBookmarkItem[]): IDocumentBookmarkTreeItem[] {
        return items.map(item => ({
            id: item.id,
            title: item.title,
            pageNumber: item.pageIndex === null ? null : item.pageIndex + 1,
            children: mapItems(item.items),
            bold: item.bold,
            italic: item.italic,
            color: item.color,
        }));
    }

    return mapItems(bookmarks.value);
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

let bookmarkNavigationRequestId = 0;
let bookmarkNavigationIntentVersion = props.navigationIntentVersion ?? 0;
const bookmarkNavigationIntentVersionByRequest = new Map<number, number>();

/**
 * Prevents async bookmark resolution from applying to an outline/document that
 * no longer owns the user's navigation intent.
 */
function invalidateBookmarkNavigationRequests() {
    bookmarkNavigationRequestId += 1;
    bookmarkNavigationIntentVersion = props.navigationIntentVersion ?? 0;
    bookmarkNavigationIntentVersionByRequest.clear();
}

function beginBookmarkNavigationRequest() {
    invalidateBookmarkNavigationRequests();
    bookmarkNavigationIntentVersionByRequest.set(
        bookmarkNavigationRequestId,
        props.navigationIntentVersion ?? 0,
    );
    return bookmarkNavigationRequestId;
}

function isBookmarkNavigationRequestCurrent(requestId: number) {
    return requestId === bookmarkNavigationRequestId
        && bookmarkNavigationIntentVersionByRequest.get(requestId) === bookmarkNavigationIntentVersion;
}

watch(
    () => props.navigationIntentVersion,
    (version) => {
        const nextVersion = version ?? 0;
        if (nextVersion === bookmarkNavigationIntentVersion) {
            return;
        }
        bookmarkNavigationIntentVersion = nextVersion;
        invalidateBookmarkNavigationRequests();
    },
    { flush: 'sync' },
);

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
    () => {
        editing.cancelEditingBookmark();
        dragDrop.resetDragState();
    },
);

const {
    bookmarkContextMenu,
    selectedContextBookmark,
    openBookmarkContextMenu,
    closeBookmarkContextMenu,
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
    bookmarkOrderIndexMap,
    selection.selectedBookmarkIds,
    selection.selectionAnchorBookmarkId,
    dragDrop.draggingBookmarkIds,
    selection.applySingleSelection,
    closeBookmarkContextMenu,
    dragDrop.resetDragState,
    currentPageRef,
    emitBookmarksChange,
    createDraftBookmarkId,
);

function addRootBookmark() {
    if (isBookmarkGrowthRefused()) {
        return;
    }
    editing.addRootBookmark();
}

function renameBookmark(payload: {
    id: string;
    title: string;
}) {
    editing.renameBookmark(payload);
}

function cancelEditingBookmark() {
    editing.cancelEditingBookmark();
}

function handleBookmarkDragStart(payload: { id: string }) {
    dragDrop.handleBookmarkDragStart(payload);
}

function handleBookmarkDragHover(payload: IBookmarkDropPayload) {
    dragDrop.handleBookmarkDragHover(payload);
}

function handleBookmarkDragEnd() {
    dragDrop.handleBookmarkDragEnd();
}

function handleTreeEndDragOver() {
    dragDrop.handleTreeEndDragOver();
}

function startEditingBookmark(id: string) {
    editing.startEditingBookmark(id);
}

function addSiblingAbove(id: string) {
    if (isBookmarkGrowthRefused()) {
        return;
    }
    editing.addSiblingAbove(id);
}

function addSiblingBelow(id: string) {
    if (isBookmarkGrowthRefused()) {
        return;
    }
    editing.addSiblingBelow(id);
}

function addChildBookmark(id: string) {
    if (isBookmarkGrowthRefused()) {
        return;
    }
    editing.addChildBookmark(id);
}

function toggleBookmarkBold(id: string) {
    editing.toggleBookmarkBold(id);
}

function toggleBookmarkItalic(id: string) {
    editing.toggleBookmarkItalic(id);
}

function setBookmarkColor(payload: {
    id: string;
    color: string | null;
}) {
    editing.setBookmarkColor(payload.id, payload.color);
}

function removeBookmark(id: string) {
    editing.removeBookmark(id);
}

function removeSelectedBookmarks() {
    editing.removeSelectedBookmarks();
}

const selectedBookmarkDeleteCount = computed(() => (
    editing.resolveRootBookmarkIds(selection.selectedBookmarkIds.value).length
));

const contextStyleSummary = computed(() => (
    editing.resolveBookmarkStyleSummary(selectedContextBookmark.value?.id ?? '')
));

const contextRemoveBookmarkLabel = computed(() => {
    const contextBookmark = selectedContextBookmark.value;
    if (!contextBookmark) {
        return t('bookmarks.removeBookmark');
    }

    const count = editing.resolveBookmarkRemovalTargetIds(contextBookmark.id).length;
    if (count <= 1) {
        return t('bookmarks.removeBookmark');
    }

    return t('bookmarks.removeSelectedBookmarks', { count });
});

provide(pdfOutlineTreeKey, {
    expandedBookmarkIds,
    activeItemId,
    editingItemId: editing.editingItemId,
    selectedBookmarkIds: selection.selectedBookmarkIds,
    displayMode,
    isEditMode,
    draggingItemIds: dragDrop.draggingBookmarkIds,
    dropTarget: dragDrop.bookmarkDropTarget,
    activePathBookmarkIds,
    beginBookmarkNavigationRequest,
    isBookmarkNavigationRequestCurrent,
});

let outlineRunId = 0;
const initialBookmarkEntries = shallowRef<IPdfBookmarkEntry[]>([]);
const hasMaterializedBookmarkSnapshot = ref(false);

function emitBookmarksChange() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: !areBookmarkEntriesEqual(persisted, initialBookmarkEntries.value),
        history: 'record',
    });
}

function setBookmarkBaseline() {
    const persisted = editing.mapBookmarksForPersistence(bookmarks.value);
    // The emitted payload belongs to the parent from here on, so the baseline
    // maps its own copy instead of aliasing what was handed out.
    syncBookmarkBaselineFromCurrentItems();
    emit('bookmarks-change', {
        bookmarks: persisted,
        dirty: false,
        history: 'reset',
    });
}

function updateActiveItemFromCurrentPage() {
    const active = resolveActiveBookmarkForPage(
        flatBookmarks.value,
        props.currentPage,
        activeItemId.value,
    );
    activeItemId.value = active?.id ?? null;
    if (!isEditMode.value) {
        if (activeItemId.value) {
            selection.applySingleSelection(activeItemId.value);
        } else {
            selection.clearSelection();
        }
    }
}

function getPendingBookmarkEntries() {
    return props.bookmarksDirty ? props.bookmarkItems ?? [] : null;
}

function shouldApplyExternalBookmarkItems(isDirty: boolean) {
    return isDirty || hasMaterializedBookmarkSnapshot.value;
}

function syncBookmarkBaselineFromCurrentItems() {
    initialBookmarkEntries.value = editing.mapBookmarksForPersistence(bookmarks.value);
    hasMaterializedBookmarkSnapshot.value = true;
}

function applyPendingBookmarkItems(
    entries: IPdfBookmarkEntry[],
    options: { syncBaseline?: boolean } = {},
) {
    outlineError.value = false;
    if (areBookmarkEntriesEqual(entries, editing.mapBookmarksForPersistence(bookmarks.value))) {
        if (options.syncBaseline) {
            syncBookmarkBaselineFromCurrentItems();
        } else {
            hasMaterializedBookmarkSnapshot.value = true;
        }
        return;
    }

    invalidateBookmarkNavigationRequests();
    resetBookmarkIdentity();
    bookmarks.value = buildOutlineFromBookmarkEntries(entries, createBookmarkId);
    closeBookmarkContextMenu();
    editing.cancelEditingBookmark();
    dragDrop.resetDragState();
    selection.clearSelection();
    expandedBookmarkIds.value = new Set();
    updateActiveItemFromCurrentPage();
    if (activeItemId.value) {
        selection.applySingleSelection(activeItemId.value);
    }
    if (options.syncBaseline) {
        syncBookmarkBaselineFromCurrentItems();
    } else {
        hasMaterializedBookmarkSnapshot.value = true;
    }
}

function applyPendingBookmarkItemsIfDirty() {
    const pendingBookmarkEntries = getPendingBookmarkEntries();
    if (!pendingBookmarkEntries) {
        return false;
    }

    stopOutlineLoading();
    applyPendingBookmarkItems(pendingBookmarkEntries);
    return true;
}

function resetOutlineInteractionState() {
    closeBookmarkContextMenu();
    editing.cancelEditingBookmark();
    dragDrop.resetDragState();
    selection.clearSelection();
    expandedBookmarkIds.value = new Set();
}

function clearLoadedOutline() {
    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    stopOutlineLoading();
    outlineError.value = false;
    bookmarks.value = [];
    activeItemId.value = null;
    selection.clearSelection();
    setBookmarkBaseline();
}

function isStaleOutlineRun(runId: number, pdfDocument: IPdfDocument) {
    return (
        runId !== outlineRunId ||
        props.pdfDocument !== pdfDocument ||
        !isPdfDocumentUsable(pdfDocument)
    );
}

async function resolveBookmarksFromPdf(pdfDocument: IPdfDocument) {
    const result = await pdfDocument.getOutline();
    const rawOutline = parseOutlineItems(result);
    const destinationCache = new Map<string, unknown[] | null>();
    const refIndexCache = new Map<string, number | null>();

    resetBookmarkIdentity();
    return buildResolvedOutline(
        rawOutline,
        pdfDocument,
        destinationCache,
        refIndexCache,
        createBookmarkId,
    );
}

function applyLoadedBookmarks(resolved: IBookmarkItem[]) {
    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    outlineError.value = false;
    bookmarks.value = resolved;
    updateActiveItemFromCurrentPage();
    if (activeItemId.value) {
        selection.applySingleSelection(activeItemId.value);
    }
    setBookmarkBaseline();
}

function handleOutlineLoadError(
    error: unknown,
    runId: number,
    pdfDocument: IPdfDocument,
) {
    if (isStaleOutlineRun(runId, pdfDocument)) {
        return;
    }

    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    BrowserLogger.error('pdfOutline', 'Failed to load bookmarks', error, {
        code: 'RENDERER_PDF_OUTLINE_LOAD_FAILED',
        context: {},
    });
    outlineError.value = true;
    bookmarks.value = [];
    activeItemId.value = null;
    selection.clearSelection();
    setBookmarkBaseline();
}

function finishOutlineLoading(runId: number) {
    if (runId === outlineRunId) {
        stopOutlineLoading();
    }
}

async function loadUsableOutline(pdfDocument: IPdfDocument, runId: number) {
    beginOutlineLoading();
    outlineError.value = false;
    try {
        const resolved = await resolveBookmarksFromPdf(pdfDocument);
        if (!isStaleOutlineRun(runId, pdfDocument)) {
            applyLoadedBookmarks(resolved);
        }
    } catch (error) {
        handleOutlineLoadError(error, runId, pdfDocument);
    } finally {
        finishOutlineLoading(runId);
    }
}

async function loadOutline() {
    const pdfDocument = props.pdfDocument;
    outlineRunId += 1;
    invalidateBookmarkNavigationRequests();
    hasMaterializedBookmarkSnapshot.value = false;
    const runId = outlineRunId;
    resetOutlineInteractionState();

    if (applyPendingBookmarkItemsIfDirty()) {
        return;
    }

    if (!pdfDocument || !isPdfDocumentUsable(pdfDocument)) {
        clearLoadedOutline();
        return;
    }

    await loadUsableOutline(pdfDocument, runId);
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

function activateSharedBookmark(id: string) {
    const item = flatBookmarks.value.find(candidate => candidate.id === id);
    if (!item) {
        return;
    }

    const wasActive = activeItemId.value === item.id;
    handleActivate({
        id: item.id,
        hasChildren: item.items.length > 0,
        wasActive,
        multiSelect: false,
        rangeSelect: false,
    });
    if (wasActive && item.items.length > 0) {
        toggleExpanded(item.id);
        return;
    }

    const navigationRequestId = beginBookmarkNavigationRequest();
    void navigateToBookmarkDestination({
        item,
        pdfDocument: props.pdfDocument,
        navigationRequestId,
        isBookmarkNavigationRequestCurrent,
        emitGoToPage: (page, options) => emit('goToPage', page, options),
    });
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
    [
        () => props.bookmarksDirty ?? false,
        () => props.bookmarkItems,
    ],
    ([
        isDirty,
        externalItems,
    ]) => {
        const items = externalItems ?? [];
        if (shouldApplyExternalBookmarkItems(isDirty)) {
            applyPendingBookmarkItems(items, { syncBaseline: !isDirty });
        }
    },
    {immediate: true},
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
    invalidateBookmarkNavigationRequests();
});
</script>

<style scoped>
.pdf-bookmarks {
    height: 100%;
    min-height: 0;
    padding: var(--app-sidebar-content-padding);
}

.pdf-bookmarks-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-3xl);
    padding: var(--app-space-16xl);
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-bookmarks-persistence-refusal {
    color: var(--ui-text-muted);
    font-size: var(--app-sidebar-caption-font-size);
    line-height: 1.3;
    padding: 0 var(--app-space-3xl);
}

.pdf-bookmarks-tree {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    user-select: none;
}

.pdf-bookmarks-drop-end {
    height: var(--app-outline-loading-icon-height);
    margin-top: var(--app-space-3xs);
    border-radius: var(--app-radius-md);
}

.pdf-bookmarks-drop-end.is-active {
    background: color-mix(in srgb, var(--ui-primary) 12%, transparent 88%);
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--ui-primary) 72%, transparent 28%);
}

</style>
