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
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireDocumentRef} from '@contracts/documentRef';
import {createPdfDocumentAnnotations} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import type {IAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import {
    annotationId,
    createApp,
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
        if (kind === 'grip') await vi.waitFor(() => expect(entityRect(gesture.surface.getEntitiesForPage(0)[0])?.left).toBeCloseTo(gesture.preview.left, 12));
        else await nextTick();
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
        if (kind !== 'create' && kind !== 'draw' && kind !== 'grip') expect(gesture.commitGesture).toHaveBeenCalledOnce();
        await gesture.finishAfterCaptureLoss();
        expect(gesture.surface.getEntitiesForPage(0)).toHaveLength(1);
        expect(gesture.surface.getEntitiesForPage(0)[0]?.revision).toBe(revision);
        expect(gesture.rect()).toEqual(gesture.preview);
        if (kind !== 'create' && kind !== 'draw' && kind !== 'grip') expect(gesture.commitGesture).toHaveBeenCalledOnce();
        if (kind === 'grip' && completed.kind === 'text-box') {
            expect(completed.text).toBe('Текст после правки');
            await gesture.surface.undo();
            const undone = gesture.surface.getEntitiesForPage(0)[0]!;
            expect(entityRect(undone)).toEqual(gesture.originalRect);
            expect(undone.kind === 'text-box' ? undone.text : null).toBe('Текст после правки');
            await gesture.surface.redo();
            expect(entityRect(gesture.surface.getEntitiesForPage(0)[0])).toEqual(gesture.preview);
        }
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
        const application = shallowRef(new AnnotationApplication('save-hook-text'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => 'select'),
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
        onTestFinished(() => scope.stop());
        application.value.store.createTextBox(createdTextBox);
        surface.select([createdTextBox.identity.id]);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
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
        await nextTick();
        expect(textBox!.style.height).toBe('40%');
        Object.defineProperty(editor!, 'scrollHeight', {
            configurable: true,
            value: 20,
        });
        editor!.textContent = 'short';
        editor!.dispatchEvent(new InputEvent('input', {bubbles: true}));
        await nextTick();
        expect(textBox!.style.height).toBe('20%');
        Object.defineProperty(editor!, 'scrollHeight', {
            configurable: true,
            value: 40,
        });
        editor!.textContent = 'draft through save hook';
        editor!.dispatchEvent(new InputEvent('input', {bubbles: true}));
        expect(surface.hasTextBoxDraftPending(createdTextBox.identity.id)).toBe(true);
        await surface.commitPendingTextBoxDraftsForSave();
        await nextTick();
        expect(textBox!.textContent).toBe('draft through save hook');
        expect(textBox!.style.height).toBe('40%');
        expect(textBox!.style.width).toBe('30%');
        expect(host.querySelector('[contenteditable="true"]')).toBeNull();
        expect(surface.hasTextBoxDraftPending(createdTextBox.identity.id)).toBe(false);
    });

    it.each([
        false,
        true,
    ])('restores both text drafts as savable geometry without editor handoffs, persisted=%s', async (persisted) => {
        const application = shallowRef(new AnnotationApplication('recovered-text-drafts'));
        const boxes: ITextBoxEntity[] = [
            'X',
            'Y',
        ].map((label, index) => ({
            ...createdTextBox,
            identity: {id: asAnnotationId(`recovered-${label}`)},
            pageIndex: requirePageIndex(0),
            revision: 3,
            persistedRevision: persisted ? 3 : -1,
            text: `Previous ${label}`,
            rect: {
                ...createdTextBox.rect,
                top: 0.2 + index * 0.3,
            },
        }));
        application.value.store.replaceFromDocument(boxes, []);
        const texts = [
            'Recovered accepted X',
            'Recovered accepted Y',
        ];
        const drafts = new Map(boxes.map((box, index) => [
            box.identity.id,
            texts[index]!,
        ]));
        const rectangles = boxes.map(box => ({
            ...box.rect,
            width: 0.5,
            height: 0.2,
        }));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            getTextBoxDraftText: id => drafts.get(id) ?? null,
            onTextBoxDraftChanged: (id, text) => {
                if (text === null) drafts.delete(id);
                else drafts.set(id, text);
            },
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
        boxes.forEach((box, index) => surface.restoreTextBoxDraftPending(box.identity.id, rectangles[index]));
        await nextTick();
        await nextTick();
        boxes.forEach((box, index) => {
            const node = host.querySelector<HTMLElement>(`[data-annotation-id="${box.identity.id}"]`)!;
            expect(node.textContent).toBe(texts[index]);
            expect(node.style.width).toBe('50%');
            expect(node.style.height).toBe('20%');
        });
        expect(host.querySelector('[contenteditable="true"]')).toBeNull();
        expect(application.value.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(application.value.store.canUndo).toBe(false);
        await surface.commitPendingTextBoxDraftsForSave();
        expect(application.value.beginSave().plan.expected).toEqual(boxes.map((box, index) => expect.objectContaining({
            identity: box.identity,
            text: texts[index],
            rect: rectangles[index],
        })));
    });

    it.each([
        'write rejection',
        'newer typing',
    ] as const)('retains editable text and geometry while protection faces %s', async (reason) => {
        const application = shallowRef(new AnnotationApplication('protected-text'));
        const scope = effectScope();
        let protection = Promise.withResolvers<undefined>();
        const drafts = new Map<string, string>();
        const generations = new Map<string, number>();
        const draftRectangles = new Map<string, ITextBoxEntity['rect']>();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => 'text'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            onTextBoxDraftChanged: (id, text) => {
                if (text === null) drafts.delete(id);
                else { drafts.set(id, text); generations.set(id, (generations.get(id) ?? 0) + 1); }
            },
            getTextBoxDraftText: id => drafts.get(id) ?? null,
            getTextBoxDraftGeneration: id => generations.get(id),
            textBoxDraftRects: draftRectangles,
            protectTextBoxDraft: () => protection.promise,
        }))!;
        const box = surface.createTextBoxAt(0, {
            left: 0.2,
            top: 0.2,
            width: 0.3,
            height: 0.1,
        });
        await surface.beginTextEditing(box.identity.id);
        draftRectangles.set(box.identity.id, {
            ...box.rect,
            width: 0.5,
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
        await nextTick();
        const layer = host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        Object.defineProperties(editor, {
            scrollWidth: {
                configurable: true,
                value: 30,
            },
            scrollHeight: {
                configurable: true,
                value: 40,
            },
        });
        const type = (text: string) => {
            editor.textContent = text;
            editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        };
        const accept = () => editor.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            ctrlKey: true,
        }));
        type('First text');
        accept();
        await nextTick();
        expect(host.querySelector('.is-editing')).not.toBeNull();
        expect(application.value.store.get(box.identity.id)).toMatchObject({text: ''});
        expect(surface.getTextBoxDraftRect(box.identity.id)).toMatchObject({height: 0.4});
        const refused = expect(surface.commitPendingTextBoxDraftsForSave()).rejects.toThrow(reason === 'newer typing' ? 'changed' : 'ENOSPC');
        if (reason === 'newer typing') {type('Newer text'); protection.resolve(undefined);}
        else protection.reject(new Error('ENOSPC'));
        await refused;
        await vi.waitFor(() => expect(document.activeElement).toBe(editor));
        expect(editor.textContent).toBe(reason === 'newer typing' ? 'Newer text' : 'First text');
        expect(host.querySelector('.is-editing')).not.toBeNull();
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(true);
        expect(application.value.store.get(box.identity.id)).toMatchObject({text: ''});
        protection = Promise.withResolvers<undefined>();
        accept();
        protection.resolve(undefined);
        await vi.waitFor(() => expect(host.querySelector('.is-editing')).toBeNull());
        expect(application.value.store.get(box.identity.id)).toMatchObject({
            text: reason === 'newer typing' ? 'Newer text' : 'First text',
            rect: {
                left: 0.2,
                top: 0.2,
                width: 0.5,
                height: 0.4,
            },
        });
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(false);
    });

    it('keeps the rejected draft geometry when its disposed viewer is replaced by the surviving editor', async () => {
        const protection = Promise.withResolvers<undefined>();
        const owner = createPdfDocumentAnnotations({
            workingCopyPath: computed(() => requireDocumentRef('/managed/shared-text.pdf')),
            source: computed(() => null),
            documentRevisionToken: computed(() => null),
        });
        const mount = () => {
            const host = document.createElement('div');
            document.body.append(host);
            let surface: IAnnotationEditorSurface;
            const app = createApp({setup() {
                surface = usePdfAnnotationEditorSurface({
                    annotationApplication: owner.application,
                    activeTool: computed(() => 'text'),
                    getPageGeometry: () => ({
                        pageView: [
                            0,
                            0,
                            100,
                            100,
                        ],
                        rotation: 0,
                    }),
                    settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
                    onTextBoxDraftChanged: owner.setTextBoxDraft,
                    getTextBoxDraftText: id => owner.textBoxDrafts.get(id) ?? null,
                    getTextBoxDraftGeneration: id => owner.textBoxDraftGenerations.get(id),
                    textBoxDraftRects: owner.textBoxDraftRects,
                    protectTextBoxDraft: () => protection.promise,
                });
                provide(annotationEditorSurfaceKey, surface);
                return () => h(PdfAnnotationEditorLayer, {pageIndex: requirePageIndex(0)});
            }});
            app.mount(host);
            return {
                host,
                app,
                surface: surface!,
            };
        };
        const source = mount();
        const surviving = mount();
        const contentHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(40);
        onTestFinished(() => contentHeight.mockRestore());
        onTestFinished(() => {surviving.app.unmount(); surviving.host.remove(); source.host.remove();});
        await nextTick();
        const sourceLayer = source.host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        const survivingLayer = surviving.host.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        vi.spyOn(sourceLayer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        vi.spyOn(survivingLayer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
        const background = source.host.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background')!;
        background.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 22,
        }));
        sourceLayer.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 22,
        }));
        const id = owner.application.value.store.list()[0]!.identity.id;
        await nextTick();
        await nextTick();
        const editor = source.host.querySelector<HTMLElement>('[contenteditable="true"]')!;
        Object.defineProperties(editor, {
            scrollWidth: {
                configurable: true,
                value: 90,
            },
            scrollHeight: {
                configurable: true,
                value: 40,
            },
        });
        editor.textContent = 'Retained linked draft';
        editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            key: 'Enter',
            ctrlKey: true,
        }));
        const refused = expect(source.surface.commitPendingTextBoxDraftsForSave()).rejects.toThrow('ENOSPC');
        await nextTick();
        expect(source.host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!.style.height).toBe('40%');
        source.app.unmount();
        protection.reject(new Error('ENOSPC'));
        await refused;
        expect(structuredClone(owner.getTextBoxDraftRect(id))?.height).toBe(0.4);
        vi.mocked(survivingLayer.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 138, 138));
        contentHeight.mockReturnValue(56);
        await surviving.surface.beginTextEditing(id);
        await nextTick();
        await nextTick();
        expect(surviving.host.querySelector('[contenteditable="true"]')?.textContent).toBe('Retained linked draft');
        const retainedBox = surviving.host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!;
        expect(retainedBox.style.height).toBe('40%');
        expect(retainedBox.style.width).toBe('80%');
    });

    it('grows a click-created text box without moving its insertion edge', async () => {
        const application = shallowRef(new AnnotationApplication('save-hook-text'));
        const scope = effectScope();
        const surface = scope.run(() => usePdfAnnotationEditorSurface({
            annotationApplication: application,
            activeTool: computed(() => 'text'),
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
        onTestFinished(() => scope.stop());
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp({setup() {
            provide(annotationEditorSurfaceKey, surface);
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
        await surface.commitPendingTextBoxDraftsForSave();

        await nextTick();
        const box = host.querySelector<HTMLElement>('[data-annotation-kind="text-box"]')!;
        expect(box.textContent).toBe('a long click-created draft');
        expect(box.style.left).toBe('20.000000000000004%');
        expect(box.style.width).toBe('80%');
        expect(Number.parseFloat(box.style.height)).toBeGreaterThan(10);
        expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    });
});
