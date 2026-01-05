<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
        <!-- Toolbar -->
        <header class="flex items-center gap-2 p-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 whitespace-nowrap overflow-x-auto">
            <UButton
                v-if="!pdfSrc"
                icon="i-lucide-folder-open"
                variant="soft"
                @click="openFile(); closeAllDropdowns()"
            >
                Open PDF
            </UButton>

            <template v-if="pdfSrc">
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

                <div class="flex-1" />

                <UButton
                    icon="i-lucide-search"
                    variant="ghost"
                    :color="showSidebar && sidebarTab === 'search' ? 'primary' : 'neutral'"
                    @click="openSearch(); closeAllDropdowns()"
                />

                <OcrPopup
                    ref="ocrPopupRef"
                    :pdf-document="pdfDocument"
                    :pdf-data="pdfData"
                    :current-page="currentPage"
                    :total-pages="totalPages"
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

                <div class="flex items-center border border-neutral-200 dark:border-neutral-700 rounded-md">
                    <UButton
                        icon="i-lucide-hand"
                        :variant="dragMode ? 'soft' : 'ghost'"
                        size="sm"
                        :color="dragMode ? 'primary' : 'neutral'"
                        class="rounded-r-none"
                        @click="enableDragMode(); closeAllDropdowns()"
                    />
                    <UButton
                        icon="i-lucide-text-cursor"
                        :variant="!dragMode ? 'soft' : 'ghost'"
                        size="sm"
                        :color="!dragMode ? 'primary' : 'neutral'"
                        class="rounded-l-none"
                        @click="dragMode = false; closeAllDropdowns()"
                    />
                </div>

                <UButton
                    icon="i-lucide-x"
                    variant="ghost"
                    @click="closeFile(); closeAllDropdowns()"
                />
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
                    class="h-full flex flex-col items-center justify-center gap-4 text-neutral-400 dark:text-neutral-600"
                >
                    <UIcon
                        name="i-lucide-file-text"
                        class="size-16"
                    />
                    <span class="text-lg">
                        Open a PDF file
                    </span>
                </div>
            </div>
        </main>
    </div>
</template>

<script setup lang="ts">
console.log('[PAGE] pages/index.vue script setup executing');

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

type TFitMode = 'width' | 'height';
type TPdfSidebarTab = 'thumbnails' | 'outline' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    saveDocument: () => Promise<Uint8Array | null>;
}

const {
    pdfSrc,
    pdfData,
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
        );
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
    // Reload the PDF with the OCR'd data
    loadPdfFromData(ocrPdfData);
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
    if (pdfDocument.value) {
        showSidebar.value = true;
        sidebarTab.value = 'search';
        const applied = await search(searchQuery.value, pdfDocument.value);
        if (applied) {
            scrollToCurrentResult();
        }
    }
}

function handleSearchNext() {
    goToResult('next');
    scrollToCurrentResult();
}

function handleSearchPrevious() {
    goToResult('previous');
    scrollToCurrentResult();
}

function scrollToCurrentResult() {
    if (results.value.length > 0 && currentResultIndex.value >= 0) {
        const result = results.value[currentResultIndex.value];
        if (result) {
            pdfViewerRef.value?.scrollToPage(result.pageIndex + 1);
        }
    }
}

function handleGoToResult(index: number) {
    setResultIndex(index);
    scrollToCurrentResult();
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
</style>
