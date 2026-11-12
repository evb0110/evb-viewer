// @vitest-environment happy-dom
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    createApp, defineComponent, h, nextTick,
} from 'vue';
import type {
    IAssistantEvent, IAssistantInstanceConfig,
} from '@contracts/assistant';
import {
    createAssistantInstance, createAssistantState,
} from '@tests/helpers/createAgentAssistantStatus';
import SettingsAgentPanel from '@app/components/settings/SettingsAgentPanel.vue';

const api = vi.hoisted(() => ({
    getAssistantInstances: vi.fn(),
    getAssistantState: vi.fn(),
    saveAssistantInstances: vi.fn(),
    importAssistantInstancesFromT3: vi.fn(),
    onAssistantEvent: vi.fn(),
    startAssistantLogin: vi.fn(),
}));
vi.mock('@app/utils/getAgentCapability', () => ({ getAgentCapability: () => api }));
vi.mock('@app/composables/useTypedI18n', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));
vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
const configs: IAssistantInstanceConfig[] = [{
    id: 'codex',
    driver: 'codex',
    displayName: 'Work account',
    enabled: true,
    binaryPath: '/bin/custom-codex',
    homePath: '/home/work',
    shadowHomePath: '/home/shadow',
    launchArgs: '',
    launchArgsSecret: true,
    launchArgsConfigured: true,
    environment: [{
        name: 'API_KEY',
        value: '',
        secret: true,
        configured: true,
    }],
}];
let event: (value: IAssistantEvent) => void;
const unmounts: Array<() => void> = [];
const Button = defineComponent({
    inheritAttrs: false,
    props: {
        label: String,
        disabled: Boolean,
    },
    setup: (props, {
        attrs, slots,
    }) => () => h('button', {
        ...attrs,
        type: 'button',
        disabled: props.disabled,
    }, [
        props.label,
        slots.default?.(),
    ]),
});
const Input = defineComponent({
    inheritAttrs: false,
    props: { modelValue: String },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs, emit,
    }) => () => h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
    }),
});
const Switch = defineComponent({
    inheritAttrs: false,
    props: {
        modelValue: Boolean,
        label: String,
    },
    emits: ['update:modelValue'],
    setup: (props, { emit }) => () => h('button', {
        type: 'button',
        'aria-label': props.label,
        'aria-pressed': String(props.modelValue),
        onClick: () => emit('update:modelValue', !props.modelValue),
    }, props.label),
});
const Select = defineComponent({
    props: {
        modelValue: String,
        items: Array,
    },
    emits: ['update:modelValue'],
    setup: (props, {
        emit, attrs,
    }) => () => h('select', {
        ...attrs,
        value: props.modelValue,
        onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value),
    }, [
        h('option', { value: 'codex' }, 'Codex'),
        h('option', { value: 'claude' }, 'Claude'),
    ]),
});
const Field = defineComponent({
    props: {
        label: String,
        hint: String,
    },
    setup: (props, { slots }) => () => h('label', [
        h('span', props.label),
        slots.default?.(),
        h('span', props.hint),
    ]),
});
function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(SettingsAgentPanel, {
        assistantPanelEnabled: true,
        status: null,
        isBusy: false,
    });
    app.component('UButton', Button); app.component('UInput', Input); app.component('USelect', Select);
    app.component('USwitch', Switch); app.component('UCheckbox', Switch); app.component('UFormField', Field);
    app.component('UIcon', defineComponent({ setup: () => () => h('span') }));
    app.component('UModal', defineComponent({ setup: () => () => null }));
    app.mount(host);
    unmounts.push(() => { app.unmount(); host.remove(); });
    return host;
}
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
function click(host: HTMLElement, label: string) {
    const target = [...host.querySelectorAll('button')].find(button => button.textContent === label);
    if (!target) throw new Error('Missing button ' + label);
    target.click();
}
beforeEach(() => {
    vi.clearAllMocks();
    api.getAssistantInstances.mockResolvedValue({
        ok: true,
        instances: configs,
        notices: [],
    });
    api.getAssistantState.mockResolvedValue(createAssistantState({ instances: [createAssistantInstance({
        label: 'Work account',
        state: 'warning',
        message: 'Actual probe warning',
        canSignIn: true,
    })] }));
    api.saveAssistantInstances.mockImplementation(async instances => ({
        ok: true,
        instances,
        notices: ['Saved provider configuration'],
    }));
    api.onAssistantEvent.mockImplementation(callback => { event = callback; return () => {}; });
    api.startAssistantLogin.mockResolvedValue({
        ok: true,
        state: createAssistantState(),
        userCode: 'ABCD',
        verificationUrl: 'https://example.com/device',
    });
});
afterEach(() => unmounts.splice(0).forEach(unmount => unmount()));

describe('provider instance settings', () => {
    it('merges live statuses, preserves secret placeholders and submits empty configured secrets unchanged', async () => {
        const host = mount();
        await settle();
        expect(host.textContent).toContain('Actual probe warning');
        expect(host.textContent).toContain('/bin/codex');
        expect(host.querySelectorAll('input[type="password"]')).toHaveLength(2);
        expect([...host.querySelectorAll<HTMLInputElement>('input[type="password"]')].every(input => input.value === '')).toBe(true);
        expect(host.textContent).toContain('assistant.secretConfigured');
        click(host, 'assistant.saveInstances');
        await settle();
        expect(api.saveAssistantInstances).toHaveBeenCalledWith([expect.objectContaining({
            launchArgs: '',
            launchArgsSecret: true,
            environment: [{
                name: 'API_KEY',
                value: '',
                secret: true,
                configured: true,
            }],
        })]);
        expect(host.textContent).toContain('Saved provider configuration');
        event({
            type: 'instances',
            instances: [createAssistantInstance({
                state: 'error',
                message: 'New real failure',
            })],
        });
        await settle();
        expect(host.textContent).toContain('New real failure');
    });

    it('refreshes and starts device-code login for the chosen instance', async () => {
        const host = mount();
        await settle();
        click(host, 'assistant.refresh');
        await settle();
        expect(api.getAssistantState).toHaveBeenLastCalledWith({
            selection: {
                instanceId: 'codex',
                model: 'gpt',
                effort: 'medium',
                speedMode: 'standard',
            },
            probe: true,
        });
        click(host, 'assistant.signInDeviceCode');
        await settle();
        expect(api.startAssistantLogin).toHaveBeenCalledWith({
            instanceId: 'codex',
            mode: 'device-code',
        });
        expect(host.textContent).toContain('ABCD');
        expect(host.querySelector('a')?.href).toBe('https://example.com/device');
    });

    it('shows save errors and import notices, and replaces the list with the returned imports', async () => {
        const host = mount();
        await settle();
        api.saveAssistantInstances.mockResolvedValue({
            ok: false,
            instances: [],
            notices: [],
            error: 'Secure storage unavailable',
        });
        click(host, 'assistant.saveInstances');
        await settle();
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('Secure storage unavailable');
        api.importAssistantInstancesFromT3.mockResolvedValue({
            ok: true,
            instances: [{
                id: 'claude-b',
                driver: 'claude',
                displayName: 'Imported Claude',
                enabled: true,
            }],
            notices: ['Imported one instance'],
        });
        click(host, 'assistant.importT3');
        await settle();
        expect(host.textContent).toContain('Imported one instance');
        expect(host.textContent).toContain('Imported Claude');
        expect(host.querySelectorAll('article')).toHaveLength(1);
    });
});
