// @vitest-environment happy-dom

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
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import PdfAnnotationStyleEditor from '@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const TooltipStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {slots}) => () => h('span', slots.default?.()),
});

const ButtonStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }),
});

const SliderStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('input', {
        ...attrs,
        'data-slider': '',
        type: 'range',
    }),
});

const IconStub = defineComponent({
    props: {name: {
        type: String,
        default: '',
    }},
    setup: props => () => h('span', {'data-icon': props.name}),
});

const activeUnmounts = new Set<() => void>();

function mountEditor() {
    const host = document.createElement('div');
    document.body.append(host);
    const updates: Array<{
        key: string;
        value: unknown
    }> = [];
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationStyleEditor, {
        settings: {...DEFAULT_ANNOTATION_SETTINGS},
        selectedTextBox: {
            color: '#123456',
            fontSize: 14,
        },
        tool: 'text',
        onUpdateSetting: (payload: {
            key: string;
            value: unknown
        }) => updates.push(payload),
    })}));
    app.component('AppTooltip', TooltipStub);
    app.component('UButton', ButtonStub);
    app.component('UIcon', IconStub);
    app.component('USlider', SliderStub);
    app.mount(host);

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        updates,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('PdfAnnotationStyleEditor', () => {
    it('uses the selected text box style and routes text edits through settings events', () => {
        const {
            host,
            updates,
        } = mountEditor();

        expect(host.querySelector('.style-label')?.textContent).toContain('14');
        const selectedColor = host.querySelector<HTMLButtonElement>('button[aria-label="#123456"]');
        expect(selectedColor?.getAttribute('aria-pressed')).toBe('true');

        selectedColor?.click();
        expect(updates.at(-1)).toEqual({
            key: 'textColor',
            value: '#123456',
        });

        host.querySelector<HTMLButtonElement>('button[aria-label="annotations.increaseWidth"]')?.click();
        expect(updates.at(-1)).toEqual({
            key: 'textSize',
            value: 15,
        });
    });
});
