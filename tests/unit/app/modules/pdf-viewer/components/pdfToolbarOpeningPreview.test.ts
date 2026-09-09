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
    reactive,
    ref,
} from 'vue';
import PdfToolbar from '@app/modules/pdf-viewer/components/PdfToolbar.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/composables/useToolbarOverflow', () => ({useToolbarOverflow: () => ({
    toolbarRef: ref<HTMLElement | null>(null),
    collapseTier: ref(0),
    hasOverflowItems: ref(false),
    isCollapsed: () => false,
})}));

vi.mock('@app/components/ToolbarButton.vue', () => ({default: defineComponent({
    inheritAttrs: false,
    props: {
        disabled: {
            type: Boolean,
            default: false,
        },
        icon: {
            type: String,
            default: '',
        },
        tooltip: {
            type: String,
            default: '',
        },
    },
    emits: ['click'],
    setup(props, {emit}) {
        return () => h('button', {
            type: 'button',
            disabled: props.disabled,
            'data-icon': props.icon,
            'data-tooltip': props.tooltip,
            onClick: () => emit('click'),
        });
    },
})}));

vi.mock('@app/components/toolbar/ToolbarSaveSplitButton.vue', () => ({default: defineComponent({
    props: {
        saveDisabled: {
            type: Boolean,
            default: false,
        },
        saveAsDisabled: {
            type: Boolean,
            default: false,
        },
    },
    emits: [
        'save',
        'save-as',
    ],
    setup(props, {emit}) {
        return () => h('div', [
            h('button', {
                type: 'button',
                disabled: props.saveDisabled,
                'data-save': '',
                onClick: () => emit('save'),
            }),
            h('button', {
                type: 'button',
                disabled: props.saveAsDisabled,
                'data-save-as': '',
                onClick: () => emit('save-as'),
            }),
        ]);
    },
})}));

vi.mock('@app/components/icons/PrintCurrentPageIcon.vue', () => ({default: defineComponent({setup: () => () => h('span')})}));
vi.mock('@app/modules/agent-panel/public/component-exports/assistantToolbarToggle', () => ({AssistantToolbarToggle: defineComponent({setup: () => () => h('span')})}));

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function getButton(host: HTMLElement, tooltip: string) {
    const button = host.querySelector<HTMLButtonElement>(`button[data-tooltip="${tooltip}"]`);
    if (!button) {
        throw new Error(`Toolbar button ${tooltip} did not render.`);
    }
    return button;
}

async function mountToolbar() {
    const host = document.createElement('div');
    document.body.append(host);
    const onToggleSidebar = vi.fn();
    const props = reactive({
        hasPdf: true,
        canToggleSidebar: true,
        documentBusy: true,
        viewingReady: true,
        isOpeningDocument: true,
        canPrint: false,
        canSave: true,
        canSaveAs: true,
        canUndo: true,
        canRedo: true,
        canExportDocx: true,
        isSaving: false,
        isSavingAs: false,
        isAnySaving: false,
        isHistoryBusy: false,
        isExportingDocx: false,
        isFitWidthActive: false,
        isFitHeightActive: false,
        showSidebar: false,
        dragMode: false,
        isCapturingRegion: false,
        isCropSelecting: false,
        isPlacingPageNote: false,
        continuousScroll: true,
        isDjvuMode: false,
    });
    const app = createApp(defineComponent({setup: () => () => h(PdfToolbar, {
        ...props,
        onToggleSidebar,
    }, {
        'page-dropdown': () => h('div', {'data-page-dropdown': ''}),
        'zoom-dropdown': () => h('div', {'data-zoom-dropdown': ''}),
    })}));
    app.mount(host);
    await nextTick();

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        onToggleSidebar,
        props,
        unmount,
    };
}

describe('PdfToolbar opening preview', () => {
    it('keeps view controls interactive, then enables editing after the PDF.js handoff', async () => {
        const toolbar = await mountToolbar();

        expect(toolbar.host.querySelector('[data-page-dropdown]')).not.toBeNull();
        expect(toolbar.host.querySelector('[data-zoom-dropdown]')).not.toBeNull();
        expect(getButton(toolbar.host, 'toolbar.toggleSidebar').disabled).toBe(false);
        expect(getButton(toolbar.host, 'zoom.fitWidth').disabled).toBe(false);
        expect(getButton(toolbar.host, 'toolbar.fullscreen').disabled).toBe(false);
        expect(getButton(toolbar.host, 'zoom.textSelect').disabled).toBe(true);
        expect(getButton(toolbar.host, 'toolbar.crop').disabled).toBe(true);
        expect(toolbar.host.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(true);

        getButton(toolbar.host, 'toolbar.toggleSidebar').click();
        expect(toolbar.onToggleSidebar).toHaveBeenCalledOnce();

        toolbar.props.documentBusy = false;
        toolbar.props.isOpeningDocument = false;
        await nextTick();

        expect(getButton(toolbar.host, 'zoom.textSelect').disabled).toBe(false);
        expect(getButton(toolbar.host, 'toolbar.crop').disabled).toBe(false);
        expect(toolbar.host.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(false);
    });
});
