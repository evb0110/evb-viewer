import type {TPageNumber} from '@contracts/pageNumbers';
import {
    parsePageNumber,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupLayoutByPage,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/domain';
import {SCAN_CLEANUP_OUTPUT_HALVES} from '@contracts/scan-cleanup/domain';
import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/geometry';
import type {
    IScanCleanupPagePlanEvidence,
    IScanCleanupPlacementAnchorSummaryCluster,
    IScanCleanupPreviewMetadata,
    IScanCleanupSourcePageMetadata,
} from '@contracts/scan-cleanup/ipc';
import type {IScanCleanupPlacementAnchor} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    attachScanCleanupPageOverrideDefaults,
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    getScanCleanupPageOverrideDefaults,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    addScanCleanupPaperCohortRect,
    createScanCleanupPaperCohortTally,
    resolveScanCleanupInkReferenceHeightPoints,
    resolveScanCleanupSheetRect,
    type IScanCleanupPaperCohortTally,
} from '@evb/scan-cleanup/core/policy/scanCleanupPaperCohort';

export type TScanCleanupResolvedPageLayout = ReturnType<typeof resolveScanCleanupPageLayout>;

export function usesScanCleanupInkAlignment(options: IScanCleanupOptions) {
    return options.matchPageSize
        && (options.pageAlignment === 'ink'
            || Object.values(options.pageOverrideDefaults?.placementOverrides ?? {})
                .some(alignment => alignment === 'ink')
            || Object.values(options.pageOverrides).some(override => Object
                .values(override.placementOverrides ?? {})
                .some(alignment => alignment === 'ink')));
}

export function resolveScanCleanupMarginsMm(
    documentMargins: IScanCleanupMarginsMm,
    override: Pick<IScanCleanupPageOverride, 'marginsMm'>,
) {
    return override.marginsMm ?? documentMargins;
}

export function resolveScanCleanupOutputPlacement(
    documentDefault: IScanCleanupOptions['pageAlignment'],
    override: Pick<IScanCleanupPageOverride, 'placementOverrides'>,
    half: IScanCleanupPreviewMetadata['half'],
) {
    return override.placementOverrides?.[half] ?? documentDefault;
}

/**
 * Two anchors closer than this on the finished page are the same position as
 * far as a reader flipping pages is concerned, so `ink` snaps them together
 * rather than reproducing the scanner's jitter.
 */
export const SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM = 4;

/**
 * One output's measured ink top: where its content box starts, as a fraction
 * of the document's reference height — the tallest rotated source sheet, the
 * rectangle the matched canvas settles on. Boxes are local to the output half
 * but normalized against their own whole sheet, and a vertical position is the
 * same in both frames, so the box's top rescaled onto the reference height is
 * the sample; the tolerance is expressed against that same height.
 */
export interface IScanCleanupPlacementAnchorSample extends IScanCleanupPlacementAnchor {
    pageNumber: TPageNumber;
    half: TScanCleanupOutputHalf;
}

export type TScanCleanupPlacementAnchorsByPage = Map<
    number,
    Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>>
>;

/**
 * The lower median. Every value between the two central members of an
 * even-sized cluster minimizes the total distance moved equally, so taking a
 * member rather than their mean keeps the snapped position one the document
 * actually measured, and taking the lower one keeps the choice free of
 * floating-point tie-breaks.
 */
function resolveScanCleanupAnchorClusterValue(sorted: readonly number[]) {
    const value = sorted[(sorted.length - 1) >> 1];
    if (value === undefined) {
        throw new RangeError('Anchor cluster must contain at least one sample');
    }
    return value;
}

interface IScanCleanupAnchorCluster {
    start: number;
    end: number;
    value: number;
    size: number;
}

/**
 * One output's measured ink top, the position its cluster snapped it to, and
 * how many outputs share that position.
 */
export interface IScanCleanupSnappedInkTop {
    yNormalized: number;
    snappedNormalized: number;
    support: number;
}

/**
 * Where the outputs of one scanned sheet print, as anchors below the document's
 * top edge. The halves of a spread were exposed together, so the scanner's
 * offset is the same in both, and moving them by different amounts would print
 * facing pages at heights the book never had. The sheet moves as one, by the
 * correction of the half whose snapped position the most outputs share; a tie
 * keeps the smaller move. An anchor is a fraction of the canvas below the top
 * margin, so a correction that would carry the lower half past the canvas is
 * cut back for the whole sheet. Ink above the top edge still sits at the margin.
 */
