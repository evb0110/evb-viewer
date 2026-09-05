import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function note(): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId('baseline-note')},
        pageIndex: 0,
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

        expect(() => store.markPersisted(frontier)).toThrow(/staleRevisionError/u);
        expect(store.dirtyEntities()).toHaveLength(1);
    });
});
