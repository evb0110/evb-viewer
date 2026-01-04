<template>
    <div class="pdf-search-results">
        <div
            v-if="!searchQuery"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search" />
            <span>Enter a search term</span>
        </div>
        <div
            v-else-if="results.length === 0"
            class="pdf-search-results-empty"
        >
            <UIcon name="i-lucide-search-x" />
            <span>No results found</span>
        </div>
        <div
            v-else
            class="pdf-search-results-list"
        >
            <div class="pdf-search-results-header">
                {{ results.length }} result{{ results.length === 1 ? '' : 's' }} for "{{ searchQuery }}"
            </div>
            <div
                v-for="(result, index) in results"
                :key="index"
                class="pdf-search-result"
                :class="{ 'is-active': index === currentResultIndex }"
                @click="$emit('goToResult', index)"
            >
                <div class="pdf-search-result-meta">
                    <span class="pdf-search-result-page">Page {{ result.pageIndex + 1 }}</span>
                    <span class="pdf-search-result-match">Match {{ result.matchIndex + 1 }}</span>
                </div>
                <div class="pdf-search-result-snippet">
                    <span v-if="result.excerpt.prefix" class="pdf-search-result-ellipsis">…</span>
                    <span>{{ result.excerpt.before }}</span>
                    <mark class="pdf-search-result-highlight">{{ result.excerpt.match }}</mark>
                    <span>{{ result.excerpt.after }}</span>
                    <span v-if="result.excerpt.suffix" class="pdf-search-result-ellipsis">…</span>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { IPdfSearchMatch } from '../../types/pdf';

interface IPdfSearchResultsProps {
    results: IPdfSearchMatch[];
    currentResultIndex: number;
    searchQuery: string;
}

defineProps<IPdfSearchResultsProps>();

defineEmits<{(e: 'goToResult', index: number): void;}>();
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

.pdf-search-results-list {
    display: flex;
    flex-direction: column;
}

.pdf-search-result {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background-color 0.15s;
}

.pdf-search-result:hover {
    background: var(--ui-bg-muted);
}

.pdf-search-result.is-active {
    background: var(--ui-bg-accented);
}

.pdf-search-result-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.pdf-search-result-page {
    font-size: 13px;
    font-weight: 500;
}

.pdf-search-result-match {
    font-size: 11px;
    color: var(--ui-text-muted);
}

.pdf-search-result-snippet {
    font-size: 12px;
    line-height: 1.4;
    color: var(--ui-text-muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.pdf-search-result-highlight {
    background: var(--ui-bg-accented);
    color: inherit;
    padding: 0 2px;
    border-radius: 2px;
    font-weight: 600;
}

.pdf-search-result-ellipsis {
    color: var(--ui-text-dimmed);
}
</style>
