import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupDocumentRasterPages,
    isStrongMediaBoxSpread,
    shouldRetryMediaBoxPage,
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
    resolveScanCleanupAnalysisDpi,
} from '@evb/scan-cleanup/core/detection';
import {
    resolveScanCleanupRasterRenderLimits,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
} from '@evb/scan-cleanup/core/rasterValidation';
import type {IScanCleanupDetectionResult} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    INativeScanCleanupPageMetadataV3,
    INativeScanCleanupSplitDiagnosticsV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';

function cropPage(
    pageNumber: number,
    widthPoints: number,
    heightPoints: number,
): IPdfPageSize {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints,
        heightPoints,
        rotation: 0,
        mediaXPoints: 0,
        mediaYPoints: 0,
        mediaWidthPoints: 841.89,
        mediaHeightPoints: 633.89,
    };
}

function retryResult(overrides: Partial<IScanCleanupDetectionResult> = {}): IScanCleanupDetectionResult {
    return {
        pageNumber: requirePageNumber(1),
        classification: 'single-uncut-page',
        confidence: 0.1,
        cutterXPx: null,
        documentPrior: null,
        tier1Verdict: 'single-uncut-page',
        reconciled: false,
        clusterAgreement: 0,
        ...overrides,
    };
}

function strongDiagnostics(overrides: Partial<INativeScanCleanupSplitDiagnosticsV3> = {}) {
    return {
        independentSpreadCues: 4,
        aspectSpreadScore: 0.845,
        centralPositionGatePassed: true,
        bilateralGatePassed: true,
        aspectSupportGatePassed: true,
        outerMarginGatePassed: true,
        evidenceAgreementGatePassed: true,
        abstained: false,
        decisionX: 175,
        ...overrides,
    } as INativeScanCleanupSplitDiagnosticsV3;
}

/** A page that is one full-page scanned image at `ppi`. */
function scannedPage(widthPoints: number, heightPoints: number, ppi: number): IPdfPageSize {
    return {
        ...cropPage(1, widthPoints, heightPoints),
        dominantImageWidthPx: Math.round(widthPoints / 72 * ppi),
        dominantImageHeightPx: Math.round(heightPoints / 72 * ppi),
        dominantImageWidthPoints: widthPoints,
        dominantImageHeightPoints: heightPoints,
    };
}

describe('scan cleanup canonical analysis plane', () => {
    it('keeps 150 DPI for a scan finer than the analysis plane', () => {
        expect(resolveScanCleanupAnalysisDpi(scannedPage(612, 792, 300))).toBe(150);
    });

    // Every stage reads the same page record, so a page whose only images are
    // smaller than the page keeps 150 everywhere; a probe that picks the
    // largest image could otherwise give detection and final cleanup
    // different planes for the same page.
    it('keeps 150 DPI for a page that is not a full-page scan', () => {
        expect(resolveScanCleanupAnalysisDpi(cropPage(1, 612, 792))).toBe(150);
        expect(resolveScanCleanupAnalysisDpi(undefined)).toBe(150);
    });

    // A scan stored at one pixel per point declares a 1 m page. At 150 DPI its
    // 2912x4368 image became 6067x9100 interpolated pixels, over the cap that
    // preview applies to the same raster, so preview failed on that page.
    it('analyzes a coarse scan at its own resolution, inside the shared cap', () => {
        const cover = scannedPage(2912, 4368, 72);
        const dpi = resolveScanCleanupAnalysisDpi(cover);
        const limits = resolveScanCleanupRasterRenderLimits(cover, dpi);

        expect(dpi).toBe(72);
        expect([
            limits.expectedWidthPx,
            limits.expectedHeightPx,
        ]).toEqual([
            2912,
            4368,
        ]);
    });

    it('lowers the plane until an oversized page fits the shared cap', () => {
        const poster = scannedPage(4000, 6000, 300);
        const dpi = resolveScanCleanupAnalysisDpi(poster);
        const limits = resolveScanCleanupRasterRenderLimits(poster, dpi);
        const finer = resolveScanCleanupRasterRenderLimits(poster, dpi + 1);

        expect(limits.expectedWidthPx * limits.expectedHeightPx).toBeLessThanOrEqual(SCAN_CLEANUP_RASTER_MAX_PIXELS);
        expect(finer.expectedWidthPx * finer.expectedHeightPx).toBeGreaterThan(SCAN_CLEANUP_RASTER_MAX_PIXELS);
    });
});

