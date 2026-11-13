import type {
    IScanCleanupDetectionResult,
    IScanCleanupPagePlanEvidence,
    TScanCleanupProgress,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {requirePageNumber} from '@contracts/pageNumbers';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';

/**
 * The progress contract accepts a page list only when it is exactly the
 * completed count or explicitly marked as a bounded list. Pages the native
 * detector processes without a classification count as completed but never
 * enter the list, and a document-sized list would breach the IPC entry cap,
 * so the list is capped in verdict-arrival order and flagged whenever it is
 * not the full set.
 */
export function completedPageProgress(
    reportedPageNumbers: ReadonlySet<number>,
    completedUnits: number,
): Pick<TScanCleanupProgress, 'completedPageNumbers' | 'completedPageNumbersTruncated'> {
    const completedPageNumbers = [...reportedPageNumbers].slice(0, SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
    return completedPageNumbers.length === completedUnits
        ? {completedPageNumbers}
        : {
            completedPageNumbers,
            completedPageNumbersTruncated: true,
        };
}

function normalizeDetectionContentBox(
    output: INativeScanCleanupAnalysisOutputV3,
    rotationDegrees: IScanCleanupPagePlanEvidence['rotationDegrees'],
) {
    const contentBox = output.contentBox;
    if (
        contentBox === null
        || contentBox === undefined
        || output.inputWidthPx <= 0
        || output.inputHeightPx <= 0
        || output.sourceRegion.widthPx <= 0
        || output.sourceRegion.heightPx <= 0
    ) {
        return undefined;
    }
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputHeightPx
        : output.inputWidthPx;
    const analysisHeight = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputWidthPx
        : output.inputHeightPx;
    const left = Math.max(0, Math.min(output.sourceRegion.widthPx, contentBox.xPx));
    const top = Math.max(0, Math.min(output.sourceRegion.heightPx, contentBox.yPx));
    const right = Math.max(
        left,
        Math.min(output.sourceRegion.widthPx, contentBox.xPx + contentBox.widthPx),
    );
    const bottom = Math.max(
        top,
        Math.min(output.sourceRegion.heightPx, contentBox.yPx + contentBox.heightPx),
    );
    if (right <= left || bottom <= top) {
        return undefined;
    }
    // Content coordinates are local to the output half, while their scale is
    // the complete rotated analysis page. Normalize the two edges first and
    // derive the extent from them so a box ending at the page edge serializes
    // exactly as `1 - start` for the manifest validator.
    const leftNormalized = left / analysisWidth;
    const topNormalized = top / analysisHeight;
    const rightNormalized = right === analysisWidth ? 1 : right / analysisWidth;
    const bottomNormalized = bottom === analysisHeight ? 1 : bottom / analysisHeight;
    return {
        xNormalized: leftNormalized,
        yNormalized: topNormalized,
        widthNormalized: rightNormalized - leftNormalized,
        heightNormalized: bottomNormalized - topNormalized,
        rotationDegrees,
    };
}

function createDetectionPagePlanEvidence(
    result: IScanCleanupDetectionResult,
    metadata: INativeScanCleanupPageMetadataV3,
    includeContentBoxes: boolean,
): IScanCleanupPagePlanEvidence {
    const rotationDegrees = metadata.rotationDegrees;
    const firstOutput = metadata.outputs?.[0];
    const analysisWidth = firstOutput === undefined
        ? 0
        : rotationDegrees === 90 || rotationDegrees === 270
            ? firstOutput.inputHeightPx
            : firstOutput.inputWidthPx;
    const splitXNormalized = result.cutterXPx === null || analysisWidth <= 0
        ? undefined
        : result.cutterXPx / analysisWidth;
    const automaticSplit = splitXNormalized === undefined
        || splitXNormalized <= 0
        || splitXNormalized >= 1
        ? undefined
        : {
            xNormalized: splitXNormalized,
            rotationDegrees,
        };
    const outputs: IScanCleanupPagePlanEvidence['outputs'] = {};
    for (const output of metadata.outputs ?? []) {
        const contentBox = includeContentBoxes
            ? normalizeDetectionContentBox(output, rotationDegrees)
            : undefined;
        if (contentBox === undefined && output.textToneDiagnostics === undefined) {
            continue;
        }
        outputs[output.half] = {
            ...(contentBox === undefined ? {} : {contentBox}),
            ...(output.textToneDiagnostics === undefined
                ? {}
                : {textToneDiagnostics: output.textToneDiagnostics}),
        };
    }
    return {
        pageNumber: result.pageNumber,
        rotationDegrees,
        layoutClassification: result.classification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

/**
 * The verdict an analysis reports: on desktop the engine's page-analyzed or
 * page-complete frame, in the browser the same fields read from the page
 * metadata by {@link deriveScanCleanupAnalysisVerdict}.
 */
export type TScanCleanupAnalysisVerdict = Pick<
    TNativeScanCleanupProgressV3,
    | 'classification'
    | 'confidence'
    | 'cutterXPx'
    | 'tier1Verdict'
    | 'reconciled'
    | 'clusterAgreement'
    | 'documentPrior'
    | 'textAxis'
    | 'recommendedOutputMode'
    | 'recommendedOutputModeConfidence'
    | 'recommendedOutputModeReason'
    | 'softAlphaForegroundRecommendation'
    | 'outputModeDiagnostics'
>;

/**
 * The verdict frame the engine reports beside a page's metadata, as its
 * `page_complete_progress` builds it: every field copies the metadata, a
 * cutter only for a spread, and absent fields left out.
 */
export function deriveScanCleanupAnalysisVerdict(metadata: INativeScanCleanupPageMetadataV3): TScanCleanupAnalysisVerdict {
    return {
        classification: metadata.layoutClassification,
        confidence: metadata.layoutConfidence,
        ...(metadata.layoutClassification === 'two-page-spread' && metadata.cutterXPx != null
            ? {cutterXPx: metadata.cutterXPx}
            : {}),
        tier1Verdict: metadata.tier1Verdict,
        reconciled: metadata.reconciled,
        clusterAgreement: metadata.clusterAgreement,
        ...(metadata.documentPrior == null
            ? {}
            : {documentPrior: {
                dominantLayout: metadata.documentPrior.dominantLayout,
                cutterRatioMedian: metadata.documentPrior.cutterRatioMedian ?? null,
                clusterDims: metadata.documentPrior.clusterDims,
                agreementStrength: metadata.documentPrior.agreementStrength,
                ...(metadata.documentPrior.strokeWidthMedianPx == null
                    ? {}
                    : {strokeWidthMedianPx: metadata.documentPrior.strokeWidthMedianPx}),
                ...(metadata.documentPrior.xHeightMedianPx == null
                    ? {}
                    : {xHeightMedianPx: metadata.documentPrior.xHeightMedianPx}),
            }}),
        ...(metadata.textAxis == null ? {} : {textAxis: metadata.textAxis}),
        // The engine recommends a concrete mode; `auto` is only a request.
        ...(metadata.recommendedOutputMode == null || metadata.recommendedOutputMode === 'auto'
            ? {}
            : {recommendedOutputMode: metadata.recommendedOutputMode}),
        ...(metadata.recommendedOutputModeConfidence == null
            ? {}
            : {recommendedOutputModeConfidence: metadata.recommendedOutputModeConfidence}),
        ...(metadata.recommendedOutputModeReason == null
            ? {}
            : {recommendedOutputModeReason: metadata.recommendedOutputModeReason}),
        ...(metadata.softAlphaForegroundRecommendation == null
            ? {}
            : {softAlphaForegroundRecommendation: metadata.softAlphaForegroundRecommendation}),
        ...(metadata.outputModeDiagnostics == null
            ? {}
            : {outputModeDiagnostics: metadata.outputModeDiagnostics}),
    };
}

/** The recommendation fields a verdict carries, each only when present. */
function recommendationFields(verdict: TScanCleanupAnalysisVerdict) {
    return {
        ...(verdict.textAxis === undefined ? {} : {textAxis: verdict.textAxis}),
        ...(verdict.recommendedOutputMode === undefined
            ? {}
            : {recommendedOutputMode: verdict.recommendedOutputMode}),
        ...(verdict.recommendedOutputModeConfidence === undefined
            ? {}
            : {recommendedOutputModeConfidence: verdict.recommendedOutputModeConfidence}),
        ...(verdict.recommendedOutputModeReason === undefined
            ? {}
            : {recommendedOutputModeReason: verdict.recommendedOutputModeReason}),
        ...(verdict.softAlphaForegroundRecommendation === undefined
            ? {}
            : {softAlphaForegroundRecommendation: verdict.softAlphaForegroundRecommendation}),
        ...(verdict.outputModeDiagnostics === undefined
            ? {}
            : {outputModeDiagnostics: verdict.outputModeDiagnostics}),
    };
}

export interface IProjectScanCleanupDetectionResultInput {
    pageNumber: number;
    revision: number;
    /** The verdict reported with the metadata. */
    verdict: TScanCleanupAnalysisVerdict;
    /** The page's analysis metadata, as an analyze manifest writes it. */
    metadata: INativeScanCleanupPageMetadataV3;
    /** The page view it was analyzed on, and its source resolution when known. */
    sourcePage: IPdfPageSize;
    sourceDpi: number | undefined;
    /** Automatic content boxes are omitted when dewarping may move the content. */
    includeContentBoxes: boolean;
}

/**
 * One page's detection result: classification and reconciliation from the
 * metadata, falling back to the reported verdict, and recommendations from
 * the verdict.
 */
export function projectScanCleanupDetectionResult({
    pageNumber,
    revision,
    verdict,
    metadata,
    sourcePage,
    sourceDpi,
    includeContentBoxes,
}: IProjectScanCleanupDetectionResultInput): IScanCleanupDetectionResult {
    const result: IScanCleanupDetectionResult = {
        pageNumber: requirePageNumber(pageNumber),
        revision,
        classification: metadata.layoutClassification,
        confidence: metadata.layoutConfidence ?? verdict.confidence!,
        cutterXPx: metadata.cutterXPx,
        tier1Verdict: metadata.tier1Verdict ?? verdict.tier1Verdict ?? metadata.layoutClassification,
        reconciled: metadata.reconciled ?? verdict.reconciled ?? false,
        clusterAgreement: metadata.clusterAgreement ?? verdict.clusterAgreement ?? 0,
        documentPrior: metadata.documentPrior == null
            ? verdict.documentPrior ?? null
            : {
                ...metadata.documentPrior,
                cutterRatioMedian: metadata.documentPrior.cutterRatioMedian ?? null,
                strokeWidthMedianPx: metadata.documentPrior.strokeWidthMedianPx ?? undefined,
                xHeightMedianPx: metadata.documentPrior.xHeightMedianPx ?? undefined,
            },
        ...recommendationFields(verdict),
        ...(sourceDpi === undefined
            ? {}
            : {sourcePageMetadata: {
                ...sourcePage,
                pageNumber: requirePageNumber(sourcePage.pageNumber),
                sourceDpi,
            }}),
    };
    result.pagePlanEvidence = createDetectionPagePlanEvidence(result, metadata, includeContentBoxes);
    if (metadata.splitDiagnostics !== undefined) result.splitDiagnostics = metadata.splitDiagnostics;
    return result;
}
