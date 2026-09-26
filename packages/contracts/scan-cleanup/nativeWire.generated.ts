// Generated from the evb-scan-cleanup Rust types; do not edit.
// Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_typescript`.

/**
 * Row-major affine mapping whose final row is `[0, 0, 1]`.
 */

export type Affine = { matrix: [[number, number, number], [number, number, number], [number, number, number]], };

export type AnalysisOutputMetadata = { half: PageHalf, sourceRegion: PixelRect, contentBox: PixelRect | null, contentDiagnostics?: ContentDiagnostics, textToneDiagnostics?: TextToneDiagnostics, cropRect: PixelRect, appliedMargins: AppliedMargins, inputWidthPx: number, inputHeightPx: number, 
/**
 * Present when the manifest page carries its PDF geometry for the
 * lossless route.
 */
pdfPlacement?: LosslessPlacement, };

export type AnalysisPurpose = "classification" | "page-plan";

export type AppliedMargins = { leftPx: number, topPx: number, rightPx: number, bottomPx: number, };

export type AutomaticSkewDegrees = { full: number | null, left: number | null, right: number | null, };

/**
 * Raw Auto-routing measurements from the canonical, at-most-256px routing
 * sample. These values intentionally describe the decision basis rather than
 * the working-resolution raster that receives the selected threshold.
 */

export type BinarizationDiagnostics = { route: BinarizationMode, robustContrast: number, illuminationDeviation: number, edgeDensity: number, estimatedStrokeWidthPx: number, darkBorderCoverage: number, otsuAdaptiveAgreement: number, spreadPlan?: SpreadBinarizationPlanDiagnostics, };

export type BinarizationMode = "otsu" | "sauvola" | "wolf" | "auto";

export type CanvasScope = "page" | "document";

export type CleanupMetadata = { version: number, sourcePageIndex: number, half: PageHalf, detectedSkewDegrees: number, skewConfidence: number, skewApplied: boolean, manualSkew?: boolean, layoutClassification: LayoutClassification, layoutConfidence: number, cutterXPx: number | null, splitGeometry: Array<Polygon>, splitSeam?: SplitSeamPolyline, sourceRegion: PixelRect, contentBox: PixelRect | null, 
/**
 * Applied crop in deskewed/dewarped page-region coordinates.
 */
cropRect: PixelRect, contentDiagnostics?: ContentDiagnostics, appliedMargins: AppliedMargins, softMarginsPx: [number, number, number, number], uniformCanvas: boolean, canvasPolicy: MatchedCanvasPolicy, canvasOverflow: boolean, matchedCanvasTargetWidthPx: number | null, matchedCanvasTargetHeightPx: number | null, matchedCanvasTargetWidthPoints: number | null, matchedCanvasTargetHeightPoints: number | null, 
/**
 * Size the intrinsic raster takes on the matched canvas. A final run has
 * already resampled its raster to it; a preview reports it so the renderer
 * presents the page at the document's scale without a second render.
 */
matchedCanvasContentWidthPx: number | null, matchedCanvasContentHeightPx: number | null, 
/**
 * True when placement is anchored to the transformed optical content
 * rather than requiring the retained white raster rectangle to fit.
 */
matchedCanvasOpticalPlacement?: boolean, 
/**
 * Horizontal optical bounds in the intrinsic raster coordinate space.
 * Consumers use these with `intrinsicRasterWidthPx` to validate the
 * optical placement in canvas pixels.
 */
matchedCanvasOpticalContentLeftPx?: number, matchedCanvasOpticalContentRightPx?: number, matchedCanvasIntrinsicOverflowLeftPx?: number, matchedCanvasIntrinsicOverflowRightPx?: number, matchedCanvasIntrinsicOverflowTopPx?: number, 
/**
 * Canvas-grid columns excluded from the materialized source window at
 * the fold edge. Preview consumers apply the same source clip.
 */
foldClipLeftPx?: number, foldClipRightPx?: number, 
/**
 * Physical PDF rectangle for a source-grid continuous-tone raster. When
 * absent, assemblers retain the legacy behavior of covering the MediaBox.
 */
pdfImagePlacement?: PdfImagePlacement, 
/**
 * How the compact source page is placed when it is kept instead of this
 * raster. Reported for whole-page outputs of pages whose PDF geometry the
 * manifest carried.
 */
sourcePdfPlacement?: LosslessPlacement, outputMode: OutputMode, bilevelWritten?: boolean, layeredWritten?: boolean, layeredForegroundKind?: LayeredForegroundKind, layeredBackgroundDpi?: number, layeredForegroundDpi?: number, 
/**
 * Compatibility field for the explicit lossless source path. Fresh
 * raster cleanup never sets this bit, even when producer MRC layers are
 * supplied as analysis hints.
 */
trustedMrcBackgroundPreserved?: boolean, 
/**
 * Compatibility field for legacy consumers. Fresh raster cleanup keeps
 * producer selection masks as hints and never sets this bit.
 */
trustedSelectionApplied?: boolean, illuminationNormalized: boolean, textToneDiagnostics?: TextToneDiagnostics, binarizationMode: BinarizationMode | null, binarizationDiagnostics: BinarizationDiagnostics | null, inkConsistencyDiagnostics?: InkConsistencyDiagnostics, despeckleFallback: boolean, forwardTransform: Affine | null, inverseTransform: Affine | null, dewarpModel: DewarpOptions | null, dewarpMapping: DewarpMappingGrid | null, dewarpConfidence: number | null, inputWidthPx: number, inputHeightPx: number, 
/**
 * Intrinsic, unpadded cleaned-raster width.
 */
outputWidthPx: number, 
/**
 * Intrinsic, unpadded cleaned-raster height.
 */
outputHeightPx: number, 
/**
 * Width of the raster before matched-canvas materialization. The
 * post-match output dimensions describe the content box, while this
 * field keeps OCR and PDF geometry tied to the visible source raster.
 */
intrinsicRasterWidthPx?: number, intrinsicRasterHeightPx?: number, 
/**
 * Actual preview payload bounds inside the full intrinsic output.
 */
renderRegion?: PixelRect, canvasWidthPx: number, canvasHeightPx: number, placementOffsetXPx: number, placementOffsetYPx: number, rotationDegrees: OrthogonalRotation, canvasScope: CanvasScope, resamplePasses: number, sourceDpi: number, renderDpi: number, requestedRenderDpi: number, rasterScaleLimited: boolean, 
/**
 * Unstructured diagnostics with no program logic or UI behind them.
 */
warnings: Array<string>, warningEvents: Array<CleanupWarningEvent>, };

