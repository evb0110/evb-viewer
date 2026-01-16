<template>
    <div class="page-controls">
        <UButton
            icon="i-lucide-chevron-left"
            variant="ghost"
            color="neutral"
            size="sm"
            :disabled="disabled || totalPages === 0 || currentPage <= 1"
            class="page-controls-btn"
            @click="goToPrevious"
        />

        <UPopover v-model:open="isOpen" mode="click" :disabled="disabled || totalPages === 0">
            <button
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
                                    v-model="pageInputValue"
                                    class="page-dropdown-input"
                                    type="number"
                                    inputmode="numeric"
                                    size="xs"
                                    min="1"
                                    :max="totalPages"
                                    @keydown.enter.prevent="commitPageInput"
                                />
                                <UButton
                                    size="xs"
                                    variant="soft"
                                    @click="commitPageInput"
                                >
                                    Go
                                </UButton>
                            </div>
                        </div>
                    </div>
                </div>
            </template>
        </UPopover>

        <UButton
            icon="i-lucide-chevron-right"
            variant="ghost"
            color="neutral"
            size="sm"
            :disabled="disabled || totalPages === 0 || currentPage >= totalPages"
            class="page-controls-btn"
            @click="goToNext"
        />
    </div>
</template>

<script setup lang="ts">
interface IProps {
    modelValue: number;
    totalPages: number;
    disabled?: boolean;
}

const {
    modelValue: currentPage,
    totalPages,
    disabled = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', page: number): void;
    (e: 'goToPage', page: number): void;
    (e: 'open'): void;
}>();

const isOpen = ref(false);
const pageInputValue = ref(currentPage.toString());

function close() {
    isOpen.value = false;
}

defineExpose({ close });

watch(isOpen, (value) => {
    if (value) {
        emit('open');
    }
});

watch(
    () => currentPage,
    (value) => {
        pageInputValue.value = value.toString();
    },
);

const pageLabel = computed(() => {
    if (totalPages === 0) {
        return '';
    }
    const totalDigits = totalPages.toString().length;
    const paddedCurrent = currentPage
        .toString()
        .padStart(totalDigits, '\u2007');
    return `${paddedCurrent} / ${totalPages}`;
});

function goToFirst() {
    emit('update:modelValue', 1);
    emit('goToPage', 1);
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
}

function commitPageInput() {
    const parsed = Number.parseInt(pageInputValue.value, 10);

    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
        emit('update:modelValue', parsed);
        emit('goToPage', parsed);
        close();
    } else {
        pageInputValue.value = currentPage.toString();
    }
}
</script>

<style scoped>
.page-controls {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
}

.page-controls-btn {
    border-radius: 0;
}

.page-controls-btn:first-child {
    border-radius: 0.375rem 0 0 0.375rem;
}

.page-controls-btn:last-child {
    border-radius: 0 0.375rem 0.375rem 0;
}

.page-controls-display {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.5rem;
    min-width: 5.5rem;
    height: 2rem;
    background: transparent;
    border: none;
    border-left: 1px solid var(--ui-border);
    border-right: 1px solid var(--ui-border);
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
}

.page-dropdown {
    padding: 0.25rem;
    min-width: 12rem;
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

.page-dropdown-input :deep(input) {
    text-align: center;
}
</style>
