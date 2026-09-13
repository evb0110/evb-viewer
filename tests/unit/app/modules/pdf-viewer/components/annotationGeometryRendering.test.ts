// @vitest-environment happy-dom
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    computed,
    createApp as createVueApp,
    effectScope,
    defineComponent,
    h,
    nextTick,
    provide,
    ref,
    shallowRef,
} from 'vue';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import PdfAnnotationEditorLayer from '@app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue';
import PdfTextMarkupAnnotation from '@app/modules/pdf-viewer/components/PdfTextMarkupAnnotation.vue';
import PdfShapeAnnotation from '@app/modules/pdf-viewer/components/PdfShapeAnnotation.vue';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import {useAnnotationCreationTools} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';
import type {TAnnotationTool} from '@app/types/annotations';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    asAnnotationId,
    type IShapeEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function createApp(...args: Parameters<typeof createVueApp>) {
    const app = createVueApp(...args);
    app.component('UIcon', {render: () => h('span')});
    app.component('AppTooltip', defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => slots.default?.(),
    }));
    return app;
}

async function mountLayer(tool: TAnnotationTool = 'select', viewRotation: 0 | 90 | 180 | 270 = 0) {
    const application = shallowRef(new AnnotationApplication('geometry-rendering'));
    const activeTool = ref(tool);
    const scope = effectScope();
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication: application,
        activeTool: computed(() => activeTool.value),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        getPageGeometry: () => ({
            pageView: [
                10,
                20,
                610,
                920,
            ],
            rotation: 0,
            viewRotation,
        }),
    }))!;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({setup() {
        provide(annotationEditorSurfaceKey, surface);
        return () => h(PdfAnnotationEditorLayer, {pageIndex: 0});
    }});
    app.mount(host);
    onTestFinished(() => {app.unmount(); scope.stop(); host.remove();});
    await nextTick();
    const layer = host.querySelector<HTMLElement>('[data-pdf-annotation-editor-surface]')!;
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, viewRotation % 180 ? 900 : 600, viewRotation % 180 ? 600 : 900));
    function pointer(target: Element, event: string, x: number, y: number) {
        target.dispatchEvent(new PointerEvent(event, {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: x,
            clientY: y,
        }));
    }
    return {
        surface,
        host,
        layer,
        pointer,
        application,
    };
}

