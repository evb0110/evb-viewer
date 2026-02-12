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
                    @page-rotate-cw="(pages) => pageOpsRotate(pages, 90)"
                    @page-rotate-ccw="(pages) => pageOpsRotate(pages, 270)"
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
    nextTick,
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
    IAnnotationEditorState,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';
import { STORAGE_KEYS } from '@app/constants/storage-keys';
import { formatBytes } from '@app/utils/formatters';
import { waitUntilIdle } from '@app/utils/async-helpers';
import { useSidebarResize } from '@app/composables/useSidebarResize';
import { useAnnotationContextMenu } from '@app/composables/pdf/useAnnotationContextMenu';
import { usePageContextMenu } from '@app/composables/pdf/usePageContextMenu';
import { usePageOperations } from '@app/composables/pdf/usePageOperations';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';
import { rewriteBookmarks } from '@app/composables/pdf/usePdfBookmarkSerialization';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';
import { useDropdownManager } from '@app/composables/useDropdownManager';
import { usePdfHistory } from '@app/composables/usePdfHistory';
import { useFileOperations } from '@app/composables/useFileOperations';


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

async function openRecentFile(file: { originalPath: string }) {
    await handleOpenFileDirectWithPersist(file.originalPath);
}

async function waitUntilAllIdle() {
    await waitUntilIdle(() =>
        isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value,
    );
}

async function ensureCurrentDocumentPersistedBeforeSwitch() {
    if (!pdfSrc.value) {
        return true;
    }

    await waitUntilAllIdle();
    if (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value) {
        return false;
    }

    if (annotationNoteWindows.value.length > 0) {
        const savedAllNotes = await persistAllAnnotationNotes(true);
        if (!savedAllNotes) {
            return false;
        }
    }

    const hasPendingChanges = (
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pageLabelsDirty.value
        || bookmarksDirty.value
    );
    if (!hasPendingChanges) {
        return true;
    }

    await handleSave();

    return !(
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pageLabelsDirty.value
        || bookmarksDirty.value
    );
}

async function handleOpenFileFromUi() {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await openFile();
    closeAllDropdowns();
}

async function handleOpenFileDirectWithPersist(path: string) {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await openFileDirect(path);
    closeAllDropdowns();
}

async function handleCloseFileFromUi() {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await closeFile();
    closeAllDropdowns();
}

// Expose for testing
if (typeof window !== 'undefined') {
    window.__openFileDirect = handleOpenFileDirectWithPersist;
}

const menuCleanups: Array<() => void> = [];

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    return Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
}

function handleGlobalShortcut(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        closeAnnotationContextMenu();
        closePageContextMenu();
        closeShapeProperties();
        pdfViewerRef.value?.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        showSettings.value = true;
        return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && pdfSrc.value) {
        event.preventDefault();
        openSearch();
        nextTick(() => sidebarRef.value?.focusSearch());
        return;
    }

    if (!pdfSrc.value) {
        return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
    }

    const key = event.key.toLowerCase();
    switch (key) {
        case 'v':
            handleAnnotationToolChange('none');
            return;
        case 'h':
            openAnnotations();
            handleAnnotationToolChange('highlight');
            return;
        case 'u':
            openAnnotations();
            handleAnnotationToolChange('underline');
            return;
        case 's':
            openAnnotations();
            handleAnnotationToolChange('strikethrough');
            return;
        case 'i':
            openAnnotations();
            handleAnnotationToolChange('draw');
            return;
        case 't':
            openAnnotations();
            handleAnnotationToolChange('text');
            return;
        case 'r':
            openAnnotations();
            handleAnnotationToolChange('rectangle');
            return;
        case 'c':
            openAnnotations();
            handleAnnotationToolChange('circle');
            return;
        case 'l':
            openAnnotations();
            handleAnnotationToolChange('line');
            return;
        case 'a':
            openAnnotations();
            handleAnnotationToolChange('arrow');
            return;
        case 'escape':
            handleAnnotationToolChange('none');
            return;
        case 'delete':
        case 'backspace':
            pdfViewerRef.value?.deleteSelectedShape();
            return;
        default:
            return;
    }
}