export function resolveScanCleanupSheetAnchors(
    inkTops: Partial<Record<TScanCleanupOutputHalf, IScanCleanupSnappedInkTop>>,
    topEdgeNormalized: number,
): Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>> {
    let correction: number | undefined;
    let support = 0;
    let lowestTop = Number.NEGATIVE_INFINITY;
    for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
        const inkTop = inkTops[half];
        if (inkTop === undefined) {
            continue;
        }
        lowestTop = Math.max(lowestTop, inkTop.yNormalized);
        const candidate = inkTop.snappedNormalized - inkTop.yNormalized;
        if (
            correction === undefined
            || inkTop.support > support
            || (inkTop.support === support && Math.abs(candidate) < Math.abs(correction))
        ) {
            correction = candidate;
            support = inkTop.support;
        }
    }
    const anchors: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPlacementAnchor>> = {};
    if (correction === undefined) {
        return anchors;
    }
    const sheetCorrection = Math.min(correction, topEdgeNormalized + 1 - lowestTop);
    for (const half of SCAN_CLEANUP_OUTPUT_HALVES) {
        const inkTop = inkTops[half];
        if (inkTop !== undefined) {
            const offset = inkTop.yNormalized + sheetCorrection - topEdgeNormalized;
            anchors[half] = {yNormalized: Math.min(1, Math.max(0, offset))};
        }
    }
    return anchors;
}

/**
 * Every cluster spans at most the tolerance, so a slow drift across the
 * document splits instead of chaining every page into one cluster. Where the
 * splits fall decides which nearly equal pages end up apart, so the densest
 * window is taken first and the rest of its run is clustered on either side of
 * it: a boundary lands at the thin edge of a position many pages share, not
 * wherever a window happened to start. A window grown from the lowest value
 * instead cut a title spread's two halves, measured 0.4 mm apart, into two
 * clusters 4 mm apart, because it began on the running heads' tail.
 *
 * Two neighbouring clusters never fit in one window together, or that window
 * would have been the denser one, so a run holds at most about two clusters per
 * tolerance of its span. Ordering and tie-breaks are fully determined by
 * (value, page, half), so the same document resolves to the same anchors
 * whatever order its evidence arrived in.
 */
function snapScanCleanupAnchors(
    samples: readonly IScanCleanupPlacementAnchorSample[],
    tolerance: number,
) {
    const ordered = samples
        .map((sample, index) => ({
            index,
            sample,
        }))
        .sort((left, right) => left.sample.yNormalized - right.sample.yNormalized
            || left.sample.pageNumber - right.sample.pageNumber
            || left.sample.half.localeCompare(right.sample.half));
    const values = ordered.map(entry => entry.sample.yNormalized);
    const valueAt = (position: number) => {
        const value = values[position];
        if (value === undefined) {
            throw new RangeError(`Anchor position ${String(position)} is outside ${String(values.length)} samples`);
        }
        return value;
    };
    const snapped = new Array<number>(samples.length);
    const support = new Array<number>(samples.length);
    const clusters: IScanCleanupAnchorCluster[] = [];
    // Half-open [start, end) ranges of `ordered`. No window crosses a gap wider
    // than the tolerance, so those gaps separate the first runs.
    const runs: Array<readonly [number, number]> = [];
    let runStart = 0;
    for (let position = 1; position <= values.length; position += 1) {
        if (position === values.length || valueAt(position) - valueAt(position - 1) > tolerance) {
            runs.push([
                runStart,
                position,
            ]);
            runStart = position;
        }
    }
    for (let run = runs.pop(); run !== undefined; run = runs.pop()) {
        const [
            start,
            end,
        ] = run;
        if (start >= end) {
            continue;
        }
        let bestStart = start;
        let bestEnd = start + 1;
        let windowStart = start;
        for (let windowEnd = start + 1; windowEnd <= end; windowEnd += 1) {
            while (valueAt(windowEnd - 1) - valueAt(windowStart) > tolerance) {
                windowStart += 1;
            }
            const size = windowEnd - windowStart;
            const bestSize = bestEnd - bestStart;
            if (
                size > bestSize
                || (size === bestSize
                    && valueAt(windowEnd - 1) - valueAt(windowStart) < valueAt(bestEnd - 1) - valueAt(bestStart))
            ) {
                bestStart = windowStart;
                bestEnd = windowEnd;
            }
        }
        const value = resolveScanCleanupAnchorClusterValue(values.slice(bestStart, bestEnd));
        for (const entry of ordered.slice(bestStart, bestEnd)) {
            snapped[entry.index] = value;
            support[entry.index] = bestEnd - bestStart;
        }
        clusters.push({
            start: valueAt(bestStart),
            end: valueAt(bestEnd - 1),
            value,
            size: bestEnd - bestStart,
        });
        runs.push([
            start,
            bestStart,
        ], [
            bestEnd,
            end,
        ]);
    }
    clusters.sort((left, right) => left.start - right.start);
    return {
        clusters,
        snapped,
        support,
    };
}

