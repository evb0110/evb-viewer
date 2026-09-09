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
    nextTick,
    ref,
} from 'vue';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import SettingsPerformancePanel from '@app/components/settings/SettingsPerformancePanel.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const FormFieldStub = defineComponent({setup: (_props, {slots}) => () => h('div', slots.default?.())});
const SelectMenuStub = defineComponent({
    inheritAttrs: false,
    props: {
        items: {
            type: Array,
            default: () => [],
        },
        modelValue: {
            type: String,
            default: '',
        },
    },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
    }) => () => h('select', {
        ...attrs,
        'data-ui-select': '',
        value: props.modelValue,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
    }, (props.items as Array<{
        label: string;
        value: string;
    }>).map(item => h('option', {value: item.value}, item.label))),
});

const IconStub = defineComponent({
    props: {name: {
        type: String,
        default: '',
    }},
    setup: props => () => h('span', {'data-ui-icon': props.name}),
});

const activeUnmounts = new Set<() => void>();

const RESTART_NOTICE_SELECTOR = '.settings-performance-restart-notice';

function mount(performanceMode: TPerformanceMode) {
    const host = document.createElement('div');
    document.body.append(host);
    const emitted: string[] = [];
    const performanceModeRef = ref(performanceMode);
    const app = createApp(defineComponent({setup: () => () => h(SettingsPerformancePanel, {
        settings: {
            ...DEFAULT_SETTINGS,
            performanceMode: performanceModeRef.value,
        },
        'onUpdate:performanceMode': (value: string | { value: string }) => {
            emitted.push(typeof value === 'string' ? value : value.value);
        },
    })}));
    app.component('UFormField', FormFieldStub);
    app.component('USelectMenu', SelectMenuStub);
    app.component('UIcon', IconStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    const setPersistedMode = async (mode: TPerformanceMode) => {
        performanceModeRef.value = mode;
        await nextTick();
    };
    return {
        host,
        emitted,
        setPersistedMode,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    vi.unstubAllGlobals();
});

describe('SettingsPerformancePanel', () => {
    it('renders every performance mode option with the current selection', () => {
        const { host } = mount('medium');
        const select = host.querySelector('select');
        expect(select).not.toBeNull();
        const optionValues = Array.from(select!.options).map(option => option.value);
        expect(optionValues).toEqual([
            'auto',
            'low',
            'medium',
            'high',
        ]);
        expect(select!.value).toBe('medium');
    });

    it('emits update:performance-mode when a mode is selected', () => {
        const {
            host,
            emitted,
        } = mount('auto');
        const select = host.querySelector('select')!;
        select.value = 'high';
        select.dispatchEvent(new Event('change'));
        expect(emitted).toEqual(['high']);
    });

    it('hides the restart notice while the mode matches the value applied at mount', () => {
        const { host } = mount('auto');
        expect(host.querySelector(RESTART_NOTICE_SELECTOR)).toBeNull();
    });

    it('shows the restart notice once the persisted mode differs from the applied one', async () => {
        const {
            host,
            setPersistedMode,
        } = mount('auto');
        await setPersistedMode('low');
        expect(host.querySelector(RESTART_NOTICE_SELECTOR)?.textContent).toContain('settings.performanceRestartNotice');
    });

    it('clears the restart notice when the mode is reverted to the applied one before restart', async () => {
        const {
            host,
            setPersistedMode,
        } = mount('auto');
        await setPersistedMode('high');
        expect(host.querySelector(RESTART_NOTICE_SELECTOR)).not.toBeNull();
        await setPersistedMode('auto');
        expect(host.querySelector(RESTART_NOTICE_SELECTOR)).toBeNull();
    });
});