function handleGlobalPointerDown(event: PointerEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;

    if (shapePropertiesPopover.value.visible) {
        if (!target?.closest('.annotation-properties')) {
            closeShapeProperties();
        }
    }

    if (annotationContextMenu.value.visible) {
        if (!target?.closest('.annotation-context-menu')) {
            closeAnnotationContextMenu();
        }
    }

    if (pageContextMenu.value.visible) {
        if (!target?.closest('.page-context-menu')) {
            closePageContextMenu();
        }
    }
}

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
                if (pages.length > 0) void pageOpsRotate(pages, 90);
            }),
            window.electronAPI.onMenuRotateCcw(() => {
                const pages = sidebarRef.value?.selectedThumbnailPages ?? [];
                if (pages.length > 0) void pageOpsRotate(pages, 270);
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

    window.addEventListener('keydown', handleGlobalShortcut);
    window.addEventListener('pointerdown', handleGlobalPointerDown);
});

onUnmounted(() => {
    menuCleanups.forEach((cleanup) => cleanup());
    cleanupSidebarResizeListeners();
    window.removeEventListener('keydown', handleGlobalShortcut);
    window.removeEventListener('pointerdown', handleGlobalPointerDown);
});

watch(pdfError, (err) => {
    if (err) {
        console.error('PDF Error:', err);
    }
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

const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
const zoomDropdownRef = ref<{ close: () => void } | null>(null);
const pageDropdownRef = ref<{ close: () => void } | null>(null);
const ocrPopupRef = ref<IOcrPopupExpose | null>(null);
const overflowMenuRef = ref<{ close: () => void } | null>(null);
const sidebarRef = ref<{
    focusSearch: () => void | Promise<void>;
    selectAllPages: () => void;
    invertPageSelection: () => void;
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
const annotationTool = ref<TAnnotationTool>('none');
const annotationKeepActive = ref(true);
const annotationPlacingPageNote = ref(false);
const annotationSettings = ref<IAnnotationSettings>({ ...DEFAULT_ANNOTATION_SETTINGS });
const annotationComments = ref<IAnnotationCommentSummary[]>([]);
const annotationActiveCommentStableKey = ref<string | null>(null);
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
const annotationEditorState = ref<IAnnotationEditorState>({
    isEditing: false,
    isEmpty: true,
    hasSomethingToUndo: false,
    hasSomethingToRedo: false,
    hasSelectedEditor: false,
});
const { settings: appSettings } = useSettings();
const showSidebar = ref(false);
const showSettings = ref(false);
const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
const isSaving = ref(false);
const isSavingAs = ref(false);
const isHistoryBusy = ref(false);
const annotationRevision = ref(0);
const annotationSavedRevision = ref(0);
const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
const isExportingDocx = computed(() => ocrPopupRef.value?.isExporting?.value ?? false);
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
const annotationDirty = computed(() => annotationRevision.value !== annotationSavedRevision.value);
const canSave = computed(() => isDirty.value || annotationDirty.value || pageLabelsDirty.value || bookmarksDirty.value);
const shapePropertiesPopover = ref<{
    visible: boolean;
    x: number;
    y: number;
}>({
    visible: false,
    x: 0,
    y: 0,
});

const selectedShapeForProperties = computed(() =>
    shapePropertiesPopover.value.visible
        ? pdfViewerRef.value?.getSelectedShape() ?? null
        : null,
);

const statusFilePath = computed(() => originalPath.value ?? workingCopyPath.value ?? t('status.noFileOpen'));
const statusFileSizeBytes = computed(() => {
    if (pdfData.value) {
        return pdfData.value.byteLength;
    }
    if (pdfSrc.value && typeof pdfSrc.value === 'object' && 'kind' in pdfSrc.value && pdfSrc.value.kind === 'path') {
        return pdfSrc.value.size;
    }
    return null;
});
const statusFileSizeLabel = computed(() => {
    if (statusFileSizeBytes.value === null) {
        return 'Size: -';
    }
    return `Size: ${formatBytes(statusFileSizeBytes.value)}`;
});
const statusZoomLabel = computed(() => `Zoom: ${Math.round(zoom.value * 100)}%`);
const statusSaveDotState = computed(() => {
    if (!pdfSrc.value) {
        return 'idle';
    }
    if (isAnySaving.value) {
        return 'saving';
    }
    if (canSave.value) {
        return 'dirty';
    }
    return 'clean';
});
const statusSaveDotClass = computed(() => `is-${statusSaveDotState.value}`);
const statusSaveDotCanSave = computed(() => (
    !!pdfSrc.value
    && canSave.value
    && !isAnySaving.value
    && !isHistoryBusy.value
));
const statusSaveDotTooltip = computed(() => {
    if (statusSaveDotState.value === 'idle') {
        return t('status.noFileOpen');
    }
    if (statusSaveDotState.value === 'saving') {
        return t('status.savingChanges');
    }
    if (statusSaveDotState.value === 'dirty') {
        return t('status.unsavedChanges');
    }
    return t('status.allSaved');
});
const statusSaveDotAriaLabel = computed(() => {
    if (statusSaveDotState.value === 'dirty') {
        return t('status.saveChanges');
    }
    if (statusSaveDotState.value === 'saving') {
        return t('status.savingChanges');
    }
    if (statusSaveDotState.value === 'clean') {
        return t('status.allSaved');
    }
    return t('status.noFileOpen');
});

async function handleStatusSaveClick() {
    if (!statusSaveDotCanSave.value) {
        return;
    }
    await handleSave();
}


watch(annotationKeepActive, (value) => {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE, value ? '1' : '0');
});

const {
    sidebarWidth,
    sidebarWrapperStyle,
    isResizingSidebar,
    startSidebarResize,
    cleanupSidebarResizeListeners,
} = useSidebarResize({ showSidebar });

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


async function handleOcrComplete(ocrPdfData: Uint8Array) {
    // Remember current page before reload
    const pageToRestore = currentPage.value;

    // M4.1: Clear OCR manifest cache so new OCR data is loaded
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }

    const restorePromise = waitForPdfReload(pageToRestore);

    // Persist OCR changes to the working copy so subsequent operations (OCR/search)
    // don't accidentally operate on an older on-disk version.
    await loadPdfFromData(ocrPdfData, {
        pushHistory: true,
        persistWorkingCopy: !!workingCopyPath.value,
    });

    await restorePromise;
}

async function handleExportDocx() {
    if (!ocrPopupRef.value) {
        return;
    }
    const result = await ocrPopupRef.value.exportDocx();
    if (result === false) {
        ocrPopupRef.value.open();
    }
}


function openSearch() {
    showSidebar.value = true;
    sidebarTab.value = 'search';
}

function openAnnotations() {
    if (showSidebar.value && sidebarTab.value === 'annotations') {
        showSidebar.value = false;
        return;
    }
    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
}

function closeSearch() {
    clearSearch();
    sidebarTab.value = 'thumbnails';
}

function handleAnnotationToolChange(tool: TAnnotationTool) {
    annotationTool.value = tool;
    // Sidebar tools should always return to text-selection interaction,
    // while hand-pan remains an explicit, separate toolbar mode.
    dragMode.value = false;
    pdfViewerRef.value?.cancelCommentPlacement();
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationToolAutoReset() {
    if (annotationKeepActive.value) {
        return;
    }
    annotationTool.value = 'none';
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationToolCancel() {
    annotationTool.value = 'none';
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationSettingChange(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings] 
}) {
    annotationSettings.value = {
        ...annotationSettings.value,
        [payload.key]: payload.value,
    };

    const selectedShapeId = pdfViewerRef.value?.selectedShapeId?.value;
    if (!selectedShapeId) {
        return;
    }

    if (payload.key === 'shapeColor') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { color: String(payload.value) });
        return;
    }

    if (payload.key === 'shapeStrokeWidth') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { strokeWidth: Number(payload.value) });
        return;
    }

    if (payload.key === 'shapeOpacity') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { opacity: Number(payload.value) });
        return;
    }

    if (payload.key === 'shapeFillColor') {
        const fill = String(payload.value);
        pdfViewerRef.value?.updateShape(selectedShapeId, {fillColor: fill === 'transparent' ? undefined : fill});
    }
}

