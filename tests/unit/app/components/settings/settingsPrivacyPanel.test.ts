// @vitest-environment happy-dom

import type * as TViMockOriginalPlatformModule from '@app/utils/platform';
import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    type Ref,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import AppRoot from '@app/app.vue';
import {
    LOCALE_MESSAGES, type TLocale,
} from '@i18n-app';
import {
    formatTranslationLeaf, getNestedTranslationLeaf,
} from '@i18n-core';
import {
    createSettingsPersistenceQueue, type TSettingsPersistenceStatus,
} from '@app/modules/settings/settingsPersistenceQueue';
import type {IFailureToastTarget} from '@app/composables/useFailureToast';
import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import type {ISettingsData} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import type {IAgentMcpIntegrationStatus} from '@contracts/agent';
import {createBrowserAgentMcpStatus} from '@app/platform/browser-api/browserAgentCapability';
import SettingsContent from '@app/components/settings/SettingsContent.vue';
import SettingsPrivacyPanel from '@app/components/settings/SettingsPrivacyPanel.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({
        t: translate,
        locale: selectedLocale,
        loadLocaleMessages: async () => {},
        setLocale: async (locale: TLocale) => {selectedLocale.value = locale;},
    }),
}));
const selectedLocale = ref<TLocale>('en');
let realMessages = false;
function translate(key: string, params?: Record<string, string | number>) {
    return realMessages ? formatTranslationLeaf(getNestedTranslationLeaf(LOCALE_MESSAGES[selectedLocale.value], key) ?? key, params, selectedLocale.value) : key;
}

const FormFieldStub = defineComponent({
    props: {help: {
        type: String,
        default: '',
    }},
    setup: (props, {slots}) => () => h('div', [
        h('span', props.help),
        slots.default?.(),
    ]),
});
const SwitchStub = defineComponent({
    props: {modelValue: Boolean},
    emits: ['update:modelValue'],
    setup: (props, {emit}) => () => h('button', {
        'aria-pressed': String(props.modelValue),
        onClick: () => emit('update:modelValue', !props.modelValue),
    }),
});
const LinkStub = defineComponent({
    props: {to: {
        type: String,
        required: true,
    }},
    setup: (props, {slots}) => () => h('a', {href: props.to}, slots.default?.()),
});
const activeUnmounts = new Set<() => void>();

function mount(preference = DEFAULT_SETTINGS.clientDiagnosticsPreference) {
    const emitted: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(SettingsPrivacyPanel, {
        settings: {
            ...DEFAULT_SETTINGS,
            clientDiagnosticsPreference: preference,
        },
        'onUpdate:clientDiagnosticsPreference': (value: string) => emitted.push(value),
    })}));
    app.component('UFormField', FormFieldStub);
    app.component('USwitch', SwitchStub);
    app.component('NuxtLink', LinkStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        emitted,
        host,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    vi.unstubAllGlobals();
});

