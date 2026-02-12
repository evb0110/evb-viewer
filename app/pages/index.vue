<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
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
            @open-file="handleOpenFileFromUi"
            @open-settings="showSettings = true"
            @save="handleSave(); closeAllDropdowns()"
            @save-as="handleSaveAs(); closeAllDropdowns()"
            @export-docx="handleExportDocx(); closeAllDropdowns()"
            @undo="handleUndo(); closeAllDropdowns()"
            @redo="handleRedo(); closeAllDropdowns()"
            @close-file="handleCloseFileFromUi"
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
                    disabled
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
                    :is-fit-width-active="isFitWidthActive"
                    :is-fit-height-active="isFitHeightActive"
                    @save="handleSave(); closeAllDropdowns()"
                    @save-as="handleSaveAs(); closeAllDropdowns()"
                    @export-docx="handleExportDocx(); closeAllDropdowns()"
                    @open-ocr="ocrPopupRef?.open(); closeAllDropdowns()"
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

        <!-- Main -->
        <main class="flex-1 overflow-hidden flex">
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
                    aria-label="Resize sidebar"
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
        <PdfAnnotationNoteWindow
            v-for="note in sortedAnnotationNoteWindows"
            :key="note.comment.stableKey"
            :comment="note.comment"
            :text="note.text"
            :saving="note.saving"
            :error="note.error"
            :position="annotationNotePositions[note.comment.stableKey] ?? null"
            :z-index="90 + note.order"
            @update:text="updateAnnotationNoteText(note.comment.stableKey, $event)"
            @update:position="updateAnnotationNotePosition(note.comment.stableKey, $event)"
            @close="closeAnnotationNote(note.comment.stableKey)"
            @delete="handleDeleteAnnotationComment(note.comment)"
            @focus="bringAnnotationNoteToFront(note.comment.stableKey)"
        />
        <PdfAnnotationContextMenu
            :menu="annotationContextMenu"
            :style="annotationContextMenuStyle"
            :can-copy="annotationContextMenuCanCopy"
            :can-create-free="annotationContextMenuCanCreateFree"
            :annotation-label="contextMenuAnnotationLabel"
            :delete-label="contextMenuDeleteActionLabel"
            @open-note="openContextMenuNote"
            @copy-text="copyContextMenuNoteText"
            @delete="deleteContextMenuComment"
            @markup="createContextMenuMarkup"
            @create-free-note="createContextMenuFreeNote"
            @create-selection-note="createContextMenuSelectionNote"
        />
        <PdfPageContextMenu
            :menu="pageContextMenu"
            :style="pageContextMenuStyle"
            :is-operation-in-progress="isPageOperationInProgress"
            @delete-pages="handlePageContextMenuDelete"
            @extract-pages="handlePageContextMenuExtract"
            @rotate-cw="handlePageContextMenuRotateCw"
            @rotate-ccw="handlePageContextMenuRotateCcw"
            @insert-before="handlePageContextMenuInsertBefore"
            @insert-after="handlePageContextMenuInsertAfter"
            @select-all="handlePageContextMenuSelectAll"
            @invert-selection="handlePageContextMenuInvertSelection"
        />

        <PdfAnnotationProperties
            :shape="selectedShapeForProperties"
            :x="shapePropertiesPopover.x"
            :y="shapePropertiesPopover.y"
            @update="handleShapePropertyUpdate"
            @close="closeShapeProperties"
        />

        <SettingsDialog v-if="showSettings" v-model:open="showSettings" />
    </div>
</template>

<script setup lang="ts">
import {
    onMounted,
    onUnmounted,
    ref,
    shallowRef,
    computed,
    watch,
    watchEffect,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TFitMode } from '@app/types/shared';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import { STORAGE_KEYS } from '@app/constants/storage-keys';
import { useSidebarResize } from '@app/composables/useSidebarResize';
import { useAnnotationContextMenu } from '@app/composables/pdf/useAnnotationContextMenu';
import { usePageContextMenu } from '@app/composables/pdf/usePageContextMenu';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';
import { useDropdownManager } from '@app/composables/useDropdownManager';
import { usePdfHistory } from '@app/composables/usePdfHistory';
import { usePageAnnotationTools } from '@app/composables/usePageAnnotationTools';
import { usePageSearch } from '@app/composables/usePageSearch';
import { usePageAnnotationActions } from '@app/composables/usePageAnnotationActions';
import { usePageSaveOrchestration } from '@app/composables/usePageSaveOrchestration';
import { usePageStatusBar } from '@app/composables/usePageStatusBar';
import { usePageOpsHandlers } from '@app/composables/usePageOpsHandlers';
import { usePageFileOperations } from '@app/composables/usePageFileOperations';
import { usePageShortcuts } from '@app/composables/usePageShortcuts';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    saveDocument: () => Promise<Uint8Array | null>;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    undoAnnotation: () => void;
    redoAnnotation: () => void;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getMarkupSubtypeOverrides: () => Map<string, import('@app/types/annotations').TMarkupSubtype>;
    getAllShapes: () => IShapeAnnotation[];
    loadShapes: (shapes: IShapeAnnotation[]) => void;
    clearShapes: () => void;
    deleteSelectedShape: () => void;
    hasShapes: { value: boolean };
    selectedShapeId: { value: string | null };
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
    applyStampImage: (file: File) => void;
    invalidatePages: (pages: number[]) => void;
}