export type CleanupOptions = { dpi: number, sourceDpi: number | null, sourceHasBilevelLayer: boolean, sourceBackgroundDpi: number | null, 
/**
 * The trusted MRC selection mask is known to be an incomplete ink
 * carrier (the producer authored a full-resolution background and left
 * detail there). Mixed composition keeps that background underneath and
 * stays safe; bilevel output must not adopt the selection as its ink.
 */
trustedSelectionIncomplete: boolean, requestedRenderDpi: number | null, 
/**
 * Optional preview tile in normalized final intrinsic-output space.
 */
renderCrop: NormalizedRect | null, binarization: BinarizationMode, thickness: number, normalizeIllumination: boolean, despeckle: boolean, despeckleLevel: DespeckleLevel, outputMode: OutputMode, 
/**
 * Locked Auto representation decision. `None` preserves native policy for
 * an explicitly selected Mixed mode.
 */
preferSoftAlphaForeground: boolean | null, resolvedTextToneDiagnostics?: ResolvedTextToneDiagnostics, ocrMode: boolean, 
/**
 * OCR-only raster preparation: detect light text on a dark page and
 * otherwise pass the source raster through without scan cleanup.
 */
ocrPolarityOnly: boolean, layout: LayoutMode, manualSplit: NormalizedSplit | null, automaticSplit: NormalizedSplit | null, manualSkewDegrees: number | null, manualContentBoxes: ManualContentBoxes, automaticSkewDegrees?: AutomaticSkewDegrees, automaticContentBoxes?: ManualContentBoxes, manualZones: ManualZones, cropContent: boolean, matchPageSize: boolean, pageAlignment: PageAlignment, placementOverrides: PlacementOverrides, placementAnchors?: PlacementAnchors, margins: MarginsMm | null, dewarp: DewarpOptions | null, experimental: ExperimentalOptions, rotationDegrees: OrthogonalRotation, excluded: boolean, skipBlankPages: boolean, maxPixels: number, maxDimensionPx: number, };

/**
 * Structured counterpart of `CleanupMetadata::warnings` for every condition
 * the pipeline aggregates or presents as a decision. Wording, units, and page
 * prefixes belong to the shared TypeScript formatter, so an event carries only
 * the parameters that sentence needs and never any user-facing text.
 */

