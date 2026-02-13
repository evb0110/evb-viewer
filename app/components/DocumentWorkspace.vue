<template>
    <div class="flex flex-col h-full">
        <PdfToolbar
            ref="pdfToolbarRef"
            :has-pdf="!!pdfSrc"
            :can-save="canSave"
            :can-undo="canUndo"
            :can-redo="canRedo"
            :can-export-docx="!!workingCopyPath && !isAnySaving && !isHistoryBusy && !isExportingDocx"
            :is-saving="isSaving"
            :is-saving-as="isSavingAs"
            :is-any-saving="isAnySaving"
            :is-history-busy="isHistoryBusy"
            :is-exporting-docx="isExportingDocx"
            :is-fit-width-active="isFitWidthActive"
            :is-fit-height-active="isFitHeightActive"
            :show-sidebar="showSidebar"
            :drag-mode="dragMode"
            :continuous-scroll="continuousScroll"
            :collapse-tier="collapseTier"
            :has-overflow-items="hasOverflowItems"
            :is-collapsed="isCollapsed"
            :is-djvu-mode="isDjvuMode"
            @open-file="handleOpenFileFromUi"
            @open-settings="emit('open-settings')"
            @save="handleSave(); closeAllDropdowns()"
            @save-as="handleSaveAs(); closeAllDropdowns()"
            @export-docx="handleExportDocx(); closeAllDropdowns()"
            @undo="handleUndo(); closeAllDropdowns()"
            @redo="handleRedo(); closeAllDropdowns()"
            @toggle-sidebar="showSidebar = !showSidebar; closeAllDropdowns()"
            @fit-width="handleFitMode('width'); closeAllDropdowns()"
            @fit-height="handleFitMode('height'); closeAllDropdowns()"
            @toggle-continuous-scroll="continuousScroll = !continuousScroll; closeAllDropdowns()"
            @enable-drag="enableDragMode(); closeAllDropdowns()"
            @disable-drag="dragMode = false; closeAllDropdowns()"
        >
            <template #ocr>
                <OcrPopup
                    v-if="!isCollapsed(1)"
                    ref="ocrPopupRef"
                    :pdf-document="pdfDocument"
                    :pdf-data="pdfData"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :working-copy-path="workingCopyPath"
                    :disabled="isDjvuMode"
                    @open="closeOtherDropdowns('ocr')"
                    @ocr-complete="handleOcrComplete"
                />
                <OcrPopup
                    v-else
                    ref="ocrPopupRef"
                    :pdf-document="pdfDocument"
                    :pdf-data="pdfData"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :working-copy-path="workingCopyPath"
                    :disabled="isDjvuMode"
                    class="toolbar-hidden-ocr"
                    @open="closeOtherDropdowns('ocr')"
                    @ocr-complete="handleOcrComplete"
                />
            </template>
            <template #zoom-dropdown>
                <PdfZoomDropdown
                    ref="zoomDropdownRef"
                    v-model:zoom="zoom"
                    v-model:fit-mode="fitMode"
                    @open="pageDropdownRef?.close()"
                />
            </template>
            <template #page-dropdown>
                <PdfPageDropdown
                    ref="pageDropdownRef"
                    v-model="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    @go-to-page="handleGoToPage"
                    @open="zoomDropdownRef?.close()"
                />
            </template>
            <template #overflow-menu>
                <ToolbarOverflowMenu
                    v-if="hasOverflowItems"
                    ref="overflowMenuRef"
                    :collapse-tier="collapseTier"
                    :can-save="canSave"
                    :can-undo="canUndo"
                    :can-redo="canRedo"
                    :is-any-saving="isAnySaving"
                    :is-history-busy="isHistoryBusy"
                    :is-exporting-docx="isExportingDocx"
                    :can-export-docx="!!workingCopyPath && !isAnySaving && !isHistoryBusy && !isExportingDocx"
                    :drag-mode="dragMode"
                    :continuous-scroll="continuousScroll"
                    :is-djvu-mode="isDjvuMode"
                    :is-fit-width-active="isFitWidthActive"
                    :is-fit-height-active="isFitHeightActive"
                    @save="handleSave(); closeAllDropdowns()"
                    @save-as="handleSaveAs(); closeAllDropdowns()"
                    @export-docx="handleExportDocx(); closeAllDropdowns()"
                    @open-ocr="closeOtherDropdowns('ocr'); ocrPopupRef?.open()"
                    @undo="handleUndo(); closeAllDropdowns()"
                    @redo="handleRedo(); closeAllDropdowns()"
                    @fit-width="handleFitMode('width'); closeAllDropdowns()"
                    @fit-height="handleFitMode('height'); closeAllDropdowns()"
                    @enable-drag="enableDragMode(); closeAllDropdowns()"
                    @disable-drag="dragMode = false; closeAllDropdowns()"
                    @toggle-continuous-scroll="continuousScroll = !continuousScroll; closeAllDropdowns()"
                />
            </template>
        </PdfToolbar>

        <DjvuBanner
            v-if="isDjvuMode"
            :visible="djvuShowBanner"
            :is-loading-pages="djvuIsLoadingPages"
            :loading-current="djvuLoadingProgress.current"
            :loading-total="djvuLoadingProgress.total"
            @convert="openConvertDialog"
            @dismiss="djvuDismissBanner"
        />

        <!-- Main -->
        <main class="flex-1 overflow-hidden flex relative">
            <div
                v-if="pdfSrc && showSidebar"
                class="sidebar-wrapper"
                :style="sidebarWrapperStyle"
            >
                <PdfSidebar
                    ref="sidebarRef"
                    v-model:active-tab="sidebarTab"
                    v-model:search-query="searchQuery"
                    :is-open="showSidebar"
                    :pdf-document="pdfDocument"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :total-matches="totalMatches"
                    :is-searching="isSearching"
                    :search-progress="searchProgress"
                    :is-truncated="isTruncated"
                    :min-query-length="minQueryLength"
                    :width="sidebarWidth"
                    :annotation-tool="annotationTool"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :annotation-comments="annotationComments"
                    :annotation-active-comment-stable-key="annotationActiveCommentStableKey"
                    :annotation-placing-page-note="annotationPlacingPageNote"
                    :bookmark-edit-mode="bookmarkEditMode"
                    :is-page-operation-in-progress="isPageOperationInProgress"
                    :is-djvu-mode="isDjvuMode"
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:page-label-ranges="handlePageLabelRangesUpdate"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @annotation-comment-selection="handleCommentSelection"
                    @annotation-start-place-note="handleStartPlaceNote"
                    @annotation-focus-comment="handleAnnotationFocusComment"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-copy-comment="handleCopyAnnotationComment"
                    @annotation-delete-comment="handleDeleteAnnotationComment"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                    @page-context-menu="showPageContextMenu"
                    @page-rotate-cw="(pages) => handlePageRotate(pages, 90)"
                    @page-rotate-ccw="(pages) => handlePageRotate(pages, 270)"
                    @page-extract="(pages) => pageOpsExtract(pages)"
                    @page-delete="(pages) => pageOpsDelete(pages, totalPages)"
                    @page-reorder="(order) => pageOpsReorder(order)"
                    @page-file-drop="handlePageFileDrop"
                />
                <div
                    class="sidebar-resizer"
                    :class="{ 'is-active': isResizingSidebar }"
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('sidebar.resize')"
                    @pointerdown.prevent="startSidebarResize"
                />
            </div>
            <div class="flex-1 overflow-hidden">
                <PdfViewer
                    v-if="pdfSrc"
                    ref="pdfViewerRef"
                    :src="pdfSrc"
                    :zoom="zoom"
                    :fit-mode="fitMode"
                    :drag-mode="dragMode"
                    :continuous-scroll="continuousScroll"
                    :annotation-tool="annotationTool"
                    :annotation-cursor-mode="annotationCursorMode"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    :working-copy-path="workingCopyPath"
                    :author-name="appSettings.authorName"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @update:document="pdfDocument = $event"
                    @loading="isLoading = $event"
                    @annotation-state="handleAnnotationState"
                    @annotation-modified="handleAnnotationModified"
                    @annotation-comments="annotationComments = $event"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-comment-click="handleAnnotationCommentClick"
                    @annotation-context-menu="handleViewerAnnotationContextMenu"
                    @annotation-tool-auto-reset="handleAnnotationToolAutoReset"
                    @annotation-tool-cancel="handleAnnotationToolCancel"
                    @annotation-setting="handleAnnotationSettingChange"
                    @annotation-note-placement-change="annotationPlacingPageNote = $event"
                    @shape-context-menu="handleShapeContextMenu"
                />
                <PdfEmptyState
                    v-else
                    :recent-files="recentFiles"
                    @open-file="handleOpenFileFromUi"
                    @open-recent="openRecentFile"
                    @remove-recent="removeRecentFile"
                    @clear-recent="clearRecentFiles"
                />
            </div>
        </main>
        <PdfStatusBar
            :file-path="statusFilePath"
            :file-size-label="statusFileSizeLabel"
            :zoom-label="statusZoomLabel"
            :save-dot-class="statusSaveDotClass"
            :save-dot-tooltip="statusSaveDotTooltip"
            :save-dot-aria-label="statusSaveDotAriaLabel"
            :can-save="statusSaveDotCanSave"
            @save="handleStatusSaveClick"
        />
        <WorkspaceAnnotationOverlays
            :sorted-annotation-note-windows="sortedAnnotationNoteWindows"
            :annotation-note-positions="annotationNotePositions"
            :annotation-context-menu="annotationContextMenu"
            :annotation-context-menu-style="annotationContextMenuStyle"
            :annotation-context-menu-can-copy="annotationContextMenuCanCopy"
            :annotation-context-menu-can-create-free="annotationContextMenuCanCreateFree"
            :context-menu-annotation-label="contextMenuAnnotationLabel"
            :context-menu-delete-action-label="contextMenuDeleteActionLabel"
            :page-context-menu="pageContextMenu"
            :page-context-menu-style="pageContextMenuStyle"
            :is-page-operation-in-progress="isPageOperationInProgress"
            :is-djvu-mode="isDjvuMode"
            :selected-shape-for-properties="selectedShapeForProperties"
            :shape-properties-x="shapePropertiesPopover.x"
            :shape-properties-y="shapePropertiesPopover.y"
            @update-note-text="updateAnnotationNoteText"
            @update-note-position="updateAnnotationNotePosition"
            @close-note="closeAnnotationNote"
            @delete-comment="handleDeleteAnnotationComment"
            @focus-note="bringAnnotationNoteToFront"
            @context-open-note="openContextMenuNote"
            @context-copy-text="copyContextMenuNoteText"
            @context-delete="deleteContextMenuComment"
            @context-markup="createContextMenuMarkup"
            @context-create-free-note="createContextMenuFreeNote"
            @context-create-selection-note="createContextMenuSelectionNote"
            @page-delete="handlePageContextMenuDelete"
            @page-extract="handlePageContextMenuExtract"
            @page-rotate-cw="handlePageContextMenuRotateCw"
            @page-rotate-ccw="handlePageContextMenuRotateCcw"
            @page-insert-before="handlePageContextMenuInsertBefore"
            @page-insert-after="handlePageContextMenuInsertAfter"
            @page-select-all="handlePageContextMenuSelectAll"
            @page-invert-selection="handlePageContextMenuInvertSelection"
            @shape-update="handleShapePropertyUpdate"
            @shape-close="closeShapeProperties"
        />

        <DjvuConversionOverlay
            :is-converting="conversionState.isConverting && !djvuIsLoadingPages"
            :phase="conversionState.phase"
            :percent="conversionState.percent"
            @cancel="handleDjvuCancel"
        />

        <DjvuConvertDialog
            v-if="isDjvuMode"
            v-model:open="showConvertDialog"
            :djvu-path="djvuSourcePath"
            @convert="handleDjvuConvert"
        />
    </div>
