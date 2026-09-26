<template>
    <PdfSidebar
        v-if="isReader && showsPdfSidebar"
        v-model:active-tab="view.sidebarTab.value"
        v-model:search-query="search.searchQuery.value"
        :submitted-search-query="search.submittedSearchQuery.value"
        :search-options="search.searchOptions.value"
        :is-open="isOpen"
        :is-active="isActive"
        :is-resizing="search.isPointerResizingSidebar.value"
        :pdf-document="view.pdfDocument.value"
        :raster-scheduler="view.pdfRasterScheduler.value"
        :page-geometry="thumbnailPageGeometry"
        :current-page="view.currentPage.value"
        :total-pages="view.totalPages.value"
        :page-labels="pageLabels"
        :page-label-ranges="pageLabelState.pageLabelRanges.value"
        :search-results="search.results.value"
        :current-result-index="search.currentResultIndex.value"
        :current-result-navigation-id="search.currentResultNavigationId.value"
        :is-searching="search.isSearching.value"
        :search-error="search.searchError.value"
        :search-focus-request="search.searchFocusRequest.value"
        :search-progress="search.searchProgress.value"
        :is-truncated="search.isTruncated.value"
        :min-query-length="search.minQueryLength"
        :width="search.sidebarWidth.value"
        :annotation-tool="annotations.annotationTool.value"
        :annotation-keep-active="annotations.annotationKeepActive.value"
        :annotation-settings="annotations.annotationSettings.value"
        :annotation-comments="annotations.annotationComments.value"
        :annotation-comments-status="annotations.annotationCommentsStatus.value"
        :annotation-inventory="annotations.annotationInventory.value"
        :annotation-enrichment-state="annotations.annotationEnrichmentState.value"
        :selected-annotations="annotations.selectedAnnotations.value"
        :can-rotate-annotations="pdfViewer?.canRotateSelectedAnnotations"
        :bookmark-edit-mode="bookmarkState.bookmarkEditMode.value"
        :bookmark-items="bookmarkState.bookmarkItems.value"
        :bookmarks-dirty="bookmarkState.bookmarksDirty.value"
        :bookmark-navigation-intent-version="bookmarkNavigationIntentVersion"
        :is-page-operation-in-progress="pageOps.isPageOperationInProgress.value"
        :is-djvu-mode="file.isDjvuMode.value"
        :selected-thumbnail-pages="view.selectedThumbnailPages.value"
        :selected-page-selection="view.selectedPageSelection.value"
        :thumbnail-invalidation-request="view.thumbnailInvalidationRequest.value"
        :thumbnail-hidden-annotation-ids="annotations.thumbnailHiddenAnnotationIds.value"
        @update:available-tabs="search.setAvailableSidebarTabs"
        @search="searchWhenDocumentReady"
        @cancel-search="search.cancelSearch"
        @next="search.handleSearchNext"
        @previous="search.handleSearchPrevious"
        @update:search-options="search.searchOptions.value = $event"
        @go-to-page="navigation.handleGoToPage"
        @go-to-result="goToResult"
        @update:page-label-ranges="pageLabelState.handlePageLabelRangesUpdate"
        @update:annotation-tool="annotations.handleAnnotationToolChange"
        @update:annotation-keep-active="annotations.annotationKeepActive.value = $event"
        @annotation-setting="annotations.handleAnnotationSettingChange"
        @annotation-edit-text-box="annotations.handleAnnotationToolChange('select'); pdfViewer?.editAnnotationTextBox?.($event)"
        @annotation-properties="pdfViewer?.updateSelectedAnnotationProperties?.($event)"
        @update:selected-thumbnail-pages="view.handleSelectedThumbnailPagesUpdate"
        @update:selected-page-selection="view.setSelectedPageSelection"
        @annotation-focus-comment="annotationActions.handleAnnotationFocusComment"
        @annotation-open-note="annotationActions.handleOpenAnnotationNote"
        @annotation-delete-comment="annotationActions.handleDeleteAnnotationComment"
        @annotation-retry-enrichment="requestAnnotationEnrichment"
        @bookmarks-change="bookmarkState.handleBookmarksChange"
        @update:bookmark-edit-mode="bookmarkState.bookmarkEditMode.value = $event"
        @page-context-menu="context.pageContextMenu.showPageContextMenu"
        @page-rotate-cw="pageOps.handlePageRotate($event, 90)"
        @page-rotate-ccw="pageOps.handlePageRotate($event, 270)"
        @page-extract="pageOps.pageOpsExtract($event)"
        @page-export="context.exportWorkflow.handleExportImages($event)"
        @page-delete="pageOps.pageOpsDelete($event, view.totalPages.value)"
        @page-reorder="pageOps.pageOpsReorder($event)"
        @page-move="pageOps.pageOpsMove($event)"
        @page-file-drop="pageOps.handlePageFileDrop"
    />
    <DocumentSourceSidebar
        v-else-if="isReader"
        v-model:active-tab="view.sidebarTab.value"
        :is-active="isActive"
        :source="view.documentPageSource.value"
        :current-page="view.currentPage.value"
        :is-resizing="isSourceResizing"
        :search-session="context.sourceSearch"
        :search-focus-request="search.searchFocusRequest.value"
        @go-to-page="navigation.handleGoToPage($event)"
        @update:available-tabs="search.setAvailableSidebarTabs"
    />
