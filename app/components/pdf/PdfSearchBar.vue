<template>
    <div class="pdf-search-bar">
        <UInput
            ref="inputRef"
            v-model="searchQuery"
            class="pdf-search-bar__input"
            placeholder="Search..."
            autofocus
            @keydown.enter.exact="emit('next')"
            @keydown.shift.enter="emit('previous')"
        >
            <template #leading>
                <UIcon name="i-lucide-search" class="size-4" />
            </template>
            <template #trailing>
                <UTooltip v-if="searchQuery" text="Clear Search" :delay-duration="1200">
                    <UButton
                        icon="i-lucide-x"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        class="pdf-search-bar__clear"
                        aria-label="Clear search"
                        @click="clearQuery"
                    />
                </UTooltip>
            </template>
        </UInput>

        <div class="pdf-search-bar__actions">
            <UTooltip text="Previous Match" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-up"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    :disabled="totalMatches === 0"
                    aria-label="Previous match"
                    @click="emit('previous')"
                />
            </UTooltip>
            <UTooltip text="Next Match" :delay-duration="1200">
                <UButton
                    icon="i-lucide-chevron-down"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    :disabled="totalMatches === 0"
                    aria-label="Next match"
                    @click="emit('next')"
                />
            </UTooltip>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    ref,
} from 'vue';

interface IProps {
    modelValue: string;
    totalMatches: number;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'search'): void;
    (e: 'next'): void;
    (e: 'previous'): void;
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

function clearQuery() {
    if (!searchQuery.value) {
        return;
    }
    searchQuery.value = '';
    focus();
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
    min-width: 0;
}

.pdf-search-bar__clear {
    min-width: auto;
    padding-inline: 0.25rem;
}

.pdf-search-bar__actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex-shrink: 0;
}
</style>