describe('SettingsPrivacyPanel', () => {
    it('is off by default and links to the complete privacy notice', () => {
        const { host } = mount();

        expect(host.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
        expect(host.textContent).toContain('settings.clientDiagnostics');
        expect(host.textContent).toContain('settings.clientDiagnosticsDescription');
        expect(host.querySelector('a')?.getAttribute('href')).toBe('/privacy');
    });

    it('maps the positive control to granted and its off state to denied', () => {
        const disabled = mount();
        disabled.host.querySelector('button')?.click();
        expect(disabled.emitted).toEqual(['granted']);

        const enabled = mount('granted');
        enabled.host.querySelector('button')?.click();
        expect(enabled.emitted).toEqual(['denied']);
    });
});

const synchronizedSettings = ref({
    ...DEFAULT_SETTINGS,
    agentMcpEnabled: true,
});
const settingsSaveError = ref<string | null>(null);
const settingsSaveFailure = ref<IPresentedFailureCapture | null>(null);
const settingsSaveStatus = ref<TSettingsPersistenceStatus>('idle');
let saveSettings: () => Promise<boolean> = async () => true;
const mcpStatusRead = vi.fn<() => Promise<IAgentMcpIntegrationStatus>>();
const runtimeStatusListeners = new Set<(status: IAgentMcpIntegrationStatus) => void>();
vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({
    settings: synchronizedSettings,
    isLoaded: ref(true),
    load: async () => undefined,
    loadOrThrow: async () => undefined,
    save: () => saveSettings(),
    settingsLoadError: ref(null),
    settingsLoadFailure: ref(null),
    settingsSaveError,
    settingsSaveFailure,
    settingsSaveStatus,
    updateSetting: vi.fn(),
})}));
vi.mock('@app/composables/useRuntimeEnvironment', () => ({useRuntimeEnvironment: () => ({isDesktopRuntime: ref(true)})}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({
    reports: ref([]),
    clearRuntimeErrorReports: vi.fn(),
    discardPendingDiagnostics: vi.fn(),
    resendPendingDiagnosticOnce: vi.fn(),
})}));
vi.mock('@app/composables/useAppUpdates', () => ({useAppUpdates: () => ({
    checkForUpdates: vi.fn(),
    ensureInitialized: async () => undefined,
    isCheckInProgress: ref(false),
    isUpdateSupported: ref(false),
})}));
vi.mock('@app/composables/useUiScale', () => ({useUiScale: () => ({
    effectiveScale: ref(1),
    hostSnapshot: ref({platform: 'linux'}),
    applyUiScaleToDocument: vi.fn(),
    attachHostEnvironmentListener: () => () => {},
    refreshHostSnapshot: vi.fn(),
    setPreferenceFromSettings: vi.fn(),
})}));
vi.mock('@app/composables/useFatalRuntimeError', () => ({useFatalRuntimeError: () => ({
    fatalRuntimeError: ref(null),
    setFatalRuntimeError: vi.fn(),
    reloadAfterFatalRuntimeError: vi.fn(),
})}));
vi.mock('@app/utils/platform', async (original) => ({
    ...await original<typeof TViMockOriginalPlatformModule>(),
    waitForPreferredDesktopPlatformBridge: async () => ({
        shouldWait: false,
        bridgeReady: true,
    }),
}));
vi.mock('@app/utils/getAgentCapability', () => ({getAgentCapability: () => ({
    getMcpIntegrationStatus: mcpStatusRead,
    onAssistantEvent: () => () => undefined,
    onMcpIntegrationChanged: (listener: (status: IAgentMcpIntegrationStatus) => void) => {
        runtimeStatusListeners.add(listener);
        return () => runtimeStatusListeners.delete(listener);
    },
})}));
vi.mock('@app/components/settings/SettingsGeneralPanel.vue', () => ({default: {render: () => h('div')}}));
vi.mock('@app/components/settings/SettingsPerformancePanel.vue', () => ({default: {render: () => h('div')}}));
vi.mock('@app/components/settings/SettingsShortcutsPanel.vue', () => ({default: {render: () => h('div')}}));
vi.mock('@app/components/settings/SettingsUpdatesPanel.vue', () => ({default: {render: () => h('div')}}));
vi.mock('@app/components/settings/SettingsViewerDefaultsPanel.vue', () => ({default: {render: () => h('div')}}));
vi.mock('@app/components/settings/SettingsAgentPanel.vue', () => ({default: defineComponent({
    props: {status: {
        type: Object,
        default: null,
    }},
    setup: props => () => h('div', [
        h('span', {'data-mcp-enabled': ''}, String(props.status?.enabled)),
        h('span', {'data-mcp-running': ''}, String(props.status?.serverRunning)),
    ]),
})}));

