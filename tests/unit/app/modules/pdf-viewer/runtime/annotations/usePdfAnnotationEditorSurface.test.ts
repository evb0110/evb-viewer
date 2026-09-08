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
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import {
    asAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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
import {requirePageIndex} from '@contracts/pageNumbers';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

function baseEntity(id: string, pageIndex = 0) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: -1,
        deleted: false as const,
        createdAt: null,
        modifiedAt: null,
        author: null,
    };
}

function createSurfaceHarness(options: {
    getPageGeometry?: IAnnotationEditorSurface['getPageGeometry'];
    withHistory?: boolean
} = {}) {
    const isActive = shallowRef(true);
    const emitAnnotationModified = vi.fn();
    const emitShapeContextMenu = vi.fn();
    const onCreationCompleted = vi.fn();
    const onTextBoxDraftChanged = vi.fn();
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
    const annotationApplication = shallowRef(new AnnotationApplication('surface-test', store));
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication,
        isActive: computed(() => isActive.value),
        activeTool: computed<TAnnotationTool>(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        onTextBoxDraftChanged,
        ...(options.getPageGeometry ? {getPageGeometry: options.getPageGeometry} : {}),
        ...(history ? {runHistoryTransaction: history.runTransaction} : {}),
    }))!;
    const stop = () => {
        if (!activeScopes.delete(scope)) {
            return;
        }
        scope.stop();
    };
    return {
        annotationApplication,
        isActive,
        emitAnnotationModified,
        emitShapeContextMenu,
        onCreationCompleted,
        onTextBoxDraftChanged,
        surface,
        stop,
    };
}

const activeScopes = new Set<ReturnType<typeof effectScope>>();

