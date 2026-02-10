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
            variant="link"
            color="primary"
            size="sm"
            :ui="{
                root: 'gap-0',
                list: 'p-0 mb-0 rounded-none bg-transparent border-b border-default',
                indicator: 'bg-primary/40 rounded-none bottom-0',
                trigger: 'flex-1 justify-center px-1 py-1.5 rounded-none text-[10px] font-semibold tracking-normal data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-muted/30',
            }"
            class="pdf-sidebar-tabs"
        />
        <div class="pdf-sidebar-content app-scrollbar">
            <PdfAnnotationsPanel
                v-show="activeTab === 'annotations'"
                :tool="annotationTool"
                :settings="annotationSettings"
                :comments="annotationComments"
                :active-comment-stable-key="annotationActiveCommentStableKey"
                :placing-page-note="annotationPlacingPageNote"
                :current-page="currentPage"
                :keep-active="annotationKeepActive"
                @set-tool="emit('update:annotation-tool', $event)"
                @update:keep-active="emit('update:annotation-keep-active', $event)"
                @update-setting="emit('annotation-setting', $event)"
                @comment-selection="emit('annotation-comment-selection')"
                @start-place-note="emit('annotation-start-place-note')"
                @focus-comment="emit('annotation-focus-comment', $event)"
                @open-note="emit('annotation-open-note', $event)"
                @copy-comment="emit('annotation-copy-comment', $event)"
                @delete-comment="emit('annotation-delete-comment', $event)"
            />
            <PdfThumbnails
                v-show="activeTab === 'thumbnails'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :total-pages="totalPages"
                :page-labels="pageLabels"
                @go-to-page="$emit('goToPage', $event)"
            />
            <PdfOutline
                v-show="activeTab === 'bookmarks'"
                :pdf-document="pdfDocument"
                :current-page="currentPage"
                :is-edit-mode="bookmarkEditMode"
                @go-to-page="$emit('goToPage', $event)"
                @bookmarks-change="emit('bookmarks-change', $event)"
                @update:is-edit-mode="emit('update:bookmark-edit-mode', $event)"
            />
            <div
                v-show="activeTab === 'search'"
                class="pdf-sidebar-search"
            >
                <div class="pdf-sidebar-search-bar">
                    <PdfSearchBar
                        ref="searchBarRef"
                        v-model="searchQueryProxy"
                        :total-matches="totalMatches"
                        @search="emit('search')"
                        @next="emit('next')"
                        @previous="emit('previous')"
                    />
                </div>
                <div class="pdf-sidebar-search-results">
                    <PdfSearchResults
                        :results="searchResults"
                        :current-result-index="currentResultIndex"
                        :search-query="searchQuery"
                        :page-labels="pageLabels"
                        :is-searching="isSearching"
                        :search-progress="props.searchProgress"
                        :is-truncated="props.isTruncated"
                        :min-query-length="props.minQueryLength"
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
    toRefs,
    watch,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IPdfBookmarkEntry,
    IPdfSearchMatch,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import PdfAnnotationsPanel from '@app/components/pdf/PdfAnnotationsPanel.vue';

interface IProps {
    isOpen: boolean;
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null;
    searchResults: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    totalMatches: number;
    isSearching: boolean;
    searchProgress?: {
        processed: number;
        total: number;
    };
    isTruncated?: boolean;
    minQueryLength?: number;
    activeTab?: TPdfSidebarTab;
    width?: number;
    annotationTool: TAnnotationTool;
    annotationKeepActive: boolean;
    annotationSettings: IAnnotationSettings;
    annotationComments: IAnnotationCommentSummary[];
    annotationActiveCommentStableKey?: string | null;
    annotationPlacingPageNote?: boolean;
    bookmarkEditMode: boolean;
}

const props = defineProps<IProps>();
const {
    annotationTool,
    annotationKeepActive,
    annotationSettings,
    annotationComments,
    annotationPlacingPageNote,
} = toRefs(props);
const annotationActiveCommentStableKey = computed(() => props.annotationActiveCommentStableKey ?? null);

const emit = defineEmits<{
    (e: 'goToPage', page: number): void;
    (e: 'goToResult', index: number): void;
    (e: 'update:activeTab', value: TPdfSidebarTab): void;
    (e: 'update:searchQuery', value: string): void;
    (e: 'update:annotation-tool', value: TAnnotationTool): void;
    (e: 'update:annotation-keep-active', value: boolean): void;
    (e: 'update:bookmark-edit-mode', value: boolean): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
    (e: 'annotation-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings] 
    }): void;
    (e: 'annotation-comment-selection'): void;
    (e: 'annotation-start-place-note'): void;
    (e: 'annotation-focus-comment', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-copy-comment', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-delete-comment', comment: IAnnotationCommentSummary): void;
    (e: 'bookmarks-change', payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }): void;
}>();

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

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
    label: string;
    title: string;
}

const tabs = [
    {
        value: 'annotations',
        label: 'Notes',
        title: 'Annotations',
    },
    {
        value: 'thumbnails',
        label: 'Pages',
        title: 'Pages',
    },
    {
        value: 'bookmarks',
        label: 'Bookmarks',
        title: 'Bookmarks',
    },
    {
        value: 'search',
        label: 'Search',
        title: 'Search',
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
    background: var(--ui-bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.pdf-sidebar-tabs {
    flex-shrink: 0;
}

.pdf-sidebar-search {
    display: flex;
    flex-direction: column;
    min-height: 100%;
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
    overflow: hidden auto;
    position: relative;
}

/* Ensure v-show hidden components don't affect layout */
.pdf-sidebar-content > * {
    width: 100%;
}
</style>
