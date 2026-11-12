import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {updateAnnotationColor} from '@app/modules/pdf-viewer/annotations/updateAnnotationColor';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

function createComment(appAnnotationId: string): IAnnotationCommentSummary {
    return {
        appAnnotationId,
        id: '12R0',
        stableKey: 'ann:0:12R0',
        pageIndex: requirePageIndex(0),
        pageNumber: 1,
        text: 'Marked text',
        subtype: 'Underline',
        author: null,
        modifiedAt: null,
        color: '#ef4444',
        uid: null,
        annotationId: '12R0',
        source: 'pdf',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
    };
}

function createNoteComment(): IAnnotationCommentSummary {
    return {
        annotationId: '12 0 R',
        author: 'Document author',
        color: '#f59e0b',
        createdAt: requireEpochMs(1),
        hasNote: true,
        id: '12R0',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.03,
            height: 0.03,
        },
        modifiedAt: requireEpochMs(1),
        pageIndex: requirePageIndex(0),
        pageNumber: 1,
        source: 'pdf',
        stableKey: 'ann:0:12R0',
        subtype: 'Text',
        text: 'Foreign note',
        uid: null,
    };
}

function createHarness() {
    const application = new AnnotationApplication('test');
    const id = asAnnotationId('anno-markup');
    application.store.createTextMarkup({
        kind: 'text-markup',
        identity: {
            id,
            pdfRef: '12R0',
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        subtype: 'Underline',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ef4444',
        opacity: 0.8,
    });
    return {
        application,
        comment: createComment(id),
    };
}

describe('updateAnnotationColor', () => {
    it('updates a canonical sticky note without routing through PDF.js', () => {
        const application = new AnnotationApplication('test');
        const id = asAnnotationId('anno-note');
        application.store.createNote({
            kind: 'note',
            identity: {
                id,
                pdfRef: '12 0 R',
            },
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: requireEpochMs(1),
            modifiedAt: requireEpochMs(1),
            author: 'Document author',
            contents: 'Foreign note',
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.03,
                height: 0.03,
            },
            color: '#f59e0b',
            open: false,
        });

        expect(updateAnnotationColor(application, createNoteComment(), '#22c55e')).toBe(true);
        expect(application.store.get(id)).toMatchObject({
            kind: 'note',
            color: '#22c55e',
        });
    });

    it('updates the canonical text-markup entity for a context-menu colour change', () => {
        const harness = createHarness();

        expect(updateAnnotationColor(harness.application, harness.comment, '#22c55e')).toBe(true);
        expect(harness.application.store.get(asAnnotationId('anno-markup'))).toMatchObject({
            kind: 'text-markup',
            color: '#22c55e',
        });
    });

    it('does not report a change for a deleted canonical markup', () => {
        const harness = createHarness();
        harness.application.store.delete(asAnnotationId('anno-markup'));

        expect(updateAnnotationColor(harness.application, harness.comment, '#22c55e')).toBe(false);
    });

    it('does not report a change when the store rejects the update', () => {
        const harness = createHarness();
        vi.spyOn(harness.application.store, 'updateTextMarkup').mockImplementation(() => undefined as never);

        expect(updateAnnotationColor(harness.application, harness.comment, '#22c55e')).toBe(false);
    });
});
