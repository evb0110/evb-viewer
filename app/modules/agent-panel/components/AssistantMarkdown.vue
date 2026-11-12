<template>
    <div class="assistant-markdown">
        <template v-for="(block, index) in blocks" :key="index">
            <p v-if="block.kind === 'text'"><InlineSegments :segments="block.segments" /></p>
            <component :is="`h${block.level}`" v-else-if="block.kind === 'heading'"><InlineSegments :segments="block.segments" /></component>
            <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'">
                <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><InlineSegments :segments="item" /></li>
            </component>
            <blockquote v-else-if="block.kind === 'blockquote'"><InlineSegments :segments="block.segments" /></blockquote>
            <div v-else-if="block.kind === 'code'" class="markdown-code">
                <div class="markdown-code-header">
                    <span>{{ block.language }}</span>
                    <UButton :aria-label="t('assistant.copyCode')" icon="i-ph-copy" color="neutral" variant="ghost" size="xs" @click="emit('copy', `code-${index}`, block.code)" />
                </div>
                <pre class="app-scrollbar"><AssistantHighlightedCode :code="block.code" :language="block.language" /></pre>
            </div>
            <div v-else-if="block.kind === 'table'" class="markdown-table app-scrollbar">
                <table><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><InlineSegments :segments="cell" /></td></tr></tbody></table>
            </div>
            <hr v-else-if="block.kind === 'rule'">
        </template>
    </div>
</template>

<script setup lang="ts">
import {
    createStreamingAssistantMessageFormatter, type TAssistantMessageSegment,
} from '@app/modules/agent-panel/utils/formatAssistantMessage';
import AssistantHighlightedCode from '@app/modules/agent-panel/components/AssistantHighlightedCode.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ copy: [id: string, text: string] }>();
const { t } = useTypedI18n();
const formatter = createStreamingAssistantMessageFormatter();
const blocks = computed(() => formatter.format(props.text));
const InlineSegments = (inline: { segments: TAssistantMessageSegment[] }) => inline.segments.map(segment => {
    if (segment.kind === 'link') return h('a', {
        href: segment.href,
        target: '_blank',
        rel: 'noopener noreferrer',
    }, segment.text);
    if (segment.kind === 'strong') return h('strong', segment.text);
    if (segment.kind === 'emphasis') return h('em', segment.text);
    if (segment.kind === 'code') return h('code', segment.text);
    return segment.text;
});
</script>

<style scoped>
.assistant-markdown {
    min-width: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    line-height: var(--app-line-height-body);
    overflow-wrap: anywhere;
    user-select: text;
}

.assistant-markdown :deep(p),
.assistant-markdown :deep(ul),
.assistant-markdown :deep(ol),
.assistant-markdown blockquote,
.markdown-code,
.markdown-table {
    margin: var(--app-space-7xl) 0;
}

.assistant-markdown :deep(p) {
    white-space: pre-wrap;
}

.assistant-markdown :deep(ul) {
    list-style: disc;
    padding-inline-start: var(--app-space-15xl);
}

.assistant-markdown :deep(ol) {
    list-style: decimal;
    padding-inline-start: var(--app-space-15xl);
}

.assistant-markdown :deep(a) {
    color: var(--ui-primary);
    text-decoration: underline;
}

.assistant-markdown :deep(strong) {
    font-weight: var(--app-font-weight-semibold);
}

.assistant-markdown :deep(h1),
.assistant-markdown :deep(h2),
.assistant-markdown :deep(h3),
.assistant-markdown :deep(h4),
.assistant-markdown :deep(h5),
.assistant-markdown :deep(h6) {
    margin: var(--app-space-15xl) 0 var(--app-space-3xl);
    font-weight: var(--app-font-weight-heading);
}

.assistant-markdown :deep(h1) {
    font-size: var(--app-text-size-title-lg);
}

.assistant-markdown :deep(h2) {
    font-size: var(--app-text-size-title-md);
}

.assistant-markdown :deep(code) {
    font-family: var(--app-font-mono);
    font-size: var(--app-text-size-body-sm);
}

.assistant-markdown :deep(p code),
.assistant-markdown :deep(li code) {
    padding: 0 var(--app-space-sm);
    border-radius: var(--app-radius-xs);
    background: var(--ui-bg-accented);
}

.assistant-markdown blockquote {
    padding-inline-start: var(--app-space-9xl);
    border-inline-start: 2px solid var(--ui-border);
    color: var(--ui-text-muted);
}

.markdown-code {
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    background: var(--ui-bg-muted);
}

.markdown-code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-micro);
}

.markdown-code pre {
    margin: 0;
    padding: var(--app-space-9xl);
    overflow-x: auto;
}

.markdown-table {
    overflow-x: auto;
}

.markdown-table td {
    padding: var(--app-space-lg);
    border: 1px solid var(--ui-border);
}

.assistant-markdown :deep(.is-keyword) {
    color: var(--ui-primary);
}

.assistant-markdown :deep(.is-string) {
    color: var(--ui-success);
}

.assistant-markdown :deep(.is-number) {
    color: var(--ui-warning);
}

.assistant-markdown :deep(.is-comment) {
    color: var(--ui-text-dimmed);
}
</style>
