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
                trigger: 'flex-1 min-w-0 justify-center px-1 py-2 rounded-none text-[10.5px] font-semibold tracking-[0.02em] uppercase whitespace-nowrap overflow-hidden text-ellipsis data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-muted/40',
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

                <div class="pdf-sidebar-pages-panel">
                    <UCollapsible
                        v-model:open="isPageNumberingExpanded"
                        :default-open="false"
                        :unmount-on-hide="false"
                        class="pdf-sidebar-pages-collapsible"
                    >
                        <template #default="{ open }">
                            <button
                                type="button"
                                class="pdf-sidebar-pages-disclosure"
                                :aria-expanded="open ? 'true' : 'false'"
                            >
                                <span class="pdf-sidebar-pages-disclosure-main">
                                    <UIcon
                                        :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                                        class="pdf-sidebar-pages-disclosure-icon size-4"
                                    />
                                    <UIcon
                                        name="i-lucide-hash"
                                        class="pdf-sidebar-pages-disclosure-type-icon size-3.5"
                                    />
                                    <span class="pdf-sidebar-pages-title">{{ t('pageNumbering.numberPages') }}</span>
                                </span>
                            </button>
                        </template>

                        <template #content>
                            <div class="pdf-sidebar-pages-editor">
                                <div class="pdf-sidebar-pages-fields">
                                    <div class="pdf-sidebar-pages-field">
                                        <label class="pdf-sidebar-pages-label" for="page-label-range-input">{{ t('pageNumbering.pageRange') }}</label>
                                        <input
                                            id="page-label-range-input"
                                            v-model="pageRangeInput"
                                            class="pdf-sidebar-pages-input"
                                            type="text"
                                            inputmode="numeric"
                                            placeholder="e.g. 1-12"
                                        >
                                    </div>

                                    <div class="pdf-sidebar-pages-field">
                                        <label class="pdf-sidebar-pages-label" for="page-label-style-input">{{ t('pageNumbering.style') }}</label>
                                        <select
                                            id="page-label-style-input"
                                            v-model="pageLabelStyle"
                                            class="pdf-sidebar-pages-select"
                                        >
                                            <option
                                                v-for="styleOption in pageLabelStyleOptions"
                                                :key="styleOption.value"
                                                :value="styleOption.value"
                                            >
                                                {{ styleOption.label }}
                                            </option>
                                        </select>
                                    </div>

                                    <div class="pdf-sidebar-pages-field">
                                        <label class="pdf-sidebar-pages-label" for="page-label-prefix-input">{{ t('pageNumbering.prefix') }}</label>
                                        <input
                                            id="page-label-prefix-input"
                                            v-model="pageLabelPrefix"
                                            class="pdf-sidebar-pages-input"
                                            type="text"
                                            placeholder="Section-"
                                        >
                                    </div>

                                    <div class="pdf-sidebar-pages-field">
                                        <label class="pdf-sidebar-pages-label" for="page-label-start-input">{{ t('pageNumbering.startAt') }}</label>
                                        <input
                                            id="page-label-start-input"
                                            :value="pageLabelStartNumber"
                                            class="pdf-sidebar-pages-input"
                                            type="number"
                                            min="1"
                                            :disabled="pageLabelStyle.length === 0"
                                            @input="handleStartNumberInput"
                                        >
                                    </div>
                                </div>

                                <div class="pdf-sidebar-pages-selection">
                                    <span class="pdf-sidebar-pages-selection-text">{{ selectionSummary }}</span>
                                    <UButton
                                        size="xs"
                                        variant="link"
                                        color="neutral"
                                        class="pdf-sidebar-pages-clear-button"
                                        :disabled="selectedThumbnailPages.length === 0 && !pageRangeInput.trim()"
                                        @click="clearPageSelection"
                                    >
                                        {{ t('pageNumbering.clear') }}
                                    </UButton>
                                </div>

                                <p
                                    v-if="rangeErrorMessage"
                                    class="pdf-sidebar-pages-error"
                                >
                                    {{ rangeErrorMessage }}
                                </p>

                                <UTooltip :text="applyTargetSummary" :delay-duration="600">
                                    <UButton
                                        size="xs"
                                        variant="soft"
                                        color="primary"
                                        class="pdf-sidebar-pages-button pdf-sidebar-pages-primary-button"
                                        :disabled="applyTargetRange === null"
                                        @click="applyToTargetRange"
                                    >
                                        <span class="pdf-sidebar-pages-button-label">{{ t('pageNumbering.applyNumbering') }}</span>
                                    </UButton>
                                </UTooltip>
                            </div>
                        </template>
                    </UCollapsible>
                </div>
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
    IPdfPageRange,
    IPdfSearchMatch,
    TPageLabelStyle,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    formatPageRange,
    normalizePageLabelRanges,
    parsePageRangeInput,
} from '@app/utils/pdf-page-labels';
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
const isPageNumberingExpanded = ref(false);
const ignoreRangeInputWatch = ref(false);
const ignoreSelectionWatch = ref(false);
const selectedThumbnailPages = ref<number[]>([]);
const pageRangeInput = ref('');
const pageLabelStyle = ref<'' | Exclude<TPageLabelStyle, null>>('D');
const pageLabelPrefix = ref('');
const pageLabelStartNumber = ref(1);

