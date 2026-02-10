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
                trigger: 'flex-1 min-w-0 justify-center px-1 py-1.5 rounded-none text-[10px] font-semibold tracking-normal whitespace-nowrap overflow-hidden text-ellipsis data-[state=active]:text-default data-[state=inactive]:text-muted data-[state=inactive]:hover:bg-muted/30',
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

            <div
                v-show="activeTab === 'thumbnails'"
                class="pdf-sidebar-pages"
            >
                <div class="pdf-sidebar-pages-panel">
                    <template v-if="!isPageNumberingMode">
                        <button
                            type="button"
                            class="pdf-sidebar-pages-disclosure"
                            aria-expanded="false"
                            @click="openPageNumberingMode"
                        >
                            <span class="pdf-sidebar-pages-disclosure-main">
                                <span class="pdf-sidebar-pages-title">Number Pages</span>
                            </span>
                        </button>
                    </template>

                    <template v-else>
                        <div class="pdf-sidebar-pages-panel-header">
                            <h3 class="pdf-sidebar-pages-title">Number Pages</h3>
                            <UButton
                                size="xs"
                                variant="outline"
                                color="neutral"
                                class="pdf-sidebar-pages-button"
                                @click="closePageNumberingMode"
                            >
                                <span class="pdf-sidebar-pages-button-label">Back to pages</span>
                            </UButton>
                        </div>
                        <p class="pdf-sidebar-pages-help">
                            Choose a range or manually pick contiguous thumbnails as the target.
                        </p>
                    </template>
                </div>

                <div
                    v-if="isPageNumberingMode && !isSelectionPickerOpen"
                    class="pdf-sidebar-pages-editor"
                >
                    <div class="pdf-sidebar-pages-target-mode">
                        <button
                            type="button"
                            class="pdf-sidebar-pages-target-mode-button"
                            :class="{ 'is-active': targetMode === 'range' }"
                            @click="setRangeTargetMode"
                        >
                            Page range
                        </button>
                        <button
                            type="button"
                            class="pdf-sidebar-pages-target-mode-button"
                            :class="{ 'is-active': targetMode === 'selection' }"
                            @click="setSelectionTargetMode"
                        >
                            Manual selection
                        </button>
                    </div>

                    <div class="pdf-sidebar-pages-fields">
                        <div class="pdf-sidebar-pages-field">
                            <label class="pdf-sidebar-pages-label" for="page-label-range-input">Page Range</label>
                            <input
                                id="page-label-range-input"
                                v-model="pageRangeInput"
                                class="pdf-sidebar-pages-input"
                                type="text"
                                inputmode="numeric"
                                placeholder="e.g. 1-12"
                                @input="setRangeTargetMode"
                            >
                        </div>

                        <div class="pdf-sidebar-pages-field">
                            <label class="pdf-sidebar-pages-label" for="page-label-style-input">Style</label>
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
                            <label class="pdf-sidebar-pages-label" for="page-label-prefix-input">Prefix</label>
                            <input
                                id="page-label-prefix-input"
                                v-model="pageLabelPrefix"
                                class="pdf-sidebar-pages-input"
                                type="text"
                                placeholder="Section-"
                            >
                        </div>

                        <div class="pdf-sidebar-pages-field">
                            <label class="pdf-sidebar-pages-label" for="page-label-start-input">Start At</label>
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

                    <div
                        v-if="targetMode === 'selection'"
                        class="pdf-sidebar-pages-selection"
                    >
                        <span class="pdf-sidebar-pages-selection-label">Thumbnail selection</span>
                        <span class="pdf-sidebar-pages-selection-text">{{ selectionSummary }}</span>
                        <div class="pdf-sidebar-pages-selection-actions">
                            <UButton
                                size="xs"
                                variant="outline"
                                color="neutral"
                                class="pdf-sidebar-pages-button pdf-sidebar-pages-secondary-button"
                                @click="openSelectionPicker"
                            >
                                <span class="pdf-sidebar-pages-button-label">Pick pages</span>
                            </UButton>
                            <UButton
                                size="xs"
                                variant="outline"
                                color="neutral"
                                class="pdf-sidebar-pages-button pdf-sidebar-pages-secondary-button"
                                :disabled="selectedThumbnailPages.length === 0"
                                @click="clearPageSelection"
                            >
                                <span class="pdf-sidebar-pages-button-label">Clear selection</span>
                            </UButton>
                        </div>
                    </div>

                    <p
                        v-if="rangeErrorMessage"
                        class="pdf-sidebar-pages-error"
                    >
                        {{ rangeErrorMessage }}
                    </p>

                    <p
                        class="pdf-sidebar-pages-target"
                        :class="{ 'is-invalid': hasTargetError }"
                    >
                        {{ applyTargetSummary }}
                    </p>

                    <UTooltip text="Apply numbering format to the active target range" :delay-duration="1200">
                        <UButton
                            size="xs"
                            variant="soft"
                            color="primary"
                            class="pdf-sidebar-pages-button pdf-sidebar-pages-primary-button"
                            :disabled="applyTargetRange === null"
                            @click="applyToTargetRange"
                        >
                            <span class="pdf-sidebar-pages-button-label">Apply numbering</span>
                        </UButton>
                    </UTooltip>
                </div>

                <div
                    v-else-if="isPageNumberingMode"
                    class="pdf-sidebar-pages-picker"
                >
                    <div class="pdf-sidebar-pages-picker-header">
                        <p class="pdf-sidebar-pages-help">
                            Pick contiguous thumbnails. Use Shift-click to expand a range.
                        </p>
                        <div class="pdf-sidebar-pages-picker-actions">
                            <UButton
                                size="xs"
                                variant="outline"
                                color="neutral"
                                class="pdf-sidebar-pages-button"
                                :disabled="selectedThumbnailPages.length === 0"
                                @click="clearPageSelection"
                            >
                                <span class="pdf-sidebar-pages-button-label">Clear</span>
                            </UButton>
                            <UButton
                                size="xs"
                                variant="soft"
                                color="primary"
                                class="pdf-sidebar-pages-button"
                                @click="closeSelectionPicker"
                            >
                                <span class="pdf-sidebar-pages-button-label">Done</span>
                            </UButton>
                        </div>
                    </div>
                    <PdfThumbnails
                        :pdf-document="pdfDocument"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :page-labels="pageLabels"
                        :selected-pages="selectedThumbnailPages"
                        @go-to-page="emit('goToPage', $event)"
                        @update:selected-pages="handleSelectedPagesUpdate"
                    />
                </div>

                <PdfThumbnails
                    v-else
                    :pdf-document="pdfDocument"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    :selected-pages="[]"
                    @go-to-page="emit('goToPage', $event)"
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
type TPageNumberTargetMode = 'range' | 'selection';