interface IOcrPopupExpose {
    close: () => void;
    open: () => void;
    exportDocx: () => Promise<boolean>;
    isExporting: { value: boolean };
}

const { t } = useI18n();

const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    originalPath,
    isDirty,
    error: pdfError,
    isElectron,
    openFile,
    openFileDirect,
    loadPdfFromData,
    closeFile,
    saveFile,
    saveWorkingCopy,
    saveWorkingCopyAs,
    markDirty,
    canUndo: canUndoFile,
    canRedo: canRedoFile,
    undo,
    redo,
} = usePdfFile();

const {
    recentFiles,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();

const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
const zoomDropdownRef = ref<{ close: () => void } | null>(null);
const pageDropdownRef = ref<{ close: () => void } | null>(null);
const ocrPopupRef = ref<IOcrPopupExpose | null>(null);
const overflowMenuRef = ref<{ close: () => void } | null>(null);
const sidebarRef = ref<{
    focusSearch: () => void | Promise<void>;
    selectAllPages: () => void;
    invertPageSelection: () => void;
    invalidateThumbnailPages: (pages: number[]) => void;
    selectedThumbnailPages: number[];
} | null>(null);
const pdfToolbarRef = ref<{ toolbarRef: HTMLElement | null } | null>(null);

const {
    toolbarRef,
    collapseTier,
    hasOverflowItems,
    isCollapsed,
} = useToolbarOverflow();

watchEffect(() => {
    toolbarRef.value = pdfToolbarRef.value?.toolbarRef ?? null;
});

const {
    closeAllDropdowns,
    closeOtherDropdowns,
} = useDropdownManager({
    zoomDropdownRef,
    pageDropdownRef,
    ocrPopupRef,
    overflowMenuRef,
});

const zoom = ref(1);
const fitMode = ref<TFitMode>('width');
const currentPage = ref(1);
const totalPages = ref(0);
const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);

const {
    pageLabels,
    pageLabelRanges,
    pageLabelsDirty,
    markPageLabelsSaved,
    handlePageLabelRangesUpdate,
} = usePageLabelState({
    pdfDocument,
    totalPages,
    markDirty, 
});

const {
    bookmarkItems,
    bookmarksDirty,
    bookmarkEditMode,
    markBookmarksSaved,
    handleBookmarksChange,
} = useBookmarkState({ markDirty });

const isLoading = ref(false);
const dragMode = ref(true);
const continuousScroll = ref(true);
const { settings: appSettings } = useSettings();
const showSidebar = ref(false);
const showSettings = ref(false);
const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
const isSaving = ref(false);
const isSavingAs = ref(false);
const isHistoryBusy = ref(false);

const {
    annotationContextMenu,
    annotationContextMenuStyle,
    annotationContextMenuCanCopy,
    annotationContextMenuCanCreateFree,
    contextMenuAnnotationLabel,
    contextMenuDeleteActionLabel,
    closeAnnotationContextMenu,
    showAnnotationContextMenu,
} = useAnnotationContextMenu({ t });

const {
    pageContextMenu,
    pageContextMenuStyle,
    showPageContextMenu,
    closePageContextMenu,
} = usePageContextMenu();

const {
    annotationTool,
    annotationKeepActive,
    annotationPlacingPageNote,
    annotationSettings,
    annotationComments,
    annotationActiveCommentStableKey,
    annotationEditorState,
    annotationDirty,
    handleAnnotationToolChange,
    handleAnnotationToolAutoReset,
    handleAnnotationToolCancel,
    handleAnnotationSettingChange,
    handleAnnotationState,
    handleAnnotationModified,
    markAnnotationDirty,
    markAnnotationSaved,
    resetAnnotationTracking,
} = usePageAnnotationTools({
    pdfViewerRef,
    dragMode,
    markDirty,
    closeAnnotationContextMenu,
});

