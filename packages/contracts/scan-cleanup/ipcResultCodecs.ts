import { requirePageNumber } from '@contracts/pageNumbers';
import {isRecord} from '@contracts/runtimeGuards';
import {decodeFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    SCAN_CLEANUP_ERROR_CODES,
    SCAN_CLEANUP_SUMMARY_SCHEMA,
} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';
import * as v from 'valibot';
import {
    SCAN_CLEANUP_BINARIZATION_METHODS,
    SCAN_CLEANUP_CANVAS_POLICIES,
    SCAN_CLEANUP_CONTENT_TRIM_SIDES,
    SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS,
    SCAN_CLEANUP_OUTPUT_HALVES,
    SCAN_CLEANUP_OUTPUT_MODES,
    SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS,
    SCAN_CLEANUP_PAGE_ROTATIONS,
    SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS,
    SCAN_CLEANUP_TEXT_TONE_RULES,SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA,
} from '@contracts/scan-cleanup/domain';
import {
    NATIVE_SCAN_CLEANUP_OUTPUT_MODE_DIAGNOSTICS_SCHEMA,
    NATIVE_SCAN_CLEANUP_SPLIT_DIAGNOSTICS_SCHEMA,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA,
    SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA,
    SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/decodeScanCleanupPlacementAnchorSummary';
import {isNativeScanCleanupOpticalPlacementValid} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@contracts/scan-cleanup/inputLimits';
import {
    parseJobId,
    parseRequestId,
} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
export {projectScanCleanupDetectionStateForRenderer} from '@contracts/scan-cleanup/projectScanCleanupDetectionStateForRenderer';

export const SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_SCHEMA = v.message(v.strictObject({
    summary: SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA,
    placementAnchors: SCAN_CLEANUP_PLACEMENT_ANCHORS_SCHEMA,
}), 'invalid scan-cleanup placement anchor calibration');

const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const finite = v.pipe(v.number(), v.finite());
const safeFiniteSchema = v.pipe(finite, v.check(number => Math.abs(number) <= Number.MAX_SAFE_INTEGER));
const nonNegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const unitSchema = v.pipe(finite, v.minValue(0), v.maxValue(1));
const previewRectSchema = v.message(v.pipe(v.object({
    xPx: safeFiniteSchema,
    yPx: safeFiniteSchema,
    widthPx: safeFiniteSchema,
    heightPx: safeFiniteSchema,
}), v.check(rect => rect.widthPx >= 0 && rect.heightPx >= 0)), 'invalid scan-cleanup preview rectangle');
const previewSourceRegionSchema = v.message(v.pipe(v.object({
    xPx: safeFiniteSchema,
    yPx: safeFiniteSchema,
    widthPx: safeFiniteSchema,
    heightPx: safeFiniteSchema,
}), v.check(rect => rect.widthPx >= 0 && rect.heightPx >= 0)), 'invalid scan-cleanup preview source region');
const previewAffineSchema = v.nullable(v.object({matrix: v.pipe(v.array(v.pipe(v.array(safeFiniteSchema), v.length(3))), v.length(3))}));
const contentSideConfidenceSchema = v.object({
    left: v.message(unitSchema, 'invalid scan-cleanup preview content left confidence'),
    top: v.message(unitSchema, 'invalid scan-cleanup preview content top confidence'),
    right: v.message(unitSchema, 'invalid scan-cleanup preview content right confidence'),
    bottom: v.message(unitSchema, 'invalid scan-cleanup preview content bottom confidence'),
});
const contentBlockEvidenceSchema = v.object({
    bounds: previewRectSchema,
    pictureMaskOverlapPixels: nonNegativeIntegerSchema,
    headingEvidence: v.boolean(),
    grayscaleEvidence: v.boolean(),
    textEvidence: v.exactOptional(v.boolean()),
});
const contentDiagnosticsSchema = v.object({
    sideConfidence: contentSideConfidenceSchema,
    textMask: v.object({
        analysisWidthPx: positiveIntegerSchema,
        analysisHeightPx: positiveIntegerSchema,
        inkPixels: nonNegativeIntegerSchema,
        lineCount: nonNegativeIntegerSchema,
        bounds: v.exactOptional(previewRectSchema),
    }),
    shippedBounds: v.exactOptional(previewRectSchema),
    acceptedTrims: v.exactOptional(v.array(v.object({
        side: v.picklist(SCAN_CLEANUP_CONTENT_TRIM_SIDES),
        iteration: positiveIntegerSchema,
        score: unitSchema,
        threshold: unitSchema,
        contentDistanceSum: v.pipe(finite, v.minValue(0)),
        garbageDistanceSum: v.pipe(finite, v.minValue(0)),
        removedBlocks: v.array(contentBlockEvidenceSchema),
    }))),
    protectedBlocks: v.exactOptional(v.array(contentBlockEvidenceSchema)),
});
const spreadBinarizationPlanSchema = v.pipe(v.object({
    route: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    thresholdAnchor: v.pipe(nonNegativeIntegerSchema, v.maxValue(255)),
    thresholdRadius: positiveIntegerSchema,
    strokeWidthAnchorPx: v.pipe(finite, v.minValue(Number.MIN_VALUE)),
    xHeightAnchorPx: v.pipe(finite, v.minValue(Number.MIN_VALUE)),
    documentAnchor: v.boolean(),
    jointCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    leftCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    rightCandidateRoute: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    decision: v.picklist(SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS),
}));
const binarizationDiagnosticsSchema = v.object({
    route: v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS),
    robustContrast: finite,
    illuminationDeviation: finite,
    edgeDensity: finite,
    estimatedStrokeWidthPx: finite,
    darkBorderCoverage: finite,
    otsuAdaptiveAgreement: finite,
    spreadPlan: v.exactOptional(spreadBinarizationPlanSchema),
});
const textToneDiagnosticsSchema = v.message(v.pipe(v.object({
    applied: v.boolean(),
    rule: v.picklist(SCAN_CLEANUP_TEXT_TONE_RULES),
    textLineCount: nonNegativeIntegerSchema,
    textInkPixels: nonNegativeIntegerSchema,
    pictureFraction: unitSchema,
    outsideMidtoneFraction: unitSchema,
    outsideMidtoneLargestComponentFraction: unitSchema,
    outsideMidtoneLargestComponentWidthFraction: unitSchema,
    outsideMidtoneLargestComponentHeightFraction: unitSchema,
    inkAnchor: v.nullable(v.pipe(nonNegativeIntegerSchema, v.maxValue(255))),
    blackPoint: v.nullable(v.pipe(finite, v.minValue(0))),
    slope: v.nullable(v.pipe(finite, v.minValue(Number.MIN_VALUE))),
}), v.check(value => value.applied === (value.rule === 'applied')
    && value.applied === (value.blackPoint !== null && value.slope !== null))),
'invalid scan-cleanup preview text-tone diagnostics');
const splitSeamSchema = v.pipe(v.object({points: v.pipe(v.array(v.object({
    x: v.number(),
    y: v.number(),
})), v.minLength(2))}), v.rawCheck(({
    dataset, addIssue,
}) => {
    const seam = dataset.value;
    if (!isRecord(seam) || !Array.isArray(seam.points)) return;
    seam.points.forEach((point, index) => {
        if (!isRecord(point)) return;
        for (const axis of [
            'x',
            'y',
        ] as const) {
            const coordinate = point[axis];
            if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)
                || Math.abs(coordinate) > Number.MAX_SAFE_INTEGER) {
                addIssue({message: `invalid scan-cleanup preview split seam point ${String(index)} ${axis}`});
                return;
            }
        }
    });
}));
const previewOutputDiagnosticsSchema = v.object({
    half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
    contentDiagnostics: v.exactOptional(contentDiagnosticsSchema),
    textToneDiagnostics: v.exactOptional(textToneDiagnosticsSchema),
});
const previewPageMetadataInputSchema = v.object({
    layoutClassification: v.message(v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS), 'invalid scan-cleanup preview page metadata'),
    layoutConfidence: v.exactOptional(v.message(unitSchema, 'invalid scan-cleanup preview layout confidence')),
    cutterXPx: v.message(v.nullable(safeFiniteSchema), 'invalid scan-cleanup preview page metadata'),
    splitSeam: v.exactOptional(splitSeamSchema),
    splitAbstained: v.exactOptional(v.boolean()),
    rotationDegrees: v.message(v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS), 'invalid scan-cleanup preview page metadata'),
    canvasScope: v.picklist([
        'page',
        'document',
    ]),
    excluded: v.boolean(),
    blankOutputsSkipped: nonNegativeIntegerSchema,
    tier1Verdict: v.exactOptional(v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS)),
    reconciled: v.exactOptional(v.boolean()),
    clusterAgreement: v.exactOptional(v.pipe(finite, v.minValue(-1), v.maxValue(1))),
    detectedSkewDegrees: v.exactOptional(finite),
    skewConfidence: v.exactOptional(v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview page skew confidence')),
    manualSkew: v.exactOptional(v.boolean()),
    binarizationMode: v.exactOptional(v.nullable(v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS))),
    binarizationDiagnostics: v.exactOptional(v.nullable(binarizationDiagnosticsSchema)),
    textToneDiagnostics: v.exactOptional(textToneDiagnosticsSchema),
    despeckleFallback: v.exactOptional(v.boolean()),
    autoDewarpAttempted: v.exactOptional(v.boolean()),
    dewarpApplied: v.exactOptional(v.boolean()),
    dewarpConfidence: v.exactOptional(v.nullable(unitSchema)),
    outputDiagnostics: v.exactOptional(v.pipe(v.array(previewOutputDiagnosticsSchema), v.maxLength(2))),
    recommendedOutputMode: v.exactOptional(v.picklist(SCAN_CLEANUP_OUTPUT_MODES)),
    recommendedOutputModeConfidence: v.exactOptional(unitSchema),
    recommendedOutputModeReason: v.exactOptional(v.picklist(SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS)),
    softAlphaForegroundRecommendation: v.exactOptional(v.boolean()),
});
export const SCAN_CLEANUP_PREVIEW_PAGE_METADATA_SCHEMA = v.pipe(
    previewPageMetadataInputSchema,
    v.transform(source => ({
        layoutClassification: source.layoutClassification,
        layoutConfidence: source.layoutConfidence ?? 0,
        cutterXPx: source.cutterXPx,
        ...(source.splitSeam === undefined ? {} : {splitSeam: source.splitSeam}),
        ...(source.splitAbstained === undefined ? {} : {splitAbstained: source.splitAbstained}),
        rotationDegrees: source.rotationDegrees,
        canvasScope: source.canvasScope,
        excluded: source.excluded,
        blankOutputsSkipped: source.blankOutputsSkipped,
        tier1Verdict: source.tier1Verdict ?? source.layoutClassification,
        reconciled: source.reconciled === true,
        clusterAgreement: source.clusterAgreement ?? 0,
        ...(source.detectedSkewDegrees === undefined ? {} : {detectedSkewDegrees: source.detectedSkewDegrees}),
        ...(source.skewConfidence === undefined ? {} : {skewConfidence: source.skewConfidence}),
        ...(source.manualSkew === undefined ? {} : {manualSkew: source.manualSkew}),
        ...(source.binarizationMode === undefined ? {} : {binarizationMode: source.binarizationMode}),
        ...(source.binarizationDiagnostics === undefined ? {} : {binarizationDiagnostics: source.binarizationDiagnostics}),
        ...(source.textToneDiagnostics === undefined ? {} : {textToneDiagnostics: source.textToneDiagnostics}),
        ...(source.despeckleFallback === undefined ? {} : {despeckleFallback: source.despeckleFallback}),
        ...(source.autoDewarpAttempted === undefined ? {} : {autoDewarpAttempted: source.autoDewarpAttempted}),
        ...(source.dewarpApplied === undefined ? {} : {dewarpApplied: source.dewarpApplied}),
        ...(source.dewarpConfidence === undefined ? {} : {dewarpConfidence: source.dewarpConfidence}),
        ...(source.outputDiagnostics === undefined ? {} : {outputDiagnostics: source.outputDiagnostics}),
        ...(source.recommendedOutputMode === undefined ? {} : {recommendedOutputMode: source.recommendedOutputMode}),
        ...(source.recommendedOutputModeConfidence === undefined ? {} : {recommendedOutputModeConfidence: source.recommendedOutputModeConfidence}),
        ...(source.recommendedOutputModeReason === undefined ? {} : {recommendedOutputModeReason: source.recommendedOutputModeReason}),
        ...(source.softAlphaForegroundRecommendation === undefined ? {} : {softAlphaForegroundRecommendation: source.softAlphaForegroundRecommendation}),
    })),
);

