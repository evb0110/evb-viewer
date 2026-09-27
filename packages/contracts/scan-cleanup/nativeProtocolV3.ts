import {NATIVE_ERROR_CODES} from '@contracts/nativeErrors';
import type {
    AnalysisOutputMetadata,
    BinarizationDiagnostics,
    CleanupOptions,
    CleanupMetadata,
    DetailRenderPlan,
    DewarpOptions,
    ExperimentalOptions,
    FoldBandUnmeasuredReason,
    InkConsistencyDiagnostics,
    LosslessPlacement,
    ManifestV3,
    OutputModeDiagnostics,
    Page,
    PageOutput,
    PageResultMetadata,
    PdfImagePlacement,
    PdfPageGeometry,
    PlacementAnchor,
    SplitDiagnostics,
    SpreadBinarizationPlanDecision,
    TextToneDiagnostics,
    TextToneRule,
} from '@contracts/scan-cleanup/nativeWire.generated';
import * as v from 'valibot';
import {isRecord} from '@contracts/runtimeGuards';
import {
    SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA,
    SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS,
    SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS,
    SCAN_CLEANUP_OUTPUT_MODES,
} from '@contracts/scan-cleanup/domain';
import {requirePageNumber} from '@contracts/pageNumbers';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';

export const SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION = 3 as const;

export type TNativeScanCleanupOperation = 'analyze' | 'render';
export type TNativeScanCleanupRenderMode = 'preview' | 'final';
export type TNativeScanCleanupAnalysisPurpose = 'classification' | 'page-plan';

export type IScanCleanupPlacementAnchor = PlacementAnchor;

export type INativeScanCleanupExperimentalOptionsV3 = ExperimentalOptions;
export type INativeScanCleanupOptionsV3 = CleanupOptions;
export type INativeScanCleanupOutputV3 = PageOutput;
export type INativeScanCleanupPdfPageV3 = PdfPageGeometry;
export type INativeScanCleanupDetailRenderPlanV3 = DetailRenderPlan;
export type INativeScanCleanupPageV3 = Page;
export type INativeScanCleanupManifestV3 = ManifestV3;

export type INativeScanCleanupPdfImagePlacementV3 = PdfImagePlacement;
export type INativeScanCleanupPdfPlacementV3 = LosslessPlacement;
export type INativeScanCleanupDewarpModelV3 = DewarpOptions;
export type INativeScanCleanupOutputMetadataV3 = CleanupMetadata;
export type INativeScanCleanupInkConsistencyDiagnosticsV3 = InkConsistencyDiagnostics;
export type INativeScanCleanupTextToneDiagnosticsV3 = TextToneDiagnostics;
export type INativeScanCleanupAnalysisOutputV3 = AnalysisOutputMetadata;
export type INativeScanCleanupOutputModeDiagnosticsV3 = OutputModeDiagnostics;
export type TNativeScanCleanupTextToneRuleV3 = TextToneRule;
export type TNativeScanCleanupSpreadBinarizationPlanDecisionV3 = SpreadBinarizationPlanDecision;
/** Native-only inverse geometry persisted beside a preview output for detail reuse. */
export type INativeScanCleanupReusableGeometryV3 = Pick<CleanupMetadata, 'inverseTransform' | 'dewarpMapping'>;

export const NATIVE_SCAN_CLEANUP_FOLD_BAND_UNMEASURED_REASONS_V3 = [
    'not-applicable',
    'no-fold-evidence',
    'fold-evidence-unquantified',
    'cutter-invalidated',
    'measurement-unavailable',
] as const satisfies readonly FoldBandUnmeasuredReason[];

const foldBandNumber = v.pipe(v.number(), v.finite(), v.minValue(0));
export const NATIVE_SCAN_CLEANUP_FOLD_BAND_SCHEMA = v.variant('status', [
    v.pipe(v.strictObject({
        status: v.literal('measured'),
        leftXPx: foldBandNumber,
        rightXPx: foldBandNumber,
    }), v.check(value => value.rightXPx >= value.leftXPx)),
    v.strictObject({
        status: v.literal('unmeasured'),
        reason: v.picklist(NATIVE_SCAN_CLEANUP_FOLD_BAND_UNMEASURED_REASONS_V3),
        nominalHalfWidthPx: foldBandNumber,
    }),
]);

export type TNativeScanCleanupFoldBandV3 = v.InferOutput<typeof NATIVE_SCAN_CLEANUP_FOLD_BAND_SCHEMA>;

