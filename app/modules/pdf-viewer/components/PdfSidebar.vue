<template>
    <AppSidebarShell
        v-show="isOpen"
        class="pdf-sidebar"
        data-testid="document-sidebar"
        :width-px="sidebarWidth"
        :model-value="activeTab ?? ''"
        :tabs="localizedTabs"
        :outer-scroll="false"
        @update:model-value="handleShellTabUpdate"
    >
            <PdfAnnotationsPanel
                v-show="activeTab === 'annotations'"
                :is-visible="isActive && isOpen && activeTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :comments-status="annotationCommentsStatus"
                :inventory="annotationInventory"
                :selected-annotations="selectedAnnotations"
                :can-rotate-annotations="canRotateAnnotations"
                :keep-active="annotationKeepActive"
                @set-tool="updateAnnotationTool"
                @update:keep-active="updateAnnotationKeepActive"
                @update-setting="updateAnnotationSetting"
                @update-properties="emit('annotation-properties', $event)"
                @focus-comment="focusAnnotationComment"
                @edit-text-box="emit('annotation-edit-text-box', $event)"
                @open-note="openAnnotationNote"
                @delete-comment="deleteAnnotationComment"
            />

            <DocumentSidebarPagesPanel
                v-show="activeTab === 'thumbnails'"
                class="pdf-sidebar-pages"
                accepts-external-pdf-drop
            >
                <template #header>
                <PdfPageSelectionBar
                    :selected-count="selectedPageSelectionProp
                        ? pageSelectionCount(selectedPageSelectionProp)
                        : selectedThumbnailPages.length"
                    :is-operation-in-progress="isPageOperationInProgress ?? false"
                    :is-djvu-mode="isDjvuMode"
                    @rotate-cw="rotateSelectedPagesClockwise"
                    @rotate-ccw="rotateSelectedPagesCounterClockwise"
                    @extract-pages="extractSelectedPages"
                    @export-pages="exportSelectedPages"
                    @delete-pages="deleteSelectedPages"
                    @deselect="clearPageSelection"
                />
                </template>
                    <PdfThumbnails
                        :source="pageSource"
                        :page-geometry="pageGeometry"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :selected-pages="selectedThumbnailPages"
                        :selected-page-selection="selectedPageSelectionProp"
                        :invalidation-request="thumbnailInvalidationRequest"
                        :hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                        :annotation-comments="annotationComments"
                        :annotation-settings="annotationSettings"
                        :is-active="isActive && isOpen && activeTab === 'thumbnails'"
                        :is-resizing="isResizing"
                        @go-to-page="goToPage"
                        @update:selected-pages="handleSelectedPagesUpdate"
                        @update:selected-page-selection="handleSelectedPageSelectionUpdate"
                        @page-context-menu="openPageContextMenu"
                        @reorder="reorderPages"
                        @move="movePages"
                        @file-drop="dropPageFiles"
                    />
                <template #footer>
                <PdfSidebarPageNumbering
                    :total-pages="totalPages"
                    :selected-page-selection="selectedPageSelectionProp ?? null"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    @update:selected-page-selection="handleSelectedPageSelectionUpdate"
                    @update:page-label-ranges="updatePageLabelRanges"
                    @clear="clearPageSelection"
                />
                </template>
            </DocumentSidebarPagesPanel>

            <PdfOutline
                v-if="hasActivatedBookmarksTab"
                v-show="activeTab === 'bookmarks'"
                :pdf-document="pdfDocument"
                :document-ref="pageSource?.documentRef ?? null"
                :current-page="currentPage"
                :is-edit-mode="bookmarkEditMode"
                :bookmark-items="bookmarkItems"
                :bookmarks-dirty="bookmarksDirty"
                @go-to-page="goToPage"
                @bookmarks-change="updateBookmarks"
                @update:is-edit-mode="updateBookmarkEditMode"
            />
            <DocumentSearchPanel
                v-show="activeTab === 'search'"
                :session="searchSession"
                :is-active="isActive && isOpen && activeTab === 'search'"
                :focus-request="searchFocusRequest ?? 0"
                :page-labels="pageLabels ?? null"
            />
    </AppSidebarShell>