const appliedMarginsSchema = v.pipe(v.unknown(),
    v.check(isRecord, 'invalid scan-cleanup preview metadata'),
    v.object({
        leftPx: v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview applied left margin'),
        topPx: v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview applied top margin'),
        rightPx: v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview applied right margin'),
        bottomPx: v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview applied bottom margin'),
    }));
const maybePositiveInteger = v.exactOptional(v.nullable(positiveIntegerSchema));
const maybePositiveFinite = v.exactOptional(v.nullable(v.pipe(finite, v.minValue(Number.MIN_VALUE))));
const previewMetadataInputSchema = v.object({
    half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
    layoutClassification: v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS),
    layoutConfidence: v.exactOptional(v.message(unitSchema, 'invalid scan-cleanup preview layout confidence')),
    detectedSkewDegrees: v.exactOptional(finite),
    skewConfidence: v.exactOptional(v.message(v.pipe(finite, v.minValue(0)), 'invalid scan-cleanup preview skew confidence')),
    skewApplied: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    manualSkew: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    sourceRegion: previewSourceRegionSchema,
    contentBox: v.nullable(previewRectSchema),
    cropRect: v.exactOptional(previewRectSchema),
    contentDiagnostics: v.exactOptional(contentDiagnosticsSchema),
    appliedMargins: appliedMarginsSchema,
    outputWidthPx: positiveIntegerSchema,
    outputHeightPx: positiveIntegerSchema,
    intrinsicRasterWidthPx: v.exactOptional(positiveIntegerSchema),
    intrinsicRasterHeightPx: v.exactOptional(positiveIntegerSchema),
    renderRegion: v.exactOptional(previewRectSchema),
    canvasWidthPx: positiveIntegerSchema,
    canvasHeightPx: positiveIntegerSchema,
    canvasPolicy: v.exactOptional(v.picklist(SCAN_CLEANUP_CANVAS_POLICIES)),
    canvasOverflow: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    matchedCanvasTargetWidthPx: maybePositiveInteger,
    matchedCanvasTargetHeightPx: maybePositiveInteger,
    matchedCanvasTargetWidthPoints: maybePositiveFinite,
    matchedCanvasTargetHeightPoints: maybePositiveFinite,
    matchedCanvasContentWidthPx: maybePositiveInteger,
    matchedCanvasContentHeightPx: maybePositiveInteger,
    matchedCanvasOpticalPlacement: v.exactOptional(v.boolean()),
    matchedCanvasOpticalContentLeftPx: v.exactOptional(v.nullable(v.pipe(finite, v.minValue(0)))),
    matchedCanvasOpticalContentRightPx: v.exactOptional(v.nullable(v.pipe(finite, v.minValue(0)))),
    matchedCanvasIntrinsicOverflowLeftPx: v.exactOptional(nonNegativeIntegerSchema),
    matchedCanvasIntrinsicOverflowRightPx: v.exactOptional(nonNegativeIntegerSchema),
    matchedCanvasIntrinsicOverflowTopPx: v.exactOptional(nonNegativeIntegerSchema),
    foldClipLeftPx: v.exactOptional(nonNegativeIntegerSchema),
    foldClipRightPx: v.exactOptional(nonNegativeIntegerSchema),
    placementOffsetXPx: nonNegativeIntegerSchema,
    placementOffsetYPx: nonNegativeIntegerSchema,
    forwardTransform: previewAffineSchema,
    cutterXPx: v.nullable(safeFiniteSchema),
    splitSeam: v.exactOptional(splitSeamSchema),
    splitAbstained: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    inputWidthPx: positiveIntegerSchema,
    inputHeightPx: positiveIntegerSchema,
    rotationDegrees: v.message(v.picklist(SCAN_CLEANUP_PAGE_ROTATIONS), 'invalid scan-cleanup preview metadata'),
    canvasScope: v.picklist([
        'page',
        'document',
    ]),
    resamplePasses: nonNegativeIntegerSchema,
    illuminationNormalized: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    textToneDiagnostics: v.exactOptional(textToneDiagnosticsSchema),
    outputMode: v.exactOptional(v.picklist(SCAN_CLEANUP_OUTPUT_MODES)),
    binarizationMode: v.exactOptional(v.nullable(v.picklist(SCAN_CLEANUP_BINARIZATION_METHODS))),
    binarizationDiagnostics: v.exactOptional(v.nullable(binarizationDiagnosticsSchema)),
    despeckleFallback: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    dewarpConfidence: v.exactOptional(v.nullable(unitSchema)),
    dewarpApplied: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    sourceDpi: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE))),
    renderDpi: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE))),
    requestedRenderDpi: v.exactOptional(v.pipe(finite, v.minValue(Number.MIN_VALUE))),
    rasterScaleLimited: v.exactOptional(v.message(v.boolean(), 'invalid scan-cleanup preview metadata')),
    warnings: v.array(v.unknown()),
});

