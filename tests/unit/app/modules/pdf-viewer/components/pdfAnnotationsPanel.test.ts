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
    nextTick,
    reactive,
    ref,
    watch,
} from 'vue';
import type {
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';

vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({settings: {authorName: null}})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({setup: () => () => vue.h('div', {'data-style-editor-stub': ''})})};
});
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {
            tool: {
                type: String,
                required: true,
            },
            stylePopoverOpen: {
                type: Boolean,
                default: false,
            },
        },
        setup: (_props, {expose}) => {
            const button = vue.ref<HTMLButtonElement | null>(null);
            vue.onMounted(() => {
                if (button.value === null) {
                    return;
                }
                button.value.getBoundingClientRect = () => ({
                    bottom: 40,
                    height: 40,
                    left: 0,
                    right: 40,
                    top: 0,
                    width: 40,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                });
            });
            expose({getButtonEl: (toolId: TAnnotationTool) => toolId === 'text' ? button.value : null});
            return () => vue.h('button', {
                ref: button,
                'data-toolbar-text': '',
                type: 'button',
            }, 'text');
        },
    })};
});

const ButtonStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('button', {
        ...attrs,
        type: 'button',
    }),
});

const CheckboxStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('input', {
        ...attrs,
        type: 'checkbox',
    }),
});

const IconStub = defineComponent({
    props: {name: {
        type: String,
        default: '',
    }},
    setup: props => () => h('span', {'data-icon': props.name}),
});

const PopoverStub = defineComponent({
    props: {
        content: {
            type: Object,
            default: () => ({}),
        },
        open: {
            type: Boolean,
            default: false,
        },
        portal: {
            type: String,
            default: '',
        },
        reference: {
            type: Object,
            default: null,
        },
    },
    emits: ['update:open'],
    setup: (props, {slots}) => {
        const element = ref<HTMLElement | null>(null);
        watch(() => props.open, async (open) => {
            if (!open) {
                return;
            }
            await nextTick();
            const event = new Event('openAutoFocus', {cancelable: true});
            props.content.onOpenAutoFocus?.(event);
            if (!event.defaultPrevented) {
                element.value?.querySelector<HTMLButtonElement>('.annotation-style-popover-close')?.focus();
            }
        });
        return () => h('div', {
            ref: element,
            'data-popover-stub': '',
        }, [
            slots.default?.(),
            props.open ? slots.content?.() : null,
        ]);
    },
});

interface IHarnessState {
    commentsStatus: TAnnotationCommentsStatus;
    isVisible: boolean;
    tool: TAnnotationTool;
    selectedTextBox: Pick<ITextBoxEntity, 'fontSize' | 'color'> | null;
}

const activeUnmounts = new Set<() => void>();

async function settle() {
    await nextTick();
    await nextTick();
    await nextTick();
    await nextTick();
}

function mountPanel() {
    const state = reactive<IHarnessState>({
        commentsStatus: 'ready',
        isVisible: true,
        tool: 'none',
        selectedTextBox: {
            color: '#123456',
            fontSize: 14,
        },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationsPanel, {
        isVisible: state.isVisible,
        tool: state.tool,
        keepActive: false,
        settings: {...DEFAULT_ANNOTATION_SETTINGS} satisfies IAnnotationSettings,
        comments: [],
        commentsStatus: state.commentsStatus,
        selectedTextBox: state.selectedTextBox,
    })}));
    app.component('UButton', ButtonStub);
    app.component('UCheckbox', CheckboxStub);
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
        host,
        state,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('PdfAnnotationsPanel style popover lifecycle', () => {
    it('keeps a newly focused annotation editor focused when selection opens styles', async () => {
        const {
            host,
            state,
        } = mountPanel();
        const layer = document.createElement('div');
        layer.className = 'pdf-annotation-editor-layer';
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        editor.tabIndex = 0;
        layer.append(editor);
        host.append(layer);
        editor.focus();

        state.tool = 'text';
        await settle();

        expect(host.querySelector('.annotation-style-popover')).not.toBeNull();
        expect(document.activeElement).toBe(editor);
    });

    it('keeps normal style-control autofocus for toolbar activation', async () => {
        const {
            host,
            state,
        } = mountPanel();
        host.querySelector<HTMLButtonElement>('[data-toolbar-text]')?.focus();

        state.tool = 'text';
        await settle();

        expect(document.activeElement).toBe(host.querySelector('.annotation-style-popover-close'));
    });

    it('dismisses the body popover while annotations are hidden and reopens on return', async () => {
        const {
            host,
            state,
        } = mountPanel();

        state.tool = 'text';
        await settle();

        expect(host.querySelector('.annotation-style-popover')).not.toBeNull();

        state.isVisible = false;
        await settle();

        expect(host.querySelector('.annotation-style-popover')).toBeNull();

        state.isVisible = true;
        await settle();

        expect(host.querySelector('.annotation-style-popover')).not.toBeNull();
    });

    it('stays closed when document annotation loading races with a tool change', async () => {
        const {
            host,
            state,
        } = mountPanel();

        state.tool = 'text';
        await settle();
        expect(host.querySelector('.annotation-style-popover')).not.toBeNull();

        state.commentsStatus = 'loading';
        state.tool = 'draw';
        await settle();

        expect(host.querySelector('.annotation-style-popover')).toBeNull();
    });

    it('opens a tool selected during loading once annotations are ready', async () => {
        const {
            host,
            state,
        } = mountPanel();

        state.commentsStatus = 'loading';
        state.tool = 'text';
        await settle();
        expect(host.querySelector('.annotation-style-popover')).toBeNull();

        state.commentsStatus = 'ready';
        await settle();

        expect(host.querySelector('.annotation-style-popover')).not.toBeNull();
    });
});