export type CleanupWarningEvent = { "code": "matched-canvas-content-fitted", unit: WarningExtentUnit, contentWidth: number, contentHeight: number, innerWidth: number, innerHeight: number, documentCanvasWidth?: number, documentCanvasHeight?: number, } | { "code": "matched-canvas-margins-reduced" } | { "code": "matched-canvas-margins-unavailable" } | { "code": "matched-canvas-paper-downscaled", unit: WarningExtentUnit, scalePercentTenths: number, documentCanvasWidth: number, documentCanvasHeight: number, paperWidth?: number, paperHeight?: number, } | { "code": "matched-canvas-optical-centering-fallback" } | { "code": "matched-canvas-intrinsic-overflow", leftPx: number, rightPx: number, } | { "code": "matched-canvas-spread-headroom-trimmed", topPx: number, } | { "code": "matched-canvas-fold-columns-discarded", leftColumns: number, rightColumns: number, } | { "code": "render-dpi-limited", appliedDpiThousandths: number, requestedDpiThousandths: number, };

export type ClusterDimensions = { widthPx: number, heightPx: number, };

export type ContentAcceptedTrim = { side: ContentTrimSide, iteration: number, score: number, threshold: number, contentDistanceSum: number, garbageDistanceSum: number, removedBlocks: Array<ContentBlockEvidence>, };

export type ContentBlockEvidence = { bounds: ContentDiagnosticRect, pictureMaskOverlapPixels: number, headingEvidence: boolean, grayscaleEvidence: boolean, textEvidence: boolean, };

export type ContentDiagnosticRect = { xPx: number, yPx: number, widthPx: number, heightPx: number, };

export type ContentDiagnostics = { sideConfidence: ContentSideConfidence, textMask: ContentTextMaskSummary, 
/**
 * Exact analysis-space detector box after every post-trim writer. Export
 * maps this box through source-pixel support and margin transforms; it is
 * not the final output crop rectangle. Absent means no detected crop box.
 */
shippedBounds?: ContentDiagnosticRect, acceptedTrims?: Array<ContentAcceptedTrim>, protectedBlocks?: Array<ContentBlockEvidence>, };

export type ContentSideConfidence = { left: number, top: number, right: number, bottom: number, };

export type ContentTextMaskSummary = { analysisWidthPx: number, analysisHeightPx: number, inkPixels: number, lineCount: number, bounds?: ContentDiagnosticRect, };

export type ContentTransform = { scale: number, translateX: number, translateY: number, };

export type ContentTrimSide = "left" | "top" | "right" | "bottom";

export type DespeckleLevel = "off" | "cautious" | "normal" | "aggressive";

export type DetailPixelRect = { xPx: number, yPx: number, widthPx: number, heightPx: number, };

export type DetailRenderPlan = { baseMetadataPath: string, baseRasterPath: string, 
/**
 * Canonical cleaned base-preview raster for this output half. Detail
 * rendering replays its source-to-cleaned transfer instead of rebuilding
 * illumination and text-tone decisions from a viewport crop.
 */
baseCleanedRasterPath: string | null, sourceCrop: DetailPixelRect, fullSourceWidthPx: number, fullSourceHeightPx: number, scale: number, renderRegion: DetailPixelRect, sampledRegion: DetailPixelRect, };

export type DewarpMappingGrid = { columns: number, rows: number, outputOrigin: Point, outputWidth: number, outputHeight: number, outputToSource: Array<Point>, sourceToOutput: Array<Point>, };

export type DewarpOptions = { 
/**
 * Directrix points use source-rotated page coordinates: after the page's
 * orthogonal rotation, before region placement, deskew, dewarp, or crop.
 */
topCurve: Array<Point>, bottomCurve: Array<Point>, depth: number, };

/**
 * The one rectangle and pixel grid every matched output of this document is
 * normalized onto. The owning process measures it from the source page
 * geometry so a preview and the final run place their pages identically.
 */

export type DocumentCanvas = { widthPoints: number, heightPoints: number, widthPx: number, heightPx: number, };

export type DocumentPrior = { dominantLayout: LayoutClassification, cutterRatioMedian: number | null, clusterDims: ClusterDimensions, agreementStrength: number, 
/**
 * Robust document-level body-text calibration, measured in the analysis
 * raster's effective-DPI pixels. These anchors let a spread share one
 * threshold scale without making a noisy leaf's local estimate the
 * document policy.
 */
strokeWidthMedianPx?: number, xHeightMedianPx?: number, };

