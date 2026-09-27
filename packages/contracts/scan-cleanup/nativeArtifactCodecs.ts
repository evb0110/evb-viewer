import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';
import {
    SCAN_CLEANUP_BINARIZATION_METHODS,
    SCAN_CLEANUP_CANVAS_POLICIES,
    SCAN_CLEANUP_CANVAS_SCOPES,
    SCAN_CLEANUP_CONTENT_TRIM_SIDES,
    SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS,
    SCAN_CLEANUP_OUTPUT_HALVES,
    SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS,
    SCAN_CLEANUP_OUTPUT_MODES,
    SCAN_CLEANUP_PAGE_ROTATIONS,
    SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS,
    SCAN_CLEANUP_TEXT_TONE_RULES,
    SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA,
} from '@contracts/scan-cleanup/domain';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
} from '@contracts/scan-cleanup/ipc';
import type {IScanCleanupAppliedMargins} from '@contracts/scan-cleanup/geometry';
import {
    NATIVE_SCAN_CLEANUP_OUTPUT_MODE_DIAGNOSTICS_SCHEMA,
    NATIVE_SCAN_CLEANUP_SPLIT_DIAGNOSTICS_SCHEMA,
    SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
    SCAN_CLEANUP_WARNING_EVENTS_SCHEMA,
    type INativeScanCleanupAnalysisOutputV3,
    type INativeScanCleanupDewarpModelV3,
    type INativeScanCleanupOutputMetadataV3,
    type INativeScanCleanupPageMetadataV3,
    type INativeScanCleanupReusableGeometryV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';

const MAX_PAGE_OUTPUTS = 2;
const MAX_WARNINGS = 256;
const MAX_WARNING_LENGTH = 4_096;
const MAX_GEOMETRY_POINTS = 65_536;
const MAX_DIAGNOSTIC_ITEMS = 4_096;
const MAX_PAGE_METADATA_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_OUTPUT_METADATA_JSON_LENGTH = 16 * 1024 * 1024;

export class InvalidScanCleanupNativeArtifactError extends Error {
    // Stable typed-error discriminator consumed across process boundaries.
    // fallow-ignore-next-line unused-class-member
    readonly code = 'native-failure' as const;
    readonly artifact: 'page metadata' | 'output metadata';

    constructor(artifact: InvalidScanCleanupNativeArtifactError['artifact'], detail: string) {
        super(`Invalid evb-scan-cleanup ${artifact}: ${detail}`);
        this.name = 'InvalidScanCleanupNativeArtifactError';
        this.artifact = artifact;
    }
}

type TArtifact = InvalidScanCleanupNativeArtifactError['artifact'];
const finite = v.pipe(v.number(), v.finite());
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveInteger = v.pipe(nonNegativeInteger, v.minValue(1));
const unit = v.pipe(finite, v.minValue(0), v.maxValue(1));
const nonNegativeFinite = v.pipe(finite, v.minValue(0));
const positiveFinite = v.pipe(finite, v.minValue(Number.MIN_VALUE));
const isOrthogonalRotation = v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS);
const isLayout = v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS);

const pointSchema = v.looseObject({
    x: finite,
    y: finite,
});
const pixelRectSchema = v.pipe(v.looseObject({
    xPx: finite,
    yPx: finite,
    widthPx: finite,
    heightPx: finite,
}), v.check(rect => rect.widthPx >= 0 && rect.heightPx >= 0,
    'invalid rectangle dimensions'));
const pdfRectSchema = v.pipe(v.looseObject({
    x: finite,
    y: finite,
    width: finite,
    height: finite,
}), v.check(rect => rect.width > 0 && rect.height > 0, 'cropRect must have a positive extent'));
const marginsSchema = v.looseObject({
    leftPx: v.pipe(finite, v.minValue(0)),
    topPx: v.pipe(finite, v.minValue(0)),
    rightPx: v.pipe(finite, v.minValue(0)),
    bottomPx: v.pipe(finite, v.minValue(0)),
});
const pointListSchema = (minimum: number) => v.pipe(v.array(pointSchema),
    v.minLength(minimum), v.maxLength(MAX_GEOMETRY_POINTS));