function handleAnnotationState(state: IAnnotationEditorState) {
    const hadUndo = annotationEditorState.value.hasSomethingToUndo;
    annotationEditorState.value = {
        ...annotationEditorState.value,
        ...state,
    };
    if (!hadUndo && annotationEditorState.value.hasSomethingToUndo) {
        markAnnotationDirty();
    }
}

function handleAnnotationModified() {
    markAnnotationDirty();
}

function markAnnotationDirty() {
    annotationRevision.value += 1;
    markDirty();
}

function markAnnotationSaved() {
    annotationSavedRevision.value = annotationRevision.value;
}

function resetAnnotationTracking() {
    annotationRevision.value = 0;
    annotationSavedRevision.value = 0;
}

const {
    rewriteMarkupSubtypes,
    serializeShapeAnnotations,
    updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
    deleteEmbeddedAnnotationByRef: deleteEmbeddedByRef,
    rewritePageLabels,
} = usePdfSerialization({
    pdfData,
    workingCopyPath,
    annotationComments,
    totalPages,
    pageLabelsDirty,
    pageLabelRanges,
    getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
    getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
});

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
    handleSave,
    handleSaveAs,
} = useFileOperations({
    isSaving,
    isSavingAs,
    workingCopyPath,
    annotationDirty,
    pageLabelsDirty,
    bookmarksDirty,
    pdfDocument,
    saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
    saveFile,
    saveWorkingCopy,
    saveWorkingCopyAs,
    markAnnotationSaved,
    markPageLabelsSaved,
    markBookmarksSaved,
    hasAnnotationChanges,
    rewriteMarkupSubtypes,
    serializeShapeAnnotations,
    rewritePageLabels,
    rewriteBookmarks: (data) => rewriteBookmarks(data, {
        bookmarksDirty,
        bookmarkItems,
        totalPages,
    }),
    persistAllAnnotationNotes,
    annotationNoteWindowsCount: computed(() => annotationNoteWindows.value.length),
    loadRecentFiles,
});

