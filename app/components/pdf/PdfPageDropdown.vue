<template>
    <div class="page-controls">
        <div class="page-controls-item">
            <UTooltip text="First Page" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevrons-left"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage <= 1"
                    class="page-controls-button"
                    aria-label="First page"
                    @click="goToFirst"
                />
            </UTooltip>
        </div>
        <div class="page-controls-item">
            <UTooltip text="Previous Page" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-left"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage <= 1"
                    class="page-controls-button"
                    aria-label="Previous page"
                    @click="goToPrevious"
                />
            </UTooltip>
        </div>

        <div class="page-controls-item">
            <UPopover v-model:open="isOpen" mode="click" :disabled="disabled || totalPages === 0">
                <button
                    ref="pageDisplayButtonRef"
                    class="page-controls-display"
                    :disabled="disabled || totalPages === 0"
                >
                    <span class="page-controls-display-value">{{ pageLabel }}</span>
                </button>

                <template #content>
                    <div class="page-dropdown">
                        <div class="page-dropdown-section">
                            <button
                                class="page-dropdown-item"
                                :disabled="currentPage <= 1"
                                @click="goToFirst"
                            >
                                <UIcon
                                    name="i-lucide-chevrons-left"
                                    class="page-dropdown-icon size-5"
                                />
                                <span class="page-dropdown-label">First page</span>
                            </button>
                            <button
                                class="page-dropdown-item"
                                :disabled="currentPage >= totalPages"
                                @click="goToLast"
                            >
                                <UIcon
                                    name="i-lucide-chevrons-right"
                                    class="page-dropdown-icon size-5"
                                />
                                <span class="page-dropdown-label">Last page</span>
                            </button>
                        </div>

                        <div class="page-dropdown-divider" />

                        <div class="page-dropdown-section">
                            <div class="page-dropdown-goto">
                                <span class="page-dropdown-goto-label">Go to page</span>
                                <div class="page-dropdown-goto-controls">
                                    <UInput
                                        ref="pageInputRef"
                                        v-model="pageInputValue"
                                        class="page-dropdown-input"
                                        type="text"
                                        size="xs"
                                        placeholder="Page # or label"
                                        @keydown.enter.prevent="commitPageInput"
                                    />
                                    <UTooltip text="Go to Page" :delay-duration="1200">
                                        <UButton
                                            icon="i-lucide-arrow-right"
                                            size="xs"
                                            variant="soft"
                                            aria-label="Go to page"
                                            @click="commitPageInput"
                                        />
                                    </UTooltip>
                                </div>
                            </div>
                        </div>

                        <div class="page-dropdown-divider" />

                        <div class="page-dropdown-section">
                            <div class="page-label-editor-header">
                                <span class="page-dropdown-goto-label">Page labels</span>
                                <UButton
                                    icon="i-lucide-plus"
                                    size="xs"
                                    variant="ghost"
                                    color="neutral"
                                    :disabled="!canEditPageLabels"
                                    @click="addRange"
                                >
                                    Add range
                                </UButton>
                            </div>
                            <div class="page-label-editor-list">
                                <div
                                    v-for="(range, index) in draftRanges"
                                    :key="`range-${index}`"
                                    class="page-label-editor-row"
                                >
                                    <div class="page-label-editor-grid">
                                        <label class="page-label-editor-label">From</label>
                                        <input
                                            class="page-label-editor-input"
                                            type="number"
                                            min="1"
                                            :max="totalPages"
                                            :value="range.startPage"
                                            @input="handleStartPageInput(index, $event)"
                                        >

                                        <label class="page-label-editor-label">Style</label>
                                        <select
                                            class="page-label-editor-select"
                                            :value="range.style ?? ''"
                                            @change="handleStyleChange(index, $event)"
                                        >
                                            <option
                                                v-for="styleOption in styleOptions"
                                                :key="styleOption.value"
                                                :value="styleOption.value"
                                            >
                                                {{ styleOption.label }}
                                            </option>
                                        </select>

                                        <label class="page-label-editor-label">Prefix</label>
                                        <input
                                            class="page-label-editor-input"
                                            type="text"
                                            :value="range.prefix"
                                            @input="handlePrefixInput(index, $event)"
                                        >

                                        <label class="page-label-editor-label">Start</label>
                                        <input
                                            class="page-label-editor-input"
                                            type="number"
                                            min="1"
                                            :disabled="range.style === null"
                                            :value="range.startNumber"
                                            @input="handleStartNumberInput(index, $event)"
                                        >
                                    </div>
                                    <div class="page-label-editor-meta">
                                        <span class="page-label-editor-preview">{{ rangePreview(range.startPage) }}</span>
                                        <UTooltip text="Remove Range" :delay-duration="1200">
                                            <UButton
                                                icon="i-lucide-trash-2"
                                                size="xs"
                                                color="neutral"
                                                variant="ghost"
                                                :disabled="draftRanges.length <= 1"
                                                aria-label="Remove range"
                                                @click="removeRange(index)"
                                            />
                                        </UTooltip>
                                    </div>
                                </div>
                            </div>
                            <div class="page-label-editor-actions">
                                <UButton
                                    size="xs"
                                    variant="ghost"
                                    color="neutral"
                                    :disabled="!canEditPageLabels"
                                    @click="resetRanges"
                                >
                                    Reset
                                </UButton>
                                <UButton
                                    size="xs"
                                    variant="soft"
                                    color="primary"
                                    :disabled="!canEditPageLabels"
                                    @click="applyRanges"
                                >
                                    Apply
                                </UButton>
                            </div>
                        </div>
                    </div>
                </template>
            </UPopover>
        </div>

        <div class="page-controls-item">
            <UTooltip text="Next Page" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-right"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                    class="page-controls-button"
                    aria-label="Next page"
                    @click="goToNext"
                />
            </UTooltip>
        </div>
        <div class="page-controls-item">
            <UTooltip text="Last Page" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevrons-right"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                    class="page-controls-button"
                    aria-label="Last page"
                    @click="goToLast"
                />
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import { nextTick } from 'vue';
import type {
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    findPageByPageLabelInput,
    formatPageIndicator,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';

interface IProps {
    modelValue: number;
    totalPages: number;
    pageLabels?: string[] | null;
    pageLabelRanges?: IPdfPageLabelRange[];
    disabled?: boolean;
}

const {
    modelValue: currentPage,
    totalPages,
    pageLabels = null,
    pageLabelRanges = [],
    disabled = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', page: number): void;
    (e: 'goToPage', page: number): void;
    (e: 'update:pageLabelRanges', ranges: IPdfPageLabelRange[]): void;
    (e: 'open'): void;
}>();

const styleOptions: Array<{
    value: '' | Exclude<TPageLabelStyle, null>;
    label: string;
}> = [
    {
        value: 'D',
        label: 'Decimal (1, 2, 3)',
    },
    {
        value: 'r',
        label: 'Roman lower (i, ii)',
    },
    {
        value: 'R',
        label: 'Roman upper (I, II)',
    },
    {
        value: 'a',
        label: 'Letters lower (a, b)',
    },
    {
        value: 'A',
        label: 'Letters upper (A, B)',
    },
    {
        value: '',
        label: 'Prefix only',
    },
];

const isOpen = ref(false);
const pageInputValue = ref(currentPage.toString());
const pageInputRef = ref<{ $el: HTMLElement } | null>(null);
const pageDisplayButtonRef = ref<HTMLButtonElement | null>(null);
const draftRanges = ref<IPdfPageLabelRange[]>([]);

const normalizedInputRanges = computed(() => normalizePageLabelRanges(pageLabelRanges, totalPages));

const effectivePageLabels = computed(() => {
    if (pageLabels && pageLabels.length === totalPages) {
        return pageLabels;
    }
    return buildPageLabelsFromRanges(totalPages, normalizedInputRanges.value);
});

const draftPreviewLabels = computed(() => buildPageLabelsFromRanges(totalPages, draftRanges.value));

const canEditPageLabels = computed(() => totalPages > 0 && !disabled);

function close() {
    isOpen.value = false;
}

defineExpose({ close });

function getCurrentInputLabel() {
    const label = effectivePageLabels.value[currentPage - 1] ?? '';
    return label.trim() || currentPage.toString();
}

function syncDraftRanges() {
    draftRanges.value = normalizedInputRanges.value.map(range => ({...range}));
}

watch(isOpen, (value) => {
    if (value) {
        emit('open');
        pageInputValue.value = getCurrentInputLabel();
        syncDraftRanges();
        void nextTick(() => {
            const input = pageInputRef.value?.$el?.querySelector('input') as HTMLInputElement | null;
            input?.focus();
            input?.select();
        });
    }
});

watch(
    () => currentPage,
    () => {
        pageInputValue.value = getCurrentInputLabel();
    },
);

watch(
    () => [
        pageLabelRanges,
        totalPages,
    ],
    () => {
        if (!isOpen.value) {
            syncDraftRanges();
        }
    },
    { deep: true },
);

const pageLabel = computed(() => {
    if (totalPages === 0) {
        return '';
    }
    const indicator = formatPageIndicator(currentPage, effectivePageLabels.value);
    return `${indicator} / ${totalPages}`;
});

function goToFirst() {
    emit('update:modelValue', 1);
    emit('goToPage', 1);
    close();
}

function goToPrevious() {
    if (currentPage > 1) {
        const newPage = currentPage - 1;
        emit('update:modelValue', newPage);
        emit('goToPage', newPage);
    }
}

function goToNext() {
    if (currentPage < totalPages) {
        const newPage = currentPage + 1;
        emit('update:modelValue', newPage);
        emit('goToPage', newPage);
    }
}

function goToLast() {
    emit('update:modelValue', totalPages);
    emit('goToPage', totalPages);
    close();
}

function commitPageInput() {
    const page = findPageByPageLabelInput(pageInputValue.value, totalPages, effectivePageLabels.value);
    if (page !== null) {
        emit('update:modelValue', page);
        emit('goToPage', page);
        close();
        return;
    }
    pageInputValue.value = getCurrentInputLabel();
}

function coerceStyle(value: string): TPageLabelStyle {
    if (!value) {
        return null;
    }
    if (value === 'D' || value === 'R' || value === 'r' || value === 'A' || value === 'a') {
        return value;
    }
    return 'D';
}

function readEventValue(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        return target.value;
    }
    return '';
}