export function isNativeScanCleanupFoldBandV3(value: unknown): value is TNativeScanCleanupFoldBandV3 {
    return v.safeParse(NATIVE_SCAN_CLEANUP_FOLD_BAND_SCHEMA, value, {abortEarly: true}).success;
}

export type INativeScanCleanupSplitDiagnosticsV3 = SplitDiagnostics;
export type INativeScanCleanupPageMetadataV3 = PageResultMetadata;
export type INativeScanCleanupBinarizationDiagnosticsV3 = BinarizationDiagnostics;

const finiteNumber = v.pipe(v.number(), v.finite());
const nonNegativeInteger = (message: string) => v.message(v.pipe(
    finiteNumber,
    v.integer(),
    v.minValue(0),
), message);
const confidence = (message: string) => v.message(v.pipe(
    finiteNumber,
    v.minValue(0),
    v.maxValue(1),
), message);
export const NATIVE_SCAN_CLEANUP_SPLIT_DIAGNOSTICS_SCHEMA = v.strictObject({
    foldBand: NATIVE_SCAN_CLEANUP_FOLD_BAND_SCHEMA,
    analysisDpi: finiteNumber,
    deskewAngleDegrees: finiteNumber,
    deskewConfidence: finiteNumber,
    cutterSlope: finiteNumber,
    leftDeskewAngleDegrees: finiteNumber,
    rightDeskewAngleDegrees: finiteNumber,
    leftDeskewConfidence: finiteNumber,
    rightDeskewConfidence: finiteNumber,
    whitespaceX: finiteNumber,
    foldX: finiteNumber,
    decisionX: finiteNumber,
    whitespaceScore: finiteNumber,
    bilateralScore: finiteNumber,
    leftPageScore: finiteNumber,
    rightPageScore: finiteNumber,
    leftContentScore: finiteNumber,
    rightContentScore: finiteNumber,
    leftSurfaceScore: finiteNumber,
    rightSurfaceScore: finiteNumber,
    leftInkPixels: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    rightInkPixels: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    leftOuterMarginScore: finiteNumber,
    rightOuterMarginScore: finiteNumber,
    outerMarginScore: finiteNumber,
    gutterScore: finiteNumber,
    agreementScore: finiteNumber,
    foldScore: finiteNumber,
    gutterDarknessScore: finiteNumber,
    softGutterScore: finiteNumber,
    softGutterCoverage: finiteNumber,
    softGutterContinuity: finiteNumber,
    softGutterMeanDepression: finiteNumber,
    sparseGutterScore: finiteNumber,
    sparseGutterCoverage: v.message(finiteNumber, 'must be finite'),
    sparseGutterContinuity: finiteNumber,
    sparseGutterMeanDepression: finiteNumber,
    aspectRatio: finiteNumber,
    aspectSpreadScore: finiteNumber,
    aspectSingleScore: finiteNumber,
    independentSpreadCues: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    offcutBoundaryScore: finiteNumber,
    offcutEmptyScore: finiteNumber,
    offcutPopulatedScore: finiteNumber,
    offcutWidthScore: finiteNumber,
    offcutNoTextRowsScore: finiteNumber,
    alternativeProduct: finiteNumber,
    evidenceProduct: finiteNumber,
    whitespaceGatePassed: v.boolean(),
    centralPositionGatePassed: v.boolean(),
    bilateralGatePassed: v.boolean(),
    outerMarginGatePassed: v.boolean(),
    gutterGatePassed: v.boolean(),
    independentGutterGatePassed: v.boolean(),
    aspectSupportGatePassed: v.boolean(),
    evidenceAgreementGatePassed: v.boolean(),
    outerMarginRecovery: v.boolean(),
    outerMarginWeakEdge: v.nullable(v.picklist([
        'left',
        'right',
    ])),
    sparseSpreadRecovered: v.boolean(),
    abstained: v.boolean(),
});
const pageNumber = v.pipe(
    finiteNumber,
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER),
    v.transform(value => requirePageNumber(value)),
);
const classification = v.message(
    v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS),
    'Invalid evb-scan-cleanup progress classification',
);
const documentPrior = SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA;
const textAxis = v.message(v.strictObject({
    sideways: v.boolean(),
    confidence: confidence('Invalid evb-scan-cleanup text axis'),
}), 'Invalid evb-scan-cleanup text axis');
const stageTime = v.pipe(finiteNumber, v.minValue(0));
const pageStageTimings = v.message(v.strictObject({
    decodeMs: v.optional(stageTime),
    analysisLevelMs: v.optional(stageTime),
    normalizationMs: v.optional(stageTime),
    illuminationPreparationMs: v.optional(stageTime),
    layoutNormalizationMs: v.optional(stageTime),
    calibrationMs: v.optional(stageTime),
    pictureMaskMs: v.optional(stageTime),
    modeRecommendationMs: v.optional(stageTime),
    qualityNormalizationMs: v.optional(stageTime),
    textAxisMs: v.optional(stageTime),
    splitMs: v.optional(stageTime),
    deskewMs: v.optional(stageTime),
    contentMs: v.optional(stageTime),
    rasterizationMs: v.optional(stageTime),
    maskRasterizationMs: v.optional(stageTime),
    binarizationMs: v.optional(stageTime),
    thresholdPreparationMs: v.optional(stageTime),
    thresholdingMs: v.optional(stageTime),
    binaryPostprocessMs: v.optional(stageTime),
    mixedCompositionMs: v.optional(stageTime),
    outputProcessingMs: v.optional(stageTime),
    renderMs: v.optional(stageTime),
    writeMs: v.optional(stageTime),
}), 'Invalid evb-scan-cleanup stage timings');
const outputModeDiagnosticNumber = finiteNumber;
const outputModeDiagnostics = v.message(v.strictObject({
    rule: v.picklist([
        'blank',
        'color-text-with-pictures',
        'color',
        'text-with-pictures',
        'picture',
        'sparse-text',
        'continuous-tone',
        'confident-text',
        'dense-text',
        'strong-single-line-text',
        'spatial-tone',
        'bilevel-fidelity',
        'mixed-ownership-veto',
        'uncertain-fallback',
    ] as const),
    fallbackUsed: v.boolean(),
    analysisWidth: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    analysisHeight: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    otsuThreshold: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    darkMean: outputModeDiagnosticNumber,
    lightMean: outputModeDiagnosticNumber,
    midtoneLower: outputModeDiagnosticNumber,
    midtoneUpper: outputModeDiagnosticNumber,
    p01: outputModeDiagnosticNumber,
    p50: outputModeDiagnosticNumber,
    p99: outputModeDiagnosticNumber,
    bimodality: outputModeDiagnosticNumber,
    midtoneFraction: outputModeDiagnosticNumber,
    relativeMidtoneFraction: outputModeDiagnosticNumber,
    modeDistance: outputModeDiagnosticNumber,
    inkFraction: outputModeDiagnosticNumber,
    edgeFraction: outputModeDiagnosticNumber,
    robustLuminanceRange: outputModeDiagnosticNumber,
    coloredFraction: outputModeDiagnosticNumber,
    largestColorComponentPixels: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    meanSaturation: outputModeDiagnosticNumber,
    pictureFraction: outputModeDiagnosticNumber,
    textLineCount: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    significantColor: v.boolean(),
    significantPicture: v.boolean(),
    pictureGateMargin: outputModeDiagnosticNumber,
    tonalMidtoneGateMargin: outputModeDiagnosticNumber,
    strongBimodalityGateMargin: outputModeDiagnosticNumber,
    confidentTextBimodalityMargin: outputModeDiagnosticNumber,
    confidentTextModeDistanceMargin: outputModeDiagnosticNumber,
    confidentTextMidtoneMargin: outputModeDiagnosticNumber,
    denseTextLineMargin: outputModeDiagnosticNumber,
    denseTextBimodalityMargin: outputModeDiagnosticNumber,
    denseTextModeDistanceMargin: outputModeDiagnosticNumber,
    denseTextMidtoneMargin: outputModeDiagnosticNumber,
    outsideTonalFraction: outputModeDiagnosticNumber,
    outsideTonalLargestComponentFraction: outputModeDiagnosticNumber,
    outsideTonalLargestComponentWidthFraction: outputModeDiagnosticNumber,
    outsideTonalLargestComponentHeightFraction: outputModeDiagnosticNumber,
    coherentOutsideTonalRegion: v.boolean(),
    destructiveModeTonalVeto: v.boolean(),
    protectedTextBlockCount: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    protectedTextBlockPictureOverlapPixels: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    protectedTextBlockPictureOverlapFraction: outputModeDiagnosticNumber,
    mixedOwnershipIndependentPictureEvidence: v.boolean(),
    mixedOwnershipVeto: v.boolean(),
    sourceDpi: v.pipe(finiteNumber, v.minValue(0)),
    analysisDpi: v.pipe(finiteNumber, v.minValue(0)),
    calibratedSourceStrokeWidthPx: v.pipe(finiteNumber, v.minValue(0)),
    calibratedSourceXHeightPx: v.pipe(finiteNumber, v.minValue(0)),
    softEdgeToInkRatio: v.pipe(finiteNumber, v.minValue(0)),
    bilevelFidelityVeto: v.boolean(),
}), 'Invalid evb-scan-cleanup output mode diagnostics');
export const NATIVE_SCAN_CLEANUP_OUTPUT_MODE_DIAGNOSTICS_SCHEMA = outputModeDiagnostics;
/**
 * `page-analyzed` is published as each page finishes; its completedPages value
 * is a monotone count of distinct analyzed pages and pageNumber may move in
 * either direction. `page-complete` keeps source-order completion semantics.
 */
