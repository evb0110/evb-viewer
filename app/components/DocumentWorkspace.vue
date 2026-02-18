<template>
    <div class="flex h-full min-h-0 min-w-0 w-full flex-col">
        <Teleport v-if="isActive && canTeleportToolbar" to="#editor-global-toolbar-host">
            <PdfToolbar
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
                :is-djvu-mode="isDjvuMode"
                :is-capturing-region="isCapturingRegion"
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
                @disable-drag="handleAnnotationToolChange('none'); closeAllDropdowns()"
                @capture-region="handleCaptureRegion(); closeAllDropdowns()"
            >
                <template #ocr="{ isCollapsed }">
                    <OcrPopup
                        :pdf-document="pdfDocument"
                        :pdf-data="pdfData"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        :open="ocrPopupOpen"
                        :is-exporting-docx="isExportingDocx"
                        :external-error="docxExportError"
                        :disabled="isDjvuMode"
                        :hide-trigger="isCollapsed(1)"
                        @update:open="handleDropdownOpen('ocr', $event)"
                        @export-docx="handleExportDocx"
                        @ocr-complete="handleOcrComplete"
                    />
                </template>
                <template #zoom-dropdown>
                    <PdfZoomDropdown
                        v-model:zoom="zoom"
                        v-model:fit-mode="fitMode"
                        v-model:view-mode="viewMode"
                        :open="zoomDropdownOpen"
                        :compact-level="0"
                        @update:open="handleDropdownOpen('zoom', $event)"
                    />
                </template>
                <template #page-dropdown="{ collapseTier }">
                    <PdfPageDropdown
                        v-model="currentPage"
                        :open="pageDropdownOpen"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :compact-level="collapseTier >= 5 ? 2 : collapseTier >= 4 ? 1 : 0"
                        @go-to-page="handleGoToPage"
                        @update:open="handleDropdownOpen('page', $event)"
                    />
                </template>
                <template #overflow-menu="{ collapseTier, hasOverflowItems }">
                    <ToolbarOverflowMenu
                        v-if="hasOverflowItems"
                        :open="overflowMenuOpen"
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
                        :view-mode="viewMode"
                        :is-djvu-mode="isDjvuMode"
                        :is-fit-width-active="isFitWidthActive"
                        :is-fit-height-active="isFitHeightActive"
                        @update:open="handleDropdownOpen('overflow', $event)"
                        @save="handleSave(); closeAllDropdowns()"
                        @save-as="handleSaveAs(); closeAllDropdowns()"
                        @export-docx="handleExportDocx(); closeAllDropdowns()"
                        @open-ocr="handleDropdownOpen('ocr', true)"
                        @undo="handleUndo(); closeAllDropdowns()"
                        @redo="handleRedo(); closeAllDropdowns()"
                        @fit-width="handleFitMode('width'); closeAllDropdowns()"
                        @fit-height="handleFitMode('height'); closeAllDropdowns()"
                        @enable-drag="enableDragMode(); closeAllDropdowns()"
                        @disable-drag="handleAnnotationToolChange('none'); closeAllDropdowns()"
                        @set-view-mode="viewMode = $event; closeAllDropdowns()"
                        @toggle-continuous-scroll="continuousScroll = !continuousScroll; closeAllDropdowns()"
                        @open-settings="emit('open-settings'); closeAllDropdowns()"
                    />
                </template>
            </PdfToolbar>
        </Teleport>

        <UAlert
            v-if="pdfError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :description="String(pdfError)"
            :ui="{ title: 'sr-only' }"
        />

        <UAlert
            v-if="isDjvuMode && djvuError"
            color="error"
            variant="soft"
            class="mx-3 mt-2"
            :description="String(djvuError)"
            :ui="{ title: 'sr-only' }"
        />

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
        <main class="flex-1 overflow-hidden flex relative min-w-0 min-h-0">
            <div
                v-if="pdfSrc && showSidebar"
                class="sidebar-wrapper"
                :style="sidebarWrapperStyle"
            >
                <PdfSidebar
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
                    :selected-thumbnail-pages="selectedThumbnailPages"
                    :thumbnail-invalidation-request="thumbnailInvalidationRequest"
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:page-label-ranges="handlePageLabelRangesUpdate"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @update:selected-thumbnail-pages="handleSelectedThumbnailPagesUpdate"
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
                    @page-export="(pages) => handleExportImages(pages)"
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
            <div class="flex-1 overflow-hidden min-w-0 min-h-0">
                <PdfViewer
                    v-if="pdfSrc"
                    ref="pdfViewerRef"
                    :src="pdfSrc"
                    :zoom="zoom"
                    :fit-mode="fitMode"
                    :view-mode="viewMode"
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
                <div v-else-if="suppressEmptyState" class="workspace-transition-placeholder" />
                <PdfEmptyState
                    v-else
                    :recent-files="recentFiles"
                    :open-batch-progress="openBatchProgress"
                    @open-file="handleOpenFileFromUi"
                    @open-recent="openRecentFile"
                    @remove-recent="removeRecentFile"
                    @clear-recent="clearRecentFiles"
                />
            </div>
        </main>
        <div
            v-if="isExportInProgress"
            class="pointer-events-none absolute bottom-12 right-4 z-50 flex items-center gap-2 rounded-md border border-default bg-default/95 px-3 py-2 text-xs text-default shadow-lg"
            role="status"
            aria-live="polite"
        >
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            <span>{{ t('export.inProgress') }}</span>
        </div>
        <Teleport v-if="isActive && canTeleportStatus" to="#editor-global-status-host">
            <PdfStatusBar
                :file-path="statusFilePath"
                :file-size-label="statusFileSizeLabel"
                :zoom-label="statusZoomLabel"
                :can-show-in-folder="statusCanShowInFolder"
                :show-in-folder-tooltip="statusShowInFolderTooltip"
                :show-in-folder-aria-label="statusShowInFolderAriaLabel"
                :save-dot-class="statusSaveDotClass"
                :save-dot-tooltip="statusSaveDotTooltip"
                :save-dot-aria-label="statusSaveDotAriaLabel"
                :can-save="statusSaveDotCanSave"
                @show-in-folder="handleStatusShowInFolderClick"
                @save="handleStatusSaveClick"
            />
        </Teleport>
        <WorkspaceAnnotationOverlays
            :sorted-annotation-note-windows="sortedAnnotationNoteWindows"
            :annotation-note-positions="annotationNotePositions"
            :annotation-context-menu="annotationContextMenu"
            :annotation-context-menu-style="annotationContextMenuStyle"
            :annotation-context-menu-can-copy="annotationContextMenuCanCopy"
            :annotation-context-menu-can-copy-selection="annotationContextMenuCanCopySelection"
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
            @context-copy-selection-text="copyContextMenuSelectionText"
            @context-delete="deleteContextMenuComment"
            @context-markup="createContextMenuMarkup"
            @context-create-free-note="createContextMenuFreeNote"
            @context-create-selection-note="createContextMenuSelectionNote"
            @page-delete="handlePageContextMenuDelete"
            @page-extract="handlePageContextMenuExtract"
            @page-export="handlePageContextMenuExport"
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

        <PdfExportScopeDialog
            v-model:open="exportScopeDialogOpen"
            :mode="exportScopeDialogMode"
            :total-pages="totalPages"
            :current-page="currentPage"
            :selected-pages="exportScopeDialogSelectedPages"
            @submit="handleExportScopeDialogSubmit"
            @update:open="handleExportScopeDialogOpenChange"
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
    computed,
    onBeforeUnmount,
    onMounted,
    onUnmounted,
    ref,
    toRef,
    watch,
} from 'vue';
import { createWorkspaceExpose } from '@app/composables/page/createWorkspaceExpose';
import { useWorkspaceOrchestration } from '@app/composables/page/useWorkspaceOrchestration';
import { useWorkspaceRestoreTracker } from '@app/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/composables/useWorkspaceSplitCache';
import type { TOpenFileResult } from '@app/types/electron-api';
import type { TTabUpdate } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';