export type ExperimentalOptions = { autoDewarp: boolean, autoDewarpDepth: number | null, };

export type FoldBand = { "status": "measured", leftXPx: number, rightXPx: number, } | { "status": "unmeasured", reason: FoldBandUnmeasuredReason, nominalHalfWidthPx: number, };

export type FoldBandUnmeasuredReason = "not-applicable" | "no-fold-evidence" | "fold-evidence-unquantified" | "cutter-invalidated" | "measurement-unavailable";

export type InkConsistencyDiagnostics = { priorSampleCount: number, priorSurvivalMedian: number, survivalBefore: number, survivalAfter: number, addedInkPixels: number, applied: boolean, };

export type LayeredForegroundKind = "stencil" | "soft-alpha" | "source-mrc";

export type LayoutClassification = "single-uncut-page" | "page-with-offcut" | "two-page-spread";

export type LayoutMode = "auto" | "force-single" | "page-with-offcut" | "keep-left" | "keep-right" | "force-two-page";

/**
 * The window `split-pages` cuts from the source page and the transform it
 * applies first, plus the conditions the placement had to report.
 */

export type LosslessPlacement = { cropRect: PdfRect, contentTransform?: ContentTransform, 
/**
 * The content changed scale to reach the canvas.
 */
contentScaled: boolean, warningEvents?: Array<CleanupWarningEvent>, preview?: PreviewPlacement, };

export type ManifestV3 = { version: number, operation: Operation, analysisPurpose: AnalysisPurpose, renderMode: RenderMode, canvasScope: CanvasScope, documentCanvas: DocumentCanvas | null, 
/**
 * Physical memory of the host that authored this manifest. The sidecar has
 * no portable way to read it, so the owning process reports it here and the
 * worker pool and stage cache are sized from it. Absent for direct CLI
 * invocations, which then size themselves conservatively.
 */
hostMemoryBytes: number | null, 
/**
 * Bounded streamed-raster look-ahead. Direct CLI callers that do not
 * coordinate producers retain the one-page acknowledgement turnstile.
 */
rasterWindow: number, 
/**
 * Number of Analyze page inputs the owning process keeps staged at once.
 *
 * Present only when that process stages replayable page rasters through
 * the lease protocol: the sidecar announces `page-input-required` for an
 * absent input, waits for the producer to publish it, and announces
 * `page-input-released` once it has finished reading it. Because the
 * producer can always re-render the same deterministic raster, an input
 * released here is replayable rather than consumed, which is what keeps a
 * bounded window from changing any classification. Absent means every
 * Analyze input must already exist, which is the direct-CLI contract.
 */
stagedInputWindow: number | null, 
/**
 * Largest staged Analyze input the owning process will publish, in pixels.
 *
 * The sidecar sizes its page pool from the largest input it can measure,
 * but under a staged window most inputs are still unrendered when that
 * decision is made. The producer already knows every page's raster
 * geometry, so it declares the document's peak here and the memory-derived
 * bound stays a document fact instead of a staging-order accident.
 */
stagedInputPeakPixels: number | null, pages: Array<Page>, };

export type ManualContentBoxes = { full: NormalizedRect | null, left: NormalizedRect | null, right: NormalizedRect | null, };

/**
 * Manual mask overrides use ScanTailor's stable three-pass ordering:
 * ERASER1 (force binary), PAINTER2 (force picture), then ERASER3 and fill
 * zones (force binary). Array order therefore cannot change layer priority.
 */

export type ManualZones = { picture: Array<PictureZone>, fill: Array<NormalizedZonePolygon>, };

export type MarginsMm = { leftMm: number, topMm: number, rightMm: number, bottomMm: number, };

export type MatchedCanvasPolicy = "intrinsic" | "strict-maximum";

export type NativeErrorCode = "encrypted" | "needs-password" | "too-large" | "corrupt-xref" | "unsupported-filter" | "invalid-request" | "io" | "timeout" | "panic" | "native-failure";

export type NormalizedRect = { xNormalized: number, yNormalized: number, widthNormalized: number, heightNormalized: number, rotationDegrees: OrthogonalRotation, };

export type NormalizedSplit = { xNormalized: number, rotationDegrees: OrthogonalRotation, };

