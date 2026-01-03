<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
        <!-- Toolbar -->
        <header class="flex items-center gap-2 p-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 whitespace-nowrap overflow-x-auto">
            <UButton
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

                <div class="flex-1" />

                <UButton
                    icon="i-lucide-search"
                    variant="ghost"
                    :color="showSearchBar ? 'primary' : 'neutral'"
                    @click="toggleSearch(); closeAllDropdowns()"
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
                        icon="i-lucide-mouse-pointer"
                        :variant="!dragMode ? 'soft' : 'ghost'"
                        size="sm"
                        :color="!dragMode ? 'primary' : 'neutral'"
                        class="rounded-r-none"
                        @click="dragMode = false; closeAllDropdowns()"
                    />
                    <UButton
                        icon="i-lucide-hand"
                        :variant="dragMode ? 'soft' : 'ghost'"
                        size="sm"
                        :color="dragMode ? 'primary' : 'neutral'"
                        class="rounded-l-none"
                        @click="dragMode = true; closeAllDropdowns()"
                    />
                </div>

                <UButton
                    icon="i-lucide-x"
                    variant="ghost"
                    @click="closeFile(); closeAllDropdowns()"
                />
            </template>
        </header>

        <!-- Search Bar -->
        <div
            v-if="showSearchBar && pdfSrc"
            class="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
        >
            <PdfSearchBar
                ref="searchBarRef"
                v-model="searchQuery"
                :current-match="currentMatch"
                :total-matches="totalMatches"
                :is-searching="isSearching"
                @search="handleSearch"
                @next="handleSearchNext"
                @previous="handleSearchPrevious"
                @close="closeSearch"
            />
        </div>

        <!-- Main -->
        <main class="flex-1 overflow-hidden">
            <PdfViewer
                v-if="pdfSrc"
                ref="pdfViewerRef"
                :src="pdfSrc"
                :zoom="zoom"
                :fit-mode="fitMode"
                :drag-mode="dragMode"
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
        </main>
    </div>
</template>

<script setup lang="ts">
import {
    nextTick,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type TFitMode = 'width' | 'height';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    getPdfDocument: () => PDFDocumentProxy | null;
    saveDocument: () => Promise<Uint8Array | null>;
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

onMounted(() => {
    console.log('Electron API available:', isElectron.value);
});

watch(pdfError, (err) => {
    if (err) {
        console.error('PDF Error:', err);
    }
});

const {
    searchQuery,
    results,
    currentResultIndex,
    isSearching,
    totalMatches,
    currentMatch,
    search,
    goToResult,
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
const dragMode = ref(false);
const showSearchBar = ref(false);
const isSaving = ref(false);
const searchBarRef = ref<{ focus: () => void } | null>(null);

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

function toggleSearch() {
    showSearchBar.value = !showSearchBar.value;
    if (showSearchBar.value) {
        nextTick(() => searchBarRef.value?.focus());
    } else {
        clearSearch();
    }
}

function closeSearch() {
    showSearchBar.value = false;
    clearSearch();
}

async function handleSearch() {
    const pdfDoc = pdfViewerRef.value?.getPdfDocument();
    if (pdfDoc && searchQuery.value) {
        await search(searchQuery.value, pdfDoc);
        scrollToCurrentResult();
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