const {
    isOperationInProgress: isPageOperationInProgress,
    deletePages: pageOpsDelete,
    extractPages: pageOpsExtract,
    rotatePages: pageOpsRotate,
    insertPages: pageOpsInsert,
    insertFile: pageOpsInsertFile,
    reorderPages: pageOpsReorder,
} = usePageOperations({
    workingCopyPath,
    currentPage,
    loadPdfFromData,
    waitForPdfReload,
    clearOcrCache: (path: string) => clearOcrCache(path),
    resetSearchCache,
});

function handlePageContextMenuDelete() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsDelete(pages, totalPages.value);
}

function handlePageContextMenuExtract() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsExtract(pages);
}

function handlePageContextMenuRotateCw() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsRotate(pages, 90);
}

function handlePageContextMenuRotateCcw() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsRotate(pages, 270);
}

function handlePageContextMenuInsertBefore() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsInsert(totalPages.value, Math.min(...pages) - 1);
}

function handlePageContextMenuInsertAfter() {
    const pages = pageContextMenu.value.pages;
    closePageContextMenu();
    void pageOpsInsert(totalPages.value, Math.max(...pages));
}

function handlePageFileDrop(payload: {
    afterPage: number;
    filePath: string 
}) {
    void pageOpsInsertFile(totalPages.value, payload.afterPage, payload.filePath);
}