function updateDraftStartPage(index: number, value: string) {
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed) ? parsed : 1;
    const row = draftRanges.value[index];
    if (!row) {
        return;
    }
    row.startPage = Math.max(1, Math.min(totalPages, next));
}

function updateDraftStyle(index: number, value: string) {
    const row = draftRanges.value[index];
    if (!row) {
        return;
    }
    row.style = coerceStyle(value);
    if (row.style === null) {
        row.startNumber = 1;
    }
}

function updateDraftPrefix(index: number, value: string) {
    const row = draftRanges.value[index];
    if (!row) {
        return;
    }
    row.prefix = value;
}

function updateDraftStartNumber(index: number, value: string) {
    const row = draftRanges.value[index];
    if (!row) {
        return;
    }
    const parsed = Number.parseInt(value, 10);
    row.startNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function handleStartPageInput(index: number, event: Event) {
    updateDraftStartPage(index, readEventValue(event));
}

function handleStyleChange(index: number, event: Event) {
    updateDraftStyle(index, readEventValue(event));
}

function handlePrefixInput(index: number, event: Event) {
    updateDraftPrefix(index, readEventValue(event));
}

function handleStartNumberInput(index: number, event: Event) {
    updateDraftStartNumber(index, readEventValue(event));
}

function addRange() {
    if (!canEditPageLabels.value) {
        return;
    }
    draftRanges.value.push({
        startPage: currentPage,
        style: 'D',
        prefix: '',
        startNumber: 1,
    });
    draftRanges.value = normalizePageLabelRanges(draftRanges.value, totalPages);
}

function removeRange(index: number) {
    if (!canEditPageLabels.value || draftRanges.value.length <= 1) {
        return;
    }
    draftRanges.value.splice(index, 1);
    draftRanges.value = normalizePageLabelRanges(draftRanges.value, totalPages);
}

function resetRanges() {
    if (!canEditPageLabels.value) {
        return;
    }
    draftRanges.value = [{
        startPage: 1,
        style: 'D',
        prefix: '',
        startNumber: 1,
    }];
}

function applyRanges() {
    if (!canEditPageLabels.value) {
        return;
    }
    const normalized = normalizePageLabelRanges(draftRanges.value, totalPages);
    draftRanges.value = normalized;
    emit('update:pageLabelRanges', normalized);
}

function rangePreview(page: number) {
    return formatPageIndicator(page, draftPreviewLabels.value);
}

function handleGlobalPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.page-controls')) {
        return;
    }

    const button = pageDisplayButtonRef.value;
    if (button && document.activeElement === button) {
        button.blur();
    }
}

