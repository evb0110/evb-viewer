import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type INoteEntity,
    type IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {requireDocumentRevisionToken} from '@contracts';

function importPersistedHighlight(store: AnnotationStore) {
    const annotationId = asAnnotationId('persisted-highlight');
    store.replaceFromDocument([{
        kind: 'text-markup',
        identity: {
            id: annotationId,
            pdfRef: '12R0',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
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
    }], []);
    return annotationId;
}

function stickyNote(id: string, text: string, left: number): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: text,
        position: {
            left,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
        color: '#ffcc00',
        open: false,
    };
}

describe('AnnotationStore save frontier rollback', () => {
    it('rejects currentness and acknowledgement after the document revision changes', () => {
        const store = new AnnotationStore();
        const firstRevision = requireDocumentRevisionToken('revision-1');
        const replacementRevision = requireDocumentRevisionToken('revision-2');
        const frontier = store.beginSave(firstRevision);

        expect(() => store.assertSaveFrontierCurrent(frontier, replacementRevision))
            .toThrow('document revision changed');
        expect(() => store.markPersisted(frontier, [], replacementRevision))
            .toThrow('document revision changed');
    });

    it('keeps markup subtype edits in canonical history for an immediate save', () => {
        const store = new AnnotationStore();
        const id = asAnnotationId('markup');
        store.createTextMarkup({
            kind: 'text-markup',
            identity: {id},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Highlight',
            contents: '',
            quadPoints: [{
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.01,
            }],
            color: '#ffff00',
            opacity: 1,
        });
        store.updateTextMarkup(id, {subtype: 'Squiggly'});
        expect(store.get(id)).toMatchObject({
            subtype: 'Squiggly',
            revision: 1,
        });
    });

    it('keeps canonical shape edits dirty while a parsed identity is adopted', () => {
        const store = new AnnotationStore();
        const shape: IShapeEntity = {
            kind: 'shape',
            identity: {id: asAnnotationId('local-shape')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            tool: 'rectangle',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
            strokeColor: '#123456',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        };
        store.createShape(shape);
        const frontier = store.beginSave();

        store.replaceFromDocument([{
            ...shape,
            identity: {
                id: shape.identity.id,
                pdfRef: '44R0',
            },
            rect: {
                left: 0.8,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
            persistedRevision: 0,
        }], []);

        expect(store.get(shape.identity.id)).toMatchObject({
            identity: {pdfRef: '44R0'},
            rect: shape.rect,
            persistedRevision: -1,
            revision: 0,
        });
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();

        store.updateShape(shape.identity.id, {strokeColor: '#ff0000'});
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.rollbackToSaveFrontier(frontier)).toBe(true);
        expect(store.get(shape.identity.id)).toMatchObject({
            identity: {pdfRef: '44R0'},
            strokeColor: '#ff0000',
            persistedRevision: -1,
            revision: 1,
        });
    });

    it('preserves concurrent authored mutations and new entities while failed-save rollback unwinds', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // Both edits are authored after capture and must remain canonical.
        store.updateTextMarkup(annotationId, {color: '#ff0000'});
        const noteId = asAnnotationId('rollback-note');
        store.createNote({
            kind: 'note',
            identity: {id: noteId},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'created after the frontier was captured',
            position: {
                left: 0.5,
                top: 0.5,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
            open: false,
        });

        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.rollbackToSaveFrontier(frontier)).toBe(true);

        expect(store.get(annotationId)).toMatchObject({
            color: '#ff0000',
            revision: 1,
        });
        expect(store.get(noteId)).toMatchObject({contents: 'created after the frontier was captured'});
        expect(store.get(annotationId)?.identity.pdfRef).toBe('12R0');
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });

    it('preserves a late persisted import that the frontier deliberately tolerates', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // The initial scan discovers an already-persisted source annotation
        // after the frontier is captured; the frontier tolerates it.
        const lateId = asAnnotationId('late-persisted');
        store.replaceFromDocument([
            store.get(annotationId)!,
            {
                kind: 'text-markup',
                identity: {
                    id: lateId,
                    pdfRef: '34R0',
                },
                pageIndex: 1,
                revision: 0,
                persistedRevision: 0,
                deleted: false,
                createdAt: null,
                modifiedAt: null,
                author: null,
                subtype: 'Highlight',
                contents: '',
                quadPoints: [{
                    left: 0.2,
                    top: 0.3,
                    width: 0.2,
                    height: 0.04,
                }],
                color: '#00ffff',
                opacity: 1,
            },
        ], []);
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();

        store.rollbackToSaveFrontier(frontier);

        expect(store.get(annotationId)).not.toBeNull();
        expect(store.get(lateId)).not.toBeNull();
    });

    it('rejects a concurrent editor mutation by CAS and preserves it on rollback', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // A captured semantic mutation lands mid-save: CAS must reject it.
        store.updateTextMarkup(annotationId, {color: '#00ff00'});
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow(
            'staleRevisionError: annotations changed after the save frontier was captured',
        );

        store.rollbackToSaveFrontier(frontier);
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.get(annotationId)).toMatchObject({
            color: '#00ff00',
            revision: 1,
        });
    });

    it('accepts identity reconciliation after capture but rejects semantic mutation', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // The materializing save binds the external identity it just wrote.
        store.replaceFromDocument([{
            ...store.get(annotationId)!,
            identity: {
                id: annotationId,
                pdfRef: '13R0',
            },
            persistedRevision: 0,
        }], []);
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();
        expect(store.get(annotationId)?.identity.pdfRef).toBe('13R0');

        store.updateTextMarkup(annotationId, {color: '#123456'});
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });

    it('refuses a frontier another store captured even when the two are structurally identical', () => {
        const left = new AnnotationStore();
        const right = new AnnotationStore();
        const leftId = importPersistedHighlight(left);
        importPersistedHighlight(right);
        const leftFrontier = left.beginSave();
        const rightFrontier = right.beginSave();
        // Two documents opened from the same bytes capture equal frontier data.
        expect(rightFrontier.entityBaselineHash).toBe(leftFrontier.entityBaselineHash);
        expect([...rightFrontier.revisions]).toEqual([...leftFrontier.revisions]);

        left.updateTextMarkup(leftId, {color: '#00ff00'});
        const drifted = left.get(leftId);

        // A failed save unwinding in `finally` must neither throw nor let one
        // document's rollback rewrite the other document's annotations.
        expect(left.rollbackToSaveFrontier(rightFrontier)).toBe(false);
        expect(left.get(leftId)).toEqual(drifted);
        expect(() => left.assertSaveFrontierCurrent(rightFrontier)).toThrow('belongs to another store');

        expect(left.rollbackToSaveFrontier(leftFrontier)).toBe(true);
        expect(left.get(leftId)).toEqual(drifted);
    });

    it('reports a retired frontier instead of throwing when the document was replaced', () => {
        const retired = new AnnotationApplication('first-document');
        const session = retired.beginSave();
        const replacement = new AnnotationApplication('second-document');

        expect(replacement.rollbackSave(session)).toBe(false);
        expect(retired.rollbackSave(session)).toBe(true);
    });

    it('preserves post-frontier application mutations when a save fails', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(stickyNote('note-to-persist', 'note to persist', 0.1));
        const frontier = application.store.beginSave();

        // A second note is created after the frontier; the save then fails.
        application.store.createNote(stickyNote('post-frontier-note', 'created after save started', 0.3));
        expect(() => application.store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');

        expect(application.store.list()).toEqual([
            expect.objectContaining({contents: 'note to persist'}),
            expect.objectContaining({contents: 'created after save started'}),
        ]);
        expect(() => application.store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });
});