const affineRowSchema = v.tuple([
    finite,
    finite,
    finite,
]);
const affineSchema = v.looseObject({matrix: v.message(v.tuple([
    affineRowSchema,
    affineRowSchema,
    affineRowSchema,
]), 'forwardTransform.matrix must be 3x3')});
const textToneSchema = v.pipe(v.looseObject({
    applied: v.boolean(),
    rule: v.picklist(SCAN_CLEANUP_TEXT_TONE_RULES),
    textLineCount: nonNegativeInteger,
    textInkPixels: nonNegativeInteger,
    pictureFraction: unit,
    outsideMidtoneFraction: unit,
    outsideMidtoneLargestComponentFraction: unit,
    outsideMidtoneLargestComponentWidthFraction: unit,
    outsideMidtoneLargestComponentHeightFraction: unit,
    inkAnchor: v.nullable(v.pipe(nonNegativeInteger, v.maxValue(255))),
    blackPoint: v.nullable(finite),
    slope: v.nullable(finite),
}), v.check(value => value.applied === (value.rule === 'applied')
    && value.applied === (value.blackPoint != null && value.slope != null), 'applied/rule mismatch'));
const contentBlockSchema = v.looseObject({
    bounds: pixelRectSchema,
    pictureMaskOverlapPixels: nonNegativeInteger,
    headingEvidence: v.boolean(),
    grayscaleEvidence: v.boolean(),
    textEvidence: v.optional(v.boolean()),
});
const contentDiagnosticRectSchema = v.looseObject({
    xPx: finite,
    yPx: finite,
    widthPx: finite,
    heightPx: finite,
});
const contentDiagnosticsSchema = v.looseObject({
    sideConfidence: v.looseObject({
        left: unit,
        top: unit,
        right: unit,
        bottom: unit,
    }),
    textMask: v.looseObject({
        analysisWidthPx: positiveInteger,
        analysisHeightPx: positiveInteger,
        inkPixels: nonNegativeInteger,
        lineCount: nonNegativeInteger,
        bounds: v.optional(contentDiagnosticRectSchema),
    }),
    shippedBounds: v.optional(contentDiagnosticRectSchema),
    acceptedTrims: v.optional(v.pipe(v.array(v.looseObject({
        side: v.picklist(SCAN_CLEANUP_CONTENT_TRIM_SIDES),
        iteration: nonNegativeInteger,
        score: unit,
        threshold: unit,
        contentDistanceSum: finite,
        garbageDistanceSum: finite,
        removedBlocks: v.pipe(v.array(contentBlockSchema), v.maxLength(MAX_DIAGNOSTIC_ITEMS)),
    })), v.maxLength(MAX_DIAGNOSTIC_ITEMS))),
    protectedBlocks: v.optional(v.pipe(v.array(contentBlockSchema), v.maxLength(MAX_DIAGNOSTIC_ITEMS))),
});
const spreadBinarizationPlanSchema = v.looseObject({
    route: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    thresholdAnchor: v.message(v.pipe(nonNegativeInteger, v.maxValue(255)), 'thresholdAnchor must be <= 255'),
    thresholdRadius: positiveInteger,
    strokeWidthAnchorPx: positiveFinite,
    xHeightAnchorPx: positiveFinite,
    documentAnchor: v.boolean(),
    jointCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    leftCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    rightCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    decision: v.picklist(SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS),
});
const binarizationDiagnosticsSchema = v.looseObject({
    route: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    robustContrast: finite,
    illuminationDeviation: finite,
    edgeDensity: finite,
    estimatedStrokeWidthPx: finite,
    darkBorderCoverage: finite,
    otsuAdaptiveAgreement: finite,
    spreadPlan: v.optional(spreadBinarizationPlanSchema),
});
const inkConsistencySchema = v.looseObject({
    priorSampleCount: nonNegativeInteger,
    priorSurvivalMedian: v.pipe(finite, v.minValue(0), v.maxValue(1)),
    survivalBefore: v.pipe(finite, v.minValue(0), v.maxValue(1)),
    survivalAfter: v.message(v.pipe(finite, v.minValue(0), v.maxValue(1)), 'inkConsistencyDiagnostics.survivalAfter must be between 0 and 1'),
    addedInkPixels: v.message(nonNegativeInteger, 'inkConsistencyDiagnostics.addedInkPixels must be a safe integer >= 0'),
    applied: v.boolean(),
});
const splitSeamSchema = v.looseObject({points: pointListSchema(2)});
const polygonSchema = v.looseObject({points: pointListSchema(3)});
const pdfImagePlacementSchema = v.pipe(v.looseObject({
    xPoints: finite,
    yPoints: finite,
    widthPoints: positiveFinite,
    heightPoints: positiveFinite,
}), v.check(value => value.xPoints >= 0 && value.yPoints >= 0,
    'pdfImagePlacement must have a positive extent and non-negative origin'));
