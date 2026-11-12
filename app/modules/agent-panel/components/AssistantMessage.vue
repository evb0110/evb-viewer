<template>
    <article class="assistant-message" :class="{ 'is-user': item.kind === 'user' }">
        <span class="sr-only">{{ t(item.kind === 'user' ? 'assistant.roleUser' : 'assistant.roleAssistant') }}</span>
        <div v-if="item.attachments?.length" class="message-images">
            <button v-for="image in item.attachments" :key="image.id" type="button" :aria-label="t('assistant.previewImage', { name: image.name })" @click="emit('preview', item.attachments, image.id)">
                <img :src="getAssistantImagePreviewUrl(image)" :alt="image.name" @load="emit('layout')">
            </button>
        </div>
        <p v-if="item.kind === 'user' && item.text" class="user-bubble">{{ item.text }}</p>
        <AssistantMarkdown v-else :text="item.text" @copy="(id, text) => emit('copy', `${item.id}:${id}`, text)" />
        <div class="message-meta">
            <span v-if="item.status === 'interrupted'">{{ t('assistant.interrupted') }}</span>
            <UButton v-if="item.status === 'completed'" :aria-label="copyLabel"  :icon="copyIcon" color="neutral" variant="ghost" size="xs" @click="emit('copy', item.id, item.text)" />
        </div>
    </article>
</template>

<script setup lang="ts">
import type { IAssistantItem } from '@contracts/assistant';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import AssistantMarkdown from '@app/modules/agent-panel/components/AssistantMarkdown.vue';
import {
    getAssistantImagePreviewUrl, type TAssistantComposerImage,
} from '@app/modules/agent-panel/utils/assistantImageAttachments';

defineProps<{
    item: IAssistantItem;
    copyIcon: string;
    copyLabel: string
}>();
const emit = defineEmits<{
    copy: [id: string, text: string];
    preview: [images: TAssistantComposerImage[] | undefined, id: string];
    layout: []
}>();
const { t } = useTypedI18n();
</script>

<style scoped>
.assistant-message {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-bottom: var(--app-space-12xl);
}

.assistant-message.is-user {
    align-items: flex-end;
}

.user-bubble {
    max-width: 80%;
    margin: 0;
    padding: var(--app-space-9xl);
    border-radius: var(--app-assistant-card-radius);
    background: var(--app-assistant-user-bg);
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    line-height: var(--app-line-height-body);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.message-images {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-3xl);
    max-width: 80%;
    margin-bottom: var(--app-space-sm);
}

.message-images button {
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    cursor: pointer;
}

.message-images img {
    max-width: 100%;
    max-height: var(--app-assistant-message-max-height);
    object-fit: contain;
}

.message-meta {
    display: flex;
    align-items: center;
    gap: var(--app-space-lg);
    min-height: var(--app-space-16xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}
</style>
