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
                    variant="ghost"
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
            <PdfSidebar
                v-if="pdfSrc"
                :is-open="showSidebar"
                v-model:activeTab="sidebarTab"
                v-model:searchQuery="searchQuery"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :total-pages="totalPages"
                :search-results="results"
                :current-result-index="currentResultIndex"
                :current-match="currentMatch"
                :total-matches="totalMatches"
                :is-searching="isSearching"
                @search="handleSearch"
                @next="handleSearchNext"
                @previous="handleSearchPrevious"
                @close="closeSearch"
                @go-to-page="handleGoToPage"
                @go-to-result="handleGoToResult"
            />
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
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type TFitMode = 'width' | 'height';
type TPdfSidebarTab = 'thumbnails' | 'outline' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    getPdfDocument: () => PDFDocumentProxy | null;
    saveDocument: () => Promise<Uint8Array | null>;
    applySearchHighlights: () => void;
    scrollToCurrentMatch: () => void;
}

const {
    pdfSrc,
    fileName: _fileName,
    isDirty,
    error: pdfError,
    isElectron,
    openFile,
    closeFile,
    saveFile,
} = usePdfFile();

const menuCleanups: Array<() => void> = [];

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
});

onUnmounted(() => {
    menuCleanups.forEach((cleanup) => cleanup());
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
    currentMatch,
    search,
    goToResult,
    setResultIndex,
    clearSearch,
} = usePdfSearch();

const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
const zoomDropdownRef = ref<{ close: () => void } | null>(null);
const pageDropdownRef = ref<{ close: () => void } | null>(null);

function closeAllDropdowns() {
    zoomDropdownRef.value?.close();
    pageDropdownRef.value?.close();
}

const zoom = ref(1);
const fitMode = ref<TFitMode>('width');
const currentPage = ref(1);
const totalPages = ref(0);
const isLoading = ref(false);
const dragMode = ref(true);

// Computed to make PDF document reactive (re-evaluates when totalPages changes)
const pdfDocument = computed(() => {
    // This dependency on totalPages makes the computed reactive
    if (totalPages.value > 0 && pdfViewerRef.value) {
        return pdfViewerRef.value.getPdfDocument();
    }
    return null;
});
const showSidebar = ref(false);
const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
const isSaving = ref(false);

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

function enableDragMode() {
    dragMode.value = true;
    window.getSelection()?.removeAllRanges();
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
            nextTick(() => {
                pdfViewerRef.value?.scrollToCurrentMatch();
            });
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
        closeSearch();
    }
});
</script>