const contentTransformSchema = v.looseObject({
    scale: positiveFinite,
    translateX: finite,
    translateY: finite,
});
const previewPlacementSchema = v.looseObject({
    canvasWidthPx: positiveInteger,
    canvasHeightPx: positiveInteger,
    contentWidthPx: positiveInteger,
    contentHeightPx: positiveInteger,
    offsetXPx: nonNegativeInteger,
    offsetYPx: nonNegativeInteger,
    margins: marginsSchema,
    canvasOverflow: v.boolean(),
});
const losslessPlacementSchema = v.looseObject({
    cropRect: pdfRectSchema,
    contentTransform: v.optional(contentTransformSchema),
    contentScaled: v.boolean(),
    warningEvents: v.optional(SCAN_CLEANUP_WARNING_EVENTS_SCHEMA),
    preview: v.optional(previewPlacementSchema),
});
const analysisOutputSchema = v.looseObject({
    half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
    sourceRegion: pixelRectSchema,
    contentBox: v.optional(v.nullable(pixelRectSchema)),
    contentDiagnostics: v.optional(contentDiagnosticsSchema),
    textToneDiagnostics: v.optional(textToneSchema),
    cropRect: pixelRectSchema,
    appliedMargins: v.optional(marginsSchema),
    inputWidthPx: positiveInteger,
    inputHeightPx: positiveInteger,
    pdfPlacement: v.optional(losslessPlacementSchema),
});
const splitDiagnosticsArtifactSchema = v.pipe(v.unknown(), v.rawCheck(({
    dataset, addIssue,
}) => {
    const value = dataset.value;
    if (!isRecord(value)) return;
    const foldBand = value.foldBand;
    if (!isRecord(foldBand)) {
        addIssue({message: 'splitDiagnostics.foldBand must be an object'});
        return;
    }
    const allowedKeys = foldBand.status === 'measured'
        ? [
            'status',
            'leftXPx',
            'rightXPx',
        ]
        : [
            'status',
            'reason',
            'nominalHalfWidthPx',
        ];
    const unsupported = Object.keys(foldBand).find(key => !allowedKeys.includes(key));
    if (unsupported !== undefined) {
        addIssue({message: `splitDiagnostics.foldBand.${unsupported} is not supported`});
        return;
    }
    if (foldBand.status === 'unmeasured' && typeof foldBand.reason !== 'string') {
        addIssue({message: 'splitDiagnostics.foldBand.reason has an unknown discriminant'});
    }
}), NATIVE_SCAN_CLEANUP_SPLIT_DIAGNOSTICS_SCHEMA);
const pageMetadataShapeSchema = v.looseObject({
    version: v.optional(v.message(v.literal(SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION), 'unsupported protocol version')),
    sourcePageIndex: v.optional(nonNegativeInteger),
    layoutClassification: v.message(isLayout, 'layoutClassification has an unknown discriminant'),
    layoutConfidence: v.optional(v.message(finite, 'layoutConfidence must be finite')),
    cutterXPx: v.nullable(finite),
    splitSeam: v.optional(v.nullable(splitSeamSchema)),
    splitAbstained: v.optional(v.boolean()),
    rotationDegrees: isOrthogonalRotation,
    canvasScope: v.optional(v.picklist(SCAN_CLEANUP_CANVAS_SCOPES)),
    excluded: v.boolean(),
    blankOutputsSkipped: nonNegativeInteger,
    outputCount: v.message(v.pipe(nonNegativeInteger, v.maxValue(MAX_PAGE_OUTPUTS)), 'outputCount exceeds the protocol limit'),
    outputs: v.optional(v.pipe(v.array(analysisOutputSchema), v.maxLength(MAX_PAGE_OUTPUTS))),
    tier1Verdict: v.optional(isLayout),
    reconciled: v.optional(v.boolean()),
    clusterAgreement: v.optional(v.pipe(finite, v.minValue(-1), v.maxValue(1))),
    splitDiagnostics: v.optional(splitDiagnosticsArtifactSchema),
    documentPrior: v.optional(v.nullable(SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA)),
    textAxis: v.optional(v.nullable(v.looseObject({
        sideways: v.boolean(),
        confidence: unit,
    }))),
    recommendedOutputMode: v.optional(v.nullable(v.picklist(SCAN_CLEANUP_OUTPUT_MODES))),
    recommendedOutputModeConfidence: v.optional(v.nullable(unit)),
    recommendedOutputModeReason: v.optional(v.nullable(v.picklist(SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS))),
    softAlphaForegroundRecommendation: v.optional(v.nullable(v.boolean())),
    outputModeDiagnostics: v.optional(v.nullable(NATIVE_SCAN_CLEANUP_OUTPUT_MODE_DIAGNOSTICS_SCHEMA)),
});
const pageMetadataTypedSchema = v.pipe(pageMetadataShapeSchema,
    v.transform(value => value as INativeScanCleanupPageMetadataV3));
