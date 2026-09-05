import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AnnotationStore,
    estimateRetainedAnnotationBytes,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import type {IAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {
    AnnotationId,
    IShapeEntity,
    INoteEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IPdfAppAnnotationHistoryCommand} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {LocalAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {
    asAnnotationId,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function stickyNote(id: string, _legacyEditorId: string): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        contents: '',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
        open: false,
    };
}

function textMarkup(id: string, _legacyEditorId: string): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        subtype: 'Highlight',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 1,
    };
}

function persistedShape(id: string, pdfRef: string, x: number): IShapeEntity {
    return {
        kind: 'shape',
        identity: {
            id: asAnnotationId(id),
            pdfRef,
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        tool: 'rectangle',
        rect: {
            left: x,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        },
        strokeColor: '#123456',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    };
}

function authoredShape(id: string, x: number): IShapeEntity {
    const shape = persistedShape(id, '', x);
    const {
        pdfRef: _pdfRef,
        ...identity
    } = shape.identity;
    return {
        ...shape,
        identity,
        persistedRevision: -1,
    };
}

function authoredLine(id: string): IShapeEntity {
    const line = persistedShape(id, '', 0.18);
    return {
        ...line,
        tool: 'line',
        rect: {
            left: 0.18,
            top: 0.22,
            width: 0.48,
            height: 0.26,
        },
        points: [
            {
                x: 0.18,
                y: 0.22,
            },
            {
                x: 0.66,
                y: 0.48,
            },
        ],
        persistedRevision: -1,
    };
}

/** Records the commands the store registers so retained-size claims stay checkable. */
function createRecordingHistoryAuthority() {
    const local = new LocalAnnotationHistoryAuthority();
    const commands: IPdfAppAnnotationHistoryCommand[] = [];
    const authority: IAnnotationHistoryAuthority = {
        get canUndo() { return local.canUndo; },
        get canRedo() { return local.canRedo; },
        registerCommand: (command) => {
            commands.push(command);
            local.registerCommand(command);
        },
        forgetCommands: ids => local.forgetCommands(ids),
        undo: () => local.undo(),
        redo: () => local.redo(),
    };
    return {
        authority,
        commands,
    };
}

function saveWithMaterializedRef(store: AnnotationStore, id: AnnotationId, pdfRef: string) {
    store.markPersisted(store.beginSave(), [{
        annotationId: id,
        pdfRef,
    }]);
}

function importEntity(store: AnnotationStore, entity: ITextMarkupEntity | IShapeEntity | INoteEntity) {
    store.replaceFromDocument([entity], []);
}

describe('AnnotationStore save identity rebase', () => {
    it('rebases a unique persisted semantic match onto the existing command identity', () => {
        const store = new AnnotationStore();
        const authored = authoredShape('authored-shape', 0.1);
        store.createShape(authored);
        store.markPersisted(store.beginSave());

        store.replaceFromDocument([persistedShape('parser-shape', '19R', 0.1)], []);

        expect(store.get(authored.identity.id)).toMatchObject({
            identity: {
                id: authored.identity.id,
                pdfRef: '19R',
            },
            persistedRevision: 0,
        });
        expect(store.get(asAnnotationId('parser-shape'))).toBeNull();
        expect(store.undo()).toBe(true);
        expect(store.get(authored.identity.id)).toMatchObject({deleted: true});
    });

    it('refuses an ambiguous semantic match and retires neither identity by guess', () => {
        const store = new AnnotationStore();
        const first = authoredShape('first-identical-shape', 0.1);
        const second = authoredShape('second-identical-shape', 0.1);
        store.createShape(first);
        store.createShape(second);
        store.markPersisted(store.beginSave());

        store.replaceFromDocument([persistedShape('parser-identical-shape', '20R', 0.1)], []);

        expect(store.get(first.identity.id)).toBeNull();
        expect(store.get(second.identity.id)).toBeNull();
        expect(store.get(asAnnotationId('parser-identical-shape'))).toMatchObject({identity: {pdfRef: '20R'}});
    });

    it('matches a saved line when the parser omits rect-derived endpoints', () => {
        const store = new AnnotationStore();
        const authored = authoredLine('authored-line');
        store.createShape(authored);
        store.markPersisted(store.beginSave());

        const {
            points: _parsedPoints,
            ...parsedLine
        } = authored;
        store.replaceFromDocument([{
            ...parsedLine,
            identity: {
                id: asAnnotationId('parser-line'),
                pdfRef: '21R',
            },
        }], []);

        expect(store.get(authored.identity.id)).toMatchObject({
            identity: {
                id: authored.identity.id,
                pdfRef: '21R',
            },
            persistedRevision: 0,
        });
        expect(store.get(asAnnotationId('parser-line'))).toBeNull();
        expect(store.undo()).toBe(true);
        expect(store.get(authored.identity.id)).toMatchObject({deleted: true});
    });

    it('matches a saved line when the parser reverses its endpoint direction', () => {
        const store = new AnnotationStore();
        const authored = authoredLine('authored-reversed-line');
        store.createShape(authored);
        store.markPersisted(store.beginSave());

        store.replaceFromDocument([{
            ...authored,
            identity: {
                id: asAnnotationId('parser-reversed-line'),
                pdfRef: '22R',
            },
            points: [
                authored.points![1]!,
                authored.points![0]!,
            ],
        }], []);

        expect(store.get(authored.identity.id)).toMatchObject({identity: {
            id: authored.identity.id,
            pdfRef: '22R',
        }});
        expect(store.get(asAnnotationId('parser-reversed-line'))).toBeNull();
    });

    it('projects a canonical shape with a native-parser-compatible stable key', () => {
        const shape = authoredShape('draw-shape', 0.2);

        expect(toLegacyShapeAnnotation(shape).stableKey).toBe('evb-shape:draw-shape');
        expect(toLegacyShapeAnnotation({
            ...shape,
            identity: {id: asAnnotationId('evb-shape:existing')},
        }).stableKey).toBe('evb-shape:existing');
    });

    it('keeps the acknowledged persistence identity through undo and redo of an edit', () => {
        const store = new AnnotationStore();
        const note = stickyNote('edited-note', 'edited-editor');
        store.createNote(note);
        store.updateNote(note.identity.id, {contents: 'saved text'});

        saveWithMaterializedRef(store, note.identity.id, '12R');

        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            contents: 'saved text',
        });

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            contents: '',
        });

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            contents: 'saved text',
        });
        expect(store.get(note.identity.id)?.identity.pdfRef).toBe('12R');
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('restores the acknowledged persistence identity when redoing a saved create', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('saved-markup', 'markup-editor');
        store.createTextMarkup(markup);

        saveWithMaterializedRef(store, markup.identity.id, '31R');

        expect(store.undo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '31R'},
            persistedRevision: 0,
        });

        expect(store.redo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({
            identity: {pdfRef: '31R'},
            persistedRevision: 0,
        });
        expect(store.get(markup.identity.id)?.identity.pdfRef).toBe('31R');
        // The saved file still holds the annotation, so the redone entity is
        // not a dirty transient the next save has to write again.
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.dirtyEntities()).toEqual([]);
    });

    it('keeps an undone saved create as a bound tombstone for the next save', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('saved-markup-delete', 'markup-delete-editor');
        store.createTextMarkup(markup);
        saveWithMaterializedRef(store, markup.identity.id, '32R');

        expect(store.undo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '32R'},
            persistedRevision: 0,
        });

        const frontier = store.beginSave();
        const plan = buildSerializationPlan(
            frontier,
            store.dirtyEntities(),
            store.list({includeDeleted: true}),
        );
        const deleteStep = plan.steps.find(step => step.operation === 'delete-annotation');

        expect(deleteStep?.annotationId).toBe(markup.identity.id);
        expect(deleteStep?.fields.identity).toMatchObject({pdfRef: '32R'});
    });

    it('keeps a redo entry captured before the acknowledgement on the saved identity', () => {
        const store = new AnnotationStore();
        const note = stickyNote('cursor-note', 'cursor-editor');
        store.createNote(note);
        store.updateNote(note.identity.id, {contents: 'first'});
        store.updateNote(note.identity.id, {contents: 'second'});

        expect(store.undo()).toBe(true);
        saveWithMaterializedRef(store, note.identity.id, '44R');

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '44R'},
            persistedRevision: 1,
            contents: 'second',
        });
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('retires the persisted identity when an acknowledged delete removes the object', () => {
        const store = new AnnotationStore();
        const note = {
            ...stickyNote('deleted-note', 'deleted-editor'),
            identity: {
                id: asAnnotationId('deleted-note'),
                pdfRef: '9R',
            },
            persistedRevision: 0,
        };
        importEntity(store, note);
        store.delete(note.identity.id);
        store.markPersisted(store.beginSave());

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            deleted: false,
            persistedRevision: -1,
        });
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            deleted: true,
            persistedRevision: -1,
        });
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.countDirtyPersistedDeletions()).toBe(0);
    });

    it('rebases every annotation in a batched markup selection', () => {
        const store = new AnnotationStore();
        const quadPoints = [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }];
        const existing: ITextMarkupEntity = {
            ...textMarkup('existing-markup', 'existing-editor'),
            identity: {
                id: asAnnotationId('existing-markup'),
                pdfRef: '7R',
            },
            subtype: 'Underline',
            quadPoints,
            persistedRevision: 0,
        };
        importEntity(store, existing);
        const created: ITextMarkupEntity = {
            ...textMarkup('created-markup', 'created-editor'),
            subtype: 'Underline',
            quadPoints,
        };
        store.applyTextMarkupSelection(created, [{
            annotationId: existing.identity.id,
            observedQuadPoints: quadPoints,
        }]);

        expect(store.get(existing.identity.id)?.deleted).toBe(true);
        store.markPersisted(store.beginSave(), [{
            annotationId: created.identity.id,
            pdfRef: '8R',
        }]);

        expect(store.undo()).toBe(true);
        expect(store.get(existing.identity.id)).toMatchObject({
            deleted: false,
            persistedRevision: -1,
        });
        expect(store.get(existing.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(created.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '8R'},
            persistedRevision: 0,
        });

        expect(store.redo()).toBe(true);
        expect(store.get(created.identity.id)).toMatchObject({
            identity: {pdfRef: '8R'},
            persistedRevision: 0,
        });
        expect(store.get(existing.identity.id)).toMatchObject({
            deleted: true,
            persistedRevision: -1,
        });
        expect(store.get(existing.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('leaves a never-acknowledged annotation transient through undo and redo', () => {
        const store = new AnnotationStore();
        const note = stickyNote('transient-note', 'transient-editor');
        store.createNote(note);
        store.updateNote(note.identity.id, {contents: 'draft'});

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)?.persistedRevision).toBe(-1);
        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({persistedRevision: -1});
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('does not rebase history when a stale acknowledgement is rejected', () => {
        const store = new AnnotationStore();
        const note = stickyNote('stale-note', 'stale-editor');
        store.createNote(note);
        const frontier = store.beginSave();
        store.updateNote(note.identity.id, {contents: 'typed after the frontier'});

        expect(() => store.markPersisted(frontier, [{
            annotationId: note.identity.id,
            pdfRef: '55R',
        }])).toThrow(/staleRevisionError/u);

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({persistedRevision: -1});
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('adopts the newest acknowledged ref when a second save renames it', () => {
        const store = new AnnotationStore();
        const note = stickyNote('renamed-note', 'renamed-editor');
        store.createNote(note);
        saveWithMaterializedRef(store, note.identity.id, '12R');
        store.updateNote(note.identity.id, {contents: 'second revision'});
        saveWithMaterializedRef(store, note.identity.id, '13R');

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '13R'},
            persistedRevision: 1,
        });
        expect(store.get(note.identity.id)?.identity.pdfRef).toBe('13R');
    });

    it('drops a remembered identity once a later save writes bytes without it', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('rewritten-markup', 'rewritten-editor');
        store.createTextMarkup(markup);
        saveWithMaterializedRef(store, markup.identity.id, '31R');

        expect(store.undo()).toBe(true);
        // The document is saved again while the create is undone, so the
        // annotation is gone from the file the acknowledgement describes.
        store.markPersisted(store.beginSave());

        expect(store.redo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({persistedRevision: -1});
        expect(store.get(markup.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(markup.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('keeps the saved ref on a delete the redo replays, so serialization can key it', () => {
        const store = new AnnotationStore();
        const note = stickyNote('serialized-note', 'serialized-editor');
        store.createNote(note);
        store.delete(note.identity.id);
        expect(store.undo()).toBe(true);
        saveWithMaterializedRef(store, note.identity.id, '9R');

        expect(store.redo()).toBe(true);

        const frontier = store.beginSave();
        const plan = buildSerializationPlan(
            frontier,
            store.dirtyEntities(),
            store.list({includeDeleted: true}),
        );
        const deleteStep = plan.steps.find(step => step.operation === 'delete-annotation');

        expect(deleteStep?.annotationId).toBe(note.identity.id);
        expect(deleteStep?.fields.identity).toMatchObject({pdfRef: '9R'});
    });

    it('rebases each annotation independently across an interleaved history', () => {
        const store = new AnnotationStore();
        const first = stickyNote('first-note', 'first-editor');
        const second = stickyNote('second-note', 'second-editor');
        store.createNote(first);
        store.createNote(second);
        store.updateNote(first.identity.id, {contents: 'first text'});
        store.updateNote(second.identity.id, {contents: 'second text'});

        store.markPersisted(store.beginSave(), [
            {
                annotationId: first.identity.id,
                pdfRef: '11R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '12R',
            },
        ]);

        expect(store.undo()).toBe(true);
        expect(store.undo()).toBe(true);
        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '11R'},
            persistedRevision: 1,
            contents: '',
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            contents: '',
        });

        expect(store.redo()).toBe(true);
        expect(store.redo()).toBe(true);
        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '11R'},
            persistedRevision: 1,
            contents: 'first text',
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            contents: 'second text',
        });
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('keeps each note-text commit as its own undo step', () => {
        const store = new AnnotationStore();
        const note = stickyNote('typed-note', 'typed-editor');
        store.createNote(note);
        store.updateNote(note.identity.id, {contents: 'first commit'});
        store.updateNote(note.identity.id, {contents: 'second commit'});

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({contents: 'first commit'});
        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({contents: ''});
        expect(store.canUndo).toBe(true);
    });

    it('drops a ref the record retired instead of restoring it from a replay', () => {
        const store = new AnnotationStore();
        const shape = persistedShape('retired-shape', '7R', 0.1);
        importEntity(store, shape);
        store.updateShape(shape.identity.id, {strokeColor: '#00ff00'});

        const frontier = store.beginSave();
        store.replaceFromDocument([], []);
        expect(store.get(shape.identity.id)?.identity.pdfRef).toBe('7R');
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();

        expect(store.undo()).toBe(true);
        const undone = store.get(shape.identity.id);
        expect(undone).not.toBeNull();
        expect(undone!.identity.pdfRef).toBe('7R');

        expect(store.redo()).toBe(true);
        const redone = store.get(shape.identity.id);
        expect(redone).not.toBeNull();
        expect(redone!.identity.pdfRef).toBe('7R');
    });

    it('does not let a replay claim a retired ref another annotation inherited', () => {
        const store = new AnnotationStore();
        const shape = persistedShape('renumbered-shape', '7R', 0.1);
        const survivor = persistedShape('surviving-shape', '8R', 0.5);
        store.replaceFromDocument([
            shape,
            survivor,
        ], []);
        store.updateShape(shape.identity.id, {strokeColor: '#00ff00'});
        store.updateShape(survivor.identity.id, {strokeColor: '#00ff00'});

        store.replaceFromDocument([], []);

        expect(store.undo()).toBe(true);
        expect(store.get(shape.identity.id)?.identity.pdfRef).toBe('7R');
        expect(store.get(survivor.identity.id)?.identity.pdfRef).toBe('8R');

        expect(store.redo()).toBe(true);
        expect(store.get(shape.identity.id)?.identity.pdfRef).toBe('7R');
        expect(store.get(survivor.identity.id)?.identity.pdfRef).toBe('8R');
    });

    it('prices canonical snapshot commands by the entities they retain', () => {
        const {
            authority,
            commands,
        } = createRecordingHistoryAuthority();
        const store = new AnnotationStore(authority);
        const note = stickyNote('priced-note', 'priced-editor');
        store.createNote(note);
        store.updateNote(note.identity.id, {contents: 'x'.repeat(4096)});

        const [
            createCommand,
            editCommand,
        ] = commands;

        // The create command wraps a clone of the note in one entry, so a priced
        // command can never come in under the note itself; an unpriced one would
        // report the ledger's flat fallback instead. That fallback is 1 KiB, which
        // over-charges this small create and under-charges the 4 KiB edit by an
        // order of magnitude, so only the edit is asserted against it.
        expect(createCommand?.estimatedBytes).toBeGreaterThan(estimateRetainedAnnotationBytes([note]));
        expect(editCommand?.estimatedBytes).toBeGreaterThan(8192);
        expect(editCommand!.estimatedBytes!).toBeGreaterThan(createCommand!.estimatedBytes!);
    });
});
