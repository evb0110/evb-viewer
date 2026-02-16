<template>
    <div class="pdf-sidebar-pages-panel">
        <UCollapsible
            v-model:open="isExpanded"
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
                                :placeholder="t('pageNumbering.rangePlaceholder')"
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
                                :placeholder="t('pageNumbering.prefixPlaceholder')"
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
                            :disabled="selectedPages.length === 0 && !pageRangeInput.trim()"
                            @click="clearAll"
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
                            class="pdf-sidebar-pages-primary-button"
                            :ui="{ base: 'justify-center text-center whitespace-nowrap' }"
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
</template>

<script setup lang="ts">
import {
    computed,
    ref,
    watch,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import type {
    IPdfPageLabelRange,
    IPdfPageRange,
    TPageLabelStyle,
} from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    formatPageRange,
    normalizePageLabelRanges,
    parsePageRangeInput,
} from '@app/utils/pdf-page-labels';

interface IProps {
    totalPages: number;
    selectedPages: number[];
    pageLabels?: string[] | null;
    pageLabelRanges?: IPdfPageLabelRange[];
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:selectedPages', pages: number[]): void;
    (e: 'update:pageRangeInput', value: string): void;
    (e: 'update:pageLabelRanges', ranges: IPdfPageLabelRange[]): void;
    (e: 'clear'): void;
}>();

const { t } = useTypedI18n();

const isExpanded = ref(false);
const ignoreRangeInputWatch = ref(false);
const ignoreSelectionWatch = ref(false);
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

    const sorted = uniq(pages)
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

const selectionRange = computed(() => deriveContiguousSelectionRange(props.selectedPages));
const hasNonContiguousSelection = computed(() => props.selectedPages.length > 0 && selectionRange.value === null);

const selectionSummary = computed(() => {
    if (props.selectedPages.length === 0) {
        return t('pageNumbering.none');
    }

    if (selectionRange.value === null) {
        return t('pageNumbering.pagesNonContiguous', { count: props.selectedPages.length });
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

function setSelectedPagesSilently(pages: number[]) {
    if (arePageListsEqual(props.selectedPages, pages)) {
        return;
    }
    ignoreSelectionWatch.value = true;
    emit('update:selectedPages', pages);
}

function setPageRangeInputSilently(value: string) {
    if (pageRangeInput.value === value) {
        return;
    }
    ignoreRangeInputWatch.value = true;
    pageRangeInput.value = value;
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

function clearAll() {
    setSelectedPagesSilently([]);
    setPageRangeInputSilently('');
    emit('clear');
}

watch(
    () => props.selectedPages,
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

defineExpose({ isExpanded });
</script>

<style scoped>
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

.pdf-sidebar-pages-button-label {
    display: block;
    width: 100%;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-error {
    margin: 0;
    font-size: 0.7rem;
    color: var(--ui-error);
}
</style>