export type INativeScanCleanupPageArtifactMetadataV3 = v.InferOutput<typeof pageMetadataTypedSchema>;

const warningSchema = v.pipe(v.string(), v.maxLength(MAX_WARNING_LENGTH));
const dewarpModelSchema = v.looseObject({
    topCurve: pointListSchema(2),
    bottomCurve: pointListSchema(2),
    depth: finite,
});
const dewarpMappingSchema = v.pipe(v.looseObject({
    columns: v.pipe(positiveInteger, v.minValue(2)),
    rows: v.pipe(positiveInteger, v.minValue(2)),
    outputOrigin: pointSchema,
    outputWidth: positiveInteger,
    outputHeight: positiveInteger,
    outputToSource: v.pipe(v.array(pointSchema), v.maxLength(MAX_GEOMETRY_POINTS)),
    sourceToOutput: v.pipe(v.array(pointSchema), v.maxLength(MAX_GEOMETRY_POINTS)),
}), v.check(mapping => {
    const pointCount = mapping.columns * mapping.rows;
    return Number.isSafeInteger(pointCount) && pointCount <= MAX_GEOMETRY_POINTS;
}, 'dewarpMapping grid exceeds the protocol limit'),
v.check(mapping => mapping.outputToSource.length === mapping.columns * mapping.rows,
    'dewarpMapping.outputToSource length does not match its grid'),
v.check(mapping => mapping.sourceToOutput.length === mapping.columns * mapping.rows,
    'dewarpMapping.sourceToOutput length does not match its grid'));
