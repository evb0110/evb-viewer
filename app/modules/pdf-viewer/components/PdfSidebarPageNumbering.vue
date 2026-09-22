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
                            :name="open ? 'i-ph-caret-down' : 'i-ph-caret-right'"
                            class="pdf-sidebar-pages-disclosure-icon size-4"
                        />
                        <UIcon
                            name="i-ph-hash"
                            class="pdf-sidebar-pages-disclosure-type-icon size-3.5"
                        />
                        <span class="pdf-sidebar-pages-title">{{ t('pageNumbering.numberPages') }}</span>
                    </span>
                </button>
            </template>

            <template #content>
                <div class="pdf-sidebar-pages-editor flex flex-col">
                    <div class="flex flex-col gap-1.5">
                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <URadioGroup
                                v-model="numberingScope"
                                name="page-label-scope"
                                :legend="t('pageNumbering.applyTo')"
                                :items="numberingScopeOptions"
                                value-key="value"
                                variant="card"
                                indicator="hidden"
                                size="xs"
                                :ui="scopeRadioGroupUi"
                            />
                        </div>

                        <!--
                            Always present: typing a range already switches the scope
                            to it, and hiding the field for the other scopes moved
                            every control below it when the scope changed.
                        -->
                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <UFormField
                                :label="t('pageNumbering.pageRange')"
                                :ui="formFieldUi"
                            >
                                <UInput
                                    id="page-label-range-input"
                                    v-model="pageRangeInput"
                                    class="w-full"
                                    size="xs"
                                    inputmode="numeric"
                                    :placeholder="t('pageNumbering.rangePlaceholder')"
                                    :color="rangeErrorMessage ? 'error' : 'primary'"
                                    :highlight="rangeErrorMessage.length > 0"
                                    :aria-invalid="rangeErrorMessage.length > 0 || undefined"
                                    aria-describedby="page-label-target-summary"
                                />
                            </UFormField>
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <UFormField
                                :label="t('pageNumbering.style')"
                                :ui="formFieldUi"
                            >
                                <USelect
                                    id="page-label-style-input"
                                    v-model="pageLabelStyleSelectValue"
                                    :items="pageLabelStyleOptions"
                                    value-key="value"
                                    class="w-full"
                                    size="xs"
                                />
                            </UFormField>
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <UFormField
                                :label="t('pageNumbering.prefix')"
                                :ui="formFieldUi"
                            >
                                <UInput
                                    id="page-label-prefix-input"
                                    v-model="pageLabelPrefix"
                                    class="w-full"
                                    size="xs"
                                    :placeholder="t('pageNumbering.prefixPlaceholder')"
                                />
                            </UFormField>
                        </div>

                        <div class="pdf-sidebar-pages-field flex flex-col gap-1">
                            <UFormField
                                :label="t('pageNumbering.startAt')"
                                :ui="formFieldUi"
                            >
                                <UInputNumber
                                    id="page-label-start-input"
                                    :model-value="pageLabelStartNumber"
                                    class="w-full"
                                    size="xs"
                                    :min="1"
                                    :step="1"
                                    :disabled="pageLabelStyle.length === 0"
                                    @update:model-value="handleStartNumberModelUpdate"
                                />
                            </UFormField>
                        </div>
                    </div>

                    <div class="flex items-center gap-1.5">
                        <span
                            id="page-label-target-summary"
                            :class="[
                                'pdf-sidebar-pages-selection-text',
                                { 'pdf-sidebar-pages-selection-text--error': rangeErrorMessage },
                            ]"
                        >{{ rangeErrorMessage || targetSummary }}</span>
                        <UButton
                            size="xs"
                            variant="link"
                            color="neutral"
                            class="pdf-sidebar-pages-clear-button"
                            :disabled="totalPages <= 0"
                            @click="clearAll"
                        >
                            {{ t('pageNumbering.clear') }}
                        </UButton>
                    </div>

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
                </div>
            </template>
        </UCollapsible>
    </div>
