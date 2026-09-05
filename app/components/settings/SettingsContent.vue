<template>
    <div
        v-if="!isLoaded || settingsLoadFailed"
        class="settings-state"
        :role="settingsLoadFailed ? 'alert' : 'status'"
        aria-live="polite"
    >
        <AppFailureAlert
            v-if="settingsLoadFailed && settingsLoadFailurePresentation"
            :presentation="settingsLoadFailurePresentation"
            icon="i-ph-warning-circle"
        />
        <UAlert
            v-else
            color="neutral"
            variant="soft"
            icon="i-ph-warning-circle"
            :description="settingsLoadFailed
                ? `${t('errors.settings.load')}: ${settingsLoadError ?? t('errors.runtime.description')}`
                : t('common.loading')"
        />
        <UButton
            v-if="settingsLoadFailed"
            color="neutral"
            variant="outline"
            :label="t('common.retry')"
            :loading="settingsLoadPending"
            @click="retrySettingsLoad"
        />
    </div>

    <div
        class="settings-grid"
        :aria-busy="!isLoaded"
        :inert="!isLoaded ? true : undefined"
    >
        <section class="settings-card">
            <SettingsGeneralPanel
                :settings="settings"
                :locale-items="localeItems"
                :selected-flag-icon="selectedFlagIcon"
                @update:author-name="updateSettingSafely('authorName', $event)"
                @update:suppress-unencrypted-save-notice="updateSettingSafely('suppressUnencryptedSaveNotice', $event)"
                @update:theme="applyTheme"
                @update:locale="applyLocale"
                @update:ui-scale="updateSettingSafely('uiScale', $event)"
            />
        </section>

        <section class="settings-card">
            <SettingsViewerDefaultsPanel
                :settings="settings"
                :zoom-preset-items="zoomPresetItems"
                :view-mode-items="viewModeItems"
                :scroll-mode-items="scrollModeItems"
                :tab-memory-policy-items="tabMemoryPolicyItems"
                :annotation-color-swatches="annotationColorSwatches"
                @update:zoom-preset="applyZoomPreset"
                @update:view-mode="applyViewMode"
                @update:scroll-mode="applyScrollMode"
                @update:tab-memory-policy="applyTabMemoryPolicy"
                @update:annotation-color="updateSettingSafely('defaultAnnotationColor', $event)"
                @update:optimize-pdf-on-save-as="updateSettingSafely('optimizePdfOnSaveAs', $event)"
            />
        </section>

        <section class="settings-card">
            <SettingsPerformancePanel
                :settings="settings"
                @update:performance-mode="applyPerformanceMode"
            />
        </section>

        <section class="settings-card">
            <SettingsPrivacyPanel
                :settings="settings"
                @update:client-diagnostics-preference="applyClientDiagnosticsPreference"
            />
        </section>

        <section v-if="isDesktopRuntime" class="settings-card settings-card--span">
            <SettingsAgentPanel
                :assistant-panel-enabled="settings.assistantPanelEnabled"
                :assistant-state="assistantState"
                :assistant-device-code="assistantDeviceCode"
                :is-assistant-busy="isAssistantBusy"
                :status="agentMcpStatus"
                :is-busy="isAgentMcpBusy"
                @update:assistant-panel-enabled="updateAssistantPanelEnabled"
                @refresh-assistant="refreshAssistantState"
                @install-assistant="installAssistantCodex"
                @start-assistant-login="startAssistantLogin"
                @cancel-assistant-login="cancelAssistantLogin"
                @set-enabled="setAgentMcpEnabled"
                @refresh="refreshAgentMcpStatus"
                @open-install="openAgentMcpInstall"
            />
        </section>

        <section class="settings-card">
            <SettingsShortcutsPanel
                :description="shortcutsDescription"
                :items="shortcutItems"
            />
        </section>

        <section v-if="isUpdateSupported" class="settings-card">
            <SettingsUpdatesPanel
                :is-check-in-progress="isCheckInProgress"
                @check="handleCheckForUpdates"
            />
        </section>

        <section class="settings-card settings-card--span settings-about-card">
            <div class="settings-about-copy">
                <h2 class="settings-about-title">{{ t('settings.aboutTitle') }}</h2>
                <p class="settings-about-description">{{ t('settings.aboutDescription') }}</p>
            </div>
            <NuxtLink class="settings-about-link" to="/about">
                <span>{{ t('settings.openAbout') }}</span>
                <UIcon name="i-ph-arrow-right" aria-hidden="true" />
            </NuxtLink>
        </section>
    </div>

    <div
        v-if="settingsSaveStatus === 'retry-pending' || settingsSaveError"
        class="settings-save-error"
        role="alert"
        aria-live="assertive"
    >
        <AppFailureAlert
            v-if="settingsSaveFailurePresentation"
            :presentation="settingsSaveFailurePresentation"
            icon="i-ph-warning"
        />
        <UAlert
            v-else
            color="warning"
            variant="soft"
            icon="i-ph-warning"
            :description="settingsSaveError ? `${t('status.saveFailed')}: ${settingsSaveError}` : t('status.saveFailed')"
        />
        <UButton
            color="neutral"
            variant="outline"
            :label="t('common.retry')"
            :loading="settingsSaveStatus === 'saving'"
            @click="retrySettingsSave"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
    TDefaultZoomPreset,
    TTabMemoryPolicy,
    TPdfViewMode,
} from '@contracts/shared';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import type {
    IAgentAssistantEvent,
    IAgentAssistantState,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import type { ExpectedOutcome } from '@contracts/diagnostics/failureReceipt';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import { useFailureToast } from '@app/composables/useFailureToast';
import { LOCALE_DEFINITIONS } from '@i18n-core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getAgentCapability } from '@app/utils/getAgentCapability';
import { getShellCapability } from '@app/utils/getShellCapability';
import {
    captureAssistantFailure,
    getAssistantExpectedOutcome,
} from '@app/modules/agent-panel/utils/assistantFailure';
import type { TAssistantFailureAction } from '@app/modules/agent-panel/utils/assistantFailure';
import { runSettingsAssistantAction } from '@app/modules/workspace-shell/agent/runSettingsAssistantAction';
import AppFailureAlert from '@app/components/AppFailureAlert.vue';
import SettingsAgentPanel from '@app/components/settings/SettingsAgentPanel.vue';
import SettingsGeneralPanel from '@app/components/settings/SettingsGeneralPanel.vue';
import SettingsPerformancePanel from '@app/components/settings/SettingsPerformancePanel.vue';
import SettingsPrivacyPanel from '@app/components/settings/SettingsPrivacyPanel.vue';
import SettingsShortcutsPanel from '@app/components/settings/SettingsShortcutsPanel.vue';
import SettingsUpdatesPanel from '@app/components/settings/SettingsUpdatesPanel.vue';
import SettingsViewerDefaultsPanel from '@app/components/settings/SettingsViewerDefaultsPanel.vue';
import { isMacClientPlatform } from '@app/utils/clientPlatform';
import { setRendererDiagnosticsPreference } from '@app/utils/failureReporter';

const { isDesktopRuntime } = useRuntimeEnvironment();
const LOCALE_FLAGS = {
    en: 'i-circle-flags-gb',
    ru: 'i-circle-flags-ru',
    fr: 'i-circle-flags-fr',
    de: 'i-circle-flags-de',
    es: 'i-circle-flags-es',
    it: 'i-circle-flags-it',
    pt: 'i-circle-flags-pt',
    'pt-BR': 'i-circle-flags-br',
    nl: 'i-circle-flags-nl',
} as const satisfies Record<TAppLocale, string>;
const LOCALE_OPTION_DEFINITIONS = LOCALE_DEFINITIONS.map(localeDefinition => ({
    value: localeDefinition.code,
    label: localeDefinition.name,
    icon: LOCALE_FLAGS[localeDefinition.code],
})) satisfies ReadonlyArray<{
    value: TAppLocale;
    label: string;
    icon: string;
}>;
const ZOOM_PRESET_OPTION_DEFINITIONS = [
    {
        value: 'fit-width',
        labelKey: 'zoom.fitWidth',
        label: null,
    },
    {
        value: 'fit-height',
        labelKey: 'zoom.fitHeight',
        label: null,
    },
    {
        value: '100',
        labelKey: null,
        label: '100%',
    },
    {
        value: '125',
        labelKey: null,
        label: '125%',
    },
    {
        value: '150',
        labelKey: null,
        label: '150%',
    },
] as const satisfies ReadonlyArray<{
    value: TDefaultZoomPreset;
    labelKey: string | null;
    label: string | null;
}>;
const VIEW_MODE_OPTION_DEFINITIONS = [
    {
        value: 'single',
        labelKey: 'zoom.singlePage',
    },
    {
        value: 'facing',
        labelKey: 'zoom.facingPages',
    },
    {
        value: 'facing-first-single',
        labelKey: 'zoom.facingWithFirstSingle',
    },
] as const satisfies ReadonlyArray<{
    value: TPdfViewMode;
    labelKey: string;
}>;
const TAB_MEMORY_POLICY_OPTION_DEFINITIONS = [
    {
        value: 'conservative',
        labelKey: 'settings.tabMemoryConservative',
    },
    {
        value: 'aggressive',
        labelKey: 'settings.tabMemoryAggressive',
    },
] as const satisfies ReadonlyArray<{
    value: TTabMemoryPolicy;
    labelKey: string;
}>;
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<TAppLocale>(LOCALE_OPTION_DEFINITIONS.map(option => option.value));
const DEFAULT_ZOOM_PRESETS: ReadonlySet<string> = new Set<TDefaultZoomPreset>(ZOOM_PRESET_OPTION_DEFINITIONS.map(option => option.value));
const DEFAULT_VIEW_MODES: ReadonlySet<string> = new Set<TPdfViewMode>(VIEW_MODE_OPTION_DEFINITIONS.map(option => option.value));
const TAB_MEMORY_POLICIES: ReadonlySet<string> = new Set<TTabMemoryPolicy>(TAB_MEMORY_POLICY_OPTION_DEFINITIONS.map(option => option.value));
const PERFORMANCE_MODES: ReadonlySet<string> = new Set<TPerformanceMode>([
    'auto',
    'low',
    'medium',
    'high',
]);

const {
    t,
    setLocale,
} = useTypedI18n();
const colorMode = useColorMode();
const toast = useToast();
const { presentFailureToast } = useFailureToast();
const {
    settings,
    isLoaded,
    load,
    loadOrThrow,
    settingsLoadError,
    settingsLoadFailure,
    save,
    settingsSaveError,
    settingsSaveFailure,
    settingsSaveStatus,
    updateSetting,
} = useSettings();
const {
    discardPendingDiagnostics,
    resendPendingDiagnosticOnce,
} = useRuntimeErrorReports();
const {
    checkForUpdates,
    ensureInitialized: ensureUpdatesInitialized,
    isCheckInProgress,
    isUpdateSupported,
} = useAppUpdates();

const selectedFlagIcon = computed(() => LOCALE_FLAGS[settings.value.locale] ?? LOCALE_FLAGS.en);
const annotationColorSwatches = ANNOTATION_COLOR_SWATCHES;
const agentMcpStatus = ref<IAgentMcpIntegrationStatus | null>(null);
const isAgentMcpBusy = ref(false);
const assistantState = ref<IAgentAssistantState | null>(null);
const assistantDeviceCode = ref('');
const assistantAction = ref<'refresh' | 'install' | 'login' | 'cancel' | null>(null);
const isAssistantBusy = computed(() => assistantAction.value !== null);
const settingsLoadFailed = ref(false);
const settingsLoadPending = ref(false);
let assistantPanelPreferenceSave: Promise<boolean> | null = null;
let diagnosticsPreferenceSave: Promise<boolean> | null = null;

const settingsLoadFailurePresentation = computed<FailurePresentation | null>(() => {
    const capture = settingsLoadFailure.value;
    if (!settingsLoadFailed.value || !capture) {
        return null;
    }
    return {
        ...capture,
        title: t('errors.settings.load'),
        description: settingsLoadError.value ?? t('errors.runtime.description'),
    };
});

const settingsSaveFailurePresentation = computed<FailurePresentation | null>(() => {
    const capture = settingsSaveFailure.value;
    if (!capture) {
        return null;
    }
    return {
        ...capture,
        title: t('status.saveFailed'),
        description: settingsSaveError.value ?? t('status.saveFailed'),
    };
});

watch(isLoaded, (loaded) => {
    if (loaded) {
        settingsLoadFailed.value = false;
    }
});
let unsubscribeAssistantEvent: (() => void) | null = null;
let disposed = false;
const shortcutsDescription = computed(() => isDesktopRuntime.value
    ? t('settings.shortcutsDescription')
    : t('settings.browserShortcutsDescription'));

const localeItems = computed(() => LOCALE_OPTION_DEFINITIONS.map(option => ({
    label: option.label,
    value: option.value,
    icon: option.icon,
})));

const zoomPresetItems = computed(() => ZOOM_PRESET_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: option.labelKey ? t(option.labelKey) : option.label ?? '',
})));

