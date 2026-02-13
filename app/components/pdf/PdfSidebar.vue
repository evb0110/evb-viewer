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
                indicator: 'bg-primary/60 rounded-none bottom-0',
                trigger: 'flex-1 min-w-0 justify-center px-1 py-2 rounded-none text-[10.5px] font-semibold tracking-[0.02em] uppercase whitespace-nowrap data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-muted/40',
                leadingIcon: 'size-3.5 shrink-0',
            }"
            class="shrink-0"
        />
        <div class="relative min-h-0 flex-1 overflow-hidden overflow-y-auto [&>*]:w-full app-scrollbar">
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

            <div
                v-show="activeTab === 'thumbnails'"
                class="pdf-sidebar-pages"
            >
                <PdfPageSelectionBar
                    :selected-count="selectedThumbnailPages.length"
                    :is-operation-in-progress="props.isPageOperationInProgress ?? false"
                    @rotate-cw="emit('page-rotate-cw', selectedThumbnailPages)"
                    @rotate-ccw="emit('page-rotate-ccw', selectedThumbnailPages)"
                    @extract-pages="emit('page-extract', selectedThumbnailPages)"
                    @delete-pages="emit('page-delete', selectedThumbnailPages)"
                    @deselect="clearPageSelection"
                />
                <div class="pdf-sidebar-pages-thumbnails app-scrollbar">
                    <PdfThumbnails
                        ref="thumbnailsRef"
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :selected-pages="selectedThumbnailPages"
                        @go-to-page="emit('goToPage', $event)"
                        @update:selected-pages="handleSelectedPagesUpdate"
                        @page-context-menu="emit('page-context-menu', $event)"
                        @reorder="emit('page-reorder', $event)"
                        @file-drop="emit('page-file-drop', $event)"
                    />
                </div>

                <PdfSidebarPageNumbering
                    :total-pages="totalPages"
                    :selected-pages="selectedThumbnailPages"
                    :page-labels="pageLabels"
                    :page-label-ranges="pageLabelRanges"
                    @update:selected-pages="handleSelectedPagesUpdate"
                    @update:page-label-ranges="emit('update:pageLabelRanges', $event)"
                    @clear="clearPageSelection"
                />
            </div>

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
                class="flex min-h-full flex-col"
            >
                <div class="sticky top-0 z-[1] border-b border-[var(--ui-border)] bg-inherit">
                    <PdfSearchBar
                        ref="searchBarRef"
                        v-model="searchQueryProxy"
                        :total-matches="totalMatches"
                        @search="emit('search')"
                        @next="emit('next')"
                        @previous="emit('previous')"
                    />
                </div>
                <div class="flex flex-col">
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
    IPdfPageLabelRange,
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
    pageLabelRanges?: IPdfPageLabelRange[];
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
    isPageOperationInProgress?: boolean;
    isDjvuMode?: boolean;
}

const { t } = useI18n();

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
    (e: 'update:pageLabelRanges', ranges: IPdfPageLabelRange[]): void;
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
    (e: 'page-context-menu', payload: {
        clientX: number;
        clientY: number;
        pages: number[]
    }): void;
    (e: 'page-rotate-cw', pages: number[]): void;
    (e: 'page-rotate-ccw', pages: number[]): void;
    (e: 'page-extract', pages: number[]): void;
    (e: 'page-delete', pages: number[]): void;
    (e: 'page-reorder', newOrder: number[]): void;
    (e: 'page-file-drop', payload: {
        afterPage: number;
        filePath: string
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
const thumbnailsRef = ref<{ invalidatePages: (pages: number[]) => void } | null>(null);
const selectedThumbnailPages = ref<number[]>([]);

async function focusSearch() {
    await nextTick();
    searchBarRef.value?.focus();
}

function selectAllPages() {
    if (props.totalPages <= 0) {
        return;
    }
    const allPages = Array.from({ length: props.totalPages }, (_, i) => i + 1);
    selectedThumbnailPages.value = allPages;
}

function invertPageSelection() {
    if (props.totalPages <= 0) {
        return;
    }
    const currentSet = new Set(selectedThumbnailPages.value);
    const inverted: number[] = [];
    for (let page = 1; page <= props.totalPages; page += 1) {
        if (!currentSet.has(page)) {
            inverted.push(page);
        }
    }
    selectedThumbnailPages.value = inverted;
}

function invalidateThumbnailPages(pages: number[]) {
    thumbnailsRef.value?.invalidatePages(pages);
}

defineExpose({
    focusSearch,
    selectAllPages,
    invertPageSelection,
    invalidateThumbnailPages,
    selectedThumbnailPages,
});

function handleSelectedPagesUpdate(pages: number[]) {
    selectedThumbnailPages.value = pages;
}

function clearPageSelection() {
    selectedThumbnailPages.value = [];
}

watch(
    () => [
        props.isOpen,
        activeTab.value,
    ] as const,
    async ([
        isOpen,
        activeSidebarTab,
    ]) => {
        if (isOpen && activeSidebarTab === 'search') {
            await focusSearch();
        }
    },
    { flush: 'post' },
);

watch(
    () => props.totalPages,
    (totalPages) => {
        if (totalPages <= 0) {
            return;
        }

        selectedThumbnailPages.value = selectedThumbnailPages.value.filter(page => page <= totalPages);
    },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: string;
    icon: string;
    title: string;
}

const COMPACT_THRESHOLD = 280;
const isCompact = computed(() => (props.width ?? 240) < COMPACT_THRESHOLD);

const allTabs: IPdfSidebarTabItem[] = [
    {
        value: 'annotations',
        label: '',
        icon: 'i-lucide-sticky-note',
        title: '',
    },
    {
        value: 'thumbnails',
        label: '',
        icon: 'i-lucide-file',
        title: '',
    },
    {
        value: 'bookmarks',
        label: '',
        icon: 'i-lucide-bookmark',
        title: '',
    },
    {
        value: 'search',
        label: '',
        icon: 'i-lucide-search',
        title: '',
    },
];

const tabs = computed<IPdfSidebarTabItem[]>(() => {
    const items = props.isDjvuMode
        ? allTabs.filter((tab) => tab.value !== 'annotations')
        : allTabs;

    return items.map((tab) => ({
        ...tab,
        label: isCompact.value ? '' : t(`sidebar.${tab.value === 'annotations' ? 'notes' : tab.value === 'thumbnails' ? 'pages' : tab.value}`),
        title: t(`sidebar.${tab.value === 'annotations' ? 'notes' : tab.value === 'thumbnails' ? 'pages' : tab.value}`),
    }));
});

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
    display: flex;
    height: 100%;
    flex-direction: column;
    overflow: hidden;
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.pdf-sidebar-pages {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}

.pdf-sidebar-pages-thumbnails {
    flex: 1;
    min-height: 80px;
    overflow: hidden auto;
}
</style>
