import type {TScanCleanupDetectionJobState} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';

export const SCAN_CLEANUP_RENDERER_RESULT_WINDOW_PAGES = 256;

/**
 * Keep the persisted/native detection state bounded before it crosses the
 * renderer IPC boundary. The full result store remains available in the main
 * process for export and reconciliation.
 */
export function projectScanCleanupDetectionStateForRenderer(
    state: TScanCleanupDetectionJobState,
): TScanCleanupDetectionJobState {
    const isLargeDetectionState = state.progress.totalUnits > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        || (state.resultCount ?? 0) > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        || state.results.length > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        || state.progress.completedPageNumbersTruncated === true;
    if (!isLargeDetectionState) {
        return state;
    }
    const {
        completedPageNumbers: _completedPageNumbers,
        completedPageNumbersTruncated: _completedPageNumbersTruncated,
        ...progressWithoutCompletionList
    } = state.progress;
    const progress = {
        ...progressWithoutCompletionList,
        completedPageNumbers: [],
        completedPageNumbersTruncated: true,
    };
    const results = state.results.slice(-SCAN_CLEANUP_RENDERER_RESULT_WINDOW_PAGES).map(result => ({
        pageNumber: result.pageNumber,
        ...(result.revision === undefined ? {} : {revision: result.revision}),
        classification: result.classification,
        confidence: result.confidence,
        cutterXPx: result.cutterXPx,
        tier1Verdict: result.tier1Verdict,
        reconciled: result.reconciled,
        clusterAgreement: result.clusterAgreement,
        documentPrior: result.documentPrior,
        ...(result.textAxis === undefined ? {} : {textAxis: result.textAxis}),
        ...(result.pagePlanEvidence === undefined ? {} : {pagePlanEvidence: result.pagePlanEvidence}),
        ...(result.recommendedOutputMode === undefined ? {} : {recommendedOutputMode: result.recommendedOutputMode}),
        ...(result.recommendedOutputModeConfidence === undefined
            ? {}
            : {recommendedOutputModeConfidence: result.recommendedOutputModeConfidence}),
        ...(result.recommendedOutputModeReason === undefined
            ? {}
            : {recommendedOutputModeReason: result.recommendedOutputModeReason}),
        ...(result.softAlphaForegroundRecommendation === undefined
            ? {}
            : {softAlphaForegroundRecommendation: result.softAlphaForegroundRecommendation}),
    }));
    return {
        ...state,
        progress,
        results,
    };
}