const viewModeItems = computed(() => VIEW_MODE_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
})));

const scrollModeItems = computed(() => [
    {
        value: true,
        label: t('settings.scrollContinuous'),
    },
    {
        value: false,
        label: t('settings.scrollPageByPage'),
    },
]);

const tabMemoryPolicyItems = computed(() => TAB_MEMORY_POLICY_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
})));

const isMac = isMacClientPlatform();
const mod = isMac ? '\u2318' : 'Ctrl';
const shift = isMac ? '\u21E7' : 'Shift';

const shortcutItems = computed(() => {
    const browserItems = [
        {
            label: t('toolbar.save'),
            keys: [
                mod,
                'S',
            ],
        },
        {
            label: t('documentSourceSidebar.searchPlaceholder'),
            keys: [
                mod,
                'F',
            ],
        },
        {
            label: t('zoom.zoomIn'),
            keys: [
                mod,
                '=',
            ],
        },
        {
            label: t('zoom.zoomOut'),
            keys: [
                mod,
                '\u2212',
            ],
        },
        {
            label: t('settings.actualSize'),
            keys: [
                mod,
                '0',
            ],
        },
    ];

    if (!isDesktopRuntime.value) {
        return browserItems;
    }

    return [
        {
            label: t('toolbar.openPdf'),
            keys: [
                mod,
                'O',
            ],
        },
        ...browserItems,
        {
            label: t('toolbar.saveAs'),
            keys: [
                mod,
                shift,
                'S',
            ],
        },
        {
            label: t('zoom.fitWidth'),
            keys: [
                mod,
                '1',
            ],
        },
        {
            label: t('zoom.fitHeight'),
            keys: [
                mod,
                '2',
            ],
        },
    ];
});

