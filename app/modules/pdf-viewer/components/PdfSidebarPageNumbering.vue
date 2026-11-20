<template>
    <div class="pdf-sidebar-pages-panel app-panel-scroll app-scrollbar">
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
                                    :model-value="pageRangeText"
                                    class="w-full"
                                    size="xs"
                                    inputmode="numeric"
                                    :placeholder="t('pageNumbering.rangePlaceholder')"
                                    :color="rangeErrorMessage ? 'error' : 'primary'"
                                    :highlight="rangeErrorMessage.length > 0"
                                    :aria-invalid="rangeErrorMessage.length > 0 || undefined"
                                    aria-describedby="page-label-target-summary"
                                    @update:model-value="updateRangeText"
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

import {admitPdfPageLabelStartNumber} from '@contracts/pdfPageLabels';
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
import {
    createEmptyPageSelection,
    createRangePageSelection,
    iteratePageSelectionRanges,
    pageSelectionCount,
    type TPageSelection,
} from '@app/utils/pdfPageSelection';

type TNumberingScope = 'all' | 'range' | 'selection';

/**
 * What the user last set in this panel, bound to the selection object it
 * left the view with. Any other selection object means the selection changed
 * elsewhere, which ends the draft and moves the scope to that selection.
 */
interface INumberingTarget {
    scope: TNumberingScope;
    /** Typed or applied range text; `null` shows the selection's range. */
    rangeDraft: string | null;
    selection: TPageSelection | null;
}

interface IProps {
    totalPages: number;
    selectedPageSelection: TPageSelection | null;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    pageLabelRanges?: IPdfPageLabelRange[] | undefined;
}

const {
    pageLabelRanges = undefined,
    pageLabels = undefined,
    selectedPageSelection,
    totalPages,
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:selectedPageSelection': [selection: TPageSelection];
    'update:pageLabelRanges': [ranges: IPdfPageLabelRange[]];
    clear: [];
}>();

const { t } = useTypedI18n();
const {presentNoticeToast} = useFailureToast();

const isExpanded = ref(false);
const target = shallowRef<INumberingTarget>({
    scope: 'all',
    rangeDraft: null,
    selection: null,
});
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
        handleStartNumberModelUpdate(pageLabelStartNumber.value);
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

function normalizePageLabelStyleSelectValue(value: string): Exclude<TPageLabelStyle, null> {
    return value === 'D' || value === 'r' || value === 'R' || value === 'a' || value === 'A'
        ? value
        : 'D';
}

const selectionCount = computed(() => (selectedPageSelection ? pageSelectionCount(selectedPageSelection) : 0));

/** The selection as one contiguous range, or `null` when it is empty or has gaps. */
const selectionRange = computed<IPdfPageRange | null>(() => {
    if (!selectedPageSelection) {
        return null;
    }
    const ranges = iteratePageSelectionRanges(selectedPageSelection);
    const first = ranges.next();
    return first.done || !ranges.next().done
        ? null
        : {
            startPage: first.value.startPage,
            endPage: first.value.endPage,
        };
});

const isTargetCurrent = computed(() => target.value.selection === selectedPageSelection);

const numberingScope = computed<TNumberingScope>({
    get: () => {
        if (isTargetCurrent.value) {
            return target.value.scope;
        }
        return selectionCount.value > 0 ? 'selection' : 'all';
    },
    set: (scope) => {
        target.value = {
            scope,
            rangeDraft: isTargetCurrent.value ? target.value.rangeDraft : null,
            selection: selectedPageSelection,
        };
    },
});

const pageRangeText = computed(() => {
    const draft = isTargetCurrent.value ? target.value.rangeDraft : null;
    if (draft !== null) {
        return draft;
    }
    return selectionRange.value ? formatPageRange(selectionRange.value) : '';
});

const manualRange = computed(() => parsePageRangeInput(pageRangeText.value, totalPages));

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
        return pageRangeText.value.trim().length > 0 ? manualRange.value : null;
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
        if (!pageRangeText.value.trim()) {
            return t('pageNumbering.targetUnavailableRange');
        }
        if (manualRange.value === null) {
            return t('pageNumbering.targetUnavailableRange');
        }

        return t('pageNumbering.targetPages', {range: formatPageRange(manualRange.value)});
    }

    if (selectionCount.value === 0) {
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

    if (!pageRangeText.value.trim()) {
        return '';
    }

    if (manualRange.value !== null) {
        return '';
    }

    return t('pageNumbering.rangeError');
});

function handleStartNumberModelUpdate(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return;
    }
    const admitted = admitPdfPageLabelStartNumber(getConfiguredPageLabelStyle(), value);
    pageLabelStartNumber.value = admitted;
    if (admitted !== value) {
        presentNoticeToast({
            tone: 'warning',
            title: t('pageNumbering.startAdjusted', {value: admitted}),
        });
    }
}

/**
 * Makes `range` (or nothing, for `null`) the view's selection and returns the
 * selection object the view holds afterwards.
 */
function selectRange(range: IPdfPageRange | null): TPageSelection | null {
    const isUnchanged = range === null
        ? selectionCount.value === 0
        : selectionRange.value?.startPage === range.startPage && selectionRange.value.endPage === range.endPage;
    if (isUnchanged && selectedPageSelection) {
        return selectedPageSelection;
    }
    const selection = range === null
        ? createEmptyPageSelection(totalPages)
        : createRangePageSelection(totalPages, range.startPage, range.endPage);
    emit('update:selectedPageSelection', selection);
    return selection;
}

/** The range field's input: keeps the text and selects every valid range as it is typed. */
function updateRangeText(text: string) {
    if (!text.trim()) {
        const scope = numberingScope.value === 'range'
            ? (selectionRange.value === null ? 'all' : 'selection')
            : numberingScope.value;
        target.value = {
            scope,
            rangeDraft: text,
            selection: selectRange(null),
        };
        return;
    }
    const range = parsePageRangeInput(text, totalPages);
    target.value = {
        scope: 'range',
        rangeDraft: text,
        selection: range === null ? selectedPageSelection : selectRange(range),
    };
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
    const scope = numberingScope.value;
    if (scope === 'all') {
        target.value = {
            scope,
            rangeDraft: null,
            selection: selectRange(null),
        };
        applyPageLabelsToWholeDocument();
        return;
    }

    target.value = {
        scope,
        rangeDraft: formatPageRange(targetRange),
        selection: selectRange(targetRange),
    };
    applyPageLabelsToRange(targetRange);
}

/** Clears the selection through the parent; an empty selection shows all pages. */
function clearAll() {
    target.value = {
        scope: 'all',
        rangeDraft: null,
        selection: selectedPageSelection,
    };
    emit('clear');
}

</script>

<style scoped>
/* In a short window the panel shrinks, leaving the thumbnail rail its
   minimum height, and scrolls so Apply numbering stays in reach. */
.pdf-sidebar-pages-panel {
    flex: 0 1 auto;
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