</template>

<script setup lang="ts">
import { whenever } from '@vueuse/core';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';


import type { TDocumentRef } from '@contracts/documentRef';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import { PDF_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@pdf-core/pdfPageSelection';
import { pageSelectionCount } from '@pdf-core/pdfPageSelection';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type {
    IPdfBookmarkChangePayload,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    IAnnotationSettings,
    IAnnotationPropertyUpdate,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import PdfPageSelectionBar from '@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import PdfSidebarPageNumbering from '@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import DocumentSidebarPagesPanel from '@app/components/document-viewer/DocumentSidebarPagesPanel.vue';
import { createPdfDocumentSearchSession } from '@app/modules/pdf-viewer/search/createPdfDocumentSearchSession';
import { SIDEBAR } from '@app/constants/pdfLayout';
import type {
    IDocumentPageSource,
    TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';
import type { IPdfThumbnailPageGeometry } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailComponentContract';

type TPageSelectionInput = number[] | TPageSelection;

interface IProps {
    isOpen: boolean;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
    pdfDocument: IPdfDocument | null;
    pageSource: IDocumentPageSource | null;
    pageGeometry?: IPdfThumbnailPageGeometry | null | undefined;
    currentPage: number;
    totalPages: number;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    pageLabelRanges?: IPdfPageLabelRange[] | undefined;
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    currentResultNavigationId: number;
    searchQuery: string;
    submittedSearchQuery?: string | undefined;
    searchOptions: IResolvedSearchMatchOptions;
    isSearching: boolean;
    searchError?: string | null | undefined;
    searchFocusRequest?: number | undefined;
    searchProgress?: {
        processed: number;
        total: number;
    } | undefined;
    isTruncated?: boolean | undefined;
    minQueryLength?: number | undefined;
    /** The tab shown: the preference clamped to `availableTabs`, or none. */
    activeTab: TPdfSidebarTab | null;
    availableTabs: readonly TPdfSidebarTab[];
    width?: number | undefined;
    annotationTool: TAnnotationTool;
    annotationKeepActive: boolean;
    annotationSettings: IAnnotationSettings;
    annotationComments: IAnnotationCommentSummary[];
    annotationCommentsStatus: TAnnotationCommentsStatus;
    annotationInventory?: IAnnotationInventoryCompleteness | null | undefined;
    selectedAnnotations?: readonly AnnotationEntity[] | undefined;
    canRotateAnnotations?: ((delta: -90 | 90) => boolean) | undefined;
    bookmarkEditMode: boolean;
    /** The document's bookmarks once it has read them; until then the outline reads its own. */
    bookmarkItems?: IPdfBookmarkEntry[] | undefined;
    bookmarksDirty: boolean;
    isPageOperationInProgress?: boolean | undefined;
    isDjvuMode?: boolean | undefined;
    selectedThumbnailPages: number[];
    selectedPageSelection?: TPageSelection | null | undefined;
    thumbnailInvalidationRequest?: {
        id: number;
        pages: number[];
    } | null | undefined;
    thumbnailHiddenAnnotationIds?: string[] | undefined;
}

const { t } = useTypedI18n();

const {
    activeTab,
    availableTabs,
    selectedAnnotations = [],
    canRotateAnnotations = undefined,
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
    annotationCommentsStatus,
    annotationInventory = null,
    bookmarkItems = undefined,
    bookmarksDirty,
    bookmarkEditMode,
    currentPage,
    currentResultNavigationId,
    currentResultIndex,
    isDjvuMode = false,
    isActive = true,
    isOpen,
    isResizing = false,
    isPageOperationInProgress = false,
    isSearching,
    isTruncated = undefined,
    minQueryLength = undefined,
    pageGeometry = undefined,
    pageLabelRanges = undefined,
    pageLabels = undefined,
    pageSource,
    pdfDocument,
    searchError = undefined,
    searchFocusRequest = undefined,
    searchProgress = undefined,
    searchOptions,
    searchQuery,
    searchResults,
    selectedPageSelection: selectedPageSelectionProp = undefined,
    selectedThumbnailPages: selectedThumbnailPagesProp,
    thumbnailHiddenAnnotationIds = undefined,
    submittedSearchQuery = undefined,
    thumbnailInvalidationRequest = undefined,
    totalPages,
    width = undefined,
} = defineProps<IProps>();

const emit = defineEmits<{
    goToPage: [page: number, options?: IScrollToPageOptions];
    goToResult: [index: number];
    'update:activeTab': [value: TPdfSidebarTab];
    'update:searchQuery': [value: string];
    'update:searchOptions': [value: IResolvedSearchMatchOptions];
    'update:annotation-tool': [value: TAnnotationTool];
    'update:annotation-keep-active': [value: boolean];
    'update:bookmark-edit-mode': [value: boolean];
    'update:pageLabelRanges': [ranges: IPdfPageLabelRange[]];
    search: [];
    'cancel-search': [];
    next: [];
    previous: [];
    'annotation-edit-text-box': [comment: IAnnotationCommentSummary];
    'annotation-properties': [updates: IAnnotationPropertyUpdate];
    'annotation-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }];
    'annotation-focus-comment': [comment: IAnnotationCommentSummary];
    'annotation-open-note': [comment: IAnnotationCommentSummary];
    'annotation-delete-comment': [comment: IAnnotationCommentSummary];
    'bookmarks-change': [payload: IPdfBookmarkChangePayload];
    'page-context-menu': [payload: {
        clientX: number;
        clientY: number;
        clickedPage: number;
        pages: number[];
        selection: TPageSelection;
    }];
    'page-rotate-cw': [pages: TPageSelectionInput];
    'page-rotate-ccw': [pages: TPageSelectionInput];
    'page-extract': [pages: TPageSelectionInput];
    'page-export': [pages: TPageSelectionInput];
    'page-delete': [pages: TPageSelectionInput];
    'page-reorder': [newOrder: number[]];
    'update:selectedThumbnailPages': [pages: number[]];
    'update:selected-page-selection': [selection: TPageSelection];
    'page-move': [move: TPageMoveOperation];
    'page-file-drop': [payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }];
}>();

const searchSession = createPdfDocumentSearchSession({
    query: computed(() => searchQuery),
    submittedQuery: computed(() => submittedSearchQuery ?? ''),
    options: computed(() => searchOptions),
    results: computed(() => searchResults),
    currentResultIndex: computed(() => currentResultIndex),
    currentResultNavigationId: computed(() => currentResultNavigationId),
    isSearching: computed(() => isSearching),
    error: computed(() => searchError ?? null),
    progress: computed(() => searchProgress),
    isTruncated: computed(() => isTruncated ?? false),
    minQueryLength: computed(() => minQueryLength ?? PDF_SEARCH_MIN_QUERY_LENGTH),
    setQuery: value => emit('update:searchQuery', value),
    setOptions: value => emit('update:searchOptions', value),
    run: () => emit('search'),
    clear: () => emit('update:searchQuery', ''),
    cancel: () => emit('cancel-search'),
    select: index => emit('goToResult', index),
    navigate: (direction) => {
        if (direction === 'next') {
            emit('next');
        } else {
            emit('previous');
        }
    },
});

const selectedThumbnailPages = computed(() => selectedThumbnailPagesProp);

const isBookmarksTabActive = computed(() => isOpen && activeTab === 'bookmarks');

/**
 * The bookmarks panel mounts on its first activation and then stays alive
 * behind `v-show`, so outline display mode, expansion, and selection survive
 * tab switches. Documents whose bookmarks tab is never opened still skip
 * outline parsing entirely; unmounting the sidebar host remains the reset
 * boundary.
 */
const hasActivatedBookmarksTab = ref(false);
whenever(isBookmarksTabActive, () => {
    hasActivatedBookmarksTab.value = true;
}, {immediate: true});

function handleSelectedPagesUpdate(pages: number[]) {
    emit('update:selectedThumbnailPages', pages);
}

function handleSelectedPageSelectionUpdate(selection: TPageSelection) {
    emit('update:selected-page-selection', selection);
}

function clearPageSelection() {
    emit('update:selectedThumbnailPages', []);
    emit('update:selected-page-selection', {
        kind: 'none',
        pageCount: totalPages,
    });
}

function updateAnnotationTool(tool: TAnnotationTool) {
    emit('update:annotation-tool', tool);
}

function updateAnnotationKeepActive(value: boolean) {
    emit('update:annotation-keep-active', value);
}

function updateAnnotationSetting(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings]
}) {
    emit('annotation-setting', payload);
}