describe('SettingsContent synchronized MCP status', () => {
    beforeEach(() => {
        synchronizedSettings.value = {
            ...DEFAULT_SETTINGS,
            agentMcpEnabled: true,
        };
        mcpStatusRead.mockReset();
        runtimeStatusListeners.clear();
        vi.stubGlobal('useColorMode', () => ({preference: 'light'}));
        vi.stubGlobal('useToast', () => ({add: vi.fn()}));
    });


    it('retains runtime completion details when an older status read arrives after the owner event', async () => {
        let resolve!: (status: IAgentMcpIntegrationStatus) => void;
        mcpStatusRead.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(SettingsContent);
        for (const name of [
            'UIcon',
            'UButton',
            'NuxtLink',
        ]) app.component(name, {render: () => h('span')});
        app.component('UFormField', FormFieldStub);
        app.component('USwitch', SwitchStub);
        app.mount(host);
        const unmount = () => { app.unmount(); host.remove(); activeUnmounts.delete(unmount); };
        activeUnmounts.add(unmount);
        await nextTick();
        for (const listener of runtimeStatusListeners) listener({
            ...createBrowserAgentMcpStatus(),
            enabled: true,
            serverRunning: true,
            codexInstalled: true,
            codexConfigured: true,
        });
        await nextTick();
        expect(host.querySelector('[data-mcp-running]')?.textContent).toBe('true');
        resolve({
            ...createBrowserAgentMcpStatus(),
            enabled: false,
            serverRunning: false,
            codexInstalled: true,
            codexConfigured: false,
        });
        await vi.waitFor(() => expect(mcpStatusRead.mock.settledResults[0]?.type).toBe('fulfilled'));
        await nextTick();
        expect(host.querySelector('[data-mcp-enabled]')?.textContent).toBe('true');
        expect(host.querySelector('[data-mcp-running]')?.textContent).toBe('true');
    });

    it('shows a broadcast setting while an earlier MCP status read is pending', async () => {
        let resolve!: (status: IAgentMcpIntegrationStatus) => void;
        mcpStatusRead.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(SettingsContent);
        for (const name of [
            'UIcon',
            'UButton',
            'NuxtLink',
        ]) {
            app.component(name, {render: () => h('span')});
        }
        app.component('UFormField', FormFieldStub);
        app.component('USwitch', SwitchStub);
        app.mount(host);
        const unmount = () => {
            app.unmount();
            host.remove();
            activeUnmounts.delete(unmount);
        };
        activeUnmounts.add(unmount);
        await nextTick();

        synchronizedSettings.value.agentMcpEnabled = false;
        await nextTick();
        const readStatus = {
            ...createBrowserAgentMcpStatus(),
            enabled: true,
        };
        for (const listener of runtimeStatusListeners) listener(readStatus);
        resolve(readStatus);
        await vi.waitFor(() => expect(host.querySelector('[data-mcp-enabled]')?.textContent).toBe('false'));
        for (const listener of runtimeStatusListeners) {
            listener({
                ...createBrowserAgentMcpStatus(),
                enabled: true,
                serverRunning: true,
            });
        }
        await nextTick();
        expect(host.querySelector('[data-mcp-enabled]')?.textContent).toBe('false');
        expect(host.querySelector('[data-mcp-running]')?.textContent).toBe('true');
    });
});

// Actual root and Settings share the queue and receipt. Only the toast target and
// unrelated bootstrap surfaces are replaced; the production presenter renders it.
type TToast = Parameters<IFailureToastTarget['add']>[0];
function mountSettingsRoot(retained = false) {
    realMessages = true;
    const entries = ref<TToast[]>([]);
    const toasts = entries as Ref<TToast[]>;
    const toast = {
        toasts,
        add: (entry: TToast) => {
            const index = entries.value.findIndex(item => item.id === entry.id);
            if (index < 0) entries.value.push(entry);
            else entries.value[index] = entry;
        },
        update: (id: string | number, update: Partial<TToast>) => {
            const entry = entries.value.find(item => item.id === id);
            if (entry) Object.assign(entry, update);
        },
        remove: (id: string) => { entries.value = entries.value.filter(item => item.id !== id); },
    };
    vi.stubGlobal('useToast', () => toast);
    vi.stubGlobal('useRoute', () => ({
        path: '/',
        fullPath: '/',
    }));
    vi.stubGlobal('useColorMode', () => ({
        preference: 'light',
        value: 'light',
    }));
    vi.stubGlobal('useLocaleHead', () => ref({
        htmlAttrs: {},
        meta: [],
        link: [],
    }));
    vi.stubGlobal('useHead', vi.fn());
    synchronizedSettings.value = {
        ...DEFAULT_SETTINGS,
        locale: selectedLocale.value,
        agentMcpEnabled: false,
    };
    if (!retained) {
        settingsSaveError.value = null;
        settingsSaveFailure.value = null;
        settingsSaveStatus.value = 'idle';
    }
    const visible = ref(true);
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(AppRoot);
    const passthrough = defineComponent({setup: (_props, {slots}) => () => slots.default?.()});
    app.component('UApp', defineComponent({setup: (_props, {slots}) => () => h('main', [
        slots.default?.(),
        ...entries.value.map(entry => h('article', {
            class: entry.ui?.root,
            'data-id': entry.id,
        }, [
            h('h2', entry.title),
            typeof entry.description === 'function' ? entry.description() : entry.description,
            ...(entry.actions ?? []).map(action => h('button', {onClick: action.onClick}, action.label)),
        ])),
    ])}));
    app.component('NuxtPage', defineComponent({setup: () => () => visible.value ? h(SettingsContent) : h('div', 'Workspace')}));
    for (const name of [
        'DevOnly',
        'ClientOnly',
    ]) app.component(name, passthrough);
    for (const name of [
        'UIcon',
        'UButton',
        'NuxtLink',
        'UAlert',
    ]) app.component(name, {render: () => h('span')});
    app.component('UFormField', FormFieldStub);
    app.component('USwitch', SwitchStub);
    app.mount(host);
    const unmount = () => {app.unmount(); host.remove(); activeUnmounts.delete(unmount);};
    activeUnmounts.add(unmount);
    return {
        host,
        visible,
        entries,
    };
}