describe('annotation geometry rendering', () => {
    it.each([
        'rectangle',
        'circle',
    ] as const)('creates a reverse-drawn %s through the layer', async tool => {
        const harness = await mountLayer(tool);
        harness.pointer(harness.layer, 'pointerdown', 480, 720);
        harness.pointer(harness.layer, 'pointermove', 360, 540);
        harness.pointer(harness.layer, 'pointermove', 240, 360);
        harness.pointer(harness.layer, 'pointerup', 240, 360);
        expect(harness.surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({
            kind: 'shape',
            rect: {
                left: 0.4,
                top: 0.4,
                width: 0.4,
                height: 0.4,
            },
        });
    });

    it.each([
        'text',
        'rectangle',
        'circle',
        'line',
        'arrow',
        'draw',
    ] as const)('previews the resized %s before release and commits those dimensions', async tool => {
        const harness = await mountLayer();
        const creation = useAnnotationCreationTools({surface: harness.surface});
        const origin = {
            x: 0.2,
            y: 0.2,
        };
        const entity = tool === 'text'
            ? harness.surface.createTextBoxAt(0, {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.3,
            }, {text: 'short'})
            : harness.surface.createShape(creation.finishShape(creation.updateShape(creation.beginShape(0, tool, origin)!, {
                x: 0.5,
                y: 0.5,
            }, origin))!);
        harness.surface.select([entity.identity.id]);
        await nextTick();
        const handle = harness.host.querySelector('[data-pdf-annotation-resize-handle="se"]')!;
        harness.pointer(handle, 'pointerdown', 300, 450);
        harness.pointer(harness.layer, 'pointermove', 420, 630);
        await nextTick();
        const handles = harness.host.querySelector<HTMLElement>('.pdf-annotation-selection-handles')!;
        expect(parseFloat(handles.style.width)).toBeCloseTo(50);
        expect(parseFloat(handles.style.height)).toBeCloseTo(50);
        if (tool === 'text') {
            const text = harness.host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!;
            expect(parseFloat(text.style.width)).toBeCloseTo(50);
            expect(parseFloat(text.style.height)).toBeCloseTo(50);
        } else {
            const shape = harness.host.querySelector('[data-annotation-kind="shape"] [data-annotation-visual]')!;
            if (tool === 'rectangle') expect(Number(shape.querySelector('rect')!.getAttribute('width'))).toBeCloseTo(0.5);
            if (tool === 'circle') expect(Number(shape.querySelector('ellipse')!.getAttribute('rx'))).toBeCloseTo(0.25);
            if (tool === 'line' || tool === 'arrow') expect(Number(shape.querySelector('line')!.getAttribute('x2'))).toBeCloseTo(0.7);
            if (tool === 'draw') expect(shape.querySelector('polyline')!.getAttribute('points')).toContain('0.7,0.7');
        }
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({rect: {
            width: 0.3,
            height: 0.3,
        }});
        harness.pointer(harness.layer, 'pointerup', 420, 630);
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({rect: {
            width: expect.closeTo(0.5),
            height: expect.closeTo(0.5),
        }});
    });

    it('maps pointer creation back through view rotation on a nonsquare CropBox', async () => {
        const harness = await mountLayer('rectangle', 90);
        harness.pointer(harness.layer, 'pointerdown', 720, 120);
        harness.pointer(harness.layer, 'pointermove', 450, 300);
        harness.pointer(harness.layer, 'pointerup', 450, 300);
        const entity = harness.surface.getEntitiesForPage(0)[0];
        expect(entity).toMatchObject({kind: 'shape'});
        if (entity?.kind !== 'shape') throw new Error('shape missing');
        expect(entity.rect.left).toBeCloseTo(0.2);
        expect(entity.rect.top).toBeCloseTo(0.2);
        expect(entity.rect.width).toBeCloseTo(0.3);
        expect(entity.rect.height).toBeCloseTo(0.3);
        expect(harness.host.querySelector<HTMLElement>('.pdf-annotation-editor-surface__html')!.style.transform).toContain('rotate(90deg)');
    });

    it('keeps newly typed text upright after a view-only quarter turn', async () => {
        const harness = await mountLayer('text', 90);
        harness.pointer(harness.layer, 'pointerdown', 450, 300);
        harness.pointer(harness.layer, 'pointerup', 450, 300);
        await nextTick();
        expect(harness.surface.getEntitiesForPage(0)[0]).toMatchObject({
            kind: 'text-box',
            rotation: 270,
        });
        expect(harness.host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!.style.transform).toBe('rotate(270deg)');
        expect(harness.host.querySelector('[contenteditable="true"]')).not.toBeNull();
    });

    it('measures multiline draft width from untransformed layout under combined entity and view rotations', async () => {
        const harness = await mountLayer('text', 90);
        harness.pointer(harness.layer, 'pointerdown', 450, 300);
        harness.pointer(harness.layer, 'pointerup', 450, 300);
        const entity = harness.surface.getEntitiesForPage(0)[0]!;
        harness.application.value.store.updateTextBox(entity.identity.id, {rotation: 180});
        await nextTick();
        const editor = harness.host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        Object.defineProperties(editor, {
            scrollWidth: {
                configurable: true,
                value: 83,
            },
            scrollHeight: {
                configurable: true,
                value: 56,
            },
        });
        // A transformed rectangle's width can be its multiline height. It must
        // never determine the untransformed text wrapping width.
        vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 83));
        editor.textContent = 'first line\nsecond line\nthird line';
        editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        await nextTick();
        const root = harness.host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!;
        expect(parseFloat(root.style.width) / 100).toBeCloseTo(83 / 600);
        expect(parseFloat(root.style.height) / 100).toBeCloseTo(56 / 900);
    });

    it('keeps group preview and committed positions identical beside a page edge', async () => {
        const harness = await mountLayer();
        const first = harness.surface.createTextBoxAt(0, {
            left: 0.2,
            top: 0.2,
            width: 0.1,
            height: 0.1,
        }, {text: 'one'});
        const last = harness.surface.createTextBoxAt(0, {
            left: 0.85,
            top: 0.2,
            width: 0.1,
            height: 0.1,
        }, {text: 'two'});
        harness.surface.select([
            first.identity.id,
            last.identity.id,
        ]);
        await nextTick();
        const element = harness.host.querySelector(`[data-annotation-id="${first.identity.id}"]`)!;
        harness.pointer(element, 'pointerdown', 130, 190);
        harness.pointer(harness.layer, 'pointermove', 310, 190);
        await nextTick();
        const positions = [
            first,
            last,
        ].map(entity => parseFloat(harness.host.querySelector<HTMLElement>(`[data-annotation-id="${entity.identity.id}"]`)!.style.left) / 100);
        expect(positions[0]).toBeCloseTo(0.25);
        expect(positions[1]).toBeCloseTo(0.9);
        harness.pointer(harness.layer, 'pointerup', 310, 190);
        harness.surface.getEntitiesForPage(0).forEach((entity, index) => {
            if (entity.kind !== 'text-box') throw new Error('text missing');
            expect(entity.rect.left).toBeCloseTo(positions[index]!);
        });
    });

    it.each([
        'Highlight',
        'Underline',
        'StrikeOut',
        'Squiggly',
    ] as const)('draws the %s subtype with a separate hit target', subtype => {
        const entity: ITextMarkupEntity = {
            kind: 'text-markup',
            identity: {id: asAnnotationId('markup')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: '',
            subtype,
            quadPoints: [{
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.1,
            }],
            color: '#ff0000',
            opacity: 0.3,
        };
        const host = document.createElement('div');
        const app = createApp({render: () => h('svg', [h(PdfTextMarkupAnnotation, {
            entity,
            selected: false,
        })])});
        app.mount(host);
        onTestFinished(() => app.unmount());
        expect(host.querySelectorAll('[data-annotation-hit-target]')).toHaveLength(1);
        const visual = host.querySelector('[data-annotation-visual]')!;
        expect(visual).not.toBeNull();
        if (subtype === 'Squiggly') expect(visual.getAttribute('d')?.split('L').length).toBeGreaterThan(3);
        if (subtype === 'Underline' || subtype === 'StrikeOut') expect(Number(visual.getAttribute('y1'))).toBeCloseTo(subtype === 'Underline' ? 0.394 : 0.35);
    });

    it.each([
        0,
        0.42,
        0.55,
        1,
    ])('keeps arrow visual alpha on the shared painted group at %s', opacity => {
        const entity: IShapeEntity = {
            kind: 'shape',
            identity: {id: asAnnotationId(`arrow-${String(opacity)}`)},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: 0,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            tool: 'arrow',
            rect: {
                left: 0.2,
                top: 0.3,
                width: 0.5,
                height: 0.2,
            },
            points: [
                {
                    x: 0.2,
                    y: 0.3,
                },
                {
                    x: 0.7,
                    y: 0.5,
                },
            ],
            strokeColor: '#224466',
            strokeWidth: 4,
            fill: '#aaccee',
            opacity,
            lineEndStyle: 'closedArrow',
        };
        const host = document.createElement('div');
        const app = createApp({render: () => h('svg', [h(PdfShapeAnnotation, {
            entity,
            selected: false,
            pageSize: {
                width: 612,
                height: 792,
            },
        })])});
        app.mount(host);
        onTestFinished(() => app.unmount());

        const root = host.querySelector<SVGGElement>('[data-annotation-kind="shape"]')!;
        const visual = root.querySelector<SVGGElement>('[data-annotation-visual]')!;
        const hit = root.querySelector<SVGGElement>('[data-annotation-hit-target]')!;
        expect(root.style.getPropertyValue('--annotation-opacity')).toBe(String(opacity));
        expect(visual.querySelector('line')).not.toBeNull();
        expect(visual.querySelector('.pdf-annotation-editor-shape__arrowhead')).not.toBeNull();
        expect(visual.style.opacity).toBe('');
        expect(hit.style.opacity).toBe('');
        expect(hit.querySelector('line')).not.toBeNull();
    });
});
