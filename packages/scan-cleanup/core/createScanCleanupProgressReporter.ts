import type {
    TScanCleanupProgress,
    TScanCleanupProgressStage,
    TScanCleanupSubPageStage,
    TScanCleanupSummary,
    TScanCleanupSummaryWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';

import {formatScanCleanupWarningEvent} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';

type TStageWeights = ReadonlyArray<readonly [TScanCleanupProgressStage, number]>;

export interface IScanCleanupProgressEmitOptions {
    /** Monotonic caller-owned version for reusing a materialized `completedPageNumbers` snapshot. */
    completedPagesVersion?: number;
    rasterizedUnits?: number;
    activePageNumbers?: Iterable<number>;
    activeSubPageStage?: TScanCleanupSubPageStage | undefined;
}

export type TEmitScanCleanupProgress = (
    stage: TScanCleanupProgressStage,
    completedUnits: number,
    totalUnits: number,
    completedPageNumbers?: Iterable<number>,
    options?: IScanCleanupProgressEmitOptions,
) => void;

export interface IScanCleanupActivePageSnapshot {
    activePageNumbers?: number[];
    activeSubPageStage?: TScanCleanupSubPageStage;
}

/**
 * Single owner of in-flight page numbers and their latest sub-page processing
 * stage across desktop sidecar workers and browser WASM lanes.
 */
export function createScanCleanupActivePageTracker() {
    const activePages = new Set<number>();
    const stageByPage = new Map<number, TScanCleanupSubPageStage>();
    let latestStage: TScanCleanupSubPageStage | undefined;
    let latestStagePage: number | undefined;

    const refreshLatestStage = () => {
        if (activePages.size === 0) {
            latestStage = undefined;
            latestStagePage = undefined;
            return;
        }
        if (latestStagePage !== undefined && activePages.has(latestStagePage)) {
            return;
        }
        latestStage = undefined;
        latestStagePage = undefined;
        for (const [
            pageNumber,
            stage,
        ] of stageByPage) {
            if (activePages.has(pageNumber)) {
                latestStage = stage;
                latestStagePage = pageNumber;
            }
        }
    };

    return {
        start(pageNumber: number) {
            activePages.add(pageNumber);
        },
        setStage(pageNumber: number, stage: TScanCleanupSubPageStage) {
            activePages.add(pageNumber);
            stageByPage.delete(pageNumber);
            stageByPage.set(pageNumber, stage);
            latestStage = stage;
            latestStagePage = pageNumber;
        },
        clearStage(pageNumber: number) {
            const removed = stageByPage.delete(pageNumber);
            if (removed && latestStagePage === pageNumber) {
                latestStagePage = undefined;
                refreshLatestStage();
            }
            return removed;
        },
        finish(pageNumber: number) {
            const removed = activePages.delete(pageNumber);
            stageByPage.delete(pageNumber);
            if (removed) {refreshLatestStage();}
            return removed;
        },
        clear() {
            activePages.clear();
            stageByPage.clear();
            latestStage = undefined;
            latestStagePage = undefined;
        },
        snapshot(): IScanCleanupActivePageSnapshot {
            if (activePages.size === 0) {
                return {};
            }
            const pageNumbers = Array.from(activePages)
                .sort((left, right) => left - right)
                .slice(0, SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
            return {
                activePageNumbers: pageNumbers,
                ...(latestStage === undefined ? {} : {activeSubPageStage: latestStage}),
            };
        },
    };
}

function materializeUniquePageNumbers(pageNumbers: Iterable<number>) {
    const unique = new Set<number>();
    for (const pageNumber of pageNumbers) {
        if (unique.size >= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES) {
            break;
        }
        if (Number.isSafeInteger(pageNumber) && pageNumber >= 1) {
            unique.add(pageNumber);
        }
    }
    return [...unique];
}

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

export function createScanCleanupSummaryWarningReporter(
    summary: TScanCleanupSummary,
    log: (level: 'warn' | 'error', message: string) => void,
) {
    return (message: string, level: 'warn' | 'error' = 'warn') => {
        summary.warnings.push(message);
        log(level, `Scan cleanup: ${message}`);
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

// The raster handoff is materialized before native rendering starts, so each
// phase keeps its own progress band.
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
const LOSSLESS_BANDS = resolveBands(LOSSLESS_STAGE_WEIGHTS);

const ETA_MIN_COMPLETED_UNITS = 5;
const ETA_MIN_STAGE_ELAPSED_MS = 10_000;

export interface IScanCleanupProgressEtaEstimator {update: (
    stage: TScanCleanupProgressStage,
    completedUnits: number,
    totalUnits: number,
    reportedAt: number,
) => number | undefined;}

/**
 * Estimate the work remaining in the current progress stage. Both conversion
 * and detection publish the same progress contract, so keeping the clock here
 * prevents the renderer from inventing a second estimate from event timing.
 */
export function createScanCleanupProgressEtaEstimator(): IScanCleanupProgressEtaEstimator {
    let activeStage: TScanCleanupProgressStage | null = null;
    let stageStartedAt = 0;
    let completedAtStageStart = 0;

    return {update(stage, completedUnits, totalUnits, reportedAt) {
        if (activeStage !== stage || completedUnits < completedAtStageStart) {
            activeStage = stage;
            stageStartedAt = reportedAt;
            completedAtStageStart = completedUnits;
        }
        const completedWithinStage = completedUnits - completedAtStageStart;
        const elapsedSinceStageStart = reportedAt - stageStartedAt;
        if (
            completedWithinStage < ETA_MIN_COMPLETED_UNITS
                || elapsedSinceStageStart < ETA_MIN_STAGE_ELAPSED_MS
                || totalUnits <= 0
        ) {
            return undefined;
        }
        const averageMsPerUnit = elapsedSinceStageStart / completedWithinStage;
        if (!Number.isFinite(averageMsPerUnit) || averageMsPerUnit < 0) {
            return undefined;
        }
        return Math.max(
            0,
            Math.ceil(Math.max(0, totalUnits - completedUnits) * averageMsPerUnit / 1000),
        );
    }};
}

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
    options: {now?: () => number} = {},
): TEmitScanCleanupProgress {
    const now = options.now ?? (() => performance.now());
    let lastPercent = 0;
    const etaEstimator = createScanCleanupProgressEtaEstimator();
    let cachedCompletedPages: {
        source: Iterable<number>;
        version: number;
        snapshot: {
            pageNumbers: number[];
            truncated: boolean;
        };
    } | null = null;
    const resolveCompletedPageSnapshot = (
        completedPageNumbers: Iterable<number> | undefined,
        completedPagesVersion: number | undefined,
    ) => {
        if (completedPageNumbers === undefined) {
            cachedCompletedPages = null;
            return undefined;
        }
        if (
            completedPagesVersion !== undefined
            && cachedCompletedPages !== null
            && cachedCompletedPages.source === completedPageNumbers
            && cachedCompletedPages.version === completedPagesVersion
        ) {
            return cachedCompletedPages.snapshot;
        }
        const snapshot = materializeCompletedPageNumbers(completedPageNumbers);
        cachedCompletedPages = completedPagesVersion === undefined
            ? null
            : {
                source: completedPageNumbers,
                version: completedPagesVersion,
                snapshot,
            };
        return snapshot;
    };
    return (stage, completedUnits, totalUnits, completedPageNumbers, progressOptions) => {
        const reportedAt = now();
        const profile = isLossless()
            ? {
                bands: LOSSLESS_BANDS,
                weights: LOSSLESS_STAGE_WEIGHTS,
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
        // A run has no ETA for an unweighted stage. Detection uses the same
        // estimator directly because its progress bands are intentionally
        // separate from conversion's weighted percentage profile.
        const etaSeconds = band === undefined
            ? undefined
            : etaEstimator.update(stage, completedUnits, totalUnits, reportedAt);
        const completedPageSnapshot = resolveCompletedPageSnapshot(
            completedPageNumbers,
            progressOptions?.completedPagesVersion,
        );
        const rasterizedUnits = progressOptions?.rasterizedUnits === undefined
            ? undefined
            : Math.min(totalUnits, Math.max(0, Math.trunc(progressOptions.rasterizedUnits)));
        const activePageNumbers = progressOptions?.activePageNumbers === undefined
            ? undefined
            : materializeUniquePageNumbers(progressOptions.activePageNumbers);
        const activeSubPageStage = progressOptions?.activeSubPageStage;
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
            ...(rasterizedUnits === undefined ? {} : {rasterizedUnits}),
            ...(completedPageSnapshot === undefined
                ? {}
                : {
                    completedPageNumbers: completedPageSnapshot.pageNumbers,
                    ...(completedPageSnapshot.truncated ? {completedPageNumbersTruncated: true} : {}),
                }),
            ...(activePageNumbers === undefined || activePageNumbers.length === 0 ? {} : {activePageNumbers}),
            ...(activeSubPageStage === undefined ? {} : {activeSubPageStage}),
        });
    };
}