export const SCAN_CLEANUP_PREVIEW_METADATA_SCHEMA = v.pipe(previewMetadataInputSchema, v.transform(source => ({
    half: source.half,
    layoutClassification: source.layoutClassification,
    layoutConfidence: source.layoutConfidence ?? 0,
    ...(source.detectedSkewDegrees === undefined ? {} : {detectedSkewDegrees: source.detectedSkewDegrees}),
    ...(source.skewConfidence === undefined ? {} : {skewConfidence: source.skewConfidence}),
    ...(source.skewApplied === undefined ? {} : {skewApplied: source.skewApplied}),
    ...(source.manualSkew === undefined ? {} : {manualSkew: source.manualSkew}),
    sourceRegion: source.sourceRegion,
    contentBox: source.contentBox,
    cropRect: source.cropRect ?? {
        xPx: 0,
        yPx: 0,
        widthPx: source.outputWidthPx,
        heightPx: source.outputHeightPx,
    },
    ...(source.contentDiagnostics === undefined ? {} : {contentDiagnostics: source.contentDiagnostics}),
    appliedMargins: source.appliedMargins,
    outputWidthPx: source.outputWidthPx,
    outputHeightPx: source.outputHeightPx,
    ...(source.intrinsicRasterWidthPx === undefined ? {} : {intrinsicRasterWidthPx: source.intrinsicRasterWidthPx}),
    ...(source.intrinsicRasterHeightPx === undefined ? {} : {intrinsicRasterHeightPx: source.intrinsicRasterHeightPx}),
    ...(source.renderRegion === undefined ? {} : {renderRegion: source.renderRegion}),
    canvasWidthPx: source.canvasWidthPx,
    canvasHeightPx: source.canvasHeightPx,
    canvasPolicy: source.canvasPolicy ?? 'intrinsic',
    canvasOverflow: source.canvasOverflow === true,
    matchedCanvasTargetWidthPx: source.matchedCanvasTargetWidthPx ?? null,
    matchedCanvasTargetHeightPx: source.matchedCanvasTargetHeightPx ?? null,
    matchedCanvasTargetWidthPoints: source.matchedCanvasTargetWidthPoints ?? null,
    matchedCanvasTargetHeightPoints: source.matchedCanvasTargetHeightPoints ?? null,
    matchedCanvasContentWidthPx: source.matchedCanvasContentWidthPx ?? null,
    matchedCanvasContentHeightPx: source.matchedCanvasContentHeightPx ?? null,
    ...(source.matchedCanvasOpticalPlacement === undefined ? {} : {matchedCanvasOpticalPlacement: source.matchedCanvasOpticalPlacement}),
    matchedCanvasOpticalContentLeftPx: source.matchedCanvasOpticalContentLeftPx ?? null,
    matchedCanvasOpticalContentRightPx: source.matchedCanvasOpticalContentRightPx ?? null,
    ...(source.matchedCanvasIntrinsicOverflowLeftPx === undefined ? {} : {matchedCanvasIntrinsicOverflowLeftPx: source.matchedCanvasIntrinsicOverflowLeftPx}),
    ...(source.matchedCanvasIntrinsicOverflowRightPx === undefined ? {} : {matchedCanvasIntrinsicOverflowRightPx: source.matchedCanvasIntrinsicOverflowRightPx}),
    ...(source.matchedCanvasIntrinsicOverflowTopPx === undefined ? {} : {matchedCanvasIntrinsicOverflowTopPx: source.matchedCanvasIntrinsicOverflowTopPx}),
    ...(source.foldClipLeftPx === undefined ? {} : {foldClipLeftPx: source.foldClipLeftPx}),
    ...(source.foldClipRightPx === undefined ? {} : {foldClipRightPx: source.foldClipRightPx}),
    placementOffsetXPx: source.placementOffsetXPx,
    placementOffsetYPx: source.placementOffsetYPx,
    forwardTransform: source.forwardTransform,
    cutterXPx: source.cutterXPx,
    ...(source.splitSeam === undefined ? {} : {splitSeam: source.splitSeam}),
    ...(source.splitAbstained === undefined ? {} : {splitAbstained: source.splitAbstained}),
    inputWidthPx: source.inputWidthPx,
    inputHeightPx: source.inputHeightPx,
    rotationDegrees: source.rotationDegrees,
    canvasScope: source.canvasScope,
    resamplePasses: source.resamplePasses,
    ...(source.illuminationNormalized === undefined ? {} : {illuminationNormalized: source.illuminationNormalized}),
    ...(source.textToneDiagnostics === undefined ? {} : {textToneDiagnostics: source.textToneDiagnostics}),
    ...(source.outputMode === undefined ? {} : {outputMode: source.outputMode}),
    ...(source.binarizationMode === undefined ? {} : {binarizationMode: source.binarizationMode}),
    ...(source.binarizationDiagnostics === undefined ? {} : {binarizationDiagnostics: source.binarizationDiagnostics}),
    ...(source.despeckleFallback === undefined ? {} : {despeckleFallback: source.despeckleFallback}),
    ...(source.dewarpConfidence === undefined ? {} : {dewarpConfidence: source.dewarpConfidence}),
    ...(source.dewarpApplied === undefined ? {} : {dewarpApplied: source.dewarpApplied}),
    ...(source.sourceDpi === undefined ? {} : {sourceDpi: source.sourceDpi}),
    ...(source.renderDpi === undefined ? {} : {renderDpi: source.renderDpi}),
    ...(source.requestedRenderDpi === undefined ? {} : {requestedRenderDpi: source.requestedRenderDpi}),
    rasterScaleLimited: source.rasterScaleLimited === true,
    warnings: source.warnings.filter((item): item is string => typeof item === 'string'),
})), v.check(metadata => {
    const contentWidth = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeight = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const recordedOverflowLeft = metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0;
    const recordedOverflowRight = metadata.matchedCanvasIntrinsicOverflowRightPx ?? 0;
    const recordedOverflowTop = metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0;
    const foldClip = (metadata.foldClipLeftPx ?? 0) + (metadata.foldClipRightPx ?? 0);
    const offsetX = metadata.placementOffsetXPx - recordedOverflowLeft;
    const offsetY = metadata.placementOffsetYPx - recordedOverflowTop;
    return metadata.canvasHeightPx >= contentHeight
        && recordedOverflowLeft <= contentWidth
        && foldClip < contentWidth
        && recordedOverflowTop <= contentHeight
        && Math.max(0, -offsetX) === recordedOverflowLeft
        && Math.max(0, offsetX + contentWidth - metadata.canvasWidthPx) === recordedOverflowRight
        && Math.max(0, -offsetY) === recordedOverflowTop
        && offsetX < metadata.canvasWidthPx
        && offsetX + contentWidth > 0
        && offsetY < metadata.canvasHeightPx
        && offsetY + contentHeight > 0
        && offsetY + contentHeight <= metadata.canvasHeightPx
        && isNativeScanCleanupOpticalPlacementValid(metadata);
}, 'invalid scan-cleanup preview intrinsic/canvas placement'),
v.check(metadata => metadata.renderRegion === undefined || (metadata.renderRegion.widthPx > 0
    && metadata.renderRegion.heightPx > 0
    && metadata.renderRegion.xPx >= 0
    && metadata.renderRegion.yPx >= 0
    && metadata.renderRegion.xPx + metadata.renderRegion.widthPx <= metadata.outputWidthPx
    && metadata.renderRegion.yPx + metadata.renderRegion.heightPx <= metadata.outputHeightPx),
'invalid scan-cleanup preview render region'));

