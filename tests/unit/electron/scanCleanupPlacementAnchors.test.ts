import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    buildScanCleanupPlacementAnchorSummary,
    resolveScanCleanupPlacementAnchorFromSummary,
} from '@evb/scan-cleanup/core/placementAnchors';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'color',
    readingOrder: 'ltr',
    thickness: 0,
    crop: false,
    matchPageSize: true,
    pageAlignment: 'ink',
    marginsMm: {
        leftMm: 0,
        topMm: 0,
        rightMm: 0,
        bottomMm: 0,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};

function result(pageNumber: number, yNormalized: number): IScanCleanupDetectionResult {
    const brandedPageNumber = requirePageNumber(pageNumber);
    return {
        pageNumber: brandedPageNumber,
        classification: 'single-uncut-page',
        confidence: 1,
        cutterXPx: null,
        documentPrior: null,
        tier1Verdict: 'single-uncut-page',
        reconciled: true,
        clusterAgreement: 1,
        sourcePageMetadata: {
            pageNumber: brandedPageNumber,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
            sourceDpi: 300,
        },
        pagePlanEvidence: {
            pageNumber: brandedPageNumber,
            rotationDegrees: 0,
            layoutClassification: 'single-uncut-page',
            outputs: {full: {contentBox: {
                xNormalized: 0.1,
                yNormalized,
                widthNormalized: 0.8,
                heightNormalized: 0.7,
                rotationDegrees: 0,
            }}},
        },
    };
}

function resultStore(records: readonly IScanCleanupDetectionResult[]): IScanCleanupDetectionResultStore {
    return {
        pageCount: records.length,
        resultCount: records.length,
        append: async () => undefined,
        replace: async () => undefined,
        getPage: async pageNumber => records[pageNumber - 1],
        readRange: async (firstPageNumber, lastPageNumberExclusive) => records.slice(
            firstPageNumber - 1,
            lastPageNumberExclusive - 1,
        ),
        forEachChunk: async onChunk => {
            for (let firstPageNumber = 1; firstPageNumber <= records.length; firstPageNumber += 1_024) {
                await onChunk(
                    records.slice(firstPageNumber - 1, firstPageNumber + 1_023),
                    firstPageNumber,
                );
            }
        },
        close: async () => undefined,
    };
}

describe('scan-cleanup bounded ink placement summary', () => {
    it('keeps early, middle, and late anchors bounded for a 20,001-page result store', async () => {
        const records = Array.from({length: 20_001}, (_, index) => {
            const pageNumber = index + 1;
            const yNormalized = pageNumber === 10_001
                ? 0.3
                : pageNumber === 20_001
                    ? 0.2
                    : 0.1;
            return result(pageNumber, yNormalized);
        });

        const summary = await buildScanCleanupPlacementAnchorSummary({
            options,
            resultStore: resultStore(records),
            signal: new AbortController().signal,
        });

        expect(summary.sampleCount).toBe(20_001);
        expect(summary.referenceHeightPoints).toBe(792);
        expect(summary.topEdgeNormalized).toBeCloseTo(0.1);
        expect(summary.clusters.length).toBeLessThanOrEqual(256);
        expect(summary.samples.map(sample => sample.pageNumber)).toEqual([
            1,
            10_001,
            20_001,
        ]);
        expect(summary.samples.map(sample => sample.anchor.yNormalized)).toEqual([
            0,
            expect.closeTo(0.2),
            expect.closeTo(0.1),
        ]);
        expect(resolveScanCleanupPlacementAnchorFromSummary(summary, 0.3)).toEqual({yNormalized: expect.closeTo(0.2)});
    });
});
