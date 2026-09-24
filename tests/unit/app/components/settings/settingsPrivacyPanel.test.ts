// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import { DEFAULT_SETTINGS } from '@contracts/settings';
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
