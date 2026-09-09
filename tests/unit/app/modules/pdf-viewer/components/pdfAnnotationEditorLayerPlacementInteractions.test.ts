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
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {ITextBoxEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { rotateAnnotationPoint } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    createApp,
    createCreationSurface,
    createdTextBox,
} from '@tests/unit/app/modules/pdf-viewer/components/pdfAnnotationEditorLayerEventFixtures';

describe('PdfAnnotationEditorLayer placement interactions', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('offers text corner scaling and horizontal wrapping handles only', async () => {
        const host = document.createElement('div');
        const app = createApp({render: () => h(PdfAnnotationSelectionHandles, {entity: createdTextBox})});
        app.mount(host);
        onTestFinished(() => app.unmount());
        await nextTick();
        expect([...host.querySelectorAll('[data-pdf-annotation-resize-handle]')]
            .map(handle => handle.getAttribute('data-pdf-annotation-resize-handle'))).toEqual([
            'nw',
            'ne',
            'e',
            'se',
            'sw',
            'w',
        ]);
    });

    it.each([
        {
            name: 'near-vertical',
            start: [
                20,
                20,
            ],
            moves: [[
                22,
                85,
            ]],
        },
        {
            name: 'reverse',
            start: [
                60,
                40,
            ],
            moves: [[
                10,
                80,
            ]],
        },
        {
            name: 'short reverse',
            start: [
                60,
                40,
            ],
            moves: [[
                58,
                90,
            ]],
        },
        {
            name: 'away and back',
            start: [
                20,
                20,
            ],
            moves: [
                [
                    80,
                    70,
                ],
                [
                    20,
                    20,
                ],
            ],
        },
    ].flatMap(scenario => ([
        0,
        90,
        180,
        270,
    ] as const).map(viewRotation => ({
        ...scenario,
        viewRotation,
    }))))('creates a one-line wrapping frame for $name drags at $viewRotation degrees', async ({
        start,
        moves,
        viewRotation,
    }) => {
        const harness = createCreationSurface();
        vi.mocked(harness.surface.getPageGeometry).mockReturnValue({
            pageView: [
                0,
                0,
                100,
                100,
            ],
            rotation: 0,
            viewRotation,
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
        const background = host.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        function pointer(type: string, point: number[]) {
            return new PointerEvent(type, {
                bubbles: true,
                button: 0,
                clientX: point[0]!,
                clientY: point[1]!,
                pointerId: 21,
            });
        }
        function previewRect() {
            const preview = host.querySelector<HTMLElement>('.pdf-annotation-editor-text-box-preview')!;
            return {
                left: Number.parseFloat(preview.style.left) / 100,
                top: Number.parseFloat(preview.style.top) / 100,
                width: Number.parseFloat(preview.style.width) / 100,
                height: Number.parseFloat(preview.style.height) / 100,
            };
        }
        background.dispatchEvent(pointer('pointerdown', start));
        await nextTick();
        function displayedRect(rect: IAnnotationMarkerRect) {
            const center = rotateAnnotationPoint({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }, viewRotation);
            return {
                ...rect,
                left: center.x - rect.width / 2,
                top: center.y - rect.height / 2,
            };
        }
        const initial = displayedRect(previewRect());
        for (const move of moves) layer.dispatchEvent(pointer('pointermove', move));
        await nextTick();
        const canonicalPreview = previewRect();
        const preview = displayedRect(canonicalPreview);
        expect(preview.width).toBeGreaterThanOrEqual(initial.width);
        expect(preview.height).toBeCloseTo(initial.height);
        expect(preview.top).toBeCloseTo(initial.top);
        const end = moves.at(-1)!;
        expect(preview.left).toBeCloseTo(end[0]! < start[0]! ? start[0]! / 100 - preview.width : initial.left);
        layer.dispatchEvent(pointer('pointerup', end));
        await nextTick();
        const committed = harness.createTextBoxAt.mock.calls[0]?.[1];
        for (const key of [
            'left',
            'top',
            'width',
            'height',
        ] as const) {
            expect(committed?.[key]).toBeCloseTo(canonicalPreview[key], 12);
        }
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
        await nextTick();
        const preview = host.querySelector<HTMLElement>('.pdf-annotation-editor-text-box-preview');
        expect(preview).not.toBeNull();
        const previewRect = {
            left: Number.parseFloat(preview!.style.left) / 100,
            top: Number.parseFloat(preview!.style.top) / 100,
            width: Number.parseFloat(preview!.style.width) / 100,
            height: Number.parseFloat(preview!.style.height) / 100,
        };
        expect(previewRect.width).toBeGreaterThan(0.1);
        expect(previewRect.height).toBeGreaterThan(0.1);
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
        const committed = harness.createTextBoxAt.mock.calls[0]?.[1];
        for (const key of [
            'left',
            'top',
            'width',
            'height',
        ] as const) {
            expect(committed?.[key], key).toBeCloseTo(previewRect[key], 12);
        }
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
    ] as const)('moves with armed %s over an existing %s without creating', async (armedTool, targetKind) => {
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
        expect(surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(surface.selectedIds.value).toEqual(new Set([existing.identity.id]));
        const moved = surface.getEntitiesForPage(0)[0]!;
        const rect = moved.kind === 'text-box' ? moved.rect : moved.kind === 'note' ? moved.position : null;
        expect(rect?.left).toBeCloseTo(0.3);
        expect(rect?.top).toBeCloseTo(0.3);
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

    it.each(([
        'move',
        'resize',
    ] as const).flatMap(gesture =>
        ([
            'type',
            'save',
            'blur',
            'escape',
        ] as const).map(completion => ({
            gesture,
            completion,
        })),
    ))('keeps a fresh empty draft editable through $gesture before $completion', async ({
        gesture,
        completion,
    }) => {
        const application = shallowRef(new AnnotationApplication('empty-geometry'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => 'text' as const),
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
        function pointer(type: string, x: number, y: number) {
            return new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: x,
                clientY: y,
                pointerId: 60,
            });
        }
        layer.dispatchEvent(pointer('pointerdown', 20, 20));
        layer.dispatchEvent(pointer('pointerup', 20, 20));
        await nextTick();
        await nextTick();
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        const id = surface.editingId.value;
        expect(id).not.toBeNull();
        const initial = surface.getEntitiesForPage(0)[0] as ITextBoxEntity;
        const control = host.querySelector<HTMLElement>(gesture === 'resize' ? '[data-pdf-annotation-resize-handle="e"]' : '[data-pdf-annotation-move-handle]')!;
        expect(control).not.toBeNull();
        const startX = gesture === 'resize' ? (initial.rect.left + initial.rect.width) * 100 : 40;
        const endX = startX + 20;
        control.dispatchEvent(pointer('pointerdown', startX, 30));
        layer.dispatchEvent(pointer('pointermove', endX, 40));
        await nextTick();
        expect(surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(surface.editingId.value).toBe(id);
        expect(document.activeElement).toBe(editor);
        const textBox = host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!;
        const preview = {
            left: textBox.style.left,
            top: textBox.style.top,
            width: textBox.style.width,
        };
        layer.dispatchEvent(pointer('pointerup', endX, 40));
        await nextTick();
        await nextTick();
        expect(surface.editingId.value).toBe(id);
        expect(document.activeElement).toBe(editor);
        const entity = surface.getEntitiesForPage(0)[0] as ITextBoxEntity;
        expect(gesture === 'move' ? entity.rect.left : entity.rect.width)
            .toBeGreaterThan(gesture === 'move' ? initial.rect.left : initial.rect.width);
        expect({
            left: textBox.style.left,
            top: textBox.style.top,
            width: textBox.style.width,
        }).toEqual(preview);
        if (completion !== 'type') {
            if (completion === 'save') surface.commitPendingTextBoxDraftsForSave();
            else if (completion === 'blur') layer.focus();
            else editor.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                key: 'Escape',
            }));
            await nextTick();
            expect(surface.getEntitiesForPage(0)).toHaveLength(0);
            expect(surface.hasPendingTextBoxDrafts()).toBe(false);
            expect(surface.editingId.value).toBeNull();
            expect(application.value.store.dirtyEntities()).toHaveLength(0);
            expect(surface.undo()).toBe(false);
            return;
        }
        Object.defineProperties(editor, {
            scrollWidth: {
                configurable: true,
                value: 95,
            },
            scrollHeight: {
                configurable: true,
                value: 15,
            },
        });
        editor.textContent = 'typed after gesture';
        editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        surface.commitPendingTextBoxDraftsForSave();
        await nextTick();
        const committed = surface.getEntitiesForPage(0)[0] as ITextBoxEntity;
        expect(committed.text).toBe('typed after gesture');
        expect(committed.rect.left).toBeCloseTo(entity.rect.left);
        expect(committed.rect.top).toBeCloseTo(entity.rect.top);
        if (gesture === 'resize') expect(committed.rect.width).toBeCloseTo(entity.rect.width);
        expect(surface.hasPendingTextBoxDrafts()).toBe(false);
        expect(surface.editingId.value).toBeNull();
    });
});
