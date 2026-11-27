import {describe, expect, it} from 'vitest';
import {resolvePdfRasterResidencyPlan} from '@app/modules/pdf-viewer/runtime/rendering/resolvePdfRasterResidencyPlan';

describe('PDF raster residency planning', () => {
    it('keeps a large mounted geometry window while admitting only the nearest affordable canvases', () => {
        const plan = resolvePdfRasterResidencyPlan({
            mountedPages: Array.from({length: 37}, (_, index) => 103 + index),
            visibleRange: {
                start: 121,
                end: 121,
            },
            bufferRadius: 4,
            maxBufferPixels: 33_554_432,
            estimatePagePixels: () => 15_188_468,
        });

        expect(plan.visiblePages).toEqual([121]);
        expect(plan.bufferPages).toEqual([122, 120]);
        expect(plan.residentPages).toEqual([121, 122, 120]);
        expect(plan.estimatedBufferPixels).toBeLessThanOrEqual(33_554_432);
        expect(plan.maxPixelsPerBufferCanvas).toBe(16_777_216);
    });

    it('uses spare aggregate pixels for farther pages only after nearer pairs', () => {
        const plan = resolvePdfRasterResidencyPlan({
            mountedPages: [7, 8, 9, 10, 11, 12, 13],
            visibleRange: {
                start: 10,
                end: 10,
            },
            bufferRadius: 3,
            maxBufferPixels: 100,
            estimatePagePixels: (pageNumber) => (pageNumber === 10 ? 1000 : 10),
        });

        expect(plan.bufferPages).toEqual([11, 9, 12, 8, 13, 7]);
        expect(plan.estimatedBufferPixels).toBe(60);
    });

    it('never charges visible pages against the aggregate buffer budget', () => {
        const plan = resolvePdfRasterResidencyPlan({
            mountedPages: [4, 5, 6, 7],
            visibleRange: {
                start: 5,
                end: 6,
            },
            bufferRadius: 1,
            maxBufferPixels: 20,
            estimatePagePixels: () => 100,
        });

        expect(plan.visiblePages).toEqual([5, 6]);
        expect(plan.bufferPages).toEqual([7, 4]);
        expect(plan.estimatedBufferPixels).toBe(20);
    });
});
