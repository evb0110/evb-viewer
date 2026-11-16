<template>
    <div class="timeline-shell">
        <div ref="viewport" class="assistant-timeline app-scrollbar" role="log" :aria-label="t('assistant.conversation')" @scroll="handleScroll" @click="handleDisclosure">
            <div ref="content" class="timeline-content">
                <div v-if="!items.length" class="timeline-empty">
                    <h2>{{ t(hasDocument ? 'assistant.emptyDocumentTitle' : 'assistant.emptyWorkspaceTitle') }}</h2>
                    <p>{{ documentName ? t('assistant.emptyDocumentDescriptionNamed', { name: documentName }) : t(hasDocument ? 'assistant.emptyDocumentDescription' : 'assistant.emptyWorkspaceDescription') }}</p>
                    <slot name="empty" />
                </div>
                <template v-for="row in rows" :key="row.id">
                    <p v-if="running && row.id === activeTurnFirstRowId" class="timeline-working" role="status">{{ t('assistant.workingFor', { seconds: elapsed }) }}</p>
                    <AssistantWorkGroup v-if="row.kind === 'work'" :data-row-id="row.id" :items="row.items" @copy="(id, text) => emit('copy', id, text)" />
                    <div v-else-if="row.item.kind === 'system' && row.item.status === 'failed'" :data-row-id="row.id" class="timeline-error" role="alert">
                        <UIcon name="i-ph-warning-circle" class="timeline-error-icon" />
                        <p>{{ row.item.errorEnvelope?.message ?? row.item.text }}</p>
                        <UButton v-if="row.item.errorEnvelope?.retryable" class="timeline-error-action" :label="t('assistant.turnRetry')" icon="i-ph-arrow-counter-clockwise" variant="soft" color="neutral" size="xs" @click="emit('retry', row.item.turnId)" />
                        <UButton v-else-if="needsAnotherModel(row.item)" class="timeline-error-action" :label="t('assistant.changeModel')" icon="i-ph-caret-up-down" variant="soft" color="neutral" size="xs" @click="emit('change-model')" />
                    </div>
                    <p v-else-if="row.item.kind === 'system'" :data-row-id="row.id" class="timeline-notice" role="status">{{ row.item.text }}</p>
                    <AssistantMessage v-else :data-row-id="row.id" :item="row.item" :copy-icon="copyIcon(row.id)" :copy-label="copyLabel(row.id)" @copy="(id, text) => emit('copy', id, text)" @preview="(images, id) => emit('preview', images, id)" />
                </template>
                <p v-if="running && !activeTurnFirstRowId" class="timeline-working" role="status">{{ t('assistant.workingFor', { seconds: elapsed }) }}</p>
            </div>
            <div class="timeline-anchor-space" :style="{ height: `${anchorSpace}px` }" />
        </div>
        <UButton v-if="follow === 'released'" class="scroll-to-end" :label="t('assistant.scrollToEnd')" icon="i-ph-caret-down" color="neutral" variant="soft" size="xs" @click="scrollToEnd" />
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
    retry: [turnId: string | null];
    'change-model': []
}>();
const { t } = useTypedI18n();
const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
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
// A model or setup the provider cannot run is fixed in the picker, not by resending.
function needsAnotherModel(item: IAssistantItem) {
    return item.errorEnvelope?.code === 'MODEL_UNAVAILABLE' || item.errorEnvelope?.code === 'INSTALL_MISSING';
}

/*
 * The one owner of this viewport's position, after T3 Code's timeline follow rules
 * (apps/web/src/components/chat/timelineViewport.ts and useTimelineFollow.ts@0b6f482dc5,
 * MIT, T3 Tools Inc.). Following keeps the live end in view. A reader who moves up
 * releases it, and only returning to the end re-arms it. A newly sent message is
 * anchored near the top: space below it lets the reply grow in view until it fills
 * the viewport, after which following tracks the reply's end.
 */
const END_BAND = 48;
const follow = ref<'following' | 'released'>('following');
let lastScrollTop = 0;
const anchorId = ref<string | null>(null);
const anchorSpace = ref(0);
function atEnd(element: HTMLElement) {
    return element.scrollHeight - element.clientHeight - element.scrollTop < END_BAND;
}
function handleScroll() {
    const element = viewport.value;
    if (!element) return;
    if (element.scrollTop < lastScrollTop || !atEnd(element)) follow.value = 'released';
    else if (atEnd(element)) follow.value = 'following';
    lastScrollTop = element.scrollTop;
}
function scrollToEnd() {
    follow.value = 'following';
    if (viewport.value) {
        viewport.value.scrollTop = viewport.value.scrollHeight;
        lastScrollTop = viewport.value.scrollTop;
    }
}
function handleDisclosure(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest('summary')) follow.value = 'released';
}
function measureAnchorSpace() {
    const element = viewport.value;
    const body = content.value;
    const anchor = anchorId.value && body
        ? [...body.querySelectorAll<HTMLElement>('[data-row-id]')].find(node => node.dataset.rowId === anchorId.value)
        : undefined;
    if (!element || !body || !anchor) return 0;
    const top = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const gap = Number.parseFloat(getComputedStyle(body).paddingTop) || 0;
    return Math.max(0, Math.round(element.clientHeight - (body.offsetHeight - top) - gap));
}
async function layout() {
    anchorSpace.value = measureAnchorSpace();
    await nextTick();
    if (follow.value === 'following') scrollToEnd();
}
const latestUser = computed(() => props.items.findLast(item => item.kind === 'user') ?? null);
watch(() => [
    props.sessionKey,
    latestUser.value?.id,
] as const, ([session, userId], [previousSession, previousUserId]) => {
    if (session !== previousSession) {
        anchorId.value = null;
        follow.value = 'following';
    } else if (userId && userId !== previousUserId) {
        // Only a message that starts the newest turn anchors; loading history does not.
        const user = latestUser.value;
        if (user && (user === props.items.at(-1) || (props.running && user.turnId === props.turn?.id))) {
            anchorId.value = userId;
            follow.value = 'following';
        }
    }
    void layout();
}, { flush: 'post' });
useResizeObserver(content, () => { void layout(); });
useResizeObserver(viewport, () => { void layout(); });
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
    overflow: hidden auto;
    overscroll-behavior: contain;
}

.timeline-content {
    padding: var(--app-space-12xl) var(--app-space-9xl);
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
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--app-space-lg) var(--app-space-3xl);
    margin-bottom: var(--app-space-12xl);
    padding: var(--app-space-3xl) var(--app-space-9xl);
    border: 1px solid var(--app-assistant-error-border);
    border-radius: var(--app-radius-2xl);
    background: var(--app-assistant-error-bg);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
}

.timeline-error p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.timeline-error-icon {
    margin-top: var(--app-space-xs);
    color: var(--ui-error);
}

.timeline-error-action {
    grid-column: 2;
    justify-self: start;
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

.timeline-notice {
    padding-block: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}
</style>