/**
 * The share of a document's outputs a position has to hold before it can be
 * the document's top edge. A title page or a stray mark whose ink starts above
 * the running head is real ink, but it is not where the book's text block
 * begins, and letting it set the top edge would push every other page down.
 */
const SCAN_CLEANUP_INK_TOP_EDGE_MINIMUM_SHARE = 1 / 20;

function resolveScanCleanupInkTopEdge(clusters: readonly IScanCleanupAnchorCluster[], sampleCount: number) {
    const minimumSize = Math.max(2, Math.ceil(sampleCount * SCAN_CLEANUP_INK_TOP_EDGE_MINIMUM_SHARE));
    const supported = clusters.filter(cluster => cluster.size >= minimumSize);
    return Math.min(...(supported.length > 0 ? supported : clusters).map(cluster => cluster.value));
}

export interface IScanCleanupPlacementAnchorResolution {
    anchorsByPage: TScanCleanupPlacementAnchorsByPage;
    topEdgeNormalized: number;
    clusters: readonly IScanCleanupPlacementAnchorSummaryCluster[];
}

/**
 * Resolve anchors and expose the bounded cluster calibration used by a
 * streaming conversion. `sampleCount` lets a bounded sample set retain the
 * document's scale for the top-edge share calculation when the full result
 * store contains more samples than the retained calibration window.
 */
export function resolveScanCleanupPlacementAnchorResolution(
    samples: readonly IScanCleanupPlacementAnchorSample[],
    tolerance: number,
    sampleCount = samples.length,
): IScanCleanupPlacementAnchorResolution {
    const anchorsByPage: TScanCleanupPlacementAnchorsByPage = new Map();
    if (samples.length === 0) {
        return {
            anchorsByPage,
            topEdgeNormalized: 0,
            clusters: [],
        };
    }
    const {
        clusters,
        snapped,
        support,
    } = snapScanCleanupAnchors(samples, tolerance);
    // A sparse calibration window represents the full document. Use the
    // window's cardinality for its support threshold so a common cluster is
    // not discarded simply because it was downsampled to 256 entries.
    const representedSampleCount = Number.isSafeInteger(sampleCount) && sampleCount > 0
        ? Math.min(sampleCount, samples.length)
        : samples.length;
    const topEdge = resolveScanCleanupInkTopEdge(clusters, representedSampleCount);
    const inkTopsByPage = new Map<number, Partial<Record<TScanCleanupOutputHalf, IScanCleanupSnappedInkTop>>>();
    samples.forEach((sample, index) => {
        const inkTops = inkTopsByPage.get(sample.pageNumber) ?? {};
        inkTops[sample.half] = {
            yNormalized: sample.yNormalized,
            snappedNormalized: snapped[index] ?? sample.yNormalized,
            support: support[index] ?? 1,
        };
        inkTopsByPage.set(sample.pageNumber, inkTops);
    });
    for (const [
        pageNumber,
        inkTops,
    ] of inkTopsByPage) {
        anchorsByPage.set(pageNumber, resolveScanCleanupSheetAnchors(inkTops, topEdge));
    }
    return {
        anchorsByPage,
        topEdgeNormalized: topEdge,
        clusters: clusters.map(cluster => ({
            startNormalized: cluster.start,
            endNormalized: cluster.end,
            valueNormalized: cluster.value,
            size: cluster.size,
        })),
    };
}

