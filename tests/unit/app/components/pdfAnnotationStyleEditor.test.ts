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
import { requirePageIndex } from '@contracts/pageNumbers';
import type {
    IAnnotationPropertyUpdate,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    asAnnotationId,
    type AnnotationEntity,
    type ITextBoxEntity,
    type INoteEntity,
    type ITextMarkupEntity,
    type IShapeEntity,
    type IPlacedImageEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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

interface IMountEditorOptions {
    tool?: TAnnotationTool;
    selectedAnnotations?: readonly AnnotationEntity[];
    selectedTextBox?: {
        color: string;
        fontSize: number;
    } | null;
}

function mountEditor({
    tool = 'text',
    selectedAnnotations = [],
    selectedTextBox = {
        color: '#123456',
        fontSize: 14,
    },
}: IMountEditorOptions = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const updates: Array<{
        key: string;
        value: unknown
    }> = [];
    const propertyUpdates: IAnnotationPropertyUpdate[] = [];
    const selectedTools: string[] = [];
    let activeTool: TAnnotationTool = tool;
    const setTool = (nextTool: TAnnotationTool) => {
        selectedTools.push(nextTool);
        activeTool = activeTool === nextTool ? 'none' : nextTool;
    };
    const app = createApp(defineComponent({setup: () => () => h(PdfAnnotationStyleEditor, {
        settings: {...DEFAULT_ANNOTATION_SETTINGS},
        selectedTextBox,
        selectedAnnotations,
        tool,
        onUpdateProperties: (updates: IAnnotationPropertyUpdate) => propertyUpdates.push(updates),
        onSetTool: setTool,
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
        selectedTools,
        propertyUpdates,
        get activeTool() {
            return activeTool;
        },
    };
}

function entityBase(id: string) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
    };
}

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.1,
};

const selectedText: ITextBoxEntity = {
    ...entityBase('text'),
    kind: 'text-box',
    text: 'Text',
    rect,
    rotation: 90,
    fontSize: 18,
    color: '#ef4444',
};
const selectedNote: INoteEntity = {
    ...entityBase('note'),
    kind: 'note',
    contents: 'Note',
    position: rect,
    color: '#22c55e',
    open: false,
};
const selectedMarkup: ITextMarkupEntity = {
    ...entityBase('markup'),
    kind: 'text-markup',
    contents: '',
    subtype: 'Highlight',
    quadPoints: [rect],
    color: '#ffd400',
    opacity: 0.35,
};
const selectedShape: IShapeEntity = {
    ...entityBase('shape'),
    kind: 'shape',
    tool: 'rectangle',
    rect,
    strokeColor: '#3b82f6',
    strokeWidth: 4,
    fill: '#ef4444',
    opacity: 0.7,
};
const selectedImage: IPlacedImageEntity = {
    ...entityBase('image'),
    kind: 'placed-image',
    rect,
    rotation: 180,
    image: {
        objectNumber: 20,
        generationNumber: 0,
        byteLength: 100,
        sha256: '0'.repeat(64),
    },
};

function changeNumber(host: HTMLElement, label: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`Missing selected property ${label}`);
    input.value = value;
    input.dispatchEvent(new Event('change', {bubbles: true}));
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

    it('changes draw presets without toggling the active draw tool off', () => {
        const editor = mountEditor({
            tool: 'draw',
            selectedTextBox: null,
        });
        const {
            host,
            updates,
            selectedTools,
        } = editor;

        host.querySelector<HTMLButtonElement>('.draw-style-button:last-child')?.click();

        expect(selectedTools).toEqual([]);
        expect(editor.activeTool).toBe('draw');
        expect(updates).toEqual([
            {
                key: 'inkThickness',
                value: 6,
            },
            {
                key: 'inkOpacity',
                value: 0.42,
            },
        ]);
    });

    it.each([
        {
            entity: selectedText,
            controls: [
                'annotations.textSize',
                'annotations.rotation',
            ],
        },
        {
            entity: selectedNote,
            controls: [],
        },
        {
            entity: selectedMarkup,
            controls: ['annotations.opacity'],
        },
        {
            entity: selectedShape,
            controls: [
                'annotations.stroke',
                'annotations.opacity',
                'annotations.fillColor',
            ],
        },
        {
            entity: selectedImage,
            controls: ['annotations.rotation'],
        },
    ])('shows supported canonical properties for $entity.kind', ({
        entity,
        controls,
    }) => {
        const {host} = mountEditor({
            tool: 'select',
            selectedAnnotations: [entity],
        });
        const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('input[aria-label]'));
        expect(inputs.map(input => input.getAttribute('aria-label'))).toEqual(controls);
        expect(host.querySelectorAll('.swatch').length > 0).toBe(entity.kind !== 'placed-image');
    });

    it('emits canonical text properties without changing creation defaults', () => {
        const {
            host,
            updates,
            propertyUpdates,
        } = mountEditor({
            tool: 'select',
            selectedAnnotations: [selectedText],
        });
        expect(host.querySelector<HTMLInputElement>('input[aria-label="annotations.textSize"]')?.value).toBe('18');
        host.querySelector<HTMLButtonElement>('button[aria-label="#22c55e"]')?.click();
        changeNumber(host, 'annotations.textSize', '26');
        changeNumber(host, 'annotations.rotation', '180');
        expect(propertyUpdates).toEqual([
            {color: '#22c55e'},
            {fontSize: 26},
            {rotation: 180},
        ]);
        expect(updates).toEqual([]);
    });

    it('shows custom selected colors as the active swatch', () => {
        const {host} = mountEditor({
            tool: 'select',
            selectedAnnotations: [{
                ...selectedText,
                color: '#123456',
            }],
        });
        expect(host.querySelector<HTMLButtonElement>('button[aria-label="#123456"]')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('shows mixed values without choosing one selected object as the default', () => {
        const {
            host,
            updates,
            propertyUpdates,
        } = mountEditor({
            tool: 'select',
            selectedAnnotations: [
                selectedShape,
                {
                    ...selectedShape,
                    ...entityBase('second-shape'),
                    strokeColor: '#ef4444',
                    strokeWidth: 8,
                    opacity: 0.5,
                },
            ],
        });
        for (const label of [
            'annotations.stroke',
            'annotations.opacity',
        ]) {
            const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
            expect(input?.value).toBe('');
            expect(input?.placeholder).toBe('annotations.mixedValues');
        }
        expect(host.querySelector('button[aria-pressed="true"]')).toBeNull();
        changeNumber(host, 'annotations.stroke', '6');
        changeNumber(host, 'annotations.opacity', '45');
        expect(propertyUpdates).toEqual([
            {strokeWidth: 6},
            {opacity: 0.45},
        ]);
        expect(updates).toEqual([]);
    });

    it('limits a heterogeneous selection to properties shared by every selected kind', () => {
        const {host} = mountEditor({
            tool: 'select',
            selectedAnnotations: [
                selectedMarkup,
                selectedShape,
            ],
        });
        expect(host.querySelector<HTMLInputElement>('input[aria-label="annotations.opacity"]')).not.toBeNull();
        expect(host.querySelector<HTMLInputElement>('input[aria-label="annotations.stroke"]')).toBeNull();
        expect(host.querySelector<HTMLInputElement>('input[aria-label="annotations.fillColor"]')).toBeNull();
        expect(host.querySelectorAll('.swatch').length).toBeGreaterThan(0);
    });

    it('does not emit a property mutation when a mixed number field is left empty', () => {
        const {
            host,
            propertyUpdates,
        } = mountEditor({
            tool: 'select',
            selectedAnnotations: [
                selectedShape,
                {
                    ...selectedShape,
                    ...entityBase('second-shape'),
                    strokeWidth: 8,
                },
            ],
        });
        changeNumber(host, 'annotations.stroke', '');
        expect(propertyUpdates).toEqual([]);
    });

    it('edits note defaults through noteColor without emitting a selected property change', () => {
        const {
            host,
            updates,
            propertyUpdates,
        } = mountEditor({
            tool: 'note',
            selectedTextBox: null,
        });
        host.querySelector<HTMLButtonElement>('button[aria-label="#22c55e"]')?.click();
        expect(updates).toEqual([{
            key: 'noteColor',
            value: '#22c55e',
        }]);
        expect(propertyUpdates).toEqual([]);
    });

});
