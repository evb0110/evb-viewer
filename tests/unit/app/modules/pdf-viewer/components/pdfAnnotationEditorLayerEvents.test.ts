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
    createApp,
    defineComponent,
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
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {TAnnotationTool} from '@app/types/annotations';
import {requirePageIndex} from '@contracts/pageNumbers';

const annotationId = 'reopened-markup' as ITextMarkupEntity['identity']['id'];

const entity: ITextMarkupEntity = {
    kind: 'text-markup',
    identity: {id: annotationId},
    pageIndex: requirePageIndex(25),
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

const createdTextBox: ITextBoxEntity = {
    kind: 'text-box',
    identity: {id: 'created-text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: requirePageIndex(25),
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    text: '',
    rect: {
        left: 0.2,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    },
    rotation: 0,
    fontSize: 14,
    color: '#111827',
};

function createInteractionMethods(
    select: IAnnotationEditorSurface['select'],
    register?: IAnnotationEditorSurface['registerTextBoxDraftCommitter'],
) {
    const scope = effectScope();
    const defaults = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication: shallowRef(new AnnotationApplication('component-event-fixture')),
        activeTool: computed(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
    }))!;
    onTestFinished(() => scope.stop());
    const editingId = ref<ITextBoxEntity['identity']['id'] | null>(null);
    const textEditPoint = ref<{
        clientX: number;
        clientY: number
    } | null>(null);
    const selectionMoveDelta = ref<{
        x: number;
        y: number
    } | null>(null);
    return {
        ...defaults,
        selectionMoveDelta,
        setSelectionMoveDelta: (delta: {
            x: number;
            y: number
        } | null) => {selectionMoveDelta.value = delta;},
        editingId,
        textEditPoint,
        registerPageInteraction: vi.fn((_page: number, callbacks: {commitTextDraft: () => void}) => register?.(callbacks.commitTextDraft) ?? (() => {})),
        beginTextEditing: vi.fn((id: ITextBoxEntity['identity']['id'], point?: {
            clientX: number;
            clientY: number
        }) => {select([id]); editingId.value = id; textEditPoint.value = point ?? null;}),
        endTextEditing: vi.fn(() => {editingId.value = null;}),
        beginPointerInteraction: vi.fn(),
        endPointerInteraction: vi.fn(),
        cancelActiveInteraction: vi.fn(() => false),
        prepareToolChange: vi.fn(),
        completeCreation: vi.fn(),
    };
}

