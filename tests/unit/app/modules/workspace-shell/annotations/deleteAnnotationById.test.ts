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

        const deleted = deleteAnnotationById(
            [
                other,
                target,
            ],
            annotationIdForSummary(target),
            remove,
        );

        expect(deleted).toBe(true);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith(target);
        expect(BrowserLogger.warn).not.toHaveBeenCalled();
    });

    it('reports a stale note-window delete instead of removing an unrelated comment', () => {
        const remove = vi.fn();

        const deleted = deleteAnnotationById(
            [createComment()],
            'annotation-that-left-the-projection',
            remove,
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
        expect(() => deleteAnnotationById([], 'missing-annotation', vi.fn())).not.toThrow();
        expect(BrowserLogger.warn).toHaveBeenCalledTimes(1);
    });
});