const {
    searchQuery,
    results,
    pageMatches,
    currentResultIndex,
    currentResult,
    isSearching,
    totalMatches,
    search,
    goToResult,
    setResultIndex,
    clearSearch,
    searchProgress,
    resetSearchCache,
    isTruncated,
    minQueryLength,
} = usePdfSearch();

const { clearCache: clearOcrCache } = useOcrTextContent();

const {
    openSearch,
    openAnnotations,
    closeSearch,
    handleSearch,
    handleSearchNext,
    handleSearchPrevious,
    handleGoToResult,
} = usePageSearch({
    showSidebar,
    sidebarTab,
    dragMode,
    workingCopyPath,
    totalPages,
    searchQuery,
    search,
    goToResult,
    setResultIndex,
    clearSearch,
});

const {
    handleSave,
    handleSaveAs,
    handleExportDocx,
    handleOcrComplete,
    isAnySaving,
    isExportingDocx,
    canSave,
    updateEmbeddedByRef,
    deleteEmbeddedByRef,
} = usePageSaveOrchestration({
    pdfData,
    pdfDocument,
    pdfViewerRef,
    ocrPopupRef,
    workingCopyPath,
    annotationComments,
    totalPages,
    pageLabelsDirty,
    pageLabelRanges,
    bookmarksDirty,
    bookmarkItems,
    isSaving,
    isSavingAs,
    annotationDirty,
    annotationNoteWindowsCount: computed(() => annotationNoteWindows.value.length),
    hasAnnotationChanges,
    markAnnotationSaved,
    markPageLabelsSaved,
    markBookmarksSaved,
    isDirty,
    saveFile,
    saveWorkingCopy,
    saveWorkingCopyAs,
    persistAllAnnotationNotes: (force: boolean) => persistAllAnnotationNotes(force),
    loadRecentFiles,
    clearOcrCache: (path: string) => clearOcrCache(path),
    loadPdfFromData,
    currentPage,
    waitForPdfReload: (page: number) => waitForPdfReload(page),
});

const isFitWidthActive = computed(() => fitMode.value === 'width' && Math.abs(zoom.value - 1) < 0.01);
const isFitHeightActive = computed(() => fitMode.value === 'height' && Math.abs(zoom.value - 1) < 0.01);
const isAnnotationUndoContext = computed(() =>
    annotationTool.value !== 'none'
    || annotationEditorState.value.hasSomethingToUndo
    || annotationEditorState.value.hasSomethingToRedo,
);
const isAnnotationPanelOpen = computed(() => showSidebar.value && sidebarTab.value === 'annotations');
const annotationCursorMode = computed(() => {
    if (dragMode.value) {
        return false;
    }
    return isAnnotationPanelOpen.value
        || annotationTool.value !== 'none'
        || annotationEditorState.value.hasSelectedEditor;
});
const canUndo = computed(() => (
    isAnnotationUndoContext.value
        ? annotationEditorState.value.hasSomethingToUndo
        : canUndoFile.value
));
const canRedo = computed(() => (
    isAnnotationUndoContext.value
        ? annotationEditorState.value.hasSomethingToRedo
        : canRedoFile.value
));

const {
    waitForPdfReload,
    handleUndo,
    handleRedo,
} = usePdfHistory({
    pdfDocument,
    pdfViewerRef,
    currentPage,
    isAnySaving,
    isHistoryBusy,
    canUndo,
    canRedo,
    isAnnotationUndoContext,
    workingCopyPath,
    resetSearchCache,
    clearOcrCache: (path: string) => clearOcrCache(path),
    undo,
    redo,
});

async function serializeCurrentPdfForEmbeddedFallback() {
    if (!pdfViewerRef.value) {
        return false;
    }
    const rawData = await pdfViewerRef.value.saveDocument();
    if (!rawData) {
        return false;
    }
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);
    await loadPdfFromData(rawData, {
        pushHistory: true,
        persistWorkingCopy: !!workingCopyPath.value,
    });
    await restorePromise;
    return true;
}

const {
    annotationNoteWindows,
    annotationNotePositions,
    sortedAnnotationNoteWindows,
    isAnyAnnotationNoteSaving,
    updateAnnotationNoteText,
    updateAnnotationNotePosition,
    persistAllAnnotationNotes,
    closeAnnotationNote,
    closeAllAnnotationNotes,
    handleOpenAnnotationNote: openAnnotationNoteWindow,
    removeAnnotationNoteWindow,
    setAnnotationNoteWindowError,
    bringAnnotationNoteToFront,
    isSameAnnotationComment,
} = useAnnotationNoteWindows({
    annotationComments,
    markAnnotationDirty,
    updateAnnotationCommentInViewer: (comment, text) => pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false,
    updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
    serializeCurrentPdfForEmbeddedFallback,
    loadPdfFromData,
    workingCopyPath,
    currentPage,
    waitForPdfReload,
});