function createCreationSurface() {
    const activeToolValue = ref<TAnnotationTool>('text');
    const activeTool = computed(() => activeToolValue.value);
    const entities = ref<readonly ITextBoxEntity[]>([]);
    const selectedIds = ref<ReadonlySet<ITextBoxEntity['identity']['id']>>(new Set());
    const select = vi.fn((ids: ReadonlyArray<ITextBoxEntity['identity']['id']>) => {
        selectedIds.value = new Set(ids);
    });
    const clearSelection = vi.fn(() => {
        selectedIds.value = new Set();
    });
    const commitGesture = vi.fn();
    const draftCommitters = new Set<() => void>();
    const registerTextBoxDraftCommitter = vi.fn((committer: () => void) => {
        draftCommitters.add(committer);
        return () => draftCommitters.delete(committer);
    });
    const commitPendingTextBoxDraftsForSave = vi.fn(() => {
        [...draftCommitters].forEach(committer => committer());
    });
    const pendingDraftIds = new Set<ITextBoxEntity['identity']['id']>();
    const setTextBoxDraftPending = vi.fn((id: ITextBoxEntity['identity']['id']) => {
        pendingDraftIds.add(id);
    });
    const clearTextBoxDraftPending = vi.fn((id: ITextBoxEntity['identity']['id']) => {
        pendingDraftIds.delete(id);
    });
    const hasPendingTextBoxDrafts = vi.fn(() => pendingDraftIds.size > 0);
    const createTextBoxAt = vi.fn(() => {
        entities.value = [createdTextBox];
        return createdTextBox;
    });
    const surface: IAnnotationEditorSurface = {
        ...createInteractionMethods(select, registerTextBoxDraftCommitter),
        activeTool,
        entitiesByPage: computed(() => new Map([[
            25,
            entities.value,
        ]])),
        selectedIds,
        settings: computed(() => null),
        getEntitiesForPage: (pageIndex: number) => pageIndex === 25 ? entities.value : [],
        select,
        clearSelection,
        getSelectedTextBox: vi.fn(() => selectedIds.value.has(createdTextBox.identity.id)
            ? createdTextBox
            : null),
        registerTextBoxDraftCommitter,
        commitPendingTextBoxDraftsForSave,
        setTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasPendingTextBoxDrafts,
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
        beginMove: vi.fn(() => null),
        beginResize: vi.fn(() => null),
        commitGesture,
        createTextBoxAt,
        createNoteAt: vi.fn(),
        createStampAt: vi.fn(),
        createHighlightFromSelection: vi.fn(),
        createShape: vi.fn(),
        openNote: vi.fn(),
        openShapeContextMenu: vi.fn(),
    };
    return {
        surface,
        activeToolValue,
        entities,
        selectedIds,
        select,
        clearSelection,
        createTextBoxAt,
        commitGesture,
        commitPendingTextBoxDraftsForSave,
        setTextBoxDraftPending,
        clearTextBoxDraftPending,
        hasPendingTextBoxDrafts,
        registerTextBoxDraftCommitter,
    };
}

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
        ...createInteractionMethods(select),
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
        registerTextBoxDraftCommitter: vi.fn(() => vi.fn()),
        commitPendingTextBoxDraftsForSave: vi.fn(),
        setTextBoxDraftPending: vi.fn(),
        clearTextBoxDraftPending: vi.fn(),
        hasPendingTextBoxDrafts: vi.fn(() => false),
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

    it('keeps a newly created text box selected after a root-retargeted click', async () => {
        const harness = createCreationSurface();
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, harness.surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        await nextTick();

        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const background = host.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background');
        expect(layer).not.toBeNull();
        expect(background).not.toBeNull();
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

        background!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 21,
        }));
        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 21,
        }));
        background!.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            clientX: 20,
            clientY: 20,
        }));
        await nextTick();

        expect(harness.createTextBoxAt).toHaveBeenCalledOnce();
        expect(harness.select).toHaveBeenCalledWith([createdTextBox.identity.id]);
        expect(harness.clearSelection).not.toHaveBeenCalled();
        expect(harness.selectedIds.value).toEqual(new Set([createdTextBox.identity.id]));
    });

    it.each([
        [
            'text',
            'text-box',
        ],
        [
            'note',
            'text-box',
        ],
        [
            'rectangle',
            'text-box',
        ],
        [
            'text',
            'note',
        ],
        [
            'note',
            'note',
        ],
        [
            'rectangle',
            'note',
        ],
    ] as const)('creates with armed %s over an existing %s', async (armedTool, targetKind) => {
        const application = shallowRef(new AnnotationApplication('overlapping-placement'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => armedTool),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            getPageGeometry: () => ({
                pageView: [
                    0,
                    0,
                    100,
                    100,
                ],
                rotation: 0,
            }),
        }))!;
        const existing = targetKind === 'text-box'
            ? surface.createTextBoxAt(0, {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            })
            : surface.createNoteAt(0, {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            });
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.component('UIcon', {render: () => h('span')});
        app.component('AppTooltip', defineComponent({
            inheritAttrs: false,
            setup: (_props, {slots}) => () => slots.default?.(),
        }));
        app.mount(host);
        onTestFinished(() => {app.unmount(); scope.stop(); host.remove();});
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        const target = host.querySelector<HTMLElement>(`[data-annotation-kind="${targetKind}"]`)!;
        target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 25,
            clientY: 25,
            pointerId: 41,
        }));
        layer.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 35,
            clientY: 35,
            pointerId: 41,
        }));
        await nextTick();
        expect(surface.getEntitiesForPage(0)).toHaveLength(2);
        const created = surface.getEntitiesForPage(0).find(candidate => candidate.identity.id !== existing.identity.id);
        expect(created?.kind).toBe(armedTool === 'text' ? 'text-box' : armedTool === 'note' ? 'note' : 'shape');
    });

    it('consumes a stationary placement click after focus without hit-testing the new empty draft', async () => {
        const application = shallowRef(new AnnotationApplication('placement-click'));
        const tool = ref<TAnnotationTool>('text');
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => tool.value),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            getPageGeometry: () => ({
                pageView: [
                    0,
                    0,
                    100,
                    100,
                ],
                rotation: 0,
            }),
        }))!;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.mount(host);
        onTestFinished(() => {app.unmount(); scope.stop(); host.remove();});
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        layer.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 30,
        }));
        layer.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 30,
        }));
        await nextTick();
        await nextTick();
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        expect(document.activeElement).toBe(editor);
        expect(surface.getEntitiesForPage(0)).toHaveLength(1);
        // Chromium retargets the click to the capture owner after the editor
        // has focused. Its rounded coordinate can precede the new rect edge.
        await new Promise(resolve => setTimeout(resolve, 1));
        layer.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            detail: 1,
            clientX: 20,
            clientY: 20,
        }));
        await nextTick();
        expect(surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(surface.editingId.value).not.toBeNull();
        expect(document.activeElement).toBe(editor);
        const editingId = surface.editingId.value;
        editor.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 30,
            clientY: 25,
            pointerId: 32,
        }));
        layer.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 30,
            clientY: 25,
            pointerId: 32,
        }));
        await nextTick();
        await nextTick();
        expect(surface.editingId.value).toBe(editingId);
        expect(document.activeElement).toBe(editor);
        tool.value = 'select';
        layer.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 90,
            clientY: 90,
            pointerId: 31,
        }));
        layer.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            detail: 1,
            clientX: 90,
            clientY: 90,
        }));
        await nextTick();
        expect(surface.getEntitiesForPage(0)).toHaveLength(0);
    });

    it('commits an existing inline text draft with measured height and its manual width through the viewer save hook', async () => {
        const harness = createCreationSurface();
        harness.activeToolValue.value = 'select';
        harness.entities.value = [createdTextBox];
        harness.selectedIds.value = new Set([createdTextBox.identity.id]);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, harness.surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        await nextTick();

        const textBox = host.querySelector<HTMLElement>('[data-annotation-id="created-text-box"]');
        expect(textBox).not.toBeNull();
        expect(host.querySelector('.pdf-annotation-selection-handles')).not.toBeNull();
        textBox!.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            detail: 2,
            clientX: 25,
            clientY: 25,
        }));
        await nextTick();

        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(editor).not.toBeNull();
        expect(host.querySelector('.pdf-annotation-selection-handles')).toBeNull();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        vi.spyOn(layer!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        Object.defineProperties(editor!, {
            scrollWidth: {
                configurable: true,
                value: 90,
            },
            scrollHeight: {
                configurable: true,
                value: 40,
            },
        });
        editor!.textContent = 'draft through save hook';
        editor!.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: 'draft through save hook',
        }));
        expect(harness.setTextBoxDraftPending).toHaveBeenCalledWith(createdTextBox.identity.id);
        expect(harness.hasPendingTextBoxDrafts()).toBe(true);
        expect(harness.registerTextBoxDraftCommitter).toHaveBeenCalledOnce();

        harness.commitPendingTextBoxDraftsForSave();

        expect(harness.commitGesture).toHaveBeenCalledWith(
            createdTextBox.identity.id,
            {
                text: 'draft through save hook',
                rect: {
                    ...createdTextBox.rect,
                    height: 0.4,
                },
            },
        );
        expect(harness.clearTextBoxDraftPending).toHaveBeenCalledWith(createdTextBox.identity.id);
        expect(harness.hasPendingTextBoxDrafts()).toBe(false);
    });

    it('grows a click-created text box without moving its insertion edge', async () => {
        const harness = createCreationSurface();
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, harness.surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(25)});
        }});
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        await nextTick();

        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const background = host.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background');
        expect(layer).not.toBeNull();
        expect(background).not.toBeNull();
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

        background!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 22,
        }));
        layer!.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 22,
        }));
        await nextTick();

        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]');
        expect(editor).not.toBeNull();
        expect(host.querySelector('.pdf-annotation-selection-handles')).toBeNull();
        Object.defineProperty(editor!, 'scrollWidth', {
            configurable: true,
            value: 90,
        });
        Object.defineProperty(editor!, 'scrollHeight', {
            configurable: true,
            value: 40,
        });
        editor!.textContent = 'a long click-created draft';
        editor!.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: 'a long click-created draft',
        }));
        harness.commitPendingTextBoxDraftsForSave();

        expect(harness.commitGesture).toHaveBeenCalledWith(
            createdTextBox.identity.id,
            expect.objectContaining({
                text: 'a long click-created draft',
                rect: expect.objectContaining({
                    left: 0.2,
                    width: 0.8,
                }),
            }),
        );
        const patch = harness.commitGesture.mock.calls.at(-1)?.[1] as {rect?: {height?: number}} | undefined;
        expect(patch?.rect?.height).toBeGreaterThan(0.1);
    });
});