export type NormalizedZonePoint = { xNormalized: number, yNormalized: number, };

export type NormalizedZonePolygon = { points: Array<NormalizedZonePoint>, rotationDegrees: OrthogonalRotation, };

export type Operation = "analyze" | "render";

export type OrthogonalRotation = 0 | 90 | 180 | 270;

export type OuterMarginSide = "left" | "right";

export type OutputMode = "bw" | "mixed" | "grayscale" | "color" | "auto";

/**
 * The raw measurements and signed gate margins behind an automatic output-mode
 * decision. Positive margins satisfy a lower-bound gate. Negative margins
 * satisfy an upper-bound gate. Keeping the values in page metadata makes an
 * Auto decision reproducible instead of exposing only its final label.
 */

export type OutputModeDiagnostics = { rule: OutputModeRule, fallbackUsed: boolean, analysisWidth: number, analysisHeight: number, otsuThreshold: number, darkMean: number, lightMean: number, midtoneLower: number, midtoneUpper: number, p01: number, p50: number, p99: number, bimodality: number, midtoneFraction: number, relativeMidtoneFraction: number, modeDistance: number, inkFraction: number, edgeFraction: number, robustLuminanceRange: number, coloredFraction: number, largestColorComponentPixels: number, meanSaturation: number, pictureFraction: number, textLineCount: number, significantColor: boolean, significantPicture: boolean, pictureGateMargin: number, tonalMidtoneGateMargin: number, strongBimodalityGateMargin: number, confidentTextBimodalityMargin: number, confidentTextModeDistanceMargin: number, confidentTextMidtoneMargin: number, denseTextLineMargin: number, denseTextBimodalityMargin: number, denseTextModeDistanceMargin: number, denseTextMidtoneMargin: number, outsideTonalFraction: number, outsideTonalLargestComponentFraction: number, outsideTonalLargestComponentWidthFraction: number, outsideTonalLargestComponentHeightFraction: number, coherentOutsideTonalRegion: boolean, destructiveModeTonalVeto: boolean, protectedTextBlockCount: number, protectedTextBlockPictureOverlapPixels: number, protectedTextBlockPictureOverlapFraction: number, mixedOwnershipIndependentPictureEvidence: boolean, mixedOwnershipVeto: boolean, sourceDpi: number, analysisDpi: number, calibratedSourceStrokeWidthPx: number, calibratedSourceXHeightPx: number, softEdgeToInkRatio: number, bilevelFidelityVeto: boolean, };

export type OutputModeRecommendationReason = "blank" | "color-chroma" | "text-with-pictures" | "continuous-tone" | "bimodal-text" | "uncertain-tonal";

export type OutputModeRule = "blank" | "color-text-with-pictures" | "color" | "text-with-pictures" | "picture" | "sparse-text" | "continuous-tone" | "confident-text" | "dense-text" | "strong-single-line-text" | "spatial-tone" | "bilevel-fidelity" | "mixed-ownership-veto" | "uncertain-fallback";

export type Page = { inputPath: string, 
/**
 * Fixed-resolution PDF render that owns analysis and Auto-routing.
 * Raster/image callers omit it because input_path is already canonical.
 */
analysisInputPath: string | null, analysisDpi: number | null, 
/**
 * White samples in this extracted one-bit PDF soft mask select the
 * source MRC foreground. It shares input_path's unrotated page grid.
 */
trustedForegroundMaskPath: string | null, 
/**
 * Native-resolution continuous-tone background extracted from the same
 * compact MRC page as trusted_foreground_mask_path.
 */
trustedMrcBackgroundPath: string | null, sourcePageIndex: number, pageMetadataPath: string, 
/**
 * Any serialized dewarp directrices inside `options` are authored in
 * source-rotated page coordinates (before deskew, dewarp, and crop).
 */
options: CleanupOptions, documentPrior: DocumentPrior | null, detailRenderPlan: DetailRenderPlan | null, 
/**
 * The source page's PDF geometry. When present, outputs also report their
 * placement in PDF points for the lossless assembler.
 */
pdfPage: PdfPageGeometry | null, outputs: Array<PageOutput>, };

export type PageAlignment = "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right" | "ink";

export type PageHalf = "full" | "left" | "right";

