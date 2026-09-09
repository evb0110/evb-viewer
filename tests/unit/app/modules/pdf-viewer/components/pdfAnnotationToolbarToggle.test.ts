// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import PdfAnnotationToolbar from '@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue';
import {usePageAnnotationTools} from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type {TAnnotationTool} from '@app/types/annotations';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function mountToolbar() {
    const prepareAnnotationToolChange = vi.fn();
    const clearSelectedShape = vi.fn();
    const tools = usePageAnnotationTools({
        pdfViewerRef: ref({
            prepareAnnotationToolChange,
            clearSelectedShape,
            selectedShapeId: null,
            getSelectedShape: () => null,
            updateShape: vi.fn(),
        }),
        dragMode: ref(false),
        clearAnnotationChanges: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        hasAnnotationChanges: () => false,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationToolbar, {
        tool: tools.annotationTool.value,
        'onSet-tool': tools.handleAnnotationToolChange,
    })}));
    app.component('AppTooltip', defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => slots.default?.(),
    }));
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.mount(host);
    onTestFinished(() => { app.unmount(); host.remove(); });
    function button(tool: TAnnotationTool) {
        const element = host.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
        if (!element) throw new Error(`Missing tool button: ${tool}`);
        return element;
    }
    async function click(tool: TAnnotationTool) {
        button(tool).click();
        await nextTick();
    }
    return {
        tools,
        button,
        click,
        prepareAnnotationToolChange,
        clearSelectedShape,
    };
}

describe('annotation toolbar tool selection', () => {
    it.each([
        'text',
        'draw',
        'note',
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
        'rectangle',
        'circle',
        'line',
        'arrow',
    ] as const)('deactivates the active %s tool on a second click', async (tool) => {
        const toolbar = mountToolbar();
        await toolbar.click(tool);
        expect(toolbar.tools.annotationTool.value).toBe(tool);
        expect(toolbar.button(tool).getAttribute('aria-pressed')).toBe('true');
        toolbar.prepareAnnotationToolChange.mockClear();
        toolbar.clearSelectedShape.mockClear();
        await toolbar.click(tool);
        expect(toolbar.tools.annotationTool.value).toBe('select');
        expect(toolbar.button(tool).getAttribute('aria-pressed')).toBe('false');
        expect(toolbar.button('select').getAttribute('aria-pressed')).toBe('true');
        expect(toolbar.prepareAnnotationToolChange).toHaveBeenCalledOnce();
        expect(toolbar.clearSelectedShape).not.toHaveBeenCalled();
    });

    it('activates a different tool and leaves selection active when clicked again', async () => {
        const toolbar = mountToolbar();
        await toolbar.click('text');
        await toolbar.click('draw');
        expect(toolbar.tools.annotationTool.value).toBe('draw');
        expect(toolbar.button('text').getAttribute('aria-pressed')).toBe('false');
        await toolbar.click('select');
        await toolbar.click('select');
        expect(toolbar.tools.annotationTool.value).toBe('select');
    });
});
