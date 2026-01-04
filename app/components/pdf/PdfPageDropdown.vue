<template>
    <UPopover v-model:open="isOpen" mode="click" :disabled="disabled || totalPages === 0">
        <UButton
            icon="i-lucide-book-open"
            variant="ghost"
            color="neutral"
            :disabled="disabled || totalPages === 0"
            class="page-dropdown-trigger"
        >
            <span class="page-dropdown-trigger__label">{{ pageLabel }}</span>
        </UButton>

        <template #content>
            <div class="page-dropdown">
                <div class="page-dropdown__section">
                    <button
                        class="page-dropdown__item"
                        :disabled="currentPage <= 1"
                        @click="goToPrevious"
                    >
                        <UIcon
                            name="i-lucide-chevron-left"
                            class="page-dropdown__icon size-5"
                        />
                        <span class="page-dropdown__label">Previous</span>
                    </button>
                    <button
                        class="page-dropdown__item"
                        :disabled="currentPage >= totalPages"
                        @click="goToNext"
                    >
                        <UIcon
                            name="i-lucide-chevron-right"
                            class="page-dropdown__icon size-5"
                        />
                        <span class="page-dropdown__label">Next</span>
                    </button>
                </div>

                <div class="page-dropdown__divider" />

                <div class="page-dropdown__section">
                    <button
                        class="page-dropdown__item"
                        :disabled="currentPage <= 1"
                        @click="goToFirst"
                    >
                        <UIcon
                            name="i-lucide-chevrons-left"
                            class="page-dropdown__icon size-5"
                        />
                        <span class="page-dropdown__label">First</span>
                    </button>
                    <button
                        class="page-dropdown__item"
                        :disabled="currentPage >= totalPages"
                        @click="goToLast"
                    >
                        <UIcon
                            name="i-lucide-chevrons-right"
                            class="page-dropdown__icon size-5"
                        />
                        <span class="page-dropdown__label">Last</span>
                    </button>
                </div>

                <div class="page-dropdown__divider" />

                <div class="page-dropdown__section">
                    <div class="page-dropdown__goto">
                        <span class="page-dropdown__goto-label">Go to page</span>
                        <div class="page-dropdown__goto-controls">
                            <UInput
                                v-model="pageInputValue"
                                class="page-dropdown__input"
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
.page-dropdown-trigger__label {
    font-variant-numeric: tabular-nums;
    min-width: 7ch;
    display: inline-block;
    text-align: center;
}

.page-dropdown {
    padding: 0.25rem;
    min-width: 12rem;
}

.page-dropdown__section {
    display: flex;
    flex-direction: column;
}

.page-dropdown__divider {
    height: 1px;
    background-color: var(--ui-border);
    margin: 0.25rem 0;
}

.page-dropdown__item {
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

.page-dropdown__item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-dropdown__item:hover:not(:disabled) {
    background-color: var(--ui-bg-elevated);
}

.page-dropdown__label {
    flex: 1;
}

.page-dropdown__icon {
    color: var(--ui-text-muted);
}

.page-dropdown__goto {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
}

.page-dropdown__goto-label {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
}

.page-dropdown__goto-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.page-dropdown__input {
    flex: 1;
}

.page-dropdown__input :deep(input) {
    text-align: center;
}
</style>