</template>

<script setup lang="ts">
import {
    onMounted,
    onUnmounted,
    toRef,
} from 'vue';
import { useWorkspaceOrchestration } from '@app/composables/page/useWorkspaceOrchestration';
import type { TTabUpdate } from '@app/types/tabs';

const props = defineProps<{
    tabId: string;
    isActive: boolean;
}>();

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [path: string];
    'request-close-tab': [];
    'open-settings': [];
}>();

const { t } = useI18n();

const w = useWorkspaceOrchestration({
    isActive: toRef(props, 'isActive'),
    emit,
});

const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    pdfDocument,
    isDjvuMode,
    djvuSourcePath,
    conversionState,
    djvuIsLoadingPages,
    djvuLoadingProgress,
    djvuShowBanner,
    showConvertDialog,
    openConvertDialog,
    djvuDismissBanner,
    handleDjvuConvert,
    handleDjvuCancel,
    recentFiles,
    removeRecentFile,
    clearRecentFiles,
    pdfViewerRef,
    zoomDropdownRef,
    pageDropdownRef,
    ocrPopupRef,
    overflowMenuRef,
    sidebarRef,
    pdfToolbarRef,
    collapseTier,
    hasOverflowItems,
    isCollapsed,
    closeAllDropdowns,
    closeOtherDropdowns,
    zoom,
    fitMode,
    currentPage,
    totalPages,
    isLoading,
    dragMode,
    continuousScroll,
    appSettings,
    showSidebar,
    sidebarTab,
    isSaving,
    isSavingAs,
    isHistoryBusy,
    pageLabels,
    pageLabelRanges,
    handlePageLabelRangesUpdate,
    bookmarkEditMode,
    handleBookmarksChange,
    annotationContextMenu,
    annotationContextMenuStyle,
    annotationContextMenuCanCopy,
    annotationContextMenuCanCreateFree,
    contextMenuAnnotationLabel,
    contextMenuDeleteActionLabel,
    pageContextMenu,
    pageContextMenuStyle,
    showPageContextMenu,
    annotationTool,
    annotationKeepActive,
    annotationPlacingPageNote,
    annotationSettings,
    annotationComments,
    annotationActiveCommentStableKey,
    handleAnnotationToolChange,
    handleAnnotationToolAutoReset,
    handleAnnotationToolCancel,
    handleAnnotationSettingChange,
    handleAnnotationState,
    handleAnnotationModified,
    searchQuery,
    results,
    pageMatches,
    currentResultIndex,
    currentResult,
    isSearching,
    totalMatches,
    searchProgress,
    isTruncated,
    minQueryLength,
    handleSearch,
    handleSearchNext,
    handleSearchPrevious,
    handleGoToResult,
    handleSave,
    handleSaveAs,
    handleExportDocx,
    handleOcrComplete,
    isAnySaving,
    isExportingDocx,
    canSave,
    isFitWidthActive,
    isFitHeightActive,
    annotationCursorMode,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
    annotationNotePositions,
    sortedAnnotationNoteWindows,
    updateAnnotationNoteText,
    updateAnnotationNotePosition,
    closeAnnotationNote,
    bringAnnotationNoteToFront,
    shapePropertiesPopover,
    selectedShapeForProperties,
    handleCommentSelection,
    handleStartPlaceNote,
    handleAnnotationFocusComment,
    handleAnnotationCommentClick,
    handleOpenAnnotationNote,
    closeShapeProperties,
    handleShapePropertyUpdate,
    handleShapeContextMenu,
    handleViewerAnnotationContextMenu,
    openContextMenuNote,
    copyContextMenuNoteText,
    deleteContextMenuComment,
    createContextMenuFreeNote,
    createContextMenuSelectionNote,
    createContextMenuMarkup,
    handleCopyAnnotationComment,
    handleDeleteAnnotationComment,
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusSaveDotClass,
    statusSaveDotCanSave,
    statusSaveDotTooltip,
    statusSaveDotAriaLabel,
    handleStatusSaveClick,
    isPageOperationInProgress,
    pageOpsDelete,
    pageOpsExtract,
    pageOpsInsert,
    pageOpsReorder,
    handlePageContextMenuDelete,
    handlePageContextMenuExtract,
    handlePageRotate,
    handlePageContextMenuRotateCw,
    handlePageContextMenuRotateCcw,
    handlePageContextMenuInsertBefore,
    handlePageContextMenuInsertAfter,
    handlePageFileDrop,
    handlePageContextMenuSelectAll,
    handlePageContextMenuInvertSelection,
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist,
    handleCloseFileFromUi,
    openRecentFile,
    setupShortcuts,
    cleanupShortcuts,
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    startSidebarResize,
    cleanupSidebarResizeListeners,
    handleFitMode,
    enableDragMode,
    handleGoToPage,
    initFromStorage,
    hasPdf,
} = w;