function installSettingsQueue() {
    let rejectWrite!: (error: unknown) => void;
    let stored: ISettingsData = {...DEFAULT_SETTINGS};
    let nextFailure: Error | DOMException | null = null;
    let first = true;
    const queue = createSettingsPersistenceQueue({
        getSettingsSnapshot: () => synchronizedSettings.value,
        getLastSavedSettings: () => stored,
        savePatch: async patch => {
            if (first) {
                first = false;
                await new Promise<void>((_resolve, reject) => {rejectWrite = reject;});
            }
            if (nextFailure) throw nextFailure;
            stored = {
                ...stored,
                ...patch,
            };
        },
        onSaved: () => {settingsSaveFailure.value = null;},
        onSaveError: () => {
            settingsSaveFailure.value ??= {failure: {
                eventId: '0123456789abcdef0123456789abcdef',
                code: 'SETTINGS_SAVE_FAILED',
                occurredAt: requireEpochMs(1_790_000_000_000),
                severity: 'error',
            }};
        },
        onStatusChanged: (status, error) => {
            settingsSaveStatus.value = status;
            settingsSaveError.value = error instanceof Error || error instanceof DOMException ? error.message : null;
        },
    });
    saveSettings = queue.save;
    return {
        reject: (error: unknown) => rejectWrite(error),
        failRetry: (error: Error | null) => {nextFailure = error;},
        stored: () => stored,
    };
}

async function flushUi() { for (let index = 0; index < 8; index++) await nextTick(); }
function clickToastButton(host: HTMLElement, label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.app-toast-failure button')].find(entry => entry.textContent === label);
    expect(button).toBeDefined();
    button!.click();
}

describe('Settings save presentation lifetime', () => {
    afterEach(() => { realMessages = false; selectedLocale.value = 'en'; saveSettings = async () => true; });

    it('shows a late failure after Settings closes, keeps one receipt on remount and retries the latest choice', async () => {
        const queue = installSettingsQueue();
        const mounted = mountSettingsRoot();
        synchronizedSettings.value.authorName = 'First choice';
        const saving = saveSettings();
        mounted.visible.value = false;
        await nextTick();
        queue.reject(new Error('ENOSPC: no space left on device'));
        await expect(saving).resolves.toBe(false);
        await flushUi();
        expect(mounted.host.querySelectorAll('.app-toast-failure')).toHaveLength(1);
        expect(mounted.host.textContent).toContain('Last save failed');
        expect(mounted.host.textContent).toContain('01234567');
        mounted.visible.value = true;
        await flushUi();
        expect(mounted.host.querySelectorAll('.app-toast-failure')).toHaveLength(1);
        queue.failRetry(new Error('still full'));
        clickToastButton(mounted.host, 'Retry');
        await flushUi();
        expect(settingsSaveStatus.value).toBe('failed');
        expect(mounted.host.querySelectorAll('.app-toast-failure')).toHaveLength(1);
        expect(mounted.entries.value[0]?.id).toBe('0123456789abcdef0123456789abcdef');
        synchronizedSettings.value.authorName = 'Latest choice';
        queue.failRetry(null);
        clickToastButton(mounted.host, 'Retry');
        await flushUi();
        expect(queue.stored().authorName).toBe('Latest choice');
        expect(settingsSaveFailure.value).toBeNull();
    });

    it('presents a retained failure immediately when the root initializes', async () => {
        const queue = installSettingsQueue();
        synchronizedSettings.value.authorName = 'Unsaved';
        const saving = saveSettings();
        queue.reject(new Error('ENOSPC'));
        await saving;
        const mounted = mountSettingsRoot(true);
        await flushUi();
        expect(mounted.host.querySelectorAll('.app-toast-failure')).toHaveLength(1);
        expect(mounted.host.textContent).toContain('01234567');
    });

});
