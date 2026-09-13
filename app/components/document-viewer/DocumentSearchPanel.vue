<template>
    <div class="document-search-panel">
        <div class="document-search-panel__header">
            <DocumentSearchBar
                ref="searchBarRef"
                v-model="searchQuery"
                :options="searchOptions"
                :total-matches="results.length"
                @update:options="searchOptions = $event"
                @search="runSearch"
                @next="session.navigate('next')"
                @previous="session.navigate('previous')"
            />
        </div>
        <DocumentSearchResults
            :results="results"
            :current-result-index="currentResultIndex"
            :current-result-navigation-id="currentResultNavigationId"
            :search-query="submittedQuery"
            :page-labels="pageLabels"
            :is-searching="isSearching"
            :search-error="searchError"
            :search-progress="searchProgress"
            :is-truncated="isTruncated"
            :min-query-length="minQueryLength"
            @go-to-result="session.select"
        />
    </div>
</template>

<script setup lang="ts">
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import type {
    IDocumentSearchSession, TDocumentPageLabelLookup,  
} from '@app/modules/document-viewer/public';
import DocumentSearchBar from '@app/components/document-viewer/DocumentSearchBar.vue';
import DocumentSearchResults from '@app/components/document-viewer/DocumentSearchResults.vue';

const {
    session,
    isActive = false,
    focusRequest = 0,
    pageLabels = null,
} = defineProps<{
    session: IDocumentSearchSession;
    isActive?: boolean;
    focusRequest?: number;
    pageLabels?: TDocumentPageLabelLookup;
}>();

const searchBarRef = ref<{focus: () => void} | null>(null);
const searchQuery = computed({
    get: () => session.query.value,
    set: session.setQuery,
});
const searchOptions = computed({
    get: () => session.options.value,
    set: (value: IResolvedSearchMatchOptions) => { session.setOptions(value); },
});
const submittedQuery = computed(() => session.submittedQuery.value);
const results = computed(() => session.results.value);
const currentResultIndex = computed(() => session.currentResultIndex.value);
const currentResultNavigationId = computed(() => session.currentResultNavigationId.value);
const isSearching = computed(() => session.isSearching.value);
const searchError = computed(() => session.error.value);
const searchProgress = computed(() => session.progress.value);
const isTruncated = computed(() => session.isTruncated.value);
const minQueryLength = computed(() => session.minQueryLength.value);

function focus() {
    searchBarRef.value?.focus();
}

function runSearch() {
    void session.run();
}

watch(
    () => [
        isActive,
        focusRequest,
    ] as const,
    async ([isActive], previous) => {
        if (!isActive || (previous && previous[0] && previous[1] === focusRequest)) {
            return;
        }
        await nextTick();
        focus();
    },
    {immediate: true},
);

defineExpose({focus});
</script>

<style scoped>
.document-search-panel {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
}

.document-search-panel__header {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--ui-border);
    background: inherit;
}
</style>
