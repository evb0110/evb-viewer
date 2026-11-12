<template>
    <aside ref="panelRef" class="agent-assistant-panel" :style="panelStyle" :aria-label="t('assistant.title')" @keydown.capture="handleAssistantCopyShortcut">
        <div class="agent-assistant-resizer" :class="{ 'is-active': isResizing }" role="separator" aria-orientation="vertical" :aria-label="t('sidebar.resize')" @pointerdown.prevent="emit('resize-start', $event)" />
        <header class="agent-assistant-header">
            <UIcon name="i-ph-chat-circle-dots" />
            <AppTooltip :text="activeDocumentName || t('assistant.title')" usefulness="overflow"><span class="agent-assistant-title">{{ activeDocumentName || t('assistant.title') }}</span></AppTooltip>
            <UButton :aria-label="t('assistant.newChat')" icon="i-ph-plus" color="neutral" variant="ghost" size="xs" :disabled="!scope || !!busyAction" @click="reset" />
            <UButton :aria-label="t('assistant.close')" icon="i-ph-x" color="neutral" variant="ghost" size="xs" @click="emit('close')" />
        </header>
        <AssistantTimeline :session-key="sessionKey" :items="chat?.items ?? []" :turn="chat?.turn ?? null" :running="running" :has-document="!!scope" :document-name="activeDocumentName" :copy-icon="copyMessageIcon" :copy-label="copyMessageTooltip" @copy="handleCopyMessageText" @preview="expandImage" @retry="retry">
            <template #overlay>
        <AssistantProviderBanner :instance="instance" :busy="!!busyAction" :progress="state.installProgress" :device-code="deviceCode" :verification-url="verificationUrl" @refresh="refresh(true)" @install="install" @sign-in="login" @cancel-login="cancelLogin" />
            </template>
            <template #empty>
                <div class="assistant-presets">
                    <UButton v-for="preset in presets" :key="preset.id" :label="presetLabel(preset.id)" :icon="preset.icon" color="neutral" variant="soft" size="xs" :disabled="!!providerDisabledReason || sending" @click="sendPreset(preset.id)" />
                </div>
            </template>
        </AssistantTimeline>
        <div v-if="chat?.items.length" class="assistant-presets assistant-presets--footer">
            <UButton v-for="preset in presets" :key="preset.id" :label="presetLabel(preset.id)" color="neutral" variant="ghost" size="xs" :disabled="!!providerDisabledReason || sending" @click="sendPreset(preset.id)" />
        </div>
        <AssistantComposer v-model="draft" :images="composerImages" :instances="state.instances" :selection="selection" :send-disabled-reason="sendDisabledReason" :running="running" :interrupting="interrupting || chat?.turn?.phase === 'interrupting'" :has-document="!!scope" :error="composerError" @select="selection = $event" @submit="send()" @interrupt="interrupt" @paste="handleComposerPaste" @remove-image="removeComposerImage" @preview="expandImage" />
        <Teleport to="body">
            <div v-if="expandedImage && expandedImageItem" class="assistant-image-overlay" role="dialog" aria-modal="true" :aria-label="t('assistant.expandedImagePreview')" tabindex="-1" @click.self="closeExpandedImage">
                <UButton class="image-close" :aria-label="t('assistant.closeImagePreview')" icon="i-ph-x" color="neutral" @click="closeExpandedImage" />
                <UButton v-if="expandedImage.images.length > 1" :aria-label="t('assistant.previousImage')" icon="i-ph-caret-left" color="neutral" @click="navigateExpandedImage(-1)" />
                <figure><img :src="expandedImageItem.src" :alt="expandedImageItem.name"><figcaption>{{ expandedImageCaption }}</figcaption></figure>
                <UButton v-if="expandedImage.images.length > 1" :aria-label="t('assistant.nextImage')" icon="i-ph-caret-right" color="neutral" @click="navigateExpandedImage(1)" />
            </div>
        </Teleport>
    </aside>
</template>

<script setup lang="ts">
import type { IAgentAssistantPanelControllerProps } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';
import { useAgentAssistantPanelController } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';
import { useAssistantPanelClipboard } from '@app/modules/agent-panel/composables/useAssistantPanelClipboard';
import AssistantProviderBanner from '@app/modules/agent-panel/components/AssistantProviderBanner.vue';
import AssistantTimeline from '@app/modules/agent-panel/components/AssistantTimeline.vue';
import AssistantComposer from '@app/modules/agent-panel/components/AssistantComposer.vue';
const props = defineProps<IAgentAssistantPanelControllerProps>();
const emit = defineEmits<{
    close: [];
    'resize-start': [event: PointerEvent]
}>();
const {
    t, state, scope, sessionKey, selection, instance, chat, draft, composerImages, composerError,
    deviceCode, verificationUrl, busyAction, sending, interrupting, running, providerDisabledReason, sendDisabledReason,
    refresh, send, retry, interrupt, reset, install, login, cancelLogin, presetLabel, sendPreset, presets,
    closeExpandedImage, expandImage, expandedImage, expandedImageItem, expandedImageCaption, handleComposerPaste, navigateExpandedImage, removeComposerImage,
} = useAgentAssistantPanelController(props);
const {
    panelRef, copyMessageIcon, copyMessageTooltip, handleCopyMessageText, handleAssistantCopyShortcut,
} = useAssistantPanelClipboard({ t });
const panelStyle = computed(() => ({
    '--assistant-panel-width': props.width ? `${props.width}px` : undefined,
    '--app-assistant-picker-width': `${Math.min((props.width ?? 384) - 48, 360)}px`,
}));
</script>

<style scoped>
.agent-assistant-panel {
    position: relative;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    width: var(--assistant-panel-width, var(--app-assistant-panel-default-width));
    min-width: 0;
    height: 100%;
    border-inline-start: 1px solid var(--ui-border);
    background: var(--app-sidebar-bg, var(--ui-bg));
}

.agent-assistant-resizer {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: var(--app-z-local-raised);
    width: var(--app-space-sm);
    cursor: col-resize;
    touch-action: none;
}

.agent-assistant-resizer:hover,
.agent-assistant-resizer.is-active {
    background: var(--ui-primary);
}

.agent-assistant-header {
    display: flex;
    align-items: center;
    gap: var(--app-space-3xl);
    min-width: 0;
    padding: var(--app-space-3xl) var(--app-space-9xl);
    border-bottom: 1px solid var(--ui-border);
}

.agent-assistant-title {
    flex: 1;
    overflow: hidden;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-presets {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--app-space-sm);
}

.assistant-presets--footer {
    padding-inline: var(--app-space-9xl);
}

.assistant-image-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--app-assistant-image-preview-z-index);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-9xl);
    padding: var(--app-assistant-image-preview-padding);
    background: var(--app-assistant-image-overlay-bg);
}

.assistant-image-overlay figure {
    min-width: 0;
    max-width: var(--app-assistant-image-preview-max-width);
}

.assistant-image-overlay img {
    max-width: 100%;
    max-height: var(--app-assistant-image-preview-image-max-height);
    object-fit: contain;
}

.assistant-image-overlay figcaption {
    color: var(--app-assistant-image-overlay-text);
    text-align: center;
    overflow-wrap: anywhere;
}

.image-close {
    position: absolute;
    top: var(--app-space-9xl);
    right: var(--app-space-9xl);
}
</style>
