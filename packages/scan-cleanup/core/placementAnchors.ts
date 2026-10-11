import type {
    IScanCleanupOptions,
    TScanCleanupOutputHalf,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPlacementAnchorSummaryIdentity,
} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_OUTPUT_HALVES} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    addScanCleanupInkReferenceSheet,
    collectScanCleanupSheetInkTops,
    createScanCleanupInkReference,
    resolveScanCleanupInkScale,
    resolveScanCleanupPlacementAnchorResolution,
    resolveScanCleanupSheetAnchors,
    type IScanCleanupInkSheet,
    type IScanCleanupPlacementAnchorSample,
    type IScanCleanupSnappedInkTop,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS} from '@contracts/scan-cleanup/inputLimits';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

/** Calibration never retains more than this many samples or clusters. */
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SAMPLE_LIMIT = SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS;

export function toScanCleanupInkSheet(result: IScanCleanupDetectionResult): IScanCleanupInkSheet {
    return {
        pageNumber: result.pageNumber,
        layoutClassification: result.classification,
        evidence: result.pagePlanEvidence,
        metadata: result.sourcePageMetadata,
    };
}

function resolveSummaryInkTop(
    summary: Pick<IScanCleanupPlacementAnchorSummary, 'clusters' | 'toleranceNormalized'>,
    yNormalized: number,
): IScanCleanupSnappedInkTop {
    // A calibrated sample lies inside its own cluster. A page outside the
    // calibration window joins the nearest cluster that would still span at
    // most the tolerance with it, and otherwise keeps its own position.
    let cluster = summary.clusters.find(candidate => (
        yNormalized >= candidate.startNormalized
        && yNormalized <= candidate.endNormalized
    ));
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of cluster === undefined ? summary.clusters : []) {
        const span = Math.max(candidate.endNormalized, yNormalized)
            - Math.min(candidate.startNormalized, yNormalized);
        const distance = Math.max(candidate.startNormalized - yNormalized, yNormalized - candidate.endNormalized);
        if (span <= summary.toleranceNormalized && distance < nearestDistance) {
            cluster = candidate;
            nearestDistance = distance;
        }
    }
    return {
        yNormalized,
        snappedNormalized: cluster?.valueNormalized ?? yNormalized,
        support: cluster?.size ?? 1,
    };
}

/**
 * Anchors for the `ink` outputs of one source sheet, keyed by output half and
 * given as measured ink tops on the reference height. The sheet's outputs are
 * resolved together because a spread moves as one sheet.
 */
export function resolveScanCleanupSheetAnchorsFromSummary(
    summary: Pick<
        IScanCleanupPlacementAnchorSummary,
        'clusters' | 'topEdgeNormalized' | 'toleranceNormalized'
    >,
    inkTops: Partial<Record<TScanCleanupOutputHalf, number>>,
) {
    const snapped: Partial<Record<TScanCleanupOutputHalf, IScanCleanupSnappedInkTop>> = {};
    for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
        const yNormalized = inkTops[half];
        if (yNormalized !== undefined) {
            snapped[half] = resolveSummaryInkTop(summary, yNormalized);
        }
    }
    return resolveScanCleanupSheetAnchors(snapped, summary.topEdgeNormalized);
}

export function resolveScanCleanupPlacementAnchorsFromResult(
    summary: IScanCleanupPlacementAnchorSummary,
    options: IScanCleanupOptions,
    result: IScanCleanupDetectionResult,
): IScanCleanupPlacementAnchorCalibration['placementAnchors'] {
    return resolveScanCleanupSheetAnchorsFromSummary(
        summary,
        collectScanCleanupSheetInkTops(options, toScanCleanupInkSheet(result), summary.referenceHeightPoints),
    );
}

/**
 * Build document-wide `ink` calibration without materializing the detection
 * store. The first pass finds the reference sheet height (the dominant paper's,
 * which the matched canvas also uses) and the sample count. The second pass
 * takes an evenly spaced calibration window and keeps its bounded clusters.
 */
export async function buildScanCleanupPlacementAnchorSummary({
    options,
    resultStore,
    signal,
    identity,
}: {
    options: IScanCleanupOptions;
    resultStore: IScanCleanupDetectionResultStore;
    signal: AbortSignal;
    identity: IScanCleanupPlacementAnchorSummaryIdentity;
}): Promise<IScanCleanupPlacementAnchorSummary> {
    const reference = createScanCleanupInkReference();
    let sampleCount = 0;
    await resultStore.forEachChunk(results => {
        signal.throwIfAborted();
        for (const result of results) {
            const sheet = toScanCleanupInkSheet(result);
            addScanCleanupInkReferenceSheet(reference, options, sheet);
            sampleCount += Object.keys(collectScanCleanupSheetInkTops(options, sheet, 0)).length;
        }
    });

    const {
        referenceHeightPoints,
        toleranceNormalized,
    } = resolveScanCleanupInkScale(reference);
    const candidateCount = Math.min(
        SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SAMPLE_LIMIT,
        sampleCount,
    );
    const targetOrdinalSet = new Set(candidateCount <= 1
        ? (candidateCount === 0 ? [] : [0])
        : Array.from(
            {length: candidateCount},
            (_, index) => Math.floor(index * (sampleCount - 1) / (candidateCount - 1)),
        ));
    const candidates: IScanCleanupPlacementAnchorSample[] = [];
    let ordinal = 0;
    await resultStore.forEachChunk(results => {
        signal.throwIfAborted();
        for (const result of results) {
            const inkTops = collectScanCleanupSheetInkTops(options, toScanCleanupInkSheet(result), referenceHeightPoints);
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                const yNormalized = inkTops[half];
                if (yNormalized === undefined) continue;
                if (targetOrdinalSet.has(ordinal)) {
                    candidates.push({
                        pageNumber: result.pageNumber,
                        half,
                        yNormalized,
                    });
                }
                ordinal += 1;
            }
        }
    });
    if (ordinal !== sampleCount) {
        throw new Error(
            `Scan cleanup placement summary observed ${String(ordinal)} samples after counting ${String(sampleCount)}`,
        );
    }

    const resolution = resolveScanCleanupPlacementAnchorResolution(
        candidates,
        toleranceNormalized,
    );
    return {
        schemaVersion: 1,
        sampleCount,
        referenceHeightPoints,
        toleranceNormalized,
        topEdgeNormalized: resolution.topEdgeNormalized,
        identity,
        clusters: resolution.clusters,
    };
}