function handlePageContextMenuSelectAll() {
    closePageContextMenu();
    sidebarRef.value?.selectAllPages();
}

function handlePageContextMenuInvertSelection() {
    closePageContextMenu();
    sidebarRef.value?.invertPageSelection();
}

async function handleCommentSelection() {
    if (!pdfViewerRef.value) {
        return;
    }
    await pdfViewerRef.value.commentSelection();
}

function handleStartPlaceNote() {
    if (!pdfViewerRef.value) {
        return;
    }

    if (annotationPlacingPageNote.value) {
        pdfViewerRef.value.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
        return;
    }

    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
    annotationTool.value = 'none';
    pdfViewerRef.value.startCommentPlacement();
    annotationPlacingPageNote.value = true;
}

async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
    if (!pdfViewerRef.value) {
        return;
    }
    annotationActiveCommentStableKey.value = comment.stableKey;
    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
    await pdfViewerRef.value.focusAnnotationComment(comment);
}

function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
    annotationActiveCommentStableKey.value = comment.stableKey;
    dragMode.value = false;
}

function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    annotationActiveCommentStableKey.value = comment.stableKey;
    openAnnotationNoteWindow(comment);
    dragMode.value = false;
}

function closeShapeProperties() {
    shapePropertiesPopover.value = {
        visible: false,
        x: 0,
        y: 0, 
    };
}

function handleShapePropertyUpdate(updates: Partial<IShapeAnnotation>) {
    const id = pdfViewerRef.value?.selectedShapeId?.value;
    if (!id) {
        return;
    }

    const nextSettings: IAnnotationSettings = {...annotationSettings.value};
    let didUpdateDefaults = false;
    if (typeof updates.color === 'string' && updates.color.trim()) {
        nextSettings.shapeColor = updates.color;
        didUpdateDefaults = true;
    }
    if (typeof updates.strokeWidth === 'number' && Number.isFinite(updates.strokeWidth)) {
        nextSettings.shapeStrokeWidth = updates.strokeWidth;
        didUpdateDefaults = true;
    }
    if (typeof updates.opacity === 'number' && Number.isFinite(updates.opacity)) {
        nextSettings.shapeOpacity = updates.opacity;
        didUpdateDefaults = true;
    }
    if ('fillColor' in updates) {
        const fill = updates.fillColor ?? 'transparent';
        nextSettings.shapeFillColor = fill;
        didUpdateDefaults = true;
    }
    if (didUpdateDefaults) {
        annotationSettings.value = nextSettings;
    }

    pdfViewerRef.value?.updateShape(id, updates);
}

function handleShapeContextMenu(payload: {
    shapeId: string;
    clientX: number;
    clientY: number;
}) {
    closeAnnotationContextMenu();
    const popoverWidth = 260;
    const popoverHeight = 200;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - popoverWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - popoverHeight - margin);

    shapePropertiesPopover.value = {
        visible: true,
        x: Math.min(Math.max(margin, payload.clientX), maxX),
        y: Math.min(Math.max(margin, payload.clientY), maxY),
    };
}

function handleViewerAnnotationContextMenu(payload: {
    comment: IAnnotationCommentSummary | null;
    clientX: number;
    clientY: number;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}) {
    if (payload.comment) {
        annotationActiveCommentStableKey.value = payload.comment.stableKey;
    } else {
        annotationActiveCommentStableKey.value = null;
    }

    showAnnotationContextMenu(payload);
}

function openContextMenuNote() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    handleOpenAnnotationNote(comment);
    closeAnnotationContextMenu();
}

function copyContextMenuNoteText() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    void handleCopyAnnotationComment(comment);
    closeAnnotationContextMenu();
}

