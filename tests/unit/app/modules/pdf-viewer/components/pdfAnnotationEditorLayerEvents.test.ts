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

    it('commits the final composition when Chromium sends no ordinary input afterwards', async () => {
        const annotationApplication = shallowRef(new AnnotationApplication('composition-end'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication,
            activeTool: computed(() => 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        }))!;
        const box = surface.createTextBoxAt(0, createdTextBox.rect, {text: 'Original'});
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.mount(host);
        onTestFinished(() => {surface.endTextEditing(box.identity.id, {cancelled: true}); app.unmount(); scope.stop();});
        await nextTick();
        await surface.beginTextEditing(box.identity.id);
        await nextTick();
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
        editor.textContent = 'café';
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            isComposing: true,
        }));
        expect(surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'Original'});
        editor.dispatchEvent(new CompositionEvent('compositionend', {
            bubbles: true,
            data: 'café',
        }));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            ctrlKey: true,
        }));
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'café'});
        expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    });

    it('places the next text box when its pointer gesture arrives during accepted completion', async () => {
        const annotationApplication = shallowRef(new AnnotationApplication('pending-placement'));
        const scope = effectScope();
        const publication = Promise.withResolvers<undefined>();
        const draft = ref<string | null>(null);
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication,
            activeTool: computed(() => 'text'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            getPageGeometry: () => ({
                pageView: [
                    0,
                    0,
                    600,
                    800,
                ],
                rotation: 0,
            }),
            getTextBoxDraftText: () => draft.value,
            onTextBoxDraftChanged: (_id, text) => {draft.value = text;},
            publishTextBoxAppearance: async (_entity, accept) => {await publication.promise; accept();},
        }))!;
        const first = surface.createTextBoxAt(0, createdTextBox.rect);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.mount(host);
        onTestFinished(() => {surface.endTextEditing(surface.editingId.value ?? first.identity.id, {cancelled: true}); app.unmount(); scope.stop();});
        await nextTick();
        await surface.beginTextEditing(first.identity.id);
        await nextTick();
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        editor.textContent = 'Accepted first';
        editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            ctrlKey: true,
        }));
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 800));
        for (const type of [
            'pointerdown',
            'pointerup',
        ]) layer.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 17,
            button: 0,
            clientX: 300,
            clientY: 400,
        }));
        layer.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        expect(surface.getEntitiesForPage(0)).toHaveLength(1);
        publication.resolve(undefined);
        await vi.waitFor(() => expect(surface.getEntitiesForPage(0)).toHaveLength(2));
        expect(surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'Accepted first'});
        const nextEditor = host.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(nextEditor).not.toBeNull();
        expect(document.activeElement).toBe(nextEditor);
        expect(nextEditor?.closest('[data-annotation-id]')?.getAttribute('data-annotation-id')).not.toBe(first.identity.id);
    });

    it.each([
        {
            failure: new DOMException('Source replaced', 'AbortError'),
            newerInput: false,
        },
        {
            failure: new Error('Native appearance unavailable'),
            newerInput: false,
        },
        {
            failure: new Error('Native appearance unavailable'),
            newerInput: true,
        },
    ])('retains visible draft when cancellation painting fails with newer input=$newerInput', async ({
        failure, newerInput,
    }) => {
        const annotationApplication = shallowRef(new AnnotationApplication('cancel-failure'));
        const scope = effectScope();
        const publication = Promise.withResolvers<undefined>();
        const draftText = ref<string | null>(null);
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication,
            activeTool: computed(() => 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            publishTextBoxAppearance: () => publication.promise,
            getTextBoxDraftText: () => draftText.value,
            onTextBoxDraftChanged: (_id, text) => {draftText.value = text;},
        }))!;
        const box = surface.createTextBoxAt(0, createdTextBox.rect, {text: 'Original'});
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.mount(host);
        onTestFinished(() => {surface.endTextEditing(box.identity.id, {cancelled: true}); app.unmount(); scope.stop();});
        await nextTick();
        await surface.beginTextEditing(box.identity.id);
        await nextTick();
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        editor.textContent = 'Unaccepted draft';
        editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        expect(surface.cancelActiveInteraction()).toBe(true);
        if (newerInput) {
            editor.textContent = 'Newer input';
            editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        }
        publication.reject(failure);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(surface.editingId.value).toBe(box.identity.id);
        expect(annotationApplication.value.store.get(box.identity.id)?.kind).toBe('text-box');
        expect(surface.getEntitiesForPage(0)[0]).toMatchObject({text: 'Original'});
        expect(host.querySelector('[contenteditable="true"]')).toBe(editor);
        expect(editor.textContent).toBe(newerInput ? 'Newer input' : 'Unaccepted draft');
        expect(host.querySelector<HTMLElement>('.pdf-annotation-editor-text-box')!.style.color).not.toBe('transparent');
        expect(surface.getTextBoxDraftText(box.identity.id)).toBe(editor.textContent);
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
        surface.select([annotationId]);
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
            draftScale: 1,
            resizeHandle: 'se',
        },
        {
            fontSize: 14,
            draftScale: 1,
            resizeHandle: 'se',
        },
        {
            fontSize: 14,
            draftScale: 1,
            resizeHandle: 'e',
        },
        {
            fontSize: 14,
            draftScale: 1.5,
            resizeHandle: 'se',
        },
    ] as const)('keeps $resizeHandle preview and commit consistent at font $fontSize and draft scale $draftScale', async ({
        fontSize,
        resizeHandle,
        draftScale,
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
            entity: {
                ...textBox,
                rect: {
                    ...textBox.rect,
                    width: textBox.rect.width * draftScale,
                    height: textBox.rect.height * draftScale,
                },
            },
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
        await nextTick();
        const preview = host.querySelector<HTMLElement>('.pdf-annotation-editor-text-box')!;
        const previewFont = Number(preview.style.fontSize.match(/\* ([\d.]+)px/)?.[1]);
        const previewWidth = Number.parseFloat(preview.style.width);
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
            expect(previewFont).toBeCloseTo(harness.commitGesture.mock.calls[0]![1].fontSize!, 5);
            expect(previewWidth).toBeCloseTo(harness.commitGesture.mock.calls[0]![1].rect!.width * 100, 5);
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
