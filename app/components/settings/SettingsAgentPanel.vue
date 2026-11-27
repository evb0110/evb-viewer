<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.assistantPanel') }}</legend>
        <div class="settings-agent-card settings-agent-card-row">
            <div class="settings-agent-main">
                <strong>{{ t(assistantPanelEnabled ? 'settings.assistantPanelStatusEnabled' : 'settings.assistantPanelStatusDisabled') }}</strong>
                <p class="settings-field-hint">{{ t('settings.assistantPanelDescription') }}</p>
            </div>
            <USwitch :model-value="assistantPanelEnabled" :label="t('settings.assistantPanelToggle')" size="sm" @update:model-value="emit('update:assistantPanelEnabled', $event)" />
        </div>
        <h3 class="settings-section-title">{{ t('assistant.providerInstances') }}</h3>
        <p v-if="instanceError" class="instance-error" role="alert">{{ instanceError }}</p>
        <p v-for="notice in notices" :key="notice" class="settings-field-hint" role="status">{{ notice }}</p>
        <!-- Edits pause while a save or refresh runs, so its reply cannot overwrite them. -->
        <fieldset :disabled="!!activeAction" class="instance-editor">
            <SettingsAgentInstanceCard
                v-for="card in instanceCards"
                :key="card.instance.id"
                :card="card"
                :disabled="!!activeAction"
                @refresh="refreshInstance(card.instance.id)"
                @login="loginInstance(card.instance.id, $event)"
                @cancel-login="cancelInstanceLogin(card.instance.id)"
                @remove="removeInstance(card.instance.id)"
                @update-instance="updateInstance(card.instance.id, $event)"
                @add-environment="addEnvironmentEntry(card.instance)"
                @update-environment="(uiId, patch) => updateEnvironmentEntry(card.instance, uiId, patch)"
                @remove-environment="removeEnvironmentEntry(card.instance, $event)"
            />
        </fieldset>
        <div class="instance-add">
            <USelect v-model="newDriver" :items="drivers" :aria-label="t('assistant.driver')" />
            <UInput v-model="newId" :placeholder="t('assistant.instanceId')" :aria-label="t('assistant.instanceId')" />
            <UButton :label="t('assistant.addInstance')" icon="i-ph-plus" color="neutral" variant="outline" :disabled="!!activeAction" @click="addInstance" />
        </div>
        <div class="settings-agent-actions settings-agent-actions--assistant">
            <UButton :label="t('assistant.saveInstances')" :disabled="!!activeAction" @click="saveInstances" />
        </div>
    </fieldset>

    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.agentMcp') }}</legend>

        <div class="settings-agent-card">
            <div class="settings-agent-main">
                <div class="settings-agent-status">
                    <UIcon
                        :name="statusIcon"
                        class="settings-agent-status-icon"
                        :class="statusClass"
                    />
                    <span class="settings-agent-status-label">{{ statusLabel }}</span>
                </div>
                <p class="settings-field-hint">{{ statusHint }}</p>
            </div>

            <div class="settings-agent-actions">
                <UButton
                    :label="primaryActionLabel"
                    :icon="primaryActionIcon"
                    color="neutral"
                    :variant="status?.enabled && !needsRepair ? 'soft' : 'solid'"
                    :loading="isBusy"
                    :disabled="isBusy || !status"
                    @click="emit('setEnabled', primaryActionEnabled)"
                />
                <UButton
                    :label="t('settings.agentMcpSetupGuide')"
                    icon="i-ph-info"
                    color="neutral"
                    variant="outline"
                    :disabled="!status"
                    @click="setupGuideOpen = true"
                />
                <UButton
                    :aria-label="t('settings.agentMcpRefresh')"
                    icon="i-ph-arrows-clockwise"
                    color="neutral"
                    variant="ghost"
                    :loading="isBusy"
                    :disabled="isBusy"
                    @click="emit('refresh')"
                />
            </div>
        </div>

        <dl
            v-if="status"
            class="settings-agent-details"
        >
            <div>
                <dt>{{ t('settings.agentMcpServerName') }}</dt>
                <dd>{{ status.serverName }}</dd>
            </div>
            <div>
                <dt>{{ t('settings.agentMcpUrl') }}</dt>
                <dd>{{ status.serverUrl || t('settings.agentMcpUnavailable') }}</dd>
            </div>
            <div>
                <dt>{{ t('settings.agentMcpCodex') }}</dt>
                <dd>{{ codexLocationLabel }}</dd>
            </div>
        </dl>

        <div
            v-if="showInstallCodex"
            class="settings-agent-install"
        >
            <p class="settings-field-hint">{{ t('settings.agentMcpInstallHint') }}</p>
            <UButton
                :label="t('settings.agentMcpInstallCodex')"
                icon="i-ph-arrow-square-out"
                color="neutral"
                variant="outline"
                @click="emit('openInstall')"
            />
        </div>
    </fieldset>

    <UModal
        v-model:open="setupGuideOpen"
        :title="t('settings.agentMcpSetupTitle')"
        :ui="{ footer: 'justify-end' }"
    >
        <template #description>
            <span class="sr-only">{{ t('settings.agentMcpSetupDescription') }}</span>
        </template>

        <template #body>
            <div class="settings-agent-guide">
                <p class="settings-field-hint">{{ t('settings.agentMcpSetupDescription') }}</p>

                <dl class="settings-agent-details settings-agent-details--guide">
                    <div>
                        <dt>{{ t('settings.agentMcpServerName') }}</dt>
                        <dd>{{ mcpServerName }}</dd>
                    </div>
                    <div>
                        <dt>{{ t('settings.agentMcpUrl') }}</dt>
                        <dd>{{ mcpServerUrl }}</dd>
                    </div>
                </dl>

                <section class="settings-agent-guide-section">
                    <h3>{{ t('settings.agentMcpSetupCodexTitle') }}</h3>
                    <ol>
                        <li>{{ t('settings.agentMcpSetupCodexAccess') }}</li>
                        <li>{{ t('settings.agentMcpSetupCodexEnable') }}</li>
                        <li>{{ t('settings.agentMcpSetupCodexVerify') }}</li>
                    </ol>
                    <div class="settings-agent-code-block">
                        <pre class="app-scrollbar"><code>{{ codexCommand }}</code></pre>
                        <UButton
                            :label="copyButtonLabel('codex')"
                            :icon="copyButtonIcon('codex')"
                            class="settings-agent-copy-button"
                            color="neutral"
                            variant="outline"
                            size="sm"
                            @click="copySetupSnippet('codex', codexCommand)"
                        />
                    </div>
                </section>

                <section class="settings-agent-guide-section">
                    <h3>{{ t('settings.agentMcpSetupClaudeTitle') }}</h3>
                    <p class="settings-field-hint">{{ t('settings.agentMcpSetupClaudeDescription') }}</p>
                    <div class="settings-agent-code-block">
                        <pre class="app-scrollbar"><code>{{ claudeCommand }}</code></pre>
                        <UButton
                            :label="copyButtonLabel('claude')"
                            :icon="copyButtonIcon('claude')"
                            class="settings-agent-copy-button"
                            color="neutral"
                            variant="outline"
                            size="sm"
                            @click="copySetupSnippet('claude', claudeCommand)"
                        />
                    </div>
                </section>

                <section class="settings-agent-guide-section">
                    <h3>{{ t('settings.agentMcpSetupCursorTitle') }}</h3>
                    <p class="settings-field-hint">{{ t('settings.agentMcpSetupCursorDescription') }}</p>
                    <div class="settings-agent-code-block">
                        <pre class="app-scrollbar"><code>{{ cursorConfig }}</code></pre>
                        <UButton
                            :label="copyButtonLabel('cursor')"
                            :icon="copyButtonIcon('cursor')"
                            class="settings-agent-copy-button"
                            color="neutral"
                            variant="outline"
                            size="sm"
                            @click="copySetupSnippet('cursor', cursorConfig)"
                        />
                    </div>
                </section>

                <p class="settings-field-hint">{{ t('settings.agentMcpSetupAvailability') }}</p>
            </div>
        </template>

        <template #footer="{ close }">
            <UButton
                :label="t('settings.close')"
                color="neutral"
                variant="outline"
                @click="close"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import {
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';
import type {IAgentMcpIntegrationStatus} from '@contracts/agent';
import {
    getSettingsAssistantStatusModel,
    runSettingsAssistantAction,
} from '@app/modules/workspace-shell/public/settingsAssistant';
import {
    ASSISTANT_INSTANCE_ID_PATTERN, type IAssistantInstanceConfig, type IAssistantInstanceStatus, type IAssistantInstancesResult, type IAssistantOperationResult, type IAssistantState, type TAssistantDriver,
} from '@contracts/assistant';
import { getAgentCapability } from '@app/utils/getAgentCapability';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import { BrowserLogger } from '@app/utils/browserLogger';
import SettingsAgentInstanceCard, {
    type IEditableAssistantEnvironmentEntry,
    type IEditableAssistantInstanceConfig,
    type ISettingsAgentInstanceCardModel,
} from '@app/components/settings/SettingsAgentInstanceCard.vue';

const {
    assistantPanelEnabled,
    status,
    isBusy,
} = defineProps<{
    assistantPanelEnabled: boolean;
    status: IAgentMcpIntegrationStatus | null;
    isBusy: boolean;
}>();

const emit = defineEmits<{
    'update:assistantPanelEnabled': [enabled: boolean];
    setEnabled: [enabled: boolean];
    refresh: [];
    openInstall: [];
}>();

const { t } = useTypedI18n();
const { copy: copyClipboardText } = useClipboard();
const setupGuideOpen = ref(false);
const instances = ref<IEditableAssistantInstanceConfig[]>([]);
const liveState = ref<IAssistantState | null>(null);
const instanceError = ref('');
const notices = ref<string[]>([]);
const activeAction = ref<'refresh' | 'login' | 'cancel' | 'save' | null>(null);
const newDriver = ref<TAssistantDriver>('codex');
const newId = ref('');
const loginCodes = ref<Record<string, string>>({});
const loginUrls = ref<Record<string, string>>({});
const drivers = [
    {
        value: 'codex',
        label: 'Codex',
    },
    {
        value: 'claude',
        label: 'Claude',
    },
];
let disposed = false;
let nextEnvironmentEntryUiId = 0;
function createEnvironmentEntryUiId() {
    nextEnvironmentEntryUiId += 1;
    return `env-${nextEnvironmentEntryUiId}`;
}
const liveInstancesById = computed(() => new Map(
    (liveState.value?.instances ?? []).map(instance => [
        instance.id,
        instance,
    ]),
));
const instanceCards = computed<ISettingsAgentInstanceCardModel[]>(() => instances.value.map(instance => {
    const live = liveInstancesById.value.get(instance.id) ?? null;
    const instanceStatus = getSettingsAssistantStatusModel(live);
    const loginPending = Boolean(live?.loginPending);
    return {
        instance,
        icon: instance.driver === 'codex' ? 'i-ph-terminal' : 'i-ph-brain',
        statusLabelKey: instanceStatus.label.key,
        statusMessage: instanceStatus.message,
        binaryPath: live?.binaryPath || instance.binaryPath,
        version: live?.version,
        homePath: live?.homePath || instance.homePath,
        loginCode: loginCodes.value[instance.id] ?? '',
        loginUrl: loginUrls.value[instance.id] ?? '',
        canSignIn: Boolean(live?.canSignIn) && !loginPending,
        loginPending,
        launchArgsHint: instance.launchArgsSecret && instance.launchArgsConfigured
            ? t('assistant.secretConfigured')
            : '',
    };
}));
function removeInstance(id: string) {
    instances.value = instances.value.filter(item => item.id !== id);
}
function updateInstance(id: string, patch: Partial<IEditableAssistantInstanceConfig>) {
    const target = instances.value.find(item => item.id === id);
    if (target) {
        Object.assign(target, patch);
    }
}
function addEnvironmentEntry(instance: IEditableAssistantInstanceConfig) {
    instance.environment.push({
        uiId: createEnvironmentEntryUiId(),
        name: '',
        value: '',
        secret: false,
    });
}
function updateEnvironmentEntry(
    instance: IEditableAssistantInstanceConfig,
    uiId: string,
    patch: Partial<Omit<IEditableAssistantEnvironmentEntry, 'uiId'>>,
) {
    const entry = instance.environment.find(item => item.uiId === uiId);
    if (entry) {
        Object.assign(entry, patch);
    }
}
function removeEnvironmentEntry(instance: IEditableAssistantInstanceConfig, uiId: string) {
    const index = instance.environment.findIndex(item => item.uiId === uiId);
    if (index >= 0) {
        instance.environment.splice(index, 1);
    }
}
function applyInstances(result: IAssistantInstancesResult) {
    if (disposed) {return;}
    notices.value = result.notices;
    instanceError.value = result.error ?? '';
    if (result.ok) {instances.value = result.instances.map(instance => ({
        ...instance,
        environment: instance.environment?.map(entry => ({
            ...entry,
            uiId: createEnvironmentEntryUiId(),
        })) ?? [],
    }));}
}
function serializeInstanceForSave(instance: IEditableAssistantInstanceConfig): IAssistantInstanceConfig {
    return {
        ...instance,
        environment: instance.environment.map(({
            uiId: _uiId,
            ...entry
        }) => ({ ...entry })),
    };
}
function applyOperation(result: IAssistantOperationResult) {
    if (disposed) {return;}
    liveState.value = result.state;
    if (!result.ok) {instanceError.value = result.error?.message ?? '';}
}
function run(action: NonNullable<typeof activeAction.value>, callback: () => Promise<void>) {
    return runSettingsAssistantAction({
        action,
        activeAction,
        error: instanceError,
        run: callback,
        isActive: () => !disposed,
    });
}
async function loadInstances() {
    await run('refresh', async () => {
        // The configuration and the live status load independently: a failed
        // status read must not leave the editor without the saved instances.
        const [
            config,
            state,
        ] = await Promise.allSettled([
            getAgentCapability().getAssistantInstances(),
            getAgentCapability().getAssistantState(),
        ]);
        if (disposed) {return;}
        if (config.status === 'fulfilled') {applyInstances(config.value);}
        if (state.status === 'fulfilled') {
            liveState.value = state.value;
            if (pendingInstances) {liveState.value.instances = pendingInstances;}
        }
        pendingInstances = null;
        if (config.status === 'rejected') {throw config.reason;}
        if (state.status === 'rejected') {throw state.reason;}
    });
}
function addInstance() {
    const id = newId.value.trim();
    if (!ASSISTANT_INSTANCE_ID_PATTERN.test(id) || instances.value.some(instance => instance.id === id)) {
        instanceError.value = t('assistant.invalidInstanceId');
        return;
    }
    instances.value.push({
        id,
        driver: newDriver.value,
        displayName: id,
        enabled: true,
        environment: [],
    });
    newId.value = '';
    instanceError.value = '';
}
function saveInstances() {
    void run('save', async () => {
        // IPC needs plain objects, not the reactive rows the editor binds to.
        applyInstances(await getAgentCapability().saveAssistantInstances(
            instances.value.map(serializeInstanceForSave),
        ));
        const state = await getAgentCapability().getAssistantState();
        if (!disposed) {liveState.value = state;}
    });
}
function refreshInstance(instanceId: string) {
    void run('refresh', async () => {
        const state = await getAgentCapability().getAssistantState({
            selection: {
                instanceId,
                model: liveInstancesById.value.get(instanceId)?.defaultModel ?? '',
                effort: 'medium',
                speedMode: 'standard',
            },
            probe: true,
        });
        if (!disposed) {liveState.value = state;}
    });
}
function loginInstance(instanceId: string, mode: 'chatgpt' | 'device-code') {
    void run('login', async () => {
        const result = await getAgentCapability().startAssistantLogin({
            instanceId,
            mode,
        });
        applyOperation(result);
        if (disposed) {return;}
        loginCodes.value[instanceId] = result.userCode ?? '';
        loginUrls.value[instanceId] = result.verificationUrl ?? result.authUrl ?? '';
    });
}
function cancelInstanceLogin(instanceId: string) {
    void run('cancel', async () => {
        const state = await getAgentCapability().cancelAssistantLogin({ instanceId });
        if (disposed) {return;}
        liveState.value = state;
        loginCodes.value[instanceId] = '';
        loginUrls.value[instanceId] = '';
    });
}
let unsubscribe: (() => void) | undefined;
let pendingInstances: IAssistantInstanceStatus[] | null = null;
onMounted(() => {
    unsubscribe = getAgentCapability().onAssistantEvent(event => {
        if (disposed) {return;}
        // Status that arrives before the first snapshot is newer than it.
        if (!liveState.value) {
            if (event.type === 'instances') {pendingInstances = event.instances;}
            return;
        }
        if (event.type === 'instances') {liveState.value.instances = event.instances;}
    });
    void loadInstances();
});
onBeforeUnmount(() => { disposed = true; unsubscribe?.(); });
type TSetupSnippetId = 'codex' | 'claude' | 'cursor';
const copiedSetupSnippet = ref<TSetupSnippetId | null>(null);
const {
    start: startCopiedSnippetReset,
    stop: stopCopiedSnippetReset,
} = useTimeoutFn(() => {
    copiedSetupSnippet.value = null;
}, 1800, { immediate: false });

const needsRepair = computed(() => status?.enabled === true && (
    !status.serverRunning
    || !status.codexConfigured
    || status.codexRegistrationState !== 'configured'
));

const primaryActionEnabled = computed(() => {
    if (needsRepair.value) {
        return true;
    }
    return status?.enabled !== true;
});

const primaryActionLabel = computed(() => {
    if (needsRepair.value) {
        return t('settings.agentMcpRepair');
    }
    return status?.enabled
        ? t('settings.agentMcpDisable')
        : t('settings.agentMcpEnable');
});

const primaryActionIcon = computed(() => {
    if (needsRepair.value) {
        return 'i-ph-arrows-clockwise';
    }
    return status?.enabled
        ? 'i-ph-warning-circle'
        : 'i-ph-check-circle';
});

const showInstallCodex = computed(() => status !== null && !status.codexInstalled);
const mcpServerName = computed(() => status?.serverName ?? t('settings.agentMcpUnavailable'));
const mcpServerUrl = computed(() => status?.serverUrl.length
    ? status.serverUrl
    : t('settings.agentMcpUnavailable'));
const codexCommand = computed(() => status?.setupSnippets?.codex
    ?? `codex mcp add ${mcpServerName.value} --url ${mcpServerUrl.value}`);
const claudeCommand = computed(() => status?.setupSnippets?.claude
    ?? `claude mcp add --transport http --scope user ${mcpServerName.value} ${mcpServerUrl.value}`);
const cursorConfig = computed(() => status?.setupSnippets?.cursor
    ?? JSON.stringify(
        { mcpServers: { [mcpServerName.value]: { url: mcpServerUrl.value } } },
        null,
        2,
    ));

const statusKind = computed(() => {
    const currentStatus = status;
    if (!currentStatus) {
        return 'starting';
    }
    if (currentStatus.error) {
        return 'error';
    }
    if (!currentStatus.enabled) {
        return 'disabled';
    }
    if (!currentStatus.codexInstalled) {
        return 'unknown';
    }
    if (currentStatus.serverRunning && currentStatus.codexConfigured && currentStatus.codexRegistrationState === 'configured') {
        return 'configured';
    }
    return currentStatus.codexRegistrationState;
});

const statusLabel = computed(() => {
    switch (statusKind.value) {
        case 'configured':
            return t('settings.agentMcpStatusReady');
        case 'disabled':
            return t('settings.agentMcpStatusDisabled');
        case 'missing':
            return t('settings.agentMcpStatusMissing');
        case 'mismatched':
            return t('settings.agentMcpStatusMismatched');
        case 'error':
            return t('settings.agentMcpStatusError');
        case 'starting':
            return t('settings.agentMcpStatusStarting');
        case 'unknown':
            return t('settings.agentMcpStatusCodexMissing');
    }
});

const statusHint = computed(() => {
    const currentStatus = status;
    if (!currentStatus) {
        return t('settings.agentMcpDescription');
    }
    if (currentStatus.error) {
        return currentStatus.error;
    }
    if (!currentStatus.enabled) {
        return t('settings.agentMcpDescription');
    }
    if (!currentStatus.codexInstalled) {
        return t('settings.agentMcpInstallHint');
    }
    if (!currentStatus.serverRunning) {
        return t('settings.agentMcpStatusServerStopped');
    }
    if (!currentStatus.codexConfigured) {
        return t('settings.agentMcpStatusMismatchedHint');
    }
    return t('settings.agentMcpStatusReadyHint');
});

const statusIcon = computed(() => {
    switch (statusKind.value) {
        case 'configured':
            return 'i-ph-check-circle';
        case 'starting':
            return 'i-ph-arrows-clockwise';
        case 'disabled':
            return 'i-ph-chat-circle-dots';
        case 'missing':
        case 'mismatched':
        case 'error':
        case 'unknown':
            return 'i-ph-warning-circle';
    }
});

const statusClass = computed(() => ({
    'is-ready': statusKind.value === 'configured',
    'is-warning': statusKind.value !== 'configured' && statusKind.value !== 'disabled' && statusKind.value !== 'starting',
}));

const codexLocationLabel = computed(() => {
    if (!status?.codexInstalled) {
        return t('settings.agentMcpCodexMissing');
    }
    return status.codexPath ?? t('settings.agentMcpUnavailable');
});

function copyButtonLabel(snippet: TSetupSnippetId) {
    return copiedSetupSnippet.value === snippet
        ? t('toolbar.captureCopied')
        : t('menu.copy');
}

function copyButtonIcon(snippet: TSetupSnippetId) {
    return copiedSetupSnippet.value === snippet
        ? 'i-ph-check'
        : 'i-ph-copy';
}

async function copySetupSnippet(snippet: TSetupSnippetId, value: string) {
    try {
        await copyClipboardText(value);
        stopCopiedSnippetReset();
        copiedSetupSnippet.value = snippet;
        startCopiedSnippetReset();
    } catch (error) {
        BrowserLogger.warn('settings', 'Failed to copy external MCP setup snippet', error);
    }
}
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

.settings-agent-card-row {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-9xl);
    width: 100%;
}

