<template>
    <article class="settings-agent-card settings-agent-card--stack">
        <div class="instance-heading">
            <UIcon :name="card.icon" />
            <strong>{{ card.instance.displayName }}</strong>
            <span>{{ card.instance.id }}</span>
            <USwitch
                :model-value="card.instance.enabled"
                :label="t('assistant.instanceEnabled')"
                size="sm"
                @update:model-value="emit('update-instance', { enabled: $event })"
            />
        </div>
        <p class="settings-field-hint">{{ t(card.statusLabelKey) }}</p>
        <p v-if="card.statusMessage" class="instance-message">{{ card.statusMessage }}</p>
        <dl class="settings-agent-details">
            <div><dt>{{ t('assistant.binaryPath') }}</dt><dd>{{ card.binaryPath }}</dd></div>
            <div><dt>{{ t('assistant.version') }}</dt><dd>{{ card.version }}</dd></div>
            <div><dt>{{ t('assistant.homePath') }}</dt><dd>{{ card.homePath }}</dd></div>
        </dl>
        <p v-if="card.loginCode" class="instance-message">{{ t('assistant.deviceCode') }} {{ card.loginCode }}</p>
        <a v-if="card.loginUrl" :href="card.loginUrl" target="_blank" rel="noopener noreferrer">{{ card.loginUrl }}</a>
        <div class="settings-agent-actions settings-agent-actions--assistant">
            <UButton
                :label="t('assistant.refresh')"
                icon="i-ph-arrows-clockwise"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="disabled"
                @click="emit('refresh')"
            />
            <UButton
                v-if="card.canSignIn"
                :label="t('assistant.signIn')"
                size="xs"
                :disabled="disabled"
                @click="emit('login', 'chatgpt')"
            />
            <UButton
                v-if="card.canSignIn"
                :label="t('assistant.signInDeviceCode')"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="disabled"
                @click="emit('login', 'device-code')"
            />
            <UButton
                v-if="card.loginPending"
                :label="t('assistant.cancelLogin')"
                size="xs"
                :disabled="disabled"
                @click="emit('cancel-login')"
            />
            <UButton
                :label="t('assistant.deleteInstance')"
                icon="i-ph-trash"
                color="error"
                variant="ghost"
                size="xs"
                :disabled="disabled"
                @click="emit('remove')"
            />
        </div>
        <details class="instance-editor">
            <summary>{{ t('assistant.editInstance') }}</summary>
            <div class="instance-fields">
                <UFormField :label="t('assistant.displayName')">
                    <UInput
                        :model-value="card.instance.displayName"
                        class="w-full"
                        @update:model-value="emit('update-instance', { displayName: String($event) })"
                    />
                </UFormField>
                <UFormField :label="t('assistant.binaryPath')">
                    <UInput
                        :model-value="card.instance.binaryPath ?? ''"
                        class="w-full"
                        @update:model-value="emit('update-instance', { binaryPath: String($event) })"
                    />
                </UFormField>
                <UFormField :label="t('assistant.homePath')">
                    <UInput
                        :model-value="card.instance.homePath ?? ''"
                        class="w-full"
                        @update:model-value="emit('update-instance', { homePath: String($event) })"
                    />
                </UFormField>
                <UFormField v-if="card.instance.driver === 'codex'" :label="t('assistant.shadowHomePath')">
                    <UInput
                        :model-value="card.instance.shadowHomePath ?? ''"
                        class="w-full"
                        @update:model-value="emit('update-instance', { shadowHomePath: String($event) })"
                    />
                </UFormField>
                <UFormField :label="t('assistant.launchArgs')" :hint="card.launchArgsHint">
                    <UInput
                        :model-value="card.instance.launchArgs ?? ''"
                        :type="card.instance.launchArgsSecret ? 'password' : 'text'"
                        autocomplete="off"
                        class="w-full"
                        @update:model-value="emit('update-instance', { launchArgs: String($event) })"
                    />
                </UFormField>
                <UCheckbox
                    :model-value="card.instance.launchArgsSecret"
                    :label="t('assistant.secret')"
                    @update:model-value="emit('update-instance', { launchArgsSecret: $event === true })"
                />
                <fieldset class="instance-fields">
                    <legend>{{ t('assistant.environment') }}</legend>
                    <div
                        v-for="entry in card.instance.environment"
                        :key="entry.uiId"
                        class="environment-row"
                    >
                        <UInput
                            :model-value="entry.name"
                            :aria-label="t('assistant.environmentName')"
                            :placeholder="t('assistant.environmentName')"
                            @update:model-value="emit('update-environment', entry.uiId, { name: String($event) })"
                        />
                        <UInput
                            :model-value="entry.value"
                            :aria-label="t('assistant.environmentValue')"
                            :placeholder="entry.secret && entry.configured ? t('assistant.secretConfigured') : t('assistant.environmentValue')"
                            :type="entry.secret ? 'password' : 'text'"
                            autocomplete="off"
                            @update:model-value="emit('update-environment', entry.uiId, { value: String($event) })"
                        />
                        <UCheckbox
                            :model-value="entry.secret"
                            :label="t('assistant.secret')"
                            @update:model-value="emit('update-environment', entry.uiId, { secret: $event === true })"
                        />
                        <UButton
                            :aria-label="t('assistant.removeEnvironment')"
                            icon="i-ph-x"
                            color="neutral"
                            variant="ghost"
                            @click="emit('remove-environment', entry.uiId)"
                        />
                    </div>
                    <UButton
                        :label="t('assistant.addEnvironment')"
                        icon="i-ph-plus"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        @click="emit('add-environment')"
                    />
                </fieldset>
            </div>
        </details>
    </article>
