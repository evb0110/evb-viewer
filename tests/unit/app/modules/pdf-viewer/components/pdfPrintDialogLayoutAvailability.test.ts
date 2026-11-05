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
import {LOCALE_MESSAGES} from '@i18n-app';
import {
    formatTranslationLeaf, getNestedTranslationLeaf,
} from '@i18n-core';
import PdfPrintDialog from '@app/modules/pdf-viewer/components/PdfPrintDialog.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string, params?: Record<string, string | number>) => realMessages
        ? formatTranslationLeaf(getNestedTranslationLeaf(LOCALE_MESSAGES.en, key) ?? key, params, 'en')
        : key}),
}));

let realMessages = false;

const ModalStub = defineComponent({setup: (_props, {slots}) => () => h('section', [
    slots.description?.(),
    slots.body?.(),
    slots.footer?.(),
])});

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: {
        disabled: Boolean,
        label: String,
    },
    setup: (props, {
        attrs,
        slots,
    }) => () => h('button', {
        ...attrs,
        disabled: props.disabled,
        type: 'button',
    }, slots.default?.() ?? props.label),
});

const RadioGroupStub = defineComponent({
    props: {
        legend: String,
        modelValue: String,
        items: Array<{
            label: string;
            value: string
        }>,
    },
    emits: ['update:modelValue'],
    setup: (props, {emit}) => () => h('fieldset', [
        h('legend', props.legend),
        ...((props.items ?? []).map(item => h('button', {onClick: () => emit('update:modelValue', item.value)}, item.label))),
    ]),
});

const activeUnmounts = new Set<() => void>();

function mountDialog(supportsFirstPageSinglePrintLayout: boolean, totalPages = 882) {
    const host = document.createElement('div');
    document.body.append(host);
    const open = ref(false);
    const submissions: unknown[] = [];
    const app = createApp(defineComponent({setup: () => () => h(PdfPrintDialog, {
        open: open.value,
        'onUpdate:open': (value: boolean) => {
            open.value = value;
        },
        totalPages,
        currentPage: 1,
        selectedPages: [],
        defaultViewMode: 'single',
        isPreparing: false,
        status: null,
        supportsAdvancedPrintOptions: true,
        supportsFirstPageSinglePrintLayout,
        onSubmit: (payload: unknown) => submissions.push(payload),
    })}));
    app.component('UModal', ModalStub);
    app.component('UButton', ButtonStub);
    app.component('URadioGroup', RadioGroupStub);
    app.component('UFormField', defineComponent({setup: (_props, {slots}) => () => slots.default?.()}));
    app.component('UInput', defineComponent({setup: () => () => h('input')}));
    app.component('UAlert', defineComponent({setup: () => () => null}));
    app.component('UIcon', defineComponent({setup: () => () => null}));
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        open,
        submissions,
        unmount,
    };
}

function buttonsWithPrefix(host: HTMLElement, prefix: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('button')]
        .filter(button => button.textContent?.trim().startsWith(prefix));
}

afterEach(() => {
    realMessages = false;
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('PdfPrintDialog layout availability', () => {
    it('offers native facing-page printing for path-backed PDFs', async () => {
        const mounted = mountDialog(false);
        mounted.open.value = true;
        await nextTick();
        await nextTick();

        const layoutButtons = buttonsWithPrefix(mounted.host, 'print.layout');
        expect(layoutButtons.map(button => button.textContent?.trim())).toStrictEqual([
            'print.layoutSingle',
            'print.layoutFacing',
        ]);
        expect(layoutButtons.map(button => button.getAttribute('aria-pressed'))).toStrictEqual([
            'true',
            'false',
        ]);
        expect(buttonsWithPrefix(mounted.host, 'print.orientation')).toHaveLength(3);

        layoutButtons[1]!.click();
        await nextTick();
        expect(layoutButtons.map(button => button.getAttribute('aria-pressed'))).toStrictEqual([
            'false',
            'true',
        ]);

        buttonsWithPrefix(mounted.host, 'print.action')[0]!.click();
        expect(mounted.submissions).toStrictEqual([{
            pageSelection: {
                kind: 'all',
                pageCount: 882,
            },
            viewMode: 'facing',
            orientation: 'auto',
        }]);
    });

    it('keeps the exact first-page-single compositor choice for byte-backed PDFs', async () => {
        const mounted = mountDialog(true);
        mounted.open.value = true;
        await nextTick();
        await nextTick();

        expect(buttonsWithPrefix(mounted.host, 'print.layout')
            .map(button => button.textContent?.trim())).toStrictEqual([
            'print.layoutSingle',
            'print.layoutFacing',
            'print.layoutFacingFirstSingle',
        ]);
    });
});

it.each([
    1,
    12,
])('renders a singular print summary for one selected page out of %s', async (totalPages) => {
    realMessages = true;
    const mounted = mountDialog(true, totalPages);
    mounted.open.value = true;
    await nextTick();
    await nextTick();
    if (totalPages > 1) {
        const current = [...mounted.host.querySelectorAll('fieldset button')].find(button => button.textContent === 'Current page (1)');
        expect(current).toBeDefined();
        (current as HTMLButtonElement).click();
        await nextTick();
    }
    expect([...mounted.host.querySelectorAll('p')].map(p => p.textContent))
        .toContain('Printing 1 page with Single pages and Auto orientation.');
});
