import {NATIVE_ERROR_CODES} from '@contracts/nativeErrors';
import type {TPageNumber} from '@contracts/pageNumbers';
import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';
import type {
    IScanCleanupDocumentPrior,
    IScanCleanupManualZones,
    TScanCleanupBinarizationMethod,
    TScanCleanupCanvasScope,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPixelPoint,
    IScanCleanupPixelPolygon,
    IScanCleanupPixelRect,
    IScanCleanupPreviewAffine,
    IScanCleanupSplitSeamPolyline,
} from '@contracts/scan-cleanup/geometry';
import {
    decodeScanCleanupPageNumber,
    SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES,
} from '@contracts/scan-cleanup/inputLimits';

export const SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION = 3 as const;

export type TNativeScanCleanupOperation = 'analyze' | 'render';
export type TNativeScanCleanupRenderMode = 'preview' | 'final';
export type TNativeScanCleanupAnalysisPurpose = 'classification' | 'page-plan';

/**
 * A resolved `ink` placement position for one output: how far down the inner
 * rect the requested margins leave the content's top edge sits, as a fraction
 * of that rect's height. `ink` only moves content vertically — horizontally it
 * is centred exactly like `top-center` — so the anchor carries one axis.
 */
export interface IScanCleanupPlacementAnchor {yNormalized: number}

export interface INativeScanCleanupExperimentalOptionsV3 {
    autoDewarp: boolean;
    autoDewarpDepth?: number;
}

export interface INativeScanCleanupOptionsV3 {
    dpi: number;
    sourceDpi: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi: number;
    /**
     * Optional preview-only tile in normalized final intrinsic-output space.
     * Absence preserves the protocol-v3 full-page render contract.
     */
    renderCrop?: IScanCleanupNormalizedRect;
    binarization: TScanCleanupBinarizationMethod;
    thickness: number;
    normalizeIllumination: boolean;
    despeckle: boolean;
    despeckleLevel?: TScanCleanupDespeckleLevel;
    outputMode: TScanCleanupOutputModeSetting;
    /** Locked Auto decision for Mixed-layer foreground encoding. */
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: Partial<
        Record<TScanCleanupOutputHalf, INativeScanCleanupTextToneDiagnosticsV3>
    >;
    ocrMode: boolean;
    layout: 'auto' | 'force-single' | 'page-with-offcut' | 'keep-left' | 'keep-right' | 'force-two-page';
    manualSplit: IScanCleanupNormalizedSplit | null;
    /**
     * Trusted automatic cutter from a base preview with the same settings.
     * Kept distinct from manualSplit so replay never becomes a user edit.
     */
    automaticSplit?: IScanCleanupNormalizedSplit;
    manualSkewDegrees?: number;
    manualContentBoxes: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    /**
     * Trusted automatic geometry from a base preview with the same settings.
     * Manual values above take precedence. Kept distinct so native metadata
     * never labels replayed automatic analysis as a user edit.
     */
    automaticSkewDegrees?: Partial<Record<TScanCleanupOutputHalf, number>>;
    automaticContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    /**
     * Where `ink` alignment puts this output's content inside the matched
     * canvas, as a fraction of the placement's free space. Resolved by the
     * renderer across the whole document so pages that agree share one
     * position; an output without an anchor falls back to top-center.
     */
    placementAnchors?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>;
    manualZones?: IScanCleanupManualZones;
    cropContent: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    placementOverrides: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    margins: IScanCleanupMarginsMm;
    experimental: INativeScanCleanupExperimentalOptionsV3;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    skipBlankPages: boolean;
    maxPixels: number;
    maxDimensionPx: number;
}

export interface INativeScanCleanupOutputV3 {
    outputPath: string;
    metadataPath: string;
    bilevelOutputPath?: string;
    backgroundOutputPath?: string;
    foregroundMaskOutputPath?: string;
    foregroundAlphaOutputPath?: string;
    pictureMaskOutputPath?: string;
    tonePreservationAlphaOutputPath?: string;
}

export interface INativeScanCleanupPdfImagePlacementV3 {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
}

export interface INativeScanCleanupDewarpModelV3 {
    topCurve: IScanCleanupPixelPoint[];
    bottomCurve: IScanCleanupPixelPoint[];
    depth: number;
}

