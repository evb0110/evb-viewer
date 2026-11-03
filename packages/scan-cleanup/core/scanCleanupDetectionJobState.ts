import type {
    IScanCleanupDetectionResult,
    TScanCleanupDetectionJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {createEpochMs} from '@contracts/timestamps';
import {completedPageProgress} from '@evb/scan-cleanup/core/policy/scanCleanupDetectionResultPolicy';
import type {IScanCleanupDetectionOutcome} from '@evb/scan-cleanup/core/createScanCleanupDetectionRecorder';

/** A finished detection, and the id its store is registered under when it outlives the job. */
export interface IScanCleanupDetectionJobResult extends IScanCleanupDetectionOutcome {resultStoreId?: string;}

/**
 * A detection job's terminal state: its final counts, the matched-canvas
 * signature it last published, and its results when the document is small
 * enough to carry them; a larger one names its retained store instead.
 */
export function completeScanCleanupDetectionJobState(
    latest: TScanCleanupDetectionJobState,
    result: IScanCleanupDetectionJobResult,
): TScanCleanupDetectionJobState {
    const resultCount = result.resultStore.resultCount;
    const pageCount = result.resultStore.pageCount;
    const results = resultCount <= SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ? result.results
        : [];
    return {
        jobId: latest.jobId,
        status: 'completed',
        documentCanvasSignature: latest.documentCanvasSignature ?? '',
        progress: {
            stage: 'detecting',
            completedUnits: resultCount,
            totalUnits: pageCount,
            percent: pageCount === 0 ? 100 : resultCount / pageCount * 100,
            ...completedPageProgress(new Set(results.map(item => item.pageNumber)), resultCount),
        },
        resultCount,
        blankPageCount: result.blankPageCount,
        ...(result.resultStoreId === undefined
            ? {}
            : {detectionResultStoreId: result.resultStoreId}),
        ...(result.placementAnchorSummary === undefined
            ? {}
            : {placementAnchorSummary: result.placementAnchorSummary}),
        results,
        updatedAtMs: createEpochMs(),
    };
}

const deliveredSignature = (result: IScanCleanupDetectionResult) => result.revision ?? JSON.stringify([
    result.classification,
    result.confidence,
    result.cutterXPx,
    result.tier1Verdict,
    result.reconciled,
    result.clusterAgreement,
    result.documentPrior,
    result.textAxis,
    result.recommendedOutputMode,
    result.recommendedOutputModeConfidence,
    result.recommendedOutputModeReason,
    result.softAlphaForegroundRecommendation,
    result.pagePlanEvidence,
]);

/**
 * The results a live small-document state carries that its subscriber has not
 * received yet, marking them delivered. A subscriber rebuilds from a full
 * snapshot, so its cursor starts empty whenever it subscribes.
 */
export function selectUndeliveredScanCleanupDetectionResults(
    delivered: Map<number, number | string>,
    results: readonly IScanCleanupDetectionResult[],
) {
    return results.filter(result => {
        const signature = deliveredSignature(result);
        if (delivered.get(result.pageNumber) === signature) {
            return false;
        }
        delivered.set(result.pageNumber, signature);
        return true;
    });
}
