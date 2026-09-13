<template>
    <div ref="pageControlsRef" :class="['page-controls', `page-controls--compact-${effectiveCompactLevel}`]">
        <div v-if="showEdgeButtons" class="page-controls-item">
            <ToolbarButton
                icon="ph:caret-double-left"
                :tooltip="t('pageDropdown.firstPage')"
                :disabled="disabled || commandPage <= 1"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="goToFirst"
            />
        </div>
        <div v-if="showStepButtons" class="page-controls-item">
            <ToolbarButton
                icon="ph:caret-left"
                :tooltip="t('pageDropdown.previousPage')"
                :disabled="disabled || commandPage <= 1"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="goToPrevious"
            />
        </div>

        <div class="page-controls-item">
            <button
                v-if="!isEditing"
                class="page-controls-display"
                :disabled="disabled || totalPages === 0"
                :style="pageDisplayStyle"
                @click="startEditing"
            >
                <span class="page-controls-current">
                    <span class="page-controls-current-primary">{{ pageIndicatorParts.primary }}</span>
                    <span
                        v-if="pageIndicatorParts.secondary"
                        class="page-controls-current-secondary"
                    >{{ pageIndicatorParts.secondary }}</span>
                </span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-slash', { 'is-hidden': !hasPages }]"
                >/</span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-total', { 'is-hidden': !hasPages }]"
                >{{ totalPages }}</span>
            </button>
            <div v-else class="page-controls-display is-editing" :style="pageDisplayStyle">
                <span class="page-controls-current">
                    <input
                        ref="pageInputRef"
                        v-model="pageInputValue"
                        class="page-controls-inline-input"
                        @keydown.enter.prevent="commitPageInput"
                        @keydown.escape.prevent="cancelEditing"
                        @blur="commitPageInput"
                    />
                    <span
                        v-if="pageIndicatorParts.secondary"
                        class="page-controls-current-secondary"
                    >{{ pageIndicatorParts.secondary }}</span>
                </span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-slash', { 'is-hidden': !hasPages }]"
                >/</span>
                <span
                    v-if="showTotalInDisplay"
                    :class="['page-controls-total', { 'is-hidden': !hasPages }]"
                >{{ totalPages }}</span>
            </div>
        </div>

        <div v-if="showStepButtons" class="page-controls-item">
            <ToolbarButton
                icon="ph:caret-right"
                :tooltip="t('pageDropdown.nextPage')"
                :disabled="disabled || (totalPages > 0 && commandPage >= totalPages)"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="goToNext"
            />
        </div>
        <div v-if="showEdgeButtons" class="page-controls-item">
            <ToolbarButton
                icon="ph:caret-double-right"
                :tooltip="t('pageDropdown.lastPage')"
                :disabled="disabled || totalPages === 0 || commandPage >= totalPages"
                grouped
                icon-class="size-[var(--app-toolbar-icon-size)]"
                @click="goToLast"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { onClickOutside } from '@vueuse/core';
import { useClamp } from '@vueuse/math';
import type { TPdfViewMode } from '@contracts/shared';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import {
    findPageByPageLabelInput,
    getPageIndicatorLayoutMetrics,
    type TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';
import {
    getPdfPageDropdownIndicatorParts,
    getPdfPageDropdownInputLabel,
    resolvePdfPageDropdownDisplayPage,
    stepPdfPageDropdownCommand,
} from '@app/modules/pdf-viewer/engine/pdfPageDropdownModel';

const { t } = useTypedI18n();

interface IProps {
    modelValue: number;
    totalPages: number;
    open: boolean;
    pageLabels?: TDocumentPageLabelLookup;
    navigationPage?: number;
    disabled?: boolean;
    compactLevel?: number;
    viewMode?: TPdfViewMode;
}

const {
    modelValue: currentPage,
    totalPages,
    open,
    pageLabels = null,
    navigationPage = undefined,
    disabled = false,
    compactLevel = 0,
    viewMode = 'single',
} = defineProps<IProps>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    goToPage: [page: number];
}>();

const isEditing = computed({
    get: () => open,
    set: (value: boolean) => emit('update:open', value),
});
const pageInputValue = ref(currentPage.toString());
const pageInputRef = ref<HTMLInputElement | null>(null);
const pageControlsRef = ref<HTMLElement | null>(null);

const effectiveCompactLevel = useClamp(() => compactLevel, 0, 3);

const showEdgeButtons = computed(() => true);
const showStepButtons = computed(() => true);
const showTotalInDisplay = computed(() => true);
const hasPages = computed(() => totalPages > 0);
const commandPage = computed(() => resolvePdfPageDropdownDisplayPage({
    currentPage,
    navigationPage,
    totalPages,
}));
const displayPage = computed(() => commandPage.value);

const effectivePageLabels = computed<TDocumentPageLabelLookup>(() => {
    if (!pageLabels) {
        return null;
    }
    if (Array.isArray(pageLabels)) {
        return pageLabels.length === totalPages ? pageLabels : null;
    }
    return 'totalPages' in pageLabels && pageLabels.totalPages === totalPages ? pageLabels : null;
});

