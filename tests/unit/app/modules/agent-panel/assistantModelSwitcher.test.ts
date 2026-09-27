// @vitest-environment happy-dom

import type {
    IAgentAssistantProviderStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import AssistantModelSwitcher from '@app/modules/agent-panel/components/AssistantModelSwitcher.vue';
import { createAgentAssistantStatus } from '@tests/helpers/createAgentAssistantStatus';

/**
 * The picker's whole job is to say, without prose, which assistant is talking
 * and which model it will use. These mounts pin the two signals that carry
 * that: the provider group heading and the model row marked checked.
 */
const { providers } = createAgentAssistantStatus();

const IconStub = defineComponent({
    props: {name: {
        type: String,
        default: '',
    }},
    setup: (props, {attrs}) => () => h('i', {
        ...attrs,
        'data-icon': props.name,
    }),
});

const PopoverStub = defineComponent({
    props: {
        content: {
            type: Object,
            default: () => ({}),
        },
        mode: {
            type: String,
            default: '',
        },
        open: {
            type: Boolean,
            default: false,
        },
        portal: {
            type: String,
            default: '',
        },
    },
    emits: ['update:open'],
    setup: (_props, {slots}) => () => h('div', [
        slots.default?.(),
        slots.content?.(),
    ]),
});

interface IHarnessState {
    providers: readonly IAgentAssistantProviderStatus[];
    selectedProvider: TAgentAssistantProviderId;
    selectedModel: string;
    isSwitching?: boolean;
    disabled?: boolean;
}

const activeUnmounts = new Set<() => void>();

/**
 * The switcher is controlled: it reports a click and waits for the parent to
 * hand back new props. The harness mirrors that, so switching provider really
 * does re-render the model list instead of leaving the previous one on screen.
 */
function mountSwitcher(overrides: Partial<IHarnessState> = {}) {
    const events: Record<string, unknown[]> = {
        'order': [],
        'select-model': [],
        'select-provider': [],
    };
    const state = reactive<IHarnessState>({
        providers,
        selectedProvider: 'codex',
        selectedModel: 'gpt-6-astra',
        ...overrides,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(AssistantModelSwitcher, {
        ...state,
        'onSelect-model': (model: string) => {
            events['order']!.push('select-model');
            events['select-model']!.push(model);
            state.selectedModel = model;
        },
        'onSelect-provider': (provider: TAgentAssistantProviderId) => {
            events['order']!.push('select-provider');
            events['select-provider']!.push(provider);
            state.selectedProvider = provider;
        },
    })}));
    app.component('UIcon', IconStub);
    app.component('UPopover', PopoverStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        events,
        host,
    };
}

function textOf(element: Element | null) {
    return element?.textContent?.trim() ?? '';
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('AssistantModelSwitcher', () => {
    it('lists every provider group with the selected model checked and the default marked', () => {
        const { host } = mountSwitcher();

        const groups = [...host.querySelectorAll('.assistant-model-group-label')];
        expect(groups.map(group => textOf(group))).toEqual([
            'Codex',
            'Claude',
        ]);

        const options = [...host.querySelectorAll('.assistant-switcher-option')];
        expect(options.map(option => textOf(option.querySelector('.assistant-switcher-option-label'))))
            .toEqual([
                'default',
                'GPT-6-Astra',
                'default',
            ]);
        expect(options.map(option => option.getAttribute('aria-pressed'))).toEqual([
            'false',
            'true',
            'false',
        ]);
        expect(options[1]?.querySelector('[data-icon="i-ph-check"]')).not.toBeNull();
    });

    it('shows the active model on the trigger without repeating the provider name', () => {
        const { host } = mountSwitcher({
            selectedModel: 'default',
            selectedProvider: 'claude',
        });

        expect(textOf(host.querySelector('.assistant-switcher-trigger-value'))).toBe('default');
        expect(host.querySelector('.assistant-switcher-trigger')?.getAttribute('aria-label'))
            .toBe('assistant.provider: Claude. assistant.model: Claude default');
    });

    it('switches provider and model in one click when picking from another group', async () => {
        const {
            events,
            host,
        } = mountSwitcher();

        host.querySelectorAll('.assistant-switcher-option')[2]?.dispatchEvent(new MouseEvent('click'));
        await nextTick();

        expect(events['select-provider']).toEqual(['claude']);
        expect(events['select-model']).toEqual(['default']);
        expect(events['order']).toEqual([
            'select-provider',
            'select-model',
        ]);

        const options = [...host.querySelectorAll('.assistant-switcher-option')];
        expect(options.map(option => option.getAttribute('aria-pressed'))).toEqual([
            'false',
            'false',
            'true',
        ]);
    });

    it('only emits the model when picking within the current provider', () => {
        const {
            events,
            host,
        } = mountSwitcher();

        host.querySelectorAll('.assistant-switcher-option')[0]?.dispatchEvent(new MouseEvent('click'));

        expect(events['select-provider']).toEqual([]);
        expect(events['select-model']).toEqual(['default']);
    });

    it('stays inert while a turn owns the selection', () => {
        const {
            events,
            host,
        } = mountSwitcher({disabled: true});

        host.querySelectorAll('.assistant-switcher-option')[2]?.dispatchEvent(new MouseEvent('click'));

        expect(events['select-provider']).toEqual([]);
        expect(events['select-model']).toEqual([]);
        expect(host.querySelector('.assistant-switcher-trigger')?.hasAttribute('disabled')).toBe(true);
    });
});