const requestIdSchema = v.pipe(v.string(), v.check(value => parseRequestId(value) !== null),
    v.transform(value => parseRequestId(value)!));
const pageNumberSchema = v.pipe(positiveIntegerSchema, v.transform(value => requirePageNumber(value)));
const previewBytesSchema = v.message(v.pipe(v.custom<Uint8Array>(data => data instanceof Uint8Array), v.check(data => data.byteLength > 0
    && data.byteLength <= PREVIEW_MAX_IMAGE_BYTES)), 'invalid scan-cleanup preview output image');
const previewOutputSchema = v.object({
    imageData: previewBytesSchema,
    metadata: SCAN_CLEANUP_PREVIEW_METADATA_SCHEMA,
});
const previewResultInputSchema = v.pipe(v.object({
    canceled: v.optional(v.undefined()),
    requestId: v.exactOptional(requestIdSchema),
    pageNumber: pageNumberSchema,
    totalPages: positiveIntegerSchema,
    rawImageData: v.exactOptional(previewBytesSchema),
    rawWidthPx: positiveIntegerSchema,
    rawHeightPx: positiveIntegerSchema,
    outputs: v.pipe(v.array(previewOutputSchema), v.maxLength(2)),
    pageMetadata: SCAN_CLEANUP_PREVIEW_PAGE_METADATA_SCHEMA,
}), v.check(result => result.pageNumber <= result.totalPages,
    'invalid scan-cleanup preview page number'),
v.check(result => (result.rawImageData?.byteLength ?? 0)
    + result.outputs.reduce((bytes, output) => bytes + output.imageData.byteLength, 0)
    <= PREVIEW_MAX_TOTAL_BYTES, 'invalid scan-cleanup preview total image bytes'));