const progress = v.pipe(v.object({
    stage: v.picklist([
        'started',
        'page-analyzed',
        // Staged-input lease frames, carrying page identity only: the producer
        // answers `page-input-required` by publishing that page's raster and
        // may drop it after `page-input-released`.
        'page-input-required',
        'page-input-released',
        'page-complete',
        'completed',
    ] as const),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    pageNumber: v.optional(v.message(pageNumber, 'Invalid evb-scan-cleanup progress page number')),
    outputPaths: v.optional(v.array(v.string())),
    classification: v.optional(classification),
    confidence: v.optional(confidence('Invalid evb-scan-cleanup progress confidence')),
    cutterXPx: v.optional(v.message(v.pipe(finiteNumber, v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
        'Invalid evb-scan-cleanup progress cutter')),
    tier1Verdict: v.optional(classification),
    reconciled: v.optional(v.boolean()),
    clusterAgreement: v.optional(v.pipe(finiteNumber, v.minValue(-1), v.maxValue(1))),
    documentPrior: v.optional(documentPrior),
    textAxis: v.optional(textAxis),
    stageTimings: v.optional(pageStageTimings),
    recommendedOutputMode: v.optional(v.message(v.picklist(SCAN_CLEANUP_OUTPUT_MODES),
        'Invalid evb-scan-cleanup recommended output mode')),
    recommendedOutputModeConfidence: v.optional(confidence('Invalid evb-scan-cleanup output mode confidence')),
    recommendedOutputModeReason: v.optional(v.message(v.picklist(SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS),
        'Invalid evb-scan-cleanup recommendation reason')),
    softAlphaForegroundRecommendation: v.optional(v.boolean()),
    outputModeDiagnostics: v.optional(outputModeDiagnostics),
}), v.check(value => value.completedPages <= value.totalPages,
    'Invalid evb-scan-cleanup progress page counts'), v.check(value =>
    value.pageNumber === undefined
        ? value.stage !== 'page-analyzed'
            && value.stage !== 'page-complete'
            && value.stage !== 'page-input-required'
            && value.stage !== 'page-input-released'
        : value.pageNumber <= value.totalPages,
'Invalid evb-scan-cleanup progress page number'));
const successResult = v.object({
    status: v.literal('success'),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
});
const failureResult = v.object({
    status: v.literal('failure'),
    code: v.picklist(NATIVE_ERROR_CODES),
    message: v.string(),
});
const progressEnvelope = v.object({
    version: v.literal(SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION),
    type: v.literal('progress'),
    progress,
});
const resultEnvelope = v.object({
    version: v.literal(SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION),
    type: v.literal('result'),
    result: v.message(v.union([
        successResult,
        failureResult,
    ]), 'Invalid evb-scan-cleanup result envelope'),
});

/**
 * Structured warning transport. A producer states the condition it detected and
 * the finite parameters that describe it; the shared formatter in
 * `packages/scan-cleanup/core/policy/scanCleanupWarningEvents` owns every user-visible
 * sentence. Aggregation therefore reads codes, never English, and a wording
 * change cannot turn one aggregate into per-page noise.
 */
export const SCAN_CLEANUP_WARNING_EVENT_CODES = [
    // Native render metadata producers.
    'matched-canvas-content-fitted',
    'matched-canvas-margins-reduced',
    'matched-canvas-margins-unavailable',
    'matched-canvas-paper-downscaled',
    'matched-canvas-optical-centering-fallback',
    'matched-canvas-intrinsic-overflow',
    'matched-canvas-spread-headroom-trimmed',
    'matched-canvas-fold-columns-discarded',
    'render-dpi-limited',
    // Lossless document assembly producers.
    'matched-canvas-content-fitted-pages',
    'matched-canvas-dropped',
    'matched-canvas-geometry-unmeasured',
    'matched-canvas-pages-resampled',
    'matched-canvas-pages-scaled-in-place',
    'matched-canvas-document-dpi-normalized',
    'matched-canvas-page-dpi-capped',
] as const;

export type TScanCleanupWarningEventCode = typeof SCAN_CLEANUP_WARNING_EVENT_CODES[number];

/** One output's placement cannot report more conditions than the matrix holds. */
export const MAX_SCAN_CLEANUP_WARNING_EVENTS = 32;
const MAX_SCAN_CLEANUP_WARNING_EVENT_DETAIL_LENGTH = 512;
/**
 * Every numeric parameter is bounded, not merely finite. Like the IPC input
 * limits these ceilings sit far above any document the pipeline can produce —
 * the raster guardrail stops at 40 000 px a side, and 1 000 000 pt is 13 888
 * inches of paper — while keeping a decoded event's arithmetic and rendered
 * width bounded no matter what wrote the artifact. They are stated here rather
 * than imported from the pipeline's own policy: a contract decides a payload
 * without depending on the runtime that produced it.
 */
const MAX_SCAN_CLEANUP_WARNING_EVENT_EXTENT = 1_000_000;
const MAX_SCAN_CLEANUP_WARNING_EVENT_DPI = 100_000;
const MAX_SCAN_CLEANUP_WARNING_EVENT_DPI_THOUSANDTHS = MAX_SCAN_CLEANUP_WARNING_EVENT_DPI * 1_000;
/**
 * The condition itself means the paper did not fit, so every real scale is
 * below 100%; the ceiling is 1000% so headroom, not the check, is what a
 * producer runs out of first.
 */
const MAX_SCAN_CLEANUP_WARNING_EVENT_SCALE_PERCENT_TENTHS = 10_000;

const warningEventMessage = 'Invalid evb-scan-cleanup warning event';
const warningEventCode = <const TCode extends TScanCleanupWarningEventCode>(code: TCode) =>
    v.message(v.literal(code), warningEventMessage);
/**
 * Physical extents travel in the unit their producer measures in: a raster
 * placement in canvas pixels, a lossless placement in PDF points. The unit also
 * decides how the formatter prints them, so pixel extents must be whole.
 */
const warningEventUnit = v.message(v.picklist([
    'px',
    'pt',
] as const), warningEventMessage);
const warningEventExtent = v.message(v.pipe(
    finiteNumber,
    v.minValue(0),
    v.maxValue(MAX_SCAN_CLEANUP_WARNING_EVENT_EXTENT),
), warningEventMessage);
const warningEventCount = v.message(v.pipe(
    finiteNumber,
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_SCAN_CLEANUP_WARNING_EVENT_EXTENT),
), warningEventMessage);
const warningEventDpi = v.message(v.pipe(
    finiteNumber,
    v.minValue(Number.MIN_VALUE),
    v.maxValue(MAX_SCAN_CLEANUP_WARNING_EVENT_DPI),
), warningEventMessage);
/**
 * A DPI the formatter prints with three decimals, and a percentage it prints
 * with one, travel as the fixed-point integer their producer quantized to.
 * Rust and JavaScript disagree on which way an exact half rounds, so the digits
 * are decided once — by the code that measured the value — and the formatter
 * only places the decimal point.
 */