export interface INativeScanCleanupOutputMetadataV3 {
    sourcePageIndex?: number;
    half?: TScanCleanupOutputHalf;
    sourceRegion?: IScanCleanupPixelRect;
    cropRect?: IScanCleanupPixelRect;
    inputWidthPx?: number;
    inputHeightPx?: number;
    outputWidthPx: number;
    outputHeightPx: number;
    intrinsicRasterWidthPx?: number;
    intrinsicRasterHeightPx?: number;
    canvasWidthPx: number;
    canvasHeightPx: number;
    layoutClassification: TScanCleanupLayoutClassification;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied: boolean;
    manualSkew?: boolean;
    bilevelWritten?: boolean;
    layeredWritten?: boolean;
    layeredForegroundKind?: 'stencil' | 'soft-alpha' | 'source-mrc';
    layeredBackgroundDpi?: number;
    layeredForegroundDpi?: number;
    trustedMrcBackgroundPreserved?: boolean;
    illuminationNormalized?: boolean;
    textToneDiagnostics?: INativeScanCleanupTextToneDiagnosticsV3;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: INativeScanCleanupBinarizationDiagnosticsV3 | null;
    outputMode?: TScanCleanupOutputMode;
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    dewarpModel?: INativeScanCleanupDewarpModelV3 | null;
    contentBox?: IScanCleanupPixelRect | null;
    /**
     * Unstructured native diagnostics. Every condition the pipeline aggregates
     * or displays as a decision travels in `warningEvents` instead; artifacts
     * written before that channel existed still carry those sentences here.
     */
    warnings?: string[];
    warningEvents?: TScanCleanupWarningEvent[];
    renderDpi?: number;
    matchedCanvasTargetWidthPoints?: number | null;
    matchedCanvasTargetHeightPoints?: number | null;
    matchedCanvasContentWidthPx?: number | null;
    matchedCanvasContentHeightPx?: number | null;
    /** True when the transformed optical content, rather than the retained raster rectangle, owns horizontal placement. */
    matchedCanvasOpticalPlacement?: boolean;
    matchedCanvasOpticalContentLeftPx?: number | null;
    matchedCanvasOpticalContentRightPx?: number | null;
    matchedCanvasIntrinsicOverflowLeftPx?: number;
    matchedCanvasIntrinsicOverflowRightPx?: number;
    matchedCanvasIntrinsicOverflowTopPx?: number;
    /** Canvas-grid columns excluded from the preview/final source window at the fold edge. */
    foldClipLeftPx?: number;
    foldClipRightPx?: number;
    /** Optional source-grid continuous-tone rectangle in PDF user-space points. */
    pdfImagePlacement?: INativeScanCleanupPdfImagePlacementV3;
    placementOffsetXPx: number;
    placementOffsetYPx: number;
    forwardTransform: IScanCleanupPreviewAffine | null;
    /** Inverse output-raster to source-raster mapping for affine preprocessing. */
    inverseTransform?: IScanCleanupPreviewAffine | null;
    dewarpMapping?: INativeScanCleanupReusableGeometryV3['dewarpMapping'];
    rotationDegrees: TScanCleanupPageRotation;
}

export type TNativeScanCleanupTextToneRuleV3 =
    | 'applied'
    | 'picture-evidence'
    | 'insufficient-text'
    | 'tonal-mass-outside-text'
    | 'already-dark';

export interface INativeScanCleanupTextToneDiagnosticsV3 {
    applied: boolean;
    rule: TNativeScanCleanupTextToneRuleV3;
    textLineCount: number;
    textInkPixels: number;
    pictureFraction: number;
    outsideMidtoneFraction: number;
    outsideMidtoneLargestComponentFraction: number;
    outsideMidtoneLargestComponentWidthFraction: number;
    outsideMidtoneLargestComponentHeightFraction: number;
    inkAnchor: number | null;
    blackPoint: number | null;
    slope: number | null;
}

export interface INativeScanCleanupAnalysisOutputV3 {
    half: TScanCleanupOutputHalf;
    contentBox?: IScanCleanupPixelRect | null;
    textToneDiagnostics?: INativeScanCleanupTextToneDiagnosticsV3;
    cropRect: IScanCleanupPixelRect;
    sourceRegion: IScanCleanupPixelRect;
    inputWidthPx: number;
    inputHeightPx: number;
}

export interface INativeScanCleanupOutputModeDiagnosticsV3 {
    rule:
        | 'blank'
        | 'color-text-with-pictures'
        | 'color'
        | 'text-with-pictures'
        | 'picture'
        | 'sparse-text'
        | 'continuous-tone'
        | 'confident-text'
        | 'dense-text'
        | 'strong-single-line-text'
        | 'spatial-tone'
        | 'bilevel-fidelity'
        | 'mixed-ownership-veto'
        | 'uncertain-fallback';
    fallbackUsed: boolean;
    analysisWidth: number;
    analysisHeight: number;
    otsuThreshold: number;
    darkMean: number;
    lightMean: number;
    midtoneLower: number;
    midtoneUpper: number;
    p01: number;
    p50: number;
    p99: number;
    bimodality: number;
    midtoneFraction: number;
    relativeMidtoneFraction: number;
    modeDistance: number;
    inkFraction: number;
    edgeFraction: number;
    robustLuminanceRange: number;
    coloredFraction: number;
    largestColorComponentPixels: number;
    meanSaturation: number;
    pictureFraction: number;
    textLineCount: number;
    significantColor: boolean;
    significantPicture: boolean;
    pictureGateMargin: number;
    tonalMidtoneGateMargin: number;
    strongBimodalityGateMargin: number;
    confidentTextBimodalityMargin: number;
    confidentTextModeDistanceMargin: number;
    confidentTextMidtoneMargin: number;
    denseTextLineMargin: number;
    denseTextBimodalityMargin: number;
    denseTextModeDistanceMargin: number;
    denseTextMidtoneMargin: number;
    outsideTonalFraction: number;
    outsideTonalLargestComponentFraction: number;
    outsideTonalLargestComponentWidthFraction: number;
    outsideTonalLargestComponentHeightFraction: number;
    coherentOutsideTonalRegion: boolean;
    destructiveModeTonalVeto: boolean;
    /** Analysis-resolution evidence that rejected a contradictory Auto Mixed recommendation. */
    protectedTextBlockCount?: number;
    protectedTextBlockPictureOverlapPixels?: number;
    protectedTextBlockPictureOverlapFraction?: number;
    mixedOwnershipIndependentPictureEvidence?: boolean;
    mixedOwnershipVeto?: boolean;
    sourceDpi: number;
    analysisDpi: number;
    calibratedSourceStrokeWidthPx: number;
    calibratedSourceXHeightPx: number;
    softEdgeToInkRatio: number;
    bilevelFidelityVeto: boolean;
}

