<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
        <!-- Toolbar -->
        <header class="toolbar">
            <UButton
                v-if="!pdfSrc"
                icon="i-lucide-folder-open"
                variant="soft"
                @click="openFile(); closeAllDropdowns()"
            >
                Open PDF
            </UButton>

            <template v-if="pdfSrc">
                <!-- Left section: File & view controls -->
                <div class="toolbar-section">
                    <UButton
                        icon="i-lucide-save"
                        variant="ghost"
                        :disabled="!isDirty && !isSaving"
                        :loading="isSaving"
                        @click="handleSave(); closeAllDropdowns()"
                    >
                        Save
                    </UButton>

                    <UButton
                        icon="i-lucide-panel-left"
                        :variant="showSidebar ? 'soft' : 'ghost'"
                        :color="showSidebar ? 'primary' : 'neutral'"
                        @click="showSidebar = !showSidebar; closeAllDropdowns()"
                    />
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

                    <PdfZoomDropdown
                        ref="zoomDropdownRef"
                        v-model:zoom="zoom"
                        v-model:fit-mode="fitMode"
                        @open="pageDropdownRef?.close()"
                    />

                    <PdfPageDropdown
                        ref="pageDropdownRef"
                        v-model="currentPage"
                        :total-pages="totalPages"
                        @go-to-page="handleGoToPage"
                        @open="zoomDropdownRef?.close()"
                    />

                    <div class="toolbar-mode-toggle">
                        <UButton
                            icon="i-lucide-hand"
                            :variant="dragMode ? 'soft' : 'ghost'"
                            size="sm"
                            :color="dragMode ? 'primary' : 'neutral'"
                            class="rounded-r-none h-8"
                            @click="enableDragMode(); closeAllDropdowns()"
                        />
                        <UButton
                            icon="i-lucide-text-cursor"
                            :variant="!dragMode ? 'soft' : 'ghost'"
                            size="sm"
                            :color="!dragMode ? 'primary' : 'neutral'"
                            class="rounded-l-none h-8"
                            @click="dragMode = false; closeAllDropdowns()"
                        />
                    </div>
                </div>

                <!-- Spacer to push right section -->
                <div class="flex-1" />

                <!-- Right section: Window control -->
                <div class="toolbar-section">
                    <UButton
                        icon="i-lucide-x"
                        variant="ghost"
                        @click="closeFile(); closeAllDropdowns()"
                    />
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
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
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
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @update:document="pdfDocument = $event"
                    @loading="isLoading = $event"
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
                            <UButton
                                variant="link"
                                size="xs"
                                color="neutral"
                                class="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                                @click="clearRecentFiles"
                            >
                                Clear all
                            </UButton>
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
                                    <span class="recent-file-time">{{ formatRelativeTime(file.timestamp) }}</span>
                                </div>
                                <UButton
                                    icon="i-lucide-x"
                                    size="xs"
                                    variant="ghost"
                                    color="neutral"
                                    class="recent-file-remove"
                                    @click.stop="removeRecentFile(file)"
                                />
                            </li>
                        </ul>
                    </div>

                    <!-- Open file action (clickable) -->
                    <button
                        class="open-file-action"
                        @click="openFile"
                    >
                        <UIcon
                            name="i-lucide-folder-open"
                            class="size-8 text-neutral-400 group-hover:text-primary-500 transition-colors"
                        />
                        <span class="text-sm text-neutral-500 dark:text-neutral-400">
                            {{ recentFiles.length > 0 ? 'Or open another file...' : 'Open a PDF file' }}
                        </span>
                    </button>
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

console.log('[PAGE] pages/index.vue script setup executing');

type TPdfSidebarTab = 'thumbnails' | 'outline' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    saveDocument: () => Promise<Uint8Array | null>;
}

const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    fileName: _fileName,
    isDirty,
    error: pdfError,
    isElectron,
    openFile,
    openFileDirect,
    loadPdfFromData,
    closeFile,
    saveFile,
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
            window.electronAPI.onMenuZoomIn(() => { zoom.value = Math.min(zoom.value + 0.25, 5); }),
            window.electronAPI.onMenuZoomOut(() => { zoom.value = Math.max(zoom.value - 0.25, 0.25); }),
            window.electronAPI.onMenuActualSize(() => { zoom.value = 1; }),
            window.electronAPI.onMenuFitWidth(() => { fitMode.value = 'width'; }),
            window.electronAPI.onMenuFitHeight(() => { fitMode.value = 'height'; }),
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

const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
const zoomDropdownRef = ref<{ close: () => void } | null>(null);
const pageDropdownRef = ref<{ close: () => void } | null>(null);
const ocrPopupRef = ref<{ close: () => void } | null>(null);
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
const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
const showSidebar = ref(false);
const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
const isSaving = ref(false);

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

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

function handleOcrComplete(ocrPdfData: Uint8Array) {
    // Remember current page before reload
    const pageToRestore = currentPage.value;

    // Reload the PDF with the OCR'd data
    loadPdfFromData(ocrPdfData);

    // Restore scroll position after PDF reloads
    // Watch for document to be set (happens after loadFromSource completes)
    const unwatch = watch(pdfDocument, (doc) => {
        if (doc) {
            unwatch();
            // Use nextTick to ensure DOM is updated
            void nextTick(() => {
                pdfViewerRef.value?.scrollToPage(pageToRestore);
            });
        }
    });
}

function enableDragMode() {
    dragMode.value = true;
    window.getSelection()?.removeAllRanges();
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

function closeSearch() {
    clearSearch();
    sidebarTab.value = 'thumbnails';
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

async function handleSave() {
    if (isSaving.value) {
        return;
    }
    isSaving.value = true;
    try {
        const data = await pdfViewerRef.value?.saveDocument();
        if (data) {
            await saveFile(data);
        }
    } finally {
        isSaving.value = false;
    }
}

watch(pdfSrc, () => {
    if (!pdfSrc.value) {
        resetSearchCache();
        closeSearch();
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

.toolbar-mode-toggle {
    display: flex;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
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

.recent-file-time {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}

.recent-file-remove {
    opacity: 0;
    transition: opacity 0.15s ease;
}

.recent-file-item:hover .recent-file-remove {
    opacity: 1;
}
</style>
