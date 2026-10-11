import type {
    IScanCleanupOptions,
    IScanCleanupSourcePageMetadata,
    TScanCleanupOutputHalf,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPlacementAnchorSummarySample,
    IScanCleanupPlacementAnchorSummaryIdentity,
} from '@contracts/scan-cleanup/ipc';
import {
    getScanCleanupPageOverride,
    SCAN_CLEANUP_OUTPUT_HALVES,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPlacementAnchorResolution,
    resolveScanCleanupSheetInkTops,
    SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM,
    type IScanCleanupSnappedInkTop,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS} from '@contracts/scan-cleanup/inputLimits';
import {
    addScanCleanupPaperCohortRect,
    createScanCleanupPaperCohortTally,
    resolveScanCleanupInkReferenceHeightPoints,
    resolveScanCleanupSheetRect,
} from '@evb/scan-cleanup/core/policy/scanCleanupPaperCohort';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

const POINTS_PER_MM = 72 / 25.4;
/** Calibration never retains more than this many samples or clusters. */
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SAMPLE_LIMIT = SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS;

export function resolveScanCleanupSheetHeightPoints(metadata: IScanCleanupSourcePageMetadata | undefined) {
    return resolveScanCleanupSheetRect(metadata)?.heightPoints ?? 0;
}

function resolveInkSample(
    result: IScanCleanupDetectionResult,
    options: IScanCleanupOptions,
    half: TScanCleanupOutputHalf,
    referenceHeightPoints: number,
): IScanCleanupPlacementAnchorSummarySample | undefined {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        result.pageNumber,
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    if (
        pageOverride.excluded
        || resolveScanCleanupOutputPlacement(options.pageAlignment, pageOverride, half) !== 'ink'
    ) {
        return undefined;
    }
    const contentBox = pageOverride.manualContentBoxes?.[half]
        ?? result.pagePlanEvidence?.outputs[half]?.contentBox;
    if (contentBox === undefined) {
        return undefined;
    }
    const sheetHeightPoints = resolveScanCleanupSheetHeightPoints(result.sourcePageMetadata);
    const measured = referenceHeightPoints > 0 && sheetHeightPoints > 0;
    const scale = measured ? sheetHeightPoints / referenceHeightPoints : 1;
    return {
        pageNumber: result.pageNumber,
        half,
        yNormalized: contentBox.yNormalized * scale,
        anchor: {yNormalized: 0},
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
    const anchors: Partial<Record<TScanCleanupOutputHalf, {yNormalized: number}>> = {};
    for (const [
        half,
        placed,
    ] of Object.entries(resolveScanCleanupSheetInkTops(snapped)) as Array<[TScanCleanupOutputHalf, number]>) {
        anchors[half] = {yNormalized: Math.max(0, placed - summary.topEdgeNormalized)};
    }
    return anchors;
}

export function resolveScanCleanupPlacementAnchorsFromResult(
    summary: IScanCleanupPlacementAnchorSummary,
    options: IScanCleanupOptions,
    result: IScanCleanupDetectionResult,
): IScanCleanupPlacementAnchorCalibration['placementAnchors'] {
    const inkTops: Partial<Record<TScanCleanupOutputHalf, number>> = {};
    for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
        const sample = resolveInkSample(result, options, half, summary.referenceHeightPoints);
        if (sample !== undefined) {
            inkTops[half] = sample.yNormalized;
        }
    }
    return resolveScanCleanupSheetAnchorsFromSummary(summary, inkTops);
}

/**
 * Build document-wide `ink` calibration without materializing the detection
 * store. The first pass finds the reference sheet height (the dominant paper's,
 * which the matched canvas also uses) and the sample count.
 * The second pass takes an evenly spaced calibration window, then keeps only
 * its bounded clusters plus early, middle, and late evidence samples.
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
    const sheets = createScanCleanupPaperCohortTally();
    let sampleCount = 0;
    await resultStore.forEachChunk(results => {
        signal.throwIfAborted();
        for (const result of results) {
            const pageOverride = getScanCleanupPageOverride(
                options.pageOverrides,
                result.pageNumber,
                options.pageOverrideDefaults,
                options.marginsMm,
            );
            if (pageOverride.excluded) continue;
            const sheet = resolveScanCleanupSheetRect(result.sourcePageMetadata);
            if (sheet !== null) {
                addScanCleanupPaperCohortRect(sheets, sheet, result.classification === 'two-page-spread' ? 2 : 1);
            }
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                if (resolveInkSample(result, options, half, 0) !== undefined) {
                    sampleCount += 1;
                }
            }
        }
    });

    const referenceHeightPoints = resolveScanCleanupInkReferenceHeightPoints(sheets);
    const candidateCount = Math.min(
        SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SAMPLE_LIMIT,
        sampleCount,
    );
    const targetOrdinals = candidateCount <= 1
        ? (candidateCount === 0 ? [] : [0])
        : Array.from(
            {length: candidateCount},
            (_, index) => Math.floor(index * (sampleCount - 1) / (candidateCount - 1)),
        );
    const targetOrdinalSet = new Set(targetOrdinals);
    const sparseOrdinalSet = new Set([
        0,
        Math.floor((sampleCount - 1) / 2),
        sampleCount - 1,
    ]);
    const candidates: IScanCleanupPlacementAnchorSummarySample[] = [];
    const sparseSamples: IScanCleanupPlacementAnchorSummarySample[] = [];
    let ordinal = 0;
    await resultStore.forEachChunk(results => {
        signal.throwIfAborted();
        for (const result of results) {
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                const sample = resolveInkSample(result, options, half, referenceHeightPoints);
                if (sample === undefined) continue;
                if (targetOrdinalSet.has(ordinal)) {
                    candidates.push(sample);
                }
                if (sparseOrdinalSet.has(ordinal)) {
                    sparseSamples.push(sample);
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

    const toleranceNormalized = referenceHeightPoints > 0
        ? SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM * POINTS_PER_MM / referenceHeightPoints
        : 0;
    const resolution = resolveScanCleanupPlacementAnchorResolution(
        candidates,
        toleranceNormalized,
    );
    const summaryBase: IScanCleanupPlacementAnchorSummary = {
        schemaVersion: 1,
        sampleCount,
        referenceHeightPoints,
        toleranceNormalized,
        topEdgeNormalized: resolution.topEdgeNormalized,
        identity,
        clusters: resolution.clusters,
        samples: [],
    };
    const resolvedSparseSamples = sparseSamples.map(sample => ({
        ...sample,
        anchor: resolveScanCleanupSheetAnchorsFromSummary(summaryBase, {[sample.half]: sample.yNormalized})[sample.half]
            ?? {yNormalized: 0},
    }));
    return {
        ...summaryBase,
        samples: resolvedSparseSamples,
    };
}