async function retrySettingsLoad() {
    if (settingsLoadPending.value) {
        return;
    }
    settingsLoadPending.value = true;
    settingsLoadFailed.value = false;
    try {
        await loadOrThrow();
        settingsLoadFailed.value = !isLoaded.value;
    } catch {
        settingsLoadFailed.value = true;
    } finally {
        settingsLoadPending.value = false;
    }
}

async function retrySettingsSave() {
    await save();
}

function updateSettingSafely<K extends keyof ISettingsData>(key: K, value: ISettingsData[K]) {
    if (!isLoaded.value) {
        return;
    }
    updateSetting(key, value);
}

function restoreDiagnosticsPreference(preference: ISettingsData['clientDiagnosticsPreference']) {
    settings.value = {
        ...settings.value,
        clientDiagnosticsPreference: preference,
    };
    setRendererDiagnosticsPreference(preference);
}

async function applyClientDiagnosticsPreference(
    preference: ISettingsData['clientDiagnosticsPreference'],
) {
    if (!isLoaded.value || diagnosticsPreferenceSave) {
        return;
    }

    const previousPreference = settings.value.clientDiagnosticsPreference;
    if (preference !== 'granted') {
        // updateSetting changes the live gate synchronously. Dispose the old
        // presentation before the persistence request is started.
        updateSetting('clientDiagnosticsPreference', preference);
        discardPendingDiagnostics();
        diagnosticsPreferenceSave = save().finally(() => {
            diagnosticsPreferenceSave = null;
        });
        await diagnosticsPreferenceSave;
        return;
    }

    updateSetting('clientDiagnosticsPreference', preference);
    diagnosticsPreferenceSave = save().finally(() => {
        diagnosticsPreferenceSave = null;
    });
    const saved = await diagnosticsPreferenceSave;
    if (disposed) {
        return;
    }
    if (!saved) {
        restoreDiagnosticsPreference(previousPreference);
        return;
    }
    if (settings.value.clientDiagnosticsPreference === 'granted') {
        resendPendingDiagnosticOnce();
    }
}

