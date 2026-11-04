import type {
    IScanCleanupDetectionResult,
    TScanCleanupDetectionJobState,
    TScanCleanupProgress,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TJobId} from '@contracts/shared';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {createEpochMs} from '@contracts/timestamps';
import {completedPageProgress} from '@evb/scan-cleanup/core/policy/scanCleanupDetectionResultPolicy';
import type {IScanCleanupDetectionOutcome} from '@evb/scan-cleanup/core/createScanCleanupDetectionRecorder';

/**
 * A detection frame with completed pages but none listed has a list bounded
 * to nothing, which the progress contract accepts only when marked so.
 */
export function normalizeDetectionProgress(progress: TScanCleanupProgress): TScanCleanupProgress {
    if (
        progress.completedUnits > 0
        && progress.completedPageNumbers?.length === 0
        && progress.completedPageNumbersTruncated !== true
    ) {
        return {
            ...progress,
            completedPageNumbersTruncated: true,
        };
    }
    return progress;
}

/** A detection job's state before its first frame. */
export function queuedScanCleanupDetectionJobState(jobId: TJobId): TScanCleanupDetectionJobState {
    return {
        jobId,
        status: 'queued',
        documentCanvasSignature: '',
        progress: {
            stage: 'queued',
            completedUnits: 0,
            totalUnits: 0,
            percent: 0,
            completedPageNumbers: [],
        },
        resultCount: 0,
        results: [],
        updatedAtMs: createEpochMs(),
    };
}

/** A running detection job's state for one published frame. */
export function runningScanCleanupDetectionJobState(
    jobId: TJobId,
    results: IScanCleanupDetectionResult[],
    progress: TScanCleanupProgress,
    documentCanvasSignature: string,
): TScanCleanupDetectionJobState {
    const normalizedProgress = normalizeDetectionProgress(progress);
    return {
        jobId,
        status: 'running',
        documentCanvasSignature,
        progress: normalizedProgress,
        resultCount: normalizedProgress.completedUnits,
        results,
        updatedAtMs: createEpochMs(),
    };
}

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
