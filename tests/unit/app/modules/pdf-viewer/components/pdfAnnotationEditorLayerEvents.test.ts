// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    h,
    nextTick,
    provide,
    ref,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import PdfAnnotationEditorLayer from '@app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue';
import PdfTextBoxAnnotation from '@app/modules/pdf-viewer/components/PdfTextBoxAnnotation.vue';
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IPlacedImageEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    annotationId,
    createApp,
    createCreationSurface,
    createSurface,
    createdTextBox,
    entity,
} from '@tests/unit/app/modules/pdf-viewer/components/pdfAnnotationEditorLayerEventFixtures';

describe('PdfAnnotationEditorLayer SVG events', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('selects an SVG markup entity on pointerdown and retains selection through a moved gesture and click', async () => {
        const harness = createSurface();
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, harness.surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const rect = host.querySelector<SVGRectElement>('[data-annotation-id="reopened-markup"] rect');
        const entityRoot = host.querySelector('[data-annotation-id="reopened-markup"]');
        expect(layer).not.toBeNull();
        expect(rect).not.toBeNull();
        vi.spyOn(layer!, 'getBoundingClientRect').mockReturnValue({
            bottom: 100,
            height: 100,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        rect!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 1,
        }));
        await nextTick();
        expect(harness.select).toHaveBeenCalledWith([annotationId], {additive: false});
        expect(harness.selectedIds.value.has(annotationId)).toBe(true);
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).toBe(entityRoot);

        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 1,
        }));
        layer!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(harness.select).toHaveBeenCalledTimes(2);
        expect(harness.selectedIds.value.has(annotationId)).toBe(true);
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).not.toBeNull();

        rect!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 2,
        }));
        rect!.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 32,
            clientY: 20,
            pointerId: 2,
        }));
        rect!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 32,
            clientY: 20,
            pointerId: 2,
        }));
        rect!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        expect(harness.commitGesture).toHaveBeenCalledOnce();
        expect(harness.selectedIds.value.has(annotationId)).toBe(true);
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).not.toBeNull();

        layer!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 80,
            clientY: 80,
            pointerId: 3,
        }));
        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 80,
            clientY: 80,
            pointerId: 3,
        }));
        layer!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        expect(harness.selectedIds.value.size).toBe(0);
        expect(harness.surface.clearSelection).toHaveBeenCalled();
        app.unmount();
    });

    it('projects store selection through a root-retargeted no-move click without a remount', async () => {
        const annotationApplication = shallowRef(new AnnotationApplication('layer-store-events'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication,
            activeTool: computed<TAnnotationTool>(() => 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        }))!;
        annotationApplication.value.store.createTextMarkup({
            ...entity,
            revision: 0,
            persistedRevision: -1,
        });

        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const rect = host.querySelector<SVGRectElement>('[data-annotation-id="reopened-markup"] rect');
        const entityRoot = host.querySelector('[data-annotation-id="reopened-markup"]');
        expect(layer).not.toBeNull();
        expect(rect).not.toBeNull();
        expect(entityRoot).not.toBeNull();
        annotationApplication.value.store.select([annotationId]);
        await nextTick();
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).toBe(entityRoot);
        vi.spyOn(layer!, 'getBoundingClientRect').mockReturnValue({
            bottom: 100,
            height: 100,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        rect!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 11,
        }));
        expect(host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')).toBe(layer);
        expect(annotationApplication.value.store.selectedIds).toEqual(new Set([annotationId]));
        expect(surface.selectedIds.value).toEqual(new Set([annotationId]));

        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 11,
        }));
        layer!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

        expect(annotationApplication.value.store.selectedIds).toEqual(new Set([annotationId]));
        expect(surface.selectedIds.value).toEqual(new Set([annotationId]));
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).not.toBeNull();

        layer!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 80,
            clientY: 80,
            pointerId: 12,
        }));
        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 80,
            clientY: 80,
            pointerId: 12,
        }));
        layer!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await nextTick();

        expect(annotationApplication.value.store.selectedIds).toEqual(new Set());
        expect(surface.selectedIds.value).toEqual(new Set());
        expect(host.querySelector('[data-annotation-id="reopened-markup"].is-selected')).toBeNull();
        app.unmount();
        scope.stop();
    });

    it('starts a canonical resize gesture for a placed image', async () => {
        const image: IPlacedImageEntity = {
            kind: 'placed-image',
            identity: {id: 'placed-image-test' as IPlacedImageEntity['identity']['id']},
            pageIndex: requirePageIndex(25),
            revision: 1,
            persistedRevision: 1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            rect: {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            },
            rotation: 0,
            image: {
                objectNumber: 10,
                generationNumber: 0,
                byteLength: 4,
                sha256: 'a'.repeat(64),
            },
        };
        const resizeStart = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            return () => h(PdfAnnotationSelectionHandles, {
                entity: image,
                onResizeStart: resizeStart,
            });
        }});
        app.mount(host);
        await nextTick();

        const handle = host.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]');
        expect(handle).not.toBeNull();
        handle!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
        }));

        expect(resizeStart).toHaveBeenCalledOnce();
        expect(resizeStart.mock.calls[0]?.[0]).toBe('se');
        app.unmount();
    });

    it.each([
        {
            fontSize: 72,
            resizeHandle: 'se',
        },
        {
            fontSize: 14,
            resizeHandle: 'se',
        },
        {
            fontSize: 14,
            resizeHandle: 'e',
        },
    ] as const)('commits $resizeHandle resize only when its validated proposal changes at font size $fontSize', async ({
        fontSize,
        resizeHandle,
    }) => {
        const harness = createCreationSurface();
        const textBox: ITextBoxEntity = {
            ...createdTextBox,
            fontSize,
            rect: {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
        };
        harness.activeToolValue.value = 'select';
        harness.entities.value = [textBox];
        harness.selectedIds.value = new Set([textBox.identity.id]);
        vi.mocked(harness.surface.beginResize).mockReturnValue({
            annotationId: textBox.identity.id,
            entity: textBox,
            kind: 'resize',
        });
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, harness.surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        onTestFinished(() => {app.unmount(); host.remove();});
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        const handle = host.querySelector<HTMLElement>(`[data-pdf-annotation-resize-handle="${resizeHandle}"]`)!;
        handle.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 42,
            clientX: 50,
            clientY: 37.5,
        }));
        layer.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            button: 0,
            pointerId: 42,
            clientX: 70,
            clientY: 50,
        }));
        layer.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            pointerId: 42,
            clientX: 70,
            clientY: 50,
        }));
        await nextTick();
        if (fontSize === 72) {
            expect(harness.commitGesture).not.toHaveBeenCalled();
        } else {
            expect(harness.commitGesture).toHaveBeenCalledOnce();
            expect(harness.commitGesture.mock.calls[0]?.[1]).toMatchObject({fontSize: expect.any(Number)});
            if (resizeHandle === 'e') {
                expect(harness.commitGesture.mock.calls[0]?.[1].fontSize).toBe(fontSize);
                expect(harness.commitGesture.mock.calls[0]?.[1].rect.width).toBeGreaterThan(textBox.rect.width);
            } else {
                expect(harness.commitGesture.mock.calls[0]?.[1].fontSize).toBeGreaterThan(fontSize);
            }
        }
    });

    it('shrinks the content-derived height after widening a wrapped text box', async () => {
        const host = document.createElement('div');
        host.className = 'pdf-annotation-editor-layer';
        document.body.append(host);
        vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 1000));
        const exposed = ref<{fitRectToContent: (rect: IAnnotationMarkerRect, handle?: 'e', fontSize?: number) => IAnnotationMarkerRect | null} | null>(null);
        const app = createApp({render: () => h(PdfTextBoxAnnotation, {
            ref: exposed,
            entity: {
                ...createdTextBox,
                text: 'text that wraps when narrowed',
            },
            selected: true,
        })});
        app.mount(host);
        onTestFinished(() => {app.unmount(); host.remove();});
        await nextTick();
        const measuredHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return Number.parseFloat(this.style.width) < 300 ? 180 : 60;
        });
        onTestFinished(() => measuredHeight.mockRestore());
        const narrow = exposed.value!.fitRectToContent({
            ...createdTextBox.rect,
            width: 0.2,
        }, 'e')!;
        expect(narrow.height).toBeCloseTo(0.18);
        const wide = exposed.value!.fitRectToContent({
            ...narrow,
            width: 0.4,
        }, 'e')!;
        expect(wide.height).toBeCloseTo(0.06);
        expect(wide.top + wide.height / 2).toBeCloseTo(narrow.top + narrow.height / 2);
        measuredHeight.mockReturnValue(2000);
        expect(exposed.value!.fitRectToContent(wide, undefined, 72)).toBeNull();
    });
});
