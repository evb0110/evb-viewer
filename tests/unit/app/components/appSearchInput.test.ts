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
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import AppSearchInput from '@app/components/AppSearchInput.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const InputStub = defineComponent({
    inheritAttrs: false,
    props: {modelValue: {
        type: String,
        default: '',
    }},
    emits: ['update:modelValue'],
    setup: (props, {
        attrs,
        emit,
        expose,
        slots,
    }) => {
        const inputRef = ref<HTMLInputElement | null>(null);
        expose({inputRef});
        return () => h('div', {'data-ui-input': ''}, [
            h('input', {
                ...attrs,
                ref: inputRef,
                value: props.modelValue,
                onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
            }),
            slots.trailing?.(),
        ]);
    },
});

const ButtonStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {
        attrs,
        slots,
    }) => () => h('button', {
        ...attrs,
        type: 'button',
    }, slots.default?.()),
});

const activeUnmounts = new Set<() => void>();

const FRUIT = [
    'apple',
    'apricot',
    'banana',
];

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const query = ref('');
    const visible = computed(() => FRUIT.filter(item => item.includes(query.value)));
    const app = createApp(defineComponent({setup: () => () => h('div', [
        h(AppSearchInput, {
            'modelValue': query.value,
            'aria-label': 'search',
            'onUpdate:modelValue': (value: string) => {
                query.value = value;
            },
        }),
        h('ul', visible.value.map(item => h('li', item))),
    ])}));
    app.component('UInput', InputStub);
    app.component('UButton', ButtonStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    const type = async (value: string) => {
        const input = host.querySelector('input')!;
        input.value = value;
        input.dispatchEvent(new Event('input'));
        await nextTick();
    };
    const clearButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="search.clearSearchLabel"]');
    const listed = () => Array.from(host.querySelectorAll('li')).map(item => item.textContent);

    return {
        clearButton,
        host,
        listed,
        query,
        type,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('AppSearchInput', () => {
    it('offers no clear control while the field is empty', () => {
        const { clearButton } = mount();

        expect(clearButton()).toBeNull();
    });

    it('restores the unfiltered list when the search is cleared', async () => {
        const {
            clearButton,
            listed,
            query,
            type,
        } = mount();

        await type('ap');
        expect(listed()).toEqual([
            'apple',
            'apricot',
        ]);

        const button = clearButton();
        expect(button).not.toBeNull();
        button!.click();
        await nextTick();

        expect(query.value).toBe('');
        expect(listed()).toEqual(FRUIT);
        expect(clearButton()).toBeNull();
    });

    it('returns focus to the field after clearing so typing continues', async () => {
        const {
            clearButton,
            host,
            type,
        } = mount();

        await type('ap');
        clearButton()!.click();
        await nextTick();

        expect(document.activeElement).toBe(host.querySelector('input'));
    });
});