export type PageOutput = { outputPath: string, metadataPath: string, bilevelOutputPath: string | null, backgroundOutputPath: string | null, foregroundMaskOutputPath: string | null, foregroundAlphaOutputPath: string | null, pictureMaskOutputPath: string | null, tonePreservationAlphaOutputPath: string | null, };

export type PageResultMetadata = { version: number, sourcePageIndex: number, layoutClassification: LayoutClassification, layoutConfidence: number, cutterXPx: number | null, splitSeam: SplitSeamPolyline | null, rotationDegrees: OrthogonalRotation, canvasScope: CanvasScope, excluded: boolean, blankOutputsSkipped: number, outputCount: number, outputs: Array<AnalysisOutputMetadata>, tier1Verdict: LayoutClassification, reconciled: boolean, clusterAgreement: number, splitDiagnostics: SplitDiagnostics, documentPrior: DocumentPrior | null, textAxis: TextAxisHint | null, recommendedOutputMode: OutputMode | null, recommendedOutputModeConfidence: number | null, recommendedOutputModeReason: OutputModeRecommendationReason | null, softAlphaForegroundRecommendation: boolean | null, outputModeDiagnostics: OutputModeDiagnostics | null, };

export type PageStageTimings = { decodeMs?: number, analysisLevelMs?: number, normalizationMs?: number, illuminationPreparationMs?: number, layoutNormalizationMs?: number, calibrationMs?: number, pictureMaskMs?: number, modeRecommendationMs?: number, qualityNormalizationMs?: number, textAxisMs?: number, splitMs?: number, deskewMs?: number, contentMs?: number, rasterizationMs?: number, maskRasterizationMs?: number, binarizationMs?: number, thresholdPreparationMs?: number, thresholdingMs?: number, binaryPostprocessMs?: number, mixedCompositionMs?: number, outputProcessingMs?: number, renderMs?: number, writeMs?: number, };

export type PdfImagePlacement = { xPoints: number, yPoints: number, widthPoints: number, heightPoints: number, };

/**
 * The source page's view box in PDF user space, its display rotation, and the
 * resolution of its raster, which is the grid margins are fitted on.
 */

export type PdfPageGeometry = { xPoints: number, yPoints: number, widthPoints: number, heightPoints: number, rotation: number, sourceDpi: number, };

export type PdfRect = { x: number, y: number, width: number, height: number, };

export type PictureZone = { polygon: NormalizedZonePolygon, layer: PictureZoneLayer, };

export type PictureZoneLayer = "eraser1" | "painter2" | "eraser3";

export type PixelRect = { xPx: number, yPx: number, widthPx: number, heightPx: number, };

/**
 * How far down the margin box this leaf's ink top goes, as a fraction of the
 * box's height. `ink` moves content vertically only — horizontally it is
 * centred exactly like `top-center` — so the anchor carries one axis. The
 * caller owns the measurement and any document-wide clustering behind it;
 * native only places what it is told.
 */

export type PlacementAnchor = { yNormalized: number, };

export type PlacementAnchors = { full: PlacementAnchor | null, left: PlacementAnchor | null, right: PlacementAnchor | null, };

export type PlacementOverrides = { full: PageAlignment | null, left: PageAlignment | null, right: PageAlignment | null, };

/**
 * Floating-point point in pixel-center coordinates; integer pixels are centered at `(x + .5, y + .5)`.
 */

export type Point = { x: number, y: number, };

export type Polygon = { points: Array<Point>, };

/**
 * Where one lossless output lands on the preview's pixel canvas.
 */

export type PreviewPlacement = { canvasWidthPx: number, canvasHeightPx: number, contentWidthPx: number, contentHeightPx: number, offsetXPx: number, offsetYPx: number, margins: AppliedMargins, canvasOverflow: boolean, };

export type Progress = { stage: ProgressStage, 
/**
 * `page-analyzed` carries the distinct analyzed-page count, so its
 * `page_number` can be out of source order. `page-complete` carries the
 * source-order completed prefix for render work and final Analyze results.
 */
completedPages: number, totalPages: number, pageNumber: number | null, outputPaths: Array<string> | null, classification: LayoutClassification | null, confidence: number | null, cutterXPx: number | null, tier1Verdict: LayoutClassification | null, reconciled: boolean | null, clusterAgreement: number | null, documentPrior: DocumentPrior | null, textAxis: TextAxisHint | null, stageTimings: PageStageTimings | null, recommendedOutputMode: OutputMode | null, recommendedOutputModeConfidence: number | null, recommendedOutputModeReason: OutputModeRecommendationReason | null, softAlphaForegroundRecommendation: boolean | null, outputModeDiagnostics: OutputModeDiagnostics | null, };

