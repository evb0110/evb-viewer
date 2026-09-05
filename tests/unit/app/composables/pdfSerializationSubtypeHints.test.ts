import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/collectMarkupSubtypeHints';
import { groupMarkupSubtypeHintsByPage } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/groupMarkupSubtypeHintsByPage';

function createComment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'id-1',
        stableKey: 'ann:0:stable-1',
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
    it('collects editor rewrite hints and highlight preservation hints', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                subtype: 'Underline',
                pageIndex: 0,
                color: '#22c55e',
                colorEdited: true,
                markerRect: {
                    left: 10,
                    top: 20,
                    width: 30,
                    height: 8,
                },
                markupGeometry: [
                    {
                        left: 10,
                        top: 20,
                        width: 12,
                        height: 8,
                    },
                    {
                        left: 28,
                        top: 20,
                        width: 12,
                        height: 8,
                    },
                ],
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
                source: 'pdf',
                annotationId: '12R',
                color: '#facc15',
                colorEdited: true,
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

        expect(hints).toHaveLength(4);
        expect(hints[0]).toMatchObject({
            id: 'id-1',
            subtype: 'Underline',
            pageIndex: 0,
            consumed: false,
            color: '#22c55e',
            pageMarkupIndex: 0,
            markupGeometry: [
                {
                    left: 10,
                    top: 20,
                    width: 12,
                    height: 8,
                },
                {
                    left: 28,
                    top: 20,
                    width: 12,
                    height: 8,
                },
            ],
        });
        expect(hints[1]).toMatchObject({
            subtype: 'StrikeOut',
            pageIndex: 2,
            consumed: false,
            pageMarkupIndex: 0,
        });
        expect(hints[2]).toMatchObject({
            annotationId: '12R',
            subtype: 'Highlight',
            pageIndex: 0,
            consumed: false,
            color: '#facc15',
            pageMarkupIndex: 1,
        });
        expect(hints[3]).toMatchObject({
            subtype: 'Underline',
            pageIndex: 0,
            consumed: false,
            source: 'pdf',
            pageMarkupIndex: 2,
        });
    });

    it('does not persist passive colors sampled from existing PDF markup', () => {
        const hints = collectMarkupSubtypeHints([createComment({
            subtype: 'Highlight',
            pageIndex: 0,
            source: 'pdf',
            annotationId: '12R',
            color: '#facc15',
            markerRect: {
                left: 1,
                top: 2,
                width: 3,
                height: 4,
            },
        })]);

        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({
            annotationId: '12R',
            subtype: 'Highlight',
            color: null,
        });
    });

    it('keeps highlight comments in the page markup order when collecting preservation hints', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                id: 'highlight-1',
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
                id: 'underline-1',
                subtype: 'Underline',
                pageIndex: 0,
                markerRect: {
                    left: 10,
                    top: 20,
                    width: 30,
                    height: 8,
                },
            }),
        ]);

        expect(hints).toHaveLength(2);
        expect(hints[0]).toMatchObject({
            id: 'highlight-1',
            pageMarkupIndex: 0,
            subtype: 'Highlight',
        });
        expect(hints[1]).toMatchObject({
            id: 'underline-1',
            pageMarkupIndex: 1,
            subtype: 'Underline',
        });
    });

    it('normalizes lowercase text markup subtypes from comment summaries', () => {
        const hints = collectMarkupSubtypeHints([
            createComment({
                subtype: 'highlight',
                markerRect: {
                    left: 1,
                    top: 2,
                    width: 3,
                    height: 4,
                },
            }),
            createComment({
                subtype: 'strikethrough',
                markerRect: {
                    left: 5,
                    top: 6,
                    width: 7,
                    height: 8,
                },
            }),
        ]);

        expect(hints.map(hint => hint.subtype)).toEqual([
            'Highlight',
            'StrikeOut',
        ]);
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