function deleteContextMenuComment() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    void handleDeleteAnnotationComment(comment);
    closeAnnotationContextMenu();
}

async function createContextMenuFreeNote() {
    if (!pdfViewerRef.value) {
        closeAnnotationContextMenu();
        return;
    }

    const {
        pageNumber,
        pageX,
        pageY,
    } = annotationContextMenu.value;
    if (
        !Number.isFinite(pageNumber)
        || !Number.isFinite(pageX)
        || !Number.isFinite(pageY)
    ) {
        closeAnnotationContextMenu();
        return;
    }

    await pdfViewerRef.value.commentAtPoint(
        pageNumber as number,
        pageX as number,
        pageY as number,
        { preferTextAnchor: false },
    );
    closeAnnotationContextMenu();
}

async function createContextMenuSelectionNote() {
    await pdfViewerRef.value?.commentSelection();
    closeAnnotationContextMenu();
}

async function createContextMenuMarkup(tool: TAnnotationTool) {
    if (!pdfViewerRef.value) {
        closeAnnotationContextMenu();
        return;
    }
    handleAnnotationToolChange(tool);
    await nextTick();
    await pdfViewerRef.value.highlightSelection();
    if (!annotationKeepActive.value) {
        annotationTool.value = 'none';
    }
    closeAnnotationContextMenu();
}


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


async function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    const text = comment.text?.trim();
    if (!text) {
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // Ignore clipboard errors in non-secure contexts.
    }
}

let annotationDeleteQueue: Promise<void> = Promise.resolve();

async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    if (!pdfViewerRef.value) {
        return;
    }
    setAnnotationNoteWindowError(comment.stableKey, null);
    let deleted = await pdfViewerRef.value.deleteAnnotationComment(comment);
    if (!deleted) {
        const result = await deleteEmbeddedByRef(comment);
        if (result instanceof Uint8Array) {
            const pageToRestore = currentPage.value;
            const restorePromise = waitForPdfReload(pageToRestore);
            await loadPdfFromData(result, {
                pushHistory: true,
                persistWorkingCopy: !!workingCopyPath.value,
            });
            await restorePromise;
            deleted = true;
        }
    }
    if (!deleted) {
        const materialized = await serializeCurrentPdfForEmbeddedFallback();
        if (materialized) {
            const result = await deleteEmbeddedByRef(comment);
            if (result instanceof Uint8Array) {
                const pageToRestore = currentPage.value;
                const restorePromise = waitForPdfReload(pageToRestore);
                await loadPdfFromData(result, {
                    pushHistory: true,
                    persistWorkingCopy: !!workingCopyPath.value,
                });
                await restorePromise;
                deleted = true;
            }
        }
    }
    if (!deleted) {
        setAnnotationNoteWindowError(comment.stableKey, 'Unable to delete this annotation from the current document.');
        return;
    }
    annotationNoteWindows.value
        .filter(note => isSameAnnotationComment(note.comment, comment))
        .forEach(note => removeAnnotationNoteWindow(note.comment.stableKey));
}

async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
    annotationDeleteQueue = annotationDeleteQueue
        .catch(() => undefined)
        .then(async () => {
            await performDeleteAnnotationComment(comment);
        });
    await annotationDeleteQueue;
}

async function handleSearch() {
    if (workingCopyPath.value) {
        showSidebar.value = true;
        sidebarTab.value = 'search';
        await search(
            searchQuery.value,
            workingCopyPath.value,
            totalPages.value > 0 ? totalPages.value : undefined,
        );
    }
}

function handleSearchNext() {
    goToResult('next');
}

function handleSearchPrevious() {
    goToResult('previous');
}

function handleGoToResult(index: number) {
    setResultIndex(index);
}

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

    // Refresh recent files list after opening a file
    // This ensures the list is up-to-date when user closes the file and returns to empty state
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