.settings-agent-main {
    flex: 1 1 auto;
    min-width: 0;
}

.settings-agent-status {
    display: flex;
    align-items: center;
    gap: var(--app-space-xl);
    color: var(--ui-text);
}

.settings-agent-status-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
    flex-shrink: 0;
    color: var(--ui-text-dimmed);
}

.settings-agent-status-icon.is-ready {
    color: var(--ui-primary);
}

.settings-agent-status-icon.is-warning {
    color: var(--ui-text);
}



.settings-agent-status-label {
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-semibold);
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

.settings-agent-details--guide {
    padding: var(--app-space-7xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-muted);
}

.settings-agent-install {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-9xl);
}

@container (max-width: 42rem) {
    .settings-agent-card-row,
    .settings-agent-install {
        flex-direction: column;
    }

    .settings-agent-actions,
    .settings-agent-install {
        width: 100%;
    }

    .settings-agent-actions {
        justify-content: flex-start;
    }
}

.settings-agent-guide {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-11xl);
}

.settings-agent-guide-section {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-2xl);
}

.settings-agent-guide-section h3 {
    margin: 0;
    color: var(--ui-text);
    font-size: var(--app-text-size-body);
    font-weight: var(--app-font-weight-heading);
}

.settings-agent-guide-section ol {
    margin: 0;
    padding-left: var(--app-space-15xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-body);
}

.settings-agent-code-block {
    display: flex;
    align-items: stretch;
    flex-direction: column;
    gap: var(--app-space-3xl);
    min-width: 0;
}

.settings-agent-code-block pre {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    padding: var(--app-space-7xl);
    overflow-x: auto;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-elevated);
    color: var(--ui-text);
    font-size: var(--app-text-size-kicker);
    line-height: var(--app-line-height-body);
    user-select: text;
}

.settings-agent-code-block code {
    display: block;
    width: max-content;
    min-width: 100%;
    user-select: text;
}

.settings-agent-copy-button {
    order: -1;
    align-self: flex-end;
}

@container (max-width: 36rem) {
    .settings-agent-card,
    .settings-agent-install {
        flex-direction: column;
        align-items: stretch;
    }

    .settings-agent-actions {
        justify-content: flex-start;
        flex-wrap: wrap;
    }


    .settings-agent-copy-button {
        align-self: flex-start;
    }
}

.instance-error {
    color: var(--ui-error);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}

.instance-editor {
    width: 100%;
}

.instance-add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--app-space-3xl);
}

</style>
