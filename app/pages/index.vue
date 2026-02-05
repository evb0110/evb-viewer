<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
        <!-- Toolbar -->
        <header class="toolbar">
            <UTooltip v-if="!pdfSrc" text="Open PDF" :delay-duration="1200">
                <UButton
                    icon="i-lucide-folder-open"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    aria-label="Open PDF"
                    @click="openFile(); closeAllDropdowns()"
                />
            </UTooltip>

            <template v-if="pdfSrc">
                <!-- Left section: File & view controls -->
                <div class="toolbar-section">
                    <UTooltip text="Save" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canSave || isAnySaving || isHistoryBusy"
                            :loading="isSaving"
                            aria-label="Save"
                            @click="handleSave(); closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Save As…" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save-all"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!pdfSrc || isAnySaving || isHistoryBusy"
                            :loading="isSavingAs"
                            aria-label="Save As"
                            @click="handleSaveAs(); closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Export DOCX" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-file-text"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!workingCopyPath || isAnySaving || isHistoryBusy || isExportingDocx"
                            :loading="isExportingDocx"
                            aria-label="Export DOCX"
                            @click="handleExportDocx(); closeAllDropdowns()"
                        />
                    </UTooltip>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Undo" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-undo-2"
                                    variant="ghost"
                                    color="neutral"
                                    class="toolbar-group-button"
                                    :disabled="!canUndo || isHistoryBusy || isAnySaving"
                                    aria-label="Undo"
                                    @click="handleUndo(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Redo" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-redo-2"
                                    variant="ghost"
                                    color="neutral"
                                    class="toolbar-group-button"
                                    :disabled="!canRedo || isHistoryBusy || isAnySaving"
                                    aria-label="Redo"
                                    @click="handleRedo(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                    <UTooltip text="Toggle Sidebar" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-panel-left"
                            :variant="showSidebar ? 'soft' : 'ghost'"
                            :color="showSidebar ? 'primary' : 'neutral'"
                            class="toolbar-icon-button"
                            aria-label="Toggle sidebar"
                            @click="showSidebar = !showSidebar; closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Annotations" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-pen-tool"
                            :variant="isAnnotationPanelOpen ? 'soft' : 'ghost'"
                            :color="isAnnotationPanelOpen ? 'primary' : 'neutral'"
                            class="toolbar-icon-button"
                            aria-label="Annotations"
                            @click="openAnnotations(); closeAllDropdowns()"
                        />
                    </UTooltip>
                </div>

                <!-- Spacer to push center -->
                <div class="flex-1" />

                <!-- Center section: Document controls -->
                <div class="toolbar-section toolbar-center">
                    <OcrPopup
                        ref="ocrPopupRef"
                        :pdf-document="pdfDocument"
                        :pdf-data="pdfData"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        @open="closeOtherDropdowns('ocr')"
                        @ocr-complete="handleOcrComplete"
                    />

                    <div class="toolbar-inline-group">
                        <PdfZoomDropdown
                            ref="zoomDropdownRef"
                            v-model:zoom="zoom"
                            v-model:fit-mode="fitMode"
                            @open="pageDropdownRef?.close()"
                        />
                    </div>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Fit Width" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-move-horizontal"
                                    :variant="isFitWidthActive ? 'soft' : 'ghost'"
                                    :color="isFitWidthActive ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Fit width"
                                    @click="handleFitMode('width'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Fit Height" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-move-vertical"
                                    :variant="isFitHeightActive ? 'soft' : 'ghost'"
                                    :color="isFitHeightActive ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Fit height"
                                    @click="handleFitMode('height'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Continuous Scroll" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-scroll"
                                    :variant="continuousScroll ? 'soft' : 'ghost'"
                                    :color="continuousScroll ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Continuous scroll"
                                    @click="continuousScroll = !continuousScroll; closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                    <div class="toolbar-inline-group">
                        <PdfPageDropdown
                            ref="pageDropdownRef"
                            v-model="currentPage"
                            :total-pages="totalPages"
                            @go-to-page="handleGoToPage"
                            @open="zoomDropdownRef?.close()"
                        />
                    </div>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Hand Tool" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-hand"
                                    :variant="dragMode ? 'soft' : 'ghost'"
                                    :color="dragMode ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Hand tool"
                                    @click="enableDragMode(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Text Select" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-text-cursor"
                                    :variant="!dragMode ? 'soft' : 'ghost'"
                                    :color="!dragMode ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Text select"
                                    @click="dragMode = false; closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>
                </div>

                <!-- Spacer to push right section -->
                <div class="flex-1" />

                <!-- Right section: Window control -->
                <div class="toolbar-section">
                    <UTooltip text="Close File" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-x"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            aria-label="Close file"
                            @click="closeFile(); closeAllDropdowns()"
                        />
                    </UTooltip>
                </div>
            </template>
        </header>

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
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :total-matches="totalMatches"
                    :is-searching="isSearching"
                    :search-progress="searchProgress"
                    :is-truncated="isTruncated"
                    :min-query-length="minQueryLength"
                    :width="sidebarWidth"
                    :annotation-tool="annotationTool"
                    :annotation-settings="annotationSettings"
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @annotation-setting="handleAnnotationSettingChange"
                    @annotation-highlight-selection="handleHighlightSelection"
                    @annotation-comment-selection="handleCommentSelection"
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
                    :annotation-settings="annotationSettings"
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    :working-copy-path="workingCopyPath"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @update:document="pdfDocument = $event"
                    @loading="isLoading = $event"
                    @annotation-state="handleAnnotationState"
                    @annotation-modified="handleAnnotationModified"
                />
                <div
                    v-else
                    class="empty-state"
                >
                    <!-- Recent Files (primary focus for returning users) -->
                    <div
                        v-if="recentFiles.length > 0"
                        class="recent-files"
                    >
                        <div class="recent-files-header">
                            <h3 class="text-sm font-medium text-neutral-600 dark:text-neutral-400">
                                Recent Files
                            </h3>
                            <UTooltip text="Clear Recent Files" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-trash-2"
                                    variant="ghost"
                                    size="xs"
                                    color="neutral"
                                    class="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                                    aria-label="Clear recent files"
                                    @click="clearRecentFiles"
                                />
                            </UTooltip>
                        </div>
                        <ul class="recent-files-list">
                            <li
                                v-for="file in recentFiles"
                                :key="file.originalPath"
                                class="recent-file-item"
                                @click="openRecentFile(file)"
                            >
                                <UIcon
                                    name="i-lucide-file-text"
                                    class="size-5 text-neutral-400 flex-shrink-0"
                                />
                                <div class="recent-file-info">
                                    <span class="recent-file-name">{{ file.fileName }}</span>
                                    <span class="recent-file-path">{{ getParentFolder(file.originalPath) }}</span>
                                </div>
                                <span class="recent-file-time">{{ formatRelativeTime(file.timestamp) }}</span>
                                <UTooltip text="Remove from Recent" :delay-duration="1200">
                                    <UButton
                                        icon="i-lucide-x"
                                        size="xs"
                                        variant="ghost"
                                        color="neutral"
                                        class="recent-file-remove"
                                        aria-label="Remove recent file"
                                        @click.stop="removeRecentFile(file)"
                                    />
                                </UTooltip>
                            </li>
                        </ul>
                    </div>

                    <!-- Open file action (clickable) -->
                    <p class="empty-state-hint text-sm text-neutral-500 dark:text-neutral-400">
                        {{ recentFiles.length > 0 ? 'Or open another file...' : 'Open a PDF file' }}
                    </p>
                    <UTooltip text="Open PDF" :delay-duration="1200">
                        <button
                            class="open-file-action group"
                            aria-label="Open PDF"
                            @click="openFile"
                        >
                            <UIcon
                                name="i-lucide-folder-open"
                                class="size-8 text-neutral-400 group-hover:text-primary-500 transition-colors"
                            />
                        </button>
                    </UTooltip>
                </div>
            </div>
        </main>
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
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TFitMode } from '@app/types/shared';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type {
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';


type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'outline' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    saveDocument: () => Promise<Uint8Array | null>;
    highlightSelection: () => void;
    commentSelection: () => void;
    undoAnnotation: () => void;
    redoAnnotation: () => void;
}