export const SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA = v.union([
    v.object({canceled: v.literal(true)}),
    previewResultInputSchema,
]);
export type TScanCleanupPreviewWireResult = v.InferOutput<typeof SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA>;

export function decodeScanCleanupPreviewResult(value: unknown) {
    // The literal cancel flag selects the payload shape and its boundary error.
    return isRecord(value) && value.canceled === true
        ? v.parse(v.object({canceled: v.literal(true)}), value, {abortEarly: true})
        : v.parse(previewResultInputSchema, value, {abortEarly: true});
}

const boundedOwnerText = (label: string) => v.message(v.pipe(v.string(),
    v.check(value => value.trim().length > 0 && !value.includes('\0')
        && new TextEncoder().encode(value).byteLength <= SCAN_CLEANUP_INPUT_MAX_ID_BYTES)),
`invalid scan-cleanup ${label}`);
export const SCAN_CLEANUP_RAW_PREVIEW_EVENT_SCHEMA = v.pipe(v.object({
    ownerId: boundedOwnerText('raw preview owner id'),
    documentRevision: boundedOwnerText('raw preview document revision'),
    requestId: requestIdSchema,
    pageNumber: pageNumberSchema,
    totalPages: positiveIntegerSchema,
    rawImageData: previewBytesSchema,
    rawWidthPx: positiveIntegerSchema,
    rawHeightPx: positiveIntegerSchema,
}), v.check(event => event.pageNumber <= event.totalPages,
    'invalid scan-cleanup raw preview page number'));