const pageLabelStyleOptions = computed<Array<{
    value: '' | Exclude<TPageLabelStyle, null>;
    label: string;
}>>(() => [
    {
        value: 'D',
        label: t('pageNumbering.decimal'),
    },
    {
        value: 'r',
        label: t('pageNumbering.romanLower'),
    },
    {
        value: 'R',
        label: t('pageNumbering.romanUpper'),
    },
    {
        value: 'a',
        label: t('pageNumbering.lettersLower'),
    },
    {
        value: 'A',
        label: t('pageNumbering.lettersUpper'),
    },
    {
        value: '',
        label: t('pageNumbering.prefixOnly'),
    },
]);

const normalizedPageLabelRanges = computed(() => normalizePageLabelRanges(
    props.pageLabelRanges ?? [],
    props.totalPages,
));

const effectivePageLabels = computed(() => {
    if (props.pageLabels && props.pageLabels.length === props.totalPages) {
        return props.pageLabels;
    }
    return buildPageLabelsFromRanges(props.totalPages, normalizedPageLabelRanges.value);
});

const manualRange = computed(() => parsePageRangeInput(pageRangeInput.value, props.totalPages));

function deriveContiguousSelectionRange(pages: number[]): IPdfPageRange | null {
    if (pages.length === 0) {
        return null;
    }

    const sorted = Array.from(new Set(pages))
        .filter(page => Number.isInteger(page) && page >= 1 && page <= props.totalPages)
        .sort((left, right) => left - right);

    if (sorted.length === 0) {
        return null;
    }

    const startPage = sorted[0] ?? 1;
    const endPage = sorted[sorted.length - 1] ?? startPage;

    if ((endPage - startPage + 1) !== sorted.length) {
        return null;
    }

    return {
        startPage,
        endPage,
    };
}

const selectionRange = computed(() => deriveContiguousSelectionRange(selectedThumbnailPages.value));
const hasNonContiguousSelection = computed(() => selectedThumbnailPages.value.length > 0 && selectionRange.value === null);

const selectionSummary = computed(() => {
    if (selectedThumbnailPages.value.length === 0) {
        return t('pageNumbering.none');
    }

    if (selectionRange.value === null) {
        return t('pageNumbering.pagesNonContiguous', { count: selectedThumbnailPages.value.length });
    }

    const rangeText = formatPageRange(selectionRange.value);
    const pageCount = selectionRange.value.endPage - selectionRange.value.startPage + 1;
    const pageWord = t('pageNumbering.pageWord', pageCount);
    return `${rangeText} (${pageCount} ${pageWord})`;
});

const rangeErrorMessage = computed(() => {
    if (!pageRangeInput.value.trim()) {
        return '';
    }

    if (manualRange.value !== null) {
        return '';
    }

    return t('pageNumbering.rangeError');
});

const applyTargetRange = computed(() => {
    if (pageRangeInput.value.trim().length > 0) {
        return manualRange.value;
    }

    return selectionRange.value;
});

const applyTargetSummary = computed(() => {
    if (pageRangeInput.value.trim().length > 0 && manualRange.value === null) {
        return t('pageNumbering.targetUnavailableRange');
    }

    if (manualRange.value !== null) {
        return t('pageNumbering.targetPages', { range: formatPageRange(manualRange.value) });
    }

    if (selectionRange.value !== null) {
        return t('pageNumbering.targetSelectedPages', { range: formatPageRange(selectionRange.value) });
    }

    if (hasNonContiguousSelection.value) {
        return t('pageNumbering.targetUnavailableNonContiguous');
    }

    return t('pageNumbering.targetNone');
});

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
    setSelectedPagesSilently([]);
    setPageRangeInputSilently('');
}

function readEventValue(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
        return target.value;
    }
    return '';
}

function handleStartNumberInput(event: Event) {
    const parsed = Number.parseInt(readEventValue(event), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        pageLabelStartNumber.value = 1;
        return;
    }
    pageLabelStartNumber.value = parsed;
}

