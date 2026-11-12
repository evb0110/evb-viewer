<template>
    <details class="work-group">
        <summary class="work-summary">
            <UIcon :name="live ? 'i-ph-circle-notch' : 'i-ph-check'" />
            <span v-if="live || items.length === 1 && latest?.kind === 'tool'">{{ latest?.toolName || latest?.text || t('assistant.thinking') }}<template v-if="latest?.kind === 'tool'"> · {{ statusLabel(latest.status) }}</template></span>
            <span v-else>{{ t('assistant.workSummary', { count: items.length }) }}</span>
        </summary>
        <div class="work-entries app-scrollbar">
            <details v-for="item in items" :key="item.id" class="work-entry">
                <summary>
                    <UIcon :name="item.kind === 'reasoning' ? 'i-ph-brain' : 'i-ph-wrench'" />
                    <span class="work-label">{{ item.kind === 'tool' ? item.toolName : t('assistant.thinking') }}</span>
                    <span>{{ statusLabel(item.status) }}</span>
                </summary>
                <AssistantMarkdown v-if="item.kind === 'reasoning'" :text="item.text" @copy="(id, text) => emit('copy', `${item.id}:${id}`, text)" />
                <pre v-else class="work-detail">{{ item.toolDetail || item.text }}</pre>
            </details>
        </div>
    </details>
</template>

<script setup lang="ts">
import type {
    IAssistantItem, TAssistantItemStatus,
} from '@contracts/assistant';
import AssistantMarkdown from '@app/modules/agent-panel/components/AssistantMarkdown.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';
const props = defineProps<{
    items: IAssistantItem[];
    live: boolean
}>();
const emit = defineEmits<{ copy: [id: string, text: string] }>();
const { t } = useTypedI18n();
const latest = computed(() => props.items.findLast(item => item.status === 'streaming') ?? props.items.at(-1));
function statusLabel(status: TAssistantItemStatus) {
    return t(status === 'streaming' ? 'assistant.toolPhaseRunning' : status === 'completed' ? 'assistant.toolPhaseCompleted' : status === 'interrupted' ? 'assistant.interrupted' : 'assistant.toolPhaseFailed');
}
</script>

<style scoped>
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
    cursor: pointer;
}

.work-summary span,
.work-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.work-label {
    flex: 1;
}

.work-entries {
    max-height: var(--app-assistant-work-max-height);
    padding-inline-start: var(--app-assistant-work-indent);
    overflow: auto;
}

.work-detail {
    margin: var(--app-space-sm) 0 var(--app-space-3xl);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}
</style>
