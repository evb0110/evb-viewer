// @vitest-environment happy-dom

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
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import type {IAgentMcpIntegrationStatus} from '@contracts/agent';
import {createBrowserAgentMcpStatus} from '@app/platform/browser-api/browserAgentCapability';
import SettingsContent from '@app/components/settings/SettingsContent.vue';
import SettingsPrivacyPanel from '@app/components/settings/SettingsPrivacyPanel.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
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
const mcpStatusRead = vi.fn<() => Promise<IAgentMcpIntegrationStatus>>();
const runtimeStatusListeners = new Set<(status: IAgentMcpIntegrationStatus) => void>();
vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({
    settings: synchronizedSettings,
    isLoaded: ref(true),
    load: async () => undefined,
    loadOrThrow: async () => undefined,
    save: async () => true,
    settingsLoadError: ref(null),
    settingsLoadFailure: ref(null),
    settingsSaveError: ref(null),
    settingsSaveFailure: ref(null),
    settingsSaveStatus: ref('idle'),
    updateSetting: vi.fn(),
})}));
vi.mock('@app/composables/useRuntimeEnvironment', () => ({useRuntimeEnvironment: () => ({isDesktopRuntime: ref(true)})}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({
    discardPendingDiagnostics: vi.fn(),
    resendPendingDiagnosticOnce: vi.fn(),
})}));
vi.mock('@app/composables/useAppUpdates', () => ({useAppUpdates: () => ({
    checkForUpdates: vi.fn(),
    ensureInitialized: async () => undefined,
    isCheckInProgress: ref(false),
    isUpdateSupported: ref(false),
})}));
vi.mock('@app/composables/useFailureToast', () => ({useFailureToast: () => ({presentFailureToast: vi.fn()})}));
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