interface IOcrPopupExpose {
    close: () => void;
    open: () => void;
    exportDocx: () => Promise<boolean>;
    isExporting: { value: boolean };
}

const {
    pdfSrc,
    pdfData,
    workingCopyPath,
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
    await openFileDirect(file.originalPath);
}

function formatRelativeTime(timestamp: number) {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return days === 1 ? 'Yesterday' : `${days} days ago`;
    }
    if (hours > 0) {
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }
    if (minutes > 0) {
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    }
    return 'Just now';
}

function getParentFolder(filePath: string) {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename
    // Show last 2 folder segments for context, or full path if shorter
    const folderParts = parts.slice(-2);
    return folderParts.join('/');
}

// Expose for testing
if (typeof window !== 'undefined') {
    (window as unknown as { __openFileDirect: typeof openFileDirect }).__openFileDirect = openFileDirect;
}

const menuCleanups: Array<() => void> = [];

function handleFindShortcut(event: KeyboardEvent) {
    if (!pdfSrc.value) {
        return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
        nextTick(() => sidebarRef.value?.focusSearch());
    }
}

onMounted(() => {
    console.log('Electron API available:', isElectron.value);

    if (window.electronAPI) {
        menuCleanups.push(
            window.electronAPI.onMenuOpenPdf(() => openFile()),
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
            window.electronAPI.onMenuOpenRecentFile((path: string) => openFileDirect(path)),
            window.electronAPI.onMenuClearRecentFiles(() => {
                clearRecentFiles();
                loadRecentFiles();
            }),
        );

        loadRecentFiles();
    }

    window.addEventListener('keydown', handleFindShortcut);
});

