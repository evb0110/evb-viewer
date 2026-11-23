import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    semanticSnapshot,
    semanticSnapshotsEqual,
    snapshotOfKind,
    type AnnotationEntity,
    type AnnotationId,
    type INoteEntity,
    type IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';

function inkShape(id: string, pageIndex = 0): IShapeEntity {
    return {
        kind: 'shape',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        tool: 'draw',
        pdfSubtype: 'Ink',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.1,
        },
        strokes: [[
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.3,
                y: 0.25,
            },
        ]],
        strokeColor: '#d92626',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    };
}

function differsFromSavedRecomputed(store: AnnotationStore, kind?: AnnotationEntity['kind']) {
    const state = store.snapshotState();
    return !semanticSnapshotsEqual(
        snapshotOfKind(semanticSnapshot(state.entities.values()), kind),
        snapshotOfKind(state.saved, kind),
    );
}

function note(id = 'baseline-note', pageIndex = 0): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'baseline',
        position: {
            left: 0.1,
            top: 0.1,
            width: 0.05,
            height: 0.05,
        },
        color: '#ff0',
        replies: [],
        open: false,
    };
}

describe('AnnotationStore saved baseline', () => {
    it('tracks dirty entities until the captured frontier is persisted', () => {
        const store = new AnnotationStore();
        store.createNote(note());
        const frontier = store.beginSave();

        expect(store.dirtyEntities()).toHaveLength(1);
        store.markPersisted(frontier);
        expect(store.dirtyEntities()).toHaveLength(0);
    });

    it('keeps a later mutation dirty after an earlier save frontier is acknowledged', () => {
        const store = new AnnotationStore();
        const entity = store.createNote(note());
        const frontier = store.beginSave();
        store.updateNote(entity.identity.id, {contents: 'changed'});

        store.markPersisted(frontier);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.dirtyEntities()).toHaveLength(1);
    });

    it('keeps the baseline of a document parse that landed during the save', () => {
        const store = new AnnotationStore();
        store.createNote(note());
        const frontier = store.beginSave();
        store.replaceFromDocument([{
            ...note(),
            identity: {
                id: asAnnotationId('late-note'),
                pdfRef: '34 0 R',
            },
            persistedRevision: 0,
            contents: 'read from the document',
        }], []);

        store.markPersisted(frontier);
        expect(store.list()).toHaveLength(2);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('tracks unsaved changes through edits, undo, redo, saves and edits back to the saved state', () => {
        const store = new AnnotationStore();
        const save = () => store.markPersisted(store.beginSave());
        const expectDirty = (all: boolean, shapes: boolean, notes: boolean) => {
            expect(store.hasChangesSinceSavedBaseline()).toBe(all);
            expect(store.hasChangesSinceSavedBaseline('shape')).toBe(shapes);
            expect(store.hasChangesSinceSavedBaseline('note')).toBe(notes);
            expect(store.hasChangesSinceSavedBaseline('text-box')).toBe(false);
            expect(differsFromSavedRecomputed(store)).toBe(all);
        };
        expectDirty(false, false, false);
        const ink = store.createShape(inkShape('ink'));
        expectDirty(true, true, false);
        expect(store.undo()).toBe(true);
        expectDirty(false, false, false);
        expect(store.redo()).toBe(true);
        expectDirty(true, true, false);
        save();
        expectDirty(false, false, false);

        store.updateShape(ink.identity.id, {strokeColor: '#00ff00'});
        expectDirty(true, true, false);
        // Editing back to what the file holds is no unsaved change.
        store.updateShape(ink.identity.id, {strokeColor: '#d92626'});
        expectDirty(false, false, false);

        const comment = store.createNote(note('comment'));
        expectDirty(true, false, true);
        store.setNoteText(comment.identity.id, 'reworded');
        save();
        expectDirty(false, false, false);
        store.setNoteText(comment.identity.id, 'reworded again');
        expectDirty(true, false, true);
        store.setNoteText(comment.identity.id, 'reworded');
        expectDirty(false, false, false);

        store.delete(ink.identity.id);
        expectDirty(true, true, false);
        expect(store.undo()).toBe(true);
        expectDirty(false, false, false);
        expect(store.redo()).toBe(true);
        save();
        expectDirty(false, false, false);
        // Undoing a saved deletion restores an annotation the file no longer holds.
        expect(store.undo()).toBe(true);
        expectDirty(true, true, false);
    });

    it('keeps the dirty check equal to a full comparison across interleaved operations', () => {
        let seed = 7;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        const store = new AnnotationStore();
        const save = () => store.markPersisted(store.beginSave());
        const ids: AnnotationId[] = [];
        for (let step = 0; step < 400; step += 1) {
            const live = store.list().filter(entity => entity.kind === 'shape' || entity.kind === 'note');
            const target = live[Math.floor(random() * live.length)];
            const operation = random();
            if (operation < 0.2 || !target) {
                const id = `entity-${step}`;
                const pageIndex = Math.floor(random() * 4);
                ids.push(asAnnotationId(id));
                if (random() < 0.5) store.createShape(inkShape(id, pageIndex));
                else store.createNote(note(id, pageIndex));
            } else if (operation < 0.45) {
                if (target.kind === 'shape') store.updateShape(target.identity.id, {strokeColor: random() < 0.5 ? '#d92626' : '#00ff00'});
                else store.setNoteText(target.identity.id, random() < 0.5 ? 'document' : 'edited');
            } else if (operation < 0.55) {
                store.delete(target.identity.id);
            } else if (operation < 0.7) {
                store.undo();
            } else if (operation < 0.8) {
                store.redo();
            } else if (operation < 0.9) {
                save();
            } else {
                // A re-read of one page after a save: the bytes hold what the store holds there.
                save();
                const pageIndex = target.pageIndex;
                store.replaceFromDocument(store.list().filter(entity => entity.pageIndex === pageIndex), [], [pageIndex]);
            }
            for (const kind of [
                undefined,
                'shape',
                'note',
            ] as const) {
                expect(store.hasChangesSinceSavedBaseline(kind), `step ${step}, kind ${kind ?? 'all'}`)
                    .toBe(differsFromSavedRecomputed(store, kind));
            }
        }
        expect(ids.length).toBeGreaterThan(20);
    });
});
