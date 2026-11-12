<template>
    <div class="timeline-shell">
        <div class="timeline-overlay"><slot name="overlay" /></div>
        <div ref="viewport" class="assistant-timeline app-scrollbar" role="log" :aria-label="t('assistant.conversation')" @scroll="handleScroll">
            <div ref="content">
                <div v-if="!items.length" class="timeline-empty">
                    <h2>{{ t(hasDocument ? 'assistant.emptyDocumentTitle' : 'assistant.emptyWorkspaceTitle') }}</h2>
                    <p>{{ documentName ? t('assistant.emptyDocumentDescriptionNamed', { name: documentName }) : t(hasDocument ? 'assistant.emptyDocumentDescription' : 'assistant.emptyWorkspaceDescription') }}</p>
                    <slot name="empty" />
                 </div>
                <template v-for="row in rows" :key="row.id">
                    <p v-if="running && row.id === activeTurnFirstRowId" class="timeline-working" role="status">{{ t('assistant.workingFor', { seconds: elapsed }) }}</p>
                    <AssistantWorkGroup v-if="row.kind === 'work'" :items="row.items" :live="running && row.id === activeWorkGroupId" @copy="(id, text) => emit('copy', id, text)" />
                    <div v-else-if="row.item.kind === 'system'" class="timeline-system" :class="row.item.status === 'failed' ? 'timeline-error' : 'timeline-notice'" :role="row.item.status === 'failed' ? 'alert' : 'status'">
                        <p>{{ row.item.errorEnvelope?.message ?? row.item.text }}</p>
                        <UButton v-if="row.item.status === 'failed' && row.item.errorEnvelope?.retryable" :label="t('assistant.turnRetry')" variant="ghost" color="neutral" size="xs" @click="emit('retry', row.item.turnId)" />
                     </div>
                    <AssistantMessage v-else :item="row.item" :copy-icon="copyIcon(row.id)" :copy-label="copyLabel(row.id)" @copy="(id, text) => emit('copy', id, text)" @preview="(images, id) => emit('preview', images, id)" @layout="followEnd" />
                </template>
                <p v-if="running && !activeTurnFirstRowId" class="timeline-working" role="status">{{ t('assistant.workingFor', { seconds: elapsed }) }}</p>
            </div>
        </div>
        <UButton v-if="!following" class="scroll-to-end" :label="t('assistant.scrollToEnd')" icon="i-ph-caret-down" color="neutral" variant="soft" size="xs" @click="scrollToEnd" />
    </div>
</template>

<script setup lang="ts">
import {
    useIntervalFn, useResizeObserver,
} from '@vueuse/core';
import type {
    IAssistantItem, IAssistantTurn,
} from '@contracts/assistant';
import type { TAssistantComposerImage } from '@app/modules/agent-panel/utils/assistantImageAttachments';
import AssistantMessage from '@app/modules/agent-panel/components/AssistantMessage.vue';
import AssistantWorkGroup from '@app/modules/agent-panel/components/AssistantWorkGroup.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';
const props = defineProps<{
    sessionKey: string | null;
    items: IAssistantItem[];
    turn: IAssistantTurn | null;
    running: boolean;
    hasDocument: boolean;
    documentName?: string | null | undefined;
    copyIcon: (id: string) => string;
    copyLabel: (id: string) => string;
}>();
const emit = defineEmits<{
    copy: [id: string, text: string];
    preview: [images: TAssistantComposerImage[] | undefined, id: string];
    retry: [turnId: string | null]
}>();
const { t } = useTypedI18n();
const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const following = ref(true);
const now = ref(Date.now());
const elapsed = computed(() => Math.max(0, Math.floor((now.value - (props.turn?.startedAtMs ?? now.value)) / 1000)));
const {
    pause, resume,
} = useIntervalFn(() => { now.value = Date.now(); }, 1000, { immediate: false });
watch(() => props.running, running => { now.value = Date.now(); if (running) resume(); else pause(); }, { immediate: true });
type TTimelineRow = {
    kind: 'work';
    id: string;
    items: IAssistantItem[]
} | {
    kind: 'item';
    id: string;
    item: IAssistantItem
};
const rows = computed(() => {
    const result: TTimelineRow[] = [];
    for (const item of props.items) {
        if (item.kind === 'tool' || item.kind === 'reasoning') {
            const previous = result.at(-1);
            if (previous?.kind === 'work' && previous.items[0]?.turnId === item.turnId) previous.items.push(item);
            else result.push({
                kind: 'work',
                id: item.id,
                items: [item],
            });
        } else result.push({
            kind: 'item',
            id: item.id,
            item,
        });
    }
    return result;
});
const activeTurnFirstRowId = computed(() => rows.value.find(row => row.kind === 'work'
    ? row.items[0]?.turnId === props.turn?.id
    : row.item.kind !== 'user' && row.item.turnId === props.turn?.id)?.id);
const activeWorkGroupId = computed(() => {
    const latest = rows.value.at(-1);
    return latest?.kind === 'work' && latest.items[0]?.turnId === props.turn?.id ? latest.id : null;
});
function handleScroll() {
    const element = viewport.value;
    if (element) following.value = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
}
function scrollToEnd() {
    following.value = true;
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
}
function followEnd() { if (following.value) scrollToEnd(); }
watch(() => [
    props.items,
    props.running,
], async () => { await nextTick(); followEnd(); }, { deep: true });
watch(() => props.sessionKey, async () => { following.value = true; await nextTick(); scrollToEnd(); });
useResizeObserver(content, followEnd);
onMounted(scrollToEnd);
</script>

<style scoped>
.timeline-shell {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
}

.assistant-timeline {
    height: 100%;
    padding: var(--app-space-12xl) var(--app-space-9xl);
    overflow: hidden auto;
    overscroll-behavior: contain;
}

.timeline-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-3xl);
    padding-block: var(--app-space-16xl);
    color: var(--ui-text-muted);
    text-align: center;
    font-size: var(--app-text-size-body);
}

.timeline-empty h2 {
    color: var(--ui-text);
    font-weight: var(--app-font-weight-semibold);
}

.timeline-empty p {
    margin: 0 0 var(--app-space-3xl);
}

.timeline-error {
    padding-block: var(--app-space-3xl);
    color: var(--ui-error);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    font-size: var(--app-text-size-body-sm);
}

.timeline-working {
    padding-block: var(--app-space-lg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    font-variant-numeric: tabular-nums;
}

.scroll-to-end {
    position: absolute;
    bottom: var(--app-space-3xl);
    left: 50%;
    transform: translateX(-50%);
    border-radius: var(--app-radius-full);
}

.timeline-overlay {
    position: absolute;
    inset: 0 0 auto;
    z-index: var(--app-z-local-overlay);
    max-height: 45%;
    pointer-events: none;
}
.timeline-overlay :deep(.provider-banner) { pointer-events: auto; }

.timeline-notice {
    padding-block: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

</style>
