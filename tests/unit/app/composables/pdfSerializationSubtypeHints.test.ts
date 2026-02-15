import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    collectMarkupSubtypeHints,
    groupMarkupSubtypeHintsByPage,
} from '@app/composables/pdf/pdfSerializationSubtypeHints';

function createComment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'id-1',
        stableKey: 'stable-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'editor',
        ...overrides,
    };
}

describe('pdfSerializationSubtypeHints', () => {
    it('collects only valid editor underline/strikeout hints', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                subtype: 'Underline',
                pageIndex: 0,
                markerRect: {
                    left: 10,
                    top: 20,
                    width: 30,
                    height: 8,
                },
            }),
            createComment({
                subtype: 'StrikeOut',
                pageIndex: 2,
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 3,
                    height: 4,
                },
            }),
            createComment({
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 3,
                    height: 4,
                },
            }),
            createComment({
                subtype: 'Underline',
                pageIndex: 0,
                source: 'pdf',
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 3,
                    height: 4,
                },
            }),
        ]);

        expect(hints).toHaveLength(2);
        expect(hints[0]).toMatchObject({
            subtype: 'Underline',
            pageIndex: 0,
            consumed: false,
        });
        expect(hints[1]).toMatchObject({
            subtype: 'StrikeOut',
            pageIndex: 2,
            consumed: false,
        });
    });

    it('ignores malformed marker rectangles', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                subtype: 'Underline',
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 0,
                    height: 5,
                },
            }),
            createComment({
                subtype: 'StrikeOut',
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 5,
                    height: Number.NaN,
                },
            }),
            createComment({
                subtype: 'Underline',
                markerRect: null,
            }),
        ]);

        expect(hints).toEqual([]);
    });

    it('groups hints by page index', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                subtype: 'Underline',
                pageIndex: 1,
                markerRect: {
                    left: 10,
                    top: 10,
                    width: 5,
                    height: 5,
                },
            }),
            createComment({
                subtype: 'StrikeOut',
                pageIndex: 1,
                markerRect: {
                    left: 20,
                    top: 20,
                    width: 5,
                    height: 5,
                },
            }),
            createComment({
                subtype: 'Underline',
                pageIndex: 3,
                markerRect: {
                    left: 30,
                    top: 30,
                    width: 5,
                    height: 5,
                },
            }),
        ]);

        const grouped = groupMarkupSubtypeHintsByPage(hints);
        expect(grouped.get(1)).toHaveLength(2);
        expect(grouped.get(3)).toHaveLength(1);
        expect(grouped.get(99)).toBeUndefined();
    });
});
