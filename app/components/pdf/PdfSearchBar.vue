<template>
    <div class="pdf-search-bar">
        <UInput
            ref="inputRef"
            v-model="searchQuery"
            class="pdf-search-bar__input"
            placeholder="Search in document..."
            autofocus
            @keydown.enter.exact="emit('next')"
            @keydown.shift.enter="emit('previous')"
            @keydown.escape="emit('close')"
        >
            <template #leading>
                <UIcon name="i-lucide-search" class="size-4" />
            </template>
        </UInput>

        <div class="pdf-search-bar__results">
            <USkeleton v-if="isSearching" class="pdf-search-bar__skeleton" />
            <span
                v-else-if="searchQuery && totalMatches > 0"
                class="pdf-search-bar__count"
            >
                {{ currentMatch }} of {{ totalMatches }}
            </span>
            <span
                v-else-if="searchQuery && totalMatches === 0"
                class="pdf-search-bar__count pdf-search-bar__count--empty"
            >
                No results
            </span>
        </div>

        <div class="pdf-search-bar__actions">
            <UButton
                icon="i-lucide-chevron-up"
                variant="ghost"
                color="neutral"
                size="xs"
                :disabled="currentMatch <= 1"
                @click="emit('previous')"
            />
            <UButton
                icon="i-lucide-chevron-down"
                variant="ghost"
                color="neutral"
                size="xs"
                :disabled="currentMatch >= totalMatches"
                @click="emit('next')"
            />
            <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                size="xs"
                @click="emit('close')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface IPdfSearchBarProps {
    modelValue: string;
    currentMatch: number;
    totalMatches: number;
    isSearching: boolean;
}

const props = defineProps<IPdfSearchBarProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
    (e: 'close'): void;
}>();

const inputRef = ref<{ $el: HTMLElement } | null>(null);

const searchQuery = computed({
    get: () => props.modelValue,
    set: (value: string) => {
        emit('update:modelValue', value);
        emit('search');
    },
});

function focus() {
    inputRef.value?.$el?.querySelector('input')?.focus();
}

defineExpose({ focus });
</script>

<style scoped>
.pdf-search-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
}

.pdf-search-bar__input {
    flex: 1;
    min-width: 12rem;
}

.pdf-search-bar__results {
    display: flex;
    align-items: center;
    min-width: 5rem;
    justify-content: center;
}

.pdf-search-bar__skeleton {
    width: 3rem;
    height: 1rem;
}

.pdf-search-bar__count {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--ui-text-muted);
    white-space: nowrap;
}

.pdf-search-bar__count--empty {
    color: var(--ui-text-dimmed);
}

.pdf-search-bar__actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
}
</style>
