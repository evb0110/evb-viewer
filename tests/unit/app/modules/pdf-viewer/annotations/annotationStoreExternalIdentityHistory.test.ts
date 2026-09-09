import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AnnotationStore,
    type IAnnotationHistoryAuthority,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {IPdfAppAnnotationHistoryCommand} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {ExternalIdentityConflictError} from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {AnnotationHistoryCompensationError} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {
    asAnnotationId,
    type INoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function identity(id: string, pdfRef?: string) {
    return pdfRef === undefined
        ? {id: asAnnotationId(id)}
        : {
            id: asAnnotationId(id),
            pdfRef,
        };
}

function note(
    id: string,
    pdfRef?: string,
    overrides: Partial<INoteEntity> = {},
): INoteEntity {
    return {
        kind: 'note',
        identity: identity(id, pdfRef),
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: null,
        contents: '',
        position: rect,
        color: '#ffff00',
        open: false,
        ...overrides,
    };
}

function textMarkup(
    id: string,
    pdfRef: string,
    overrides: Partial<ITextMarkupEntity> = {},
): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: identity(id, pdfRef),
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: null,
        subtype: 'Highlight',
        contents: '',
        quadPoints: [rect],
        color: '#ffff00',
        opacity: 1,
        ...overrides,
    };
}

function persist(store: AnnotationStore, id: string, pdfRef: string) {
    store.markPersisted(store.beginSave(), [{
        annotationId: asAnnotationId(id),
        pdfRef,
    }]);
}