onMounted(() => {
    initFromStorage();
    setupShortcuts();
});

onUnmounted(() => {
    cleanupSidebarResizeListeners();
    cleanupShortcuts();
});

defineExpose({
    handleSave,
    handleSaveAs,
    handleUndo,
    handleRedo,
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist,
    handleCloseFileFromUi,
    handleExportDocx,
    hasPdf,
    handleZoomIn: () => { zoom.value = Math.min(zoom.value + 0.25, 5); },
    handleZoomOut: () => { zoom.value = Math.max(zoom.value - 0.25, 0.25); },
    handleFitWidth: () => { handleFitMode('width'); },
    handleFitHeight: () => { handleFitMode('height'); },
    handleActualSize: () => { zoom.value = 1; },
    handleDeletePages: () => {
        const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
        if (pages.length > 0) void pageOpsDelete(pages, totalPages.value);
    },
    handleExtractPages: () => {
        const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
        if (pages.length > 0) void pageOpsExtract(pages);
    },
    handleRotateCw: () => {
        const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
        if (pages.length > 0) void handlePageRotate(pages, 90);
    },
    handleRotateCcw: () => {
        const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
        if (pages.length > 0) void handlePageRotate(pages, 270);
    },
    handleInsertPages: () => {
        void pageOpsInsert(totalPages.value, totalPages.value);
    },
    handleConvertToPdf: () => {
        if (isDjvuMode.value) {
            openConvertDialog();
        }
    },
    closeAllDropdowns,
});
</script>

<style scoped>
.toolbar-hidden-ocr {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
    opacity: 0;
}

.sidebar-wrapper {
    display: flex;
    height: 100%;
}

.sidebar-resizer {
    width: 6px;
    cursor: col-resize;
    position: relative;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    background: transparent;
    border-left: 1px solid var(--ui-border);
    transition: border-color 0.15s ease;
}

.sidebar-resizer:hover,
.sidebar-resizer.is-active {
    border-left-color: var(--ui-primary);
}
</style>