onUnmounted(() => {
    menuCleanups.forEach((cleanup) => cleanup());
    cleanupSidebarResizeListeners();
    window.removeEventListener('keydown', handleFindShortcut);
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
const sidebarRef = ref<{ focusSearch: () => void | Promise<void> } | null>(null);

function closeAllDropdowns() {
    zoomDropdownRef.value?.close();
    pageDropdownRef.value?.close();
    ocrPopupRef.value?.close();
}

function closeOtherDropdowns(except: 'zoom' | 'page' | 'ocr') {
    if (except !== 'zoom') zoomDropdownRef.value?.close();
    if (except !== 'page') pageDropdownRef.value?.close();
    if (except !== 'ocr') ocrPopupRef.value?.close();
}

const zoom = ref(1);
const fitMode = ref<TFitMode>('width');
const currentPage = ref(1);
const totalPages = ref(0);
const isLoading = ref(false);
const dragMode = ref(true);
const continuousScroll = ref(true);
const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
const annotationTool = ref<TAnnotationTool>('none');
const annotationSettings = ref<IAnnotationSettings>({
    highlightColor: '#ffd400',
    highlightOpacity: 0.35,
    highlightFree: true,
    inkColor: '#e11d48',
    inkOpacity: 0.9,
    inkThickness: 2,
    textColor: '#111827',
    textSize: 12,
});
const annotationEditorState = ref<IAnnotationEditorState>({
    isEditing: false,
    isEmpty: true,
    hasSomethingToUndo: false,
    hasSomethingToRedo: false,
    hasSelectedEditor: false,
});
const showSidebar = ref(false);
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
const canSave = computed(() => isDirty.value || annotationDirty.value);

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_COLLAPSE_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZER_WIDTH = 8;

const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const lastOpenSidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const isResizingSidebar = ref(false);

let resizeStartX = 0;
let resizeStartWidth = 0;

const sidebarWrapperStyle = computed(() => ({
    width: `${sidebarWidth.value + SIDEBAR_RESIZER_WIDTH}px`,
    minWidth: `${sidebarWidth.value + SIDEBAR_RESIZER_WIDTH}px`,
}));

watch(showSidebar, (isOpen) => {
    if (isOpen) {
        const width = Math.min(
            Math.max(lastOpenSidebarWidth.value, SIDEBAR_DEFAULT_WIDTH),
            SIDEBAR_MAX_WIDTH,
        );
        sidebarWidth.value = width;
        lastOpenSidebarWidth.value = width;
        return;
    }

    stopSidebarResize();
});

watch(dragMode, (enabled) => {
    if (enabled) {
        window.getSelection()?.removeAllRanges();
        if (annotationTool.value !== 'none') {
            annotationTool.value = 'none';
        }
    }
});

function enableDragMode() {
    dragMode.value = true;
    if (annotationTool.value !== 'none') {
        annotationTool.value = 'none';
    }
}

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

function waitForPdfReload(pageToRestore: number) {
    return new Promise<void>((resolve) => {
        const unwatch = watch(pdfDocument, (doc) => {
            if (doc) {
                unwatch();
                resetSearchCache();
                void nextTick(() => {
                    pdfViewerRef.value?.scrollToPage(pageToRestore);
                    resolve();
                });
            }
        });
    });
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

function cleanupSidebarResizeListeners() {
    window.removeEventListener('pointermove', handleSidebarResize);
    window.removeEventListener('pointerup', stopSidebarResize);
    window.removeEventListener('pointercancel', stopSidebarResize);
}

function startSidebarResize(event: PointerEvent) {
    if (!showSidebar.value) {
        return;
    }

    event.preventDefault();

    isResizingSidebar.value = true;
    resizeStartX = event.clientX;
    resizeStartWidth = sidebarWidth.value;

    window.addEventListener('pointermove', handleSidebarResize);
    window.addEventListener('pointerup', stopSidebarResize);
    window.addEventListener('pointercancel', stopSidebarResize);
}

function handleSidebarResize(event: PointerEvent) {
    const deltaX = event.clientX - resizeStartX;
    const nextWidth = resizeStartWidth + deltaX;

    if (nextWidth < SIDEBAR_COLLAPSE_WIDTH) {
        isResizingSidebar.value = false;
        cleanupSidebarResizeListeners();
        lastOpenSidebarWidth.value = SIDEBAR_MIN_WIDTH;
        sidebarWidth.value = SIDEBAR_MIN_WIDTH;
        showSidebar.value = false;
        return;
    }

    const clampedWidth = Math.min(
        Math.max(nextWidth, SIDEBAR_MIN_WIDTH),
        SIDEBAR_MAX_WIDTH,
    );

    sidebarWidth.value = clampedWidth;
    lastOpenSidebarWidth.value = clampedWidth;
}

function stopSidebarResize() {
    if (!isResizingSidebar.value) {
        return;
    }

    isResizingSidebar.value = false;
    cleanupSidebarResizeListeners();
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
    if (tool !== 'none') {
        dragMode.value = false;
    }
}

function handleAnnotationSettingChange(payload: { key: keyof IAnnotationSettings; value: IAnnotationSettings[keyof IAnnotationSettings] }) {
    annotationSettings.value = {
        ...annotationSettings.value,
        [payload.key]: payload.value,
    };
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

function handleHighlightSelection() {
    pdfViewerRef.value?.highlightSelection();
}

function handleCommentSelection() {
    pdfViewerRef.value?.commentSelection();
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
    const doc = pdfDocument.value;
    if (!doc) {
        return false;
    }
    try {
        const storage = doc.annotationStorage;
        if (!storage) {
            return false;
        }
        if (storage.size > 0) {
            return true;
        }
        return storage.modifiedIds?.ids?.size > 0;
    } catch {
        return false;
    }
}

async function handleUndo() {
    if (isAnySaving.value || !canUndo.value) {
        return;
    }
    if (isAnnotationUndoContext.value) {
        pdfViewerRef.value?.undoAnnotation();
        return;
    }
    if (isHistoryBusy.value) {
        return;
    }
    isHistoryBusy.value = true;
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);
    const didUndo = await undo();
    if (didUndo) {
        await restorePromise;
    }
    isHistoryBusy.value = false;
}

async function handleRedo() {
    if (isAnySaving.value || !canRedo.value) {
        return;
    }
    if (isAnnotationUndoContext.value) {
        pdfViewerRef.value?.redoAnnotation();
        return;
    }
    if (isHistoryBusy.value) {
        return;
    }
    isHistoryBusy.value = true;
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);
    const didRedo = await redo();
    if (didRedo) {
        await restorePromise;
    }
    isHistoryBusy.value = false;
}

function handleFitMode(mode: TFitMode) {
    zoom.value = 1;
    fitMode.value = mode;
}

async function handleSave() {
    if (isSaving.value || isSavingAs.value) {
        return;
    }
    isSaving.value = true;
    try {
        // In Electron we always operate on a working copy on disk. Saving should just copy
        // the working copy back to the original, without re-serializing the PDF in the renderer
        // (which can change compression and bloat scanned PDFs).
        if (workingCopyPath.value) {
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges();
            if (shouldSerialize) {
                const data = await pdfViewerRef.value?.saveDocument();
                if (data) {
                    const saved = await saveFile(data);
                    if (saved) {
                        pdfDocument.value?.annotationStorage?.resetModified();
                        markAnnotationSaved();
                    }
                }
                return;
            }
            const saved = await saveWorkingCopy();
            if (saved) {
                markAnnotationSaved();
            }
            return;
        }

        // Web context fallback.
        const data = await pdfViewerRef.value?.saveDocument();
        if (data) {
            const saved = await saveFile(data);
            if (saved) {
                pdfDocument.value?.annotationStorage?.resetModified();
                markAnnotationSaved();
            }
        }
    } finally {
        isSaving.value = false;
    }
}

async function handleSaveAs() {
    if (isSaving.value || isSavingAs.value) {
        return;
    }
    isSavingAs.value = true;
    try {
        let outPath: string | null = null;
        const shouldSerialize = annotationDirty.value || hasAnnotationChanges();
        if (shouldSerialize) {
            const data = await pdfViewerRef.value?.saveDocument();
            if (data) {
                outPath = await saveWorkingCopyAs(data);
                if (outPath) {
                    pdfDocument.value?.annotationStorage?.resetModified();
                    markAnnotationSaved();
                }
            }
        } else {
            outPath = await saveWorkingCopyAs();
            if (outPath) {
                markAnnotationSaved();
            }
        }
        if (outPath) {
            // Keep the recent files list in sync with Save As.
            loadRecentFiles();
        }
    } finally {
        isSavingAs.value = false;
    }
}

watch(pdfSrc, (newSrc, oldSrc) => {
    if (newSrc && newSrc !== oldSrc) {
        resetAnnotationTracking();
    }
    if (!newSrc) {
        resetSearchCache();
        closeSearch();
        annotationTool.value = 'none';
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
</script>

<style scoped>
/* Toolbar layout */
.toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-bg);
    white-space: nowrap;
    overflow-x: auto;
    container-type: inline-size;
    --toolbar-control-height: 2.25rem;
    --toolbar-icon-size: 18px;
}

.toolbar :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar :deep(.u-button::before),
.toolbar :deep(.u-button::after) {
    border-radius: 0 !important;
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
}

.toolbar-center {
    gap: clamp(0.5rem, 1.5vw, 1.25rem);
}

.toolbar-button-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.toolbar-group-item {
    display: flex;
    border-radius: 0;
}

.toolbar-group-item + .toolbar-group-item {
    border-left: 1px solid var(--ui-border);
}

.toolbar-button-group :deep(button),
.toolbar-button-group :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar-icon-button {
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.25rem;
    justify-content: center;
    border-radius: 0 !important;
    font-size: var(--toolbar-icon-size);
}

.toolbar-group-button {
    border-radius: 0 !important;
    height: var(--toolbar-control-height);
    min-width: var(--toolbar-control-height);
    padding: 0.25rem;
    font-size: var(--toolbar-icon-size);
}

.toolbar :deep(.toolbar-icon-button svg),
.toolbar :deep(.toolbar-group-button svg) {
    width: 1.1rem;
    height: 1.1rem;
}

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.sidebar-wrapper {
    display: flex;
    height: 100%;
}

.sidebar-resizer {
    width: 8px;
    cursor: col-resize;
    position: relative;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    background: color-mix(in oklab, var(--ui-bg) 80%, var(--ui-border) 20%);
    transition: background-color 0.15s ease;
}

.sidebar-resizer:hover,
.sidebar-resizer.is-active {
    background: color-mix(in oklab, var(--ui-bg) 50%, var(--ui-primary) 50%);
}

/* Empty state layout */
.empty-state {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    padding: 2rem;
}

.empty-state-hint {
    margin: 0;
    text-align: center;
}

/* Open file action button */
.open-file-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 1.5rem;
    border-radius: 0.5rem;
    border: 1px dashed var(--ui-border);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
}

.open-file-action:hover {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-primary) 5%);
}

.open-file-action:hover :deep(.iconify) {
    color: var(--ui-primary);
}

.open-file-action:active {
    transform: scale(0.98);
}

/* Recent files */
.recent-files {
    width: 100%;
    max-width: 400px;
}

.recent-files-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    padding: 0 0.5rem;
}

.recent-files-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.recent-file-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.recent-file-item:hover {
    background: var(--ui-bg-elevated);
}

.recent-file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.recent-file-name {
    color: var(--ui-text);
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-path {
    font-size: 0.7rem;
    color: var(--ui-text-dimmed);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-time {
    font-size: 0.7rem;
    color: var(--ui-text-muted);
    flex-shrink: 0;
    margin-left: auto;
}

.recent-file-remove {
    opacity: 0;
    transition: opacity 0.15s ease;
}

.recent-file-item:hover .recent-file-remove {
    opacity: 1;
}
</style>