describe('AnnotationStore external identity history', () => {
    it('releases a created PDF identity on undo and restores it on redo', () => {
        const store = new AnnotationStore();
        const entity = note('original-note', '1R');

        store.createNote(entity);
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(entity.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '1R'})).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(entity.identity.id);
    });

    it('rolls back a canonical undo that throws after mutating and keeps it retryable', () => {
        const store = new AnnotationStore();
        const entity = note('retryable-note', '2R');
        const replayFailure = new Error('projection listener failed');
        store.createNote(entity);
        let failNextEmission = false;
        store.subscribe(() => {
            if (!failNextEmission) {
                return;
            }
            failNextEmission = false;
            throw replayFailure;
        });

        failNextEmission = true;
        let received: unknown;
        try {
            store.undo();
        } catch (error) {
            received = error;
        }

        expect(received).toBe(replayFailure);
        expect(store.get(entity.identity.id)).toEqual(entity);
        expect(store.resolveExternal({pdfRef: '2R'})).toBe(entity.identity.id);
        expect(store.canUndo).toBe(true);
        expect(store.canRedo).toBe(false);

        expect(store.undo()).toBe(true);
        expect(store.get(entity.identity.id)).toMatchObject({deleted: true});
        expect(store.resolveExternal({pdfRef: '2R'})).toBeNull();
        expect(store.canRedo).toBe(true);
    });

    it('clears canonical history and reports every failed rollback after an undo emission fails', () => {
        const store = new AnnotationStore();
        const entity = note('poisoned-note', '3R');
        const replayFailure = new Error('projection listener failed');
        const rollbackFailure = new Error('rollback projection listener failed');
        const failures: Error[] = [];
        store.createNote(entity);
        store.subscribe(() => {
            const failure = failures.shift();
            if (failure) throw failure;
        });
        failures.push(replayFailure, rollbackFailure);

        let received: unknown;
        try {
            store.undo();
        } catch (error) {
            received = error;
        }

        expect(received).toBeInstanceOf(AnnotationHistoryCompensationError);
        expect((received as AnnotationHistoryCompensationError).cause).toBe(replayFailure);
        expect((received as AnnotationHistoryCompensationError).rollbackErrors).toEqual([rollbackFailure]);
        expect(store.get(entity.identity.id)).toEqual(entity);
        expect(store.resolveExternal({pdfRef: '3R'})).toBe(entity.identity.id);
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
    });

    it('lets a deleted identity be recreated and follows both entities through history', () => {
        const store = new AnnotationStore();
        const original = note('original-note', '4R');
        const recreated = note('recreated-note', '4R');
        store.createNote(original);

        store.delete(original.identity.id);
        expect(store.resolveExternal({pdfRef: '4R'})).toBeNull();

        expect(() => store.createNote(recreated)).not.toThrow();
        expect(store.resolveExternal({pdfRef: '4R'})).toBe(recreated.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '4R'})).toBeNull();
        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '4R'})).toBe(original.identity.id);

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '4R'})).toBeNull();
        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '4R'})).toBe(recreated.identity.id);
    });

    it('updates the identity index with a batched markup selection through undo and redo', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('created-markup', '5R');

        store.applyTextMarkupSelection(markup, []);
        expect(store.resolveExternal({pdfRef: '5R'})).toBe(markup.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '5R'})).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '5R'})).toBe(markup.identity.id);
    });

    it('merges connected same-color highlights into one persisted identity with one undo step', () => {
        const store = new AnnotationStore();
        const firstQuad = {
            left: 0.1,
            top: 0.2,
            width: 0.35,
            height: 0.04,
        };
        const secondQuad = {
            left: 0.4,
            top: 0.2,
            width: 0.35,
            height: 0.04,
        };
        const first = store.createTextMarkup(textMarkup('first-highlight', '6R', {
            contents: 'authored note',
            quadPoints: [firstQuad],
            selectedText: 'first text',
        }));
        const second = store.createTextMarkup(textMarkup('second-highlight', '7R', {
            quadPoints: [secondQuad],
            selectedText: 'second text',
        }));
        store.markPersisted(store.beginSave(), [
            {
                annotationId: first.identity.id,
                pdfRef: '6R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '7R',
            },
        ]);
        const created: ITextMarkupEntity = textMarkup('new-highlight', 'editor-ref', {
            identity: {id: asAnnotationId('new-highlight')},
            persistedRevision: -1,
            color: 'rgb(255, 255, 0)',
            opacity: 0.65,
            quadPoints: [{
                left: 0.05,
                top: 0.2,
                width: 0.8,
                height: 0.04,
            }],
            selectedText: 'new text',
        });

        const projection = store.applyTextMarkupSelection(created, []);

        expect(projection.created.identity.id).toBe(first.identity.id);
        expect(store.list()).toHaveLength(1);
        expect(store.get(first.identity.id)).toMatchObject({
            identity: {
                id: first.identity.id,
                pdfRef: '6R',
            },
            contents: 'authored note',
            color: 'rgb(255, 255, 0)',
            opacity: 0.65,
            selectedText: 'new text',
            quadPoints: [{
                left: 0.05,
                top: 0.2,
                width: 0.8,
                height: 0.04,
            }],
        });
        expect(store.get(second.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '7R'},
        });
        expect(store.get(created.identity.id)).toBeNull();
        expect(store.dirtyEntities().map(entity => [
            entity.identity.id,
            entity.deleted,
        ])).toEqual([
            [
                first.identity.id,
                false,
            ],
            [
                second.identity.id,
                true,
            ],
        ]);
        const mergePlan = buildSerializationPlan(
            store.beginSave(),
            store.dirtyEntities(),
            store.list({includeDeleted: true}),
        );
        expect(mergePlan.steps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                annotationId: first.identity.id,
                operation: 'write-text-markup',
            }),
            expect.objectContaining({
                annotationId: second.identity.id,
                operation: 'delete-annotation',
                fields: expect.objectContaining({identity: expect.objectContaining({pdfRef: '7R'})}),
            }),
        ]));

        expect(store.undo()).toBe(true);
        expect(store.list()).toHaveLength(2);
        expect(store.get(first.identity.id)).toMatchObject({
            contents: 'authored note',
            quadPoints: [firstQuad],
            opacity: 1,
        });
        expect(store.get(second.identity.id)).toMatchObject({
            deleted: false,
            quadPoints: [secondQuad],
        });
        expect(store.get(created.identity.id)).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.list()).toHaveLength(1);
        expect(store.get(first.identity.id)).toMatchObject({
            contents: 'authored note',
            opacity: 0.65,
        });
        expect(store.get(second.identity.id)?.deleted).toBe(true);

        store.applyTextMarkupSelection(textMarkup('repeat-highlight', 'repeat-editor', {
            identity: {id: asAnnotationId('repeat-highlight')},
            color: '#ffff00',
            opacity: 0.65,
            quadPoints: [{
                left: 0.05,
                top: 0.2,
                width: 0.8,
                height: 0.04,
            }],
            selectedText: 'new text',
        }), []);
        // An identical gesture does not add a no-op history entry. The next
        // undo still removes the original merge in one step.
        expect(store.undo()).toBe(true);
        expect(store.get(first.identity.id)).toMatchObject({
            quadPoints: [firstQuad],
            opacity: 1,
        });
        expect(store.get(second.identity.id)).toMatchObject({deleted: false});
    });

    it('keeps distant and differently colored highlights separate', () => {
        const store = new AnnotationStore();
        const existing = store.createTextMarkup(textMarkup('separate-existing', '8R'));
        const distant = textMarkup('separate-distant', 'distant-editor', {
            identity: {id: asAnnotationId('separate-distant')},
            quadPoints: [{
                left: 0.8,
                top: 0.2,
                width: 0.1,
                height: 0.04,
            }],
        });
        const differentColor = textMarkup('separate-color', 'color-editor', {
            identity: {id: asAnnotationId('separate-color')},
            color: '#00ff00',
            quadPoints: [{
                left: 0.1,
                top: 0.2,
                width: 0.1,
                height: 0.04,
            }],
        });

        const distantProjection = store.applyTextMarkupSelection(distant, []);
        const differentColorProjection = store.applyTextMarkupSelection(differentColor, []);

        expect(distantProjection.created.identity.id).toBe(distant.identity.id);
        expect(differentColorProjection.created.identity.id).toBe(differentColor.identity.id);
        expect(store.list().map(entity => entity.identity.id)).toEqual([
            existing.identity.id,
            distant.identity.id,
            differentColor.identity.id,
        ]);
    });

    it('stores a non-overlapping union for highlights with different line bands', () => {
        const store = new AnnotationStore();
        const existing = store.createTextMarkup(textMarkup('band-existing', '9R', {quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.6,
            height: 0.06,
        }]}));
        const created = textMarkup('band-created', 'band-editor', {
            identity: {id: asAnnotationId('band-created')},
            quadPoints: [{
                left: 0.4,
                top: 0.23,
                width: 0.4,
                height: 0.06,
            }],
        });

        store.applyTextMarkupSelection(created, []);

        const geometryEntity = store.get(existing.identity.id);
        if (geometryEntity?.kind !== 'text-markup') {
            throw new Error('expected the merged highlight to remain a text markup');
        }
        const geometry = geometryEntity.quadPoints;
        expect(geometry.length).toBeGreaterThan(1);
        geometry.forEach((left, leftIndex) => {
            geometry.slice(leftIndex + 1).forEach((right) => {
                expect(
                    left.left + left.width <= right.left
                    || right.left + right.width <= left.left
                    || left.top + left.height <= right.top
                    || right.top + right.height <= left.top,
                ).toBe(true);
            });
        });
    });

    it('merges rounded PDF geometry without producing empty save quads', () => {
        const store = new AnnotationStore();
        const saved = textMarkup('saved-rounded', '40R', {
            persistedRevision: 0,
            quadPoints: [
                {
                    left: 0.285818,
                    top: 0.115957,
                    width: 0.07613403,
                    height: 0.124703,
                },
                {
                    left: 0.285818,
                    top: 0.269771,
                    width: 0.07613403,
                    height: 0.042403,
                },
            ],
        });
        store.replaceFromDocument([saved], []);
        const created = textMarkup('expanded-rounded', '', {
            identity: identity('expanded-rounded'),
            quadPoints: [
                {
                    left: 0.092398,
                    top: 0.115957,
                    width: 0.269554,
                    height: 0.124703,
                },
                {
                    left: 0.092398,
                    top: 0.269771,
                    width: 0.269554,
                    height: 0.042403,
                },
            ],
        });
        const merged = store.applyTextMarkupSelection(created, []).created;
        expect(merged.identity.id).toBe(saved.identity.id);
        expect(merged.quadPoints.every(quad => quad.width > 0 && quad.height > 0)).toBe(true);
        expect(merged.quadPoints.reduce((area, quad) => area + quad.width * quad.height, 0))
            .toBeCloseTo(0.269554 * (0.124703 + 0.042403), 8);
    });

    it('normalizes overlapping quads on a fresh highlight before persistence', () => {
        const store = new AnnotationStore();
        const created = textMarkup('fresh-bands', 'fresh-editor', {
            identity: {id: asAnnotationId('fresh-bands')},
            quadPoints: [
                {
                    left: 0.1,
                    top: 0.2,
                    width: 0.6,
                    height: 0.06,
                },
                {
                    left: 0.4,
                    top: 0.23,
                    width: 0.4,
                    height: 0.06,
                },
            ],
        });

        const projection = store.applyTextMarkupSelection(created, []);

        expect(projection.created.quadPoints.length).toBeGreaterThan(1);
        projection.created.quadPoints.forEach((left, leftIndex) => {
            projection.created.quadPoints.slice(leftIndex + 1).forEach((right) => {
                expect(
                    left.left + left.width <= right.left
                    || right.left + right.width <= left.left
                    || left.top + left.height <= right.top
                    || right.top + right.height <= left.top,
                ).toBe(true);
            });
        });
    });

    it('keeps saved-baseline semantics independent from live identity bindings', () => {
        const store = new AnnotationStore();
        const entity = note('saved-note');
        store.createNote(entity);
        persist(store, 'saved-note', '6R');
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);

        store.delete(entity.identity.id);
        expect(store.resolveExternal({pdfRef: '6R'})).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);

        store.markPersisted(store.beginSave());
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);

        expect(store.undo()).toBe(true);
        // A saved delete retires its PDF object. Undo restores a dirty local
        // entity without resurrecting a ref that the next save may reuse.
        expect(store.resolveExternal({pdfRef: '6R'})).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('tracks live state when a document replacement tombstones and restores an entity', () => {
        const store = new AnnotationStore();
        const entity = note('imported-note', '7R', {
            revision: 7,
            persistedRevision: 7,
        });
        store.replaceFromDocument([entity], []);
        expect(store.resolveExternal({pdfRef: '7R'})).toBe(entity.identity.id);

        store.replaceFromDocument([note('imported-note', '7R', {
            revision: 8,
            persistedRevision: 8,
            deleted: true,
        })], []);
        expect(store.resolveExternal({pdfRef: '7R'})).toBeNull();

        store.replaceFromDocument([note('imported-note', '7R', {
            revision: 9,
            persistedRevision: 9,
        })], []);
        expect(store.resolveExternal({pdfRef: '7R'})).toBe(entity.identity.id);
    });

    it('does not resurrect a deleted binding while forgetting another entity', () => {
        const store = new AnnotationStore();
        const deleted = note('deleted-note', '8R');
        const forgotten = note('forgotten-note', '9R');
        store.createNote(deleted);
        store.delete(deleted.identity.id);
        store.createNote(forgotten);

        store.forget(new Set([forgotten.identity.id]));

        expect(store.resolveExternal({pdfRef: '8R'})).toBeNull();
        expect(store.resolveExternal({pdfRef: '9R'})).toBeNull();
    });

    it('prunes history that could recreate a hard-forgotten entity', () => {
        const store = new AnnotationStore();
        const entity = note('forgotten-created-note', '10R');
        store.createNote(entity);
        store.forget(new Set([entity.identity.id]));

        expect(store.get(entity.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfRef: '10R'})).toBeNull();
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
        expect(store.undo()).toBe(false);
        expect(store.redo()).toBe(false);
    });

    it('uses the explicit id if an external authority replays a stale null-to-null command', () => {
        let command: IPdfAppAnnotationHistoryCommand | null = null;
        const history: IAnnotationHistoryAuthority = {
            get canUndo() { return command !== null; },
            get canRedo() { return false; },
            registerCommand(registered) { command = registered; },
            forgetCommands() {},
            undo() {
                if (!command) {
                    return false;
                }
                command.undo();
                return true;
            },
            redo: () => false,
        };
        const store = new AnnotationStore(history);
        const entity = note('stale-forgotten-note', '11R');
        store.createNote(entity);
        store.forget(new Set([entity.identity.id]));

        expect(store.undo()).toBe(true);
        expect(store.get(entity.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfRef: '11R'})).toBeNull();
    });

    it('releases the binding when a page remap tombstones an annotation', () => {
        const store = new AnnotationStore();
        const entity = note('removed-page-note', '12R');
        store.createNote(entity);

        store.remapPages({
            previousPageCount: 1,
            pages: [],
        });

        expect(store.resolveExternal({pdfRef: '12R'})).toBeNull();
    });

    it('keeps parsed identity metadata on a tombstone without publishing a live binding', () => {
        const store = new AnnotationStore();
        const entity = note('deleted-note', '13R');
        store.createNote(entity);
        store.delete(entity.identity.id);

        store.replaceFromDocument([note('deleted-note', '14R', {
            revision: 2,
            persistedRevision: 2,
        })], []);

        expect(store.get(entity.identity.id)?.identity.pdfRef).toBe('14R');
        expect(store.resolveExternal({pdfRef: '13R'})).toBeNull();
        expect(store.resolveExternal({pdfRef: '14R'})).toBeNull();
    });

    it('does not publish a materialized ref when acknowledging a saved tombstone', () => {
        const store = new AnnotationStore();
        const entity = note('deleted-note');
        store.createNote(entity);
        store.delete(entity.identity.id);
        const frontier = store.beginSave();

        store.markPersisted(frontier, [{
            annotationId: entity.identity.id,
            pdfRef: '15R',
        }]);

        expect(store.get(entity.identity.id)).toMatchObject({persistedRevision: 1});
        expect(store.get(entity.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.resolveExternal({pdfRef: '15R'})).toBeNull();
    });

    it('atomically swaps materialized refs while acknowledging a save', () => {
        const store = new AnnotationStore();
        const first = note('first-note');
        const second = note('second-note');
        store.createNote(first);
        store.createNote(second);

        store.markPersisted(store.beginSave(), [
            {
                annotationId: first.identity.id,
                pdfRef: '16R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '17R',
            },
        ]);
        const frontier = store.beginSave();

        store.markPersisted(frontier, [
            {
                annotationId: first.identity.id,
                pdfRef: '17R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '16R',
            },
        ]);

        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '17R'},
            persistedRevision: 0,
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '16R'},
            persistedRevision: 0,
        });
        expect(store.resolveExternal({pdfRef: '17R'})).toBe(first.identity.id);
        expect(store.resolveExternal({pdfRef: '16R'})).toBe(second.identity.id);
    });

    it('rolls back every save acknowledgement update when one ref conflicts', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('first-note'));
        const second = store.createNote(note('second-note'));
        const frontier = store.beginSave();

        expect(() => store.markPersisted(frontier, [
            {
                annotationId: first.identity.id,
                pdfRef: 'new-first-ref',
            },
            {
                annotationId: second.identity.id,
                pdfRef: 'new-first-ref',
            },
        ])).toThrow(/Conflicting persisted annotation identity/u);

        expect(store.get(first.identity.id)).toMatchObject({
            identity: {},
            persistedRevision: -1,
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {},
            persistedRevision: -1,
        });
        expect(store.resolveExternal({pdfRef: 'new-first-ref'})).toBeNull();
        expect(store.resolveExternal({pdfRef: 'occupied-ref'})).toBeNull();
    });

    it('rejects a conflicting redo before changing the live entity or its binding', () => {
        const store = new AnnotationStore();
        const original = note('original-note', '18R');
        const competing = note('competing-note', '18R');
        store.createNote(original);
        store.undo();
        store.replaceFromDocument([competing], []);

        expect(() => store.redo()).toThrow(ExternalIdentityConflictError);
        expect(store.get(original.identity.id)).toMatchObject({deleted: true});
        expect(store.resolveExternal({pdfRef: '18R'})).toBe(competing.identity.id);
        expect(store.canRedo).toBe(true);

        store.forget(new Set([competing.identity.id]));
        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '18R'})).toBe(original.identity.id);
    });
});