</template>

<script setup lang="ts">
import { until } from '@vueuse/core';
import { PdfSidebar } from '@app/modules/pdf-viewer/public/component-exports/pdfSidebar';
import type { IPdfThumbnailPageGeometry } from '@app/modules/pdf-viewer/public';
import type { TDocumentPageLabelLookup } from '@app/modules/document-viewer/public';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import { useDocumentContext } from '@app/modules/workspace-shell/documentContext';

const {
    documentOpening,
    isOpen,
    isActive,
    isSourceResizing,
    pageLabels,
    showsPdfSidebar,
} = defineProps<{
    documentOpening: boolean;
    isOpen: boolean;
    isActive: boolean;
    isSourceResizing: boolean;
    pageLabels: TDocumentPageLabelLookup;
    showsPdfSidebar: boolean;
}>();

const context = useDocumentContext();
const {
    view,
    search,
    file,
    navigation,
    annotations,
    annotationActions,
    pageOps,
    bookmarkNavigationIntentVersion,
    metadata: {
        pageLabelState,
        bookmarkState,
    },
} = context;
const isReader = computed(() => context.scanCleanup.surfaceMode.value === 'reader');
const pdfViewer = computed(() => view.pdfViewerRef.value);
const thumbnailPageGeometry = computed<IPdfThumbnailPageGeometry | null>(() => {
    const viewer = pdfViewer.value;
    if (!viewer?.pageMetrics || !viewer.ensurePageMetricsInRange) {
        return null;
    }
    return {
        ensureRange: viewer.ensurePageMetricsInRange,
        metrics: toRaw(viewer.pageMetrics),
        version: viewer.pageMetricsVersion ?? 0,
    };
});

function requestAnnotationEnrichment() {
    void pdfViewer.value?.ensurePdfAnnotationNameReconciliation?.('annotations-ui-open');
}
watch(
    () => view.showSidebar.value && view.sidebarTab.value === 'annotations',
    (annotationsVisible) => {
        if (annotationsVisible) {
            requestAnnotationEnrichment();
        }
    },
    {flush: 'post'},
);

function goToResult(index: number) {
    if (search.results.value[index]) {
        search.handleGoToResult(index);
    }
}

const searchDocumentReady = computed(() => Boolean(
    file.workingCopyPath.value
    && view.pdfDocument.value
    && view.totalPages.value > 0
    && !view.isLoading.value
    && !documentOpening,
));
let latestSearchRequest = 0;
// A search typed while the document opens runs once it is searchable.
async function searchWhenDocumentReady() {
    const request = ++latestSearchRequest;
    const identity = [
        file.workingCopyPath.value,
        file.documentRevisionToken.value,
    ];
    const query = search.searchQuery.value;
    const options = {...search.searchOptions.value};
    await until(searchDocumentReady).toBe(true);
    if (
        request !== latestSearchRequest
        || identity[0] !== file.workingCopyPath.value
        || identity[1] !== file.documentRevisionToken.value
    ) {
        return;
    }
    if (!search.searchQuery.value && query) {
        search.searchQuery.value = query;
        search.searchOptions.value = options;
    }
    await search.handleSearch();
}
</script>