function applyTheme(theme: TAppTheme) {
    if (!isLoaded.value) {
        return;
    }
    colorMode.preference = theme;
    updateSetting('theme', theme);
}

function readSelectValue(payload: string | { value: string }) {
    return typeof payload === 'string' ? payload : payload.value;
}

function isDefaultZoomPreset(value: string): value is TDefaultZoomPreset {
    return DEFAULT_ZOOM_PRESETS.has(value);
}

function isPdfViewMode(value: string): value is TPdfViewMode {
    return DEFAULT_VIEW_MODES.has(value);
}

function isAppLocale(value: string): value is TAppLocale {
    return SUPPORTED_LOCALES.has(value);
}

function isTabMemoryPolicy(value: string): value is TTabMemoryPolicy {
    return TAB_MEMORY_POLICIES.has(value);
}

function isPerformanceMode(value: string): value is TPerformanceMode {
    return PERFORMANCE_MODES.has(value);
}

function applyZoomPreset(preset: string | { value: string }) {
    if (!isLoaded.value) {
        return;
    }
    const value = readSelectValue(preset);
    if (isDefaultZoomPreset(value)) {
        updateSetting('defaultZoomPreset', value);
    }
}

function applyViewMode(mode: string | { value: string }) {
    if (!isLoaded.value) {
        return;
    }
    const value = readSelectValue(mode);
    if (isPdfViewMode(value)) {
        updateSetting('defaultViewMode', value);
    }
}

