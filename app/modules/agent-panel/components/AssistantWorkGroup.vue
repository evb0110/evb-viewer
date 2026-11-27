<template>
    <details class="work-group" :class="`is-${summary.state}`">
        <summary class="work-summary">
            <UIcon :name="ASSISTANT_WORK_ICONS[summary.state]" class="work-icon" :class="{ 'animate-spin motion-reduce:animate-none': summary.state === 'running' }" />
            <span class="work-label">{{ t(summary.labelKey) }}</span>
            <span v-if="summary.statusKey" class="work-status">{{ t(summary.statusKey) }}</span>
            <span v-if="items.length > 1" class="work-steps">{{ t('assistant.work.steps', { count: items.length }) }}</span>
            <UIcon name="i-ph-caret-right" class="work-caret" />
        </summary>
        <ol class="work-entries app-scrollbar">
            <li v-for="entry in entries" :key="entry.item.id">
                <details class="work-entry">
                    <summary>
                        <UIcon :name="ASSISTANT_WORK_ICONS[entry.state]" class="work-icon" :class="{ 'animate-spin motion-reduce:animate-none': entry.state === 'running' }" />
                        <span class="work-label">{{ t(entry.labelKey) }}</span>
                        <span v-if="entry.statusKey" class="work-status">{{ t(entry.statusKey) }}</span>
                    </summary>
                    <AssistantMarkdown v-if="entry.item.kind === 'reasoning'" :text="entry.item.text" @copy="(id, text) => emit('copy', `${entry.item.id}:${id}`, text)" />
                    <template v-else>
                        <code v-if="entry.item.toolName" class="work-tool-name">{{ entry.item.toolName }}</code>
                        <pre v-if="entry.item.toolDetail || entry.item.text" class="work-detail">{{ entry.item.toolDetail || entry.item.text }}</pre>
                    </template>
                </details>
            </li>
        </ol>
    </details>
</template>

<script setup lang="ts">
import type { IAssistantItem } from '@contracts/assistant';
import AssistantMarkdown from '@app/modules/agent-panel/components/AssistantMarkdown.vue';
import {
    ASSISTANT_WORK_ICONS, describeAssistantWorkItem, summarizeAssistantWork,
} from '@app/modules/agent-panel/utils/assistantWorkPresentation';
import { useTypedI18n } from '@app/composables/useTypedI18n';
const { items } = defineProps<{ items: IAssistantItem[] }>();
const emit = defineEmits<{ copy: [id: string, text: string] }>();
const { t } = useTypedI18n();
const summary = computed(() => summarizeAssistantWork(items));
const entries = computed(() => items.map(item => ({
    item,
    ...describeAssistantWorkItem(item),
})));
</script>

<style lang="scss" scoped>
.work-group {
    min-width: 0;
    padding-bottom: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
}

.work-summary,
.work-entry summary {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    min-height: var(--app-space-16xl);
    border-radius: var(--app-radius-md);
    cursor: pointer;
    list-style: none;
}

.work-summary::-webkit-details-marker,
.work-entry summary::-webkit-details-marker {
    display: none;
}

.work-summary:hover,
.work-entry summary:hover {
    color: var(--ui-text);
}

.work-summary:focus-visible,
.work-entry summary:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 1px;
}

.work-icon {
    flex: 0 0 auto;
}

.is-failed > .work-summary .work-icon,
.is-failed > .work-summary .work-status {
    color: var(--ui-error);
}

.work-label {
    min-width: 0;

    @include app.truncate-single-line;
}

.work-status,
.work-steps {
    flex: 0 0 auto;
    color: var(--ui-text-dimmed);
}

.work-caret {
    flex: 0 0 auto;
    color: var(--ui-text-dimmed);
    transition: transform $ease-standard;
}

.work-group[open] > .work-summary .work-caret {
    transform: rotate(90deg);
}

.work-entries {
    max-height: var(--app-assistant-work-max-height);
    margin: 0;
    padding: 0 0 0 var(--app-assistant-work-indent);
    overflow: auto;
    list-style: none;
}

.work-tool-name {
    display: block;
    margin-top: var(--app-space-sm);
    color: var(--ui-text-dimmed);
    font-family: var(--app-font-mono);
    font-size: var(--app-text-size-micro);
    overflow-wrap: anywhere;
    user-select: text;
}

.work-detail {
    margin: var(--app-space-sm) 0 var(--app-space-3xl);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}
</style>
