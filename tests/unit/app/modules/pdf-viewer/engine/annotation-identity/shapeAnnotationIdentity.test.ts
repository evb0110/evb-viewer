import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    computeShapeCommentStableKey,
    getNormalizedShapeAnnotationId,
    getNormalizedShapeStableKey,
    shapeStableRefsMatch,
} from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-identity/shapeAnnotationIdentity';

function shape(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        annotationId: null,
        color: '#000000',
        height: 0.2,
        id: 'shape-id',
        opacity: 1,
        pageIndex: 0,
        source: 'local',
        stableKey: null,
        strokeWidth: 1,
        type: 'rectangle',
        width: 0.3,
        x: 0.1,
        y: 0.2,
        ...overrides,
    };
}

describe('shape annotation identity', () => {
    it('keeps shape comment stable keys in the shape namespace', () => {
        expect(computeShapeCommentStableKey(shape({
            annotationId: '12R',
            id: 'local-id',
            pageIndex: 2,
            stableKey: 'evb-shape:stable',
        }))).toBe('nm:evb-shape:stable');

        expect(computeShapeCommentStableKey(shape({
            annotationId: '12R',
            id: 'local-id',
            pageIndex: 2,
            stableKey: null,
        }))).toBe('ann:2:12R');

        expect(computeShapeCommentStableKey(shape({
            annotationId: null,
            id: 'local-id',
            pageIndex: 2,
            stableKey: null,
        }))).toBe('ann:2:local-id');
    });

    it('normalizes managed stable keys and pdf annotation ids', () => {
        expect(getNormalizedShapeStableKey(shape({ stableKey: ' evb-shape:stable ' }))).toBe('evb-shape:stable');
        expect(getNormalizedShapeAnnotationId(shape({ annotationId: '12R0' }))).toBe('12R');
    });

    it('matches durable shape refs by stable key before normalized annotation id', () => {
        expect(shapeStableRefsMatch(
            shape({
                annotationId: '12R0',
                stableKey: 'evb-shape:one',
            }),
            shape({
                annotationId: '99R0',
                stableKey: ' evb-shape:one ',
            }),
        )).toBe(true);

        expect(shapeStableRefsMatch(
            shape({
                annotationId: '12R0',
                stableKey: null,
            }),
            shape({
                annotationId: '12R',
                stableKey: null,
            }),
        )).toBe(true);

        expect(shapeStableRefsMatch(
            shape({
                annotationId: '12R0',
                stableKey: null,
            }),
            shape({
                annotationId: '13R',
                stableKey: null,
            }),
        )).toBe(false);
    });
});