function applyScrollMode(mode: boolean | { value: boolean }) {
    if (!isLoaded.value) {
        return;
    }
    const value = typeof mode === 'boolean' ? mode : mode.value;
    updateSetting('defaultContinuousScroll', value);
}

function applyTabMemoryPolicy(policy: string | { value: string }) {
    if (!isLoaded.value) {
        return;
    }
    const value = readSelectValue(policy);
    if (isTabMemoryPolicy(value)) {
        updateSetting('tabMemoryPolicy', value);
    }
}

function applyPerformanceMode(mode: string | { value: string }) {
    if (!isLoaded.value) {
        return;
    }
    const value = readSelectValue(mode);
    if (isPerformanceMode(value)) {
        updateSetting('performanceMode', value);
    }
}

async function applyLocale(locale: string | { value: string }) {
    if (!isLoaded.value) {
        return;
    }
    const code = readSelectValue(locale);
    if (isAppLocale(code)) {
        await setLocale(code);
        updateSetting('locale', code);
    }
}

function handleCheckForUpdates() {
    void checkForUpdates();
}

function applyAssistantState(nextState: IAgentAssistantState) {
    if (disposed) {
        return;
    }
    assistantState.value = nextState;
    if (nextState.status.authState !== 'login-pending') {
        assistantDeviceCode.value = '';
    }
}

