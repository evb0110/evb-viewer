import {isRecord} from '@contracts/runtimeGuards';
import { requirePageNumber } from '@contracts/pageNumbers';
import {decodeFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    decodeScanCleanupScratchShortfall,
    SCAN_CLEANUP_ERROR_CODES,
    SCAN_CLEANUP_SUMMARY_SCHEMA,
} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
    TScanCleanupCanvasPolicy,
    TScanCleanupContentTrimSide,
} from '@contracts/scan-cleanup/ipc';
import type {
    TScanCleanupBinarizationMethod,
    TScanCleanupOutputHalf,
    TScanCleanupPageRotation,
} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_BINARIZATION_METHODS,
    SCAN_CLEANUP_CANVAS_POLICIES,
    SCAN_CLEANUP_CONTENT_TRIM_SIDES,
    SCAN_CLEANUP_OUTPUT_HALVES,
    SCAN_CLEANUP_PAGE_ROTATIONS,
    SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS,
    SCAN_CLEANUP_TEXT_TONE_RULES,
} from '@contracts/scan-cleanup/domain';
import type {
    TNativeScanCleanupSpreadBinarizationPlanDecisionV3,
    TNativeScanCleanupTextToneRuleV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    decodeFiniteNumber,
    decodeScanCleanupPagePlanEvidence,
    decodeScanCleanupPlacementAnchors,
    decodeSourcePageMetadata,
    isLayoutClassification,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {decodeDocumentPrior} from '@contracts/scan-cleanup/decodeDocumentPrior';
import {decodeScanCleanupPlacementAnchorSummary} from '@contracts/scan-cleanup/decodeScanCleanupPlacementAnchorSummary';
import {isNativeScanCleanupOpticalPlacementValid} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    isScanCleanupOutputMode,
    isScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/outputModeGuards';
import {decodeSplitDiagnostics} from '@contracts/scan-cleanup/decodeSplitDiagnostics';
import {
    decodeBoundedScanCleanupString,
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@contracts/scan-cleanup/inputLimits';
import {
    parseJobId,
    parseRequestId,
} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
export {projectScanCleanupDetectionStateForRenderer} from '@contracts/scan-cleanup/projectScanCleanupDetectionStateForRenderer';

export function decodeScanCleanupPlacementAnchorCalibration(
    value: unknown,
): IScanCleanupPlacementAnchorCalibration {
    if (
        !isRecord(value)
        || Object.keys(value).some(key => ![
            'summary',
            'placementAnchors',
        ].includes(key))
    ) {
        throw new Error('invalid scan-cleanup placement anchor calibration');
    }
    return {
        summary: decodeScanCleanupPlacementAnchorSummary(value.summary),
        placementAnchors: decodeScanCleanupPlacementAnchors(
            value.placementAnchors,
            'placement anchor calibration result',
        ),
    };
}

const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
function isPreviewHalf(value: unknown): value is TScanCleanupOutputHalf {
    return SCAN_CLEANUP_OUTPUT_HALVES.some(half => half === value);
}

function isPreviewCanvasPolicy(value: unknown): value is TScanCleanupCanvasPolicy {
    return SCAN_CLEANUP_CANVAS_POLICIES.some(policy => policy === value);
}

function isPreviewBinarizationRoute(value: unknown): value is TScanCleanupBinarizationMethod {
    return SCAN_CLEANUP_BINARIZATION_METHODS.some(route => route === value);
}

function isPreviewTextToneRule(value: unknown): value is TNativeScanCleanupTextToneRuleV3 {
    return SCAN_CLEANUP_TEXT_TONE_RULES.some(rule => rule === value);
}

function isPreviewTrimSide(value: unknown): value is TScanCleanupContentTrimSide {
    return SCAN_CLEANUP_CONTENT_TRIM_SIDES.some(side => side === value);
}

function isPreviewSpreadDecision(
    value: unknown,
): value is TNativeScanCleanupSpreadBinarizationPlanDecisionV3 {
    return SCAN_CLEANUP_SPREAD_BINARIZATION_DECISIONS.some(decision => decision === value);
}

function decodePreviewBytes(value: unknown, label: string) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveFiniteNumber(value: unknown, label: string) {
    const decoded = decodeSafeFiniteNumber(value, label);
    if (decoded <= 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

function decodeNonNegativeFiniteNumber(value: unknown, label: string) {
    const decoded = decodeSafeFiniteNumber(value, label);
    if (decoded < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

function decodeSafeFiniteNumber(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (Math.abs(decoded) > Number.MAX_SAFE_INTEGER) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return decoded;
}

function decodeScanCleanupRotation(value: unknown, label: string): TScanCleanupPageRotation {
    if (!isScanCleanupRotation(value)) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function isScanCleanupRotation(value: unknown): value is TScanCleanupPageRotation {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && SCAN_CLEANUP_PAGE_ROTATIONS.some(rotation => rotation === value);
}

function decodePreviewRect(value: unknown, label: string) {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup preview ${label}`);
    const rect = {
        xPx: decodeSafeFiniteNumber(value.xPx, `${label} x`),
        yPx: decodeSafeFiniteNumber(value.yPx, `${label} y`),
        widthPx: decodeSafeFiniteNumber(value.widthPx, `${label} width`),
        heightPx: decodeSafeFiniteNumber(value.heightPx, `${label} height`),
    };
    if (rect.widthPx < 0 || rect.heightPx < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return rect;
}

function decodePreviewAffine(value: unknown) {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || !Array.isArray(value.matrix) || value.matrix.length !== 3) {
        throw new Error('invalid scan-cleanup preview affine');
    }
    const matrix = value.matrix.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== 3) {
            throw new Error('invalid scan-cleanup preview affine');
        }
        return row.map((item, columnIndex) =>
            decodeSafeFiniteNumber(item, `affine ${rowIndex}:${columnIndex}`));
    });
    return {matrix};
}

function decodeContentDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['contentDiagnostics']> {
    if (!isRecord(value) || !isRecord(value.sideConfidence) || !isRecord(value.textMask)) {
        throw new Error('invalid scan-cleanup preview content diagnostics');
    }
    const textMask = value.textMask;
    const decodeBlockEvidence = (block: unknown, label: string) => {
        if (
            !isRecord(block)
            || typeof block.headingEvidence !== 'boolean'
            || typeof block.grayscaleEvidence !== 'boolean'
            || (block.textEvidence !== undefined && typeof block.textEvidence !== 'boolean')
        ) {
            throw new Error(`invalid scan-cleanup preview ${label}`);
        }
        return {
            bounds: decodePreviewRect(block.bounds, `${label} bounds`),
            pictureMaskOverlapPixels: decodeNonNegativeInteger(
                block.pictureMaskOverlapPixels,
                `${label} picture-mask overlap`,
            ),
            headingEvidence: block.headingEvidence,
            grayscaleEvidence: block.grayscaleEvidence,
            ...(block.textEvidence === undefined ? {} : {textEvidence: block.textEvidence}),
        };
    };
    const acceptedTrims = value.acceptedTrims === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.acceptedTrims)) {
                throw new Error('invalid scan-cleanup preview accepted trims');
            }
            return value.acceptedTrims.map((trim, index) => {
                if (!isRecord(trim) || !isPreviewTrimSide(trim.side) || !Array.isArray(trim.removedBlocks)) {
                    throw new Error(`invalid scan-cleanup preview accepted trim ${index}`);
                }
                return {
                    side: trim.side,
                    iteration: decodePositiveInteger(trim.iteration, `accepted trim ${index} iteration`),
                    score: decodeUnitInterval(trim.score, `accepted trim ${index} score`),
                    threshold: decodeUnitInterval(trim.threshold, `accepted trim ${index} threshold`),
                    contentDistanceSum: decodeNonNegativeFiniteNumber(
                        trim.contentDistanceSum,
                        `accepted trim ${index} content distance`,
                    ),
                    garbageDistanceSum: decodeNonNegativeFiniteNumber(
                        trim.garbageDistanceSum,
                        `accepted trim ${index} garbage distance`,
                    ),
                    removedBlocks: trim.removedBlocks.map((block, blockIndex) => (
                        decodeBlockEvidence(block, `accepted trim ${index} block ${blockIndex}`)
                    )),
                };
            });
        })();
    const protectedBlocks = value.protectedBlocks === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.protectedBlocks)) {
                throw new Error('invalid scan-cleanup preview protected blocks');
            }
            return value.protectedBlocks.map((block, index) => (
                decodeBlockEvidence(block, `protected block ${index}`)
            ));
        })();
    const shippedBounds = value.shippedBounds === undefined
        ? undefined
        : decodePreviewRect(value.shippedBounds, 'shipped content bounds');
    return {
        sideConfidence: decodeContentSideConfidence(value.sideConfidence),
        textMask: {
            analysisWidthPx: decodePositiveInteger(textMask.analysisWidthPx, 'text-mask analysis width'),
            analysisHeightPx: decodePositiveInteger(textMask.analysisHeightPx, 'text-mask analysis height'),
            inkPixels: decodeNonNegativeInteger(textMask.inkPixels, 'text-mask ink pixels'),
            lineCount: decodeNonNegativeInteger(textMask.lineCount, 'text-mask line count'),
            ...(textMask.bounds === undefined
                ? {}
                : {bounds: decodePreviewRect(textMask.bounds, 'text-mask bounds')}),
        },
        ...(shippedBounds === undefined ? {} : {shippedBounds}),
        ...(acceptedTrims === undefined ? {} : {acceptedTrims}),
        ...(protectedBlocks === undefined ? {} : {protectedBlocks}),
    };
}

function decodeContentSideConfidence(value: unknown) {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview content side confidence');
    return {
        left: decodeUnitInterval(value.left, 'content left confidence'),
        top: decodeUnitInterval(value.top, 'content top confidence'),
        right: decodeUnitInterval(value.right, 'content right confidence'),
        bottom: decodeUnitInterval(value.bottom, 'content bottom confidence'),
    };
}

function decodeBinarizationDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['binarizationDiagnostics']> {
    if (!isRecord(value) || !isPreviewBinarizationRoute(value.route)) {
        throw new Error('invalid scan-cleanup preview binarization diagnostics');
    }
    const decodeRoute = (candidate: unknown, label: string): TScanCleanupBinarizationMethod => {
        if (!isPreviewBinarizationRoute(candidate)) {
            throw new Error(`invalid scan-cleanup preview ${label}`);
        }
        return candidate;
    };
    const spreadPlan = value.spreadPlan === undefined
        ? undefined
        : (() => {
            if (!isRecord(value.spreadPlan)) throw new Error('invalid scan-cleanup preview spread plan');
            const plan = value.spreadPlan;
            const thresholdAnchor = decodeNonNegativeInteger(plan.thresholdAnchor, 'spread threshold anchor');
            if (thresholdAnchor > 255) throw new Error('invalid scan-cleanup preview spread threshold anchor');
            if (typeof plan.documentAnchor !== 'boolean') throw new Error('invalid scan-cleanup preview spread document anchor');
            if (!isPreviewSpreadDecision(plan.decision)) {
                throw new Error('invalid scan-cleanup preview spread decision');
            }
            return {
                route: decodeRoute(plan.route, 'spread route'),
                thresholdAnchor,
                thresholdRadius: decodePositiveInteger(plan.thresholdRadius, 'spread threshold radius'),
                strokeWidthAnchorPx: decodePositiveFiniteNumber(plan.strokeWidthAnchorPx, 'spread stroke width anchor'),
                xHeightAnchorPx: decodePositiveFiniteNumber(plan.xHeightAnchorPx, 'spread x-height anchor'),
                documentAnchor: plan.documentAnchor,
                jointCandidateRoute: decodeRoute(plan.jointCandidateRoute, 'spread joint candidate route'),
                leftCandidateRoute: decodeRoute(plan.leftCandidateRoute, 'spread left candidate route'),
                rightCandidateRoute: decodeRoute(plan.rightCandidateRoute, 'spread right candidate route'),
                decision: plan.decision,
            };
        })();
    return {
        route: value.route,
        robustContrast: decodeFiniteNumber(value.robustContrast, 'binarization robust contrast'),
        illuminationDeviation: decodeFiniteNumber(value.illuminationDeviation, 'binarization illumination deviation'),
        edgeDensity: decodeFiniteNumber(value.edgeDensity, 'binarization edge density'),
        estimatedStrokeWidthPx: decodeFiniteNumber(value.estimatedStrokeWidthPx, 'binarization stroke width'),
        darkBorderCoverage: decodeFiniteNumber(value.darkBorderCoverage, 'binarization border coverage'),
        otsuAdaptiveAgreement: decodeFiniteNumber(value.otsuAdaptiveAgreement, 'binarization agreement'),
        ...(spreadPlan === undefined ? {} : {spreadPlan}),
    };
}

function decodeTextToneDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['textToneDiagnostics']> {
    if (!isRecord(value) || typeof value.applied !== 'boolean' || !isPreviewTextToneRule(value.rule)) {
        throw new Error('invalid scan-cleanup preview text-tone diagnostics');
    }
    const inkAnchor = value.inkAnchor === null
        ? null
        : decodeNonNegativeInteger(value.inkAnchor, 'text-tone ink anchor');
    if (inkAnchor !== null && inkAnchor > 255) {
        throw new Error('invalid scan-cleanup preview text-tone ink anchor');
    }
    const blackPoint = value.blackPoint === null
        ? null
        : decodeNonNegativeFiniteNumber(value.blackPoint, 'text-tone black point');
    const slope = value.slope === null
        ? null
        : decodePositiveFiniteNumber(value.slope, 'text-tone slope');
    if (
        value.applied !== (value.rule === 'applied')
        || value.applied !== (blackPoint !== null && slope !== null)
    ) throw new Error('inconsistent scan-cleanup preview text-tone diagnostics');
    return {
        applied: value.applied,
        rule: value.rule,
        textLineCount: decodeNonNegativeInteger(value.textLineCount, 'text-tone line count'),
        textInkPixels: decodeNonNegativeInteger(value.textInkPixels, 'text-tone ink pixels'),
        pictureFraction: decodeUnitInterval(value.pictureFraction, 'text-tone picture fraction'),
        outsideMidtoneFraction: decodeUnitInterval(
            value.outsideMidtoneFraction,
            'text-tone outside midtone fraction',
        ),
        outsideMidtoneLargestComponentFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentFraction,
            'text-tone outside midtone largest component fraction',
        ),
        outsideMidtoneLargestComponentWidthFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentWidthFraction,
            'text-tone outside midtone largest component width fraction',
        ),
        outsideMidtoneLargestComponentHeightFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentHeightFraction,
            'text-tone outside midtone largest component height fraction',
        ),
        inkAnchor,
        blackPoint,
        slope,
    };
}

function decodeSplitSeam(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 2) {
        throw new Error('invalid scan-cleanup preview split seam');
    }
    return {points: value.points.map((point, index) => {
        if (!isRecord(point)) throw new Error(`invalid scan-cleanup preview split seam point ${index}`);
        return {
            x: decodeSafeFiniteNumber(point.x, `split seam point ${index} x`),
            y: decodeSafeFiniteNumber(point.y, `split seam point ${index} y`),
        };
    })};
}

function decodePreviewMetadata(value: unknown): IScanCleanupPreviewMetadata {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview metadata');
    const half = SCAN_CLEANUP_OUTPUT_HALVES.find(candidate => candidate === value.half)
        ?? (() => { throw new Error('invalid scan-cleanup preview half'); })();
    const layoutClassification = isLayoutClassification(value.layoutClassification)
        ? value.layoutClassification
        : (() => { throw new Error('invalid scan-cleanup preview layout classification'); })();
    const canvasPolicy = value.canvasPolicy;
    const binarizationMode = value.binarizationMode;
    if (
        !isRecord(value.appliedMargins)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
        || !isScanCleanupRotation(value.rotationDegrees)
        || (canvasPolicy !== undefined && !isPreviewCanvasPolicy(canvasPolicy))
        || (value.canvasOverflow !== undefined && typeof value.canvasOverflow !== 'boolean')
        || (value.matchedCanvasOpticalPlacement !== undefined && typeof value.matchedCanvasOpticalPlacement !== 'boolean')
        || (value.intrinsicRasterWidthPx !== undefined && (!Number.isSafeInteger(value.intrinsicRasterWidthPx) || Number(value.intrinsicRasterWidthPx) < 1))
        || (value.intrinsicRasterHeightPx !== undefined && (!Number.isSafeInteger(value.intrinsicRasterHeightPx) || Number(value.intrinsicRasterHeightPx) < 1))
        || (value.matchedCanvasOpticalContentLeftPx !== undefined && value.matchedCanvasOpticalContentLeftPx !== null && (!Number.isFinite(Number(value.matchedCanvasOpticalContentLeftPx)) || Number(value.matchedCanvasOpticalContentLeftPx) < 0))
        || (value.matchedCanvasOpticalContentRightPx !== undefined && value.matchedCanvasOpticalContentRightPx !== null && (!Number.isFinite(Number(value.matchedCanvasOpticalContentRightPx)) || Number(value.matchedCanvasOpticalContentRightPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowLeftPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowLeftPx) || Number(value.matchedCanvasIntrinsicOverflowLeftPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowRightPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowRightPx) || Number(value.matchedCanvasIntrinsicOverflowRightPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowTopPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowTopPx) || Number(value.matchedCanvasIntrinsicOverflowTopPx) < 0))
        || (value.foldClipLeftPx !== undefined && (!Number.isSafeInteger(value.foldClipLeftPx) || Number(value.foldClipLeftPx) < 0))
        || (value.foldClipRightPx !== undefined && (!Number.isSafeInteger(value.foldClipRightPx) || Number(value.foldClipRightPx) < 0))
        || (value.illuminationNormalized !== undefined && typeof value.illuminationNormalized !== 'boolean')
        || (value.outputMode !== undefined && !isScanCleanupOutputMode(value.outputMode))
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.skewApplied !== undefined && typeof value.skewApplied !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (binarizationMode !== undefined
            && binarizationMode !== null
            && !isPreviewBinarizationRoute(binarizationMode))
        || (value.rasterScaleLimited !== undefined && typeof value.rasterScaleLimited !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview metadata');
    const metadata: IScanCleanupPreviewMetadata = {
        half,
        layoutClassification,
        layoutConfidence: value.layoutConfidence === undefined
            ? 0
            : decodeUnitInterval(value.layoutConfidence, 'layout confidence'),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeNonNegativeFiniteNumber(value.skewConfidence, 'skew confidence')}),
        ...(value.skewApplied === undefined ? {} : {skewApplied: value.skewApplied}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        sourceRegion: decodePreviewRect(value.sourceRegion, 'source region'),
        contentBox: value.contentBox === null ? null : decodePreviewRect(value.contentBox, 'content box'),
        cropRect: value.cropRect === undefined
            ? {
                xPx: 0,
                yPx: 0,
                widthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
                heightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
            }
            : decodePreviewRect(value.cropRect, 'crop rect'),
        ...(value.contentDiagnostics === undefined
            ? {}
            : {contentDiagnostics: decodeContentDiagnostics(value.contentDiagnostics)}),
        appliedMargins: {
            leftPx: decodeNonNegativeFiniteNumber(value.appliedMargins.leftPx, 'applied left margin'),
            topPx: decodeNonNegativeFiniteNumber(value.appliedMargins.topPx, 'applied top margin'),
            rightPx: decodeNonNegativeFiniteNumber(value.appliedMargins.rightPx, 'applied right margin'),
            bottomPx: decodeNonNegativeFiniteNumber(value.appliedMargins.bottomPx, 'applied bottom margin'),
        },
        outputWidthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
        outputHeightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
        ...(value.intrinsicRasterWidthPx === undefined
            ? {}
            : {intrinsicRasterWidthPx: decodePositiveInteger(value.intrinsicRasterWidthPx, 'intrinsic raster width')}),
        ...(value.intrinsicRasterHeightPx === undefined
            ? {}
            : {intrinsicRasterHeightPx: decodePositiveInteger(value.intrinsicRasterHeightPx, 'intrinsic raster height')}),
        ...(value.renderRegion === undefined
            ? {}
            : {renderRegion: decodePreviewRect(value.renderRegion, 'render region')}),
        canvasWidthPx: decodePositiveInteger(value.canvasWidthPx, 'canvas width'),
        canvasHeightPx: decodePositiveInteger(value.canvasHeightPx, 'canvas height'),
        canvasPolicy: isPreviewCanvasPolicy(canvasPolicy) ? canvasPolicy : 'intrinsic',
        canvasOverflow: value.canvasOverflow === true,
        matchedCanvasTargetWidthPx: value.matchedCanvasTargetWidthPx === null
            || value.matchedCanvasTargetWidthPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetWidthPx, 'matched canvas target width'),
        matchedCanvasTargetHeightPx: value.matchedCanvasTargetHeightPx === null
            || value.matchedCanvasTargetHeightPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetHeightPx, 'matched canvas target height'),
        matchedCanvasTargetWidthPoints: value.matchedCanvasTargetWidthPoints === null
            || value.matchedCanvasTargetWidthPoints === undefined
            ? null
            : decodePositiveFiniteNumber(value.matchedCanvasTargetWidthPoints, 'matched canvas target width points'),
        matchedCanvasTargetHeightPoints: value.matchedCanvasTargetHeightPoints === null
            || value.matchedCanvasTargetHeightPoints === undefined
            ? null
            : decodePositiveFiniteNumber(value.matchedCanvasTargetHeightPoints, 'matched canvas target height points'),
        matchedCanvasContentWidthPx: value.matchedCanvasContentWidthPx === null
            || value.matchedCanvasContentWidthPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasContentWidthPx, 'matched canvas content width'),
        matchedCanvasContentHeightPx: value.matchedCanvasContentHeightPx === null
            || value.matchedCanvasContentHeightPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasContentHeightPx, 'matched canvas content height'),
        ...(value.matchedCanvasOpticalPlacement === undefined
            ? {}
            : {matchedCanvasOpticalPlacement: value.matchedCanvasOpticalPlacement}),
        matchedCanvasOpticalContentLeftPx: value.matchedCanvasOpticalContentLeftPx === null
            || value.matchedCanvasOpticalContentLeftPx === undefined
            ? null
            : decodeNonNegativeFiniteNumber(value.matchedCanvasOpticalContentLeftPx, 'optical content left'),
        matchedCanvasOpticalContentRightPx: value.matchedCanvasOpticalContentRightPx === null
            || value.matchedCanvasOpticalContentRightPx === undefined
            ? null
            : decodeNonNegativeFiniteNumber(value.matchedCanvasOpticalContentRightPx, 'optical content right'),
        ...(value.matchedCanvasIntrinsicOverflowLeftPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowLeftPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowLeftPx, 'intrinsic overflow left')}),
        ...(value.matchedCanvasIntrinsicOverflowRightPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowRightPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowRightPx, 'intrinsic overflow right')}),
        ...(value.matchedCanvasIntrinsicOverflowTopPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowTopPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowTopPx, 'intrinsic overflow top')}),
        ...(value.foldClipLeftPx === undefined
            ? {}
            : {foldClipLeftPx: decodeNonNegativeInteger(value.foldClipLeftPx, 'fold clip left')}),
        ...(value.foldClipRightPx === undefined
            ? {}
            : {foldClipRightPx: decodeNonNegativeInteger(value.foldClipRightPx, 'fold clip right')}),
        placementOffsetXPx: decodeNonNegativeInteger(value.placementOffsetXPx, 'placement offset x'),
        placementOffsetYPx: decodeNonNegativeInteger(value.placementOffsetYPx, 'placement offset y'),
        forwardTransform: decodePreviewAffine(value.forwardTransform),
        cutterXPx: value.cutterXPx === null ? null : decodeSafeFiniteNumber(value.cutterXPx, 'cutter x'),
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        inputWidthPx: decodePositiveInteger(value.inputWidthPx, 'input width'),
        inputHeightPx: decodePositiveInteger(value.inputHeightPx, 'input height'),
        rotationDegrees: decodeScanCleanupRotation(value.rotationDegrees, 'rotation'),
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        resamplePasses: decodeNonNegativeInteger(value.resamplePasses, 'resample passes'),
        ...(value.illuminationNormalized === undefined
            ? {}
            : {illuminationNormalized: value.illuminationNormalized}),
        ...(value.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: decodeTextToneDiagnostics(value.textToneDiagnostics)}),
        ...(value.outputMode === undefined
            ? {}
            : {outputMode: value.outputMode}),
        ...(binarizationMode === undefined
            ? {}
            : {binarizationMode: isPreviewBinarizationRoute(binarizationMode)
                ? binarizationMode
                : null}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'dewarp confidence')}),
        ...(value.dewarpApplied === undefined ? {} : {dewarpApplied: value.dewarpApplied}),
        ...(value.sourceDpi === undefined
            ? {}
            : {sourceDpi: decodePositiveFiniteNumber(value.sourceDpi, 'source dpi')}),
        ...(value.renderDpi === undefined
            ? {}
            : {renderDpi: decodePositiveFiniteNumber(value.renderDpi, 'render dpi')}),
        ...(value.requestedRenderDpi === undefined
            ? {}
            : {requestedRenderDpi: decodePositiveFiniteNumber(value.requestedRenderDpi, 'requested render dpi')}),
        rasterScaleLimited: value.rasterScaleLimited === true,
        warnings: value.warnings.filter((item): item is string => typeof item === 'string'),
    };
    // What is placed on the canvas is the *content* box: the size the intrinsic
    // raster takes once the page has been normalized to the document's scale. A
    // matched preview keeps the raster it rendered — the renderer scales it —
    // so its intrinsic dimensions are the page's own pixels and say nothing
    // about whether it fits the canvas. A page nothing normalized carries no
    // content box, and there the two are the same thing.
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeightPx = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const recordedIntrinsicOverflowLeft = metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0;
    const recordedIntrinsicOverflowRight = metadata.matchedCanvasIntrinsicOverflowRightPx ?? 0;
    const recordedIntrinsicOverflowTop = metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0;
    const foldClipLeft = metadata.foldClipLeftPx ?? 0;
    const foldClipRight = metadata.foldClipRightPx ?? 0;
    const effectivePlacementOffsetX = metadata.placementOffsetXPx - recordedIntrinsicOverflowLeft;
    const effectivePlacementOffsetY = metadata.placementOffsetYPx - recordedIntrinsicOverflowTop;
    const actualIntrinsicOverflowLeft = Math.max(0, -effectivePlacementOffsetX);
    const actualIntrinsicOverflowRight = Math.max(
        0,
        effectivePlacementOffsetX + contentWidthPx - metadata.canvasWidthPx,
    );
    const actualIntrinsicOverflowTop = Math.max(0, -effectivePlacementOffsetY);
    if (
        metadata.canvasHeightPx < contentHeightPx
        || recordedIntrinsicOverflowLeft > contentWidthPx
        || foldClipLeft + foldClipRight >= contentWidthPx
        || recordedIntrinsicOverflowTop > contentHeightPx
        || actualIntrinsicOverflowLeft !== recordedIntrinsicOverflowLeft
        || actualIntrinsicOverflowRight !== recordedIntrinsicOverflowRight
        || actualIntrinsicOverflowTop !== recordedIntrinsicOverflowTop
        || effectivePlacementOffsetX >= metadata.canvasWidthPx
        || effectivePlacementOffsetX + contentWidthPx <= 0
        || effectivePlacementOffsetY >= metadata.canvasHeightPx
        || effectivePlacementOffsetY + contentHeightPx <= 0
        || effectivePlacementOffsetY + contentHeightPx > metadata.canvasHeightPx
    ) {
        throw new Error('invalid scan-cleanup preview intrinsic/canvas placement');
    }
    if (!isNativeScanCleanupOpticalPlacementValid(metadata)) {
        throw new Error('invalid scan-cleanup preview intrinsic/canvas placement');
    }
    if (
        metadata.renderRegion
        && (
            metadata.renderRegion.xPx < 0
            || metadata.renderRegion.yPx < 0
            || metadata.renderRegion.widthPx <= 0
            || metadata.renderRegion.heightPx <= 0
            || metadata.renderRegion.xPx + metadata.renderRegion.widthPx > metadata.outputWidthPx
            || metadata.renderRegion.yPx + metadata.renderRegion.heightPx > metadata.outputHeightPx
        )
    ) {
        throw new Error(
            `invalid scan-cleanup preview render region ${JSON.stringify({
                outputHeightPx: metadata.outputHeightPx,
                outputWidthPx: metadata.outputWidthPx,
                renderRegion: metadata.renderRegion,
            })}`,
        );
    }
    return metadata;
}

function decodeUnitInterval(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0 || decoded > 1) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

export function decodeScanCleanupPreviewResult(value: unknown): TScanCleanupPreviewWireResult {
    if (isRecord(value) && value.canceled === true) {
        return {canceled: true};
    }
    const requestId = isRecord(value) && value.requestId !== undefined
        ? parseRequestId(value.requestId)
        : undefined;
    if (
        !isRecord(value)
        || requestId === null
        || !Array.isArray(value.outputs)
        || value.outputs.length > 2
    ) throw new Error('invalid scan-cleanup preview result');
    // Absent exactly when the request streamed the raster ahead of this result.
    const rawImageData = value.rawImageData === undefined
        ? undefined
        : decodePreviewBytes(value.rawImageData, 'raw image');
    let totalBytes = rawImageData?.byteLength ?? 0;
    const outputs = value.outputs.map(output => {
        if (!isRecord(output) || !isRecord(output.metadata)) throw new Error('invalid scan-cleanup preview output');
        const imageData = decodePreviewBytes(output.imageData, 'output image');
        totalBytes += imageData.byteLength;
        return {
            imageData,
            metadata: decodePreviewMetadata(output.metadata),
        };
    });
    if (totalBytes > PREVIEW_MAX_TOTAL_BYTES) throw new Error('invalid scan-cleanup preview total image bytes');
    const totalPages = decodePositiveInteger(value.totalPages, 'total pages');
    const pageNumber = requirePageNumber(
        decodePositiveInteger(value.pageNumber, 'page number'),
        totalPages,
    );
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup preview page number');
    return {
        ...(requestId === undefined ? {} : {requestId}),
        pageNumber,
        totalPages,
        ...(rawImageData === undefined ? {} : {rawImageData}),
        rawWidthPx: decodePositiveInteger(value.rawWidthPx, 'raw width'),
        rawHeightPx: decodePositiveInteger(value.rawHeightPx, 'raw height'),
        pageMetadata: decodePreviewPageMetadata(value.pageMetadata),
        outputs,
    };
}

export function decodeScanCleanupRawPreviewEvent(value: unknown): IScanCleanupRawPreviewEvent {
    const requestId = isRecord(value) ? parseRequestId(value.requestId) : null;
    if (!isRecord(value) || requestId === null) {
        throw new Error('invalid scan-cleanup raw preview result');
    }
    const ownerId = decodeBoundedScanCleanupString(
        value.ownerId,
        'raw preview owner id',
        SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    );
    const documentRevision = decodeBoundedScanCleanupString(
        value.documentRevision,
        'raw preview document revision',
        SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    );
    const totalPages = decodePositiveInteger(value.totalPages, 'raw total pages');
    const pageNumber = requirePageNumber(
        decodePositiveInteger(value.pageNumber, 'raw page number'),
        totalPages,
    );
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup raw preview page number');
    return {
        ownerId,
        documentRevision,
        requestId,
        pageNumber,
        totalPages,
        rawImageData: decodePreviewBytes(value.rawImageData, 'raw image'),
        rawWidthPx: decodePositiveInteger(value.rawWidthPx, 'raw width'),
        rawHeightPx: decodePositiveInteger(value.rawHeightPx, 'raw height'),
    };
}

function decodePreviewPageMetadata(value: unknown): IScanCleanupPreviewResult['pageMetadata'] {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview page metadata');
    const layoutClassification = isLayoutClassification(value.layoutClassification)
        ? value.layoutClassification
        : (() => { throw new Error('invalid scan-cleanup preview page layout classification'); })();
    const binarizationMode = value.binarizationMode === undefined || value.binarizationMode === null
        ? value.binarizationMode
        : isPreviewBinarizationRoute(value.binarizationMode)
            ? value.binarizationMode
            : (() => { throw new Error('invalid scan-cleanup preview page binarization mode'); })();
    if (
        !(value.cutterXPx === null || typeof value.cutterXPx === 'number'
            && Number.isFinite(value.cutterXPx)
            && Math.abs(value.cutterXPx) <= Number.MAX_SAFE_INTEGER)
        || !isScanCleanupRotation(value.rotationDegrees)
        || typeof value.excluded !== 'boolean'
        || (value.layoutConfidence !== undefined && (
            typeof value.layoutConfidence !== 'number'
            || !Number.isFinite(value.layoutConfidence)
            || value.layoutConfidence < 0
            || value.layoutConfidence > 1
        ))
        || (value.tier1Verdict !== undefined && !isLayoutClassification(value.tier1Verdict))
        || (value.reconciled !== undefined && typeof value.reconciled !== 'boolean')
        || (value.clusterAgreement !== undefined && (
            typeof value.clusterAgreement !== 'number'
            || !Number.isFinite(value.clusterAgreement)
            || value.clusterAgreement < -1
            || value.clusterAgreement > 1
        ))
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.autoDewarpAttempted !== undefined && typeof value.autoDewarpAttempted !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (value.recommendedOutputMode !== undefined
            && !isScanCleanupOutputMode(value.recommendedOutputMode))
        || (value.recommendedOutputModeConfidence !== undefined && (
            typeof value.recommendedOutputModeConfidence !== 'number'
            || !Number.isFinite(value.recommendedOutputModeConfidence)
            || value.recommendedOutputModeConfidence < 0
            || value.recommendedOutputModeConfidence > 1
        ))
        || (value.recommendedOutputModeReason !== undefined
            && !isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason))
        || (value.softAlphaForegroundRecommendation !== undefined
            && typeof value.softAlphaForegroundRecommendation !== 'boolean')
        || (value.outputDiagnostics !== undefined && (
            !Array.isArray(value.outputDiagnostics)
            || value.outputDiagnostics.length > 2
            || value.outputDiagnostics.some(output => (
                !isRecord(output)
                || !isPreviewHalf(output.half)
            ))
        ))
    ) throw new Error('invalid scan-cleanup preview page metadata');
    return {
        layoutClassification,
        layoutConfidence: value.layoutConfidence === undefined
            ? 0
            : decodeUnitInterval(value.layoutConfidence, 'page layout confidence'),
        cutterXPx: value.cutterXPx === null
            ? null
            : decodeSafeFiniteNumber(value.cutterXPx, 'cutter x'),
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        rotationDegrees: decodeScanCleanupRotation(value.rotationDegrees, 'page rotation'),
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        excluded: value.excluded,
        blankOutputsSkipped: decodeNonNegativeInteger(value.blankOutputsSkipped, 'blank outputs skipped'),
        tier1Verdict: isLayoutClassification(value.tier1Verdict)
            ? value.tier1Verdict
            : layoutClassification,
        reconciled: value.reconciled === true,
        clusterAgreement: value.clusterAgreement === undefined
            ? 0
            : (() => {
                const agreement = decodeFiniteNumber(value.clusterAgreement, 'cluster agreement');
                if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup cluster agreement');
                return agreement;
            })(),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'page detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeNonNegativeFiniteNumber(value.skewConfidence, 'page skew confidence')}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        ...(binarizationMode === undefined
            ? {}
            : {binarizationMode}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: decodeTextToneDiagnostics(value.textToneDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.autoDewarpAttempted === undefined
            ? {}
            : {autoDewarpAttempted: value.autoDewarpAttempted}),
        ...(value.dewarpApplied === undefined
            ? {}
            : {dewarpApplied: value.dewarpApplied}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'page dewarp confidence')}),
        ...(value.outputDiagnostics === undefined
            ? {}
            : {outputDiagnostics: value.outputDiagnostics.map((output: unknown) => {
                if (!isRecord(output)) throw new Error('invalid scan-cleanup preview output diagnostics');
                const half = isPreviewHalf(output.half)
                    ? output.half
                    : (() => { throw new Error('invalid scan-cleanup preview output half'); })();
                return {
                    half,
                    ...(output.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: decodeContentDiagnostics(output.contentDiagnostics)}),
                    ...(output.textToneDiagnostics === undefined
                        ? {}
                        : {textToneDiagnostics: decodeTextToneDiagnostics(
                            output.textToneDiagnostics,
                        )}),
                };
            })}),
        ...(isScanCleanupOutputMode(value.recommendedOutputMode)
            ? {recommendedOutputMode: value.recommendedOutputMode}
            : {}),
        ...(typeof value.recommendedOutputModeConfidence === 'number'
            ? {recommendedOutputModeConfidence: value.recommendedOutputModeConfidence}
            : {}),
        ...(isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason)
            ? {recommendedOutputModeReason: value.recommendedOutputModeReason}
            : {}),
        ...(typeof value.softAlphaForegroundRecommendation === 'boolean'
            ? {softAlphaForegroundRecommendation: value.softAlphaForegroundRecommendation}
            : {}),
    };
}

export function decodeStartResult(value: unknown) {
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    if (!isRecord(value) || typeof value.started !== 'boolean' || jobId === null) throw new Error('invalid scan-cleanup start result');
    if (value.started) {
        if (typeof value.outputPdfPath !== 'string') throw new Error('successful scan-cleanup start requires outputPdfPath');
        return {
            started: true as const,
            jobId,
            outputPdfPath: value.outputPdfPath,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup start requires a typed error');
    }
    return {
        started: false as const,
        jobId,
        error: value.error,
        errorCode: value.errorCode,
        ...(value.scratchShortfall === undefined
            ? {}
            : {scratchShortfall: decodeScanCleanupScratchShortfall(value.scratchShortfall)}),
    };
}

export function decodeDetectionStartResult(value: unknown) {
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    if (!isRecord(value) || typeof value.started !== 'boolean' || jobId === null) {
        throw new Error('invalid scan-cleanup detection start result');
    }
    if (value.started) {
        return {
            started: true as const,
            jobId,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup detection start requires a typed error');
    }
    return {
        started: false as const,
        jobId,
        error: value.error,
        errorCode: value.errorCode,
        ...(value.scratchShortfall === undefined
            ? {}
            : {scratchShortfall: decodeScanCleanupScratchShortfall(value.scratchShortfall)}),
    };
}

function isScanCleanupErrorCode(value: unknown): value is TScanCleanupErrorCode {
    return SCAN_CLEANUP_ERROR_CODES.some(code => code === value);
}

function decodeNonNegativeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid scan-cleanup ${fieldName}`);
    }
    return value;
}

export function decodeScanCleanupJobState(value: unknown): TScanCleanupJobState | null {
    if (value === null) {
        return null;
    }
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    const updatedAtMs = isRecord(value) ? parseEpochMs(value.updatedAtMs) : null;
    if (
        !isRecord(value)
        || jobId === null
        || updatedAtMs === null
    ) {
        throw new Error('invalid scan-cleanup job state');
    }
    const base = {
        jobId,
        progress: SCAN_CLEANUP_PROGRESS_SCHEMA.decode(value.progress),
        updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'handoff' || value.status === 'committing' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'completed') {
        if (typeof value.outputPdfPath !== 'string' || typeof value.partial !== 'boolean') {
            throw new Error('completed scan-cleanup state requires outputPdfPath and partial flag');
        }
        return {
            ...base,
            status: 'completed',
            outputPdfPath: value.outputPdfPath,
            summary: SCAN_CLEANUP_SUMMARY_SCHEMA.decode(value.summary),
            partial: value.partial,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup state requires a typed error');
        }
        let failure;
        if (value.failure !== undefined) {
            const decodedFailure = decodeFailureReceipt(value.failure);
            if (decodedFailure === null) {
                throw new Error('failed scan-cleanup state has an invalid failure receipt');
            }
            failure = decodedFailure;
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
            ...(value.scratchShortfall === undefined
                ? {}
                : {scratchShortfall: decodeScanCleanupScratchShortfall(value.scratchShortfall)}),
            ...(failure === undefined ? {} : {failure}),
            ...(value.scratchShortfall === undefined
                ? {}
                : {scratchShortfall: decodeScanCleanupScratchShortfall(value.scratchShortfall)}),
        };
    }
    throw new Error('invalid scan-cleanup job status');
}

export function decodeScanCleanupDetectionJobState(value: unknown): TScanCleanupDetectionJobState | null {
    if (value === null) {
        return null;
    }
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    const updatedAtMs = isRecord(value) ? parseEpochMs(value.updatedAtMs) : null;
    if (
        !isRecord(value)
        || jobId === null
        || (value.documentCanvasSignature !== undefined
            && typeof value.documentCanvasSignature !== 'string')
        || updatedAtMs === null
        || !isRecord(value.progress)
        || !Array.isArray(value.results)
        || value.results.length > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        || (value.resultCount !== undefined && (
            typeof value.resultCount !== 'number'
            || !Number.isSafeInteger(value.resultCount)
            || value.resultCount < 0
        ))
    ) throw new Error('invalid scan-cleanup detection job state');
    const resultCount = value.resultCount === undefined
        ? value.results.length
        : decodeNonNegativeInteger(value.resultCount, 'detection result count');
    if (resultCount < value.results.length) {
        throw new Error('invalid scan-cleanup detection result count');
    }
    const progress = SCAN_CLEANUP_PROGRESS_SCHEMA.decode(value.progress);
    const results = value.results.map(result => {
        if (
            !isRecord(result)
            || !isLayoutClassification(result.classification)
            || (result.revision !== undefined && (
                typeof result.revision !== 'number'
                || !Number.isInteger(result.revision)
                || result.revision < 1
            ))
            || !(result.cutterXPx === null || typeof result.cutterXPx === 'number'
                && Number.isFinite(result.cutterXPx)
                && Math.abs(result.cutterXPx) <= Number.MAX_SAFE_INTEGER)
            || (result.tier1Verdict !== undefined && !isLayoutClassification(result.tier1Verdict))
            || (result.reconciled !== undefined && typeof result.reconciled !== 'boolean')
            || (result.clusterAgreement !== undefined && (
                typeof result.clusterAgreement !== 'number'
                || !Number.isFinite(result.clusterAgreement)
                || result.clusterAgreement < -1
                || result.clusterAgreement > 1
            ))
            || (result.textAxis !== undefined && (
                !isRecord(result.textAxis)
                || Object.keys(result.textAxis).some(key => key !== 'sideways' && key !== 'confidence')
                || typeof result.textAxis.sideways !== 'boolean'
                || typeof result.textAxis.confidence !== 'number'
                || !Number.isFinite(result.textAxis.confidence)
                || result.textAxis.confidence < 0
                || result.textAxis.confidence > 1
            ))
            || (result.recommendedOutputMode !== undefined
                && !isScanCleanupOutputMode(result.recommendedOutputMode))
            || (result.recommendedOutputModeConfidence !== undefined && (
                typeof result.recommendedOutputModeConfidence !== 'number'
                || !Number.isFinite(result.recommendedOutputModeConfidence)
                || result.recommendedOutputModeConfidence < 0
                || result.recommendedOutputModeConfidence > 1
            ))
            || (result.recommendedOutputModeReason !== undefined
                && !isScanCleanupOutputModeRecommendationReason(result.recommendedOutputModeReason))
            || (result.softAlphaForegroundRecommendation !== undefined
                && typeof result.softAlphaForegroundRecommendation !== 'boolean')
        ) throw new Error('invalid scan-cleanup detection result');
        const classification = isLayoutClassification(result.classification)
            ? result.classification
            : (() => { throw new Error('invalid scan-cleanup detection classification'); })();
        const textAxis = result.textAxis === undefined
            ? undefined
            : !isRecord(result.textAxis)
                || typeof result.textAxis.sideways !== 'boolean'
                || typeof result.textAxis.confidence !== 'number'
                ? (() => { throw new Error('invalid scan-cleanup detection text axis'); })()
                : {
                    sideways: result.textAxis.sideways,
                    confidence: result.textAxis.confidence,
                };
        const pageNumber = requirePageNumber(
            decodePositiveInteger(result.pageNumber, 'detection page number'),
        );
        const sourcePageMetadata = result.sourcePageMetadata === undefined
            ? undefined
            : decodeSourcePageMetadata(result.sourcePageMetadata);
        if (
            sourcePageMetadata !== undefined
            && sourcePageMetadata.pageNumber !== result.pageNumber
        ) {
            throw new Error('invalid scan-cleanup detection source page metadata');
        }
        const pagePlanEvidence = result.pagePlanEvidence === undefined
            ? undefined
            : decodeScanCleanupPagePlanEvidence(result.pagePlanEvidence, pageNumber);
        const splitDiagnostics = result.splitDiagnostics === undefined
            ? undefined
            : decodeSplitDiagnostics(result.splitDiagnostics);
        return {
            pageNumber,
            ...(result.revision === undefined ? {} : {revision: result.revision}),
            classification,
            confidence: decodeUnitInterval(result.confidence, 'detection confidence'),
            cutterXPx: result.cutterXPx === null
                ? null
                : decodeSafeFiniteNumber(result.cutterXPx, 'detection cutter x'),
            tier1Verdict: isLayoutClassification(result.tier1Verdict)
                ? result.tier1Verdict
                : classification,
            reconciled: result.reconciled === true,
            clusterAgreement: result.clusterAgreement === undefined
                ? 0
                : (() => {
                    const agreement = decodeFiniteNumber(result.clusterAgreement, 'detection cluster agreement');
                    if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup detection cluster agreement');
                    return agreement;
                })(),
            documentPrior: result.documentPrior === null || result.documentPrior === undefined
                ? null
                : decodeDocumentPrior(result.documentPrior),
            ...(textAxis === undefined ? {} : {textAxis}),
            ...(isScanCleanupOutputMode(result.recommendedOutputMode)
                ? {recommendedOutputMode: result.recommendedOutputMode}
                : {}),
            ...(typeof result.recommendedOutputModeConfidence === 'number'
                ? {recommendedOutputModeConfidence: result.recommendedOutputModeConfidence}
                : {}),
            ...(isScanCleanupOutputModeRecommendationReason(result.recommendedOutputModeReason)
                ? {recommendedOutputModeReason: result.recommendedOutputModeReason}
                : {}),
            ...(typeof result.softAlphaForegroundRecommendation === 'boolean'
                ? {softAlphaForegroundRecommendation: result.softAlphaForegroundRecommendation}
                : {}),
            ...(sourcePageMetadata === undefined ? {} : {sourcePageMetadata}),
            ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
            ...(splitDiagnostics === undefined ? {} : {splitDiagnostics}),
        };
    });
    if (
        resultCount > progress.completedUnits
        || resultCount > progress.totalUnits
        || (value.status === 'completed' && resultCount !== progress.completedUnits)
    ) throw new Error('invalid scan-cleanup detection result count');
    const base = {
        jobId,
        ...(typeof value.documentCanvasSignature === 'string'
            ? {documentCanvasSignature: value.documentCanvasSignature}
            : {}),
        progress,
        ...(value.resultCount === undefined ? {} : {resultCount}),
        ...(value.detectionResultStoreId === undefined
            ? {}
            : {detectionResultStoreId: decodeBoundedScanCleanupString(
                value.detectionResultStoreId,
                'detection result store id',
                SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
            )}),
        ...(value.placementAnchorSummary === undefined
            ? {}
            : {placementAnchorSummary: decodeScanCleanupPlacementAnchorSummary(
                value.placementAnchorSummary,
            )}),
        results,
        updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'completed' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup detection state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
            ...(value.scratchShortfall === undefined
                ? {}
                : {scratchShortfall: decodeScanCleanupScratchShortfall(value.scratchShortfall)}),
        };
    }
    throw new Error('invalid scan-cleanup detection job status');
}
