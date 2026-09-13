<template>
    <button
        type="button"
        class="document-search-result flex flex-col gap-1"
        :class="{ 'is-active': isActive }"
        :aria-current="isActive ? 'true' : undefined"
        @click="activate"
        @keydown.enter.prevent="activate"
        @keydown.space.prevent="activate"
    >
        <div class="document-search-result-meta">
            <span v-if="showPageLabel" class="document-search-result-page">{{ t('searchResults.page', { page: pageIndicator }) }}</span>
            <span class="document-search-result-match">{{ t('searchResults.match', { index: matchIndicator }) }}</span>
        </div>
        <div
            v-if="result.excerpt"
            class="document-search-result-snippet"
        >
            <template v-if="result.excerpt.prefix">…</template>
            <span>{{ result.excerpt.before }}</span>
            <mark class="document-search-result-highlight">{{ result.excerpt.match }}</mark>
            <span>{{ result.excerpt.after }}</span>
            <template v-if="result.excerpt.suffix">…</template>
        </div>
    </button>
</template>

<script setup lang="ts">
import {
    formatPageIndicatorWithOptions,
    type IDocumentSearchMatch,
    type TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';

const { t } = useTypedI18n();

interface IProps {
    result: IDocumentSearchMatch;
    isActive: boolean;
    pageLabels?: TDocumentPageLabelLookup | undefined;
    showPageLabel?: boolean | undefined;
}

const {
    pageLabels = undefined,
    result,
    showPageLabel: showPageLabelProp = true,
} = defineProps<IProps>();
const emit = defineEmits<{activate: [];}>();

const showPageLabel = computed(() => showPageLabelProp);
const pageIndicator = computed(() => formatPageIndicatorWithOptions(result.pageIndex + 1, pageLabels ?? null));
const matchIndicator = computed(() => (result.pageMatchIndex ?? result.matchIndex) + 1);

function activate() {
    emit('activate');
}
</script>

<style lang="scss" scoped>
.document-search-result {
    width: 100%;
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    text-align: left;
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    cursor: pointer;
    background: transparent;
    transition: background-color $ease-standard;
}

.document-search-result:hover {
    background: var(--app-sidebar-control-hover-bg);
}

.document-search-result.is-active {
    border-color: var(--app-control-active-border);
    background: var(--app-control-active-bg);
}

.document-search-result:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--app-document-search-result-focus-ring);
}

.document-search-result-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-sidebar-row-gap);
}

.document-search-result-page {
    font-size: var(--app-sidebar-row-font-size);
    font-weight: 500;
}

.document-search-result-match {
    font-size: var(--app-sidebar-caption-font-size);
    color: var(--ui-text-muted);
}

.document-search-result-snippet {
    font-size: var(--app-sidebar-caption-font-size);
    line-height: 1.45;
    color: var(--ui-text-muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
}

.document-search-result-highlight {
    padding: 0;
    border-radius: 0.2rem;
    background: var(--app-document-search-result-highlight-bg);
    color: var(--ui-text);
    font-weight: 700;
}

.document-search-result.is-active .document-search-result-highlight {
    background: var(--app-document-search-result-highlight-current-bg);
}
</style>
