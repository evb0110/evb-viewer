import type {
    IScanCleanupOptions,
    IScanCleanupSourcePageMetadata,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupPlacementAnchorSummary,
    IScanCleanupPlacementAnchorSummarySample,
} from '@contracts/scan-cleanup/ipc';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupOutputPlacement,
    resolveScanCleanupPlacementAnchorResolution,
    SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM,
    SCAN_CLEANUP_OUTPUT_HALVES,
} from '@contracts/scanCleanupPageOverrides';
import {SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS} from '@contracts/scan-cleanup/inputLimits';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

const POINTS_PER_MM = 72 / 25.4;
/** Calibration never retains more than this many samples or clusters. */
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_SAMPLE_LIMIT = SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS;

export function resolveScanCleanupSheetHeightPoints(metadata: IScanCleanupSourcePageMetadata | undefined) {
    if (metadata === undefined) {
        return 0;
    }
    const swapsAxes = (((Math.round(metadata.rotation / 90) % 2) + 2) % 2) === 1;
    return swapsAxes ? metadata.widthPoints : metadata.heightPoints;
}

function resolveInkSample(
    result: IScanCleanupDetectionResult,
    options: IScanCleanupOptions,
    half: TScanCleanupOutputHalf,
    referenceHeightPoints: number,
): IScanCleanupPlacementAnchorSummarySample | undefined {
    const pageOverride = getScanCleanupPageOverride(options.pageOverrides, result.pageNumber);
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

function resolveSummaryAnchor(
    summary: Pick<
        IScanCleanupPlacementAnchorSummary,
        'clusters' | 'topEdgeNormalized' | 'toleranceNormalized'
    >,
    yNormalized: number,
) {
    const cluster = summary.clusters.find(candidate => (
        yNormalized >= candidate.startNormalized
        && yNormalized - candidate.startNormalized <= summary.toleranceNormalized
    ));
    const offset = Math.max(
        0,
        (cluster?.valueNormalized ?? yNormalized) - summary.topEdgeNormalized,
    );
    return {yNormalized: offset};
}

export function resolveScanCleanupPlacementAnchorFromSummary(
    summary: IScanCleanupPlacementAnchorSummary,
    yNormalized: number,
) {
    return resolveSummaryAnchor(summary, yNormalized);
}

/**
 * Build document-wide `ink` calibration without materializing the detection
 * store. The first pass finds the reference sheet height and sample count.
 * The second pass takes an evenly spaced calibration window, then keeps only
 * its bounded clusters plus early, middle, and late evidence samples.
 */
export async function buildScanCleanupPlacementAnchorSummary({
    options,
    resultStore,
    signal,
}: {
    options: IScanCleanupOptions;
    resultStore: IScanCleanupDetectionResultStore;
    signal: AbortSignal;
}): Promise<IScanCleanupPlacementAnchorSummary> {
    let referenceHeightPoints = 0;
    let sampleCount = 0;
    await resultStore.forEachChunk(results => {
        signal.throwIfAborted();
        for (const result of results) {
            const pageOverride = getScanCleanupPageOverride(options.pageOverrides, result.pageNumber);
            if (pageOverride.excluded) continue;
            referenceHeightPoints = Math.max(
                referenceHeightPoints,
                resolveScanCleanupSheetHeightPoints(result.sourcePageMetadata),
            );
            for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
                if (resolveInkSample(result, options, half, 0) !== undefined) {
                    sampleCount += 1;
                }
            }
        }
    });

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
        clusters: resolution.clusters,
        samples: [],
    };
    const resolvedSparseSamples = sparseSamples.map(sample => ({
        ...sample,
        anchor: resolveSummaryAnchor(summaryBase, sample.yNormalized),
    }));
    return {
        ...summaryBase,
        samples: resolvedSparseSamples,
    };
}