describe('usePdfAnnotationEditorSurface', () => {
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

    it.each([
        false,
        true,
    ])('checks pending text read-only and commits before rotation with geometry preparation %s', (hasGeometryPreparation) => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, rect);
        const draftRect = shallowRef({
            left: 0.01,
            top: 0.01,
            width: 0.3,
            height: 0.9,
        });
        const commitDraft = () => {
            surface.commitGesture(box.identity.id, {
                text: 'Pending text',
                rect: draftRect.value,
            });
            surface.endTextEditing(box.identity.id, {restoreFocus: false});
        };
        const commitTextDraft = vi.fn(commitDraft);
        const prepareGeometryChange = vi.fn(commitDraft);
        surface.registerPageInteraction(0, {
            commitTextDraft,
            ...(hasGeometryPreparation ? {prepareGeometryChange} : {}),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect: id => id === box.identity.id ? draftRect.value : null,
        });
        surface.beginTextEditing(box.identity.id);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        draftRect.value = {
            ...draftRect.value,
            height: 0.15,
        };
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(commitTextDraft).not.toHaveBeenCalled();
        expect(prepareGeometryChange).not.toHaveBeenCalled();
        expect(annotationApplication.value.store.get(box.identity.id)).toEqual(box);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        if (hasGeometryPreparation) {
            expect(prepareGeometryChange).toHaveBeenCalledOnce();
            expect(commitTextDraft).not.toHaveBeenCalled();
        } else {
            expect(commitTextDraft).toHaveBeenCalledOnce();
            expect(prepareGeometryChange).not.toHaveBeenCalled();
        }
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
    });

    it('preserves an empty editing session and rotates its pending rectangle after geometry preparation', () => {
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
        const prepareGeometryChange = vi.fn();
        const commitTextDraft = vi.fn();
        surface.registerPageInteraction(0, {
            commitTextDraft,
            prepareGeometryChange,
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            getTextBoxDraftRect: () => draftRect,
        });
        surface.beginTextEditing(box.identity.id);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(prepareGeometryChange).not.toHaveBeenCalled();
        expect(commitTextDraft).not.toHaveBeenCalled();
        expect(annotationApplication.value.store.get(box.identity.id)).toEqual(box);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        expect(prepareGeometryChange).toHaveBeenCalledOnce();
        expect(commitTextDraft).not.toHaveBeenCalled();
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

    it('does not read draft geometry outside an active text editing session', () => {
        const {surface} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, rect);
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

    it('returns focus only to the still-selected annotation without replacing a multi-selection', () => {
        const {
            surface,
            isActive,
        } = createSurfaceHarness();
        const first = surface.createNoteAt(0, rect);
        const second = surface.createNoteAt(0, rect);
        const focus = vi.fn();
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus,
        });
        surface.select([
            first.identity.id,
            second.identity.id,
        ]);
        expect(surface.focusSelectedAnnotation(first.identity.id)).toBe(true);
        expect(focus).toHaveBeenCalledOnce();
        expect(surface.selectedIds.value).toEqual(new Set([
            first.identity.id,
            second.identity.id,
        ]));
        surface.select([second.identity.id]);
        expect(surface.focusSelectedAnnotation(first.identity.id)).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
        isActive.value = false;
        expect(surface.focusSelectedAnnotation(second.identity.id)).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
    });

    it('completes a new text creation only after its accepted draft, never on cancellation', () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.beginTextEditing(box.identity.id);
        expect(onCreationCompleted).not.toHaveBeenCalled();
        surface.endTextEditing(box.identity.id, {
            created: true,
            cancelled: true,
        });
        expect(onCreationCompleted).not.toHaveBeenCalled();
        surface.beginTextEditing(box.identity.id);
        surface.endTextEditing(box.identity.id, {created: true});
        expect(onCreationCompleted).toHaveBeenCalledExactlyOnceWith('text');
    });

    it('Escape cancels the pointer operation before touching selection or the active text session', () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const cancelPointerGesture = vi.fn();
        const cancelTextDraft = vi.fn(() => surface.endTextEditing(box.identity.id, {cancelled: true}));
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft,
            cancelPointerGesture,
            focus: vi.fn(),
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        expect(surface.handleEscape()).toBe(true);
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(cancelTextDraft).not.toHaveBeenCalled();
        expect(surface.selectedIds.value.has(box.identity.id)).toBe(true);
        expect(surface.handleEscape()).toBe(true);
        expect(cancelTextDraft).toHaveBeenCalledOnce();
        expect(surface.editingId.value).toBeNull();
        expect(surface.handleEscape()).toBe(true);
        expect(surface.selectedIds.value.size).toBe(0);
        expect(onCreationCompleted).not.toHaveBeenCalled();
    });

    it('owns one text session and cancels a captured gesture before a tool change', () => {
        const { surface } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const events: string[] = [];
        surface.registerPageInteraction(0, {
            commitTextDraft: () => {
                events.push('commit');
                surface.endTextEditing(box.identity.id, {restoreFocus: false});
            },
            cancelTextDraft: () => events.push('cancel-text'),
            cancelPointerGesture: () => events.push('cancel-pointer'),
            focus: () => events.push('focus'),
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        surface.prepareToolChange();
        expect(events).toEqual([
            'commit',
            'cancel-pointer',
        ]);
        expect(surface.editingId.value).toBeNull();
        expect(surface.selectedIds.value.size).toBe(0);
        expect(surface.cancelActiveInteraction()).toBe(false);
    });

    it('suspends a hidden document by committing text and cancelling its gesture without tool completion', async () => {
        const {
            surface,
            onCreationCompleted,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const focus = vi.fn();
        const cancelPointerGesture = vi.fn();
        const commitTextDraft = vi.fn(() => surface.endTextEditing(box.identity.id, {created: true}));
        surface.registerPageInteraction(0, {
            commitTextDraft,
            cancelTextDraft: vi.fn(),
            cancelPointerGesture,
            focus,
        });
        surface.beginTextEditing(box.identity.id);
        surface.beginPointerInteraction(0);
        surface.suspendInteraction();
        await Promise.resolve();
        expect(commitTextDraft).toHaveBeenCalledOnce();
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(surface.selectedIds.value.has(box.identity.id)).toBe(true);
        expect(onCreationCompleted).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
    });

    it('applies explicit common properties to the whole canonical selection without changing defaults', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const note = surface.createNoteAt(0, rect);
        surface.select([
            box.identity.id,
            note.identity.id,
        ]);
        expect(surface.updateSelectedAnnotationProperties({color: '#123456'})).toBe(true);
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({color: '#123456'});
        expect(annotationApplication.value.store.get(note.identity.id)).toMatchObject({color: '#123456'});
        expect(surface.settings.value).toEqual(DEFAULT_ANNOTATION_SETTINGS);
    });

    it('does not mark unchanged font size and equal measured geometry as modified', () => {
        const {
            surface,
            emitAnnotationModified,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox: entity => ({...entity.rect}),
        });
        surface.select([box.identity.id]);
        emitAnnotationModified.mockClear();
        expect(surface.updateSelectedAnnotationProperties({fontSize: box.fontSize})).toBe(false);
        expect(emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('rejects font and geometry together when text cannot fit the page', () => {
        const {
            surface,
            annotationApplication,
            emitAnnotationModified,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox: () => null,
        });
        surface.select([box.identity.id]);
        emitAnnotationModified.mockClear();
        expect(surface.updateSelectedAnnotationProperties({fontSize: 72})).toBe(false);
        expect(annotationApplication.value.store.get(box.identity.id)).toEqual(box);
        expect(emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('fits selected text to a new font size before one canonical update', () => {
        const {
            surface,
            annotationApplication,
        } = createSurfaceHarness();
        const box = surface.createTextBoxAt(0, rect);
        const fitTextBox = vi.fn(() => ({
            ...rect,
            height: 0.15,
        }));
        surface.registerPageInteraction(0, {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture: vi.fn(),
            focus: vi.fn(),
            fitTextBox,
        });
        surface.select([box.identity.id]);
        const before = annotationApplication.value.store.get(box.identity.id)!.revision;
        surface.updateSelectedAnnotationProperties({fontSize: 32});
        expect(fitTextBox).toHaveBeenCalledWith(expect.objectContaining({fontSize: 32}));
        expect(annotationApplication.value.store.get(box.identity.id)).toMatchObject({
            fontSize: 32,
            rect: {
                ...rect,
                height: 0.15,
            },
            revision: before + 1,
        });
    });

    it('clears a moving page preview when its interaction host unmounts', () => {
        const {surface} = createSurfaceHarness();
        const cancelPointerGesture = vi.fn();
        const interaction = {
            commitTextDraft: vi.fn(),
            cancelTextDraft: vi.fn(),
            cancelPointerGesture,
            focus: vi.fn(),
        };
        const unregisterMovingPage = surface.registerPageInteraction(0, interaction);
        const unregisterOtherPage = surface.registerPageInteraction(1, {
            ...interaction,
            cancelPointerGesture: vi.fn(),
        });
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.1,
            y: 0.2,
        });
        unregisterOtherPage();
        expect(surface.selectionMoveDelta.value).toEqual({
            x: 0.1,
            y: 0.2,
        });
        expect(cancelPointerGesture).not.toHaveBeenCalled();
        unregisterMovingPage();
        expect(surface.selectionMoveDelta.value).toBeNull();
        expect(cancelPointerGesture).toHaveBeenCalledOnce();
        expect(surface.cancelActiveInteraction()).toBe(false);
    });

    it('clears the shared selection preview when its pointer operation ends or cancels', () => {
        const {surface} = createSurfaceHarness();
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.1,
            y: 0.2,
        });
        surface.endPointerInteraction(1);
        expect(surface.selectionMoveDelta.value).toEqual({
            x: 0.1,
            y: 0.2,
        });
        surface.endPointerInteraction(0);
        expect(surface.selectionMoveDelta.value).toBeNull();
        surface.beginPointerInteraction(0);
        surface.setSelectionMoveDelta({
            x: 0.2,
            y: 0.1,
        });
        surface.cancelActiveInteraction();
        expect(surface.selectionMoveDelta.value).toBeNull();
    });

    afterEach(() => {
        for (const scope of activeScopes) {
            scope.stop();
        }
        activeScopes.clear();
    });

    it('projects every authored kind from the store and preserves markup subtypes and geometry', () => {
        const harness = createSurfaceHarness();
        const { store } = harness.annotationApplication.value;
        const entities: AnnotationEntity[] = [
            {
                kind: 'text-box',
                ...baseEntity('text-box'),
                text: 'text box',
                rect,
                rotation: 0,
                fontSize: 18,
                color: '#111827',
            },
            {
                kind: 'note',
                ...baseEntity('note'),
                contents: 'note',
                position: {
                    ...rect,
                    width: 0.018,
                    height: 0.018,
                },
                color: '#f59e0b',
                open: false,
            },
            {
                kind: 'placed-image',
                ...baseEntity('placed-image'),
                rect,
                rotation: 0,
                image: {
                    objectNumber: 10,
                    generationNumber: 0,
                    byteLength: 4,
                    sha256: 'a'.repeat(64),
                },
            },
            {
                kind: 'text-markup',
                ...baseEntity('text-markup'),
                subtype: 'Underline',
                contents: 'markup note',
                quadPoints: [
                    rect,
                    {
                        ...rect,
                        top: 0.3,
                    },
                ],
                color: '#2563eb',
                opacity: 0.8,
                selectedText: 'underlined text',
            },
            {
                kind: 'shape',
                ...baseEntity('shape'),
                tool: 'rectangle',
                rect,
                strokeColor: '#dc2626',
                strokeWidth: 2,
                fill: null,
                opacity: 1,
            },
        ];

        entities.forEach((entity) => {
            switch (entity.kind) {
                case 'text-box':
                    store.createTextBox(entity);
                    break;
                case 'note':
                    store.createNote(entity);
                    break;
                case 'placed-image':
                    store.createPlacedImage(entity);
                    break;
                case 'text-markup':
                    store.createTextMarkup(entity);
                    break;
                case 'shape':
                    store.createShape(entity);
                    break;
            }
        });

        const projected = harness.surface.getEntitiesForPage(0);
        expect(projected.map(entity => entity.kind)).toEqual([
            'text-box',
            'note',
            'placed-image',
            'text-markup',
            'shape',
        ]);
        const markup = projected.find((entity) => entity.kind === 'text-markup');
        expect(markup).toMatchObject({
            kind: 'text-markup',
            subtype: 'Underline',
            quadPoints: [
                rect,
                {
                    ...rect,
                    top: 0.3,
                },
            ],
            selectedText: 'underlined text',
        });

        harness.surface.select([asAnnotationId('text-markup')]);
        harness.surface.select([asAnnotationId('shape')], {additive: true});
        expect(store.selectedIds).toEqual(new Set([
            asAnnotationId('text-markup'),
            asAnnotationId('shape'),
        ]));

        harness.stop();
    });

    it('removes tombstoned entities from the page projection', () => {
        const harness = createSurfaceHarness();
        const entity = {
            kind: 'note' as const,
            ...baseEntity('deleted-note'),
            contents: '',
            position: rect,
            color: null,
            open: false,
        };
        harness.annotationApplication.value.store.createNote(entity);
        expect(harness.surface.getEntitiesForPage(0)).toHaveLength(1);

        harness.annotationApplication.value.store.delete(entity.identity.id);

        expect(harness.surface.getEntitiesForPage(0)).toEqual([]);
        harness.stop();
    });

    it('forwards canonical shape context-menu selection to the workspace bridge', () => {
        const harness = createSurfaceHarness();
        const entity = {
            kind: 'shape' as const,
            ...baseEntity('context-shape'),
            tool: 'rectangle' as const,
            rect,
            strokeColor: '#dc2626',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        };
        harness.annotationApplication.value.store.createShape(entity);

        harness.surface.openShapeContextMenu({
            shapeId: entity.identity.id,
            clientX: 120,
            clientY: 240,
        });

        expect(harness.emitShapeContextMenu).toHaveBeenCalledWith({
            shapeId: entity.identity.id,
            clientX: 120,
            clientY: 240,
        });
        harness.stop();
    });

    it('uses the selected subtype settings when creating text markup directly', () => {
        const harness = createSurfaceHarness();

        const created = harness.surface.createHighlightFromSelection(0, [rect], {subtype: 'Underline'});

        expect(created).toMatchObject({
            subtype: 'Underline',
            color: DEFAULT_ANNOTATION_SETTINGS.underlineColor,
            opacity: DEFAULT_ANNOTATION_SETTINGS.underlineOpacity,
        });
        harness.stop();
    });

    it('creates and selects one canonical stamp with its JPEG image reference', () => {
        const harness = createSurfaceHarness();
        const image = {
            objectNumber: 17,
            generationNumber: 0,
            byteLength: 4,
            sha256: 'b'.repeat(64),
        };

        const created = harness.surface.createStampAt(1, rect, image);

        expect(created).toMatchObject({
            kind: 'placed-image',
            pageIndex: requirePageIndex(1),
            rect,
            rotation: 0,
            image,
        });
        expect(harness.annotationApplication.value.store.list()).toEqual([created]);
        harness.surface.select([created.identity.id]);
        expect(harness.surface.selectedIds.value).toEqual(new Set([created.identity.id]));

        harness.stop();
    });

    it('creates, selects, styles, and deletes a text box through the canonical surface', () => {
        const harness = createSurfaceHarness();

        const created = harness.surface.createTextBoxAt(0, rect);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        harness.surface.select([created.identity.id]);

        expect(harness.surface.getSelectedTextBox()).toMatchObject({
            identity: created.identity,
            rect,
            fontSize: DEFAULT_ANNOTATION_SETTINGS.textSize,
            color: DEFAULT_ANNOTATION_SETTINGS.textColor,
        });
        expect(harness.surface.updateSelectedTextBoxProperties({
            fontSize: 22,
            color: '#ef4444',
        })).toBe(true);
        expect(harness.emitAnnotationModified).toHaveBeenCalledOnce();
        expect(harness.surface.getSelectedTextBox()).toMatchObject({
            fontSize: 22,
            color: '#ef4444',
        });
        expect(harness.surface.updateSelectedTextBoxProperties({fontSize: 22})).toBe(false);
        expect(harness.surface.deleteAnnotation(created.identity.id)).toBe(true);
        expect(harness.surface.getSelectedTextBox()).toBeNull();
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(2);

        harness.stop();
    });

    it('commits registered text box drafts before save and unregisters disposed editors', () => {
        const harness = createSurfaceHarness();
        const firstCommitter = vi.fn();
        const secondCommitter = vi.fn();
        const unregisterFirst = harness.surface.registerTextBoxDraftCommitter(firstCommitter);
        harness.surface.registerTextBoxDraftCommitter(secondCommitter);

        harness.surface.commitPendingTextBoxDraftsForSave();
        expect(firstCommitter).toHaveBeenCalledOnce();
        expect(secondCommitter).toHaveBeenCalledOnce();

        unregisterFirst();
        harness.surface.commitPendingTextBoxDraftsForSave();
        expect(firstCommitter).toHaveBeenCalledOnce();
        expect(secondCommitter).toHaveBeenCalledTimes(2);

        harness.stop();
    });

    it('publishes every live text draft without committing it, then retracts it on cancel', () => {
        const harness = createSurfaceHarness();
        const entity = harness.surface.createTextBoxAt(0, rect, {text: 'Original'});
        harness.surface.beginTextEditing(entity.identity.id);
        const epoch = harness.annotationApplication.value.store.mutationEpoch;

        harness.surface.setTextBoxDraftPending(entity.identity.id, 'First');
        harness.surface.setTextBoxDraftPending(entity.identity.id, 'Текст العربية');
        harness.surface.setTextBoxDraftPending(entity.identity.id, '');
        expect(harness.onTextBoxDraftChanged.mock.calls).toEqual([
            [
                entity.identity.id,
                'First',
            ],
            [
                entity.identity.id,
                'Текст العربية',
            ],
            [
                entity.identity.id,
                '',
            ],
        ]);
        expect(harness.annotationApplication.value.listCommentSummaries()[0]?.text).toBe('Original');
        expect(harness.annotationApplication.value.store.mutationEpoch).toBe(epoch);

        harness.surface.endTextEditing(entity.identity.id, {cancelled: true});
        expect(harness.onTextBoxDraftChanged).toHaveBeenLastCalledWith(entity.identity.id, null);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
    });

    it('reports pending text box drafts until the editor commits or cancels them', () => {
        const harness = createSurfaceHarness();
        const annotationId = asAnnotationId('pending-text-box');
        harness.annotationApplication.value.store.createTextBox({
            kind: 'text-box',
            ...baseEntity(annotationId),
            text: '',
            rect,
            rotation: 0,
            fontSize: 14,
            color: '#111827',
        });

        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.surface.setTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);

        // Repeated input events for one editor must not inflate the count.
        harness.surface.setTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);

        harness.surface.clearTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.surface.clearTextBoxDraftPending(annotationId);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.surface.setTextBoxDraftPending(annotationId);
        harness.annotationApplication.value = new AnnotationApplication('surface-next-document');
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.stop();
    });

    it('ignores stale draft input for an id that is absent from the current document', () => {
        const harness = createSurfaceHarness();

        harness.surface.setTextBoxDraftPending(asAnnotationId('stale-text-box'));

        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);
        harness.stop();
    });

    it('prunes pending drafts when text boxes are discarded or deleted', () => {
        const harness = createSurfaceHarness();
        const createTextBox = (id: string) => harness.annotationApplication.value.store.createTextBox({
            kind: 'text-box',
            ...baseEntity(id),
            text: '',
            rect,
            rotation: 0,
            fontSize: 14,
            color: '#111827',
        });
        const markPending = (id: string) => harness.surface.setTextBoxDraftPending(asAnnotationId(id));

        const discarded = createTextBox('discarded-pending-text-box');
        const discardUnrelated = createTextBox('discard-unrelated-pending-text-box');
        markPending(discarded.identity.id);
        markPending(discardUnrelated.identity.id);
        expect(harness.surface.discardUnsavedAnnotation(discarded.identity.id)).toBe(true);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(discardUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        const deleted = createTextBox('deleted-pending-text-box');
        const deleteUnrelated = createTextBox('delete-unrelated-pending-text-box');
        markPending(deleted.identity.id);
        markPending(deleteUnrelated.identity.id);
        expect(harness.surface.deleteAnnotation(deleted.identity.id)).toBe(true);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(deleteUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        const selected = createTextBox('selection-pending-text-box');
        const selectionUnrelated = createTextBox('selection-unrelated-pending-text-box');
        markPending(selected.identity.id);
        markPending(selectionUnrelated.identity.id);
        harness.surface.select([selected.identity.id]);
        harness.surface.deleteSelection();
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(true);
        harness.surface.clearTextBoxDraftPending(selectionUnrelated.identity.id);
        expect(harness.surface.hasPendingTextBoxDrafts()).toBe(false);

        harness.stop();
    });

    it('discards a never-saved text box without leaving a tombstone or undo command', () => {
        const harness = createSurfaceHarness();
        const created = harness.surface.createTextBoxAt(0, rect);

        expect(harness.surface.discardUnsavedAnnotation(created.identity.id)).toBe(true);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        expect(harness.annotationApplication.value.store.get(created.identity.id)).toBeNull();
        expect(harness.annotationApplication.value.store.canUndo).toBe(false);
        expect(harness.surface.discardUnsavedAnnotation(created.identity.id)).toBe(false);

        harness.stop();
    });
});