function focusAnnotationComment(comment: IAnnotationCommentSummary) {
    emit('annotation-focus-comment', comment);
}

function openAnnotationNote(comment: IAnnotationCommentSummary) {
    emit('annotation-open-note', comment);
}

function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
    emit('annotation-delete-comment', comment);
}

function getSelectedPagePayload(): TPageSelectionInput {
    return selectedPageSelectionProp ?? selectedThumbnailPages.value;
}

function rotateSelectedPagesClockwise() {
    emit('page-rotate-cw', getSelectedPagePayload());
}

function rotateSelectedPagesCounterClockwise() {
    emit('page-rotate-ccw', getSelectedPagePayload());
}

function extractSelectedPages() {
    emit('page-extract', getSelectedPagePayload());
}

function exportSelectedPages() {
    emit('page-export', getSelectedPagePayload());
}

function deleteSelectedPages() {
    emit('page-delete', getSelectedPagePayload());
}

function goToPage(page: number, options?: IScrollToPageOptions) {
    emit('goToPage', page, options);
}

function openPageContextMenu(payload: {
    clientX: number;
    clientY: number;
    clickedPage: number;
    pages: number[];
    selection: TPageSelection;
}) {
    emit('page-context-menu', payload);
}

function reorderPages(newOrder: number[]) {
    emit('page-reorder', newOrder);
}