/**
 * Turns the ink tops a document measured into the vertical positions its
 * outputs will actually be printed at.
 *
 * Pages whose ink starts within a few millimetres of each other were meant to
 * start in the same place, and a reader flipping through the finished book sees
 * the difference as the text block jumping; such a cluster snaps to its median,
 * the position that moves the fewest pages. A spread's halves then move by one
 * shared correction (see `resolveScanCleanupSheetAnchors`), so a half can sit
 * off its own cluster's median by the offset it was scanned with. Versos and
 * rectos are clustered together: a book has one top margin, and the canvas
 * gives every leaf the same height to measure it against.
 *
 * The snapped positions are then measured from the document's own top edge —
 * the highest position enough outputs share — which prints at the top margin,
 * while every other output keeps its distance below it. Ink is kept where it
 * sat relative to the rest of the book rather than where it sat on the
 * scanner glass: the scan's own margin above the running head is not printed
 * again on top of the requested margin, and pages that start above the top
 * edge sit at the margin.
 */
export function resolveScanCleanupPlacementAnchors(
    samples: readonly IScanCleanupPlacementAnchorSample[],
    tolerance: number,
): TScanCleanupPlacementAnchorsByPage {
    return resolveScanCleanupPlacementAnchorResolution(samples, tolerance).anchorsByPage;
}

const POINTS_PER_MM = 72 / 25.4;

/** One source sheet as `ink` calibration reads it. */
export interface IScanCleanupInkSheet {
    pageNumber: number;
    layoutClassification: TScanCleanupLayoutClassification | undefined;
    evidence: Pick<IScanCleanupPagePlanEvidence, 'outputs' | 'automaticSplit'> | undefined;
    metadata: IScanCleanupSourcePageMetadata | undefined;
}

/**
 * The halves a sheet is printed as. A forced layout decides by itself; an
 * automatic one follows the sheet's classification. An offcut keeps the half
 * its evidence names, else the wider side of its cutter, as native cuts it (a
 * detected offcut drops under 30% of the sheet, so never a near tie). A manual
 * box on a half the layout no longer produces is not an output to place.
 */
function resolveScanCleanupProducedHalves(
    options: Pick<IScanCleanupOptions, 'layoutMode'>,
    pageOverride: IScanCleanupPageOverride,
    sheet: IScanCleanupInkSheet,
): readonly TScanCleanupOutputHalf[] {
    const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    if (layout === 'keep-left' || layout === 'keep-right') {
        return [layout === 'keep-left' ? 'left' : 'right'];
    }
    if (layout === 'force-single') {
        return ['full'];
    }
    if (layout === 'force-two-page' || pageOverride.manualSplit !== null) {
        return [
            'left',
            'right',
        ];
    }
    if (sheet.layoutClassification === 'single-uncut-page') {
        return ['full'];
    }
    if (sheet.layoutClassification === 'two-page-spread') {
        return [
            'left',
            'right',
        ];
    }
    if (sheet.layoutClassification !== 'page-with-offcut') {
        return SCAN_CLEANUP_OUTPUT_HALVES;
    }
    const reported = SCAN_CLEANUP_OUTPUT_HALVES.filter(half => half !== 'full' && sheet.evidence?.outputs[half] !== undefined);
    if (reported.length > 0) {
        return reported;
    }
    const cutter = sheet.evidence?.automaticSplit?.xNormalized;
    if (cutter !== undefined) {
        return [cutter >= 0.5 ? 'left' : 'right'];
    }
    return SCAN_CLEANUP_OUTPUT_HALVES;
}

/**
 * The measured ink tops of a sheet's `ink` outputs, on the reference height.
 * Every path that calibrates, places or checks `ink` reads a sheet through this
 * one rule, so they agree on which halves take part: only produced, included
 * outputs whose placement is `ink`, each by its manual box before its
 * detected one. A manual box needs no detection evidence: the page it was
 * drawn on is placed by it either way.
 */