const props = defineProps<{
    tabId: string;
    isActive: boolean;
    pendingDocumentOpen?: boolean;
}>();

const canTeleportToolbar = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-toolbar-host'))
));
const canTeleportStatus = computed(() => (
    import.meta.client
    && Boolean(document.getElementById('editor-global-status-host'))
));

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [result: TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
}>();

const { t } = useTypedI18n();
const workspaceSplitCache = useWorkspaceSplitCache();
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const isRestoringSplitPayload = ref(false);

const hasQueuedSplitRestore = computed(() => workspaceSplitCache.has(props.tabId));
const isExternallyRestoring = computed(() => workspaceRestoreTracker.has(props.tabId));
const suppressEmptyState = computed(() => (
    isRestoringSplitPayload.value
    || hasQueuedSplitRestore.value
    || isExternallyRestoring.value
    || props.pendingDocumentOpen === true
));

const w = useWorkspaceOrchestration({
    isActive: toRef(props, 'isActive'),
    emit,
});

const {
    pdfSrc,
    pdfError,
    pdfData,
    workingCopyPath,
    pdfDocument,
    isDjvuMode,
    djvuSourcePath,
    conversionState,
    djvuIsLoadingPages,
    djvuLoadingProgress,
    djvuShowBanner,
    djvuError,
    showConvertDialog,
    openConvertDialog,
    djvuDismissBanner,
    handleDjvuConvert,
    handleDjvuCancel,
    openBatchProgress,
    recentFiles,
    removeRecentFile,
    clearRecentFiles,
    pdfViewerRef,
    zoomDropdownOpen,
    pageDropdownOpen,
    ocrPopupOpen,
    overflowMenuOpen,
    selectedThumbnailPages,
    thumbnailInvalidationRequest,
    handleSelectedThumbnailPagesUpdate,
    handleDropdownOpen,
    closeAllDropdowns,
    zoom,
    fitMode,
    viewMode,
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
    isExportInProgress,
    exportScopeDialogOpen,
    exportScopeDialogMode,
    exportScopeDialogSelectedPages,
    pageLabels,
    pageLabelRanges,
    handlePageLabelRangesUpdate,
    bookmarkEditMode,
    handleBookmarksChange,
    annotationContextMenu,
    annotationContextMenuStyle,
    annotationContextMenuCanCopy,
    annotationContextMenuCanCopySelection,
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
    handleExportImages,
    handleExportMultiPageTiff,
    handleExportScopeDialogSubmit,
    handleExportScopeDialogOpenChange,
    handleOcrComplete,
    docxExportError,
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
    handleCaptureRegion,
    isCapturingRegion,
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
    copyContextMenuSelectionText,
    deleteContextMenuComment,
    createContextMenuFreeNote,
    createContextMenuSelectionNote,
    createContextMenuMarkup,
    handleCopyAnnotationComment,
    handleDeleteAnnotationComment,
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusCanShowInFolder,
    statusShowInFolderTooltip,
    statusShowInFolderAriaLabel,
    statusSaveDotClass,
    statusSaveDotCanSave,
    statusSaveDotTooltip,
    statusSaveDotAriaLabel,
    handleStatusSaveClick,
    handleStatusShowInFolderClick,
    isPageOperationInProgress,
    pageOpsDelete,
    pageOpsExtract,
    pageOpsInsert,
    pageOpsReorder,
    handlePageContextMenuDelete,
    handlePageContextMenuExtract,
    handlePageContextMenuExport,
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
    handleOpenFileDirectBatchWithPersist,
    handleOpenFileWithResult,
    handleCloseFileFromUi,
    openRecentFile,
    captureSplitPayload,
    restoreSplitPayload,
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

async function restoreCachedSplitPayloadIfNeeded() {
    if (!workspaceSplitCache.has(props.tabId) || hasPdf.value) {
        return;
    }

    const payload = workspaceSplitCache.consume(props.tabId);
    if (!payload) {
        return;
    }

    isRestoringSplitPayload.value = true;
    try {
        await restoreSplitPayload(payload);
    } catch (error) {
        BrowserLogger.warn('workspace', 'Failed to restore cached split payload', {
            tabId: props.tabId,
            payloadKind: payload.kind,
            error,
        });
    } finally {
        isRestoringSplitPayload.value = false;
    }
}

async function cacheSplitPayloadForRemount() {
    try {
        const payload = await captureSplitPayload();
        workspaceSplitCache.set(props.tabId, payload);
    } catch (error) {
        BrowserLogger.warn('workspace', 'Failed to cache split payload on unmount', {
            tabId: props.tabId,
            error,
        });
    }
}

onMounted(() => {
    initFromStorage();
    setupShortcuts();
    void restoreCachedSplitPayloadIfNeeded();
});

watch(
    [
        hasQueuedSplitRestore,
        hasPdf,
        isRestoringSplitPayload,
        isExternallyRestoring,
    ],
    ([
        hasQueued,
        hasLoadedPdf,
        isRestoring,
        isExternalRestoreInProgress,
    ]) => {
        if (!hasQueued || hasLoadedPdf || isRestoring || isExternalRestoreInProgress) {
            return;
        }
        void restoreCachedSplitPayloadIfNeeded();
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    void cacheSplitPayloadForRemount();
});

onUnmounted(() => {
    cleanupSidebarResizeListeners();
    cleanupShortcuts();
});

const workspaceExpose: IWorkspaceExpose = createWorkspaceExpose({
    handleSave,
    handleSaveAs,
    handleUndo,
    handleRedo,
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist,
    handleOpenFileDirectBatchWithPersist,
    handleOpenFileWithResult,
    handleCloseFileFromUi,
    handleExportDocx,
    handleExportImages,
    handleExportMultiPageTiff,
    hasPdf,
    closeAllDropdowns,
    zoom,
    viewMode,
    handleFitMode,
    selectedThumbnailPages,
    pageOpsDelete,
    pageOpsExtract,
    handlePageRotate,
    pageOpsInsert,
    totalPages,
    isDjvuMode,
    openConvertDialog,
    captureSplitPayload,
    restoreSplitPayload,
});

defineExpose(workspaceExpose);
</script>

<style scoped>
.sidebar-wrapper {
    display: flex;
    height: 100%;
    min-width: 0;
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

.workspace-transition-placeholder {
    width: 100%;
    height: 100%;
    background: var(--app-window-bg);
}
</style>