</template>

<script setup lang="ts">

import { uniq } from 'es-toolkit/array';
import type {
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdfContracts';
import type { IPdfPageRange } from '@app/types/pdfUi';
import {
    applyPageLabelRange,
    buildWholeDocumentPageLabelRanges,
    derivePageLabelRangesFromLabels,
    formatPageRange,
    normalizePageLabelRanges,
    PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES,
    parsePageRangeInput,
    type TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';
import { arePageNumberListsEqual } from '@app/utils/pdfPageSelection';

type TNumberingScope = 'all' | 'range' | 'selection';

interface IProps {
    totalPages: number;
    selectedPages: number[];
    pageLabels?: TDocumentPageLabelLookup | undefined;
    pageLabelRanges?: IPdfPageLabelRange[] | undefined;
}

const {
    pageLabelRanges = undefined,
    pageLabels = undefined,
    selectedPages,
    totalPages,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:selectedPages': [pages: number[]];
    'update:pageLabelRanges': [ranges: IPdfPageLabelRange[]];
    clear: [];
}>();

const { t } = useTypedI18n();

const isExpanded = ref(false);
const pendingSelectionSyncCount = ref(0);
const pendingRangeSyncCount = ref(0);
const pageRangeInput = ref('');
const numberingScope = ref<TNumberingScope>('all');
const pageLabelStyle = ref<'' | Exclude<TPageLabelStyle, null>>('D');
const pageLabelPrefix = ref('');
const pageLabelStartNumber = ref(1);
const PAGE_LABEL_STYLE_PREFIX_ONLY_VALUE = '__prefix_only__';
const formFieldUi = { label: 'pdf-sidebar-pages-label' } as const;
const scopeRadioGroupUi = {
    fieldset: 'gap-y-1',
    legend: 'pdf-sidebar-pages-label',
    item: 'min-w-0 cursor-pointer rounded-[var(--app-radius-xs)] bg-elevated px-1.5 py-1',
    label: 'min-w-0 truncate text-xs font-normal',
} as const;

const numberingScopeOptions = computed<Array<{
    value: TNumberingScope;
    label: string;
}>>(() => [
    {
        value: 'all',
        label: t('pageNumbering.scopeAll', { count: totalPages }),
    },
    {
        value: 'range',
        label: t('pageNumbering.scopeRange'),
    },
    {
        value: 'selection',
        label: t('pageNumbering.scopeSelection'),
    },
]);

const pageLabelStyleOptions = computed<Array<{
    value: Exclude<TPageLabelStyle, null> | typeof PAGE_LABEL_STYLE_PREFIX_ONLY_VALUE;
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
        value: PAGE_LABEL_STYLE_PREFIX_ONLY_VALUE,
        label: t('pageNumbering.prefixOnly'),
    },
]);
const pageLabelStyleSelectValue = computed({
    get: () => pageLabelStyle.value === ''
        ? PAGE_LABEL_STYLE_PREFIX_ONLY_VALUE
        : pageLabelStyle.value,
    set: (value: string) => {
        pageLabelStyle.value = value === PAGE_LABEL_STYLE_PREFIX_ONLY_VALUE
            ? ''
            : normalizePageLabelStyleSelectValue(value);
    },
});

const normalizedPageLabelRanges = computed(() => normalizePageLabelRanges(
    pageLabelRanges
        ?? (
            Array.isArray(pageLabels)
            && totalPages <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
            && pageLabels.length === totalPages
                ? derivePageLabelRangesFromLabels(pageLabels, totalPages)
                : []
        ),
    totalPages,
));

function buildRangePages(range: IPdfPageRange) {
    const pageCount = range.endPage - range.startPage + 1;
    if (pageCount > PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES) {
        return [];
    }
    const pages: number[] = [];
    for (let page = range.startPage; page <= range.endPage; page += 1) {
        pages.push(page);
    }
    return pages;
}

