import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type ITextBoxEntity,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function note(id: string, overrides: Partial<INoteEntity> = {}): INoteEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        kind: 'note',
        contents: '',
        position: rect,
        color: '#ffff00',
        open: false,
        ...overrides,
    };
}

function textBox(id: string): ITextBoxEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        kind: 'text-box',
        text: 'text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#123456',
    };
}

function persist(store: AnnotationStore, id: string, pdfRef?: string) {
    return store.markPersisted(store.beginSave(), pdfRef === undefined ? [] : [{
        annotationId: asAnnotationId(id),
        pdfRef,
    }]);
}

describe('AnnotationStore dirty and persistence projection', () => {
    it('returns cloned canonical entities for edits and deletes', () => {
        const store = new AnnotationStore();
        const created = store.createNote(note('dirty'));
        store.updateNote(created.identity.id, {contents: 'edited'});
        const dirty = store.dirtyEntities();
        expect(dirty).toHaveLength(1);
        expect(dirty[0]).toMatchObject({
            kind: 'note',
            contents: 'edited',
            revision: 1,
            persistedRevision: -1,
        });

        const dirtyEntity = dirty[0];
        expect(dirtyEntity).toBeDefined();
        Object.assign(dirtyEntity!, {contents: 'mutated outside'});
        expect((store.get(created.identity.id) as INoteEntity | null)?.contents).toBe('edited');

        store.delete(created.identity.id);
        expect(store.dirtyEntities()).toEqual([expect.objectContaining({
            deleted: true,
            revision: 2,
            persistedRevision: -1,
        })]);
    });

    it('marks a captured revision clean and binds all returned PDF references atomically', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('first'));
        const second = store.createTextBox(textBox('second'));
        const frontier = store.beginSave();

        store.markPersisted(frontier, [
            {
                annotationId: first.identity.id,
                pdfRef: '11R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '12R',
            },
        ]);

        expect(store.dirtyEntities()).toEqual([]);
        expect(store.get(first.identity.id)).toMatchObject({
            persistedRevision: 0,
            identity: {pdfRef: '11R'},
        });
        expect(store.get(second.identity.id)).toMatchObject({
            persistedRevision: 0,
            identity: {pdfRef: '12R'},
        });
    });

    it('rejects a binding conflict without partially changing entities', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('first'));
        const second = store.createNote(note('second'));
        const frontier = store.beginSave();

        expect(() => store.markPersisted(frontier, [
            {
                annotationId: first.identity.id,
                pdfRef: '21R',
            },
            {
                annotationId: second.identity.id,
                pdfRef: '21R',
            },
        ])).toThrow(/Conflicting persisted annotation identity/u);
        expect(store.dirtyEntities().map(entity => entity.identity.id)).toEqual([
            first.identity.id,
            second.identity.id,
        ]);
        expect(store.get(first.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(second.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('retires a tombstone reference and makes undo of the saved delete dirty again', () => {
        const store = new AnnotationStore();
        const created = store.createNote(note('delete-me'));
        persist(store, created.identity.id, '31R');
        store.delete(created.identity.id);
        const frontier = store.beginSave();

        store.markPersisted(frontier);
        expect(store.get(created.identity.id)).toMatchObject({
            deleted: true,
            persistedRevision: 1,
            identity: {},
        });
        expect(store.dirtyEntities()).toEqual([]);

        expect(store.undo()).toBe(true);
        expect(store.get(created.identity.id)).toMatchObject({
            deleted: false,
            persistedRevision: -1,
            identity: {},
        });
        expect(store.dirtyEntities()).toEqual([expect.objectContaining({
            identity: {id: created.identity.id},
            deleted: false,
        })]);
    });

    it('rejects a stale frontier before applying bindings', () => {
        const store = new AnnotationStore();
        const created = store.createNote(note('stale'));
        const frontier = store.beginSave();
        store.updateNote(created.identity.id, {contents: 'changed'});

        expect(() => store.markPersisted(frontier, [{
            annotationId: created.identity.id,
            pdfRef: '41R',
        }])).toThrow('staleRevisionError');
        expect(store.get(created.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(created.identity.id)?.persistedRevision).toBe(-1);
    });
});