/** Gate-level evidence behind the native spread/single decision. */
export type TNativeScanCleanupFoldBandUnmeasuredReasonV3 =
    | 'not-applicable'
    | 'no-fold-evidence'
    | 'fold-evidence-unquantified'
    | 'cutter-invalidated'
    | 'measurement-unavailable'
    | 'legacy-protocol-v3';

export type TNativeScanCleanupFoldBandV3 =
    | {
        status: 'measured';
        leftXPx: number;
        rightXPx: number;
    }
    | {
        status: 'unmeasured';
        reason: TNativeScanCleanupFoldBandUnmeasuredReasonV3;
        nominalHalfWidthPx: number;
    };

export const NATIVE_SCAN_CLEANUP_FOLD_BAND_UNMEASURED_REASONS_V3 = [
    'not-applicable',
    'no-fold-evidence',
    'fold-evidence-unquantified',
    'cutter-invalidated',
    'measurement-unavailable',
    'legacy-protocol-v3',
] as const satisfies readonly TNativeScanCleanupFoldBandUnmeasuredReasonV3[];

/** Compatibility state synthesized when early protocol-v3 data has no typed fold outcome. */
export function legacyNativeScanCleanupFoldBandV3(): TNativeScanCleanupFoldBandV3 {
    return {
        status: 'unmeasured',
        reason: 'legacy-protocol-v3',
        nominalHalfWidthPx: 0,
    };
}

export function isNativeScanCleanupFoldBandV3(value: unknown): value is TNativeScanCleanupFoldBandV3 {
    if (!isRecord(value)) {
        return false;
    }
    const candidate = value;
    if (candidate.status === 'measured') {
        return Object.keys(candidate).every(key => (
            key === 'status' || key === 'leftXPx' || key === 'rightXPx'
        ))
            && typeof candidate.leftXPx === 'number'
            && Number.isFinite(candidate.leftXPx)
            && candidate.leftXPx >= 0
            && typeof candidate.rightXPx === 'number'
            && Number.isFinite(candidate.rightXPx)
            && candidate.rightXPx >= candidate.leftXPx;
    }
    return candidate.status === 'unmeasured'
        && Object.keys(candidate).every(key => (
            key === 'status' || key === 'reason' || key === 'nominalHalfWidthPx'
        ))
        && NATIVE_SCAN_CLEANUP_FOLD_BAND_UNMEASURED_REASONS_V3.some(
            reason => reason === candidate.reason,
        )
        && typeof candidate.nominalHalfWidthPx === 'number'
        && Number.isFinite(candidate.nominalHalfWidthPx)
        && candidate.nominalHalfWidthPx >= 0;
}

export interface INativeScanCleanupSplitDiagnosticsV3 {
    analysisDpi: number;
    deskewAngleDegrees: number;
    deskewConfidence: number;
    cutterSlope: number;
    leftDeskewAngleDegrees: number;
    rightDeskewAngleDegrees: number;
    leftDeskewConfidence: number;
    rightDeskewConfidence: number;
    whitespaceX: number;
    foldX: number;
    decisionX: number;
    whitespaceScore: number;
    bilateralScore: number;
    leftPageScore: number;
    rightPageScore: number;
    leftContentScore: number;
    rightContentScore: number;
    leftSurfaceScore: number;
    rightSurfaceScore: number;
    leftInkPixels: number;
    rightInkPixels: number;
    outerMarginScore: number;
    /** Optional because persisted protocol-v3 states may predate bilateral margin diagnostics. */
    leftOuterMarginScore?: number;
    /** Optional because persisted protocol-v3 states may predate bilateral margin diagnostics. */
    rightOuterMarginScore?: number;
    gutterScore: number;
    agreementScore: number;
    foldScore: number;
    gutterDarknessScore: number;
    softGutterScore: number;
    softGutterCoverage: number;
    softGutterContinuity: number;
    softGutterMeanDepression: number;
    sparseGutterScore: number;
    sparseGutterCoverage: number;
    sparseGutterContinuity: number;
    sparseGutterMeanDepression: number;
    aspectRatio: number;
    aspectSpreadScore: number;
    aspectSingleScore: number;
    independentSpreadCues: number;
    offcutBoundaryScore: number;
    offcutEmptyScore: number;
    offcutPopulatedScore: number;
    offcutWidthScore: number;
    offcutNoTextRowsScore: number;
    alternativeProduct: number;
    evidenceProduct: number;
    whitespaceGatePassed: boolean;
    centralPositionGatePassed: boolean;
    bilateralGatePassed: boolean;
    outerMarginGatePassed: boolean;
    gutterGatePassed: boolean;
    independentGutterGatePassed: boolean;
    aspectSupportGatePassed: boolean;
    evidenceAgreementGatePassed: boolean;
    /** Optional because persisted protocol-v3 states may predate local recovery diagnostics. */
    outerMarginRecovery?: boolean;
    /** `null` is emitted by Rust when no edge was recovered. */
    outerMarginWeakEdge?: 'left' | 'right' | null;
    sparseSpreadRecovered: boolean;
    abstained: boolean;
    foldBand: TNativeScanCleanupFoldBandV3;
}

