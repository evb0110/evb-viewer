import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IShapeAnnotation } from '@app/types/annotations';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';

function expectMarkerRect(
    markerRect: ReturnType<typeof toShapeAnnotationCommentSummary>['markerRect'],
    expected: {
        left: number;
        top: number;
        width: number;
        height: number;
    },
) {
    expect(markerRect).not.toBeNull();
    expect(markerRect!.left).toBeCloseTo(expected.left);
    expect(markerRect!.top).toBeCloseTo(expected.top);
    expect(markerRect!.width).toBeCloseTo(expected.width);
    expect(markerRect!.height).toBeCloseTo(expected.height);
}

function createShape(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'shape-1',
        type: 'rectangle',
        pageIndex: 2,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: '#336699',
        opacity: 0.75,
        strokeWidth: 2,
        ...overrides,
    };
}

describe('shapeAnnotationComments', () => {
    it('builds sidebar-only summaries for shape annotations', () => {
        const summary = toShapeAnnotationCommentSummary(createShape({
            annotationId: '12R0',
            stableKey: 'evb-shape:stable-rect',
            source: 'embedded',
            pdfSubtype: 'Square',
        }));

        expect(summary).toMatchObject({
            id: 'shape-1',
            stableKey: 'nm:evb-shape:stable-rect',
            pageIndex: 2,
            pageNumber: 3,
            text: '',
            previewText: null,
            subtype: 'Square',
            color: '#336699',
            fillColor: null,
            opacity: 0.75,
            strokeWidth: 2,
            annotationId: '12R0',
            source: 'shape',
            hasNote: false,
        });
        expectMarkerRect(summary.markerRect, {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        });
    });

    it('labels local arrows with an arrow subtype instead of a generic line subtype', () => {
        const summary = toShapeAnnotationCommentSummary(createShape({
            id: 'shape-arrow',
            type: 'arrow',
            pageIndex: 0,
            x: 0.2,
            y: 0.3,
            x2: 0.6,
            y2: 0.7,
            width: 0.4,
            height: 0.4,
        }));

        expect(summary.subtype).toBe('Arrow');
        expect(summary.stableKey).toBe('ann:0:shape-arrow');
    });

    it('carries drawing timestamps into sidebar summaries', () => {
        const summary = toShapeAnnotationCommentSummary(createShape({
            createdAt: 100,
            modifiedAt: 200,
        }));

        expect(summary.createdAt).toBe(100);
        expect(summary.modifiedAt).toBe(200);
    });

    it('uses caller-provided sort index for sidebar ordering', () => {
        const summary = toShapeAnnotationCommentSummary(createShape(), 4);

        expect(summary.sortIndex).toBe(4);
    });

    it('uses point bounds for ink-like shapes', () => {
        const summary = toShapeAnnotationCommentSummary(createShape({
            id: 'shape-ink',
            type: 'polyline',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            points: [
                {
                    x: 0.3,
                    y: 0.4,
                },
                {
                    x: 0.5,
                    y: 0.65,
                },
            ],
            pdfSubtype: 'Ink',
        }));

        expect(summary.subtype).toBe('Ink');
        expectMarkerRect(summary.markerRect, {
            left: 0.3,
            top: 0.4,
            width: 0.2,
            height: 0.25,
        });
    });
});
