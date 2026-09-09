import type {
    TScanCleanupProgress,
    TScanCleanupProgressStage,
    TScanCleanupSummary,
    TScanCleanupSummaryWarningEvent,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';

import {formatScanCleanupWarningEvent} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';

type TStageWeights = ReadonlyArray<readonly [TScanCleanupProgressStage, number]>;

export type TEmitScanCleanupProgress = (
    stage: TScanCleanupProgressStage,
    completedUnits: number,
    totalUnits: number,
    completedPageNumbers?: Iterable<number>,
) => void;

function materializeCompletedPageNumbers(completedPageNumbers: Iterable<number>) {
    const pageNumbers: number[] = [];
    let truncated = false;
    for (const pageNumber of completedPageNumbers) {
        if (pageNumbers.length >= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES) {
            truncated = true;
            break;
        }
        pageNumbers.push(pageNumber);
    }
    return {
        pageNumbers,
        truncated,
    };
}

export function createEmptyScanCleanupSummary(
    inputPages: number,
    warnings: readonly string[],
    warningEvents: readonly TScanCleanupSummaryWarningEvent[] = [],
): TScanCleanupSummary {
    return {
        inputPages,
        outputPages: 0,
        spreadsSplit: 0,
        offcutsDiscarded: 0,
        deskewSkipped: 0,
        cropSkipped: 0,
        excludedPages: 0,
        blankPagesSkipped: 0,
        warnings: [...warnings],
        warningEvents: [...warningEvents],
    };
}

/**
 * Records one condition on a summary: the sentence the user reads and the typed
 * event it was formatted from, published together so a consumer never has to
 * read the sentence back to learn which condition a run raised.
 */
export function reportScanCleanupSummaryWarningEvent(
    summary: TScanCleanupSummary,
    entry: TScanCleanupSummaryWarningEvent,
    report: (message: string) => void,
) {
    // A summary a run built itself always carries the list; one decoded from a
    // run that predates this channel carries none, and the first event opens
    // it. Appending in place keeps a document that reports a condition per page
    // linear instead of copying the whole list once per page.
    if (summary.warningEvents === undefined) {
        summary.warningEvents = [entry];
    } else {
        summary.warningEvents.push(entry);
    }
    report(formatScanCleanupWarningEvent(entry.event, entry.pageNumber));
}

// Non-streaming transports really do materialize the complete raster handoff
// before native rendering starts, so they retain separate bands.
const RASTER_STAGE_WEIGHTS = [
    [
        'normalizing',
        1,
    ],
    [
        'probing',
        4,
    ],
    [
        'extracting',
        4,
    ],
    [
        'rasterizing',
        17,
    ],
    [
        'rendering',
        58,
    ],
    [
        'collecting',
        2,
    ],
    [
        'assembling',
        12,
    ],
    [
        'handoff',
        2,
    ],
] as const satisfies TStageWeights;

// FIFO production and native consumption are one pipeline. Native page
// completion is its authoritative counter; presenting producer completion as
// an earlier stage made the meter stall and then jump by most of its width.
const STREAMING_RASTER_STAGE_WEIGHTS = [
    [
        'normalizing',
        1,
    ],
    [
        'probing',
        3,
    ],
    [
        'extracting',
        6,
    ],
    [
        'rendering',
        78,
    ],
    [
        'collecting',
        1,
    ],
    [
        'assembling',
        9,
    ],
    [
        'handoff',
        2,
    ],
] as const satisfies TStageWeights;

const LOSSLESS_STAGE_WEIGHTS = [
    [
        'normalizing',
        3,
    ],
    [
        'probing',
        4,
    ],
    [
        'extracting',
        0,
    ],
    [
        'rasterizing',
        40,
    ],
    [
        'classifying',
        33,
    ],
    [
        'collecting',
        5,
    ],
    [
        'assembling',
        13,
    ],
    [
        'handoff',
        2,
    ],
] as const satisfies TStageWeights;

function resolveBands(weights: TStageWeights) {
    const totalWeight = weights.reduce((sum, [
        , weight,
    ]) => sum + weight, 0);
    const bands = new Map<TScanCleanupProgressStage, {
        start: number;
        span: number
    }>();
    let consumedWeight = 0;
    for (const [
        stage,
        weight,
    ] of weights) {
        bands.set(stage, {
            start: consumedWeight / totalWeight * 100,
            span: weight / totalWeight * 100,
        });
        consumedWeight += weight;
    }
    return bands;
}

// Both profiles are fixed tables, so they are laid out once rather than on
// every progress report a run emits.
const RASTER_BANDS = resolveBands(RASTER_STAGE_WEIGHTS);
const STREAMING_RASTER_BANDS = resolveBands(STREAMING_RASTER_STAGE_WEIGHTS);
const LOSSLESS_BANDS = resolveBands(LOSSLESS_STAGE_WEIGHTS);

const ETA_MIN_COMPLETED_UNITS = 5;
const ETA_MIN_STAGE_ELAPSED_MS = 10_000;
const ETA_EMA_ALPHA = 0.25;

/**
 * `isLossless` is read per report rather than captured: a matched run that
 * cannot keep a page's own pixels starts on the lossless profile and then
 * renders, and a profile fixed at the first report would leave the meter frozen
 * through the longest stage of the run it actually performed. The percentage
 * only ever moves forward, so the switch can hold it but never rewind it.
 *
 * `etaSeconds` covers the reporting stage alone. The stage weights calibrate how
 * the bar is laid out, not how long a stage takes, so pricing the stages still
 * ahead at the current stage's rate invented most of the number the meter showed
 * — and the caller already replaces that number with a finishing caption the
 * moment those stages begin. An estimate the meter discards once it becomes
 * checkable is worse than no estimate, so only measured work is reported.
 */
export function createScanCleanupProgressReporter(
    callback: (progress: TScanCleanupProgress) => void,
    isLossless: () => boolean,
    options: {
        isRasterStreaming?: () => boolean;
        now?: () => number
    } = {},
): TEmitScanCleanupProgress {
    const now = options.now ?? (() => performance.now());
    let lastPercent = 0;
    let activeStage: TScanCleanupProgressStage | null = null;
    let stageStartedAt = 0;
    let lastSampleAt = 0;
    let lastCompletedUnits = 0;
    let smoothedMsPerUnit: number | null = null;
    let lastEtaSeconds: number | undefined;
    return (stage, completedUnits, totalUnits, completedPageNumbers) => {
        const reportedAt = now();
        const profile = isLossless()
            ? {
                bands: LOSSLESS_BANDS,
                weights: LOSSLESS_STAGE_WEIGHTS,
            }
            : options.isRasterStreaming?.() === true
                ? {
                    bands: STREAMING_RASTER_BANDS,
                    weights: STREAMING_RASTER_STAGE_WEIGHTS,
                }
                : {
                    bands: RASTER_BANDS,
                    weights: RASTER_STAGE_WEIGHTS,
                };
        const stageIndex = profile.weights.findIndex(([profileStage]) => profileStage === stage) + 1;
        const bands = profile.bands;
        const band = bands.get(stage);
        const fraction = totalUnits > 0 ? Math.min(1, completedUnits / totalUnits) : 0;
        const percent = band === undefined ? lastPercent : band.start + (band.span * fraction);
        lastPercent = Math.min(100, Math.max(lastPercent, percent));
        if (activeStage !== stage || completedUnits < lastCompletedUnits) {
            activeStage = stage;
            stageStartedAt = reportedAt;
            lastSampleAt = reportedAt;
            lastCompletedUnits = completedUnits;
            smoothedMsPerUnit = null;
            // The floor exists to stop a displayed countdown from ticking
            // upward, which only holds within one stage's own units. Carried
            // across a stage boundary it would clamp the next stage's first
            // honest estimate down to the last few seconds of the previous one.
            lastEtaSeconds = undefined;
        } else if (completedUnits > lastCompletedUnits) {
            const sampleMsPerUnit = (reportedAt - lastSampleAt) / (completedUnits - lastCompletedUnits);
            if (Number.isFinite(sampleMsPerUnit) && sampleMsPerUnit >= 0) {
                smoothedMsPerUnit = smoothedMsPerUnit === null
                    ? sampleMsPerUnit
                    : smoothedMsPerUnit * (1 - ETA_EMA_ALPHA) + sampleMsPerUnit * ETA_EMA_ALPHA;
            }
            lastSampleAt = reportedAt;
            lastCompletedUnits = completedUnits;
        }
        let etaSeconds: number | undefined;
        if (
            band !== undefined
            && smoothedMsPerUnit !== null
            && completedUnits >= ETA_MIN_COMPLETED_UNITS
            && reportedAt - stageStartedAt >= ETA_MIN_STAGE_ELAPSED_MS
            && totalUnits > 0
        ) {
            const remainingStageMs = Math.max(0, totalUnits - completedUnits) * smoothedMsPerUnit;
            const estimatedSeconds = Math.max(0, Math.ceil(remainingStageMs / 1000));
            etaSeconds = lastEtaSeconds === undefined
                ? estimatedSeconds
                : Math.min(lastEtaSeconds, estimatedSeconds);
            lastEtaSeconds = etaSeconds;
        }
        const completedPageSnapshot = completedPageNumbers === undefined
            ? undefined
            : materializeCompletedPageNumbers(completedPageNumbers);
        callback({
            stage,
            completedUnits,
            totalUnits,
            percent: lastPercent,
            ...(stageIndex === 0 ? {} : {
                stageIndex,
                stageCount: profile.weights.length,
            }),
            ...(etaSeconds === undefined ? {} : {etaSeconds}),
            ...(completedPageSnapshot === undefined
                ? {}
                : {
                    completedPageNumbers: completedPageSnapshot.pageNumbers,
                    ...(completedPageSnapshot.truncated ? {completedPageNumbersTruncated: true} : {}),
                }),
        });
    };
}