function getInputLabelForPage(page: number) {
    return getPdfPageDropdownInputLabel(page, effectivePageLabels.value);
}

function getCurrentInputLabel() {
    return getInputLabelForPage(displayPage.value);
}

watch(
    () => displayPage.value,
    () => {
        pageInputValue.value = getCurrentInputLabel();
    },
);

const pageIndicatorParts = computed(() => {
    return getPdfPageDropdownIndicatorParts({
        page: displayPage.value,
        pageLabels: effectivePageLabels.value,
        totalPages,
    });
});

const pageLayoutMetrics = computed(() => getPageIndicatorLayoutMetrics(
    totalPages,
    effectivePageLabels.value,
    showTotalInDisplay.value,
));

const pageDisplayStyle = computed(() => ({
    '--page-current-width-ch': `${pageLayoutMetrics.value.currentWidthCh}ch`,
    '--page-total-width-ch': `${pageLayoutMetrics.value.totalWidthCh}ch`,
    '--page-separator-width-ch': `${pageLayoutMetrics.value.separatorWidthCh}ch`,
    '--page-display-width-ch': `${pageLayoutMetrics.value.displayWidthCh}ch`,
}));

function startEditing() {
    if (disabled || totalPages === 0) {
        return;
    }
    isEditing.value = true;
    pageInputValue.value = getCurrentInputLabel();
    void nextTick(() => {
        pageInputRef.value?.focus();
        pageInputRef.value?.select();
    });
}

function cancelEditing() {
    isEditing.value = false;
    pageInputValue.value = getCurrentInputLabel();
}

function goToFirst() {
    emit('goToPage', 1);
    isEditing.value = false;
}

function goToPrevious() {
    if (commandPage.value > 1) {
        const newPage = stepPdfPageDropdownCommand(commandPage.value, viewMode, totalPages, -1);
        if (newPage === commandPage.value) {
            return;
        }
        emit('goToPage', newPage);
    }
}

function goToNext() {
    if (totalPages <= 0 || commandPage.value < totalPages) {
        const newPage = stepPdfPageDropdownCommand(commandPage.value, viewMode, totalPages, 1);
        if (newPage === commandPage.value) {
            return;
        }
        emit('goToPage', newPage);
    }
}

function goToLast() {
    emit('goToPage', totalPages);
    isEditing.value = false;
}

function commitPageInput() {
    if (!isEditing.value) {
        return;
    }
    const page = findPageByPageLabelInput(pageInputValue.value, totalPages, effectivePageLabels.value);
    if (page !== null) {
        emit('goToPage', page);
    }
    isEditing.value = false;
}

onClickOutside(pageControlsRef, () => {
    const activeElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (activeElement?.closest('.page-controls')) {
        activeElement.blur();
    }
}, { capture: true });
</script>

<style scoped>
.page-controls {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: var(--app-toolbar-segmented-radius);
    background: var(--app-toolbar-group-bg);
    overflow: hidden;
}

.page-controls-item {
    display: flex;
}

.page-controls-item :deep(.toolbar-btn) {
    width: var(--toolbar-control-height, 2.25rem);
    height: var(--toolbar-control-height, 2.25rem);
    border-radius: 0;
}

.page-controls-display {
    display: grid;
    grid-template-columns:
        var(--page-current-width-ch)
        var(--page-separator-width-ch)
        var(--page-total-width-ch);
    align-items: center;
    padding: 0 0.5rem;
    width: var(--page-display-width-ch);
    min-width: var(--page-display-width-ch);
    height: var(--toolbar-control-height, 2.25rem);
    font-family: var(--app-font-mono);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
}

.page-controls-display:disabled {
    opacity: 0.5;
}

.page-controls-display:focus {
    outline: none;
}

.page-controls-display:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.page-controls-display:not(.is-editing):hover:not(:disabled) {
    background-color: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.page-controls-current,
.page-controls-total,
.page-controls-slash,
.page-controls-inline-input {
    font-size: var(--app-text-size-body);
    font-family: var(--app-font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    white-space: nowrap;
}

.page-controls-current {
    display: inline-flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 1ch;
    text-align: right;
    min-width: var(--page-current-width-ch);
}

.page-controls-current-primary {
    color: var(--ui-text);
}

.page-controls-current-secondary,
.page-controls-slash {
    color: var(--ui-text-dimmed);
    text-align: center;
}

.page-controls-slash.is-hidden,
.page-controls-total.is-hidden {
    visibility: hidden;
}

.page-controls-total {
    color: var(--ui-text-dimmed);
    text-align: left;
    min-width: var(--page-total-width-ch);
}

.page-controls-inline-input {
    font-family: inherit;
    background: transparent;
    border: none;
    outline: none;
    flex: 1 1 auto;
    text-align: right;
    padding: 0;
    min-width: 0;
    width: auto;
}
</style>
