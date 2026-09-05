import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {shallowRef} from 'vue';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationColorCommands} from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';

function createComment(appAnnotationId: string): IAnnotationCommentSummary {
    return {
        appAnnotationId,
        id: '12R0',
        stableKey: 'ann:0:12R0',
        pageIndex: 0,
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
        createdAt: 1,
        hasNote: true,
        id: '12R0',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.03,
            height: 0.03,
        },
        modifiedAt: 1,
        pageIndex: 0,
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
        pageIndex: 0,
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
    const annotationCommentModel = {
        toTextMarkupSubtype: vi.fn(() => 'Underline' as const),
        updateCachedColor: vi.fn(),
    };
    const emitForcedAnnotationMutation = vi.fn();
    const commands = usePdfAnnotationColorCommands({
        annotationApplication: shallowRef(application),
        annotationCommentModel: annotationCommentModel as never,
        emitForcedAnnotationMutation,
    });
    return {
        application,
        commands,
        annotationCommentModel,
        emitForcedAnnotationMutation,
        comment: createComment(id),
    };
}

describe('usePdfAnnotationColorCommands', () => {
    it('updates a canonical sticky note without routing through PDF.js', () => {
        const application = new AnnotationApplication('test');
        const id = asAnnotationId('anno-note');
        application.store.createNote({
            kind: 'note',
            identity: {
                id,
                pdfRef: '12 0 R',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: 1,
            modifiedAt: 1,
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
        const annotationCommentModel = {
            toTextMarkupSubtype: vi.fn(),
            updateCachedColor: vi.fn(),
        };
        const emitForcedAnnotationMutation = vi.fn();
        const commands = usePdfAnnotationColorCommands({
            annotationApplication: shallowRef(application),
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation,
        });

        const result = commands.updateTextMarkupAnnotationColor(createNoteComment(), '#22c55e');

        expect(result).toMatchObject({
            updated: true,
            sourceColor: '#f59e0b',
            shouldScheduleCommentSync: true,
            shouldRefreshPage: false,
            comment: expect.objectContaining({
                color: '#22c55e',
                colorEdited: true,
            }),
        });
        expect(application.store.get(id)).toMatchObject({
            kind: 'note',
            color: '#22c55e',
        });
        expect(annotationCommentModel.toTextMarkupSubtype).not.toHaveBeenCalled();
        expect(annotationCommentModel.updateCachedColor).not.toHaveBeenCalled();
        expect(emitForcedAnnotationMutation).toHaveBeenCalledWith({scheduleCommentSync: true});
    });

    it('updates the canonical text-markup entity for a context-menu colour change', () => {
        const harness = createHarness();

        const result = harness.commands.updateTextMarkupAnnotationColor(harness.comment, '#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: false,
            shouldRefreshPage: false,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                color: '#22c55e',
                colorEdited: true,
            }),
        });
        expect(harness.application.store.get(asAnnotationId('anno-markup'))).toMatchObject({
            kind: 'text-markup',
            color: '#22c55e',
        });
        expect(harness.annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            harness.comment,
            '#22c55e',
            {colorEdited: true},
        );
        expect(harness.emitForcedAnnotationMutation).toHaveBeenCalledWith({scheduleCommentSync: true});
    });

    it('updates the selected canonical text markup without a PDF.js editor', () => {
        const harness = createHarness();
        harness.application.store.select([asAnnotationId('anno-markup')]);

        const result = harness.commands.updateSelectedTextMarkupAnnotationColor('#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                appAnnotationId: 'anno-markup',
                annotationId: 'anno-markup',
                color: '#22c55e',
                subtype: 'Underline',
            }),
        });
        expect(harness.application.store.get(asAnnotationId('anno-markup'))).toMatchObject({color: '#22c55e'});
    });

    it('does not report a mutation when the selected entity is not text markup', () => {
        const application = new AnnotationApplication('test');
        application.store.select([asAnnotationId('missing')]);
        const commands = usePdfAnnotationColorCommands({
            annotationApplication: shallowRef(application),
            annotationCommentModel: {
                toTextMarkupSubtype: vi.fn(() => null),
                updateCachedColor: vi.fn(),
            } as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        expect(commands.updateSelectedTextMarkupAnnotationColor('#22c55e')).toMatchObject({updated: false});
    });

    it('does not mutate the comment cache for a deleted canonical markup', () => {
        const harness = createHarness();
        harness.application.store.delete(asAnnotationId('anno-markup'));

        const result = harness.commands.updateTextMarkupAnnotationColor(harness.comment, '#22c55e');

        expect(result).toMatchObject({updated: false});
        expect(harness.annotationCommentModel.updateCachedColor).not.toHaveBeenCalled();
        expect(harness.emitForcedAnnotationMutation).not.toHaveBeenCalled();
    });

    it('does not publish a color change when the store rejects the update', () => {
        const harness = createHarness();
        vi.spyOn(harness.application.store, 'updateTextMarkup').mockImplementation(() => undefined as never);

        const result = harness.commands.updateTextMarkupAnnotationColor(harness.comment, '#22c55e');

        expect(result).toMatchObject({updated: false});
        expect(harness.annotationCommentModel.updateCachedColor).not.toHaveBeenCalled();
        expect(harness.emitForcedAnnotationMutation).not.toHaveBeenCalled();
    });
});