function handleAssistantEvent(event: IAgentAssistantEvent) {
    if (disposed || !settings.value.assistantPanelEnabled) {
        return;
    }
    if (event.state) {
        applyAssistantState(event.state);
    }
}

async function runAssistantAction(
    action: 'refresh' | 'install' | 'login' | 'cancel',
    callback: () => Promise<void>,
) {
    await runSettingsAssistantAction({
        action,
        activeAction: assistantAction,
        isDesktopRuntime: isDesktopRuntime.value,
        isActive: () => !disposed,
        run: callback,
        t,
        toast,
    });
}

async function refreshAssistantState() {
    await runAssistantAction('refresh', async () => {
        const state = await getAgentCapability().getAssistantState();
        applyAssistantState(state);
    });
}

async function installAssistantCodex() {
    await runAssistantAction('install', async () => {
        const result = await getAgentCapability().installAssistantCodex();
        applyAssistantState(result.state);
    });
}

async function startAssistantLogin() {
    await runAssistantAction('login', async () => {
        const result = await getAgentCapability().startAssistantLogin({ mode: 'chatgpt' });
        applyAssistantState(result.state);
        assistantDeviceCode.value = result.userCode ?? '';
    });
}

async function cancelAssistantLogin() {
    await runAssistantAction('cancel', async () => {
        applyAssistantState(await getAgentCapability().cancelAssistantLogin());
        assistantDeviceCode.value = '';
    });
}

async function updateAssistantPanelEnabled(enabled: boolean) {
    if (!isLoaded.value) {
        return;
    }
    updateSetting('assistantPanelEnabled', enabled);
    assistantPanelPreferenceSave = save().finally(() => {
        assistantPanelPreferenceSave = null;
    });
    const saved = await assistantPanelPreferenceSave;

    if (disposed) {
        return;
    }

    if (!enabled) {
        assistantState.value = null;
        assistantDeviceCode.value = '';
    }

    if (!saved) {
        return;
    }

    if (enabled) {
        await refreshAssistantState();
    }
}

function showExpectedAssistantOutcome(
    action: TAssistantFailureAction,
    expected: ExpectedOutcome,
    description: string,
) {
    BrowserLogger.warn('settings', 'Assistant settings operation was not completed', {
        action,
        expected,
    });
    toast.add({
        color: 'warning',
        title: t('settings.agentMcpStatusError'),
        description,
    });
}

function presentAssistantFailure(
    error: unknown,
    action: TAssistantFailureAction,
    logMessage: string,
) {
    const expected = getAssistantExpectedOutcome(error);
    if (expected) {
        showExpectedAssistantOutcome(
            action,
            expected,
            getErrorMessage(error) || t('settings.agentMcpUnavailable'),
        );
        return;
    }

    presentFailureToast(captureAssistantFailure(error, {
        action,
        section: 'settings',
        logMessage,
        title: t('settings.agentMcpStatusError'),
    }));
}

async function refreshAgentMcpStatus() {
    if (!isDesktopRuntime.value || isAgentMcpBusy.value) {
        return;
    }

    isAgentMcpBusy.value = true;
    try {
        const status = await getAgentCapability().getMcpIntegrationStatus();
        if (disposed) {
            return;
        }
        agentMcpStatus.value = status;
    } catch (error) {
        if (disposed) {
            return;
        }
        presentAssistantFailure(
            error,
            'mcp-refresh',
            'Failed to refresh agent MCP integration status',
        );
    } finally {
        if (!disposed) {
            isAgentMcpBusy.value = false;
        }
    }
}