onMounted(() => {
    window.addEventListener('pointerdown', handleGlobalPointerDown, true);
});

onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
});
</script>

<style scoped>
.page-controls {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.page-controls-item {
    display: flex;
    border-radius: 0;
}

.page-controls-item + .page-controls-item {
    border-left: 1px solid var(--ui-border);
}

.page-controls-button {
    border-radius: 0 !important;
    height: var(--toolbar-control-height, 2.25rem);
    min-width: var(--toolbar-control-height, 2.25rem);
    padding: 0.25rem;
    font-size: var(--toolbar-icon-size, 18px);
}

.page-controls-button :deep(svg) {
    width: 1.1rem;
    height: 1.1rem;
}

.page-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.5rem;
    min-width: 8rem;
    height: var(--toolbar-control-height, 2.25rem);
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
    transition: background-color 150ms ease;
}

.page-controls-display:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-controls-display:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.page-controls-display-value {
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    white-space: nowrap;
}

.page-dropdown {
    padding: 0.25rem;
    min-width: 19rem;
    max-width: 24rem;
}

.page-dropdown-section {
    display: flex;
    flex-direction: column;
}

.page-dropdown-divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.page-dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 0.375rem;
    color: var(--ui-text);
    font-size: 0.875rem;
    text-align: left;
    transition: background-color 150ms ease;
}

.page-dropdown-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-dropdown-item:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.page-dropdown-label {
    flex: 1;
}

.page-dropdown-icon {
    color: var(--ui-text-muted);
}

.page-dropdown-goto {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
}

.page-dropdown-goto-label {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}

.page-dropdown-goto-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.page-dropdown-input {
    flex: 1;
}

.page-label-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.5rem 0.5rem;
    gap: 0.5rem;
}

.page-label-editor-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 14rem;
    overflow-y: auto;
    padding: 0 0.5rem;
}

.page-label-editor-row {
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    padding: 0.5rem;
    background: var(--ui-bg-muted);
}

.page-label-editor-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.375rem 0.5rem;
}

.page-label-editor-label {
    font-size: 0.675rem;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.page-label-editor-input,
.page-label-editor-select {
    width: 100%;
    border: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    padding: 0.25rem 0.375rem;
}

.page-label-editor-input:disabled {
    opacity: 0.55;
}

.page-label-editor-meta {
    margin-top: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}

.page-label-editor-preview {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}

.page-label-editor-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.5rem;
}
</style>