function movePages(move: TPageMoveOperation) {
    emit('page-move', move);
}

function dropPageFiles(payload: {
    afterPage: number;
    filePaths: TDocumentRef[];
}) {
    emit('page-file-drop', payload);
}

function updatePageLabelRanges(ranges: IPdfPageLabelRange[]) {
    emit('update:pageLabelRanges', ranges);
}

function updateBookmarks(payload: IPdfBookmarkChangePayload) {
    emit('bookmarks-change', payload);
}

function updateBookmarkEditMode(value: boolean) {
    emit('update:bookmark-edit-mode', value);
}

watch(
    () => [
        isOpen,
        activeTab,
    ] as const,
    ([
        _isOpen,
        activeSidebarTab,
    ], [
        wasOpen,
        previousTab,
    ]) => {
        const leftAnnotations = previousTab === 'annotations' && activeSidebarTab !== 'annotations';
        const sidebarClosed = wasOpen && !isOpen;
        if (leftAnnotations || sidebarClosed) {
            emit('update:annotation-tool', 'none');
        }
        // A search the user has navigated away from is wasted work: drop the
        // in-flight request and anything still waiting on the debounce.
        const leftSearch = previousTab === 'search'
            && (activeSidebarTab !== 'search' || sidebarClosed);
        if (leftSearch) {
            searchSession.cancel();
        }
    },
    { flush: 'post' },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: string;
    icon: string;
    title: string;
}


const localizedTabs = computed<IPdfSidebarTabItem[]>(() => {
    return availableTabs.map((value) => ({
        value,
        icon: {
            annotations: 'i-ph-chat',
            thumbnails: 'i-ph-file',
            bookmarks: 'i-ph-bookmark',
            search: 'i-ph-magnifying-glass',
        }[value],
        label: t(`sidebar.${value === 'thumbnails' ? 'pages' : value}`),
        title: t(`sidebar.${value === 'thumbnails' ? 'pages' : value}`),
    }));
});
function handleShellTabUpdate(value: string) {
    emit('update:activeTab', value as TPdfSidebarTab);
}

const sidebarWidth = computed(() => width ?? SIDEBAR.DEFAULT_WIDTH);
</script>
