import {readFileSync} from 'node:fs';
import {
    decodeNativeScanCleanupOutputMetadata,
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadata,
    decodeNativeScanCleanupPageMetadataJson,
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
    InvalidScanCleanupNativeArtifactError,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {
    MAX_SCAN_CLEANUP_WARNING_EVENTS,
    SCAN_CLEANUP_WARNING_EVENT_CODES,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    INativeScanCleanupSplitDiagnosticsV3,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    describe,
    expect,
    it,
} from 'vitest';

const rect = {
    xPx: 0,
    yPx: 0,
    widthPx: 100,
    heightPx: 200,
};
const appliedMargins = {
    leftPx: 0,
    topPx: 0,
    rightPx: 0,
    bottomPx: 0,
};
const legacyProtocolV3Page = readFileSync(
    new URL('../../fixtures/scan-cleanup/protocol-v3-page-before-fold-band.json', import.meta.url),
    'utf8',
);

function pageMetadata() {
    return {
        sourcePageIndex: 0,
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        cutterXPx: null,
        rotationDegrees: 0,
        canvasScope: 'page',
        excluded: false,
        blankOutputsSkipped: 0,
        outputCount: 1,
        outputs: [{
            half: 'full',
            sourceRegion: rect,
            contentBox: null,
            cropRect: rect,
            appliedMargins,
            inputWidthPx: 100,
            inputHeightPx: 200,
        }],
        tier1Verdict: 'single-uncut-page',
        reconciled: false,
        clusterAgreement: 0,
    };
}

function outputMetadata() {
    return {
        sourcePageIndex: 0,
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        cutterXPx: null,
        sourceRegion: rect,
        contentBox: null,
        cropRect: rect,
        appliedMargins,
        outputWidthPx: 100,
        outputHeightPx: 200,
        canvasWidthPx: 100,
        canvasHeightPx: 200,
        foldClipLeftPx: 2,
        foldClipRightPx: 3,
        inputWidthPx: 100,
        inputHeightPx: 200,
        skewApplied: false,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        inverseTransform: null,
        dewarpModel: null,
        dewarpMapping: null,
        rotationDegrees: 0,
        canvasScope: 'page',
        resamplePasses: 0,
        warnings: [],
    };
}

function fullSplitDiagnostics(): INativeScanCleanupSplitDiagnosticsV3 {
    return {
        analysisDpi: 150,
        deskewAngleDegrees: 0,
        deskewConfidence: 1,
        cutterSlope: 0,
        leftDeskewAngleDegrees: 0,
        rightDeskewAngleDegrees: 0,
        leftDeskewConfidence: 1,
        rightDeskewConfidence: 1,
        whitespaceX: 1075,
        foldX: 1142,
        decisionX: 1198,
        whitespaceScore: 0.98,
        bilateralScore: 1,
        leftPageScore: 1,
        rightPageScore: 1,
        leftContentScore: 1,
        rightContentScore: 1,
        leftSurfaceScore: 1,
        rightSurfaceScore: 1,
        leftInkPixels: 31_717,
        rightInkPixels: 20_784,
        outerMarginScore: 1,
        leftOuterMarginScore: 1,
        rightOuterMarginScore: 1,
        gutterScore: 1,
        agreementScore: 1,
        foldScore: 0.086,
        gutterDarknessScore: 0,
        softGutterScore: 0,
        softGutterCoverage: 0,
        softGutterContinuity: 0,
        softGutterMeanDepression: 0,
        sparseGutterScore: 1,
        sparseGutterCoverage: 1,
        sparseGutterContinuity: 1,
        sparseGutterMeanDepression: 24.64,
        aspectRatio: 1.4,
        aspectSpreadScore: 1,
        aspectSingleScore: 0,
        independentSpreadCues: 3,
        offcutBoundaryScore: 0,
        offcutEmptyScore: 0,
        offcutPopulatedScore: 0,
        offcutWidthScore: 0,
        offcutNoTextRowsScore: 0,
        alternativeProduct: 0,
        evidenceProduct: 0.699,
        whitespaceGatePassed: true,
        centralPositionGatePassed: true,
        bilateralGatePassed: true,
        outerMarginGatePassed: true,
        gutterGatePassed: true,
        independentGutterGatePassed: true,
        aspectSupportGatePassed: true,
        evidenceAgreementGatePassed: true,
        outerMarginRecovery: false,
        outerMarginWeakEdge: null,
        sparseSpreadRecovered: true,
        abstained: false,
        foldBand: {
            status: 'unmeasured',
            reason: 'fold-evidence-unquantified',
            nominalHalfWidthPx: 6,
        },
    };
}

describe('scan-cleanup native artifact codecs', () => {
    it('normalizes a real pre-fold-band protocol-v3 artifact to an honest legacy state', () => {
        const decoded = decodeNativeScanCleanupPageMetadataJson(legacyProtocolV3Page);

        expect(decoded.splitDiagnostics?.foldBand).toEqual({
            status: 'unmeasured',
            reason: 'legacy-protocol-v3',
            nominalHalfWidthPx: 0,
        });
    });

    it('decodes split diagnostics carrying every field the native binary emits, and rejects a payload missing one', () => {
        const diagnostics = fullSplitDiagnostics();
        const page = {
            ...pageMetadata(),
            splitDiagnostics: diagnostics,
        };
        const decoded = decodeNativeScanCleanupPageMetadata(page);
        expect(decoded).toBe(page);
        expect(decoded.splitDiagnostics).toEqual(diagnostics);

        const {
            offcutPopulatedScore: _omitted,
            ...missingField
        } = diagnostics;
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            splitDiagnostics: missingField,
        })).toThrow();
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            splitDiagnostics: {
                ...diagnostics,
                foldBand: {
                    status: 'unmeasured',
                    reason: 'unknown',
                    nominalHalfWidthPx: 6,
                },
            },
        })).toThrow('splitDiagnostics.foldBand.reason');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            splitDiagnostics: {
                ...diagnostics,
                foldBand: {
                    status: 'measured',
                    leftXPx: 1,
                    rightXPx: 2,
                    extra: true,
                },
            },
        })).toThrow('splitDiagnostics.foldBand.extra is not supported');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            splitDiagnostics: {
                ...diagnostics,
                foldBand: null,
            },
        })).toThrow('splitDiagnostics.foldBand must be an object');
    });

    it('decodes page and output artifacts while preserving additive fields', () => {
        const page = {
            ...pageMetadata(),
            futurePageDiagnostic: {producer: 'vNext'},
        };
        const output = {
            ...outputMetadata(),
            futureOutputDiagnostic: {producer: 'vNext'},
        };

        expect(decodeNativeScanCleanupPageMetadata(page)).toBe(page);
        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(decodeNativeScanCleanupPreviewPageMetadataJson(JSON.stringify(page))).toMatchObject({
            futurePageDiagnostic: {producer: 'vNext'},
            tier1Verdict: 'single-uncut-page',
        });
        expect(decodeNativeScanCleanupPreviewOutputMetadataJson(JSON.stringify(output))).toMatchObject({futureOutputDiagnostic: {producer: 'vNext'}});
    });

    it('decodes native ink consistency diagnostics and rejects malformed values', () => {
        const diagnostics = {
            priorSampleCount: 12,
            priorSurvivalMedian: 0.42,
            survivalBefore: 0.31,
            survivalAfter: 0.39,
            addedInkPixels: 240,
            applied: true,
        };
        const output = {
            ...outputMetadata(),
            inkConsistencyDiagnostics: diagnostics,
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            inkConsistencyDiagnostics: {
                ...diagnostics,
                survivalAfter: 1.01,
            },
        })).toThrow('inkConsistencyDiagnostics.survivalAfter');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            inkConsistencyDiagnostics: {
                ...diagnostics,
                addedInkPixels: 1.5,
            },
        })).toThrow('inkConsistencyDiagnostics.addedInkPixels');
    });

    it('rejects malformed JSON and unsupported artifact versions as native failures', () => {
        for (const decode of [
            () => decodeNativeScanCleanupPageMetadataJson('{'),
            () => decodeNativeScanCleanupOutputMetadataJson(JSON.stringify({
                ...outputMetadata(),
                version: 4,
            })),
        ]) {
            expect(decode).toThrow(InvalidScanCleanupNativeArtifactError);
            try {
                decode();
            } catch (error) {
                expect(error).toMatchObject({code: 'native-failure'});
            }
        }
    });

    it('rejects invalid discriminants, non-finite numbers, and oversized page collections', () => {
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            layoutClassification: 'future-layout',
        })).toThrow('unknown discriminant');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            layoutConfidence: Number.NaN,
        })).toThrow('must be finite');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            outputCount: 3,
            outputs: [
                pageMetadata().outputs[0],
                pageMetadata().outputs[0],
                pageMetadata().outputs[0],
            ],
        })).toThrow('protocol limit');
    });

    it('bounds structured warning events and accepts an artifact written without them', () => {
        const fitted = {
            code: 'matched-canvas-content-fitted',
            unit: 'px',
            contentWidth: 60,
            contentHeight: 50,
            innerWidth: 95,
            innerHeight: 95,
            documentCanvasWidth: 100,
            documentCanvasHeight: 100,
        } satisfies TScanCleanupWarningEvent;
        const paperDownscaled = {
            code: 'matched-canvas-paper-downscaled',
            unit: 'px',
            scalePercentTenths: 500,
            documentCanvasWidth: 50,
            documentCanvasHeight: 100,
            paperWidth: 100,
            paperHeight: 200,
        } satisfies TScanCleanupWarningEvent;
        // One decodable payload per code the catalog declares. The catalog owns
        // how many that is, so a code added to the contract without a case here
        // fails on this matrix rather than reaching an artifact undecoded.
        const declared: readonly TScanCleanupWarningEvent[] = [
            fitted,
            {
                code: 'matched-canvas-content-fitted-pages',
                pages: [
                    requirePageNumber(1),
                    requirePageNumber(2),
                    requirePageNumber(5),
                ],
            },
            {code: 'matched-canvas-margins-reduced'},
            {code: 'matched-canvas-margins-unavailable'},
            paperDownscaled,
            {code: 'matched-canvas-optical-centering-fallback'},
            {
                code: 'matched-canvas-intrinsic-overflow',
                leftPx: 7,
                rightPx: 3,
            },
            {
                code: 'matched-canvas-spread-headroom-trimmed',
                topPx: 12,
            },
            {
                code: 'matched-canvas-fold-columns-discarded',
                leftColumns: 5,
                rightColumns: 9,
            },
            {code: 'matched-canvas-dropped'},
            {
                code: 'matched-canvas-geometry-unmeasured',
                detail: 'pdfinfo exited with 1',
            },
            {
                code: 'matched-canvas-pages-resampled',
                pages: [
                    requirePageNumber(3),
                    requirePageNumber(1),
                    requirePageNumber(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES),
                ],
            },
            {
                code: 'matched-canvas-pages-scaled-in-place',
                pages: [requirePageNumber(1)],
            },
            {
                code: 'matched-canvas-document-dpi-normalized',
                canvasDpi: 299.6,
                finestPageDpi: 400.2,
            },
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: requirePageNumber(3),
                appliedDpiThousandths: 200_000,
                requestedDpiThousandths: 300_000,
            },
            {
                code: 'render-dpi-limited',
                appliedDpiThousandths: 288_500,
                requestedDpiThousandths: 400_000,
            },
        ];
        const withEvents = {
            ...outputMetadata(),
            warningEvents: [
                ...declared,
                // The optional rectangles are absent as a pair, and a page
                // list keeps the order its producer found the pages in.
                {
                    code: 'matched-canvas-content-fitted',
                    unit: 'pt',
                    contentWidth: 343.25,
                    contentHeight: 171.7,
                    innerWidth: 371.7,
                    innerHeight: 171.7,
                },
            ],
        };
        const atLimit = {
            ...outputMetadata(),
            warningEvents: Array.from(
                {length: MAX_SCAN_CLEANUP_WARNING_EVENTS},
                () => ({code: 'matched-canvas-margins-reduced'}),
            ),
        };

        expect(declared).toHaveLength(SCAN_CLEANUP_WARNING_EVENT_CODES.length);
        expect(new Set(declared.map(event => event.code)))
            .toEqual(new Set(SCAN_CLEANUP_WARNING_EVENT_CODES));
        expect(decodeNativeScanCleanupOutputMetadata(withEvents)).toBe(withEvents);
        // The ceiling is a bound the contract states, not a number this test
        // decides: one output may report exactly that many conditions.
        expect(decodeNativeScanCleanupOutputMetadata(atLimit)).toBe(atLimit);
        // An artifact written before the structured channel existed keeps its
        // sentences and decodes unchanged.
        expect(decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            warnings: ['Matched page size reduced requested margins because they leave no drawable canvas'],
        }).warningEvents).toBeUndefined();

        // Each rejection names itself. A bare loop reports only the assertion
        // that failed, which for twenty-odd malformed payloads is not enough to
        // tell which payload the decoder let through.
        const rejected: ReadonlyArray<{
            label: string;
            warningEvents: unknown;
        }> = [
            {
                label: 'a code no catalog declares',
                warningEvents: [{code: 'engine-said-something'}],
            },
            {
                label: 'a parameterless code carrying another code\'s parameters',
                warningEvents: [{
                    ...fitted,
                    code: 'matched-canvas-margins-reduced',
                }],
            },
            {
                label: 'a non-finite extent',
                warningEvents: [{
                    ...fitted,
                    contentWidth: Number.NaN,
                }],
            },
            {
                label: 'a fractional pixel extent',
                warningEvents: [{
                    ...fitted,
                    contentWidth: 60.5,
                }],
            },
            {
                label: 'an overflow missing one side',
                warningEvents: [{
                    code: 'matched-canvas-intrinsic-overflow',
                    leftPx: 1,
                }],
            },
            {
                label: 'a detail past the length limit',
                warningEvents: [{
                    code: 'matched-canvas-geometry-unmeasured',
                    detail: 'x'.repeat(513),
                }],
            },
            {
                label: 'an empty page list',
                warningEvents: [{
                    code: 'matched-canvas-pages-resampled',
                    pages: [],
                }],
            },
            // A rectangle is one measurement: half of it is a payload the
            // formatter would have to guess the other half of.
            {
                label: 'a document canvas rectangle missing its height',
                warningEvents: [{
                    ...fitted,
                    documentCanvasHeight: undefined,
                }],
            },
            {
                label: 'a document canvas rectangle missing its width',
                warningEvents: [{
                    ...fitted,
                    documentCanvasWidth: undefined,
                }],
            },
            {
                label: 'a paper rectangle missing its height',
                warningEvents: [{
                    ...paperDownscaled,
                    paperHeight: undefined,
                }],
            },
            {
                label: 'a paper rectangle missing its width',
                warningEvents: [{
                    ...paperDownscaled,
                    paperWidth: undefined,
                }],
            },
            // Every numeric parameter is bounded, not merely finite.
            {
                label: 'an extent past the bound',
                warningEvents: [{
                    ...fitted,
                    contentWidth: 1_000_001,
                }],
            },
            {
                label: 'a scale past the bound',
                warningEvents: [{
                    ...paperDownscaled,
                    scalePercentTenths: 10_001,
                }],
            },
            {
                label: 'a fractional scale in fixed-point tenths',
                warningEvents: [{
                    ...paperDownscaled,
                    scalePercentTenths: 50.5,
                }],
            },
            {
                label: 'a count past the bound',
                warningEvents: [{
                    code: 'matched-canvas-intrinsic-overflow',
                    leftPx: 1_000_001,
                    rightPx: 0,
                }],
            },
            {
                label: 'a normalized DPI past the bound',
                warningEvents: [{
                    code: 'matched-canvas-document-dpi-normalized',
                    canvasDpi: 300,
                    finestPageDpi: 100_001,
                }],
            },
            {
                label: 'a limited render DPI past the bound',
                warningEvents: [{
                    code: 'render-dpi-limited',
                    appliedDpiThousandths: 100_000_001,
                    requestedDpiThousandths: 400_000,
                }],
            },
            {
                label: 'a fractional limited render DPI in fixed-point thousandths',
                warningEvents: [{
                    code: 'render-dpi-limited',
                    appliedDpiThousandths: 288_500.5,
                    requestedDpiThousandths: 400_000,
                }],
            },
            // The capped page reports the same fixed-point DPI the render limit
            // does, so a producer that rounded it in the formatter's language
            // instead of its own is rejected here rather than printed.
            {
                label: 'a fractional capped page DPI in fixed-point thousandths',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpiThousandths: 200_000.5,
                    requestedDpiThousandths: 300_000,
                }],
            },
            {
                label: 'a capped page DPI below one quantum',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpiThousandths: 0,
                    requestedDpiThousandths: 300_000,
                }],
            },
            {
                label: 'a capped page past the page limit',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: Number.MAX_SAFE_INTEGER + 1,
                    appliedDpiThousandths: 200_000,
                    requestedDpiThousandths: 300_000,
                }],
            },
            {
                label: 'a page list naming a page past the page limit',
                warningEvents: [{
                    code: 'matched-canvas-pages-resampled',
                    pages: [Number.MAX_SAFE_INTEGER + 1],
                }],
            },
            // A repeated page means the producer lost count of its own set;
            // the list is a set kept in the order the pages were found.
            {
                label: 'a page list repeating a page',
                warningEvents: [{
                    code: 'matched-canvas-pages-resampled',
                    pages: [
                        3,
                        1,
                        3,
                    ],
                }],
            },
            {
                label: 'one condition past the protocol ceiling',
                warningEvents: Array.from(
                    {length: MAX_SCAN_CLEANUP_WARNING_EVENTS + 1},
                    () => ({code: 'matched-canvas-margins-reduced'}),
                ),
            },
            {
                label: 'a warning channel that is not an array',
                warningEvents: 'not-an-array',
            },
        ];

        expect(new Set(rejected.map(({label}) => label)).size).toBe(rejected.length);
        for (const {
            label,
            warningEvents,
        } of rejected) {
            expect(() => decodeNativeScanCleanupOutputMetadata({
                ...outputMetadata(),
                warningEvents,
            }), label).toThrow(InvalidScanCleanupNativeArtifactError);
        }
    });

    it('normalizes a capped page DPI written before the fixed-point rename', () => {
        // `matched-canvas-page-dpi-capped` once stated both measurements as
        // plain DPI. Artifacts written then are still on disk, so the decoder
        // reads them and hands consumers the canonical payload — the union
        // carries one shape per condition, and the formatter never learns that
        // the old one existed.
        const decodeEvents = (warningEvents: readonly unknown[]) => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            warningEvents,
        }).warningEvents;

        expect(decodeEvents([
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 3,
                appliedDpi: 200,
                requestedDpi: 300,
            },
            // A source resolution measured from a raster carried its decimals,
            // and the quantum the canonical field states is what they land on.
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 7,
                appliedDpi: 288.5,
                requestedDpi: 296.999_999_999_999_94,
            },
            // The old field admitted any positive DPI. One below half a
            // quantum still names a real artifact, so it decodes to the
            // smallest DPI the canonical field can state rather than to zero,
            // which the bound would refuse.
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 9,
                appliedDpi: Number.MIN_VALUE,
                requestedDpi: 100_000,
            },
        ])).toEqual([
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 3,
                appliedDpiThousandths: 200_000,
                requestedDpiThousandths: 300_000,
            },
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 7,
                appliedDpiThousandths: 288_500,
                requestedDpiThousandths: 297_000,
            },
            {
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: 9,
                appliedDpiThousandths: 1,
                requestedDpiThousandths: 100_000_000,
            },
        ]);
        // A current producer's payload survives the same decode unchanged, so
        // reading an artifact is not a way to alter one.
        expect(decodeEvents([{
            code: 'matched-canvas-page-dpi-capped',
            pageNumber: 3,
            appliedDpiThousandths: 200_000,
            requestedDpiThousandths: 300_000,
        }])).toEqual([{
            code: 'matched-canvas-page-dpi-capped',
            pageNumber: 3,
            appliedDpiThousandths: 200_000,
            requestedDpiThousandths: 300_000,
        }]);

        // Both shapes are exact and complete, so nothing that names one field
        // from each — or one field from a pair — is decodable. A payload whose
        // unit the decoder would have to guess at is refused, not guessed at.
        const rejected: ReadonlyArray<{
            label: string;
            warningEvents: unknown;
        }> = [
            {
                label: 'a payload naming the old applied DPI beside the new requested one',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpi: 200,
                    requestedDpiThousandths: 300_000,
                }],
            },
            {
                label: 'a payload naming the new applied DPI beside the old requested one',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpiThousandths: 200_000,
                    requestedDpi: 300,
                }],
            },
            {
                label: 'a payload restating both measurements in both shapes',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpi: 200,
                    requestedDpi: 300,
                    appliedDpiThousandths: 200_000,
                    requestedDpiThousandths: 300_000,
                }],
            },
            {
                label: 'an old-shape payload missing half of its pair',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpi: 200,
                }],
            },
            {
                label: 'an old-shape payload whose applied DPI is not positive',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpi: 0,
                    requestedDpi: 300,
                }],
            },
            {
                label: 'an old-shape payload past the DPI bound',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: 3,
                    appliedDpi: 200,
                    requestedDpi: 100_001,
                }],
            },
            {
                label: 'an old-shape payload past the page limit',
                warningEvents: [{
                    code: 'matched-canvas-page-dpi-capped',
                    pageNumber: Number.MAX_SAFE_INTEGER + 1,
                    appliedDpi: 200,
                    requestedDpi: 300,
                }],
            },
            // The render limit was born stating fixed-point thousandths, so
            // there is no old shape of it to accept: compatibility is one
            // condition's history, not a shape any code may take.
            {
                label: 'a render limit borrowing the capped page\'s old shape',
                warningEvents: [{
                    code: 'render-dpi-limited',
                    appliedDpi: 288.5,
                    requestedDpi: 400,
                }],
            },
        ];

        expect(new Set(rejected.map(({label}) => label)).size).toBe(rejected.length);
        for (const {
            label,
            warningEvents,
        } of rejected) {
            expect(() => decodeNativeScanCleanupOutputMetadata({
                ...outputMetadata(),
                warningEvents,
            }), label).toThrow(InvalidScanCleanupNativeArtifactError);
        }
    });

    it('normalizes a superseded warning shape without touching the artifact it read', () => {
        // Decoding reads an artifact; it is never a way to rewrite one. The
        // payload the caller still holds keeps the shape it arrived in, and a
        // frozen one decodes like any other instead of faulting on a write
        // the caller never asked for.
        const legacyEvent = {
            code: 'matched-canvas-page-dpi-capped',
            pageNumber: 3,
            appliedDpi: 200,
            requestedDpi: 300,
        };
        const canonicalEvent = {
            code: 'matched-canvas-page-dpi-capped',
            pageNumber: 3,
            appliedDpiThousandths: 200_000,
            requestedDpiThousandths: 300_000,
        };
        const legacy = {
            ...outputMetadata(),
            warningEvents: [legacyEvent],
        };
        const asWritten = structuredClone(legacy);
        const normalized = decodeNativeScanCleanupOutputMetadata(legacy);

        expect(normalized.warningEvents).toEqual([canonicalEvent]);
        expect(normalized).not.toBe(legacy);
        expect(legacy).toEqual(asWritten);
        expect(legacy.warningEvents[0]).toBe(legacyEvent);

        const frozenLegacy = Object.freeze({
            ...outputMetadata(),
            warningEvents: Object.freeze([Object.freeze({...legacyEvent})]),
        });
        const frozenCurrent = Object.freeze({
            ...outputMetadata(),
            warningEvents: Object.freeze([Object.freeze({...canonicalEvent})]),
        });

        expect(decodeNativeScanCleanupOutputMetadata(frozenLegacy).warningEvents)
            .toEqual([canonicalEvent]);
        // A payload already stating the current shape is handed back as it
        // came, so reading a large artifact stays a copy nobody pays for.
        expect(decodeNativeScanCleanupOutputMetadata(frozenCurrent)).toBe(frozenCurrent);
    });

    it('rejects malformed nested output geometry before a consumer can use it', () => {
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            forwardTransform: {matrix: [[
                1,
                0,
                0,
            ]]},
        })).toThrow('must be 3x3');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            dewarpMapping: {
                columns: 2,
                rows: 2,
                outputOrigin: {
                    x: 0,
                    y: 0,
                },
                outputWidth: 100,
                outputHeight: 200,
                outputToSource: [],
                sourceToOutput: [],
            },
        })).toThrow('length does not match its grid');
    });

    it('validates persisted spread binarization decisions', () => {
        const output = {
            ...outputMetadata(),
            binarizationMode: 'otsu',
            binarizationDiagnostics: {
                route: 'otsu',
                robustContrast: 80,
                illuminationDeviation: 4,
                edgeDensity: 0.12,
                estimatedStrokeWidthPx: 3,
                darkBorderCoverage: 0,
                otsuAdaptiveAgreement: 0.98,
                spreadPlan: {
                    route: 'otsu',
                    thresholdAnchor: 127,
                    thresholdRadius: 27,
                    strokeWidthAnchorPx: 2.5,
                    xHeightAnchorPx: 18,
                    documentAnchor: true,
                    jointCandidateRoute: 'otsu',
                    leftCandidateRoute: 'wolf',
                    rightCandidateRoute: 'otsu',
                    decision: 'perLeafRouteMismatch',
                },
            },
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            binarizationDiagnostics: {
                ...output.binarizationDiagnostics,
                spreadPlan: {
                    ...output.binarizationDiagnostics.spreadPlan,
                    thresholdAnchor: 256,
                },
            },
        })).toThrow('thresholdAnchor must be <= 255');
    });

    it('accepts a recorded left white-tail overhang when the optical box stays bounded', () => {
        const output = {
            ...outputMetadata(),
            matchedCanvasContentWidthPx: 1000,
            matchedCanvasContentHeightPx: 500,
            intrinsicRasterWidthPx: 1000,
            intrinsicRasterHeightPx: 500,
            canvasWidthPx: 1000,
            canvasHeightPx: 500,
            matchedCanvasOpticalPlacement: true,
            matchedCanvasOpticalContentLeftPx: 300,
            matchedCanvasOpticalContentRightPx: 950,
            matchedCanvasIntrinsicOverflowLeftPx: 125,
            softMarginsPx: [
                0,
                0,
                0,
                0,
            ],
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            matchedCanvasIntrinsicOverflowLeftPx: 1001,
        })).toThrow('intrinsic content placement exceeds its canvas');
    });

    it('rejects inconsistent or fully off-canvas intrinsic overflow intervals', () => {
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasContentWidthPx: 200,
            canvasWidthPx: 100,
            matchedCanvasIntrinsicOverflowLeftPx: 200,
            placementOffsetXPx: 0,
        })).toThrow('intrinsic content placement exceeds its canvas');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowLeftPx: 10,
            placementOffsetXPx: 5,
        })).toThrow('intrinsic content placement exceeds its canvas');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowTopPx: 201,
            placementOffsetYPx: 0,
        })).toThrow('intrinsic content placement exceeds its canvas');
    });

    it('accepts a bounded top headroom trim that still intersects the canvas', () => {
        const output = {
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowTopPx: 80,
            placementOffsetYPx: 0,
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
    });

    it('rejects fold clipping that removes the complete placed source interval', () => {
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            foldClipLeftPx: 40,
            foldClipRightPx: 60,
        })).toThrow('intrinsic content placement exceeds its canvas');
    });

    it('accepts omitted and numeric fold clips but rejects explicit null values', () => {
        const omitted = outputMetadata();
        delete (omitted as Partial<typeof omitted>).foldClipLeftPx;
        delete (omitted as Partial<typeof omitted>).foldClipRightPx;

        const decodedOmitted = decodeNativeScanCleanupOutputMetadata(omitted);
        expect(decodedOmitted.foldClipLeftPx).toBeUndefined();
        expect(decodedOmitted.foldClipRightPx).toBeUndefined();
        expect(decodedOmitted.cropRect).toEqual(outputMetadata().cropRect);
        expect(decodeNativeScanCleanupOutputMetadata(outputMetadata())).toMatchObject({
            foldClipLeftPx: 2,
            foldClipRightPx: 3,
        });
        for (const key of [
            'foldClipLeftPx',
            'foldClipRightPx',
        ] as const) {
            expect(() => decodeNativeScanCleanupOutputMetadata({
                ...outputMetadata(),
                [key]: null,
            })).toThrow(`${key} must be a safe integer >= 0`);
        }
    });

    it('enforces preview-only required metadata at the native preview boundary', () => {
        const page = pageMetadata();
        delete (page.outputs[0] as Partial<typeof page.outputs[number]>).appliedMargins;
        expect(() => decodeNativeScanCleanupPreviewPageMetadataJson(JSON.stringify(page)))
            .toThrow('appliedMargins is required for preview');

        const output = outputMetadata();
        delete (output as Partial<typeof output>).sourceRegion;
        expect(() => decodeNativeScanCleanupPreviewOutputMetadataJson(JSON.stringify(output)))
            .toThrow('sourceRegion is required for preview');
    });
});
