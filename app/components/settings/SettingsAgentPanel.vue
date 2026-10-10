<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.assistantPanel') }}</legend>

        <div class="settings-agent-card settings-agent-card--stack">
            <div class="settings-agent-card-row">
                <div class="settings-agent-main">
                    <div class="settings-agent-status">
                        <UIcon
                            name="i-ph-chat-circle-dots"
                            class="settings-agent-status-icon"
                            :class="{ 'is-ready': assistantPanelEnabled }"
                        />
                        <span class="settings-agent-status-label">{{ assistantPanelStatusLabel }}</span>
                    </div>
                    <p class="settings-field-hint">{{ t('settings.assistantPanelDescription') }}</p>
                </div>

                <USwitch
                    :model-value="assistantPanelEnabled"
                    :label="t('settings.assistantPanelToggle')"
                    size="sm"
                    :ui="assistantSwitchUi"
                    @update:model-value="emit('update:assistantPanelEnabled', $event)"
                />
            </div>

            <div
                v-if="assistantPanelEnabled"
                class="settings-agent-auth"
            >
                <div class="settings-agent-auth-main">
                    <div class="settings-agent-status">
                        <UIcon
                            :name="assistantSetup.icon"
                            class="settings-agent-status-icon"
                            :class="assistantSetupIconClass"
                        />
                        <span class="settings-agent-status-label">{{ assistantSetupLabel }}</span>
                    </div>
                    <p class="settings-field-hint">{{ assistantSetupHint }}</p>
                </div>

                <div
                    v-if="assistantDeviceCode"
                    class="settings-agent-device-code"
                >
                    <span>{{ t('assistant.deviceCode') }}</span>
                    <strong>{{ assistantDeviceCode }}</strong>
                </div>

                <div class="settings-agent-actions settings-agent-actions--assistant">
                    <UButton
                        v-if="assistantSetup.primaryAction"
                        :label="assistantPrimaryActionLabel"
                        :icon="assistantSetup.primaryActionIcon ?? undefined"
                        color="primary"
                        :loading="isAssistantBusy"
                        :disabled="isAssistantBusy"
                        @click="handleAssistantPrimaryAction"
                    />
                    <UButton
                        v-if="assistantSetup.showCancelLogin"
                        :label="t('assistant.cancelLogin')"
                        icon="i-ph-x"
                        color="neutral"
                        variant="outline"
                        :disabled="isAssistantBusy"
                        @click="emit('cancelAssistantLogin')"
                    />
                    <UButton
                        :aria-label="t('assistant.refresh')"
                        icon="i-ph-arrows-clockwise"
                        color="neutral"
                        variant="ghost"
                        :loading="isAssistantBusy"
                        :disabled="isAssistantBusy"
                        @click="emit('refreshAssistant')"
                    />
                </div>
            </div>
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
import type {
    IAgentAssistantState,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import {
    getSettingsAssistantStatusModel,
    type TSettingsAssistantCopy,
} from '@app/modules/workspace-shell/public/settingsAssistant';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    assistantPanelEnabled,
    assistantState,
    assistantDeviceCode,
    isAssistantBusy,
    status,
    isBusy,
} = defineProps<{
    assistantPanelEnabled: boolean;
    assistantState: IAgentAssistantState | null;
    assistantDeviceCode: string;
    isAssistantBusy: boolean;
    status: IAgentMcpIntegrationStatus | null;
    isBusy: boolean;
}>();

const emit = defineEmits<{
    'update:assistantPanelEnabled': [enabled: boolean];
    refreshAssistant: [];
    installAssistant: [];
    startAssistantLogin: [];
    cancelAssistantLogin: [];
    setEnabled: [enabled: boolean];
    refresh: [];
    openInstall: [];
}>();

const { t } = useTypedI18n();
const { copy: copyClipboardText } = useClipboard();
const setupGuideOpen = ref(false);
const assistantSwitchUi = {
    root: 'settings-agent-switch-row',
    container: 'order-2',
    wrapper: 'order-1 ms-0',
    label: 'settings-agent-switch-label',
};
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
const assistantPanelStatusLabel = computed(() => assistantPanelEnabled
    ? t('settings.assistantPanelStatusEnabled')
    : t('settings.assistantPanelStatusDisabled'));
const assistantSetup = computed(() => getSettingsAssistantStatusModel(
    assistantState?.status ?? null,
    assistantState !== null,
));
const assistantSetupIconClass = computed(() => ({
    'is-ready': assistantSetup.value.tone === 'ready',
    'is-warning': assistantSetup.value.tone === 'warning',
}));
const assistantSetupLabel = computed(() => translateAssistantCopy(assistantSetup.value.label));
const assistantSetupHint = computed(() => assistantState?.status.error
    ?? translateAssistantCopy(assistantSetup.value.hint));
const assistantPrimaryActionLabel = computed(() => assistantSetup.value.primaryActionLabelKey
    ? t(assistantSetup.value.primaryActionLabelKey)
    : '');
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

function translateAssistantCopy(copy: TSettingsAssistantCopy) {
    switch (copy.key) {
        case 'settings.assistantPanelNeedsUpdateHint':
            return t(copy.key, copy.params);
        case 'settings.assistantPanelStatusReadyAccount':
            return t(copy.key, copy.params);
        case 'assistant.loginPending':
        case 'settings.assistantPanelCheckingHint':
        case 'settings.assistantPanelErrorHint':
        case 'settings.assistantPanelNeedsCodexHint':
        case 'settings.assistantPanelReadyHint':
        case 'settings.assistantPanelSignedOutHint':
        case 'settings.assistantPanelStatusChecking':
        case 'settings.assistantPanelStatusError':
        case 'settings.assistantPanelStatusLoginPending':
        case 'settings.assistantPanelStatusNeedsCodex':
        case 'settings.assistantPanelStatusNeedsUpdate':
        case 'settings.assistantPanelStatusReady':
        case 'settings.assistantPanelStatusSignedOut':
        case 'settings.assistantPanelStatusUnsupported':
        case 'settings.assistantPanelUnsupportedHint':
            return t(copy.key);
    }
}

function handleAssistantPrimaryAction() {
    switch (assistantSetup.value.primaryAction) {
        case 'install':
        case 'update':
            emit('installAssistant');
            return;
        case 'sign-in':
            emit('startAssistantLogin');
            return;
        case null:
            return;
    }
}

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

<style lang="scss" scoped>
@use '@app/assets/css/settings-panel-shared';

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

.settings-agent-auth {
    display: flex;
    align-items: flex-start;
    gap: var(--app-space-9xl);
    width: 100%;
    padding-top: var(--app-space-8xl);
    border-top: 1px solid var(--ui-border);
}

.settings-agent-auth-main {
    flex: 1 1 auto;
    min-width: 0;
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

.settings-agent-device-code {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-md);
    flex: 0 0 auto;
    max-width: 100%;
    padding: 0.3rem var(--app-space-2xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    background: var(--ui-bg-muted);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.settings-agent-device-code strong {
    color: var(--ui-text);
    font-family: var(--app-font-mono);
    font-weight: 700;
    letter-spacing: 0.02em;
}

.settings-agent-switch-row {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-5xl);
    flex-shrink: 0;
    cursor: pointer;
}

.settings-agent-switch-label {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    font-weight: var(--app-font-weight-medium);
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
    .settings-agent-auth,
    .settings-agent-install {
        flex-direction: column;
    }

    .settings-agent-switch-row,
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

    .settings-agent-switch-row {
        justify-content: space-between;
    }

    .settings-agent-copy-button {
        align-self: flex-start;
    }
}
</style>
