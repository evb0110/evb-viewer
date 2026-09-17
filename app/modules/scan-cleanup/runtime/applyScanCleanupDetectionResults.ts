import type {
    IScanCleanupDetectionResult,
    IScanCleanupDocumentPrior,
    IScanCleanupPreviewMetadata,
    IScanCleanupTextAxis,
} from '@contracts/scan-cleanup/electronApiScanCleanup';

export function applyScanCleanupDetectionResults(
    results: readonly IScanCleanupDetectionResult[],
    classifications: Map<number, IScanCleanupPreviewMetadata['layoutClassification']>,
    confidences: Map<number, number>,
    accepts: (pageNumber: number) => boolean = () => true,
    documentPriors?: Map<number, IScanCleanupDocumentPrior>,
    textAxes?: Map<number, IScanCleanupTextAxis>,
    recommendedModes?: Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputMode']>>,
    recommendedModeConfidences?: Map<number, number>,
    recommendedModeReasons?: Map<number, NonNullable<IScanCleanupDetectionResult['recommendedOutputModeReason']>>,
    softAlphaForegroundRecommendations?: Map<number, boolean>,
) {
    for (const result of results) {
        if (!accepts(result.pageNumber)) {
            continue;
        }
        classifications.set(result.pageNumber, result.classification);
        confidences.set(result.pageNumber, result.confidence);
        if (result.documentPrior === null) {
            documentPriors?.delete(result.pageNumber);
        } else {
            documentPriors?.set(result.pageNumber, result.documentPrior);
        }
        if (result.textAxis === undefined) {
            textAxes?.delete(result.pageNumber);
        } else {
            textAxes?.set(result.pageNumber, result.textAxis);
        }
        if (result.recommendedOutputMode === undefined) {
            recommendedModes?.delete(result.pageNumber);
        } else {
            recommendedModes?.set(result.pageNumber, result.recommendedOutputMode);
        }
        if (result.recommendedOutputModeConfidence === undefined) {
            recommendedModeConfidences?.delete(result.pageNumber);
        } else {
            recommendedModeConfidences?.set(
                result.pageNumber,
                result.recommendedOutputModeConfidence,
            );
        }
        if (result.recommendedOutputModeReason === undefined) {
            recommendedModeReasons?.delete(result.pageNumber);
        } else {
            recommendedModeReasons?.set(result.pageNumber, result.recommendedOutputModeReason);
        }
        if (result.softAlphaForegroundRecommendation === undefined) {
            softAlphaForegroundRecommendations?.delete(result.pageNumber);
        } else {
            softAlphaForegroundRecommendations?.set(
                result.pageNumber,
                result.softAlphaForegroundRecommendation,
            );
        }
    }
}