const outputMetadataShapeSchema = v.looseObject({
    version: v.optional(v.message(v.literal(SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION), 'unsupported protocol version')),
    sourcePageIndex: v.optional(nonNegativeInteger),
    half: v.optional(v.picklist(SCAN_CLEANUP_OUTPUT_HALVES)),
    detectedSkewDegrees: v.optional(finite),
    skewConfidence: v.optional(nonNegativeFinite),
    skewApplied: v.boolean(),
    manualSkew: v.optional(v.boolean()),
    layoutClassification: v.message(isLayout, 'layoutClassification has an unknown discriminant'),
    layoutConfidence: v.optional(unit),
    cutterXPx: v.optional(v.nullable(finite)),
    splitGeometry: v.optional(v.pipe(v.array(polygonSchema), v.maxLength(MAX_PAGE_OUTPUTS))),
    splitSeam: v.optional(splitSeamSchema),
    sourceRegion: v.optional(pixelRectSchema),
    contentBox: v.optional(v.nullable(pixelRectSchema)),
    cropRect: v.optional(pixelRectSchema),
    contentDiagnostics: v.optional(contentDiagnosticsSchema),
    appliedMargins: v.optional(marginsSchema),
    softMarginsPx: v.optional(v.tuple([
        nonNegativeInteger,
        nonNegativeInteger,
        nonNegativeInteger,
        nonNegativeInteger,
    ])),
    uniformCanvas: v.optional(v.boolean()),
    canvasPolicy: v.optional(v.picklist(SCAN_CLEANUP_CANVAS_POLICIES)),
    canvasOverflow: v.optional(v.boolean()),
    matchedCanvasTargetWidthPx: v.optional(v.nullable(positiveInteger)),
    matchedCanvasTargetHeightPx: v.optional(v.nullable(positiveInteger)),
    matchedCanvasTargetWidthPoints: v.optional(v.nullable(positiveFinite)),
    matchedCanvasTargetHeightPoints: v.optional(v.nullable(positiveFinite)),
    matchedCanvasContentWidthPx: v.optional(v.nullable(positiveInteger)),
    matchedCanvasContentHeightPx: v.optional(v.nullable(positiveInteger)),
    matchedCanvasOpticalPlacement: v.optional(v.boolean()),
    matchedCanvasOpticalContentLeftPx: v.optional(v.nullable(nonNegativeFinite)),
    matchedCanvasOpticalContentRightPx: v.optional(v.nullable(nonNegativeFinite)),
    matchedCanvasIntrinsicOverflowLeftPx: v.optional(nonNegativeInteger),
    matchedCanvasIntrinsicOverflowRightPx: v.optional(nonNegativeInteger),
    matchedCanvasIntrinsicOverflowTopPx: v.optional(nonNegativeInteger),
    foldClipLeftPx: v.optional(v.message(nonNegativeInteger, 'foldClipLeftPx must be a safe integer >= 0')),
    foldClipRightPx: v.optional(v.message(nonNegativeInteger, 'foldClipRightPx must be a safe integer >= 0')),
    pdfImagePlacement: v.optional(pdfImagePlacementSchema),
    sourcePdfPlacement: v.optional(losslessPlacementSchema),
    outputMode: v.optional(v.picklist(SCAN_CLEANUP_OUTPUT_MODES)),
    bilevelWritten: v.optional(v.boolean()),
    layeredWritten: v.optional(v.boolean()),
    layeredForegroundKind: v.optional(v.picklist([
        'stencil',
        'soft-alpha',
        'source-mrc',
    ])),
    layeredBackgroundDpi: v.optional(positiveFinite),
    layeredForegroundDpi: v.optional(positiveFinite),
    trustedMrcBackgroundPreserved: v.optional(v.boolean()),
    trustedSelectionApplied: v.optional(v.boolean()),
    illuminationNormalized: v.optional(v.boolean()),
    textToneDiagnostics: v.optional(textToneSchema),
    binarizationMode: v.optional(v.nullable(v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS))),
    binarizationDiagnostics: v.optional(v.nullable(binarizationDiagnosticsSchema)),
    inkConsistencyDiagnostics: v.optional(inkConsistencySchema),
    despeckleFallback: v.optional(v.boolean()),
    forwardTransform: v.optional(v.nullable(affineSchema)),
    inverseTransform: v.optional(v.nullable(affineSchema)),
    dewarpModel: v.optional(v.nullable(dewarpModelSchema)),
    dewarpMapping: v.optional(v.nullable(dewarpMappingSchema)),
    dewarpConfidence: v.optional(v.nullable(unit)),
    inputWidthPx: v.optional(positiveInteger),
    inputHeightPx: v.optional(positiveInteger),
    outputWidthPx: positiveInteger,
    outputHeightPx: positiveInteger,
    intrinsicRasterWidthPx: v.optional(positiveInteger),
    intrinsicRasterHeightPx: v.optional(positiveInteger),
    renderRegion: v.optional(pixelRectSchema),
    canvasWidthPx: positiveInteger,
    canvasHeightPx: positiveInteger,
    placementOffsetXPx: nonNegativeInteger,
    placementOffsetYPx: nonNegativeInteger,
    rotationDegrees: v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS),
    canvasScope: v.optional(v.picklist(SCAN_CLEANUP_CANVAS_SCOPES)),
    resamplePasses: v.optional(nonNegativeInteger),
    sourceDpi: v.optional(positiveFinite),
    renderDpi: v.optional(positiveFinite),
    requestedRenderDpi: v.optional(positiveFinite),
    rasterScaleLimited: v.optional(v.boolean()),
    warnings: v.optional(v.pipe(v.array(warningSchema), v.maxLength(MAX_WARNINGS))),
    warningEvents: SCAN_CLEANUP_WARNING_EVENTS_SCHEMA,
});
const outputMetadataTypedSchema = v.pipe(outputMetadataShapeSchema,
    v.transform(value => value as INativeScanCleanupOutputMetadataV3));
