import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    buildScanCleanupPlacementAnchorSummary,
    resolveScanCleanupSheetAnchorsFromSummary,
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

function result(pageNumber: number, yNormalized: number, heightPoints = 792): IScanCleanupDetectionResult {
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
            heightPoints,
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

function resultStore(
    records: readonly IScanCleanupDetectionResult[],
): IScanCleanupDetectionResultStore {
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
                const chunk = records.slice(firstPageNumber - 1, firstPageNumber + 1_023);
                await onChunk(
                    chunk,
                    firstPageNumber,
                );
            }
        },
        close: async () => undefined,
    };
}

describe('scan-cleanup bounded ink placement summary', () => {
    it('recomputes current-option calibration at the 1,024/1,025 boundary with mixed sheets', async () => {
        const records = Array.from({length: 1_025}, (_, index) => {
            const pageNumber = index + 1;
            return result(pageNumber, pageNumber === 1 ? 0.1 : 0.2, pageNumber === 512 ? 396 : 792);
        });

        const initial = await buildScanCleanupPlacementAnchorSummary({
            options,
            resultStore: resultStore(records),
            signal: new AbortController().signal,
            identity: {
                documentRevision: 'revision-boundary',
                detectionSignature: 'detection-boundary',
                calibrationSignature: 'calibration-initial',
            },
        });

        expect(initial.sampleCount).toBe(1_025);
        expect(initial.referenceHeightPoints).toBe(792);
        expect(initial.topEdgeNormalized).toBeCloseTo(0.2);
        expect(resolveScanCleanupSheetAnchorsFromSummary(initial, {full: 0.2}).full).toEqual({yNormalized: 0});

        const currentOptions = structuredClone(options);
        currentOptions.pageOverrides['1'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: true,
            manualSplit: null,
        };
        currentOptions.pageOverrides['2'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.3,
                widthNormalized: 0.8,
                heightNormalized: 0.7,
                rotationDegrees: 0,
            }},
        };
        currentOptions.pageOverrides['3'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            placementOverrides: {full: 'top-center'},
        };
        const current = await buildScanCleanupPlacementAnchorSummary({
            options: currentOptions,
            resultStore: resultStore(records),
            signal: new AbortController().signal,
            identity: {
                documentRevision: 'revision-boundary',
                detectionSignature: 'detection-boundary',
                calibrationSignature: 'calibration-current-options',
            },
        });

        expect(current.sampleCount).toBe(1_023);
        expect(current.topEdgeNormalized).toBeCloseTo(0.2);
        expect(resolveScanCleanupSheetAnchorsFromSummary(current, {full: 0.2}).full).toEqual({yNormalized: 0});
        expect(resolveScanCleanupSheetAnchorsFromSummary(current, {full: 0.3}).full).toEqual({yNormalized: expect.closeTo(0.1)});
        expect(current.identity.calibrationSignature).toBe('calibration-current-options');
    });

    it('prints two leaves whose ink agrees at one height when it sits below the running heads', async () => {
        // The shape of a scanned book's front matter: running heads with a
        // shoulder above and a tail below, and a title opening whose two leaves
        // start 0.5 mm apart, a few millimetres under the tail. The 4 mm
        // tolerance is 0.0143 of this sheet.
        const tops = [
            0.0597,
            0.058,
            0.03,
            ...Array.from({length: 30}, () => 0.04),
            0.045,
        ];
        const records = tops.map((top, index) => result(index + 1, top));

        const summary = await buildScanCleanupPlacementAnchorSummary({
            options,
            resultStore: resultStore(records),
            signal: new AbortController().signal,
            identity: {
                documentRevision: 'revision-title-opening',
                detectionSignature: 'detection-title-opening',
                calibrationSignature: 'calibration-title-opening',
            },
        });

        const verso = resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.0597}).full?.yNormalized;
        const recto = resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.058}).full?.yNormalized;
        expect(verso).toBe(recto);
        expect(recto).toBeCloseTo(0.018, 10);
        expect(resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.04}).full).toEqual({yNormalized: 0});
    });

    it('measures ink against the leaves a taller cover would otherwise outgrow', async () => {
        // The matched canvas is the leaves' paper, so ink anchors must be
        // fractions of the leaf height: measured against the cover, every
        // leaf's ink would land higher than it was measured.
        const records = Array.from({length: 40}, (_, index) => {
            const pageNumber = index + 1;
            return result(pageNumber, 0.2, pageNumber === 1 ? 1_100 : 792);
        });

        const summary = await buildScanCleanupPlacementAnchorSummary({
            options,
            resultStore: resultStore(records),
            signal: new AbortController().signal,
            identity: {
                documentRevision: 'revision-cover',
                detectionSignature: 'detection-cover',
                calibrationSignature: 'calibration-cover',
            },
        });

        expect(summary.referenceHeightPoints).toBe(792);
    });

    it('places early, middle, and late pages of a 20,001-page result store from bounded calibration', async () => {
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
            identity: {
                documentRevision: 'revision-1',
                detectionSignature: 'detection-1',
                calibrationSignature: 'calibration-1',
            },
        });

        expect(summary.sampleCount).toBe(20_001);
        expect(summary.referenceHeightPoints).toBe(792);
        expect(summary.topEdgeNormalized).toBeCloseTo(0.1);
        expect(summary.clusters.length).toBeLessThanOrEqual(256);
        expect(resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.1}).full).toEqual({yNormalized: 0});
        expect(resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.3}).full).toEqual({yNormalized: expect.closeTo(0.2)});
        expect(resolveScanCleanupSheetAnchorsFromSummary(summary, {full: 0.2}).full).toEqual({yNormalized: expect.closeTo(0.1)});
    });

});
