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
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import PdfAnnotationEditorLayer from '@app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    AnnotationEntity,
    INoteEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    annotationId,
    createApp,
    createCreationSurface,
    createdTextBox,
} from '@tests/unit/app/modules/pdf-viewer/components/pdfAnnotationEditorLayerEventFixtures';

describe('PdfAnnotationEditorLayer pointer capture and draft events', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    function entityRect(annotation: AnnotationEntity | undefined) {
        if (!annotation) {
            return undefined;
        }
        if (annotation.kind === 'note') {
            return annotation.position;
        }
        if (annotation.kind === 'text-markup') {
            return annotation.quadPoints[0];
        }
        return annotation.rect;
    }

    async function startCapturedGesture(
        kind: 'grip' | 'body' | 'resize' | 'create' | 'note' | 'shape-move' | 'shape-resize' | 'image-move' | 'image-resize' | 'markup' | 'draw',
        editing = false,
    ) {
        const creating = kind === 'create' || kind === 'draw';
        const resizing = kind === 'resize' || kind.endsWith('-resize');
        const entityKind = kind.startsWith('shape') || kind === 'draw' ? 'shape'
            : kind.startsWith('image') ? 'placed-image' : kind === 'markup' ? 'text-markup'
                : kind === 'note' ? 'note' : 'text-box';
        const application = shallowRef(new AnnotationApplication('capture-release'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => kind === 'create' ? 'text' : kind === 'draw' ? 'draw' : 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            getPageGeometry: () => ({
                pageView: [
                    0,
                    0,
                    500,
                    500,
                ],
                rotation: 0,
            }),
        }))!;
        if (!creating) {
            const initialRect = {
                left: 0.4,
                top: 0.3,
                width: 0.2,
                height: 0.1,
            };
            const entity = entityKind === 'note' ? surface.createNoteAt(0, initialRect)
                : entityKind === 'placed-image' ? surface.createStampAt(0, initialRect, {
                    objectNumber: 10,
                    generationNumber: 0,
                    byteLength: 4,
                    sha256: 'a'.repeat(64),
                })
                    : entityKind === 'text-markup' ? surface.createHighlightFromSelection(0, [initialRect])
                        : entityKind === 'shape' ? surface.createShape({
                            kind: 'shape',
                            identity: {id: annotationId},
                            pageIndex: requirePageIndex(0),
                            revision: 0,
                            persistedRevision: -1,
                            deleted: false,
                            createdAt: null,
                            modifiedAt: null,
                            author: null,
                            tool: 'rectangle',
                            rect: initialRect,
                            strokeColor: '#111827',
                            strokeWidth: 2,
                            fill: null,
                            opacity: 1,
                        }) : surface.createTextBoxAt(0, initialRect);
            if (entity.kind === 'text-box') surface.commitGesture(entity.identity.id, {text: 'Кириллический текст'});
            surface.select([entity.identity.id]);
            if (editing) surface.beginTextEditing(entity.identity.id);
        }
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
            return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
        }});
        app.mount(host);
        onTestFinished(() => {app.unmount(); scope.stop(); host.remove();});
        await nextTick();
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 1000));
        if (editing) {
            const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
            editor.textContent = 'Текст после правки';
            editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
            await nextTick();
        }
        const target = kind === 'grip' ? host.querySelector<HTMLElement>('[data-pdf-annotation-move-handle]')!
            : resizing ? host.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]')!
                : creating ? layer : host.querySelector(`[data-annotation-kind="${entityKind}"]`)!;
        const start = {
            x: resizing ? 600 : 500,
            y: resizing ? 400 : 300,
        };
        const end = {
            x: start.x + (creating || resizing ? 100 : -100),
            y: start.y + 50,
        };
        function pointer(type: string, point = end, overrides: PointerEventInit = {}) {
            return new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
                pointerId: 70,
                button: type === 'lostpointercapture' ? -1 : 0,
                buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
                clientX: point.x,
                clientY: point.y,
                ...overrides,
            });
        }
        function rect(selector = `[data-annotation-kind="${entityKind}"]`) {
            const box = host.querySelector<HTMLElement>(selector);
            if (!box) {
                return null;
            }
            if (entityKind === 'shape' || entityKind === 'text-markup') {
                if (kind === 'draw') {
                    const points = box.querySelector('polyline')!.getAttribute('points')!.split(' ').map(point => point.split(',').map(Number));
                    const xs = points.map(point => point[0]!);
                    const ys = points.map(point => point[1]!);
                    return {
                        left: Math.min(...xs),
                        top: Math.min(...ys),
                        width: Math.max(...xs) - Math.min(...xs),
                        height: Math.max(...ys) - Math.min(...ys),
                    };
                }
                const svgRect = box.querySelector('rect')!;
                return {
                    left: Number(svgRect.getAttribute('x')),
                    top: Number(svgRect.getAttribute('y')),
                    width: Number(svgRect.getAttribute('width')),
                    height: Number(svgRect.getAttribute('height')),
                };
            }
            const note = kind === 'note' ? surface.getEntitiesForPage(0)[0] as INoteEntity : null;
            return {
                left: parseFloat(box.style.left) / 100 - (note ? note.position.width / 2 : 0),
                top: parseFloat(box.style.top) / 100 - (note ? note.position.height / 2 : 0),
                width: note?.position.width ?? parseFloat(box.style.width) / 100,
                height: note?.position.height ?? parseFloat(box.style.height) / 100,
            };
        }
        target.dispatchEvent(pointer('pointerdown', start));
        await nextTick();
        const original = surface.getEntitiesForPage(0)[0];
        const originalRect = entityRect(original);
        const commitGesture = vi.spyOn(surface, 'commitGesture');
        layer.dispatchEvent(pointer('pointermove'));
        await nextTick();
        const preview = rect(kind === 'create' ? '.pdf-annotation-editor-text-box-preview' : undefined)!;
        expect(preview).not.toBeNull();
        if (original) expect(preview).not.toEqual(originalRect);
        async function finishAfterCaptureLoss() {
            layer.dispatchEvent(pointer('pointermove', end, {buttons: 0}));
            layer.dispatchEvent(pointer('pointerup'));
            layer.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                clientX: end.x,
                clientY: end.y,
            }));
            await nextTick();
            await nextTick();
        }
        return {
            surface,
            layer,
            pointer,
            rect,
            original,
            originalRect,
            preview,
            commitGesture,
            finishAfterCaptureLoss,
        };
    }

    it.each([
        'grip',
        'body',
        'resize',
        'create',
        'note',
        'shape-move',
        'shape-resize',
        'image-move',
        'image-resize',
        'markup',
        'draw',
    ] as const)('commits %s preview when released mouse loses capture before pointerup exactly once', async (kind) => {
        const gesture = await startCapturedGesture(kind, kind === 'grip');
        gesture.layer.dispatchEvent(gesture.pointer('lostpointercapture'));
        await nextTick();
        const completed = gesture.surface.getEntitiesForPage(0)[0]!;
        const completedRect = entityRect(completed);
        for (const key of [
            'left',
            'top',
            'width',
            'height',
        ] as const) {
            expect(completedRect?.[key]).toBeCloseTo(gesture.preview[key], 12);
        }
        const revision = completed.revision;
        if (kind !== 'create' && kind !== 'draw') expect(gesture.commitGesture).toHaveBeenCalledOnce();
        await gesture.finishAfterCaptureLoss();
        expect(gesture.surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(gesture.surface.getEntitiesForPage(0)[0]?.revision).toBe(revision);
        expect(gesture.rect()).toEqual(gesture.preview);
        if (kind !== 'create' && kind !== 'draw') expect(gesture.commitGesture).toHaveBeenCalledOnce();
        if (kind === 'grip' && completed.kind === 'text-box') expect(completed.text).toBe('Текст после правки');
    });

    it.each([
        'pointercancel',
        'held mouse',
        'pen',
        'touch',
        'Escape',
    ] as const)('rolls back the preview on %s instead of treating it as a released mouse', async (reason) => {
        const gesture = await startCapturedGesture('grip');
        if (reason === 'Escape') gesture.layer.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Escape',
        }));
        else gesture.layer.dispatchEvent(gesture.pointer(reason === 'pointercancel' ? reason : 'lostpointercapture', undefined, {
            buttons: reason === 'held mouse' ? 1 : 0,
            pointerType: reason === 'pen' || reason === 'touch' ? reason : 'mouse',
        }));
        await gesture.finishAfterCaptureLoss();
        expect(gesture.surface.getEntitiesForPage(0)[0]).toEqual(gesture.original);
        expect(gesture.rect()).toEqual(gesture.originalRect);
        expect(gesture.commitGesture).not.toHaveBeenCalled();
    });

    it('ignores another pointer losing capture and lets the active mouse finish once', async () => {
        const gesture = await startCapturedGesture('body');
        gesture.layer.dispatchEvent(gesture.pointer('lostpointercapture', undefined, {pointerId: 99}));
        await nextTick();
        expect(gesture.rect()).toEqual(gesture.preview);
        expect(gesture.surface.getEntitiesForPage(0)[0]).toEqual(gesture.original);
        await gesture.finishAfterCaptureLoss();
        expect((gesture.surface.getEntitiesForPage(0)[0] as ITextBoxEntity).rect).toEqual(gesture.preview);
        expect(gesture.commitGesture).toHaveBeenCalledOnce();
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
        expect(host.querySelector('.pdf-annotation-selection-handles')).not.toBeNull();
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
        expect(harness.setTextBoxDraftPending).toHaveBeenCalledWith(createdTextBox.identity.id, 'draft through save hook');
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
        expect(host.querySelector('.pdf-annotation-selection-handles')).not.toBeNull();
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