export type TNativeScanCleanupOutputArtifactMetadataV3 = v.InferOutput<typeof outputMetadataTypedSchema>;

const previewAnalysisOutputSchema = v.looseObject({
    ...analysisOutputSchema.entries,
    sourceRegion: v.optional(pixelRectSchema),
    contentBox: v.optional(v.nullable(pixelRectSchema)),
    appliedMargins: v.optional(marginsSchema),
});
const previewPageShapeSchema = v.pipe(v.looseObject({
    ...pageMetadataShapeSchema.entries,
    canvasScope: v.picklist(SCAN_CLEANUP_CANVAS_SCOPES),
    outputs: v.optional(v.pipe(v.array(previewAnalysisOutputSchema), v.maxLength(MAX_PAGE_OUTPUTS))),
    tier1Verdict: isLayout,
    reconciled: v.boolean(),
    clusterAgreement: v.pipe(finite, v.minValue(-1), v.maxValue(1)),
}), v.check(value => value.outputs === undefined || value.outputs.every(output => output.appliedMargins !== undefined),
    'appliedMargins is required for preview'),
v.check(value => value.outputs === undefined || value.outputs.every(output => output.sourceRegion !== undefined),
    'sourceRegion is required for preview'),
v.check(value => value.outputs === undefined || value.outputs.every(output => output.contentBox !== undefined),
    'contentBox is required for preview'));
const previewPageTypedSchema = v.pipe(previewPageShapeSchema, v.transform(value => value as IScanCleanupPreviewPageMetadata & Omit<INativeScanCleanupPageMetadataV3, 'outputs'> & {outputs?: Array<INativeScanCleanupAnalysisOutputV3 & {
    appliedMargins: IScanCleanupAppliedMargins;
    contentBox: IScanCleanupPreviewMetadata['contentBox'];
}>;}));
export type TNativeScanCleanupPreviewPageArtifactMetadataV3 = v.InferOutput<typeof previewPageTypedSchema>;
const previewOutputShapeSchema = v.looseObject({
    ...outputMetadataShapeSchema.entries,
    half: v.optional(v.picklist(SCAN_CLEANUP_OUTPUT_HALVES)),
    layoutConfidence: v.optional(unit),
    sourceRegion: v.optional(pixelRectSchema),
    contentBox: v.optional(v.nullable(pixelRectSchema)),
    appliedMargins: v.optional(marginsSchema),
    cutterXPx: v.optional(v.nullable(finite)),
    inputWidthPx: v.optional(positiveInteger),
    inputHeightPx: v.optional(positiveInteger),
    canvasScope: v.optional(v.picklist(SCAN_CLEANUP_CANVAS_SCOPES)),
    resamplePasses: v.optional(nonNegativeInteger),
    warnings: v.optional(v.pipe(v.array(warningSchema), v.maxLength(MAX_WARNINGS))),
});
const previewOutputRequiredFieldsSchema = v.pipe(previewOutputShapeSchema,
    v.check(output => output.half !== undefined, 'half is required for preview'),
    v.check(output => output.layoutConfidence !== undefined, 'layoutConfidence is required for preview'),
    v.check(output => output.sourceRegion !== undefined, 'sourceRegion is required for preview'),
    v.check(output => output.contentBox !== undefined, 'contentBox is required for preview'),
    v.check(output => output.appliedMargins !== undefined, 'appliedMargins is required for preview'),
    v.check(output => output.cutterXPx !== undefined, 'cutterXPx is required for preview'),
    v.check(output => output.inputWidthPx !== undefined, 'inputWidthPx is required for preview'),
    v.check(output => output.inputHeightPx !== undefined, 'inputHeightPx is required for preview'),
    v.check(output => output.canvasScope !== undefined, 'canvasScope is required for preview'),
    v.check(output => output.resamplePasses !== undefined, 'resamplePasses is required for preview'),
    v.check(output => output.warnings !== undefined, 'warnings is required for preview'));