</template>

<script setup lang="ts">
import type { IAssistantInstanceConfig } from '@contracts/assistant';
import type { getSettingsAssistantStatusModel } from '@app/modules/workspace-shell/public/settingsAssistant';
import { useTypedI18n } from '@app/composables/useTypedI18n';

export interface IEditableAssistantEnvironmentEntry {
    uiId: string;
    name: string;
    value: string;
    secret: boolean;
    configured?: boolean | undefined;
}

export interface IEditableAssistantInstanceConfig extends Omit<IAssistantInstanceConfig, 'environment'> {
    environment: IEditableAssistantEnvironmentEntry[];
}

export interface ISettingsAgentInstanceCardModel {
    instance: IEditableAssistantInstanceConfig;
    icon: string;
    statusLabelKey: ReturnType<typeof getSettingsAssistantStatusModel>['label']['key'];
    statusMessage: string;
    binaryPath: string | undefined;
    version: string | null | undefined;
    homePath: string | undefined;
    loginCode: string;
    loginUrl: string;
    canSignIn: boolean;
    loginPending: boolean;
    launchArgsHint: string;
}

defineProps<{
    card: ISettingsAgentInstanceCardModel;
    disabled: boolean;
}>();

const emit = defineEmits<{
    refresh: [];
    login: [mode: 'chatgpt' | 'device-code'];
    'cancel-login': [];
    remove: [];
    'update-instance': [patch: Partial<IEditableAssistantInstanceConfig>];
    'add-environment': [];
    'update-environment': [uiId: string, patch: Partial<Omit<IEditableAssistantEnvironmentEntry, 'uiId'>>];
    'remove-environment': [uiId: string];
}>();

const { t } = useTypedI18n();
</script>

<style scoped>
.settings-agent-card {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-9xl);
    padding: var(--app-space-9xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-elevated);
}

.settings-agent-card--stack {
    flex-direction: column;
}

.settings-agent-actions {
    display: flex;
    align-items: center;
    gap: var(--app-space-md);
    flex-shrink: 0;
}

.settings-agent-actions--assistant {
    flex-wrap: wrap;
    justify-content: flex-end;
}

.settings-agent-details {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--app-space-md);
    margin: 0;
}

.settings-agent-details div {
    display: grid;
    grid-template-columns: minmax(5.5rem, 0.35fr) minmax(0, 1fr);
    gap: var(--app-space-3xl);
    min-width: 0;
}

.settings-agent-details dt {
    color: var(--ui-text-dimmed);
    font-size: var(--app-text-size-kicker);
}

.settings-agent-details dd {
    margin: 0;
    min-width: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-kicker);
    overflow-wrap: anywhere;
}

.instance-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--app-space-3xl);
    width: 100%;
}

.instance-heading strong {
    flex: 1;
}

.instance-heading span {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.instance-message {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    font-size: var(--app-text-size-body-sm);
}

.instance-editor {
    width: 100%;
}

.instance-editor summary {
    cursor: pointer;
    color: var(--ui-text-muted);
}

.instance-fields {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
    padding-top: var(--app-space-3xl);
}

.environment-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--app-space-3xl);
}

@container (max-width: 42rem) {
    .settings-agent-actions {
        width: 100%;
        justify-content: flex-start;
    }
}

@container (max-width: 36rem) {
    .settings-agent-card {
        flex-direction: column;
        align-items: stretch;
    }

    .settings-agent-actions {
        justify-content: flex-start;
        flex-wrap: wrap;
    }
}
</style>