function normalizePageLabelStyleSelectValue(value: string): Exclude<TPageLabelStyle, null> {
    return value === 'D' || value === 'r' || value === 'R' || value === 'a' || value === 'A'
        ? value
        : 'D';
}

const manualRange = computed(() => parsePageRangeInput(pageRangeInput.value, totalPages));

function deriveContiguousSelectionRange(pages: number[]): IPdfPageRange | null {
    if (pages.length === 0) {
        return null;
    }

    const sorted = uniq(pages)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
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

const selectionRange = computed(() => deriveContiguousSelectionRange(selectedPages));

const allPagesRange = computed<IPdfPageRange | null>(() => {
    if (totalPages <= 0) {
        return null;
    }

    return {
        startPage: 1,
        endPage: totalPages,
    };
});

const applyTargetRange = computed(() => {
    if (numberingScope.value === 'all') {
        return allPagesRange.value;
    }

    if (numberingScope.value === 'range') {
        return pageRangeInput.value.trim().length > 0 ? manualRange.value : null;
    }

    return selectionRange.value;
});

const targetSummary = computed(() => {
    if (numberingScope.value === 'all') {
        if (totalPages <= 0) {
            return t('pageNumbering.targetNone');
        }
        return t('pageNumbering.targetAllPages', { count: totalPages });
    }

    if (numberingScope.value === 'range') {
        if (!pageRangeInput.value.trim()) {
            return t('pageNumbering.targetUnavailableRange');
        }
        if (manualRange.value === null) {
            return t('pageNumbering.targetUnavailableRange');
        }

        return t('pageNumbering.targetPages', {range: formatPageRange(manualRange.value)});
    }

    if (selectedPages.length === 0) {
        return t('pageNumbering.targetNone');
    }

    if (selectionRange.value === null) {
        return t('pageNumbering.targetUnavailableNonContiguous');
    }

    const rangeText = formatPageRange(selectionRange.value);
    return t('pageNumbering.targetSelectedPages', { range: rangeText });
});

const rangeErrorMessage = computed(() => {
    if (numberingScope.value !== 'range') {
        return '';
    }

    if (!pageRangeInput.value.trim()) {
        return '';
    }

    if (manualRange.value !== null) {
        return '';
    }

    return t('pageNumbering.rangeError');
});

function queueSelectionSyncSuppression() {
    pendingSelectionSyncCount.value += 1;
    void nextTick(() => {
        if (pendingSelectionSyncCount.value > 0) {
            pendingSelectionSyncCount.value -= 1;
        }
    });
}

function queueRangeSyncSuppression() {
    pendingRangeSyncCount.value += 1;
    void nextTick(() => {
        if (pendingRangeSyncCount.value > 0) {
            pendingRangeSyncCount.value -= 1;
        }
    });
}

function handleStartNumberModelUpdate(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
    }
    pageLabelStartNumber.value = Math.max(1, Math.trunc(value));
}

function setSelectedPagesSilently(pages: number[]) {
    if (arePageNumberListsEqual(selectedPages, pages)) {
        return;
    }
    queueSelectionSyncSuppression();
    emit('update:selectedPages', pages);
}

function setPageRangeInputSilently(value: string) {
    if (pageRangeInput.value === value) {
        return;
    }
    queueRangeSyncSuppression();
    pageRangeInput.value = value;
}


function getConfiguredPageLabelStyle(): TPageLabelStyle {
    return pageLabelStyle.value === '' ? null : pageLabelStyle.value;
}

function getConfiguredPageLabelRange(startPage: number): IPdfPageLabelRange {
    return {
        startPage,
        style: getConfiguredPageLabelStyle(),
        prefix: pageLabelPrefix.value,
        startNumber: pageLabelStartNumber.value,
    };
}

