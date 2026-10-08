import type {IScanCleanupSourcePageMetadata} from '@contracts/scan-cleanup/electronApiScanCleanup';

/**
 * Which paper size a document mostly is.
 *
 * A scanned book is hundreds of leaves of one size plus a cover, endpapers or
 * a fold-out of another. The matched canvas and the ink-placement reference
 * both have to be the leaves' paper: sizing them to the largest sheet blows
 * every ordinary leaf up to the cover. Sizes are grouped on a 1% logarithmic
 * grid so a scanner's per-page crop jitter stays one cohort, and a cohort
 * speaks for the document only when it holds at least three quarters of its
 * pages. A genuinely mixed document has no dominant paper, and callers keep
 * their fallback, the largest sheet.
 *
 * The tally is bounded: it tracks at most `MAX_COHORTS` distinct sizes and
 * counts everything else only in the total, so a document of any length stays
 * a constant-size summary.
 */
export interface IScanCleanupPaperRect {
    widthPoints: number;
    heightPoints: number;
}

interface IScanCleanupPaperCohort {
    count: number;
    /** The largest actual rectangle seen in this bucket. */
    rect: IScanCleanupPaperRect;
}

export interface IScanCleanupPaperCohortTally {
    total: number;
    /** Tallest valid rectangle seen, tracked or not. */
    tallestHeightPoints: number;
    cohorts: Map<string, IScanCleanupPaperCohort>;
}

const COHORT_STEP = Math.log(1.01);
const MAX_COHORTS = 64;

export function createScanCleanupPaperCohortTally(): IScanCleanupPaperCohortTally {
    return {
        total: 0,
        tallestHeightPoints: 0,
        cohorts: new Map(),
    };
}

function cohortCoordinates(rect: IScanCleanupPaperRect) {
    return [
        Math.round(Math.log(rect.widthPoints) / COHORT_STEP),
        Math.round(Math.log(rect.heightPoints) / COHORT_STEP),
    ] as const;
}

function cohortKey(widthStep: number, heightStep: number) {
    return `${String(widthStep)}:${String(heightStep)}`;
}

/** Larger by area, then width, then height: one answer for any arrival order. */
export function isLargerScanCleanupPaperRect(
    candidate: IScanCleanupPaperRect,
    current: IScanCleanupPaperRect | null,
) {
    if (current === null) {
        return true;
    }
    const area = candidate.widthPoints * candidate.heightPoints;
    const currentArea = current.widthPoints * current.heightPoints;
    return area > currentArea
        || (area === currentArea && candidate.widthPoints > current.widthPoints)
        || (area === currentArea
            && candidate.widthPoints === current.widthPoints
            && candidate.heightPoints > current.heightPoints);
}

export function addScanCleanupPaperCohortRect(
    tally: IScanCleanupPaperCohortTally,
    rect: IScanCleanupPaperRect,
) {
    tally.total += 1;
    if (!(rect.widthPoints > 0 && rect.heightPoints > 0)
        || !Number.isFinite(rect.widthPoints)
        || !Number.isFinite(rect.heightPoints)) {
        return;
    }
    tally.tallestHeightPoints = Math.max(tally.tallestHeightPoints, rect.heightPoints);
    const key = cohortKey(...cohortCoordinates(rect));
    const cohort = tally.cohorts.get(key);
    if (cohort !== undefined) {
        cohort.count += 1;
        if (isLargerScanCleanupPaperRect(rect, cohort.rect)) {
            cohort.rect = {...rect};
        }
        return;
    }
    if (tally.cohorts.size < MAX_COHORTS) {
        tally.cohorts.set(key, {
            count: 1,
            rect: {...rect},
        });
    }
}

export function mergeScanCleanupPaperCohortTallies(
    tallies: readonly IScanCleanupPaperCohortTally[],
): IScanCleanupPaperCohortTally {
    const merged = createScanCleanupPaperCohortTally();
    for (const tally of tallies) {
        merged.total += tally.total;
        merged.tallestHeightPoints = Math.max(merged.tallestHeightPoints, tally.tallestHeightPoints);
        for (const [
            key,
            cohort,
        ] of tally.cohorts) {
            const existing = merged.cohorts.get(key);
            if (existing === undefined) {
                merged.cohorts.set(key, {
                    count: cohort.count,
                    rect: {...cohort.rect},
                });
            } else {
                existing.count += cohort.count;
                if (isLargerScanCleanupPaperRect(cohort.rect, existing.rect)) {
                    existing.rect = {...cohort.rect};
                }
            }
        }
    }
    return merged;
}

/**
 * The paper at least three quarters of the tallied pages share, as the largest
 * actual rectangle among them, or null when no size holds that share. A
 * size and its immediate grid neighbours count as one cohort, so a size that
 * straddles a grid line is not split in two.
 */
export function resolveScanCleanupDominantPaperRect(
    tally: IScanCleanupPaperCohortTally,
): IScanCleanupPaperRect | null {
    let best: {
        count: number;
        rect: IScanCleanupPaperRect
    } | null = null;
    for (const key of tally.cohorts.keys()) {
        const [
            widthStep,
            heightStep,
        ] = key.split(':').map(Number) as [number, number];
        let count = 0;
        let rect: IScanCleanupPaperRect | null = null;
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                const neighbour = tally.cohorts.get(cohortKey(widthStep + dx, heightStep + dy));
                if (neighbour === undefined) continue;
                count += neighbour.count;
                if (isLargerScanCleanupPaperRect(neighbour.rect, rect)) {
                    rect = neighbour.rect;
                }
            }
        }
        if (rect === null) continue;
        if (best === null
            || count > best.count
            || (count === best.count && isLargerScanCleanupPaperRect(rect, best.rect))) {
            best = {
                count,
                rect,
            };
        }
    }
    return best !== null && best.count * 4 >= tally.total * 3
        ? {...best.rect}
        : null;
}

/**
 * The sheet height ink placement measures every page against: the dominant
 * paper's, which is the matched canvas's, or the tallest sheet's when the
 * document has no dominant paper. 0 when no sheet could be measured.
 */
export function resolveScanCleanupInkReferenceHeightPoints(sheets: IScanCleanupPaperCohortTally) {
    return resolveScanCleanupDominantPaperRect(sheets)?.heightPoints ?? sheets.tallestHeightPoints;
}

/** A source sheet as the reader sees it, turned by its display rotation. */
export function resolveScanCleanupSheetRect(
    metadata: Pick<IScanCleanupSourcePageMetadata, 'widthPoints' | 'heightPoints' | 'rotation'> | undefined,
): IScanCleanupPaperRect | null {
    if (metadata === undefined) {
        return null;
    }
    const swapsAxes = (((Math.round(metadata.rotation / 90) % 2) + 2) % 2) === 1;
    return swapsAxes
        ? {
            widthPoints: metadata.heightPoints,
            heightPoints: metadata.widthPoints,
        }
        : {
            widthPoints: metadata.widthPoints,
            heightPoints: metadata.heightPoints,
        };
}