const {
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
} = usePageAnnotationActions({
    pdfViewerRef,
    annotationTool,
    annotationKeepActive,
    annotationPlacingPageNote,
    annotationSettings,
    annotationActiveCommentStableKey,
    annotationContextMenu,
    showSidebar,
    sidebarTab,
    dragMode,
    currentPage,
    workingCopyPath,
    closeAnnotationContextMenu,
    showAnnotationContextMenu,
    handleAnnotationToolChange,
    openAnnotationNoteWindow,
    removeAnnotationNoteWindow,
    setAnnotationNoteWindowError,
    isSameAnnotationComment,
    annotationNoteWindows,
    deleteEmbeddedByRef,
    loadPdfFromData,
    waitForPdfReload,
});

const {
    statusFilePath,
    statusFileSizeLabel,
    statusZoomLabel,
    statusSaveDotClass,
    statusSaveDotCanSave,
    statusSaveDotTooltip,
    statusSaveDotAriaLabel,
    handleStatusSaveClick,
} = usePageStatusBar({
    t,
    pdfSrc,
    pdfData,
    originalPath,
    workingCopyPath,
    zoom,
    canSave,
    isAnySaving,
    isHistoryBusy,
    handleSave,
});

const {
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
} = usePageOpsHandlers({
    workingCopyPath,
    totalPages,
    sidebarRef,
    pdfViewerRef,
    pageContextMenu,
    closePageContextMenu,
    loadPdfFromData,
    clearOcrCache: (path: string) => clearOcrCache(path),
    resetSearchCache,
});

const {
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist,
    handleCloseFileFromUi,
    openRecentFile,
} = usePageFileOperations({
    pdfSrc,
    isAnySaving,
    isHistoryBusy,
    isExportingDocx,
    isAnyAnnotationNoteSaving,
    annotationNoteWindows,
    annotationDirty,
    isDirty,
    pageLabelsDirty,
    bookmarksDirty,
    hasAnnotationChanges,
    persistAllAnnotationNotes,
    handleSave,
    openFile,
    openFileDirect,
    closeFile,
    closeAllDropdowns,
});

if (typeof window !== 'undefined') {
    window.__openFileDirect = handleOpenFileDirectWithPersist;
}

const {
    setupShortcuts,
    cleanupShortcuts,
} = usePageShortcuts({
    pdfSrc,
    showSettings,
    annotationPlacingPageNote,
    pdfViewerRef,
    sidebarRef,
    shapePropertiesPopoverVisible: computed(() => shapePropertiesPopover.value.visible),
    annotationContextMenuVisible: computed(() => annotationContextMenu.value.visible),
    pageContextMenuVisible: computed(() => pageContextMenu.value.visible),
    closeAnnotationContextMenu,
    closePageContextMenu,
    closeShapeProperties,
    openSearch,
    openAnnotations,
    handleAnnotationToolChange,
});

const {
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    startSidebarResize,
    cleanupSidebarResizeListeners,
} = useSidebarResize({ showSidebar });

function hasAnnotationChanges() {
    if (pdfViewerRef.value?.hasShapes?.value) {
        return true;
    }
    const doc = pdfDocument.value;
    if (!doc) {
        return false;
    }
    try {
        const storage = doc.annotationStorage;
        if (!storage) {
            return false;
        }
        const modifiedIds = storage.modifiedIds?.ids;
        if (modifiedIds && typeof modifiedIds.size === 'number') {
            return modifiedIds.size > 0;
        }
        return false;
    } catch {
        return false;
    }
}

function handleFitMode(mode: TFitMode) {
    zoom.value = 1;
    fitMode.value = mode;
}

function enableDragMode() {
    dragMode.value = true;
    pdfViewerRef.value?.cancelCommentPlacement();
    annotationPlacingPageNote.value = false;
    if (annotationTool.value !== 'none') {
        annotationTool.value = 'none';
    }
}

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

const menuCleanups: Array<() => void> = [];