const warningEventDpiThousandths = v.message(v.pipe(
    finiteNumber,
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_SCAN_CLEANUP_WARNING_EVENT_DPI_THOUSANDTHS),
), warningEventMessage);
const warningEventScalePercentTenths = v.message(v.pipe(
    finiteNumber,
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_SCAN_CLEANUP_WARNING_EVENT_SCALE_PERCENT_TENTHS),
), warningEventMessage);
const warningEventPageNumber = v.message(pageNumber, warningEventMessage);
/**
 * A page list is a set the producer already deduplicated, kept in the order it
 * discovered the pages in — source order carries meaning, so the contract
 * checks for repeats rather than normalizing them away.
 */
const warningEventPages = v.message(v.pipe(
    v.array(warningEventPageNumber),
    v.check(value => value.length > 0
        && value.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
        && new Set(value).size === value.length),
), warningEventMessage);
const warningEventDetail = v.message(v.pipe(
    v.string(),
    v.maxLength(MAX_SCAN_CLEANUP_WARNING_EVENT_DETAIL_LENGTH),
), warningEventMessage);
const pixelExtentsAreWhole = (
    unit: 'px' | 'pt',
    extents: ReadonlyArray<number | undefined>,
) => unit !== 'px'
    || extents.every(extent => extent === undefined || Number.isSafeInteger(extent));
