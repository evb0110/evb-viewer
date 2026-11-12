<template>
    <section v-if="instance && instance.state !== 'ready' && statusKey !== dismissedKey" class="provider-banner" :class="{ 'is-checking': instance.state === 'checking' }" :role="instance.state === 'checking' ? 'status' : 'alert'">
        <template v-if="instance.state === 'checking'">
            <UIcon name="i-ph-circle-notch" />
            <span>{{ t('assistant.checkingInstance', { label: instance.label }) }}</span>
            <span v-if="instance.message" class="provider-progress">{{ instance.message }}</span>
            <UButton :aria-label="t('assistant.refresh')" icon="i-ph-arrows-clockwise" size="xs" color="neutral" variant="ghost" :disabled="busy" @click="emit('refresh')" />
        </template>
        <template v-else>
            <header class="provider-header">
                <strong>{{ instance.label }}</strong>
                <UButton :aria-label="t('assistant.dismissStatus')" icon="i-ph-x" size="xs" color="neutral" variant="ghost" @click="dismissedKey = statusKey" />
            </header>
            <p v-if="instance.state === 'disabled'">{{ t('assistant.instanceDisabled') }}</p>
            <p v-if="instance.message" class="provider-message">{{ instance.message }}</p>
            <div class="provider-actions">
                <UButton :label="t('assistant.refresh')" icon="i-ph-arrows-clockwise" size="xs" color="neutral" variant="ghost" :disabled="busy" @click="emit('refresh')" />
                <UButton v-if="instance.canInstall" :label="t('assistant.installCodex')" size="xs" :disabled="busy" @click="emit('install')" />
                <template v-if="instance.canSignIn && instance.auth === 'unauthenticated' && !instance.loginPending">
                    <UButton :label="t('assistant.signIn')" size="xs" :disabled="busy" @click="emit('signIn', 'chatgpt')" />
                    <UButton :label="t('assistant.signInDeviceCode')" color="neutral" variant="ghost" size="xs" :disabled="busy" @click="emit('signIn', 'device-code')" />
                </template>
                <UButton v-if="instance.loginPending" :label="t('assistant.cancelLogin')" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('cancelLogin')" />
            </div>
        </template>
        <p v-if="progress" class="provider-progress">{{ progress }}</p>
        <p v-if="deviceCode" class="provider-progress">{{ t('assistant.deviceCode') }} <strong>{{ deviceCode }}</strong></p>
        <a v-if="verificationUrl" :href="verificationUrl" target="_blank" rel="noopener noreferrer">{{ verificationUrl }}</a>
    </section>
</template>

<script setup lang="ts">
import type { IAssistantInstanceStatus } from '@contracts/assistant';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const props = defineProps<{
    instance: IAssistantInstanceStatus | null;
    busy?: boolean;
    progress?: string | null;
    deviceCode?: string;
    verificationUrl?: string
}>();
const emit = defineEmits<{
    refresh: [];
    install: [];
    signIn: [mode: 'chatgpt' | 'device-code'];
    cancelLogin: []
}>();
const { t } = useTypedI18n();
// A dismissed status stays hidden until the instance reports something new.
const dismissedKey = ref<string | null>(null);
const statusKey = computed(() => props.instance
    ? `${props.instance.id}:${props.instance.state}:${props.instance.message ?? ''}`
    : null);
</script>

<style scoped>
.provider-banner {
    flex: 0 0 auto;
    min-width: 0;
    max-height: var(--app-assistant-banner-max-height);
    margin: var(--app-space-9xl) var(--app-space-9xl) 0;
    padding: var(--app-space-9xl);
    overflow: auto;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-3xl);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    user-select: text;
}

.provider-banner.is-checking {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-lg);
    padding: var(--app-space-sm) 0;
    border: 0;
    background: none;
    color: var(--ui-text-muted);
}

.provider-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-sm);
}

.provider-message {
    margin: var(--app-space-lg) 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.provider-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-sm);
}

.provider-progress {
    overflow-wrap: anywhere;
}

.provider-banner a {
    color: var(--ui-primary);
    overflow-wrap: anywhere;
}
</style>
