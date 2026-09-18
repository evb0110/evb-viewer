import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { deleteAnnotationById } from '@app/modules/workspace-shell/annotations/deleteAnnotationById';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: vi.fn(),
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}}));

function createComment(overrides?: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'note-1',
        stableKey: 'ann:0:note-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'note text',
        author: null,
        modifiedAt: null,
        color: null,
        uid: 'note-1',
        annotationId: null,
        source: 'editor',
        ...overrides,
    } as IAnnotationCommentSummary;
}

describe('deleteAnnotationById', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('removes the comment the note window asked for', () => {
        const target = createComment();
        const other = createComment({
            id: 'note-2',
            stableKey: 'ann:0:note-2',
            uid: 'note-2',
        });
        const remove = vi.fn();
        const discardHostedNote = vi.fn();

        const deleted = deleteAnnotationById(
            [
                other,
                target,
            ],
            annotationIdForSummary(target),
            remove,
            discardHostedNote,
        );

        expect(deleted).toBe(true);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith(target);
        expect(discardHostedNote).not.toHaveBeenCalled();
        expect(BrowserLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
        {
            annotationKind: 'text-markup' as const,
            subtype: 'highlight',
        },
        {
            annotationKind: 'text-box' as const,
            subtype: 'freetext',
        },
        {subtype: 'Underline'},
    ])('discards only the note when $subtype hosts it', (overrides) => {
        const target = createComment(overrides);
        const remove = vi.fn();
        const discardHostedNote = vi.fn();

        const deleted = deleteAnnotationById(
            [target],
            annotationIdForSummary(target),
            remove,
            discardHostedNote,
        );

        expect(deleted).toBe(true);
        expect(remove).not.toHaveBeenCalled();
        expect(discardHostedNote).toHaveBeenCalledWith(target);
    });

    it('removes a sticky note, which is its own annotation', () => {
        const target = createComment({
            annotationKind: 'note',
            subtype: 'text',
        });
        const remove = vi.fn();
        const discardHostedNote = vi.fn();

        deleteAnnotationById([target], annotationIdForSummary(target), remove, discardHostedNote);

        expect(remove).toHaveBeenCalledWith(target);
        expect(discardHostedNote).not.toHaveBeenCalled();
    });

    it('reports a stale note-window delete instead of removing an unrelated comment', () => {
        const remove = vi.fn();

        const deleted = deleteAnnotationById(
            [createComment()],
            'annotation-that-left-the-projection',
            remove,
            vi.fn(),
        );

        expect(deleted).toBe(false);
        expect(remove).not.toHaveBeenCalled();
        expect(BrowserLogger.warn).toHaveBeenCalledTimes(1);
        expect(vi.mocked(BrowserLogger.warn).mock.calls[0]).toEqual([
            'annotations',
            expect.any(String),
            expect.objectContaining({
                annotationId: 'annotation-that-left-the-projection',
                commentCount: 1,
            }),
        ]);
    });

    it('reports an empty projection without throwing', () => {
        expect(() => deleteAnnotationById([], 'missing-annotation', vi.fn(), vi.fn())).not.toThrow();
        expect(BrowserLogger.warn).toHaveBeenCalledTimes(1);
    });
});