const previewOutputTypedSchema = v.pipe(previewOutputRequiredFieldsSchema,
    v.transform(value => value as IScanCleanupPreviewMetadata & INativeScanCleanupOutputMetadataV3 & INativeScanCleanupReusableGeometryV3
        & {dewarpModel?: INativeScanCleanupDewarpModelV3 | null}));
export type TNativeScanCleanupPreviewOutputArtifactMetadataV3 = v.InferOutput<typeof previewOutputTypedSchema>;

/** Checks that optical content stays inside the requested horizontal margins. */
export function isNativeScanCleanupOpticalPlacementValid(metadata: {
    matchedCanvasOpticalPlacement?: boolean | undefined;
    matchedCanvasOpticalContentLeftPx?: number | null | undefined;
    matchedCanvasOpticalContentRightPx?: number | null | undefined;
    matchedCanvasContentWidthPx?: number | null | undefined;
    intrinsicRasterWidthPx?: number | undefined;
    appliedMargins?: IScanCleanupAppliedMargins | undefined;
    outputWidthPx: number;
    placementOffsetXPx: number;
    matchedCanvasIntrinsicOverflowLeftPx?: number | undefined;
    canvasWidthPx: number;
}): boolean {
    if (metadata.matchedCanvasOpticalPlacement !== true) return true;
    const opticalLeft = metadata.matchedCanvasOpticalContentLeftPx;
    const opticalRight = metadata.matchedCanvasOpticalContentRightPx;
    const contentWidth = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const intrinsicWidth = metadata.intrinsicRasterWidthPx ?? metadata.outputWidthPx;
    const margins = metadata.appliedMargins;
    if (opticalLeft == null || opticalRight == null || margins === undefined
        || !Number.isFinite(opticalLeft) || !Number.isFinite(opticalRight)
        || !Number.isFinite(contentWidth) || !Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0 || contentWidth <= 0
        || !Number.isFinite(metadata.placementOffsetXPx) || !Number.isFinite(metadata.canvasWidthPx)
        || !Number.isFinite(metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0)
        || !Number.isFinite(margins.leftPx) || !Number.isFinite(margins.rightPx) || opticalLeft >= opticalRight) return false;
    const offset = metadata.placementOffsetXPx - (metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0);
    const scale = contentWidth / intrinsicWidth;
    return offset + opticalLeft * scale >= margins.leftPx
        && offset + opticalRight * scale <= metadata.canvasWidthPx - margins.rightPx;
}

function fail(artifact: TArtifact, detail: string): never {
    throw new InvalidScanCleanupNativeArtifactError(artifact, detail);
}

function artifactError(issues: ReadonlyArray<v.BaseIssue<unknown>>): string {
    const issue = issues[0];
    if (issue === undefined) return 'invalid artifact';
    const path = issue.path?.map(item => String(item.key)).join('.');
    return path ? `${path} ${issue.message}` : issue.message;
}

function parseArtifact<TOutput>(schema: v.GenericSchema<unknown, TOutput>, value: unknown, artifact: TArtifact): TOutput {
    const result = v.safeParse(schema, value, {abortEarly: true});
    return result.success ? result.output : fail(artifact, artifactError(result.issues));
}

function parseArtifactJson(text: string, artifact: TArtifact, maximumLength: number): unknown {
    if (text.length > maximumLength) return fail(artifact, 'JSON exceeds the artifact size limit');
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return fail(artifact, 'JSON is malformed');
    }
}

export function decodeNativeScanCleanupPageMetadata(value: unknown): INativeScanCleanupPageArtifactMetadataV3 {
    const artifact = 'page metadata';
    const source = isRecord(value) && value.canvasScope === undefined ? {
        ...value,
        canvasScope: 'page',
    } : value;
    parseArtifact(pageMetadataTypedSchema, source, artifact);
    return source as INativeScanCleanupPageArtifactMetadataV3;
}

