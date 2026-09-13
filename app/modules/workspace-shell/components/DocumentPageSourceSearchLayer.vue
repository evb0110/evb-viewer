<template>
    <div
        v-if="highlights.length > 0"
        class="document-source-viewer__search-layer"
        data-testid="document-page-source-search-layer"
        aria-hidden="true"
    >
        <span
            v-for="highlight in highlights"
            :key="highlight.key"
            class="document-search-highlight document-page-source-search-highlight"
            :class="{'document-search-highlight--current document-page-source-search-highlight--current': highlight.current}"
            :style="getHighlightStyle(highlight)"
            :data-search-result-index="highlight.resultIndex"
            :data-search-match-index="highlight.matchIndex"
            :data-search-highlight-current="highlight.current"
            :data-search-word="highlight.word.text"
            data-testid="document-page-source-search-highlight"
        />
    </div>
</template>

<script setup lang="ts">
import type { IDocumentSearchMatch } from '@app/modules/document-viewer/public';
import {
    resolveDocumentPageSourceSearchHighlights,
    type IDocumentPageSourceSearchHighlight,
} from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceSearchHighlights';

const props = defineProps<{
    currentResultIndex: number;
    pageNumber: number;
    results: readonly IDocumentSearchMatch[];
}>();

const highlights = computed(() => resolveDocumentPageSourceSearchHighlights({
    currentResultIndex: props.currentResultIndex,
    pageNumber: props.pageNumber,
    results: props.results,
}));

function getHighlightStyle(highlight: IDocumentPageSourceSearchHighlight) {
    return {
        left: `${String(highlight.rect.left * 100)}%`,
        top: `${String(highlight.rect.top * 100)}%`,
        width: `${String(highlight.rect.width * 100)}%`,
        height: `${String(highlight.rect.height * 100)}%`,
    };
}
</script>

<style scoped>
.document-source-viewer__search-layer {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    overflow: hidden;
    pointer-events: none;
}

.document-search-highlight {
    position: absolute;
    box-sizing: border-box;
    pointer-events: none;
    background: var(--app-search-highlight-bg);
    border-radius: var(--app-search-highlight-fragment-radius);
}

.document-search-highlight--current {
    background: var(--app-search-highlight-current-bg);
    box-shadow: inset 0 0 0 1px var(--app-search-highlight-current-outline);
}
</style>
