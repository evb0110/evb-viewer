<template>
    <aside
        v-if="isOpen"
        class="pdf-sidebar"
        :style="sidebarStyle"
    >
        <UTabs
            v-model="activeTab"
            :items="tabs"
            :content="false"
            class="pdf-sidebar-tabs"
        >
            <template #leading="{ item }">
                <UTooltip :text="item.tooltip">
                    <span class="pdf-sidebar-tab-icon">
                        <UIcon
                            :name="item.icon"
                            class="size-4"
                        />
                    </span>
                </UTooltip>
            </template>
        </UTabs>
        <div class="pdf-sidebar-content">
            <PdfThumbnails
                v-show="activeTab === 'thumbnails'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :total-pages="totalPages"
                @go-to-page="$emit('goToPage', $event)"
            />
            <PdfOutline
                v-show="activeTab === 'outline'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                @go-to-page="$emit('goToPage', $event)"
            />
            <div
                v-show="activeTab === 'search'"
                class="pdf-sidebar-search"
            >
                <div class="pdf-sidebar-search-bar">
                    <PdfSearchBar
                        ref="searchBarRef"
                        v-model="searchQueryProxy"
                        :current-match="currentMatch"
                        :total-matches="totalMatches"
                        :is-searching="isSearching"
                        @search="emit('search')"
                        @next="emit('next')"
                        @previous="emit('previous')"
                        @close="handleSearchClose"
                    />
                </div>
                <div class="pdf-sidebar-search-results">
                    <PdfSearchResults
                        :results="searchResults"
                        :current-result-index="currentResultIndex"
                        :search-query="searchQuery"
                        :is-searching="isSearching"
                        :search-progress="props.searchProgress"
                        @go-to-result="$emit('goToResult', $event)"
                    />
                </div>
            </div>
        </div>
    </aside>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    ref,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IPdfSearchMatch } from 'app/types/pdf';

interface IProps {
    isOpen: boolean;
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    currentMatch: number;
    totalMatches: number;
    isSearching: boolean;
    searchProgress?: {
        processed: number;
        total: number;
    };
    activeTab?: TPdfSidebarTab;
    width?: number;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'goToResult', index: number): void;
    (e: 'update:activeTab', value: TPdfSidebarTab): void;
    (e: 'update:searchQuery', value: string): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
    (e: 'close'): void;
}>();

type TPdfSidebarTab = 'thumbnails' | 'outline' | 'search';

const activeTabLocal = ref<TPdfSidebarTab>('thumbnails');

const activeTab = computed<TPdfSidebarTab>({
    get: () => props.activeTab ?? activeTabLocal.value,
    set: (value) => {
        if (props.activeTab !== undefined) {
            emit('update:activeTab', value);
            return;
        }
        activeTabLocal.value = value;
    },
});

const searchQueryProxy = computed({
    get: () => props.searchQuery,
    set: (value: string) => emit('update:searchQuery', value),
});

const searchBarRef = ref<{ focus: () => void } | null>(null);

async function focusSearch() {
    await nextTick();
    searchBarRef.value?.focus();
}

defineExpose({ focusSearch });

function handleSearchClose() {
    emit('close');
    activeTab.value = 'thumbnails';
}

watch(
    () => [
        props.isOpen,
        activeTab.value,
    ] as const,
    async ([
        isOpen,
        tab,
    ]) => {
        if (isOpen && tab === 'search') {
            await focusSearch();
        }
    },
    { flush: 'post' },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: '';
    tooltip: string;
    icon: string;
}

const tabs = [
    {
        value: 'thumbnails',
        label: '',
        tooltip: 'Pages',
        icon: 'i-lucide-layout-grid',
    },
    {
        value: 'outline',
        label: '',
        tooltip: 'Outline',
        icon: 'i-lucide-list',
    },
    {
        value: 'search',
        label: '',
        tooltip: 'Search',
        icon: 'i-lucide-search',
    },
] satisfies IPdfSidebarTabItem[];

const sidebarStyle = computed(() => {
    const width = props.width ?? 240;

    return {
        width: `${width}px`,
        minWidth: `${width}px`,
    };
});
</script>

<style scoped>
.pdf-sidebar {
    height: 100%;
    border-right: 1px solid var(--ui-border);
    background: var(--ui-bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.pdf-sidebar-tabs {
    flex-shrink: 0;
}

.pdf-sidebar-tab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
}

.pdf-sidebar-search {
    display: flex;
    flex-direction: column;
    height: 100%;
}

.pdf-sidebar-search-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--ui-bg);
    border-bottom: 1px solid var(--ui-border);
}

.pdf-sidebar-search-results {
    display: flex;
    flex-direction: column;
}

.pdf-sidebar-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
}

/* Ensure v-show hidden components don't affect layout */
.pdf-sidebar-content > * {
    width: 100%;
}
</style>