export function collectScanCleanupSheetInkTops(
    options: IScanCleanupOptions,
    sheet: IScanCleanupInkSheet,
    referenceHeightPoints: number,
): Partial<Record<TScanCleanupOutputHalf, number>> {
    const inkTops: Partial<Record<TScanCleanupOutputHalf, number>> = {};
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(sheet.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    if (pageOverride.excluded) {
        return inkTops;
    }
    const sheetHeightPoints = resolveScanCleanupSheetRect(sheet.metadata)?.heightPoints ?? 0;
    const scale = referenceHeightPoints > 0 && sheetHeightPoints > 0
        ? sheetHeightPoints / referenceHeightPoints
        : 1;
    for (const half of resolveScanCleanupProducedHalves(options, pageOverride, sheet)) {
        if (resolveScanCleanupOutputPlacement(options.pageAlignment, pageOverride, half) !== 'ink') {
            continue;
        }
        const box = pageOverride.manualContentBoxes?.[half] ?? sheet.evidence?.outputs[half]?.contentBox;
        if (box !== undefined) {
            inkTops[half] = box.yNormalized * scale;
        }
    }
    return inkTops;
}

/**
 * The height `ink` measures against: the dominant paper of the included sheets,
 * a spread voting for both leaves it carries. A sheet that cannot be measured
 * keeps its own-sheet fraction, which is not comparable with the others, so
 * snapping is only meaningful when every included sheet was measured.
 */
export interface IScanCleanupInkReference {
    sheets: IScanCleanupPaperCohortTally;
    everySheetMeasured: boolean;
}

export function createScanCleanupInkReference(): IScanCleanupInkReference {
    return {
        sheets: createScanCleanupPaperCohortTally(),
        everySheetMeasured: true,
    };
}

export function addScanCleanupInkReferenceSheet(
    reference: IScanCleanupInkReference,
    options: IScanCleanupOptions,
    sheet: IScanCleanupInkSheet,
) {
    if (getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(sheet.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    ).excluded) {
        return;
    }
    const rect = resolveScanCleanupSheetRect(sheet.metadata);
    if (rect === null) {
        reference.everySheetMeasured = false;
        return;
    }
    addScanCleanupPaperCohortRect(reference.sheets, rect, sheet.layoutClassification === 'two-page-spread' ? 2 : 1);
}

export function resolveScanCleanupInkScale(reference: IScanCleanupInkReference) {
    const referenceHeightPoints = resolveScanCleanupInkReferenceHeightPoints(reference.sheets);
    return {
        referenceHeightPoints,
        toleranceNormalized: reference.everySheetMeasured && referenceHeightPoints > 0
            ? SCAN_CLEANUP_INK_ANCHOR_TOLERANCE_MM * POINTS_PER_MM / referenceHeightPoints
            : 0,
    };
}

/**
 * Anchors for every `ink` output of a document whose sheets are all at hand.
 * The renderer places a run with this map and the CLI resolves the same
 * documents through it, so both print a page where the preview shows it.
 */
export function resolveScanCleanupDocumentInkAnchors(
    options: IScanCleanupOptions,
    sheets: Iterable<IScanCleanupInkSheet>,
): TScanCleanupPlacementAnchorsByPage {
    if (!usesScanCleanupInkAlignment(options)) {
        return new Map();
    }
    const included = [...sheets];
    const reference = createScanCleanupInkReference();
    for (const sheet of included) {
        addScanCleanupInkReferenceSheet(reference, options, sheet);
    }
    const {
        referenceHeightPoints,
        toleranceNormalized,
    } = resolveScanCleanupInkScale(reference);
    const samples = included.flatMap(sheet => Object.entries(
        collectScanCleanupSheetInkTops(options, sheet, referenceHeightPoints),
    ).map(([
        half,
        yNormalized,
    ]) => ({
        pageNumber: requirePageNumber(sheet.pageNumber),
        half: half as TScanCleanupOutputHalf,
        yNormalized,
    })));
    return resolveScanCleanupPlacementAnchors(samples, toleranceNormalized);
}

export function resolveScanCleanupPageLayout(
    layoutMode: IScanCleanupOptions['layoutMode'],
    override: TScanCleanupPageLayoutOverride,
) {
    if (override === 'single') {
        return 'force-single' as const;
    }
    if (override === 'spread') {
        return 'force-two-page' as const;
    }
    if (override === 'keep-left' || override === 'keep-right') {
        return override;
    }
    return layoutMode;
}

/**
 * The layouts a run is told to expect, as a plain record the bridge can carry.
 * Matched page size is measured over the pages a run produces, and this is what
 * the preview and the run are both measured against.
 */
export function toScanCleanupLayoutByPage(
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
): TScanCleanupLayoutByPage {
    const layouts: TScanCleanupLayoutByPage = {};
    for (const [
        pageNumber,
        classification,
    ] of classifications) {
        layouts[String(pageNumber)] = classification;
    }
    return layouts;
}

/**
 * Compact main-process request identity for the spread classifications a
 * matched render was asked to use.
 *
 * That is the whole of it, because a spread is the only classification the
 * matched canvas reads — every other page is measured as the whole sheet it is,
 * classified or not (see resolveScanCleanupDocumentCanvas). Classifying another
 * page as anything but a spread therefore cannot move the rectangle. Renderer
 * invalidation is deliberately keyed on the resolved canvas plan instead: on
 * a spread-majority book this set can grow hundreds of times while the actual
 * rectangle remains unchanged.
 */
export function scanCleanupLayoutSignature(layouts: TScanCleanupLayoutByPage) {
    const spreads = Object.entries(layouts)
        .filter(entry => entry[1] === 'two-page-spread')
        .map(entry => Number(entry[0]))
        .sort((left, right) => left - right);
    const ranges: string[] = [];
    let rangeStart: number | undefined;
    let rangeEnd = 0;
    const flushRange = () => {
        if (rangeStart !== undefined) {
            ranges.push(rangeStart === rangeEnd ? String(rangeStart) : `${String(rangeStart)}-${String(rangeEnd)}`);
        }
    };
    for (const spread of spreads) {
        if (rangeStart === undefined || spread !== rangeEnd + 1) {
            flushRange();
            rangeStart = spread;
        }
        rangeEnd = spread;
    }
    flushRange();
    return ranges.join(',');
}

/**
 * The rest of what a cached preview has to be revalidated against when matched
 * page size is on: the document-wide inputs the matched canvas is measured
 * from, which no single page's cache key carries.
 *
 * `resolveScanCleanupDocumentCanvas` reads the whole document to answer one
 * rectangle — which pages are produced at all (`excluded`), how many outputs
 * each sheet is cut into (`layoutOverride`, including keep-left/right, and
 * whether a `manualSplit` exists), and whether any page can be rendered in
 * continuous tone, which halves the pixel budget the grid is held inside
 * (`outputModeOverride`). Excluding page 40 therefore changes the canvas page 1
 * was drawn on, and without this the renderer would keep serving page 1 from a
 * cache measured against the old document.
 *
 * Only the non-default overrides are visited — the record holds nothing else —
 * so this is proportional to what the user has actually touched rather than to
 * the document's length, and it is derived once per settings change rather than
 * once per cache key.
 *
 * Each field is reduced to what the canvas can actually read: the split's
 * position and the exact tone of a page's output mode do not move the
 * rectangle, and keying on them would throw away every cached page of the
 * document for an edit that cannot have changed it.
 *
 * Every entry is read through `getScanCleanupPageOverride`, because the record
 * also arrives from disk and from the bridge, where a partially written entry
 * leaves a field absent rather than at its default. The canvas resolves those
 * entries the same way, so a signature taken off the raw record would distinguish
 * two documents the canvas cannot tell apart and drop the whole preview cache.
 */
export function scanCleanupMatchedCanvasOverridesSignature(
    overrides: TScanCleanupPageOverrides,
    pageOverrideDefaults?: IScanCleanupPageOverride,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const serialize = (override: IScanCleanupPageOverride) => [
        override.excluded ? 'excluded' : '',
        override.layoutOverride,
        override.manualSplit ? 'split' : '',
        // Only whether the page can leave the bilevel pixel budget.
        override.outputModeOverride === undefined
            ? ''
            : override.outputModeOverride === 'bw' ? 'bw' : 'tonal',
    ].join(':');
    const defaults = serialize(pageOverrideDefaults === undefined
        ? getScanCleanupPageOverrideDefaults(overrides)
        : createScanCleanupPageOverride(pageOverrideDefaults, documentMargins));
    const defaultEntry = defaults === ':auto::' ? '' : `@default=${defaults}`;
    const pageEntries = Object.keys(overrides)
        .map(pageKey => {
            const pageNumber = parsePageNumber(Number(pageKey));
            if (pageNumber === null) {
                return '';
            }
            const canvasInputs = serialize(pageOverrideDefaults === undefined
                ? getScanCleanupPageOverride(overrides, pageNumber)
                : getScanCleanupPageOverride(overrides, pageNumber, pageOverrideDefaults, documentMargins));
            return canvasInputs === ':auto::' ? '' : `${pageKey}=${canvasInputs}`;
        })
        .filter(entry => entry !== '')
        .sort()
        .join(',');
    return [
        defaultEntry,
        pageEntries,
    ]
        .filter(entry => entry !== '')
        .join(',');
}

function automaticOutputCount(
    classification: IScanCleanupPreviewMetadata['layoutClassification'] | undefined,
) {
    return classification === 'two-page-spread' ? 2 : 1;
}

export function estimateScanCleanupOutputPages(
    totalPages: number,
    options: Pick<IScanCleanupOptions, 'layoutMode' | 'pageOverrides'>
        & Partial<Pick<IScanCleanupOptions, 'pageOverrideDefaults'>>
        & Partial<Pick<IScanCleanupOptions, 'skipBlankPages'>>,
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
) {
    const pageCount = Math.max(0, Math.floor(totalPages));
    if (options.pageOverrideDefaults !== undefined) {
        attachScanCleanupPageOverrideDefaults(
            options.pageOverrides,
            options.pageOverrideDefaults,
        );
    }
    const defaultOverride = options.pageOverrideDefaults
        ?? getScanCleanupPageOverrideDefaults(options.pageOverrides);
    const resolveOutput = (
        override: IScanCleanupPageOverride,
        classification: IScanCleanupPreviewMetadata['layoutClassification'] | undefined,
    ) => {
        if (override.excluded) {
            return {
                automatic: false,
                count: 0,
            };
        }
        const layout = resolveScanCleanupPageLayout(options.layoutMode, override.layoutOverride);
        if (layout === 'force-two-page' || override.manualSplit !== null) {
            return {
                automatic: false,
                count: 2,
            };
        }
        if (layout === 'force-single' || layout === 'keep-left' || layout === 'keep-right') {
            return {
                automatic: false,
                count: 1,
            };
        }
        return {
            automatic: true,
            count: classification === undefined ? 1 : automaticOutputCount(classification),
        };
    };
    const defaultResolution = resolveOutput(defaultOverride, undefined);
    let outputPages = defaultResolution.count * pageCount;
    let exact = options.skipBlankPages !== true;
    const fixedPages = new Set<number>();
    let fixedAutomaticPagesMissingClassification = false;
    for (const pageKey of Object.keys(options.pageOverrides)) {
        const pageNumber = parsePageNumber(Number(pageKey), pageCount);
        if (pageNumber === null) {
            continue;
        }
        fixedPages.add(pageNumber);
        const classification = classifications.get(pageNumber);
        const pageOverride = getScanCleanupPageOverride(options.pageOverrides, pageNumber);
        const explicitPage = resolveOutput(pageOverride, classification);
        // The document baseline starts with one default output per page. Any
        // automatic classification adjustment is added only for pages that do
        // not have a sparse exception below, so remove that same baseline here
        // before applying the explicit page result.
        outputPages += explicitPage.count - defaultResolution.count;
        if (explicitPage.automatic && classification === undefined) {
            fixedAutomaticPagesMissingClassification = true;
        }
    }
    let classifiedAutomaticPages = 0;
    for (const [
        pageNumber,
        classification,
    ] of classifications) {
        if (!Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || fixedPages.has(pageNumber)) {
            continue;
        }
        classifiedAutomaticPages += 1;
        if (defaultResolution.automatic) {
            outputPages += automaticOutputCount(classification) - 1;
        }
    }
    if (defaultResolution.automatic
        && (classifiedAutomaticPages < pageCount - fixedPages.size
            || fixedAutomaticPagesMissingClassification)) {
        exact = false;
    }
    return {
        exact,
        outputPages,
    };
}

export function shouldShowScanCleanupOutputEstimate(
    totalPages: number,
    options: Pick<IScanCleanupOptions, 'layoutMode' | 'pageOverrides'>
        & Partial<Pick<IScanCleanupOptions, 'skipBlankPages'>>,
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
) {
    if (classifications.size > 0 || options.layoutMode !== 'auto') {
        return true;
    }
    return estimateScanCleanupOutputPages(totalPages, options, classifications).exact;
}
