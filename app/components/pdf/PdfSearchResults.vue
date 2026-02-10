<template>
    <div class="pdf-search-results">
        <div
            v-if="isSearching"
            class="pdf-search-results-status"
        >
            <UIcon name="i-lucide-loader-2" class="pdf-search-results-spinner size-4" />
            <span>
                {{ t('searchResults.searching') }}
                <template v-if="progressText">
                    ({{ progressText }})
                </template>
            </span>
        </div>
        <div
            v-if="!trimmedQuery"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search" />
            <span>{{ t('searchResults.enterSearchTerm') }}</span>
        </div>
        <div
            v-else-if="isQueryTooShort"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-type" />
            <span>{{ t('searchResults.typeMinChars', { count: minQueryLength }) }}</span>
        </div>
        <div
            v-else-if="!isSearching && results.length === 0"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search-x" />
            <span>{{ t('searchResults.noResults') }}</span>
        </div>
        <div
            v-else-if="results.length > 0"
            class="pdf-search-results-list"
        >
            <div class="pdf-search-results-header">
                {{ t('searchResults.resultCount', { count: results.length }) }} {{ t('searchResults.forQuery', { query: trimmedQuery }) }}
                <div
                    v-if="isTruncated"
                    class="pdf-search-results-truncated"
                >
                    {{ t('searchResults.showingFirst', { count: results.length }) }}
                </div>
            </div>
            <PdfSearchResultItem
                v-for="(result, index) in results"
                :key="index"
                :result="result"
                :is-active="index === currentResultIndex"
                :page-labels="pageLabels"
                @click="$emit('goToResult', index)"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { IPdfSearchMatch } from '@app/types/pdf';
import PdfSearchResultItem from '@app/components/pdf/PdfSearchResultItem.vue';

const { t } = useI18n();

interface IProps {
    results: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
    pageLabels?: string[] | null;
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
    return t('searchResults.pagesProgress', {
        processed,
        total, 
    });
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
