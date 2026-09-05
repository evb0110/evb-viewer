import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    annotationCommentsMatch,
    dedupeAnnotationCommentSummaries,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function summary(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'editor-1',
        stableKey: 'ann:0:editor-1',
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

describe('annotationSummaryIdentity', () => {
    it('uses immutable app identity ahead of all external bindings', () => {
        expect(annotationCommentsMatch(
            summary({
                appAnnotationId: 'anno-1',
                annotationId: '12R',
            }),
            summary({
                appAnnotationId: 'anno-1',
                annotationId: 'different',
            }),
        )).toBe(true);
        expect(annotationCommentsMatch(
            summary({
                appAnnotationId: 'anno-1',
                annotationId: '12R',
            }),
            summary({
                appAnnotationId: 'anno-2',
                annotationId: '12R',
            }),
        )).toBe(false);
    });

    it('never merges records from geometry or text alone', () => {
        const markerRect = {
            left: 0.1,
            top: 0.1,
            width: 0.2,
            height: 0.02,
        };
        const comments = dedupeAnnotationCommentSummaries([
            summary({
                id: 'one',
                text: 'same',
                markerRect,
            }),
            summary({
                id: 'two',
                text: 'same',
                markerRect,
            }),
        ]);
        expect(comments).toHaveLength(2);
    });

    it('keeps reference identity stable until annotation-name enrichment arrives', () => {
        const referenceSummary = summary({
            id: 'pdf:0:12R0',
            stableKey: 'ann:0:12R0',
            source: 'pdf',
            annotationId: '12R0',
        });
        const enrichedSummary = summary({
            id: 'pdf:0:12R0',
            stableKey: 'nm:stable-name',
            source: 'pdf',
            annotationId: '12R0',
            annotationName: 'stable-name',
        });

        expect(annotationCommentsMatch(referenceSummary, enrichedSummary)).toBe(true);
        expect(dedupeAnnotationCommentSummaries([
            referenceSummary,
            enrichedSummary,
        ])).toHaveLength(1);
    });
});
