<template>
    <aside
        v-if="isOpen"
        class="pdf-sidebar"
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
            <PdfSearchResults
                v-show="activeTab === 'search'"
                :results="searchResults"
                :current-result-index="currentResultIndex"
                :search-query="searchQuery"
                @go-to-result="$emit('goToResult', $event)"
            />
        </div>
    </aside>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IPdfSearchMatch } from '../../types/pdf';

interface IPdfSidebarProps {
    isOpen: boolean;
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
}

defineProps<IPdfSidebarProps>();

defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'goToResult', index: number): void;
}>();

type TPdfSidebarTab = 'thumbnails' | 'outline' | 'search';

const activeTab = ref<TPdfSidebarTab>('thumbnails');

type TPdfSidebarTabItem = {
    value: TPdfSidebarTab;
    label: '';
    tooltip: string;
    icon: string;
};

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
] satisfies TPdfSidebarTabItem[];
</script>

<style scoped>
.pdf-sidebar {
    width: 240px;
    min-width: 240px;
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