function applyPageLabelsToWholeDocument() {
    emit('update:pageLabelRanges', buildWholeDocumentPageLabelRanges(totalPages, {
        style: getConfiguredPageLabelStyle(),
        prefix: pageLabelPrefix.value,
        startNumber: pageLabelStartNumber.value,
    }));
}

function applyPageLabelsToRange(range: IPdfPageRange) {
    if (totalPages <= 0) {
        return;
    }
    emit('update:pageLabelRanges', applyPageLabelRange(
        totalPages,
        normalizedPageLabelRanges.value,
        range,
        getConfiguredPageLabelRange(1),
    ));
}

function applyToTargetRange() {
    if (applyTargetRange.value === null) {
        return;
    }

    const targetRange = applyTargetRange.value;
    if (numberingScope.value === 'all') {
        setSelectedPagesSilently([]);
        setPageRangeInputSilently('');
        applyPageLabelsToWholeDocument();
        return;
    }

    setSelectedPagesSilently(buildRangePages(targetRange));
    setPageRangeInputSilently(formatPageRange(targetRange));
    applyPageLabelsToRange(targetRange);
}

function clearAll() {
    numberingScope.value = 'all';
    setSelectedPagesSilently([]);
    setPageRangeInputSilently('');
    emit('clear');
}

watch(
    () => selectedPages.join(','),
    () => {
        const pages = selectedPages;
        if (pendingSelectionSyncCount.value > 0) {
            pendingSelectionSyncCount.value -= 1;
            return;
        }

        if (pages.length === 0) {
            if (numberingScope.value === 'selection') {
                numberingScope.value = 'all';
            }
            setPageRangeInputSilently('');
            return;
        }

        numberingScope.value = 'selection';

        if (selectionRange.value === null) {
            setPageRangeInputSilently('');
            return;
        }

        const nextRangeText = formatPageRange(selectionRange.value);
        setPageRangeInputSilently(nextRangeText);
    },
);

watch(
    () => pageRangeInput.value,
    (inputValue) => {
        if (pendingRangeSyncCount.value > 0) {
            pendingRangeSyncCount.value -= 1;
            return;
        }

        if (!inputValue.trim()) {
            if (numberingScope.value === 'range') {
                numberingScope.value = selectionRange.value === null ? 'all' : 'selection';
            }
            setSelectedPagesSilently([]);
            return;
        }

        numberingScope.value = 'range';

        if (manualRange.value === null) {
            return;
        }

        const nextPages = buildRangePages(manualRange.value);
        setSelectedPagesSilently(nextPages);
    },
);

</script>

<style scoped>
.pdf-sidebar-pages-panel {
    flex-shrink: 0;
    border-top: 1px solid var(--ui-border);
    padding: var(--app-sidebar-content-padding);
    background: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
}

.pdf-sidebar-pages-collapsible {
    display: flex;
    flex-direction: column;
    gap: var(--app-sidebar-row-gap);
}

.pdf-sidebar-pages-disclosure {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--app-sidebar-row-gap);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
    background: transparent;
    color: var(--ui-text);
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    font-size: var(--app-sidebar-caption-font-size);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}

.pdf-sidebar-pages-disclosure-main {
    display: inline-flex;
    align-items: center;
    gap: var(--app-sidebar-row-gap);
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
    gap: var(--app-sidebar-row-gap);
    padding-top: var(--app-space-lg);
}

.pdf-sidebar-pages-title {
    margin: 0;
    font-size: var(--app-sidebar-row-font-size);
    font-weight: 700;
    color: inherit;
}

.pdf-sidebar-pages-field {
    min-width: 0;
}

.pdf-sidebar-pages-label,
:deep(.pdf-sidebar-pages-label) {
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.pdf-sidebar-pages-selection-text {
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-muted);
    line-height: 1.3;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.pdf-sidebar-pages-clear-button {
    flex-shrink: 0;
    font-size: var(--app-sidebar-caption-font-size);
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

.pdf-sidebar-pages-selection-text--error {
    color: var(--ui-error);
}
</style>