const jobIdSchema = v.pipe(v.string(), v.check(value => parseJobId(value) !== null),
    v.transform(value => parseJobId(value)!));
const epochMsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0),
    v.transform(value => parseEpochMs(value)!));
const errorCodeSchema = v.picklist(SCAN_CLEANUP_ERROR_CODES);
const scratchShortfallSchema = v.object({
    availableBytes: v.nullable(v.pipe(finite, v.minValue(0))),
    requiredBytes: v.nullable(v.pipe(finite, v.minValue(0))),
});
const failureReceiptSchema = v.message(v.custom<NonNullable<ReturnType<typeof decodeFailureReceipt>>>(
    value => decodeFailureReceipt(value) !== null,
), 'invalid failure receipt');
const startSuccessSchema = v.object({
    started: v.literal(true),
    jobId: jobIdSchema,
    outputPdfPath: v.string(),
});
const detectionStartSuccessSchema = v.object({
    started: v.literal(true),
    jobId: jobIdSchema,
});
const failedResultFields = {
    started: v.literal(false),
    jobId: jobIdSchema,
    error: v.string(),
    errorCode: v.message(errorCodeSchema, 'failed scan-cleanup start requires a typed error'),
    scratchShortfall: v.optional(scratchShortfallSchema),
};
export const SCAN_CLEANUP_START_RESULT_SCHEMA = v.variant('started', [
    startSuccessSchema,
    v.object(failedResultFields),
]);
export const SCAN_CLEANUP_DETECTION_START_RESULT_SCHEMA = v.variant('started', [
    detectionStartSuccessSchema,
    v.object(failedResultFields),
]);