export interface INativeScanCleanupPageMetadataV3 {
    layoutClassification: TScanCleanupLayoutClassification;
    layoutConfidence?: number;
    cutterXPx: number | null;
    splitSeam?: IScanCleanupSplitSeamPolyline;
    splitAbstained?: boolean;
    rotationDegrees: TScanCleanupPageRotation;
    canvasScope: TScanCleanupCanvasScope;
    excluded: boolean;
    blankOutputsSkipped: number;
    outputCount: number;
    outputs?: INativeScanCleanupAnalysisOutputV3[];
    recommendedOutputMode?: TScanCleanupOutputMode;
    recommendedOutputModeConfidence?: number;
    recommendedOutputModeReason?: TScanCleanupOutputModeRecommendationReason;
    softAlphaForegroundRecommendation?: boolean;
    outputModeDiagnostics?: INativeScanCleanupOutputModeDiagnosticsV3;
    splitDiagnostics?: INativeScanCleanupSplitDiagnosticsV3;
}

/** Additive geometry returned in page/output metadata by protocol-v3 sidecars. */
export interface INativeScanCleanupSplitResultGeometryV3 {
    cutterXPx: number | null;
    /** Existing straight-cut page polygons. Output metadata always supplies these. */
    splitGeometry?: IScanCleanupPixelPolygon[];
    /** Optional diagnostic seam. Current renderers continue to use the straight cutter. */
    splitSeam?: IScanCleanupSplitSeamPolyline;
}

export interface INativeScanCleanupBinarizationDiagnosticsV3 {
    /**
     * Selected route plus raw measurements from the canonical, at-most-256px
     * routing raster. These fields do not describe the final working-DPI
     * threshold raster; a spread plan may select its joint candidate route.
     */
    route: TScanCleanupBinarizationMethod;
    robustContrast: number;
    illuminationDeviation: number;
    edgeDensity: number;
    estimatedStrokeWidthPx: number;
    darkBorderCoverage: number;
    otsuAdaptiveAgreement: number;
    /** The spread-loop decision that supplied the route and threshold scale. */
    spreadPlan?: INativeScanCleanupSpreadBinarizationPlanDiagnosticsV3;
}

export type TNativeScanCleanupSpreadBinarizationPlanDecisionV3 =
    | 'sharedJoint'
    | 'perLeafRouteMismatch'
    | 'perLeafAnchorDrift'
    | 'perLeafRadiusDrift'
    | 'perLeafFaintInkDrift';

export interface INativeScanCleanupSpreadBinarizationPlanDiagnosticsV3 {
    route: TScanCleanupBinarizationMethod;
    thresholdAnchor: number;
    thresholdRadius: number;
    strokeWidthAnchorPx: number;
    xHeightAnchorPx: number;
    documentAnchor: boolean;
    jointCandidateRoute: TScanCleanupBinarizationMethod;
    leftCandidateRoute: TScanCleanupBinarizationMethod;
    rightCandidateRoute: TScanCleanupBinarizationMethod;
    decision: TNativeScanCleanupSpreadBinarizationPlanDecisionV3;
}

