<template>
    <form ref="composer" class="assistant-composer" @submit.prevent="emit('submit')">
        <div v-if="images.length" class="composer-images" :aria-label="t('assistant.imageAttachments')">
            <div v-for="image in images" :key="image.id" class="composer-image">
                <button type="button" :aria-label="t('assistant.previewImage', { name: image.name })" @click="emit('preview', images, image.id)"><img :src="getAssistantImagePreviewUrl(image)" :alt="image.name"></button>
                <UButton class="remove-image" :aria-label="t('assistant.removeImageAttachment', { name: image.name })" icon="i-ph-x" size="xs" color="neutral" variant="solid" @click="emit('removeImage', image.id)" />
            </div>
        </div>
        <textarea ref="input" :value="modelValue" :aria-label="t('assistant.documentPlaceholder')" :placeholder="t(hasDocument ? 'assistant.documentPlaceholder' : 'assistant.workspacePlaceholder')" rows="3" :class="{ 'is-scrollable': scrollable }" class="composer-input app-scrollbar" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" @keydown="handleKeydown" @paste="emit('paste', $event)" />
        <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
        <div class="composer-footer">
            <AssistantProviderModelPicker :width="composerWidth" :instances="instances" :selection="selection" @select="emit('select', $event)" />
            <AppTooltip :text="showStop ? t('assistant.stop') : sendDisabledReason || t(running ? 'assistant.sendSteer' : 'assistant.send')">
                <UButton class="composer-send" :aria-label="showStop ? t('assistant.stop') : sendDisabledReason || t(running ? 'assistant.sendSteer' : 'assistant.send')" :icon="showStop ? 'i-ph-stop' : 'i-ph-arrow-up'" :color="showStop ? 'error' : 'primary'" :disabled="showStop ? interrupting : Boolean(sendDisabledReason)" :loading="showStop && interrupting" type="button" @click="showStop ? emit('interrupt') : emit('submit')" />
            </AppTooltip>
        </div>
    </form>
</template>

<script setup lang="ts">
import {
    useElementSize, useTextareaAutosize,
} from '@vueuse/core';
import type {
    IAssistantInstanceStatus, IAssistantSelection,
} from '@contracts/assistant';
import {
    getAssistantImagePreviewUrl, type TAssistantComposerImage,
} from '@app/modules/agent-panel/utils/assistantImageAttachments';
import AssistantProviderModelPicker from '@app/modules/agent-panel/components/AssistantProviderModelPicker.vue';
import { useTypedI18n } from '@app/composables/useTypedI18n';
const props = defineProps<{
    modelValue: string;
    images: TAssistantComposerImage[];
    instances: IAssistantInstanceStatus[];
    selection: IAssistantSelection | null;
    sendDisabledReason: string;
    running: boolean;
    interrupting: boolean;
    hasDocument: boolean;
    error: string;
}>();
const emit = defineEmits<{
    'update:modelValue': [value: string];
    submit: [];
    interrupt: [];
    paste: [event: ClipboardEvent];
    removeImage: [id: string];
    preview: [images: TAssistantComposerImage[], id: string];
    select: [selection: IAssistantSelection];
}>();
const { t } = useTypedI18n();
const composer = ref<HTMLFormElement | null>(null);
const { width: composerWidth } = useElementSize(composer);
// The prompt grows with its text and scrolls only once it reaches its maximum height.
const scrollable = ref(false);
const { textarea: input } = useTextareaAutosize({
    input: computed(() => props.modelValue),
    onResize: () => {
        scrollable.value = Boolean(input.value && input.value.scrollHeight > input.value.clientHeight);
    },
});
const showStop = computed(() => props.running && !props.modelValue.trim() && !props.images.length);
function handleKeydown(event: KeyboardEvent) {
    // Safari may clear isComposing before the final IME Enter.
    const legacyCode: unknown = Reflect.get(event, 'keyCode');
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || legacyCode === 229 || event.repeat) return;
    event.preventDefault();
    if (!props.sendDisabledReason) emit('submit');
}
function focus() { input.value?.focus({ preventScroll: true }); }
onMounted(() => { if (props.hasDocument) focus(); });
watch(() => props.hasDocument, async available => { if (available) { await nextTick(); focus(); } });
watch(() => props.images.length, async (count, previous) => { if (count > previous) { await nextTick(); focus(); } });
defineExpose({ focus });
</script>

<style scoped>
.assistant-composer {
    flex: 0 0 auto;
    min-width: 0;
    margin: var(--app-space-3xl) var(--app-space-9xl) var(--app-space-9xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-assistant-card-radius);
    background: var(--ui-bg-elevated);
}

.composer-input {
    display: block;
    width: 100%;
    min-height: var(--app-assistant-composer-min-height);
    max-height: var(--app-assistant-message-max-height);
    padding: var(--app-space-12xl) var(--app-space-9xl);
    overflow-y: hidden;
    resize: none;
    outline: none;
    background: none;
    color: var(--ui-text);
    font: inherit;
    font-size: var(--app-text-size-body);
    line-height: var(--app-line-height-body);
}

.composer-input.is-scrollable {
    overflow-y: auto;
}

.composer-input::placeholder {
    color: var(--ui-text-dimmed);
}

.assistant-composer:focus-within {
    border-color: var(--ui-primary);
}

.composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-3xl);
    padding: 0 var(--app-space-3xl) var(--app-space-3xl);
}

.composer-send {
    flex: 0 0 auto;
    width: var(--app-assistant-send-button-size);
    height: var(--app-assistant-send-button-size);
    justify-content: center;
    padding: 0;
    border-radius: var(--app-radius-full);
}

.composer-error {
    margin: 0;
    padding: var(--app-space-3xl) var(--app-space-12xl);
    color: var(--ui-error);
    font-size: var(--app-text-size-kicker);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.composer-images {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-3xl);
    padding: var(--app-space-9xl) var(--app-space-12xl) 0;
}

.composer-image {
    position: relative;
    width: var(--app-assistant-thumbnail-size);
    height: var(--app-assistant-thumbnail-size);
}

.composer-image img {
    width: var(--app-assistant-thumbnail-size);
    height: var(--app-assistant-thumbnail-size);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-2xl);
    object-fit: cover;
}

.remove-image {
    position: absolute;
    top: 0;
    right: 0;
    border-radius: var(--app-radius-full);
}
</style>