const jobStateBase = {
    jobId: jobIdSchema,
    progress: SCAN_CLEANUP_PROGRESS_SCHEMA,
    updatedAtMs: epochMsSchema,
};
const completedJobStateSchema = v.object({
    ...jobStateBase,
    status: v.literal('completed'),
    outputPdfPath: v.message(v.string(), 'completed scan-cleanup state requires outputPdfPath and partial flag'),
    summary: SCAN_CLEANUP_SUMMARY_SCHEMA,
    partial: v.message(v.boolean(), 'completed scan-cleanup state requires outputPdfPath and partial flag'),
});
const failedJobStateSchema = v.object({
    ...jobStateBase,
    status: v.literal('failed'),
    error: v.string(),
    errorCode: v.message(errorCodeSchema, 'failed scan-cleanup state requires a typed error'),
    scratchShortfall: v.optional(scratchShortfallSchema),
    failure: v.optional(failureReceiptSchema),
});
const activeJobStateSchema = v.object({
    ...jobStateBase,
    status: v.picklist([
        'queued',
        'running',
        'canceling',
        'handoff',
        'committing',
        'canceled',
    ]),
});
export const SCAN_CLEANUP_JOB_STATE_SCHEMA = v.nullable(v.variant('status', [
    activeJobStateSchema,
    completedJobStateSchema,
    failedJobStateSchema,
]));