async function setAgentMcpEnabled(enabled: boolean) {
    if (!isDesktopRuntime.value || isAgentMcpBusy.value) {
        return;
    }

    isAgentMcpBusy.value = true;
    try {
        const result = await getAgentCapability().setMcpIntegrationEnabled(enabled);
        if (disposed) {
            return;
        }
        agentMcpStatus.value = result.status;
        await load();
        if (disposed) {
            return;
        }
        if (!result.ok) {
            showExpectedAssistantOutcome(
                'mcp-update',
                {
                    kind: 'expected',
                    code: result.cancelled ? 'canceled' : 'temporarily-unavailable',
                },
                result.error ?? t('settings.agentMcpUnavailable'),
            );
        }
    } catch (error) {
        if (disposed) {
            return;
        }
        presentAssistantFailure(
            error,
            'mcp-update',
            'Failed to update agent MCP integration status',
        );
        try {
            const status = await getAgentCapability().getMcpIntegrationStatus();
            if (!disposed) {
                agentMcpStatus.value = status;
            }
        } catch (statusError) {
            BrowserLogger.warn('settings', 'Failed to refresh agent MCP status after update failure', { statusError });
        }
    } finally {
        if (!disposed) {
            isAgentMcpBusy.value = false;
        }
    }
}

function openAgentMcpInstall() {
    const installUrl = agentMcpStatus.value?.installUrl ?? 'https://developers.openai.com/codex/app';
    void getShellCapability().openExternal(installUrl).catch((error: unknown) => {
        if (disposed) {
            return;
        }
        presentAssistantFailure(error, 'mcp-install', 'Failed to open agent MCP install URL');
    });
}

onMounted(() => {
    if (!isLoaded.value) {
        void retrySettingsLoad();
    }
    void ensureUpdatesInitialized();
    void refreshAgentMcpStatus();
    if (isDesktopRuntime.value) {
        unsubscribeAssistantEvent = getAgentCapability().onAssistantEvent(handleAssistantEvent);
        if (settings.value.assistantPanelEnabled) {
            void refreshAssistantState();
        }
    }
});

watch(() => settings.value.assistantPanelEnabled, (enabled) => {
    if (!isDesktopRuntime.value || assistantPanelPreferenceSave) {
        return;
    }
    if (enabled) {
        if (assistantState.value === null) {
            void refreshAssistantState();
        }
        return;
    }
    assistantState.value = null;
    assistantDeviceCode.value = '';
});

onBeforeUnmount(() => {
    disposed = true;
    unsubscribeAssistantEvent?.();
    unsubscribeAssistantEvent = null;
});
</script>

<style scoped>
.settings-state,
.settings-save-error {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-3xl);
    margin-block-end: var(--app-space-12xl);
}

.settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-12xl);
    align-items: start;
}

.settings-card {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-10xl);
    min-width: 0;
    padding: var(--app-space-15xl);
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-radius-surface);
    background: var(--app-start-card-bg);
}

.settings-card :deep(.settings-section) {
    min-inline-size: 0;
}

.settings-card--span {
    grid-column: 1 / -1;
}

.settings-about-card {
    gap: var(--app-space-3xl);
}

.settings-about-copy {
    display: grid;
    gap: var(--app-space-sm);
}

.settings-about-title,
.settings-about-description {
    margin: 0;
}

.settings-about-title {
    font-size: var(--app-text-size-title-sm);
}

.settings-about-description {
    color: var(--ui-text-muted);
    line-height: 1.6;
}

.settings-about-link {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: var(--app-space-sm);
    min-height: var(--app-control-height-md);
    padding: var(--app-space-sm) var(--app-space-lg);
    border: 1px solid var(--ui-primary);
    border-radius: var(--app-radius-xs);
    color: var(--ui-primary);
    font-weight: 650;
    text-decoration: none;
}

.settings-about-link:hover {
    background: color-mix(in oklab, var(--ui-bg) 90%, var(--ui-primary) 10%);
}

.settings-about-link:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 3px;
}

@container (max-width: 720px) {
    .settings-grid {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
