import {afterEach, describe, expect, it, vi} from 'vitest';
import {computed, effectScope, shallowRef} from 'vue';
import {DEFAULT_ANNOTATION_SETTINGS} from '@app/constants/annotationDefaults';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {usePdfAppAnnotationHistory} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import {
    usePdfAnnotationEditorSurface,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import {useAnnotationStoreSnapshot} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDocumentAnnotations';
import {
    annotationPageDimensions,
    rotatedAnnotationBounds,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import type {IAnnotationMarkerRect, TAnnotationTool} from '@app/types/annotations';
import {useAnnotationPointerGesture} from '@app/modules/pdf-viewer/annotations/editor/useAnnotationPointerGesture';
import {textNoteIconRect} from '@app/modules/pdf-viewer/engine/annotation-geometry/textNoteIconRect';
import {nativeNoteGeometryProjection} from '@app/modules/pdf-viewer/annotations/persistence/nativeNoteGeometryProjection';
import {createComment} from '@tests/unit/app/services/pdf-save/createComment';
import type {TPageRotation} from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

const activeScopes = new Set<ReturnType<typeof effectScope>>();

function createSurfaceHarness(
    options: {
        getPageGeometry?: IAnnotationEditorSurface['getPageGeometry'];
        withHistory?: boolean;
    } = {},
) {
    const isActive = shallowRef(true);
    const emitAnnotationModified = vi.fn();
    const emitShapeContextMenu = vi.fn();
    const onCreationCompleted = vi.fn();
    const draftTexts = new Map<string, string>();
    const onTextBoxDraftChanged = (id: string, text: string | null) => {
        if (text === null) {
            draftTexts.delete(id);
        } else {
            draftTexts.set(id, text);
        }
    };
    const scope = effectScope();
    activeScopes.add(scope);
    const history = options.withHistory
        ? scope.run(() =>
              usePdfAppAnnotationHistory({
                  emitAnnotationState: vi.fn(),
                  markModified: vi.fn(),
              }),
          )
        : undefined;
    const store = history
        ? new AnnotationStore({
              get canUndo() {
                  return history.canUndo.value;
              },
              get canRedo() {
                  return history.canRedo.value;
              },
              registerCommand: history.registerCommand,
              forgetCommands: history.forgetCommands,
              undo: history.undo,
              redo: history.redo,
          })
        : undefined;
    const annotationApplication = shallowRef(new AnnotationApplication('surface-rotation-test', store));
    const surface = scope.run(() =>
        usePdfAnnotationEditorSurface({
            annotationApplication,
            entitiesByPage: useAnnotationStoreSnapshot(annotationApplication).entitiesByPage,
            isActive: computed(() => isActive.value),
            activeTool: computed<TAnnotationTool>(() => 'select'),
            settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            emitAnnotationModified,
            emitShapeContextMenu,
            onCreationCompleted,
            onTextBoxDraftChanged,
            getTextBoxDraftText: (id) => draftTexts.get(id) ?? null,
            ...(options.getPageGeometry ? {getPageGeometry: options.getPageGeometry} : {}),
            ...(history ? {runHistoryTransaction: history.runTransaction} : {}),
        }),
    )!;
    return {
        annotationApplication,
        emitAnnotationModified,
        history,
        surface,
    };
}

describe('usePdfAnnotationEditorSurface rotation', () => {
    const portraitGeometry = {
        pageView: [0, 0, 600, 1000],
        rotation: 0 as const,
    };

    it('rotates each selected text and image by its own angle in one undoable operation', () => {
        const {surface, annotationApplication} = createSurfaceHarness({
            getPageGeometry: () => portraitGeometry,
            withHistory: true,
        });
        const box = surface.createTextBoxAt(
            0,
            {
                ...rect,
                left: 0.4,
                top: 0.4,
            },
            {rotation: 270},
        );
        const image = surface.createStampAt(
            0,
            {
                ...rect,
                left: 0.4,
                top: 0.6,
            },
            {
                objectNumber: 10,
                generationNumber: 0,
                byteLength: 4,
                sha256: 'a'.repeat(64),
            },
            {rotation: 37},
        );
        surface.select([box.identity.id, image.identity.id]);
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

    it.each([0, 90] as const)('translates a quarter-turned box inside a nonsquare page with page rotation %s', (pageRotation) => {
        const geometry = {
            ...portraitGeometry,
            rotation: pageRotation,
        };
        const {surface, annotationApplication} = createSurfaceHarness({getPageGeometry: () => geometry});
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
        if (updated?.kind !== 'text-box') {
            throw new Error('Text box missing');
        }
        expect(updated.rotation).toBe(270);
        expect(updated.rect.width).toBe(box.rect.width);
        expect(updated.rect.height).toBe(box.rect.height);
        expect(updated.fontSize).toBe(box.fontSize);
        const bounds = rotatedAnnotationBounds(
            updated.rect,
            updated.rotation,
            annotationPageDimensions(geometry.pageView, geometry.rotation),
        );
        expect(bounds.left).toBeGreaterThanOrEqual(-1e-12);
        expect(bounds.top).toBeGreaterThanOrEqual(-1e-12);
        expect(bounds.left + bounds.width).toBeLessThanOrEqual(1 + 1e-12);
        expect(bounds.top + bounds.height).toBeLessThanOrEqual(1 + 1e-12);
        if (pageRotation === 0) {
            expect(updated.rect.top).toBeCloseTo(0.015, 12);
        } else {
            expect(updated.rect.top).toBeCloseTo(0.175);
        }
    });

    it('checks pending text read-only and commits before rotation', async () => {
        const {surface, annotationApplication, history} = createSurfaceHarness({
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
            if (refuseCompletion) {
                throw new DOMException('Draft protection was refused', 'AbortError');
            }
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
            getTextBoxDraftRect: (id) => (id === box.identity.id ? draftRect.value : null),
        });
        await surface.beginTextEditing(box.identity.id);
        surface.setTextBoxDraftPending(box.identity.id, 'Pending text');
        const original = annotationApplication.value.store.list();
        const selection = [...surface.selectedIds.value];
        const historyBefore = [history!.canUndo.value, history!.canRedo.value];
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
        expect([history!.canUndo.value, history!.canRedo.value]).toEqual(historyBefore);
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
        if (updated?.kind !== 'text-box') {
            throw new Error('Text box missing');
        }
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
        const {surface, annotationApplication} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const box = surface.createTextBoxAt(0, rect);
        const draftRect = {
            left: 0.01,
            top: 0.01,
            width: 0.3,
            height: 0.15,
        };

        surface.registerPageInteraction(0, {
            commitTextDraft: () => {
                throw new Error('Empty editor must remain open');
            },
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
        if (updated?.kind !== 'text-box') {
            throw new Error('Text box missing');
        }
        expect(updated.rect.top).toBeCloseTo(0.015, 12);
    });

    it('does not read draft geometry outside an active text editing session', async () => {
        const {surface, annotationApplication} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
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
            commitTextDraft: () => {
                throw new Error('No-op entry must not complete');
            },
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
        const {surface, annotationApplication} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const image = surface.createStampAt(
            0,
            {
                left: 0.4,
                top: 0.89,
                width: 0.18,
                height: 0.1,
            },
            {
                objectNumber: 10,
                generationNumber: 0,
                byteLength: 4,
                sha256: 'a'.repeat(64),
            },
            {rotation: 10},
        );
        surface.select([image.identity.id]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(true);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(true);
        const updated = annotationApplication.value.store.get(image.identity.id);
        if (updated?.kind !== 'placed-image') {
            throw new Error('Image missing');
        }
        expect(updated.rotation).toBe(100);
        expect(updated.rect.left).toBe(image.rect.left);
        expect(updated.rect.top).toBeLessThan(image.rect.top);
        expect(updated.rect.width).toBe(image.rect.width);
        expect(updated.rect.height).toBe(image.rect.height);
        const bounds = rotatedAnnotationBounds(
            updated.rect,
            updated.rotation,
            annotationPageDimensions(portraitGeometry.pageView, portraitGeometry.rotation),
        );
        expect(bounds.top + bounds.height).toBeCloseTo(1, 12);
    });

    it('rejects the entire rotation and other property changes when one selected box cannot fit', () => {
        const {surface, annotationApplication, emitAnnotationModified} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
        const small = surface.createTextBoxAt(0, rect);
        const tall = surface.createTextBoxAt(0, {
            left: 0.1,
            top: 0.05,
            width: 0.1,
            height: 0.9,
        });
        surface.select([small.identity.id, tall.identity.id]);
        const original = annotationApplication.value.store.list();
        const update = vi.spyOn(annotationApplication.value.store, 'updateTextBox');
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(
            surface.updateSelectedAnnotationProperties({
                rotationDelta: 90,
                color: '#123456',
            }),
        ).toBe(false);
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
        surface.select([box.identity.id, note.identity.id]);
        expect(surface.canRotateSelectedAnnotations(90)).toBe(false);
        expect(surface.updateSelectedAnnotationProperties({rotationDelta: 90})).toBe(false);
    });

    it('preserves absolute rotation updates and applies the same bounds admission', () => {
        const {surface, annotationApplication} = createSurfaceHarness({getPageGeometry: () => portraitGeometry});
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
        expect(
            surface.updateSelectedAnnotationProperties({
                rotation: 180,
                rotationDelta: 90,
            }),
        ).toBe(false);
    });

    afterEach(() => {
        for (const scope of activeScopes) {
            scope.stop();
        }
        activeScopes.clear();
    });
});

describe('usePdfAnnotationEditorSurface note icon', () => {
    // A non-square page with an offset origin, so swapped axes and the view origin both show.
    const pageView = [10, 20, 610, 1020];
    const rotations: TPageRotation[] = [0, 90, 180, 270];
    const marker = (x: number, y: number): IAnnotationMarkerRect => ({
        left: x - 0.0008,
        top: y - 0.0008,
        width: 0.0016,
        height: 0.0016,
    });
    const center = (position: IAnnotationMarkerRect) => ({
        x: position.left + position.width / 2,
        y: position.top + position.height / 2,
    });
    // The page as displayed with its /Rotate, in points.
    const displayedSize = (rotation: TPageRotation) =>
        rotation === 90 || rotation === 270 ? {width: 1000, height: 600} : {width: 600, height: 1000};

    function createNoteHarness(rotation: TPageRotation, view: number[] = pageView) {
        let geometry: {pageView: number[]; rotation: TPageRotation} | null = {pageView: view, rotation};
        const harness = createSurfaceHarness({getPageGeometry: () => geometry});
        const scope = effectScope();
        activeScopes.add(scope);
        const gesture = scope.run(() => useAnnotationPointerGesture({surface: harness.surface, pageIndex: 0}))!;
        const notePosition = (id: string) => {
            const entity = harness.surface.entitiesByPage.value.get(0)?.find((candidate) => candidate.identity.id === id);
            if (entity?.kind !== 'note') {
                throw new Error('note missing');
            }
            return entity.position;
        };
        const setGeometryKnown = (known: boolean) => {
            geometry = known ? {pageView: view, rotation} : null;
        };
        return {...harness, gesture, notePosition, setGeometryKnown};
    }

    it.each(rotations)('places a corner note where the writer saves its 20 pt icon on a %i degree page', (rotation) => {
        const {surface, notePosition} = createNoteHarness(rotation);
        const page = displayedSize(rotation);
        const topLeft = surface.createNoteAt(0, marker(0.003, 0.002));
        const bottomRight = surface.createNoteAt(0, marker(0.998, 0.999));
        const middle = surface.createNoteAt(0, marker(0.5, 0.25));

        expect(notePosition(topLeft.identity.id).width * page.width).toBeCloseTo(20, 9);
        expect(notePosition(topLeft.identity.id).height * page.height).toBeCloseTo(20, 9);
        expect(center(notePosition(topLeft.identity.id)).x * page.width).toBeCloseTo(10, 9);
        expect(center(notePosition(topLeft.identity.id)).y * page.height).toBeCloseTo(10, 9);
        expect((1 - center(notePosition(bottomRight.identity.id)).x) * page.width).toBeCloseTo(10, 9);
        expect((1 - center(notePosition(bottomRight.identity.id)).y) * page.height).toBeCloseTo(10, 9);
        // Away from an edge the icon keeps the marker's centre.
        expect(center(notePosition(middle.identity.id)).x).toBeCloseTo(0.5, 12);
        expect(center(notePosition(middle.identity.id)).y).toBeCloseTo(0.25, 12);
    });

    it.each(rotations)('keeps a dragged or nudged note icon inside a %i degree page', (rotation) => {
        const {surface, gesture, notePosition} = createNoteHarness(rotation);
        const page = displayedSize(rotation);
        const note = surface.createNoteAt(0, marker(0.5, 0.5));
        const pointer = {clientX: 0, clientY: 0, pointerId: 1};

        surface.select([note.identity.id]);
        expect(gesture.beginMove(note.identity.id, {x: 0.5, y: 0.5}, pointer)).toBe(true);
        gesture.update({x: -3, y: 4}, {...pointer, clientX: 500, clientY: 500});
        const dragged = gesture.previewRect.value!;
        expect(center(dragged).x * page.width).toBeCloseTo(10, 9);
        expect((1 - center(dragged).y) * page.height).toBeCloseTo(10, 9);
        gesture.cancel();

        // A diagonal nudge keeps its direction, so push each axis to its edge on its own.
        surface.nudgeSelectionByPdfPoints(-5_000, 0, pageView, rotation);
        surface.nudgeSelectionByPdfPoints(0, -5_000, pageView, rotation);
        const nudged = notePosition(note.identity.id);
        expect(center(nudged).x * page.width).toBeCloseTo(10, 9);
        expect(center(nudged).y * page.height).toBeCloseTo(10, 9);
        // What the writer would save for the nudged note is where the note already is.
        expect(textNoteIconRect(nudged, pageView, rotation)).toEqual(nudged);
    });

    it('keeps a note dragged to the right edge of a letter page within the bounds its save accepts', () => {
        const letter = [0, 0, 612, 792];
        const {surface, gesture, notePosition} = createNoteHarness(0, letter);
        // The imported /Text note at /Rect [29 300 49 320].
        const note = surface.createNoteAt(0, {
            left: 29 / 612,
            top: (792 - 320) / 792,
            width: 20 / 612,
            height: 20 / 792,
        });
        const pointer = {clientX: 0, clientY: 0, pointerId: 1};

        surface.select([note.identity.id]);
        expect(gesture.beginMove(note.identity.id, {x: 0.5, y: 0.5}, pointer)).toBe(true);
        const completion = gesture.finish({x: 5, y: 0.5}, {...pointer, clientX: 900});
        surface.commitGesture(completion!.gesture!, {position: completion!.rect});
        const position = notePosition(note.identity.id);

        expect(position.left + position.width).toBeLessThanOrEqual(1);
        expect((1 - center(position).x) * 612).toBeCloseTo(10, 9);
        expect(nativeNoteGeometryProjection([createComment({markerRect: position})]).value).toHaveLength(1);
    });

    it.each(rotations)('stops an imported 10 pt note where the writer saves it on a %i degree page', (rotation) => {
        const {surface, gesture, notePosition, setGeometryKnown} = createNoteHarness(rotation);
        const page = displayedSize(rotation);
        const tenPoint = (x: number, y: number): IAnnotationMarkerRect => ({
            left: x - 5 / page.width,
            top: y - 5 / page.height,
            width: 10 / page.width,
            height: 10 / page.height,
        });
        // Imported before the page geometry is known, so each keeps its 10 pt rect.
        setGeometryKnown(false);
        const dragged = surface.createNoteAt(0, tenPoint(0.5, 0.5));
        const nudged = surface.createNoteAt(0, tenPoint(0.5, 0.25));
        setGeometryKnown(true);
        expect(notePosition(dragged.identity.id).width * page.width).toBeCloseTo(10, 9);
        const pointer = {clientX: 0, clientY: 0, pointerId: 1};

        surface.select([dragged.identity.id]);
        expect(gesture.beginMove(dragged.identity.id, {x: 0.5, y: 0.5}, pointer)).toBe(true);
        gesture.update({x: -3, y: 0.5}, {...pointer, clientX: 500});
        // The preview already stops where the note will be saved.
        expect(center(gesture.previewRect.value!).x * page.width).toBeCloseTo(10, 9);
        const completion = gesture.finish({x: -3, y: 0.5}, {...pointer, clientX: 500});
        surface.commitGesture(completion!.gesture!, {position: completion!.rect});
        expect(center(notePosition(dragged.identity.id)).x * page.width).toBeCloseTo(10, 9);
        expect(center(notePosition(dragged.identity.id)).y).toBeCloseTo(0.5, 12);

        surface.select([nudged.identity.id]);
        surface.nudgeSelectionByPdfPoints(0, -5_000, pageView, rotation);
        expect(center(notePosition(nudged.identity.id)).y * page.height).toBeCloseTo(10, 9);
        expect(textNoteIconRect(notePosition(nudged.identity.id), pageView, rotation)).toEqual(notePosition(nudged.identity.id));
    });

    it.each([
        [[0, 0, 15, 792], 0],
        [[0, 0, 612, 15], 90],
        [[0, 0, 19.99, 19.99], 180],
    ] as const)('keeps the marker where the writer refuses a note on a page under 20 pt (%j at %i degrees)', (tinyView, rotation) => {
        const {surface} = createSurfaceHarness({getPageGeometry: () => ({pageView: [...tinyView], rotation})});
        const position = marker(0.5, 0.5);

        expect(textNoteIconRect(position, tinyView, rotation)).toBeNull();
        expect(surface.createNoteAt(0, position).position).toEqual(position);
    });

    it('keeps the marker until the page geometry is known', () => {
        const {surface} = createSurfaceHarness();
        const position = marker(0.001, 0.001);

        expect(surface.createNoteAt(0, position).position).toEqual(position);
    });

    afterEach(() => {
        for (const scope of activeScopes) {
            scope.stop();
        }
        activeScopes.clear();
    });
});