describe('scan cleanup detection raster plan', () => {
    it('gates the MediaBox retry to the Nabuco-style spread signals', () => {
        const page31 = cropPage(31, 358.8, 425.6);
        const page32 = cropPage(32, 616.7, 452.8);
        const page33 = cropPage(33, 702.1, 493.2);
        const page32Result = retryResult({splitDiagnostics: strongDiagnostics()});
        expect(shouldRetryMediaBoxPage(page31, retryResult())).toBe(true);
        expect(shouldRetryMediaBoxPage(page32, page32Result)).toBe(true);
        expect(shouldRetryMediaBoxPage(page33, retryResult({
            tier1Verdict: 'two-page-spread',
            reconciled: true,
        }))).toBe(true);
        expect(shouldRetryMediaBoxPage(cropPage(34, 600, 400), retryResult())).toBe(false);
        const trueSingle = cropPage(35, 300, 400);
        delete trueSingle.mediaWidthPoints;
        expect(shouldRetryMediaBoxPage(trueSingle, retryResult())).toBe(false);
    });

    it('accepts only a strong second-pass spread with local cutter evidence', () => {
        const metadata = {
            layoutClassification: 'two-page-spread',
            cutterXPx: 175,
            rotationDegrees: 0,
            canvasScope: 'page',
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 0,
            splitDiagnostics: strongDiagnostics({aspectSpreadScore: 0.711}),
        } as INativeScanCleanupPageMetadataV3;
        const progress = {
            stage: 'page-complete',
            completedPages: 1,
            totalPages: 1,
            pageNumber: 1,
            classification: 'two-page-spread',
            tier1Verdict: 'two-page-spread',
            confidence: 0.91,
            cutterXPx: 175,
        } as TNativeScanCleanupProgressV3;
        expect(isStrongMediaBoxSpread(progress, metadata, 351, 265)).toBe(true);
        expect(isStrongMediaBoxSpread(
            progress,
            {
                ...metadata,
                splitDiagnostics: strongDiagnostics({outerMarginGatePassed: false}),
            },
            351,
            265,
        )).toBe(true);
        expect(isStrongMediaBoxSpread(
            {
                ...progress,
                cutterXPx: 20,
            },
            metadata,
            351,
            265,
        )).toBe(false);
    });

    it('keeps source stroke samples for binary preview cleanup', () => {
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'bw',
            sourceDpi: 300,
        })).toBe(300);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: undefined,
            sourceDpi: 240,
        })).toBe(240);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'grayscale',
            sourceDpi: 300,
        })).toBe(150);
        expect(resolvePreviewProcessingDpi({
            displayDpi: 150,
            outputMode: 'mixed',
            sourceDpi: 600,
        })).toBe(300);
    });

    it('uses structural raster DPI when page geometry has no dominant image metadata', () => {
        const plan = resolvePreviewRasterPlan([
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 439.6,
                heightPoints: 670,
                rotation: 0,
            },
            {
                pageNumber: 2,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 439.6,
                heightPoints: 670,
                rotation: 0,
            },
        ], new Map([
            [
                1,
                360,
            ],
            [
                2,
                82,
            ],
        ]));

        expect(plan.dpi).toBe(150);
        expect(plan.pageDpiByNumber.get(1)).toBe(360);
        expect(plan.pageDpiByNumber.get(2)).toBe(82);
    });

    it('projects detected page raster metadata into the run-level page sets and maps', () => {
        const rasterPages = createScanCleanupDocumentRasterPages(true, new Map([
            [
                1,
                {
                    dpi: 300,
                    height: 1_200,
                    hasBilevelLayer: true,
                    hasDominantBilevelLayer: true,
                    width: 800,
                    backgroundDpi: 150,
                },
            ],
            [
                2,
                {
                    dpi: 150,
                    height: 900,
                    width: 600,
                },
            ],
        ]));

        expect(rasterPages).toMatchObject({
            detected: true,
            documentDpi: 300,
            compactLayeredPageCount: 1,
            compactLayeredPageCountComplete: true,
        });
        expect(rasterPages.getPageRaster(1)).toEqual({
            dpi: 300,
            height: 1_200,
            hasBilevelLayer: true,
            hasDominantBilevelLayer: true,
            width: 800,
            backgroundDpi: 150,
        });
        expect(rasterPages.getPageRaster(2)).toEqual({
            dpi: 150,
            height: 900,
            width: 600,
        });
    });
});
