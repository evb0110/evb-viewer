<template>
    <div class="assistant-markdown"><RenderedMarkdown /></div>
</template>

<script setup lang="ts">
import {
    Lexer, type Token, type Tokens,
} from 'marked';
import { decodeHTMLStrict } from 'entities';
import type { VNodeChild } from 'vue';
import AssistantHighlightedCode from '@app/modules/agent-panel/components/AssistantHighlightedCode.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const { text } = defineProps<{ text: string }>();
const emit = defineEmits<{ copy: [id: string, text: string] }>();
const { t } = useTypedI18n();
const UButton = resolveComponent('UButton');
// GFM tokens rendered as Vue nodes: no HTML string ever reaches the DOM, raw HTML stays
// literal text, links keep only safe schemes and images show their alt text instead of
// loading. Semantic tables and recursive lists follow T3 Code's ChatMarkdown and
// MarkdownTable (apps/web/src/components@0b6f482dc5, MIT, T3 Tools Inc.).
const tokens = computed(() => Lexer.lex(text, {
    gfm: true,
    breaks: true,
}));

function safeHref(href: string) {
    if (/^(?:#|\/(?!\/)|\.\.?\/)/u.test(href)) {return href;}
    try {
        return [
            'http:',
            'https:',
            'mailto:',
        ].includes(new URL(href).protocol) ? href : null;
    } catch {
        return null;
    }
}

function renderInline(list: Token[] | undefined): VNodeChild[] {
    return (list ?? []).map((token) => {
        switch (token.type) {
            case 'strong': return h('strong', renderInline(token.tokens));
            case 'em': return h('em', renderInline(token.tokens));
            case 'del': return h('del', renderInline(token.tokens));
            case 'codespan': return h('code', token.text);
            case 'br': return h('br');
            case 'checkbox': return h('input', {
                type: 'checkbox',
                checked: token.checked,
                disabled: true,
            });
            case 'link': {
                const href = safeHref(decodeHTMLStrict(token.href));
                return href ? h('a', {
                    href,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                }, renderInline(token.tokens)) : renderInline(token.tokens);
            }
            case 'image': return token.text;
            case 'html': return token.raw;
            case 'text': return token.tokens ? renderInline(token.tokens) : token.escaped ? token.text : decodeHTMLStrict(token.text);
            default: return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
        }
    });
}

function renderBlocks(list: Token[], code: { count: number }): VNodeChild[] {
    return list.map((token) => {
        switch (token.type) {
            case 'space':
            case 'def': return null;
            case 'paragraph': return h('p', renderInline(token.tokens));
            case 'heading': return h(`h${token.depth}`, renderInline(token.tokens));
            case 'hr': return h('hr');
            case 'blockquote': return h('blockquote', renderBlocks(token.tokens ?? [], code));
            case 'html': return h('p', token.raw);
            case 'list': return h(token.ordered ? 'ol' : 'ul', { start: token.ordered && token.start !== 1 ? token.start : undefined }, (token as Tokens.List).items.map(item => h('li', { class: { 'is-task': item.task } }, renderBlocks(item.tokens, code))));
            case 'table': return renderTable(token as Tokens.Table);
            case 'code': {
                const id = `code-${code.count++}`;
                const language = token.lang?.split(/\s/u)[0] || null;
                return h('div', { class: 'markdown-code' }, [
                    h('div', { class: 'markdown-code-header' }, [
                        h('span', language ?? ''),
                        h(UButton, {
                            'aria-label': t('assistant.copyCode'),
                            icon: 'i-ph-copy',
                            color: 'neutral',
                            variant: 'ghost',
                            size: 'xs',
                            onClick: () => emit('copy', id, token.text),
                        }),
                    ]),
                    h('pre', { class: 'app-scrollbar' }, h(AssistantHighlightedCode, {
                        code: token.text,
                        language,
                    })),
                ]);
            }
            default: return renderInline([token]);
        }
    });
}

function renderTable(token: Tokens.Table) {
    const cell = (tag: 'th' | 'td', value: Tokens.TableCell) => h(tag, { style: value.align ? { textAlign: value.align } : undefined }, renderInline(value.tokens));
    return h('div', { class: 'markdown-table app-scrollbar' }, h('table', [
        h('thead', h('tr', token.header.map(value => cell('th', value)))),
        h('tbody', token.rows.map(row => h('tr', row.map(value => cell('td', value))))),
    ]));
}

const RenderedMarkdown = () => renderBlocks(tokens.value, { count: 0 });
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
.assistant-markdown :deep(blockquote),
.assistant-markdown :deep(.markdown-code),
.assistant-markdown :deep(.markdown-table) {
    margin: var(--app-space-7xl) 0;
}

.assistant-markdown :deep(li > ul),
.assistant-markdown :deep(li > ol),
.assistant-markdown :deep(li > p) {
    margin: var(--app-space-sm) 0;
}

.assistant-markdown :deep(ul) {
    list-style: disc;
    padding-inline-start: var(--app-space-15xl);
}

.assistant-markdown :deep(ol) {
    list-style: decimal;
    padding-inline-start: var(--app-space-15xl);
}

.assistant-markdown :deep(li.is-task) {
    list-style: none;
}

.assistant-markdown :deep(li input) {
    margin-inline-end: var(--app-space-lg);
    vertical-align: middle;
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

.assistant-markdown :deep(hr) {
    margin: var(--app-space-12xl) 0;
    border-color: var(--ui-border);
}

/* Inline code keeps its background on every wrapped line (T3 Code index.css@0b6f482dc5). */
.assistant-markdown :deep(:not(pre) > code) {
    font-family: var(--app-font-mono);
    font-size: var(--app-text-size-body-sm);
    padding: var(--app-assistant-inline-code-padding);
    border-radius: var(--app-radius-xs);
    background: var(--ui-bg-accented);
    box-decoration-break: clone;
}

.assistant-markdown :deep(blockquote) {
    padding-inline-start: var(--app-space-9xl);
    border-inline-start: 2px solid var(--ui-border);
    color: var(--ui-text-muted);
}

.assistant-markdown :deep(.markdown-code) {
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    background: var(--ui-bg-muted);
}

.assistant-markdown :deep(.markdown-code-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-micro);
}

.assistant-markdown :deep(pre) {
    margin: 0;
    padding: var(--app-space-9xl);
    overflow-x: auto;
}

/* Diagnostics-style table from T3 Code index.css@0b6f482dc5: row separators, a stronger
   header rule, word-boundary wrapping and horizontal scrolling instead of columns that
   shrink to single characters. */
.assistant-markdown :deep(.markdown-table) {
    overflow-x: auto;
}

.assistant-markdown :deep(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--app-text-size-body-sm);
    overflow-wrap: normal;
    word-break: normal;
}

.assistant-markdown :deep(th),
.assistant-markdown :deep(td) {
    max-width: var(--app-assistant-table-cell-max-width);
    padding: var(--app-space-lg) var(--app-space-9xl);
    border-bottom: 1px solid var(--ui-border);
    text-align: start;
    vertical-align: top;
    overflow-wrap: break-word;
    text-wrap: pretty;
}

.assistant-markdown :deep(th:first-child),
.assistant-markdown :deep(td:first-child) {
    padding-inline-start: 0;
}

.assistant-markdown :deep(th:last-child),
.assistant-markdown :deep(td:last-child) {
    padding-inline-end: 0;
}

.assistant-markdown :deep(th) {
    border-bottom-color: var(--app-assistant-table-header-rule);
    font-weight: var(--app-font-weight-semibold);
}
</style>