const isPageNumberingMode = ref(false);
const isSelectionPickerOpen = ref(false);
const targetMode = ref<TPageNumberTargetMode>('range');
const selectedThumbnailPages = ref<number[]>([]);
const pageRangeInput = ref('');
const pageLabelStyle = ref<'' | Exclude<TPageLabelStyle, null>>('D');
const pageLabelPrefix = ref('');
const pageLabelStartNumber = ref(1);

const pageLabelStyleOptions: Array<{
    value: '' | Exclude<TPageLabelStyle, null>;
    label: string;
}> = [
    {
        value: 'D',
        label: 'Decimal',
    },
    {
        value: 'r',
        label: 'Roman (i, ii)',
    },
    {
        value: 'R',
        label: 'Roman (I, II)',
    },
    {
        value: 'a',
        label: 'Letters (a, b)',
    },
    {
        value: 'A',
        label: 'Letters (A, B)',
    },
    {
        value: '',
        label: 'Prefix only',
    },
];

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
        return 'None';
    }

    if (selectionRange.value === null) {
        return `${selectedThumbnailPages.value.length} pages (non-contiguous)`;
    }

    const rangeText = formatPageRange(selectionRange.value);
    const pageCount = selectionRange.value.endPage - selectionRange.value.startPage + 1;
    const pageWord = pageCount === 1 ? 'page' : 'pages';
    return `${rangeText} (${pageCount} ${pageWord})`;
});

const rangeErrorMessage = computed(() => {
    if (targetMode.value !== 'range') {
        return '';
    }

    if (!pageRangeInput.value.trim()) {
        return '';
    }

    if (manualRange.value !== null) {
        return '';
    }

    return 'Enter one page (7) or a range (7-14).';
});

const applyTargetRange = computed(() => {
    if (targetMode.value === 'range') {
        return manualRange.value;
    }
    return selectionRange.value;
});

const hasTargetError = computed(() => {
    if (targetMode.value === 'range') {
        return pageRangeInput.value.trim().length > 0 && manualRange.value === null;
    }

    return hasNonContiguousSelection.value;
});

