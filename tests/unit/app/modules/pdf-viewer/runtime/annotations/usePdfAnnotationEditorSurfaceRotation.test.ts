import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    shallowRef,
} from 'vue';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {usePdfAppAnnotationHistory} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import {
    usePdfAnnotationEditorSurface,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import {
    annotationPageDimensions,
    rotatedAnnotationBounds,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

const activeScopes = new Set<ReturnType<typeof effectScope>>();

function createSurfaceHarness(options: {
    getPageGeometry?: IAnnotationEditorSurface['getPageGeometry'];
    withHistory?: boolean
} = {}) {
    const isActive = shallowRef(true);
    const emitAnnotationModified = vi.fn();
    const emitShapeContextMenu = vi.fn();
    const onCreationCompleted = vi.fn();
    const draftTexts = new Map<string, string>();
    const onTextBoxDraftChanged = (id: string, text: string | null) => {
        if (text === null) draftTexts.delete(id);
        else draftTexts.set(id, text);
    };
    const scope = effectScope();
    activeScopes.add(scope);
    const history = options.withHistory ? scope.run(() => usePdfAppAnnotationHistory({
        emitAnnotationState: vi.fn(),
        markModified: vi.fn(),
    })) : undefined;
    const store = history ? new AnnotationStore({
        get canUndo() { return history.canUndo.value; },
        get canRedo() { return history.canRedo.value; },
        registerCommand: history.registerCommand,
        forgetCommands: history.forgetCommands,
        undo: history.undo,
        redo: history.redo,
    }) : undefined;
    const annotationApplication = shallowRef(new AnnotationApplication('surface-rotation-test', store));
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication,
        isActive: computed(() => isActive.value),
        activeTool: computed<TAnnotationTool>(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        onTextBoxDraftChanged,
        getTextBoxDraftText: id => draftTexts.get(id) ?? null,
        ...(options.getPageGeometry ? {getPageGeometry: options.getPageGeometry} : {}),
        ...(history ? {runHistoryTransaction: history.runTransaction} : {}),
    }))!;
    return {
        annotationApplication,
        emitAnnotationModified,
        history,
        surface,
    };
}