function buildRangePages(range: IPdfPageRange) {
    const pages: number[] = [];
    for (let page = range.startPage; page <= range.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
}

function arePageListsEqual(left: number[], right: number[]) {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function setSelectedPagesSilently(pages: number[]) {
    if (arePageListsEqual(selectedThumbnailPages.value, pages)) {
        return;
    }
    ignoreSelectionWatch.value = true;
    selectedThumbnailPages.value = pages;
}

function setPageRangeInputSilently(value: string) {
    if (pageRangeInput.value === value) {
        return;
    }
    ignoreRangeInputWatch.value = true;
    pageRangeInput.value = value;
}

function getConfiguredPageLabelStyle(): TPageLabelStyle {
    return pageLabelStyle.value === '' ? null : pageLabelStyle.value;
}

function applyPageLabelsToRange(range: IPdfPageRange) {
    if (props.totalPages <= 0) {
        return;
    }

    const nextLabels = [...effectivePageLabels.value];
    if (nextLabels.length !== props.totalPages) {
        return;
    }

    const segmentLabels = buildPageLabelsFromRanges(
        range.endPage - range.startPage + 1,
        [{
            startPage: 1,
            style: getConfiguredPageLabelStyle(),
            prefix: pageLabelPrefix.value,
            startNumber: pageLabelStartNumber.value,
        }],
    );

    segmentLabels.forEach((label, index) => {
        nextLabels[range.startPage - 1 + index] = label;
    });

    const nextRanges = derivePageLabelRangesFromLabels(nextLabels, props.totalPages);
    emit('update:pageLabelRanges', nextRanges);
}

function applyToTargetRange() {
    if (applyTargetRange.value === null) {
        return;
    }

    const targetRange = applyTargetRange.value;
    setSelectedPagesSilently(buildRangePages(targetRange));
    setPageRangeInputSilently(formatPageRange(targetRange));
    applyPageLabelsToRange(targetRange);
}

watch(
    () => selectedThumbnailPages.value,
    (pages) => {
        if (ignoreSelectionWatch.value) {
            ignoreSelectionWatch.value = false;
            return;
        }

        if (pages.length === 0) {
            setPageRangeInputSilently('');
            return;
        }

        if (selectionRange.value === null) {
            setPageRangeInputSilently('');
            return;
        }

        const nextRangeText = formatPageRange(selectionRange.value);
        setPageRangeInputSilently(nextRangeText);
    },
    { deep: true },
);

watch(
    () => pageRangeInput.value,
    (inputValue) => {
        if (ignoreRangeInputWatch.value) {
            ignoreRangeInputWatch.value = false;
            return;
        }

        if (!inputValue.trim()) {
            setSelectedPagesSilently([]);
            return;
        }

        if (manualRange.value === null) {
            return;
        }

        const nextPages = buildRangePages(manualRange.value);
        setSelectedPagesSilently(nextPages);
    },
);

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
            isPageNumberingExpanded.value = false;
            setSelectedPagesSilently([]);
            setPageRangeInputSilently('');
            return;
        }

        setSelectedPagesSilently(selectedThumbnailPages.value.filter(page => page <= totalPages));
    },
);

interface IPdfSidebarTabItem {
    value: TPdfSidebarTab;
    label: string;
    title: string;
}

const tabs = computed<IPdfSidebarTabItem[]>(() => [
    {
        value: 'annotations',
        label: t('sidebar.notes'),
        title: t('sidebar.notes'),
    },
    {
        value: 'thumbnails',
        label: t('sidebar.pages'),
        title: t('sidebar.pages'),
    },
    {
        value: 'bookmarks',
        label: t('sidebar.bookmarks'),
        title: t('sidebar.bookmarks'),
    },
    {
        value: 'search',
        label: t('sidebar.search'),
        title: t('sidebar.search'),
    },
]);

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

.pdf-sidebar-pages-panel {
    flex-shrink: 0;
    border-top: 1px solid var(--ui-border);
    padding: 0.625rem 0.75rem;
    background: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.pdf-sidebar-pages-collapsible {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.pdf-sidebar-pages-disclosure {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    background: transparent;
    color: var(--ui-text);
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}

.pdf-sidebar-pages-disclosure-main {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
}

.pdf-sidebar-pages-disclosure:hover {
    background: var(--ui-bg-elevated);
}

.pdf-sidebar-pages-disclosure-icon {
    color: var(--ui-text-muted);
    flex-shrink: 0;
}

.pdf-sidebar-pages-disclosure-type-icon {
    color: var(--ui-text-muted);
    flex-shrink: 0;
}

.pdf-sidebar-pages-editor {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding-top: 0.375rem;
}

.pdf-sidebar-pages-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 700;
    color: inherit;
}

.pdf-sidebar-pages-fields {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
}

.pdf-sidebar-pages-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
}

.pdf-sidebar-pages-label {
    font-size: 0.675rem;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.pdf-sidebar-pages-input,
.pdf-sidebar-pages-select {
    width: 100%;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    padding: 0.25rem 0.375rem;
    min-width: 0;
    max-width: 100%;
}

.pdf-sidebar-pages-select {
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-input:disabled {
    opacity: 0.6;
}

.pdf-sidebar-pages-selection {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

.pdf-sidebar-pages-selection-text {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    line-height: 1.3;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-clear-button {
    flex-shrink: 0;
    font-size: 0.7rem;
    padding: 0;
}

.pdf-sidebar-pages-primary-button {
    width: 100%;
    justify-content: center;
}

.pdf-sidebar-pages-button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    text-align: center;
    flex: 1;
}

:deep(.pdf-sidebar-pages-button) {
    justify-content: center !important;
    text-align: center !important;
    white-space: nowrap !important;
}

:deep(.pdf-sidebar-pages-button span) {
    display: block;
    width: 100%;
    text-align: center;
    white-space: nowrap !important;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-error {
    margin: 0;
    font-size: 0.7rem;
    color: var(--ui-error);
}
</style>
