import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AnnotationApplication,
    toCanonicalShapeEntity,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

function note(): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId('note-1')},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: 'Tester',
        contents: 'hello',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.05,
            height: 0.05,
        },
        color: '#ff0',
        replies: [],
        open: false,
    };
}

describe('AnnotationApplication', () => {
    it('exposes canonical comment read models from the store', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note());
        let comments = application.listCommentSummaries();
        application.store.subscribe(snapshotIncludingDeleted => comments = application.listCommentSummaries(snapshotIncludingDeleted));

        expect(application.listCommentSummaries()).toEqual([expect.objectContaining({
            appAnnotationId: 'note-1',
            text: 'hello',
            pageNumber: 1,
        })]);
        expect(comments).toEqual(application.listCommentSummaries());
        comments[0]!.markerRect!.left = 0.9;
        expect(application.listCommentSummaries()[0]!.markerRect!.left).toBe(0.1);
        application.store.delete(asAnnotationId('note-1'));
        expect(comments).toEqual([]);
        expect(application.store.undo()).toBe(true);
        expect(comments).toEqual(application.listCommentSummaries());
        expect(comments[0]!.text).toBe('hello');
    });

    it('captures and acknowledges a store save frontier', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note());
        const session = application.beginSave();

        expect(session.plan.expected).toHaveLength(1);
        application.acknowledgeSave(session);
        expect(application.store.dirtyEntities()).toHaveLength(0);
    });

    it('applies native identity bindings when acknowledging a save', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note());
        const session = application.beginSave();

        application.acknowledgeSave(session, null, [{
            annotationId: 'note-1',
            pdfRef: '11 0 R',
        }]);

        expect(application.store.get(asAnnotationId('note-1'))).toMatchObject({
            persistedRevision: 0,
            identity: {pdfRef: '11 0 R'},
        });
        expect(application.store.resolveExternal({pdfRef: '11 0 R'})).toBe(asAnnotationId('note-1'));
    });

    it('maps legacy line and arrow shapes to canonical tools', () => {
        const entity = toCanonicalShapeEntity({
            id: 'shape-1',
            annotationId: null,
            pageIndex: requirePageIndex(0),
            type: 'line',
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            lineEndStyle: 'closedArrow',
            color: '#000',
            strokeWidth: 1,
            opacity: 1,
        });

        expect(entity.tool).toBe('arrow');
        expect(entity.points).toHaveLength(2);
        expect(entity.points?.[1]).toMatchObject({
            x: 0.4,
            y: expect.closeTo(0.6),
        });
    });
});