/**
 * An optional rectangle is one measurement, not two. A producer that measured
 * it reports both sides; one side alone is a payload the formatter would have
 * to guess at, so the contract refuses it.
 */
const rectangleIsWholeOrAbsent = (width?: number, height?: number) =>
    (width === undefined) === (height === undefined);

const contentFitted = v.message(v.pipe(v.strictObject({
    code: warningEventCode('matched-canvas-content-fitted'),
    unit: warningEventUnit,
    contentWidth: warningEventExtent,
    contentHeight: warningEventExtent,
    innerWidth: warningEventExtent,
    innerHeight: warningEventExtent,
    /** Present only where the producer reports the whole document rectangle. */
    documentCanvasWidth: v.optional(warningEventExtent),
    documentCanvasHeight: v.optional(warningEventExtent),
}), v.check(value => pixelExtentsAreWhole(value.unit, [
    value.contentWidth,
    value.contentHeight,
    value.innerWidth,
    value.innerHeight,
    value.documentCanvasWidth,
    value.documentCanvasHeight,
]) && rectangleIsWholeOrAbsent(
    value.documentCanvasWidth,
    value.documentCanvasHeight,
))), warningEventMessage);
const paperDownscaled = v.message(v.pipe(v.strictObject({
    code: warningEventCode('matched-canvas-paper-downscaled'),
    unit: warningEventUnit,
    scalePercentTenths: warningEventScalePercentTenths,
    documentCanvasWidth: warningEventExtent,
    documentCanvasHeight: warningEventExtent,
    /** Present only where the producer measured the paper it could not hold. */
    paperWidth: v.optional(warningEventExtent),
    paperHeight: v.optional(warningEventExtent),
}), v.check(value => pixelExtentsAreWhole(value.unit, [
    value.documentCanvasWidth,
    value.documentCanvasHeight,
    value.paperWidth,
    value.paperHeight,
]) && rectangleIsWholeOrAbsent(value.paperWidth, value.paperHeight))), warningEventMessage);
/**
 * A page's capped render DPI, and the superseded shape of the same condition:
 * artifacts written before both measurements travelled as fixed-point
 * thousandths state them as plain DPI. One condition carries one decoded
 * shape, so the old fields are converted and re-decoded against the canonical
 * bounds instead of widening the union with a variant every consumer would
 * branch on; both shapes being exact, a payload mixing them matches neither.
 * The old field also admitted a DPI below half a thousandth: that lands on the
 * smallest one the canonical field states rather than quantizing to zero and
 * costing a readable artifact its decode.
 */