onMounted(() => {
    console.log('Electron API available:', isElectron.value);

    if (window.electronAPI) {
        menuCleanups.push(
            window.electronAPI.onMenuOpenPdf(() => {
                void handleOpenFileFromUi();
            }),
            window.electronAPI.onMenuSave(() => handleSave()),
            window.electronAPI.onMenuSaveAs(() => handleSaveAs()),
            window.electronAPI.onMenuExportDocx(() => handleExportDocx()),
            window.electronAPI.onMenuUndo(() => handleUndo()),
            window.electronAPI.onMenuRedo(() => handleRedo()),
            window.electronAPI.onMenuZoomIn(() => { zoom.value = Math.min(zoom.value + 0.25, 5); }),
            window.electronAPI.onMenuZoomOut(() => { zoom.value = Math.max(zoom.value - 0.25, 0.25); }),
            window.electronAPI.onMenuActualSize(() => { zoom.value = 1; }),
            window.electronAPI.onMenuFitWidth(() => { handleFitMode('width'); }),
            window.electronAPI.onMenuFitHeight(() => { handleFitMode('height'); }),
            window.electronAPI.onMenuOpenRecentFile((path: string) => {
                void handleOpenFileDirectWithPersist(path);
            }),
            window.electronAPI.onMenuClearRecentFiles(() => {
                clearRecentFiles();
                loadRecentFiles();
            }),
            window.electronAPI.onMenuOpenSettings(() => {
                showSettings.value = true;
            }),
            window.electronAPI.onMenuDeletePages(() => {
                const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
                if (pages.length > 0) void pageOpsDelete(pages, totalPages.value);
            }),
            window.electronAPI.onMenuExtractPages(() => {
                const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
                if (pages.length > 0) void pageOpsExtract(pages);
            }),
            window.electronAPI.onMenuRotateCw(() => {
                const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
                if (pages.length > 0) void handlePageRotate(pages, 90);
            }),
            window.electronAPI.onMenuRotateCcw(() => {
                const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
                if (pages.length > 0) void handlePageRotate(pages, 270);
            }),
            window.electronAPI.onMenuInsertPages(() => {
                void pageOpsInsert(totalPages.value, totalPages.value);
            }),
        );

        loadRecentFiles();
    }

    const storedKeepActive = window.localStorage.getItem(STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE);
    if (storedKeepActive !== null) {
        annotationKeepActive.value = storedKeepActive === '1';
    }

    setupShortcuts();
});

onUnmounted(() => {
    menuCleanups.forEach((cleanup) => cleanup());
    cleanupSidebarResizeListeners();
    cleanupShortcuts();
});

watch(pdfError, (err) => {
    if (err) {
        console.error('PDF Error:', err);
    }
});

watch(annotationKeepActive, (value) => {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE, value ? '1' : '0');
});

watch(
    () => [
        showSidebar.value,
        sidebarTab.value,
    ] as const,
    ([
        isOpen,
        tab,
    ]) => {
        if (!isOpen || tab !== 'bookmarks') {
            bookmarkEditMode.value = false;
        }
    },
);

watch(dragMode, (enabled) => {
    if (enabled) {
        window.getSelection()?.removeAllRanges();
        if (annotationTool.value !== 'none') {
            annotationTool.value = 'none';
        }
        pdfViewerRef.value?.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
    }
});

watch(pdfSrc, (newSrc, oldSrc) => {
    if (newSrc && newSrc !== oldSrc) {
        resetAnnotationTracking();
        annotationComments.value = [];
        bookmarkItems.value = [];
        bookmarksDirty.value = false;
        bookmarkEditMode.value = false;
        closeAnnotationContextMenu();
        closePageContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    }
    if (!newSrc) {
        resetSearchCache();
        closeSearch();
        annotationTool.value = 'none';
        annotationComments.value = [];
        annotationActiveCommentStableKey.value = null;
        pageLabels.value = null;
        pageLabelRanges.value = [];
        pageLabelsDirty.value = false;
        bookmarkItems.value = [];
        bookmarksDirty.value = false;
        bookmarkEditMode.value = false;
        pdfViewerRef.value?.clearShapes();
        closeAnnotationContextMenu();
        closePageContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
        resetAnnotationTracking();
        annotationEditorState.value = {
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        };
    }

    if (newSrc && !oldSrc) {
        loadRecentFiles();
    }
});

watch(workingCopyPath, (nextPath, previousPath) => {
    if (nextPath === previousPath) {
        return;
    }
    annotationActiveCommentStableKey.value = null;
    closeAnnotationContextMenu();
    void closeAllAnnotationNotes({ saveIfDirty: false });
});

watch(annotationComments, (comments) => {
    if (
        annotationActiveCommentStableKey.value
        && !comments.some(comment => comment.stableKey === annotationActiveCommentStableKey.value)
    ) {
        annotationActiveCommentStableKey.value = null;
    }
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
