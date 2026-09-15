import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentRasterResidencyPlan } from '@app/modules/document-viewer/rendering/resolveDocumentRasterResidencyPlan';

describe('document raster residency planning', () => {
    it('admits nearest mounted surfaces under one aggregate budget', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                6,
                7,
                8,
                9,
                10,
                11,
                12,
            ],
            visiblePages: [9],
            bufferRadius: 3,
            maxBufferPixels: 40,
            estimatePagePixels: () => 10,
        });

        expect(plan.visiblePages).toEqual([9]);
        expect(plan.bufferPages).toEqual([
            10,
            8,
            11,
            7,
        ]);
        expect(plan.estimatedBufferPixels).toBeLessThanOrEqual(40);
    });

    it('supports non-contiguous visibility anchors during navigation handoff', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                1,
                2,
                3,
                5,
                6,
            ],
            visiblePages: [
                1,
                6,
            ],
            bufferRadius: 1,
            maxBufferPixels: 20,
            estimatePagePixels: () => 10,
        });

        expect(plan.visiblePages).toEqual([
            1,
            6,
        ]);
        expect(plan.bufferPages).toEqual([
            5,
            2,
        ]);
        expect(plan.residentPages).toEqual([
            1,
            6,
            5,
            2,
        ]);
    });

    it('retains visible geometry while mount bookkeeping catches up without charging it to the buffer budget', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                3,
                4,
                5,
            ],
            visiblePages: [
                2,
                4,
            ],
            bufferRadius: 2,
            maxBufferPixels: 2,
            estimatePagePixels: () => 100,
        });

        expect(plan.visiblePages).toEqual([
            2,
            4,
        ]);
        expect(plan.bufferPages).toEqual([
            5,
            3,
        ]);
        expect(plan.estimatedBufferPixels).toBe(2);
        expect(plan.residentPages).toEqual([
            2,
            4,
            5,
            3,
        ]);
    });

    it('supports a renderer latency floor without changing visible-page accounting', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                1,
                2,
                3,
                4,
                5,
                6,
            ],
            visiblePages: [1],
            bufferRadius: 5,
            maxBufferPixels: 100,
            minimumBufferPages: 4,
            estimatePagePixels: () => 1_000,
        });

        expect(plan.bufferPages).toEqual([
            2,
            3,
            4,
            5,
        ]);
        expect(plan.estimatedBufferPixels).toBe(100);
    });

    it('spends the latency floor ahead of the current scroll direction', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                6,
                7,
                8,
                9,
                10,
                11,
                12,
                13,
                14,
            ],
            visiblePages: [10],
            bufferRadius: 4,
            maxBufferPixels: 100,
            minimumBufferPages: 4,
            preferredDirection: 1,
            estimatePagePixels: () => 1_000,
        });

        expect(plan.bufferPages).toEqual([
            11,
            12,
            13,
            14,
        ]);
    });

    it('caps retained buffers independently from a generous byte budget', () => {
        const plan = resolveDocumentRasterResidencyPlan({
            mountedPages: [
                6,
                7,
                8,
                9,
                10,
                11,
                12,
                13,
            ],
            visiblePages: [
                9,
                10,
            ],
            bufferRadius: 4,
            maxBufferPixels: Number.MAX_SAFE_INTEGER,
            maximumResidentPages: 5,
            minimumBufferPages: 4,
            estimatePagePixels: () => 1,
        });

        expect(plan.visiblePages).toEqual([
            9,
            10,
        ]);
        expect(plan.bufferPages).toHaveLength(3);
        expect(plan.residentPages).toHaveLength(5);
    });
});
