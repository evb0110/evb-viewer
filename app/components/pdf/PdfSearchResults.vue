<template>
    <div class="pdf-search-results">
        <div
            v-if="isSearching"
            class="pdf-search-results-status"
        >
            <UIcon name="i-lucide-loader-2" class="pdf-search-results-spinner size-4" />
            <span>
                Searching…
                <template v-if="progressText">
                    ({{ progressText }} pages)
                </template>
            </span>
        </div>
        <div
            v-if="!trimmedQuery"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search" />
            <span>Enter a search term</span>
        </div>
        <div
            v-else-if="isQueryTooShort"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-type" />
            <span>Type at least {{ minQueryLength }} characters</span>
        </div>
        <div
            v-else-if="!isSearching && results.length === 0"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search-x" />
            <span>No results found</span>
        </div>
        <div
            v-else-if="results.length > 0"
            class="pdf-search-results-list"
        >
            <div class="pdf-search-results-header">
                {{ results.length }} result{{ results.length === 1 ? '' : 's' }} for "{{ trimmedQuery }}"
                <div
                    v-if="isTruncated"
                    class="pdf-search-results-truncated"
                >
                    Showing first {{ results.length }} results — keep typing to narrow
                </div>
            </div>
            <PdfSearchResultItem
                v-for="(result, index) in results"
                :key="index"
                :result="result"
                :is-active="index === currentResultIndex"
                @click="$emit('goToResult', index)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IPdfSearchMatch } from 'app/types/pdf';
import PdfSearchResultItem from './PdfSearchResultItem.vue';

interface IProps {
    results: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    isSearching?: boolean;
    searchProgress?: {
        processed: number;
        total: number;
    };
    isTruncated?: boolean;
    minQueryLength?: number;
}

const props = defineProps<IProps>();

defineEmits<{(e: 'goToResult', index: number): void;}>();

const trimmedQuery = computed(() => props.searchQuery.trim());

const minQueryLength = computed(() => props.minQueryLength ?? 0);

const isQueryTooShort = computed(() => {
    const min = minQueryLength.value;
    if (!min || !trimmedQuery.value) {
        return false;
    }
    return trimmedQuery.value.length < min;
});

const isTruncated = computed(() => props.isTruncated ?? false);

const progressText = computed(() => {
    if (!props.searchProgress || props.searchProgress.total === 0) {
        return '';
    }

    const total = props.searchProgress.total;
    const processed = Math.min(props.searchProgress.processed, total);
    return `${processed}/${total}`;
});
</script>

<style scoped>
.pdf-search-results-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--ui-text-muted);
    text-align: center;
}

.pdf-search-results-header {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
}

.pdf-search-results-truncated {
    margin-top: 4px;
    font-size: 11px;
    color: var(--ui-text-dimmed);
}

.pdf-search-results-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: var(--ui-text-muted);
    border-bottom: 1px solid var(--ui-border);
}

.pdf-search-results-spinner {
    animation: pdf-search-spin 1s linear infinite;
}

.pdf-search-results-list {
    display: flex;
    flex-direction: column;
}

@keyframes pdf-search-spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
