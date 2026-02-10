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
import {
    findPageByPageLabelInput,
    formatPageIndicator,
} from '@app/utils/pdf-page-labels';

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
    min-width: 16rem;
    max-width: 18rem;
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
</style>
