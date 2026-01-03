<template>
    <aside
        v-if="isOpen"
        class="pdf-sidebar"
    >
        <UTabs
            v-model="activeTab"
            :items="tabs"
            class="pdf-sidebar-tabs"
        >
            <template #content="{ item }">
                <div class="pdf-sidebar-content">
                    <PdfThumbnails
                        v-if="item.key === 'thumbnails'"
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        @go-to-page="$emit('goToPage', $event)"
                    />
                    <PdfOutline
                        v-else-if="item.key === 'outline'"
                        :pdf-document="pdfDocument"
                        @go-to-page="$emit('goToPage', $event)"
                    />
                    <PdfSearchResults
                        v-else-if="item.key === 'search'"
                        :results="searchResults"
                        :current-result-index="currentResultIndex"
                        :search-query="searchQuery"
                        @go-to-result="$emit('goToResult', $event)"
                    />
                </div>
            </template>
        </UTabs>
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

const activeTab = ref('thumbnails');

const tabs = [
    {
        key: 'thumbnails',
        label: 'Pages',
        icon: 'i-lucide-layout-grid',
    },
    {
        key: 'outline',
        label: 'Outline',
        icon: 'i-lucide-list',
    },
    {
        key: 'search',
        label: 'Search',
        icon: 'i-lucide-search',
    },
];
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
    height: 100%;
    display: flex;
    flex-direction: column;
}

.pdf-sidebar-content {
    flex: 1;
    overflow: auto;
}
</style>