const applyTargetSummary = computed(() => {
    if (targetMode.value === 'range') {
        if (manualRange.value !== null) {
            return `Target: range ${formatPageRange(manualRange.value)}.`;
        }

        if (!pageRangeInput.value.trim()) {
            return 'Target: none. Enter a range.';
        }

        return 'Target unavailable: enter one page (7) or a range (7-14).';
    }

    if (selectionRange.value !== null) {
        return `Target: selected pages ${formatPageRange(selectionRange.value)}.`;
    }

    if (hasNonContiguousSelection.value) {
        return 'Target unavailable: selected pages are not contiguous.';
    }

    return 'Target: none. Pick contiguous thumbnails.';
});

async function focusSearch() {
    await nextTick();
    searchBarRef.value?.focus();
}

defineExpose({ focusSearch });

function openPageNumberingMode() {
    isPageNumberingMode.value = true;
    isSelectionPickerOpen.value = false;
}

function closePageNumberingMode() {
    isPageNumberingMode.value = false;
    isSelectionPickerOpen.value = false;
}

function openSelectionPicker() {
    targetMode.value = 'selection';
    isSelectionPickerOpen.value = true;
}

function closeSelectionPicker() {
    isSelectionPickerOpen.value = false;
}

function setRangeTargetMode() {
    targetMode.value = 'range';
    isSelectionPickerOpen.value = false;
}

function setSelectionTargetMode() {
    targetMode.value = 'selection';
    if (selectedThumbnailPages.value.length === 0) {
        isSelectionPickerOpen.value = true;
    }
}

function handleSelectedPagesUpdate(pages: number[]) {
    if (!isSelectionPickerOpen.value) {
        return;
    }

    selectedThumbnailPages.value = pages;
    targetMode.value = 'selection';
}

function clearPageSelection() {
    selectedThumbnailPages.value = [];
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
    selectedThumbnailPages.value = buildRangePages(targetRange);
    pageRangeInput.value = formatPageRange(targetRange);
    applyPageLabelsToRange(targetRange);
    closePageNumberingMode();
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
        if (!isOpen || tab !== 'thumbnails') {
            closePageNumberingMode();
        }

        if (isOpen && tab === 'search') {
            await focusSearch();
        }
    },
    { flush: 'post' },
);

watch(
    () => props.totalPages,
    (totalPages) => {
        if (totalPages <= 0) {
            closePageNumberingMode();
            selectedThumbnailPages.value = [];
            pageRangeInput.value = '';
            return;
        }

        selectedThumbnailPages.value = selectedThumbnailPages.value.filter(page => page <= totalPages);
    },
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

.pdf-sidebar-content > * {
    width: 100%;
}

.pdf-sidebar-pages {
    display: flex;
    flex-direction: column;
    min-height: 100%;
}

.pdf-sidebar-pages-panel {
    position: sticky;
    top: 0;
    z-index: 1;
    border-bottom: 1px solid var(--ui-border);
    padding: 0.625rem 0.75rem;
    background: var(--ui-bg);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.pdf-sidebar-pages-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    min-width: 0;
}

.pdf-sidebar-pages-disclosure:hover {
    background: var(--ui-bg-elevated);
}

.pdf-sidebar-pages-editor {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.625rem 0.75rem 0.75rem;
}

.pdf-sidebar-pages-picker {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
}

.pdf-sidebar-pages-picker-header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0 0.75rem;
}

.pdf-sidebar-pages-picker-actions {
    display: flex;
    gap: 0.5rem;
}

.pdf-sidebar-pages-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 700;
    color: inherit;
}

.pdf-sidebar-pages-help {
    margin: 0;
    font-size: 0.7rem;
    color: var(--ui-text-muted);
    line-height: 1.25;
}

.pdf-sidebar-pages-target-mode {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.375rem;
}

.pdf-sidebar-pages-target-mode-button {
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    background: var(--ui-bg-elevated);
    color: var(--ui-text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
}

.pdf-sidebar-pages-target-mode-button.is-active {
    border-color: var(--ui-primary);
    color: var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg-elevated));
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
    flex-direction: column;
    gap: 0.375rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    padding: 0.5rem;
    background: var(--ui-bg-muted);
}

.pdf-sidebar-pages-selection-label {
    font-size: 0.675rem;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.pdf-sidebar-pages-selection-text {
    font-size: 0.75rem;
    color: var(--ui-text);
    line-height: 1.3;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
}

.pdf-sidebar-pages-selection-actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
}

.pdf-sidebar-pages-target {
    margin: 0;
    font-size: 0.7rem;
    color: var(--ui-text-muted);
    line-height: 1.3;
}

.pdf-sidebar-pages-target.is-invalid {
    color: #dc2626;
}

.pdf-sidebar-pages-primary-button,
.pdf-sidebar-pages-secondary-button {
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
    color: #dc2626;
}
</style>