export type ProgressEnvelope = { version: number, type: string, progress: Progress, };

export type ProgressStage = "started" | "page-analyzed" | "page-complete" | "page-input-required" | "page-input-released" | "completed";

export type RenderMode = "preview" | "final";

export type ResolvedTextToneDiagnostics = { full: TextToneDiagnostics | null, left: TextToneDiagnostics | null, right: TextToneDiagnostics | null, };

export type ResultEnvelope = { version: number, type: string, result: ResultPayload, };

export type ResultPayload = { "status": "success", completedPages: number, totalPages: number, } | { "status": "failure", code: NativeErrorCode, message: string, };

export type SplitDiagnostics = { foldBand: FoldBand, analysisDpi: number, deskewAngleDegrees: number, deskewConfidence: number, cutterSlope: number, leftDeskewAngleDegrees: number, rightDeskewAngleDegrees: number, leftDeskewConfidence: number, rightDeskewConfidence: number, whitespaceX: number, foldX: number, decisionX: number, whitespaceScore: number, bilateralScore: number, leftPageScore: number, rightPageScore: number, leftContentScore: number, rightContentScore: number, leftSurfaceScore: number, rightSurfaceScore: number, leftInkPixels: number, rightInkPixels: number, leftOuterMarginScore: number, rightOuterMarginScore: number, outerMarginScore: number, gutterScore: number, agreementScore: number, foldScore: number, gutterDarknessScore: number, softGutterScore: number, softGutterCoverage: number, softGutterContinuity: number, softGutterMeanDepression: number, sparseGutterScore: number, sparseGutterCoverage: number, sparseGutterContinuity: number, sparseGutterMeanDepression: number, aspectRatio: number, aspectSpreadScore: number, aspectSingleScore: number, independentSpreadCues: number, offcutBoundaryScore: number, offcutEmptyScore: number, offcutPopulatedScore: number, offcutWidthScore: number, offcutNoTextRowsScore: number, alternativeProduct: number, evidenceProduct: number, whitespaceGatePassed: boolean, centralPositionGatePassed: boolean, bilateralGatePassed: boolean, outerMarginGatePassed: boolean, gutterGatePassed: boolean, independentGutterGatePassed: boolean, aspectSupportGatePassed: boolean, evidenceAgreementGatePassed: boolean, outerMarginRecovery: boolean, outerMarginWeakEdge: OuterMarginSide | null, sparseSpreadRecovered: boolean, abstained: boolean, };

/**
 * Optional diagnostic geometry for a non-straight page seam. The existing
 * cutter and page polygons remain the rendering contract; consumers that do
 * not know about this additive field continue to cut at `cutterXPx`.
 */

export type SplitSeamPolyline = { points: Array<Point>, };

export type SpreadBinarizationPlanDecision = "sharedJoint" | "perLeafRouteMismatch" | "perLeafAnchorDrift" | "perLeafRadiusDrift" | "perLeafFaintInkDrift";

export type SpreadBinarizationPlanDiagnostics = { route: BinarizationMode, thresholdAnchor: number, thresholdRadius: number, strokeWidthAnchorPx: number, xHeightAnchorPx: number, documentAnchor: boolean, jointCandidateRoute: BinarizationMode, leftCandidateRoute: BinarizationMode, rightCandidateRoute: BinarizationMode, decision: SpreadBinarizationPlanDecision, };

export type TextAxisHint = { sideways: boolean, confidence: number, };

export type TextToneDiagnostics = { applied: boolean, rule: TextToneRule, textLineCount: number, textInkPixels: number, pictureFraction: number, outsideMidtoneFraction: number, outsideMidtoneLargestComponentFraction: number, outsideMidtoneLargestComponentWidthFraction: number, outsideMidtoneLargestComponentHeightFraction: number, inkAnchor: number | null, blackPoint: number | null, slope: number | null, };

export type TextToneRule = "applied" | "picture-evidence" | "insufficient-text" | "tonal-mass-outside-text" | "already-dark";

/**
 * Unit a warning event's physical extents are measured in. Native placement
 * works on the canvas pixel grid; the lossless path measures the same
 * conditions in PDF points.
 */

export type WarningExtentUnit = "px" | "pt";
