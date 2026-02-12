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
                        <div class="page-dropdown-goto">
                            <span class="page-dropdown-goto-label">{{ t('pageDropdown.goToPage') }}</span>
                            <div class="page-dropdown-goto-controls">
                                <UInput
                                    ref="pageInputRef"
                                    v-model="pageInputValue"
                                    class="page-dropdown-input"
                                    type="text"
                                    size="sm"
                                    :placeholder="t('pageDropdown.pageInputPlaceholder')"
                                    @keydown.enter.prevent="commitPageInput"
                                />
                                <UButton
                                    icon="i-lucide-arrow-right"
                                    size="sm"
                                    variant="soft"
                                    :aria-label="t('pageDropdown.goToPage')"
                                    @click="commitPageInput"
                                />
                            </div>
                        </div>
                    </div>
                </template>
            </UPopover>
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

const isOpen = ref(false);
const pageInputValue = ref(currentPage.toString());
const pageInputRef = ref<{ $el: HTMLElement } | null>(null);
const pageDisplayButtonRef = ref<HTMLButtonElement | null>(null);

const effectivePageLabels = computed(() => {
    if (pageLabels && pageLabels.length === totalPages) {
        return pageLabels;
    }

    return Array.from({ length: totalPages }, (_, index) => String(index + 1));
});

function close() {
    isOpen.value = false;
}

defineExpose({ close });

function getCurrentInputLabel() {
    const label = effectivePageLabels.value[currentPage - 1] ?? '';
    return label.trim() || currentPage.toString();
}

watch(isOpen, (value) => {
    if (value) {
        emit('open');
        pageInputValue.value = getCurrentInputLabel();
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
    padding: 0.375rem;
    min-width: 9rem;
}

.page-dropdown-goto {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.125rem 0.25rem;
}

.page-dropdown-goto-label {
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--ui-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
}

.page-dropdown-goto-controls {
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

.page-dropdown-input {
    flex: 1;
    min-width: 0;
}
</style>