const canonicalPageDpiCapped = v.message(v.strictObject({
    code: warningEventCode('matched-canvas-page-dpi-capped'),
    pageNumber: warningEventPageNumber,
    appliedDpiThousandths: warningEventDpiThousandths,
    requestedDpiThousandths: warningEventDpiThousandths,
}), warningEventMessage);
const legacyPageDpiCapped = v.message(v.strictObject({
    code: warningEventCode('matched-canvas-page-dpi-capped'),
    pageNumber: warningEventPageNumber,
    appliedDpi: warningEventDpi,
    requestedDpi: warningEventDpi,
}), warningEventMessage);
const legacyDpiThousandths = (dpi: number) => Math.max(1, Math.round(dpi * 1_000));
// Legacy DPI names normalize into the canonical fixed-point warning shape.
const pageDpiCapped = v.pipe(v.union([
    canonicalPageDpiCapped,
    legacyPageDpiCapped,
]), v.transform(value => 'appliedDpi' in value ? {
    code: value.code,
    pageNumber: value.pageNumber,
    appliedDpiThousandths: legacyDpiThousandths(value.appliedDpi),
    requestedDpiThousandths: legacyDpiThousandths(value.requestedDpi),
} : value));
export const SCAN_CLEANUP_WARNING_EVENT_SCHEMA = v.message(v.union([
    contentFitted,
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-content-fitted-pages'),
        pages: warningEventPages,
    }), warningEventMessage),
    v.message(v.strictObject({code: warningEventCode('matched-canvas-margins-reduced')}), warningEventMessage),
    v.message(v.strictObject({code: warningEventCode('matched-canvas-margins-unavailable')}), warningEventMessage),
    paperDownscaled,
    v.message(v.strictObject({code: warningEventCode('matched-canvas-optical-centering-fallback')}), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-intrinsic-overflow'),
        leftPx: warningEventCount,
        rightPx: warningEventCount,
    }), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-spread-headroom-trimmed'),
        topPx: warningEventCount,
    }), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-fold-columns-discarded'),
        leftColumns: warningEventCount,
        rightColumns: warningEventCount,
    }), warningEventMessage),
    v.message(v.strictObject({code: warningEventCode('matched-canvas-dropped')}), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-geometry-unmeasured'),
        detail: warningEventDetail,
    }), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-pages-resampled'),
        pages: warningEventPages,
    }), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-pages-scaled-in-place'),
        pages: warningEventPages,
    }), warningEventMessage),
    v.message(v.strictObject({
        code: warningEventCode('matched-canvas-document-dpi-normalized'),
        canvasDpi: warningEventDpi,
        finestPageDpi: warningEventDpi,
    }), warningEventMessage),
    pageDpiCapped,
    v.message(v.strictObject({
        code: warningEventCode('render-dpi-limited'),
        appliedDpiThousandths: warningEventDpiThousandths,
        requestedDpiThousandths: warningEventDpiThousandths,
    }), warningEventMessage),
]), warningEventMessage);