describe('usePdfAnnotationEditorSurface rotation', () => {
    const portraitGeometry = {
        pageView: [
            0,
            0,
            600,
            1000,
        ],
        rotation: 0 as const,
    };

    it('rotates each selected text and image by its own angle in one undoable operation', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({
            getPageGeometry: () => portraitGeometry,
            withHistory: true,
        });
        const box = surface.createTextBoxAt(0, {
            ...rect,
            left: 0.4,
            top: 0.4,
        }, {rotation: 270});
        const image = surface.createStampAt(0, {
            ...rect,
            left: 0.4,
            top: 0.6,
        }, {
            objectNumber: 10,
            generationNumber: 0,
            byteLength: 4,
            sha256: 'a'.repeat(64),
        }, {rotation: 37});
        surface.select([
            box.identity.id,
            image.identity.id,
        ]);
        const original = annotationApplication.value.store.list();
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(annotationApplication.value.store.list()).toEqual(original);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            rotation: 0,
            rect: box.rect,
            fontSize: box.fontSize,
        });
        expect(annotationApplication.value.store.get(image.identity.id)).toMatchObject({
            rotation: 127,
            rect: image.rect,
        });
        expect(surface.undo()).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            rotation: 270,
            rect: box.rect,
        });
        expect(annotationApplication.value.store.get(image.identity.id)).toMatchObject({
            rotation: 37,
            rect: image.rect,
        });
    });

    it.each([
        0,
        90,
    ] as const)('translates a quarter-turned box inside a nonsquare page with page rotation %s', (pageRotation) => {
        const geometry = {
            ...portraitGeometry,
            rotation: pageRotation,
        };
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => geometry});
        const box = surface.createTextBoxAt(0, {
            left: 0.01,
            top: 0.01,
            width: 0.3,
            height: 0.15,
        });
        surface.select([box.identity.id]);
        expect(surface.canRotateSelectedAnnotations(-90)).toBe(true);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: -90})).toBe(true);
        const updated = annotationApplication.value.store.get(box.identity.id);
        expect(updated?.kind).toBe('text-box');
        if (updated?.kind !== 'text-box') throw new Error('Text box missing');
        expect(updated.rotation).toBe(270);
        expect(updated.rect.width).toBe(box.rect.width);
        expect(updated.rect.height).toBe(box.rect.height);
        expect(updated.fontSize).toBe(box.fontSize);
        const bounds = rotatedAnnotationBounds(updated.rect, updated.rotation, annotationPageDimensions(geometry.pageView, geometry.rotation));
        expect(bounds.left).toBeGreaterThanOrEqual(-1e-12);
        expect(bounds.top).toBeGreaterThanOrEqual(-1e-12);
        expect(bounds.left + bounds.width).toBeLessThanOrEqual(1 + 1e-12);
        expect(bounds.top + bounds.height).toBeLessThanOrEqual(1 + 1e-12);
        if (pageRotation === 0) expect(updated.rect.top).toBeCloseTo(0.015, 12);
        else expect(updated.rect.top).toBeCloseTo(0.175);
    });

    it('checks pending text read-only and commits before rotation', async () => {
        const {
            surface,
            annotationApplication,
            history,
        } = createSurfaceHarness({
            getPageGeometry: () => portraitGeometry,
            withHistory: true,
        });
        const box = surface.createTextBoxAt(0, rect, {text: 'Existing text'});
        const draftRect = shallowRef({
            left: 0.01,
            top: 0.01,
            width: 0.3,
            height: 0.9,
        });
        const completion = Promise.withResolvers<undefined>();
        let refuseCompletion = true;
        const commitDraft = async () => {
            await completion.promise;
            if (refuseCompletion) throw new DOMException('Draft protection was refused', 'AbortError');
            surface.commitGesture(box.identity.id, {
                text: 'Pending text',
                rect: draftRect.value,
            });
            surface.endTextEditing(box.identity.id, {restoreFocus: false});
        };
        surface.registerPageInteraction(0, {
            commitTextDraft: commitDraft,
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect: id => id === box.identity.id ? draftRect.value : null,
        });
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Pending text');
        const original = annotationApplication.value.store.list();
        const selection = [...surface.selectedIds.value];
        const historyBefore = [
            history!.canUndo.value,
            history!.canRedo.value,
        ];
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        draftRect.value = {
            ...draftRect.value,
            height: 0.15,
        };
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(false);
        completion.resolve(undefined);
        await Promise.resolve();
        expect(annotationApplication.value.store.list()).toEqual(original);
        expect([...surface.selectedIds.value]).toEqual(selection);
        expect([
            history!.canUndo.value,
            history!.canRedo.value,
        ]).toEqual(historyBefore);
        expect(surface.editingId.value).toBe(box.identity.id);
        expect(surface.getTextBoxDraftText(box.identity.id)).toBe('Pending text');
        expect(surface.getTextBoxDraftRect(box.identity.id)).toEqual(draftRect.value);
        await expect(surface.commitPendingTextBoxDraftsForSave()).rejects.toThrow('Draft protection was refused');
        expect(annotationApplication.value.store.list()).toEqual(original);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.editingId.value).toBe(box.identity.id);

        // Unchanged text with a measured nonempty rectangle is still unaccepted geometry.
        surface.setTextBoxDraftPending(box.identity.id, box.text);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(false);
        expect(annotationApplication.value.store.list()).toEqual(original);
        surface.setTextBoxDraftPending(box.identity.id, 'Pending text');
        refuseCompletion = false;
        await surface.commitPendingTextBoxDraftsForSave();
        const accepted = annotationApplication.value.store.get(box.identity.id);
        expect(accepted).toMatchObject({
            text: 'Pending text',
            rect: draftRect.value,
            rotation: 0,
        });
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        const updated = annotationApplication.value.store.get(box.identity.id);
        expect(updated).toMatchObject({
            text: 'Pending text',
            rotation: 90,
            rect: {
                width: 0.3,
                height: 0.15,
            },
        });
        if (updated?.kind !== 'text-box') throw new Error('Text box missing');
        expect(updated.rect.top).toBeCloseTo(0.015, 12);
        expect(surface.editingId.value).toBeNull();
        expect(await surface.undo()).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: 'Pending text',
            rect: draftRect.value,
            rotation: 0,
        });
        expect(await surface.undo()).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: box.text,
            rect: box.rect,
            rotation: 0,
        });
    });

    it('preserves an empty editing session and rotates its pending rectangle after geometry preparation', async () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, rect);
        const draftRect = {
            left: 0.01,
            top: 0.01,
            width: 0.3,
            height: 0.15,
        };

        surface.registerPageInteraction(0, {
            commitTextDraft: () => { throw new Error('Empty editor must remain open'); },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect: () => draftRect,
        });
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, '');
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toEqual(box);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        expect(surface.editingId.value).toBe(box.identity.id);
        const updated = annotationApplication.value.store.get(box.identity.id);
        expect(updated).toMatchObject({
            text: '',
            rotation: 90,
            rect: {
                width: 0.3,
                height: 0.15,
            },
        });
        if (updated?.kind !== 'text-box') throw new Error('Text box missing');
        expect(updated.rect.top).toBeCloseTo(0.015, 12);
    });

    it('does not read draft geometry outside an active text editing session', async () => {
        const {
            surface, annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, rect, {text: 'Unchanged text'});
        const getTextBoxDraftRect = vi.fn(() => ({
            left: 0,
            top: 0,
            width: 1,
            height: 1,
        }));
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect,
        });
        surface.select([box.identity.id]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(getTextBoxDraftRect).not.toHaveBeenCalled();
        await surface.beginTextEditing(box.identity.id);
        surface.registerPageInteraction(0, {
            commitTextDraft: () => { throw new Error('No-op entry must not complete'); },
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect: () => box.rect,
        });
        surface.setTextBoxDraftPending(box.identity.id, box.text);
        expect(surface.hasTextBoxDraftPending(box.identity.id)).toBe(true);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            text: box.text,
            rect: box.rect,
            rotation: 90,
        });
        expect(surface.editingId.value).toBe(box.identity.id);
    });

    it('fits an arbitrary-angle image against the bottom edge without changing its size', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const image = surface.createStampAt(0, {
            left: 0.4,
            top: 0.89,
            width: 0.18,
            height: 0.1,
        }, {
            objectNumber: 10,
            generationNumber: 0,
            byteLength: 4,
            sha256: 'a'.repeat(64),
        }, {rotation: 10});
        surface.select([image.identity.id]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        const updated = annotationApplication.value.store.get(image.identity.id);
        if (updated?.kind !== 'placed-image') throw new Error('Image missing');
        expect(updated.rotation).toBe(100);
        expect(updated.rect.left).toBe(image.rect.left);
        expect(updated.rect.top).toBeLessThan(image.rect.top);
        expect(updated.rect.width).toBe(image.rect.width);
        expect(updated.rect.height).toBe(image.rect.height);
        const bounds = rotatedAnnotationBounds(updated.rect, updated.rotation, annotationPageDimensions(portraitGeometry.pageView, portraitGeometry.rotation));
        expect(bounds.top + bounds.height).toBeCloseTo(1, 12);
    });

    it('rejects the entire rotation and other property changes when one selected box cannot fit', () => {
        const {
            surface,
            annotationApplication,
            emitAnnotationModified,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const small = surface.createTextBoxAt(0, rect);
        const tall = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.05,
            width: 0.1,
            height: 0.9,
        });
        surface.select([
            small.identity.id,
            tall.identity.id,
        ]);
        const original = annotationApplication.value.store.list();
        const update = vi.spyOn(annotationApplication.value.store, 'updateTextBox');
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({
            rotationDelta: 90,
            color: '#123456',
        })).toBe(false);
        expect(annotationApplication.value.store.list()).toEqual(original);
        expect(update).not.toHaveBeenCalled();
        expect(emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('declines rotation until geometry exists and for selections containing unsupported annotations', () => {
        const geometry = shallowRef<typeof portraitGeometry | null>(null);
        const {surface} = createSurfaceHarness({getPageGeometry: () => geometry.value});
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        const box = surface.createTextBoxAt(0, rect);
        surface.select([box.identity.id]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({rotation: 90})).toBe(false);
        geometry.value = portraitGeometry;
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        const note = surface.createNoteAt(0, rect);
        surface.select([
            box.identity.id,
            note.identity.id,
        ]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(false);
    });

    it('preserves absolute rotation updates and applies the same bounds admission', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, {
            left: 0.01,
            top: 0.2,
            width: 0.3,
            height: 0.15,
        });
        surface.select([box.identity.id]);
        expect(surface.updateSelectedAnnotationProperties({rotation: 90})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({rotation: 90});
        expect(surface.updateSelectedAnnotationProperties({rotation: 90})).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({
            rotation: 180,
            rotationDelta: 90,
        })).toBe(false);
    });

    afterEach(() => {
        for (const scope of activeScopes) scope.stop();
        activeScopes.clear();
    });
});
