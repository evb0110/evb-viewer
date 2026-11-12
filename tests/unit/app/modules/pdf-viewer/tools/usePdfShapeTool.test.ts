import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    shallowRef,
    watch,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/usePdfShapeTool';
import {
    createDrawingShape,
    finishDrawingShape,
    updateDrawingShapeForPoint,
} from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';
import {
    AnnotationApplication,
    toCanonicalShapeEntity,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    asAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {buildNativeShapesMutationForSave} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import {requirePageIndex} from '@contracts/pageNumbers';

function createShapeProjection() {
    const application = shallowRef(new AnnotationApplication('doc-key'));
    // Stands in for the editor surface's live entities, which hasShapes reads.
    const entitiesByPage = shallowRef<ReadonlyMap<number, readonly AnnotationEntity[]>>(new Map());
    const scope = effectScope();
    const shapes = scope.run(() => {
        watch(application, (current, _previous, onCleanup) => onCleanup(current.store.subscribe((entities) => {
            entitiesByPage.value = new Map([[0, entities.filter(entity => !entity.deleted)]]);
        })), {
            immediate: true,
            flush: 'sync',
        });
        return usePdfShapeTool({
            annotationApplication: application,
            entitiesByPage,
            markModified: () => undefined,
        });
    })!;
    return {
        application,
        shapes,
        store: application.value.store,
    };
}

function createEmbeddedShape(): IShapeAnnotation {
    return {
        id: 'embedded-shape-1',
        type: 'rectangle',
        pageIndex: requirePageIndex(0),
        x: 0.1,
        y: 0.15,
        width: 0.2,
        height: 0.25,
        color: '#336699',
        fillColor: '#abcdef',
        opacity: 0.6,
        strokeWidth: 3,
        source: 'embedded',
        annotationId: '12R0',
        stableKey: 'evb-shape:embedded-rect-1',
        pdfSubtype: 'Square',
    };
}

function createEmbeddedInkShape(overrides?: Partial<IShapeAnnotation>): IShapeAnnotation {
    return {
        id: 'embedded-ink-1',
        type: 'polyline',
        pageIndex: requirePageIndex(0),
        x: 0.1,
        y: 0.2,
        width: 0.15,
        height: 0.15,
        color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
        opacity: DEFAULT_ANNOTATION_SETTINGS.inkOpacity,
        strokeWidth: DEFAULT_ANNOTATION_SETTINGS.inkThickness,
        points: [
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ],
        strokes: [[
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ]],
        source: 'embedded',
        annotationId: '21R',
        stableKey: 'evb-shape:embedded-ink-1',
        pdfSubtype: 'Ink',
        ...overrides,
    };
}

function shapeById(projection: ReturnType<typeof createShapeProjection>, id: string) {
    return projection.shapes.getAllShapes().find(shape => shape.id === id) ?? null;
}

function drawLocalShape(projection: ReturnType<typeof createShapeProjection>) {
    const origin = {
        x: 0.1,
        y: 0.2,
    };
    let draft = createDrawingShape(requirePageIndex(0), 'draw', origin.x, origin.y, DEFAULT_ANNOTATION_SETTINGS);
    let previous = origin;
    for (const point of [
        {
            x: 0.15,
            y: 0.25,
        },
        {
            x: 0.25,
            y: 0.35,
        },
    ]) {
        draft = updateDrawingShapeForPoint(draft, origin, point.x, point.y, previous);
        previous = point;
    }
    const created = finishDrawingShape(draft);
    expect(created).not.toBeNull();
    projection.application.value.store.createShape(toCanonicalShapeEntity(created!, asAnnotationId(created!.id)));
    return created!;
}

function replaceEmbeddedShapes(
    projection: ReturnType<typeof createShapeProjection>,
    shapes: readonly IShapeAnnotation[],
) {
    projection.application.value.store.replaceFromDocument(
        shapes.map(shape => toCanonicalShapeEntity(shape, asAnnotationId(shape.id))),
        [],
    );
}

function deleteShape(projection: ReturnType<typeof createShapeProjection>, shapeId: string) {
    const annotationId = projection.application.value.annotationIdForShape({
        id: shapeId,
        annotationId: shapeById(projection, shapeId)?.annotationId ?? null,
    });
    expect(annotationId).not.toBeNull();
    projection.application.value.store.delete(annotationId!);
}

describe('usePdfShapeTool', () => {
    it('renders the canonical store shapes instead of a second shape map', () => {
        const projection = createShapeProjection();
        replaceEmbeddedShapes(projection, [createEmbeddedShape()]);

        const [projected] = projection.shapes.getAllShapes();
        expect(projected).toMatchObject({
            id: 'embedded-shape-1',
            source: 'embedded',
        });

        // A projection copy is not authority: mutating it cannot change what the
        // store renders next.
        projected!.color = '#000000';
        expect(shapeById(projection, 'embedded-shape-1')?.color).toBe('#336699');

        const entity = projection.application.value.store.list()
            .find(candidate => candidate.kind === 'shape');
        expect(entity?.kind).toBe('shape');
        if (entity?.kind === 'shape') {
            projection.application.value.store.updateShape(entity.identity.id, {strokeColor: '#ff0000'});
        }
        expect(shapeById(projection, 'embedded-shape-1')?.color).toBe('#ff0000');
        expect(projection.shapes.getAllShapes()).toHaveLength(1);
    });

    it('does not mark imported embedded shapes as dirty until they change', () => {
        const projection = createShapeProjection();
        replaceEmbeddedShapes(projection, [createEmbeddedShape()]);

        expect(projection.shapes.hasShapes.value).toBe(true);

        const entity = projection.application.value.store.list()
            .find(candidate => candidate.kind === 'shape');
        expect(entity?.kind).toBe('shape');
        if (entity?.kind === 'shape') {
            projection.application.value.store.updateShape(entity.identity.id, {strokeColor: '#ff0000'});
        }

        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('reports shape dirty state without reacting to note mutations', () => {
        const projection = createShapeProjection();
        replaceEmbeddedShapes(projection, [createEmbeddedShape()]);

        const note = projection.application.value.store.createNote({
            kind: 'note',
            identity: {id: asAnnotationId('shape-dirty-note')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            contents: 'note',
            position: {
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
            color: null,
            createdAt: null,
            modifiedAt: null,
            author: null,
            open: false,
        });
        projection.application.value.store.updateNote(note.identity.id, {contents: 'edited'});

        expect(projection.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('derives deleted embedded refs from store tombstones and drops them when the delete is undone', () => {
        const projection = createShapeProjection();
        const embeddedShape = createEmbeddedShape();

        replaceEmbeddedShapes(projection, [embeddedShape]);
        deleteShape(projection, embeddedShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['12R']);
        expect(projection.shapes.hasShapes.value).toBe(false);

        projection.store.undo();

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getAllShapes()).toHaveLength(1);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('omits a retired Ink ref after delete-save-undo while preserving a changed live shape', () => {
        const projection = createShapeProjection();
        const retiredShape = createEmbeddedInkShape({
            id: 'retired-ink',
            stableKey: 'evb-shape:retired-ink',
            annotationId: '21R',
        });
        const liveShape = createEmbeddedInkShape({
            id: 'live-ink',
            stableKey: 'evb-shape:live-ink',
            annotationId: '22R',
            x: 0.4,
            y: 0.3,
        });

        replaceEmbeddedShapes(projection, [
            retiredShape,
            liveShape,
        ]);
        const retiredId = projection.application.value.annotationIdForShape(retiredShape);
        const liveId = projection.application.value.annotationIdForShape(liveShape);
        expect(retiredId).not.toBeNull();
        expect(liveId).not.toBeNull();

        projection.store.delete(retiredId!);
        const frontier = projection.store.beginSave();
        projection.store.markPersisted(frontier, [{
            annotationId: liveId!,
            pdfRef: '22R',
        }]);
        expect(projection.store.get(retiredId!)?.identity.pdfRef).toBeUndefined();

        expect(projection.store.undo()).toBe(true);
        expect(projection.store.get(retiredId!)).toMatchObject({deleted: false});
        expect(projection.store.get(retiredId!)?.identity.pdfRef).toBeUndefined();

        projection.store.updateShape(retiredId!, {strokeColor: '#dc2626'});
        projection.store.updateShape(liveId!, {strokeColor: '#16a34a'});

        const mutation = buildNativeShapesMutationForSave({
            shapeStateDirty: true,
            rewriteShapeState: false,
            totalPageCount: 1,
            shapes: projection.shapes.getAllShapes(),
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        });
        expect(mutation).not.toBeNull();
        const retiredNative = mutation!.shapes.find(shape => shape.color === '#dc2626');
        const liveNative = mutation!.shapes.find(shape => shape.annotationId === '22R');
        expect(retiredNative).toMatchObject({
            annotationId: null,
            color: '#dc2626',
        });
        expect(mutation!.shapes).toHaveLength(2);
        expect(liveNative).toMatchObject({
            annotationId: '22R',
            color: '#16a34a',
        });
    });

    it('keeps the creation time of a drawing and updates its modified time on canonical edits', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-25T10:00:00Z'));

        try {
            const projection = createShapeProjection();
            const created = drawLocalShape(projection);

            vi.setSystemTime(new Date('2026-05-25T10:02:00Z'));
            projection.store.updateShape(asAnnotationId(created.id), {strokeColor: '#ff0000'});

            const updated = shapeById(projection, created.id);
            expect(updated?.createdAt).toBe(new Date('2026-05-25T10:00:00Z').getTime());
            expect(updated?.modifiedAt).toBe(new Date('2026-05-25T10:02:00Z').getTime());
        } finally {
            vi.useRealTimers();
        }
    });

    it('adopts the parsed PDF reference while preserving a dirty local draw stroke', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            id: created.id,
            stableKey: created.stableKey,
            x: created.x,
            y: created.y,
            width: created.width,
            height: created.height,
            color: created.color,
            opacity: created.opacity,
            strokeWidth: created.strokeWidth,
            points: created.points,
            strokes: created.strokes,
        });

        replaceEmbeddedShapes(projection, [importedEmbeddedInkShape]);

        expect(shapeById(projection, created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '21R',
            pdfSubtype: 'Ink',
        });
        expect(shapeById(projection, created.id)?.points).toEqual(created.points);
        expect(projection.store.dirtyEntities().some(entity => entity.identity.id === asAnnotationId(created.id))).toBe(true);
    });

    it('keeps local shape geometry while the parsed document supplies its saved baseline', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);
        expect(projection.shapes.hasShapes.value).toBe(true);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '99R',
            stableKey: created.stableKey,
            x: created.x + 0.02,
            y: created.y + 0.03,
            points: created.points?.map(point => ({
                x: point.x + 0.02,
                y: point.y + 0.03,
            })),
            strokes: created.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.02,
                y: point.y + 0.03,
            }))),
        });

        replaceEmbeddedShapes(projection, [{
            ...importedEmbeddedInkShape,
            id: created.id,
        }]);

        expect(shapeById(projection, created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '99R',
            x: created.x,
            y: created.y,
        });
        expect(shapeById(projection, created.id)?.points).toEqual(created.points);
        expect(projection.shapes.hasShapes.value).toBe(true);
        expect(projection.store.dirtyEntities()).toHaveLength(1);
    });

    it('replaces parsed shapes in one batch without invalidating a captured save frontier', () => {
        const projection = createShapeProjection();
        const survivingEmbeddedShape = createEmbeddedShape();
        replaceEmbeddedShapes(projection, [survivingEmbeddedShape]);
        const created = drawLocalShape(projection);

        const frontier = projection.store.beginSave();
        replaceEmbeddedShapes(projection, [
            createEmbeddedShape(),
            createEmbeddedInkShape({
                id: created.id,
                annotationId: '77R',
                stableKey: created.stableKey,
            }),
        ]);

        // Parsed identity adoption does not change authored revisions, so a
        // captured frontier remains valid until an actual edit occurs.
        expect(() => projection.store.assertSaveFrontierCurrent(frontier)).not.toThrow();
        const createdId = projection.application.value.annotationIdForShape(created);
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBe('77R');
        expect(shapeById(projection, survivingEmbeddedShape.id)).not.toBeNull();

        const entity = projection.application.value.store.list()
            .find(candidate => candidate.kind === 'shape');
        expect(entity?.kind).toBe('shape');
        if (entity?.kind !== 'shape') {
            throw new Error('Expected a canonical shape');
        }
        projection.application.value.store.updateShape(entity.identity.id, {strokeColor: '#ff0000'});

        expect(() => projection.store.assertSaveFrontierCurrent(frontier))
            .toThrow(/staleRevisionError/u);
    });

    it('keeps a parsed identity when a save frontier is rolled back', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        replaceEmbeddedShapes(projection, [createEmbeddedInkShape({
            id: created.id,
            stableKey: created.stableKey,
        })]);
        const createdId = projection.application.value.annotationIdForShape(created);
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBe('21R');

        const frontier = projection.store.beginSave();
        expect(projection.store.rollbackToSaveFrontier(frontier)).toBe(true);

        expect(shapeById(projection, created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '21R',
        });
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBe('21R');
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('keeps local geometry when a later parse supplies self-saved metadata', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '88R',
            stableKey: created.stableKey,
            x: created.x + 0.02,
            y: created.y + 0.03,
        });

        replaceEmbeddedShapes(projection, [{
            ...importedEmbeddedInkShape,
            id: created.id,
        }]);

        expect(shapeById(projection, created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '88R',
            x: created.x,
            y: created.y,
        });
        expect(projection.store.dirtyEntities()).toHaveLength(1);
    });

    it('forgets a deleted shape only after its canonical deletion is persisted', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape();

        replaceEmbeddedShapes(projection, [embeddedInkShape]);
        deleteShape(projection, embeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(projection.shapes.hasShapes.value).toBe(false);

        const frontier = projection.store.beginSave();
        projection.store.markPersisted(frontier, []);
        replaceEmbeddedShapes(projection, []);

        expect(projection.shapes.getAllShapes()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('reconciles a persisted drawing by canonical id when the saved annotation ref changes', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            id: created.id,
            annotationId: '44R',
            stableKey: created.stableKey,
            x: created.x + 0.0002,
            y: created.y + 0.00015,
            points: created.points?.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            })),
            strokes: created.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            }))),
        });

        replaceEmbeddedShapes(projection, [importedEmbeddedInkShape]);

        expect(shapeById(projection, created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '44R',
            pdfSubtype: 'Ink',
        });
        expect(shapeById(projection, created.id)?.points).toEqual(created.points);
        expect(shapeById(projection, created.id)?.x).toBe(created.x);
        expect(projection.store.dirtyEntities()).toHaveLength(1);
    });

    it('uses parsed managed shape geometry as the saved baseline for a clean entity', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-current-ink',
            stableKey: 'evb-shape:current-ink',
            annotationId: '21R',
        });

        replaceEmbeddedShapes(projection, [embeddedInkShape]);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            id: 'shape-imported-ink',
            stableKey: embeddedInkShape.stableKey,
            annotationId: '44R',
            x: embeddedInkShape.x + 0.012,
            y: embeddedInkShape.y + 0.015,
            strokeWidth: embeddedInkShape.strokeWidth + 2,
            opacity: 0.5,
        });

        replaceEmbeddedShapes(projection, [{
            ...importedEmbeddedInkShape,
            id: embeddedInkShape.id,
        }]);

        expect(shapeById(projection, embeddedInkShape.id)).toMatchObject({
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '44R',
            pdfSubtype: 'Ink',
        });
        expect(projection.store.dirtyEntities()).toHaveLength(0);
    });

    it('keeps unmatched local shapes dirty when a late same-file import reconciles saved embedded shapes', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-saved-ink',
            stableKey: 'evb-shape:saved-ink',
            annotationId: '41R',
        });

        replaceEmbeddedShapes(projection, [embeddedInkShape]);
        const localShape = drawLocalShape(projection);

        replaceEmbeddedShapes(projection, [createEmbeddedInkShape({
            ...embeddedInkShape,
            id: embeddedInkShape.id,
            annotationId: '52R',
            x: embeddedInkShape.x + 0.01,
            y: embeddedInkShape.y + 0.01,
        })]);

        expect(shapeById(projection, embeddedInkShape.id)).toMatchObject({
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '52R',
        });
        expect(shapeById(projection, localShape.id)).toMatchObject({id: localShape.id});
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('keeps deleted embedded shape tombstones while the deletion is dirty', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape();

        replaceEmbeddedShapes(projection, [embeddedInkShape]);
        deleteShape(projection, embeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.hasShapes.value).toBe(false);

        replaceEmbeddedShapes(projection, [embeddedInkShape]);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(projection.shapes.hasShapes.value).toBe(false);

        replaceEmbeddedShapes(projection, []);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('does not resurrect a just-deleted embedded shape when a stale import finishes after the delete', () => {
        const projection = createShapeProjection();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
        });

        replaceEmbeddedShapes(projection, [
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);
        deleteShape(projection, secondEmbeddedInkShape.id);

        replaceEmbeddedShapes(projection, [
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);

        expect(projection.shapes.getAllShapes()).toHaveLength(1);
        expect(projection.shapes.getAllShapes()[0]).toMatchObject({
            id: firstEmbeddedInkShape.id,
            annotationId: firstEmbeddedInkShape.annotationId,
        });
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['22R']);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('marks the current shapes as the saved baseline and clears deleted embedded tombstones', () => {
        const projection = createShapeProjection();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
        });

        replaceEmbeddedShapes(projection, [
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);
        deleteShape(projection, firstEmbeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        const frontier = projection.store.beginSave();
        projection.store.markPersisted(frontier, []);
        replaceEmbeddedShapes(projection, [secondEmbeddedInkShape]);

        expect(projection.shapes.getAllShapes().map(shape => shape.id)).toEqual([secondEmbeddedInkShape.id]);
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('refuses a prepared clean mark once another document owns the projection', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);

        // The save primed the previous document; the viewer has since adopted
        // another one, whose shapes this save says nothing about.
        projection.application.value = new AnnotationApplication('other-doc-key');
        drawLocalShape(projection);

        expect(projection.shapes.getAllShapes()).toHaveLength(1);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('marks the live store clean through its captured save frontier', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);
        const frontier = projection.store.beginSave();

        projection.store.markPersisted(frontier, []);
        expect(projection.store.dirtyEntities()).toHaveLength(0);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('marks the live store clean when a save had nothing to prime', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);

        const frontier = projection.store.beginSave();
        projection.store.markPersisted(frontier, []);
        expect(projection.store.dirtyEntities()).toHaveLength(0);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('replaces the projection when the authority is swapped for another document', () => {
        const projection = createShapeProjection();
        replaceEmbeddedShapes(projection, [createEmbeddedShape()]);
        expect(projection.shapes.getAllShapes()).toHaveLength(1);

        projection.application.value = new AnnotationApplication('other-doc-key');

        expect(projection.shapes.getAllShapes()).toEqual([]);
    });
});