export const SCAN_CLEANUP_WARNING_EVENTS_SCHEMA = v.message(v.pipe(
    v.array(SCAN_CLEANUP_WARNING_EVENT_SCHEMA),
    v.check(value => value.length <= MAX_SCAN_CLEANUP_WARNING_EVENTS),
), 'evb-scan-cleanup warning events exceed the protocol limit');

export type TScanCleanupWarningEvent = v.InferOutput<typeof SCAN_CLEANUP_WARNING_EVENT_SCHEMA>;

/**
 * The catalog and the decoded union are one list of codes stated twice: the
 * catalog is what aggregation and the formatter switch on, the union is what a
 * payload may carry. Either list gaining a code the other lacks collapses this
 * type to `never`, so the assignment stops compiling before the two can drift.
 */
type TSameCodes<TCatalog extends string, TCarried extends string> = [TCatalog] extends [TCarried]
    ? [TCarried] extends [TCatalog] ? true : never
    : never;
const _warningEventCodesMatchCatalog: TSameCodes<
    TScanCleanupWarningEventCode,
    TScanCleanupWarningEvent['code']
> = true;
// The stdout validators must accept exactly the shapes the sidecar declares.
type TSameShape<TLeft, TRight> = [TLeft] extends [TRight] ? [TRight] extends [TLeft] ? true : never : never;
const _outputModeDiagnosticsMatchNative: TSameShape<v.InferOutput<typeof outputModeDiagnostics>, OutputModeDiagnostics> = true;

export const NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA = v.pipe(
    v.unknown(),
    v.check(value => isRecord(value) && value.version === SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        'Unsupported evb-scan-cleanup NDJSON protocol version'),
    v.check(value => isRecord(value) && (value.type === 'progress' || value.type === 'result'),
        'Unknown evb-scan-cleanup NDJSON envelope type'),
    v.variant('type', [
        progressEnvelope,
        resultEnvelope,
    ]),
);

export type TNativeScanCleanupPageStageTimingsV3 = v.InferOutput<typeof pageStageTimings>;
export type TNativeScanCleanupProgressV3 = v.InferOutput<typeof progress>;
export type TNativeScanCleanupProgressStage = TNativeScanCleanupProgressV3['stage'];
export type TNativeScanCleanupProgressEnvelopeV3 = v.InferOutput<typeof progressEnvelope>;
export type TNativeScanCleanupResultV3 = v.InferOutput<typeof resultEnvelope>['result'];
export type TNativeScanCleanupResultEnvelopeV3 = v.InferOutput<typeof resultEnvelope>;
export type TNativeScanCleanupEnvelopeV3 = v.InferOutput<typeof NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA>;
