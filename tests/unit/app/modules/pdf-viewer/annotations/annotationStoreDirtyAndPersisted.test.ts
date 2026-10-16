import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type IShapeEntity,
    type ITextBoxEntity,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function note(id: string, overrides: Partial<INoteEntity> = {}): INoteEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
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
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: null,
        kind: 'text-box',
        text: 'text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#123456',
    };
}

function shape(id: string): IShapeEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: null,
        kind: 'shape',
        tool: 'rectangle',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.2,
        },
        strokeColor: '#123456',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
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

    it('accepts a managed shape stable-key binding from the native writer', () => {
        const store = new AnnotationStore();
        const created = store.createShape(shape('shape-native-binding'));

        store.markPersisted(store.beginSave(), [{
            annotationId: 'evb-shape:shape-native-binding',
            pdfRef: '13 0 R',
        }]);

        expect(store.dirtyEntities()).toEqual([]);
        expect(store.get(created.identity.id)).toMatchObject({
            persistedRevision: 0,
            identity: {pdfRef: '13 0 R'},
        });
        expect(store.resolveExternal({pdfRef: '13 0 R'})).toBe(created.identity.id);
    });

    it('preserves an existing PDF reference when the save returns no new binding', () => {
        const store = new AnnotationStore();
        const annotationId = asAnnotationId('existing');
        store.replaceFromDocument([note('existing', {
            identity: {
                id: annotationId,
                pdfRef: '11 0 R',
            },
            persistedRevision: 0,
        })], []);

        store.updateNote(annotationId, {contents: 'edited'});
        const frontier = store.beginSave();

        store.markPersisted(frontier);

        expect(store.get(annotationId)).toMatchObject({
            contents: 'edited',
            persistedRevision: 1,
            identity: {pdfRef: '11 0 R'},
        });
        expect(store.resolveExternal({pdfRef: '11 0 R'})).toBe(annotationId);
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

    it('rejects a stale frontier before writing', () => {
        const store = new AnnotationStore();
        const created = store.createNote(note('stale'));
        const frontier = store.beginSave();
        store.updateNote(created.identity.id, {contents: 'changed'});

        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.get(created.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.get(created.identity.id)?.persistedRevision).toBe(-1);
    });
    it('acknowledges published revisions while later edits and notes stay dirty', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('published', {contents: 'saved text'}));
        const frontier = store.beginSave();
        store.updateNote(first.identity.id, {contents: 'later edit'});
        const later = store.createNote(note('later', {contents: 'later note'}));

        store.markPersisted(frontier, [{
            annotationId: first.identity.id,
            pdfRef: '41R',
        }]);

        expect(store.get(first.identity.id)).toMatchObject({
            contents: 'later edit',
            persistedRevision: 0,
            revision: 1,
            identity: {pdfRef: '41R'},
        });
        expect(store.dirtyEntities().map(entity => entity.identity.id)).toEqual([
            first.identity.id,
            later.identity.id,
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        store.markPersisted(store.beginSave(), [{
            annotationId: later.identity.id,
            pdfRef: '42R',
        }]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.dirtyEntities()).toEqual([]);
    });

    it('keeps a deletion accepted after publication bound for the next save', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('late-delete'));
        const frontier = store.beginSave();
        store.delete(first.identity.id);
        store.markPersisted(frontier, [{
            annotationId: first.identity.id,
            pdfRef: '43R',
        }]);
        expect(store.get(first.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '43R'},
        });
        expect(store.countDirtyPersistedDeletions()).toBe(1);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        store.markPersisted(store.beginSave());
        expect(store.get(first.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

});