const textAxisSchema = v.strictObject({
    sideways: v.boolean(),
    confidence: unitSchema,
});
const splitDiagnosticsSchema = v.message(
    NATIVE_SCAN_CLEANUP_SPLIT_DIAGNOSTICS_SCHEMA,
    'invalid scan-cleanup split diagnostics',
);
const detectionResultInputSchema = v.pipe(v.object({
    pageNumber: pageNumberSchema,
    revision: v.exactOptional(positiveIntegerSchema),
    classification: v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS),
    confidence: unitSchema,
    cutterXPx: v.nullable(safeFiniteSchema),
    tier1Verdict: v.exactOptional(v.picklist(SCAN_CLEANUP_LAYOUT_CLASSIFICATIONS)),
    reconciled: v.exactOptional(v.boolean()),
    clusterAgreement: v.exactOptional(v.pipe(finite, v.minValue(-1), v.maxValue(1))),
    documentPrior: v.exactOptional(v.nullable(SCAN_CLEANUP_DOCUMENT_PRIOR_SCHEMA)),
    textAxis: v.exactOptional(textAxisSchema),
    recommendedOutputMode: v.exactOptional(v.picklist(SCAN_CLEANUP_OUTPUT_MODES)),
    recommendedOutputModeConfidence: v.exactOptional(unitSchema),
    recommendedOutputModeReason: v.exactOptional(v.picklist(SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS)),
    softAlphaForegroundRecommendation: v.exactOptional(v.boolean()),
    outputModeDiagnostics: v.exactOptional(NATIVE_SCAN_CLEANUP_OUTPUT_MODE_DIAGNOSTICS_SCHEMA),
    sourcePageMetadata: v.exactOptional(SCAN_CLEANUP_SOURCE_PAGE_METADATA_SCHEMA),
    pagePlanEvidence: v.exactOptional(SCAN_CLEANUP_PAGE_PLAN_EVIDENCE_SCHEMA),
    splitDiagnostics: v.exactOptional(splitDiagnosticsSchema),
}), v.transform(result => ({
    pageNumber: result.pageNumber,
    ...(result.revision === undefined ? {} : {revision: result.revision}),
    classification: result.classification,
    confidence: result.confidence,
    cutterXPx: result.cutterXPx,
    tier1Verdict: result.tier1Verdict ?? result.classification,
    reconciled: result.reconciled === true,
    clusterAgreement: result.clusterAgreement ?? 0,
    documentPrior: result.documentPrior ?? null,
    ...(result.textAxis === undefined ? {} : {textAxis: result.textAxis}),
    ...(result.recommendedOutputMode === undefined ? {} : {recommendedOutputMode: result.recommendedOutputMode}),
    ...(result.recommendedOutputModeConfidence === undefined ? {} : {recommendedOutputModeConfidence: result.recommendedOutputModeConfidence}),
    ...(result.recommendedOutputModeReason === undefined ? {} : {recommendedOutputModeReason: result.recommendedOutputModeReason}),
    ...(result.softAlphaForegroundRecommendation === undefined ? {} : {softAlphaForegroundRecommendation: result.softAlphaForegroundRecommendation}),
    ...(result.outputModeDiagnostics === undefined ? {} : {outputModeDiagnostics: result.outputModeDiagnostics}),
    ...(result.sourcePageMetadata === undefined ? {} : {sourcePageMetadata: result.sourcePageMetadata}),
    ...(result.pagePlanEvidence === undefined ? {} : {pagePlanEvidence: result.pagePlanEvidence}),
    ...(result.splitDiagnostics === undefined ? {} : {splitDiagnostics: result.splitDiagnostics}),
})), v.check(result => result.sourcePageMetadata === undefined
    || result.sourcePageMetadata.pageNumber === result.pageNumber,
'invalid scan-cleanup detection source page metadata'),
v.check(result => result.pagePlanEvidence === undefined
        || result.pagePlanEvidence.pageNumber === result.pageNumber,
'invalid scan-cleanup page-plan evidence'));
export const SCAN_CLEANUP_DETECTION_RESULT_SCHEMA = v.message(detectionResultInputSchema, 'invalid scan-cleanup detection result');
const detectionJobBaseSchema = v.object({
    jobId: jobIdSchema,
    documentCanvasSignature: v.exactOptional(v.string()),
    progress: SCAN_CLEANUP_PROGRESS_SCHEMA,
    resultCount: v.exactOptional(nonNegativeIntegerSchema),
    /** Final pages recommended as blank, counted over every result, not the window. */
    blankPageCount: v.exactOptional(nonNegativeIntegerSchema),
    detectionResultStoreId: v.exactOptional(boundedOwnerText('detection result store id')),
    placementAnchorSummary: v.exactOptional(SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SCHEMA),
    results: v.pipe(v.array(SCAN_CLEANUP_DETECTION_RESULT_SCHEMA),
        v.maxLength(SCAN_CLEANUP_STREAMING_BATCH_PAGES, 'invalid scan-cleanup detection job state')),
    updatedAtMs: epochMsSchema,
});
const activeDetectionJobSchema = v.object({
    ...detectionJobBaseSchema.entries,
    status: v.picklist([
        'queued',
        'running',
        'canceling',
        'completed',
        'canceled',
    ]),
});
const failedDetectionJobSchema = v.object({
    ...detectionJobBaseSchema.entries,
    status: v.literal('failed'),
    error: v.string(),
    errorCode: v.message(errorCodeSchema, 'failed scan-cleanup detection state requires a typed error'),
    scratchShortfall: v.optional(scratchShortfallSchema),
});
export const SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA = v.pipe(
    v.nullable(v.variant('status', [
        activeDetectionJobSchema,
        failedDetectionJobSchema,
    ])),
    v.check(state => state === null || (() => {
        const count = state.resultCount ?? state.results.length;
        return count >= state.results.length
            && (state.blankPageCount ?? 0) <= count
            && count <= state.progress.completedUnits
            && count <= state.progress.totalUnits
            && (state.status !== 'completed' || count === state.progress.completedUnits);
    })(), 'invalid scan-cleanup detection result count'),
);
