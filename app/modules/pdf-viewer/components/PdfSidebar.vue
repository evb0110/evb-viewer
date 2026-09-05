<template>
    <AppSidebarShell
        v-show="isOpen"
        class="pdf-sidebar"
        data-testid="document-sidebar"
        :style="sidebarStyle"
        :model-value="effectiveTab ?? ''"
        :tabs="localizedTabs"
        :outer-scroll="false"
        @update:model-value="handleShellTabUpdate"
    >
            <PdfAnnotationsPanel
                v-show="effectiveTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :comments-status="annotationCommentsStatus"
                :inventory="annotationInventory"
                :enrichment-state="annotationEnrichmentState"
                :active-comment-stable-key="annotationActiveCommentStableKey"
                :selected-text-box="selectedTextBox"
                :keep-active="annotationKeepActive"
                @set-tool="updateAnnotationTool"
                @update:keep-active="updateAnnotationKeepActive"
                @update-setting="updateAnnotationSetting"
                @focus-comment="focusAnnotationComment"
                @open-note="openAnnotationNote"
                @delete-comment="deleteAnnotationComment"
                @retry-enrichment="retryAnnotationEnrichment"
            />

            <DocumentSidebarPagesPanel
                v-show="effectiveTab === 'thumbnails'"
                class="pdf-sidebar-pages"
                rail-class="pdf-sidebar-pages-thumbnails"
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
                        :pdf-document="pdfDocument"
                        :raster-scheduler="rasterScheduler"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :selected-pages="selectedThumbnailPages"
                        :selected-page-selection="selectedPageSelectionProp"
                        :invalidation-request="thumbnailInvalidationRequest"
                        :hidden-annotation-ids="thumbnailHiddenAnnotationIds"
                        :annotation-comments="annotationComments"
                        :annotation-settings="annotationSettings"
                        :is-active="isActive && isOpen && effectiveTab === 'thumbnails'"
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
                    :selected-pages="selectedThumbnailPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    @update:selected-pages="handleSelectedPagesUpdate"
                    @update:page-label-ranges="updatePageLabelRanges"
                    @clear="clearPageSelection"
                />
                </template>
            </DocumentSidebarPagesPanel>

            <PdfOutline
                v-if="hasActivatedBookmarksTab"
                v-show="effectiveTab === 'bookmarks'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :is-edit-mode="bookmarkEditMode"
                :bookmark-items="bookmarkItems"
                :bookmarks-dirty="bookmarksDirty"
                :navigation-intent-version="bookmarkNavigationIntentVersion"
                @go-to-page="goToPage"
                @bookmarks-change="updateBookmarks"
                @update:is-edit-mode="updateBookmarkEditMode"
            />
            <DocumentSearchPanel
                v-show="effectiveTab === 'search'"
                :session="searchSession"
                :is-active="isActive && isOpen && effectiveTab === 'search'"
                :focus-request="searchFocusRequest ?? 0"
                :page-labels="pageLabels ?? null"
            />
    </AppSidebarShell>
</template>

