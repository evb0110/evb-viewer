<template>
    <div class="page-controls">
        <div class="page-controls-item">
            <UTooltip :text="t('pageDropdown.firstPage')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevrons-left"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage <= 1"
                    class="page-controls-button"
                    :aria-label="t('pageDropdown.firstPage')"
                    @click="goToFirst"
                />
            </UTooltip>
        </div>
        <div class="page-controls-item">
            <UTooltip :text="t('pageDropdown.previousPage')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-left"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage <= 1"
                    class="page-controls-button"
                    :aria-label="t('pageDropdown.previousPage')"
                    @click="goToPrevious"
                />
            </UTooltip>
        </div>

        <div class="page-controls-item">
            <button
                v-if="!isEditing"
                class="page-controls-display"
                :disabled="disabled || totalPages === 0"
                @click="startEditing"
            >
                <span class="page-controls-indicator">{{ pageIndicator }}</span>
                <span class="page-controls-separator">&nbsp;/ {{ totalPages }}</span>
            </button>
            <div v-else class="page-controls-display is-editing">
                <input
                    ref="pageInputRef"
                    v-model="pageInputValue"
                    class="page-controls-inline-input"
                    :style="{ width: inputWidth }"
                    @keydown.enter.prevent="commitPageInput"
                    @keydown.escape.prevent="cancelEditing"
                    @blur="commitPageInput"
                />
                <span class="page-controls-separator">&nbsp;/ {{ totalPages }}</span>
            </div>
        </div>

        <div class="page-controls-item">
            <UTooltip :text="t('pageDropdown.nextPage')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-right"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                    class="page-controls-button"
                    :aria-label="t('pageDropdown.nextPage')"
                    @click="goToNext"
                />
            </UTooltip>
        </div>
        <div class="page-controls-item">
            <UTooltip :text="t('pageDropdown.lastPage')" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevrons-right"
                    variant="ghost"
                    color="neutral"
                    :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
                    class="page-controls-button"
                    :aria-label="t('pageDropdown.lastPage')"
                    @click="goToLast"
                />
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import { nextTick } from 'vue';
import {
    findPageByPageLabelInput,
    formatPageIndicator,
} from '@app/utils/pdf-page-labels';

const { t } = useI18n();

interface IProps {
    modelValue: number;
    totalPages: number;
    pageLabels?: string[] | null;
    disabled?: boolean;
}

const {
    modelValue: currentPage,
    totalPages,
    pageLabels = null,
    disabled = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', page: number): void;
    (e: 'goToPage', page: number): void;
    (e: 'open'): void;
}>();

const isEditing = ref(false);
const pageInputValue = ref(currentPage.toString());
const pageInputRef = ref<HTMLInputElement | null>(null);

const effectivePageLabels = computed(() => {
    if (pageLabels && pageLabels.length === totalPages) {
        return pageLabels;
    }

    return Array.from({ length: totalPages }, (_, index) => String(index + 1));
});

function close() {
    isEditing.value = false;
}

defineExpose({ close });

function getCurrentInputLabel() {
    const label = effectivePageLabels.value[currentPage - 1] ?? '';
    return label.trim() || currentPage.toString();
}

const inputWidth = computed(() => {
    const chars = Math.max(pageInputValue.value.length, 1);
    return `${chars}ch`;
});

watch(
    () => currentPage,
    () => {
        pageInputValue.value = getCurrentInputLabel();
    },
);

const pageIndicator = computed(() => {
    if (totalPages === 0) {
        return '';
    }
    return formatPageIndicator(currentPage, effectivePageLabels.value);
});

function startEditing() {
    if (disabled || totalPages === 0) {
        return;
    }
    emit('open');
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
    if (!isEditing.value) {
        return;
    }
    const page = findPageByPageLabelInput(pageInputValue.value, totalPages, effectivePageLabels.value);
    if (page !== null) {
        emit('update:modelValue', page);
        emit('goToPage', page);
    }
    isEditing.value = false;
}

function handleGlobalPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.page-controls')) {
        return;
    }

    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement?.closest('.page-controls')) {
        activeElement.blur();
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

.page-controls-item :deep(> *) {
    display: flex;
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
    min-width: 5.5rem;
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

.page-controls-display:not(.is-editing):hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.page-controls-indicator,
.page-controls-inline-input,
.page-controls-separator {
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text);
    white-space: nowrap;
}

.page-controls-inline-input {
    font-family: inherit;
    background: transparent;
    border: none;
    outline: none;
    text-align: right;
    padding: 0;
    min-width: 1ch;
}
</style>
