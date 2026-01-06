<template>
    <div
        class="pdf-search-result"
        :class="{ 'is-active': isActive }"
    >
        <div class="pdf-search-result-meta">
            <span class="pdf-search-result-page">Page {{ result.pageIndex + 1 }}</span>
            <span class="pdf-search-result-match">Match {{ result.matchIndex + 1 }}</span>
        </div>
        <div class="pdf-search-result-snippet">
            <template v-if="result.excerpt.prefix">…</template><span
                ref="textRef"
            >{{ fullText }}</span><template v-if="result.excerpt.suffix">…</template>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { IPdfSearchMatch } from 'app/types/pdf';
import {
    registerSearchHighlight,
    unregisterSearchHighlight,
} from 'app/composables/useSearchHighlight';

interface IProps {
    result: IPdfSearchMatch;
    isActive: boolean;
}

const props = defineProps<IProps>();

const textRef = ref<HTMLSpanElement | null>(null);
const highlightId = `search-${Math.random().toString(36).slice(2)}`;

const fullText = computed(() =>
    props.result.excerpt.before + props.result.excerpt.match + props.result.excerpt.after,
);

const matchStart = computed(() => props.result.excerpt.before.length);
const matchEnd = computed(() => matchStart.value + props.result.excerpt.match.length);

function applyHighlight() {
    if (!textRef.value || typeof CSS === 'undefined' || !CSS.highlights) {
        return;
    }

    const textNode = textRef.value.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        return;
    }

    try {
        const range = new Range();
        range.setStart(textNode, matchStart.value);
        range.setEnd(textNode, matchEnd.value);
        registerSearchHighlight(highlightId, range);
    } catch {
        // Range may be invalid if text changed
    }
}

function clearHighlight() {
    unregisterSearchHighlight(highlightId);
}

onMounted(() => {
    nextTick(() => applyHighlight());
});

onBeforeUnmount(() => {
    clearHighlight();
});

watch(
    () => [
        props.result,
        fullText.value,
    ],
    () => {
        clearHighlight();
        nextTick(() => applyHighlight());
    },
);
</script>

<style scoped>
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
</style>

<style>
/* CSS Custom Highlight API - must be global (not scoped) */
::highlight(search-result-match) {
    color: var(--ui-text);
    background-color: rgb(59 130 246 / 0.25);
}
</style>
