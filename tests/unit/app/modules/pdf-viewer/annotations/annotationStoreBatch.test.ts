import {
    describe,
    expect,
    it,
} from 'vitest';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type INoteEntity,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { requirePageIndex } from '@contracts/pageNumbers';

function note(id: string): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: id,
        position: {
            left: 0.2,
            top: 0.3,
            width: 0.01,
            height: 0.01,
        },
        color: null,
        open: false,
    };
}

describe('AnnotationStore batched notifications', () => {
    it('publishes nested mutations together while preserving individual undo commands', () => {
        const store = new AnnotationStore();
        const snapshots: string[][] = [];
        store.subscribe(allEntities => snapshots.push(allEntities.filter(entity => !entity.deleted).map(entity => entity.identity.id)));

        store.batch(() => {
            store.createNote(note('first'));
            store.batch(() => store.createNote(note('second')));
            expect(snapshots).toEqual([[]]);
        });

        expect(snapshots).toEqual([
            [],
            [
                'first',
                'second',
            ],
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.undo()).toBe(true);
        expect(snapshots.at(-1)).toEqual(['first']);
        expect(store.undo()).toBe(true);
        expect(snapshots.at(-1)).toEqual([]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.redo()).toBe(true);
        expect(snapshots.at(-1)).toEqual(['first']);
    });

    it('publishes completed mutations after a callback throws and resumes normal notifications', () => {
        const store = new AnnotationStore();
        const snapshots: string[][] = [];
        store.subscribe(allEntities => snapshots.push(allEntities.filter(entity => !entity.deleted).map(entity => entity.identity.id)));

        expect(() => store.batch(() => {
            store.createNote(note('before-error'));
            throw new Error('import interrupted');
        })).toThrow('import interrupted');

        expect(snapshots).toEqual([
            [],
            ['before-error'],
        ]);
        store.createNote(note('after-error'));
        expect(snapshots).toEqual([
            [],
            ['before-error'],
            [
                'before-error',
                'after-error',
            ],
        ]);
    });
    it('publishes isolated complete snapshots, including deletions, to current and later readers', () => {
        const store = new AnnotationStore();
        const created = store.createNote(note('persisted'));
        store.markPersisted(store.beginSave(), [{
            annotationId: created.identity.id,
            pdfRef: '12R',
        }]);
        let snapshotIncludingDeleted: readonly AnnotationEntity[] = [];
        store.subscribe(allEntities => snapshotIncludingDeleted = allEntities);
        store.delete(created.identity.id);
        expect(snapshotIncludingDeleted).toEqual([expect.objectContaining({
            deleted: true,
            contents: 'persisted',
        })]);
        const originalDeletion = snapshotIncludingDeleted;
        let laterSnapshotIncludingDeleted: readonly AnnotationEntity[] = [];
        store.subscribe(allEntities => laterSnapshotIncludingDeleted = allEntities);
        expect(laterSnapshotIncludingDeleted).toEqual(originalDeletion);

        const clone = laterSnapshotIncludingDeleted[0]!;
        expect(clone.kind).toBe('note');
        if (clone.kind !== 'note') {
            throw new Error('Expected a note');
        }
        clone.position.left = 0.9;
        Object.assign(clone, {contents: 'reader-only change'});
        expect(store.get(created.identity.id)).toMatchObject({
            deleted: true,
            contents: 'persisted',
            position: {left: 0.2},
        });
        expect(originalDeletion[0]).toMatchObject({contents: 'persisted'});
        expect(store.undo()).toBe(true);
        expect(snapshotIncludingDeleted[0]).toMatchObject({
            deleted: false,
            contents: 'persisted',
        });
        expect(originalDeletion[0]).toMatchObject({deleted: true});
    });

});