export interface INativeScanCleanupContentSideConfidenceV3 {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Optional diagnostics written by render metadata. */
export interface INativeScanCleanupRenderDiagnosticsV3 {
    cutterXPx?: number | null;
    splitGeometry?: IScanCleanupPixelPolygon[];
    splitSeam?: IScanCleanupSplitSeamPolyline;
    detectedSkewDegrees?: number;
    skewConfidence?: number;
    skewApplied?: boolean;
    manualSkew?: boolean;
    layoutConfidence?: number;
    /** Additive split detector abstention signal when supplied by the native implementation. */
    splitAbstained?: boolean;
    binarizationMode?: TScanCleanupBinarizationMethod | null;
    binarizationDiagnostics?: INativeScanCleanupBinarizationDiagnosticsV3 | null;
    despeckleFallback?: boolean;
    dewarpConfidence?: number | null;
    contentDiagnostics?: {sideConfidence: INativeScanCleanupContentSideConfidenceV3};
}

/** Optional diagnostics written beside each analyzed page. */
export interface INativeScanCleanupPageDiagnosticsV3 {
    cutterXPx?: number | null;
    splitGeometry?: IScanCleanupPixelPolygon[];
    splitSeam?: IScanCleanupSplitSeamPolyline;
    layoutConfidence?: number;
    splitAbstained?: boolean;
    tier1Verdict?: TScanCleanupLayoutClassification;
    reconciled?: boolean;
    clusterAgreement?: number;
}

export interface INativeScanCleanupDetailRenderPlanV3 {
    /** Trusted metadata from the completed 150-DPI base preview. */
    baseMetadataPath: string;
    /** Full 150-DPI source raster used to reuse page-global processing models. */
    baseRasterPath: string;
    /** Canonical base-preview pixels whose transfer the detail tile replays. */
    baseCleanedRasterPath?: string;
    /** Actual Poppler crop in full, unrotated source-raster pixels at detail DPI. */
    sourceCrop: IScanCleanupPixelRect;
    fullSourceWidthPx: number;
    fullSourceHeightPx: number;
    /** Detail pixels per base-preview pixel. */
    scale: number;
    /** Requested payload bounds in final intrinsic-output pixels at detail DPI. */
    renderRegion: IScanCleanupPixelRect;
    /** Geometry/processing apron rendered before trimming to renderRegion. */
    sampledRegion: IScanCleanupPixelRect;
}

/** Native-only inverse geometry persisted beside a preview output for detail reuse. */
export interface INativeScanCleanupReusableGeometryV3 {
    inverseTransform?: IScanCleanupPreviewAffine;
    dewarpMapping?: {
        columns: number;
        rows: number;
        outputOrigin: IScanCleanupPixelPoint;
        outputWidth: number;
        outputHeight: number;
        outputToSource: IScanCleanupPixelPoint[];
        sourceToOutput: IScanCleanupPixelPoint[];
    } | null;
}

export interface INativeScanCleanupPageV3 {
    inputPath: string;
    /**
     * Fixed-resolution PDF render used for every analysis and routing decision.
     * Image callers omit this pair because inputPath is already a fixed source.
     */
    analysisInputPath?: string;
    analysisDpi?: number;
    /**
     * One-bit PDF soft mask extracted from a compact MRC source. White samples
     * select trusted foreground pixels; native maps it through the same page
     * geometry as inputPath instead of trying to rediscover glyphs.
     */
    trustedForegroundMaskPath?: string;
    /**
     * Native-resolution continuous-tone background extracted from the same
     * compact MRC page as trustedForegroundMaskPath.
     */
    trustedMrcBackgroundPath?: string;
    sourcePageIndex: number;
    pageMetadataPath: string;
    options: INativeScanCleanupOptionsV3;
    outputs: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
    detailRenderPlan?: INativeScanCleanupDetailRenderPlanV3;
}

export interface INativeScanCleanupManifestV3 {
    version: typeof SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION;
    operation: TNativeScanCleanupOperation;
    /**
     * Classification omits content/crop planning that no detection consumer
     * reads. Page-plan is the default for compatibility and for lossless
     * previews, which do consume those output rectangles.
     */
    analysisPurpose?: TNativeScanCleanupAnalysisPurpose;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    documentCanvas?: {
        widthPoints: number;
        heightPoints: number;
        widthPx: number;
        heightPx: number;
    };
    /**
     * Physical memory of this host. The sidecar has no portable way to read it,
     * so it sizes its worker pool and stage cache from this figure instead.
     */
    hostMemoryBytes?: number;
    /**
     * Maximum number of streamed raster materializations that may be live
     * while native page processing remains serial. Omitted direct-CLI
     * manifests retain the one-page turnstile.
     */
    rasterWindow?: number;
    /**
     * Analyze page inputs the owning process keeps staged at once. Present only
     * when it stages a bounded window of replayable rasters instead of the
     * whole document, which puts the sidecar on the lease protocol below.
     * Omitted means every Analyze input must already exist, the direct-CLI
     * contract. See docs/internal/scan-cleanup/staged-analyze-window.md.
     */
    stagedInputWindow?: number;
    /**
     * Pixels in the largest raster that window will stage. The sidecar sizes
     * its page pool from it while most inputs are still unrendered, so the
     * memory bound stays a fact about the document. Needs a window.
     */
    stagedInputPeakPixels?: number;
    pages: INativeScanCleanupPageV3[];
}

const s = runtimeSchema;
const pageNumber = s.fromParser<TPageNumber>(
    value => decodeScanCleanupPageNumber(value, 'page number'),
    () => decodeScanCleanupPageNumber(1, 'page number'),
);
const nonNegativeInteger = (message: string) => s.number({
    integer: true,
    min: 0,
    message,
});
const confidence = (message: string) => s.number({
    min: 0,
    max: 1,
    message,
});
const classification = s.oneOf([
    'single-uncut-page',
    'page-with-offcut',
    'two-page-spread',
] as const, 'Invalid evb-scan-cleanup progress classification');
const documentPrior = s.refine(s.object({
    dominantLayout: classification,
    cutterRatioMedian: s.nullable(s.number({
        min: 0.2,
        max: 0.8,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
    clusterDims: s.object({
        widthPx: s.number({
            min: Number.MIN_VALUE,
            message: 'Invalid evb-scan-cleanup document prior',
        }),
        heightPx: s.number({
            min: Number.MIN_VALUE,
            message: 'Invalid evb-scan-cleanup document prior',
        }),
    }, {
        exact: true,
        message: 'Invalid evb-scan-cleanup document prior',
    }),
    agreementStrength: confidence('Invalid evb-scan-cleanup document prior'),
    strokeWidthMedianPx: s.optional(s.number({
        min: Number.MIN_VALUE,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
    xHeightMedianPx: s.optional(s.number({
        min: Number.MIN_VALUE,
        message: 'Invalid evb-scan-cleanup document prior',
    })),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup document prior',
}), value =>
    value.dominantLayout !== 'two-page-spread' || value.cutterRatioMedian !== null,
'Invalid evb-scan-cleanup document prior');
const textAxis = s.object({
    sideways: s.boolean(),
    confidence: confidence('Invalid evb-scan-cleanup text axis'),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup text axis',
});
const pageStageTimings = s.object({
    decodeMs: s.optional(s.number({min: 0})),
    analysisLevelMs: s.optional(s.number({min: 0})),
    normalizationMs: s.optional(s.number({min: 0})),
    illuminationPreparationMs: s.optional(s.number({min: 0})),
    layoutNormalizationMs: s.optional(s.number({min: 0})),
    calibrationMs: s.optional(s.number({min: 0})),
    pictureMaskMs: s.optional(s.number({min: 0})),
    modeRecommendationMs: s.optional(s.number({min: 0})),
    qualityNormalizationMs: s.optional(s.number({min: 0})),
    textAxisMs: s.optional(s.number({min: 0})),
    splitMs: s.optional(s.number({min: 0})),
    deskewMs: s.optional(s.number({min: 0})),
    contentMs: s.optional(s.number({min: 0})),
    rasterizationMs: s.optional(s.number({min: 0})),
    maskRasterizationMs: s.optional(s.number({min: 0})),
    binarizationMs: s.optional(s.number({min: 0})),
    thresholdPreparationMs: s.optional(s.number({min: 0})),
    thresholdingMs: s.optional(s.number({min: 0})),
    binaryPostprocessMs: s.optional(s.number({min: 0})),
    mixedCompositionMs: s.optional(s.number({min: 0})),
    outputProcessingMs: s.optional(s.number({min: 0})),
    renderMs: s.optional(s.number({min: 0})),
    writeMs: s.optional(s.number({min: 0})),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup stage timings',
});
const outputModeDiagnostics = s.object({
    rule: s.oneOf([
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
    ] as const, 'Invalid evb-scan-cleanup output mode diagnostics'),
    fallbackUsed: s.boolean(),
    analysisWidth: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    analysisHeight: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    otsuThreshold: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    darkMean: s.number(),
    lightMean: s.number(),
    midtoneLower: s.number(),
    midtoneUpper: s.number(),
    p01: s.number(),
    p50: s.number(),
    p99: s.number(),
    bimodality: s.number(),
    midtoneFraction: s.number(),
    relativeMidtoneFraction: s.number(),
    modeDistance: s.number(),
    inkFraction: s.number(),
    edgeFraction: s.number(),
    robustLuminanceRange: s.number(),
    coloredFraction: s.number(),
    largestColorComponentPixels: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    meanSaturation: s.number(),
    pictureFraction: s.number(),
    textLineCount: nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics'),
    significantColor: s.boolean(),
    significantPicture: s.boolean(),
    pictureGateMargin: s.number(),
    tonalMidtoneGateMargin: s.number(),
    strongBimodalityGateMargin: s.number(),
    confidentTextBimodalityMargin: s.number(),
    confidentTextModeDistanceMargin: s.number(),
    confidentTextMidtoneMargin: s.number(),
    denseTextLineMargin: s.number(),
    denseTextBimodalityMargin: s.number(),
    denseTextModeDistanceMargin: s.number(),
    denseTextMidtoneMargin: s.number(),
    outsideTonalFraction: s.number(),
    outsideTonalLargestComponentFraction: s.number(),
    outsideTonalLargestComponentWidthFraction: s.number(),
    outsideTonalLargestComponentHeightFraction: s.number(),
    coherentOutsideTonalRegion: s.boolean(),
    destructiveModeTonalVeto: s.boolean(),
    protectedTextBlockCount: s.optional(nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics')),
    protectedTextBlockPictureOverlapPixels: s.optional(nonNegativeInteger('Invalid evb-scan-cleanup output mode diagnostics')),
    protectedTextBlockPictureOverlapFraction: s.optional(s.number()),
    mixedOwnershipIndependentPictureEvidence: s.optional(s.boolean()),
    mixedOwnershipVeto: s.optional(s.boolean()),
    sourceDpi: s.number({min: 0}),
    analysisDpi: s.number({min: 0}),
    calibratedSourceStrokeWidthPx: s.number({min: 0}),
    calibratedSourceXHeightPx: s.number({min: 0}),
    softEdgeToInkRatio: s.number({min: 0}),
    bilevelFidelityVeto: s.boolean(),
}, {
    exact: true,
    message: 'Invalid evb-scan-cleanup output mode diagnostics',
});
const progress = s.refine(s.refine(s.object({
    stage: s.oneOf([
        'started',
        'page-analyzed',
        // Staged-input lease frames, carrying page identity only: the producer
        // answers `page-input-required` by publishing that page's raster and
        // may drop it after `page-input-released`.
        'page-input-required',
        'page-input-released',
        'page-complete',
        'completed',
    ] as const, 'Invalid evb-scan-cleanup progress envelope'),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup progress envelope'),
    pageNumber: s.optional(pageNumber),
    outputPaths: s.optional(s.array(s.string())),
    classification: s.optional(classification),
    confidence: s.optional(s.number({message: 'Invalid evb-scan-cleanup progress confidence'})),
    cutterXPx: s.optional(s.number({message: 'Invalid evb-scan-cleanup progress cutter'})),
    tier1Verdict: s.optional(classification),
    reconciled: s.optional(s.boolean()),
    clusterAgreement: s.optional(s.number({
        min: -1,
        max: 1,
        message: 'Invalid evb-scan-cleanup cluster agreement',
    })),
    documentPrior: s.optional(documentPrior),
    textAxis: s.optional(textAxis),
    stageTimings: s.optional(pageStageTimings),
    recommendedOutputMode: s.optional(s.oneOf([
        'bw',
        'mixed',
        'grayscale',
        'color',
    ] as const, 'Invalid evb-scan-cleanup recommended output mode')),
    recommendedOutputModeConfidence: s.optional(confidence(
        'Invalid evb-scan-cleanup output mode confidence',
    )),
    recommendedOutputModeReason: s.optional(s.oneOf([
        'blank',
        'color-chroma',
        'text-with-pictures',
        'continuous-tone',
        'bimodal-text',
        'uncertain-tonal',
    ] as const, 'Invalid evb-scan-cleanup output mode recommendation reason')),
    softAlphaForegroundRecommendation: s.optional(s.boolean()),
    outputModeDiagnostics: s.optional(outputModeDiagnostics),
}), value => value.completedPages <= value.totalPages,
'Invalid evb-scan-cleanup progress envelope'), value =>
    value.pageNumber === undefined
        ? value.stage !== 'page-analyzed'
            && value.stage !== 'page-complete'
            && value.stage !== 'page-input-required'
            && value.stage !== 'page-input-released'
        : true,
'Invalid evb-scan-cleanup progress page number');
const successResult = s.object({
    status: s.oneOf(['success'] as const),
    completedPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
    totalPages: nonNegativeInteger('Invalid evb-scan-cleanup success result'),
});
const failureResult = s.object({
    status: s.oneOf(['failure'] as const),
    code: s.oneOf(NATIVE_ERROR_CODES),
    message: s.string(),
});
const progressEnvelope = s.object({
    version: s.oneOf([SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION] as const),
    type: s.oneOf(['progress'] as const),
    progress,
});
const resultEnvelope = s.object({
    version: s.oneOf([SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION] as const),
    type: s.oneOf(['result'] as const),
    result: s.union([
        successResult,
        failureResult,
    ] as const, 'Invalid evb-scan-cleanup result envelope'),
});

/**
 * Structured warning transport. A producer states the condition it detected and
 * the finite parameters that describe it; the shared formatter in
 * `packages/scan-cleanup/core/policy/scanCleanupWarningEvents` owns every user-visible
 * sentence. Aggregation therefore reads codes, never English, and a wording
 * change cannot turn one aggregate into per-page noise.
 */
export const SCAN_CLEANUP_WARNING_EVENT_CODES = [
    'matched-canvas-content-fitted',
    'matched-canvas-content-fitted-pages',
    'matched-canvas-margins-reduced',
    'matched-canvas-margins-unavailable',
    'matched-canvas-paper-downscaled',
    'matched-canvas-optical-centering-fallback',
    'matched-canvas-intrinsic-overflow',
    'matched-canvas-spread-headroom-trimmed',
    'matched-canvas-fold-columns-discarded',
    'matched-canvas-dropped',
    'matched-canvas-geometry-unmeasured',
    'matched-canvas-pages-resampled',
    'matched-canvas-pages-scaled-in-place',
    'matched-canvas-document-dpi-normalized',
    'matched-canvas-page-dpi-capped',
    'render-dpi-limited',
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
    s.oneOf([code] as const, warningEventMessage);
/**
 * Physical extents travel in the unit their producer measures in: a raster
 * placement in canvas pixels, a lossless placement in PDF points. The unit also
 * decides how the formatter prints them, so pixel extents must be whole.
 */
const warningEventUnit = s.oneOf([
    'px',
    'pt',
] as const, warningEventMessage);
const warningEventExtent = s.number({
    min: 0,
    max: MAX_SCAN_CLEANUP_WARNING_EVENT_EXTENT,
    message: warningEventMessage,
});
const warningEventCount = s.number({
    integer: true,
    min: 0,
    max: MAX_SCAN_CLEANUP_WARNING_EVENT_EXTENT,
    message: warningEventMessage,
});
const warningEventDpi = s.number({
    min: Number.MIN_VALUE,
    max: MAX_SCAN_CLEANUP_WARNING_EVENT_DPI,
    message: warningEventMessage,
});
/**
 * A DPI the formatter prints with three decimals, and a percentage it prints
 * with one, travel as the fixed-point integer their producer quantized to.
 * Rust and JavaScript disagree on which way an exact half rounds, so the digits
 * are decided once — by the code that measured the value — and the formatter
 * only places the decimal point.
 */
const warningEventDpiThousandths = s.number({
    integer: true,
    min: 1,
    max: MAX_SCAN_CLEANUP_WARNING_EVENT_DPI_THOUSANDTHS,
    message: warningEventMessage,
});
const warningEventScalePercentTenths = s.number({
    integer: true,
    min: 0,
    max: MAX_SCAN_CLEANUP_WARNING_EVENT_SCALE_PERCENT_TENTHS,
    message: warningEventMessage,
});
const warningEventPageNumber = pageNumber;
/**
 * A page list is a set the producer already deduplicated, kept in the order it
 * discovered the pages in — source order carries meaning, so the contract
 * checks for repeats rather than normalizing them away.
 */
const warningEventPages = s.refine(
    s.array(warningEventPageNumber),
    value => value.length > 0
        && value.length <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
        && new Set(value).size === value.length,
    warningEventMessage,
);
const warningEventDetail = s.refine(
    s.string(),
    value => value.length <= MAX_SCAN_CLEANUP_WARNING_EVENT_DETAIL_LENGTH,
    warningEventMessage,
);
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

const contentFitted = s.refine(s.object({
    code: warningEventCode('matched-canvas-content-fitted'),
    unit: warningEventUnit,
    contentWidth: warningEventExtent,
    contentHeight: warningEventExtent,
    innerWidth: warningEventExtent,
    innerHeight: warningEventExtent,
    /** Present only where the producer reports the whole document rectangle. */
    documentCanvasWidth: s.optional(warningEventExtent),
    documentCanvasHeight: s.optional(warningEventExtent),
}, {
    exact: true,
    message: warningEventMessage,
}), value => pixelExtentsAreWhole(value.unit, [
    value.contentWidth,
    value.contentHeight,
    value.innerWidth,
    value.innerHeight,
    value.documentCanvasWidth,
    value.documentCanvasHeight,
]) && rectangleIsWholeOrAbsent(
    value.documentCanvasWidth,
    value.documentCanvasHeight,
), warningEventMessage);
const paperDownscaled = s.refine(s.object({
    code: warningEventCode('matched-canvas-paper-downscaled'),
    unit: warningEventUnit,
    scalePercentTenths: warningEventScalePercentTenths,
    documentCanvasWidth: warningEventExtent,
    documentCanvasHeight: warningEventExtent,
    /** Present only where the producer measured the paper it could not hold. */
    paperWidth: s.optional(warningEventExtent),
    paperHeight: s.optional(warningEventExtent),
}, {
    exact: true,
    message: warningEventMessage,
}), value => pixelExtentsAreWhole(value.unit, [
    value.documentCanvasWidth,
    value.documentCanvasHeight,
    value.paperWidth,
    value.paperHeight,
]) && rectangleIsWholeOrAbsent(value.paperWidth, value.paperHeight), warningEventMessage);
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
const canonicalPageDpiCapped = s.object({
    code: warningEventCode('matched-canvas-page-dpi-capped'),
    pageNumber: warningEventPageNumber,
    appliedDpiThousandths: warningEventDpiThousandths,
    requestedDpiThousandths: warningEventDpiThousandths,
}, {
    exact: true,
    message: warningEventMessage,
});
const legacyPageDpiCapped = s.object({
    code: warningEventCode('matched-canvas-page-dpi-capped'),
    pageNumber: warningEventPageNumber,
    appliedDpi: warningEventDpi,
    requestedDpi: warningEventDpi,
}, {
    exact: true,
    message: warningEventMessage,
});
const legacyDpiThousandths = (dpi: number) => Math.max(1, Math.round(dpi * 1_000));
const pageDpiCapped = s.fromParser(value => {
    if (!isRecord(value) || !('appliedDpi' in value || 'requestedDpi' in value)) {
        return canonicalPageDpiCapped.decode(value);
    }
    const legacy = legacyPageDpiCapped.decode(value);
    return canonicalPageDpiCapped.decode({
        code: legacy.code,
        pageNumber: legacy.pageNumber,
        appliedDpiThousandths: legacyDpiThousandths(legacy.appliedDpi),
        requestedDpiThousandths: legacyDpiThousandths(legacy.requestedDpi),
    });
}, canonicalPageDpiCapped.example);
export const SCAN_CLEANUP_WARNING_EVENT_SCHEMA = s.union([
    contentFitted,
    s.object({
        code: warningEventCode('matched-canvas-content-fitted-pages'),
        pages: warningEventPages,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({code: warningEventCode('matched-canvas-margins-reduced')}, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({code: warningEventCode('matched-canvas-margins-unavailable')}, {
        exact: true,
        message: warningEventMessage,
    }),
    paperDownscaled,
    s.object({code: warningEventCode('matched-canvas-optical-centering-fallback')}, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-intrinsic-overflow'),
        leftPx: warningEventCount,
        rightPx: warningEventCount,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-spread-headroom-trimmed'),
        topPx: warningEventCount,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-fold-columns-discarded'),
        leftColumns: warningEventCount,
        rightColumns: warningEventCount,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({code: warningEventCode('matched-canvas-dropped')}, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-geometry-unmeasured'),
        detail: warningEventDetail,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-pages-resampled'),
        pages: warningEventPages,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-pages-scaled-in-place'),
        pages: warningEventPages,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    s.object({
        code: warningEventCode('matched-canvas-document-dpi-normalized'),
        canvasDpi: warningEventDpi,
        finestPageDpi: warningEventDpi,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
    pageDpiCapped,
    s.object({
        code: warningEventCode('render-dpi-limited'),
        appliedDpiThousandths: warningEventDpiThousandths,
        requestedDpiThousandths: warningEventDpiThousandths,
    }, {
        exact: true,
        message: warningEventMessage,
    }),
] as const, warningEventMessage);

export const SCAN_CLEANUP_WARNING_EVENTS_SCHEMA = s.refine(
    s.array(SCAN_CLEANUP_WARNING_EVENT_SCHEMA),
    value => value.length <= MAX_SCAN_CLEANUP_WARNING_EVENTS,
    'evb-scan-cleanup warning events exceed the protocol limit',
);

export type TScanCleanupWarningEvent = TInferSchema<typeof SCAN_CLEANUP_WARNING_EVENT_SCHEMA>;

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

export const NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA = s.fromParser((value: unknown) => {
    if (!isRecord(value) || value.version !== SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION) {
        throw new Error('Unsupported evb-scan-cleanup NDJSON protocol version');
    }
    if (value.type === 'progress') {
        return progressEnvelope.decode(value);
    }
    if (value.type === 'result') {
        return resultEnvelope.decode(value);
    }
    throw new Error('Unknown evb-scan-cleanup NDJSON envelope type');
}, progressEnvelope.example);

export type TNativeScanCleanupPageStageTimingsV3 = TInferSchema<typeof pageStageTimings>;
export type TNativeScanCleanupProgressV3 = TInferSchema<typeof progress>;
export type TNativeScanCleanupProgressStage = TNativeScanCleanupProgressV3['stage'];
export type TNativeScanCleanupProgressEnvelopeV3 = TInferSchema<typeof progressEnvelope>;
export type TNativeScanCleanupResultV3 = TInferSchema<typeof resultEnvelope>['result'];
export type TNativeScanCleanupResultEnvelopeV3 = TInferSchema<typeof resultEnvelope>;
export type TNativeScanCleanupEnvelopeV3 = TInferSchema<typeof NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA>;
