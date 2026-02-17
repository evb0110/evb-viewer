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
            class="pdf-search-results-list-shell"
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
            <div
                v-bind="containerProps"
                class="pdf-search-results-list app-scrollbar"
            >
                <div
                    v-bind="wrapperProps"
                    class="pdf-search-results-list-inner"
                >
                    <PdfSearchResultItem
                        v-for="entry in virtualResults"
                        :key="entry.index"
                        :result="entry.data"
                        :is-active="entry.index === currentResultIndex"
                        :page-labels="pageLabels"
                        @click="$emit('goToResult', entry.index)"
                    />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    watch,
} from 'vue';
import { useVirtualList } from '@vueuse/core';
import type { IPdfSearchMatch } from '@app/types/pdf';
import PdfSearchResultItem from '@app/components/pdf/PdfSearchResultItem.vue';

const { t } = useTypedI18n();

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

const SEARCH_RESULT_ITEM_HEIGHT = 72;

const resultsForVirtualization = computed(() => props.results);
const {
    list: virtualResults,
    containerProps,
    wrapperProps,
    scrollTo,
} = useVirtualList(resultsForVirtualization, {
    itemHeight: SEARCH_RESULT_ITEM_HEIGHT,
    overscan: 10,
});

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

watch(
    () => [
        props.currentResultIndex,
        props.results.length,
    ] as const,
    async ([
        nextIndex,
        resultCount,
    ]) => {
        if (resultCount <= 0 || nextIndex < 0 || nextIndex >= resultCount) {
            return;
        }

        await nextTick();
        scrollTo(nextIndex);
    },
    { flush: 'post' },
);
</script>

<style scoped>
.pdf-search-results {
    display: flex;
    flex-direction: column;
    min-height: 100%;
}

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

.pdf-search-results-list-shell {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
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
    flex: 1;
    min-height: 0;
    overflow: auto;
}

.pdf-search-results-list-inner {
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