export function decodeNativeScanCleanupPageMetadataJson(text: string) {
    return decodeNativeScanCleanupPageMetadata(parseArtifactJson(text, 'page metadata', MAX_PAGE_METADATA_JSON_LENGTH));
}

export function decodeNativeScanCleanupPreviewPageMetadataJson(text: string): TNativeScanCleanupPreviewPageArtifactMetadataV3 {
    const metadata = decodeNativeScanCleanupPageMetadataJson(text);
    const preview = {
        ...metadata,
        tier1Verdict: metadata.tier1Verdict ?? metadata.layoutClassification,
        reconciled: metadata.reconciled === true,
        clusterAgreement: metadata.clusterAgreement ?? 0,
    };
    parseArtifact(previewPageTypedSchema, preview, 'page metadata');
    return preview as TNativeScanCleanupPreviewPageArtifactMetadataV3;
}

function hasLegacyWarningEventFields(value: unknown): boolean {
    return Array.isArray(value)
        && value.some(item => isRecord(item) && ('appliedDpi' in item || 'requestedDpi' in item));
}

function validateIntrinsicPlacement(metadata: INativeScanCleanupOutputMetadataV3): boolean {
    const width = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const height = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const overflowLeft = metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0;
    const overflowRight = metadata.matchedCanvasIntrinsicOverflowRightPx ?? 0;
    const overflowTop = metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0;
    const foldClip = (metadata.foldClipLeftPx ?? 0) + (metadata.foldClipRightPx ?? 0);
    const offsetX = metadata.placementOffsetXPx - overflowLeft;
    const offsetY = metadata.placementOffsetYPx - overflowTop;
    return overflowLeft <= width && foldClip < width && overflowTop <= height
        && Math.max(0, -offsetX) === overflowLeft
        && Math.max(0, offsetX + width - metadata.canvasWidthPx) === overflowRight
        && Math.max(0, -offsetY) === overflowTop
        && offsetX < metadata.canvasWidthPx && offsetX + width > 0
        && offsetY < metadata.canvasHeightPx && offsetY + height > 0
        && offsetY + height <= metadata.canvasHeightPx
        && isNativeScanCleanupOpticalPlacementValid(metadata);
}

const outputMetadataWithPlacementSchema = v.pipe(outputMetadataTypedSchema,
    v.check(validateIntrinsicPlacement, 'intrinsic content placement exceeds its canvas'));

export function decodeNativeScanCleanupOutputMetadata(value: unknown): TNativeScanCleanupOutputArtifactMetadataV3 {
    const artifact = 'output metadata';
    const defaults = isRecord(value) && (
        value.placementOffsetXPx === undefined || value.placementOffsetYPx === undefined
        || value.forwardTransform === undefined || value.rotationDegrees === undefined
    ) ? {
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            forwardTransform: null,
            rotationDegrees: 0,
            ...value,
        } : value;
    const decoded = parseArtifact(outputMetadataWithPlacementSchema, defaults, artifact);
    const events = decoded.warningEvents;
    const source = defaults as Record<string, unknown>;
    return hasLegacyWarningEventFields(source.warningEvents)
        ? {
            ...source,
            warningEvents: events,
        } as TNativeScanCleanupOutputArtifactMetadataV3
        : source as TNativeScanCleanupOutputArtifactMetadataV3;
}

export function decodeNativeScanCleanupOutputMetadataJson(text: string) {
    return decodeNativeScanCleanupOutputMetadata(parseArtifactJson(text, 'output metadata', MAX_OUTPUT_METADATA_JSON_LENGTH));
}

export function decodeNativeScanCleanupPreviewOutputMetadataJson(text: string): TNativeScanCleanupPreviewOutputArtifactMetadataV3 {
    const metadata = decodeNativeScanCleanupOutputMetadataJson(text);
    parseArtifact(previewOutputTypedSchema, metadata, 'output metadata');
    return metadata as TNativeScanCleanupPreviewOutputArtifactMetadataV3;
}
