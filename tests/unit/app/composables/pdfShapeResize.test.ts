import {
    describe,
    expect,
    it,
} from 'vitest';
import { getPointMinMaxBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getPointMinMaxBounds';
import { toShapeRect } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/toShapeRect';

describe('pdfShapeResize', () => {
    it('computes min/max bounds from polygon points', () => {
        const points = [
            {
                x: 0.2,
                y: 0.3,
            },
            {
                x: 0.8,
                y: 0.25,
            },
            {
                x: 0.45,
                y: 0.9,
            },
        ];

        expect(getPointMinMaxBounds(points)).toEqual({
            minX: 0.2,
            minY: 0.25,
            maxX: 0.8,
            maxY: 0.9,
        });
    });

    it('returns null bounds for empty point arrays', () => {
        expect(getPointMinMaxBounds([])).toBeNull();
    });

    it('enforces minSize 0.01 for degenerate single-point shapes via toShapeRect', () => {
        const bounds = getPointMinMaxBounds([{
            x: 0.4,
            y: 0.6,
        }]);
        expect(bounds).not.toBeNull();
        const rect = toShapeRect(bounds!, 0.01);

        expect(rect.minX).toBeCloseTo(0.4);
        expect(rect.minY).toBeCloseTo(0.6);
        expect(rect.maxX - rect.minX).toBeCloseTo(0.01);
        expect(rect.maxY - rect.minY).toBeCloseTo(0.01);
    });

    it('enforces minSize 0.0001 for degenerate single-point shapes via toShapeRect', () => {
        const bounds = getPointMinMaxBounds([
            {
                x: 0.5,
                y: 0.5,
            },
            {
                x: 0.5,
                y: 0.5,
            },
        ]);
        expect(bounds).not.toBeNull();
        const rect = toShapeRect(bounds!, 0.0001);

        expect(rect.minX).toBeCloseTo(0.5);
        expect(rect.minY).toBeCloseTo(0.5);
        expect(rect.maxX - rect.minX).toBeCloseTo(0.0001);
        expect(rect.maxY - rect.minY).toBeCloseTo(0.0001);
    });

    it('preserves bounds wider than minSize when calling toShapeRect', () => {
        const rect = toShapeRect({
            minX: 0.1,
            minY: 0.2,
            maxX: 0.6,
            maxY: 0.5,
        }, 0.01);

        expect(rect).toEqual({
            minX: 0.1,
            minY: 0.2,
            maxX: 0.6,
            maxY: 0.5,
        });
    });
});
