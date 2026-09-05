// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
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
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import {
    annotationEditorSurfaceKey,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IPlacedImageEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {TAnnotationTool} from '@app/types/annotations';

const annotationId = 'reopened-markup' as ITextMarkupEntity['identity']['id'];

const entity: ITextMarkupEntity = {
    kind: 'text-markup',
    identity: {id: annotationId},
    pageIndex: 25,
    revision: 2,
    persistedRevision: 2,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    subtype: 'Highlight',
    contents: '',
    quadPoints: [{
        left: 0.2,
        top: 0.2,
        width: 0.3,
        height: 0.05,
    }],
    color: '#facc15',
    opacity: 0.5,
};

function createSurface() {
    const selectedIds = ref<ReadonlySet<ITextMarkupEntity['identity']['id']>>(new Set());
    const activeTool = computed(() => 'select' as const);
    const select = vi.fn((ids: ReadonlyArray<ITextMarkupEntity['identity']['id']>) => {
        selectedIds.value = new Set(ids);
    });
    const gesture = {
        annotationId,
        entity,
        kind: 'move' as const,
    };
    const commitGesture = vi.fn(() => entity);
    const surface: IAnnotationEditorSurface = {
        activeTool,
        entitiesByPage: ref(new Map([[
            25,
            [entity],
        ]])),
        selectedIds,
        settings: computed(() => null),
        getEntitiesForPage: (pageIndex: number) => pageIndex === 25 ? [entity] : [],
        select,
        clearSelection: vi.fn(() => { selectedIds.value = new Set(); }),
        getSelectedTextBox: vi.fn(() => null),
        updateSelectedTextBoxProperties: vi.fn(() => true),
        discardUnsavedAnnotation: vi.fn(() => true),
        deleteAnnotation: vi.fn(() => true),
        deleteSelection: vi.fn(),
        moveSelection: vi.fn(),
        nudgeSelection: vi.fn(),
        nudgeSelectionByPdfPoints: vi.fn(),
        undo: vi.fn(() => true),
        redo: vi.fn(() => true),
        getPageGeometry: vi.fn(() => ({
            pageView: [
                0,
                0,
                100,
                100,
            ],
            rotation: 0 as const,
        })),
        beginMove: vi.fn(() => gesture),
        beginResize: vi.fn(() => null),
        commitGesture,
        cancelGesture: vi.fn(),
        createTextBoxAt: vi.fn(),
        createNoteAt: vi.fn(),
        createStampAt: vi.fn(),
        createHighlightFromSelection: vi.fn(),
        createShape: vi.fn(),
        openNote: vi.fn(),
        openShapeContextMenu: vi.fn(),
    };
    return {
        surface,
        selectedIds,
        select,
        commitGesture,
    };
}

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
            return () => h(PdfAnnotationEditorLayer, {pageIndex: 25});
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
            return () => h(PdfAnnotationEditorLayer, {pageIndex: 25});
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
            pageIndex: 25,
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
});