<script setup lang="ts">

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import { PDF_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import { pageSelectionCount } from '@contracts/pageNumbers';
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
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { PENDING_ANNOTATION_ENRICHMENT_STATE } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import PdfPageSelectionBar from '@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import PdfSidebarPageNumbering from '@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue';
import PdfThumbnails from '@app/modules/pdf-viewer/components/PdfThumbnails.vue';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import DocumentSidebarPagesPanel from '@app/components/document-viewer/DocumentSidebarPagesPanel.vue';
import {useDocumentSidebarCapabilitySession} from '@app/utils/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
import { createPdfDocumentSearchSession } from '@app/modules/pdf-viewer/search/createPdfDocumentSearchSession';
import { SIDEBAR } from '@app/constants/pdfLayout';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import type { TDocumentPageLabelLookup } from '@app/utils/document-viewer/pageLabels';

type TPageSelectionInput = number[] | TPageSelection;

interface IProps {
    isOpen: boolean;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
    pdfDocument: PDFDocumentProxy | null;
    rasterScheduler: IPdfPageRasterScheduler | null;
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
    activeTab?: TPdfSidebarTab | undefined;
    width?: number | undefined;
    annotationTool: TAnnotationTool;
    annotationKeepActive: boolean;
    annotationSettings: IAnnotationSettings;
    annotationComments: IAnnotationCommentSummary[];
    annotationCommentsStatus: TAnnotationCommentsStatus;
    annotationInventory?: IAnnotationInventoryCompleteness | null | undefined;
    annotationEnrichmentState?: IAnnotationEnrichmentState | undefined;
    annotationActiveCommentStableKey?: string | null | undefined;
    selectedTextBox?: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null | undefined;
    bookmarkEditMode: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    bookmarksDirty: boolean;
    bookmarkNavigationIntentVersion: number;
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
    activeTab: activeTabProp = undefined,
    annotationActiveCommentStableKey: annotationActiveCommentStableKeyProp = undefined,
    selectedTextBox = null,
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
    annotationCommentsStatus,
    annotationInventory = null,
    annotationEnrichmentState = PENDING_ANNOTATION_ENRICHMENT_STATE,
    bookmarkItems,
    bookmarkNavigationIntentVersion,
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
    pageLabelRanges = undefined,
    pageLabels = undefined,
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
const annotationActiveCommentStableKey = computed(() => annotationActiveCommentStableKeyProp ?? null);

const emit = defineEmits<{
    goToPage: [page: number, options?: IScrollToPageOptions];
    goToResult: [index: number];
    'update:activeTab': [value: TPdfSidebarTab];
    'update:availableTabs': [value: TPdfSidebarTab[]];
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
    'annotation-setting': [payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }];
    'annotation-focus-comment': [comment: IAnnotationCommentSummary];
    'annotation-open-note': [comment: IAnnotationCommentSummary];
    'annotation-delete-comment': [comment: IAnnotationCommentSummary];
    'annotation-retry-enrichment': [];
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

const activeTabLocal = ref<TPdfSidebarTab>('thumbnails');

const activeTab = computed<TPdfSidebarTab>({
    get: () => activeTabProp ?? activeTabLocal.value,
    set: (value) => {
        if (activeTabProp !== undefined) {
            emit('update:activeTab', value);
            return;
        }
        activeTabLocal.value = value;
    },
});
const sidebarCapabilities = computed(() => ({
    annotations: !isDjvuMode,
    bookmarks: true,
    pages: true,
    search: true,
}));
const {
    availableTabs,
    effectiveTab,
    select: selectTab,
} = useDocumentSidebarCapabilitySession({
    capabilities: sidebarCapabilities,
    capabilitiesReady: computed(() => true),
    preferredTab: activeTab,
});

watch(
    availableTabs,
    tabs => emit('update:availableTabs', [...tabs]),
    {immediate: true},
);

const selectedThumbnailPages = computed(() => selectedThumbnailPagesProp);

const isBookmarksTabActive = computed(() => isOpen && effectiveTab.value === 'bookmarks');

/**
 * The bookmarks panel mounts on its first activation and then stays alive
 * behind `v-show`, so outline display mode, expansion, and selection survive
 * tab switches. Documents whose bookmarks tab is never opened still skip
 * outline parsing entirely; unmounting the sidebar host remains the reset
 * boundary.
 */
const hasActivatedBookmarksTab = ref(false);
watch(isBookmarksTabActive, (isActive) => {
    if (isActive) {
        hasActivatedBookmarksTab.value = true;
    }
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

function retryAnnotationEnrichment() {
    emit('annotation-retry-enrichment');
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
        effectiveTab.value,
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

watch(
    () => totalPages,
    (totalPages) => {
        if (totalPages <= 0) {
            return;
        }

        const filteredPages = selectedThumbnailPagesProp.filter(page => page <= totalPages);
        if (
            filteredPages.length !== selectedThumbnailPagesProp.length
            || filteredPages.some((page, index) => page !== selectedThumbnailPagesProp[index])
        ) {
            emit('update:selectedThumbnailPages', filteredPages);
        }
    },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: string;
    icon: string;
    title: string;
}


const localizedTabs = computed<IPdfSidebarTabItem[]>(() => {
    return availableTabs.value.map((value) => ({
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
    selectTab(value as TPdfSidebarTab);
}

const sidebarStyle = computed(() => {
    const sidebarWidth = width ?? SIDEBAR.DEFAULT_WIDTH;

    return {
        width: `${sidebarWidth}px`,
        maxWidth: '100%',
        minWidth: '0',
    };
});
</script>
