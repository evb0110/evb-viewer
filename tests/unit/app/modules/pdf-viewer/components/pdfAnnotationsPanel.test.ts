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
} from 'vue';
import { requirePageIndex } from '@contracts/pageNumbers';
import type {
    IAnnotationPropertyUpdate,
    IAnnotationSettings,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    asAnnotationId,
    type AnnotationEntity,
    type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import PdfAnnotationsPanel from '@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue';

vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({settings: {authorName: null}})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue', () => ({default: {render: () => null}}));

const TooltipStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});
const ButtonStub = defineComponent({setup: (_props, {attrs}) => () => h('button', {
    ...attrs,
    type: 'button',
})});
const InputStub = defineComponent({setup: (_props, {attrs}) => () => h('input', attrs)});
const IconStub = defineComponent({setup: () => () => h('span')});

function textBox(overrides: Partial<ITextBoxEntity> = {}): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: asAnnotationId('selected-text')},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        text: 'Selected text',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.1,
        },
        rotation: 0,
        fontSize: 14,
        color: '#123456',
        ...overrides,
    };
}

interface IHarnessState {
    commentsStatus: TAnnotationCommentsStatus;
    isVisible: boolean;
    tool: TAnnotationTool;
    selectedAnnotations: AnnotationEntity[];
}

const activeUnmounts = new Set<() => void>();

function mountPanel() {
    const state = reactive<IHarnessState>({
        commentsStatus: 'ready',
        isVisible: true,
        tool: 'select',
        selectedAnnotations: [textBox()],
    });
    const settingUpdates: unknown[] = [];
    const propertyUpdates: IAnnotationPropertyUpdate[] = [];
    const tools: TAnnotationTool[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationsPanel, {
        ...state,
        keepActive: false,
        settings: {...DEFAULT_ANNOTATION_SETTINGS} satisfies IAnnotationSettings,
        comments: [],
        onSetTool: (tool: TAnnotationTool) => {
            tools.push(tool);
            state.tool = tool;
        },
        onUpdateSetting: (update: unknown) => settingUpdates.push(update),
        onUpdateProperties: (update: IAnnotationPropertyUpdate) => propertyUpdates.push(update),
    })}));
    app.component('AppTooltip', TooltipStub);
    app.component('UButton', ButtonStub);
    app.component('UCheckbox', InputStub);
    app.component('USlider', InputStub);
    app.component('UIcon', IconStub);
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
        tools,
        settingUpdates,
        propertyUpdates,
    };
}

function inspector(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[data-annotation-inspector]');
}

function numberInput(host: HTMLElement, label: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`Missing inspector input ${label}`);
    return input;
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) unmount();
});

describe('PdfAnnotationsPanel inline inspector', () => {
    it('offers Keep active for repeatable tools but not one-shot notes', async () => {
        const {
            host,
            state,
        } = mountPanel();
        expect(host.querySelector('.annotation-tool-options')).not.toBeNull();
        state.tool = 'note';
        await nextTick();
        expect(host.querySelector('.annotation-tool-options')).toBeNull();
        state.tool = 'draw';
        await nextTick();
        expect(host.querySelector('.annotation-tool-options')).not.toBeNull();
    });

    it('renders exactly one live inspector within the panel and removes hidden controls', async () => {
        const {
            host,
            state,
        } = mountPanel();
        expect(document.querySelectorAll('[data-annotation-inspector]')).toHaveLength(1);
        expect(host.querySelectorAll('.annotation-style-editor')).toHaveLength(1);
        expect(host.contains(inspector(host))).toBe(true);
        expect(document.querySelector('.annotation-style-popover, .annotation-style-cache')).toBeNull();

        state.isVisible = false;
        await nextTick();
        expect(document.querySelector('[data-annotation-inspector]')).toBeNull();
        expect(host.querySelector('.annotation-style-editor')).toBeNull();

        state.isVisible = true;
        await nextTick();
        expect(document.querySelectorAll('[data-annotation-inspector]')).toHaveLength(1);
        expect(host.querySelectorAll('.annotation-style-editor')).toHaveLength(1);
    });

    it('preserves the focused control when selected entity properties change', async () => {
        const {
            host,
            state,
        } = mountPanel();
        const input = numberInput(host, 'annotations.textSize');
        const panel = inspector(host);
        input.focus();

        state.selectedAnnotations = [textBox({
            fontSize: 18,
            revision: 1,
        })];
        await nextTick();

        expect(inspector(host)).toBe(panel);
        expect(numberInput(host, 'annotations.textSize')).toBe(input);
        expect(input.value).toBe('18');
        expect(document.activeElement).toBe(input);
    });

    it.each([
        'select',
        'none',
    ] as const)('shows selected properties in %s mode', async (tool) => {
        const {
            host,
            state,
        } = mountPanel();
        state.tool = tool;
        await nextTick();
        expect(inspector(host)?.dataset.target).toBe('selection');
        expect(numberInput(host, 'annotations.textSize').value).toBe('14');
    });

    it('edits defaults while a creation tool is armed even with an existing selection', async () => {
        const {
            host,
            state,
            settingUpdates,
            propertyUpdates,
        } = mountPanel();
        state.tool = 'text';
        await nextTick();
        expect(inspector(host)?.dataset.target).toBe('defaults');
        expect(host.querySelector('.style-label')?.textContent).toContain(String(DEFAULT_ANNOTATION_SETTINGS.textSize));
        host.querySelector<HTMLButtonElement>('button[aria-label="annotations.increaseWidth"]')?.click();
        expect(settingUpdates).toEqual([{
            key: 'textSize',
            value: DEFAULT_ANNOTATION_SETTINGS.textSize + 1,
        }]);
        expect(propertyUpdates).toEqual([]);
    });

    it('emits selected property changes separately from defaults', () => {
        const {
            host,
            settingUpdates,
            propertyUpdates,
        } = mountPanel();
        const input = numberInput(host, 'annotations.textSize');
        input.value = '24';
        input.dispatchEvent(new Event('change', {bubbles: true}));
        expect(propertyUpdates).toEqual([{fontSize: 24}]);
        expect(settingUpdates).toEqual([]);
    });

    it('deactivates an already active toolbar tool and preserves toolbar focus', async () => {
        const {
            host,
            state,
            tools,
        } = mountPanel();
        state.tool = 'text';
        await nextTick();
        const button = host.querySelector<HTMLButtonElement>('button[data-tool="text"]');
        if (!button) throw new Error('Missing text tool button');
        button.focus();
        button.click();
        await nextTick();
        expect(tools).toEqual(['select']);
        expect(state.tool).toBe('select');
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(document.activeElement).toBe(button);
    });

    it('keeps the same inspector through comment loading and updates', async () => {
        const {
            host,
            state,
        } = mountPanel();
        const panel = inspector(host);
        state.commentsStatus = 'loading';
        await nextTick();
        expect(inspector(host)).toBe(panel);
        state.commentsStatus = 'ready';
        await nextTick();
        expect(inspector(host)).toBe(panel);
    });
});
