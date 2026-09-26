import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupOptions,
    TScanCleanupLayoutByPage,
    TScanCleanupLayoutClassification,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    IScanCleanupPageRasterSource,
    IPdfPageSize,
} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    resolveScanCleanupMatchedCanvasMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

/**
 * Resolves the intrinsic raster's scale and origin in the logical matched
 * canvas. Native reports placement offsets for that logical canvas, while a
 * materialized raster may begin after an intrinsic overflow tail has been
 * clipped. Every affine consumer must apply the same effective origin.
 */
export function resolveScanCleanupMatchedCanvasPlacement(input: {
    outputWidthPx: number;
    outputHeightPx: number;
    intrinsicRasterWidthPx?: number | null;
    intrinsicRasterHeightPx?: number | null;
    matchedCanvasContentWidthPx?: number | null;
    matchedCanvasContentHeightPx?: number | null;
    matchedCanvasIntrinsicOverflowLeftPx?: number | null;
    matchedCanvasIntrinsicOverflowTopPx?: number | null;
    placementOffsetXPx: number;
    placementOffsetYPx: number;
}) {
    const positiveFiniteOr = (value: number | null | undefined, fallback: number) => (
        typeof value === 'number' && Number.isFinite(value) && value > 0
            ? value
            : fallback
    );
    const contentWidthPx = positiveFiniteOr(
        input.matchedCanvasContentWidthPx,
        input.outputWidthPx,
    );
    const contentHeightPx = positiveFiniteOr(
        input.matchedCanvasContentHeightPx,
        input.outputHeightPx,
    );
    const intrinsicRasterWidthPx = positiveFiniteOr(
        input.intrinsicRasterWidthPx,
        input.outputWidthPx,
    );
    const intrinsicRasterHeightPx = positiveFiniteOr(
        input.intrinsicRasterHeightPx,
        input.outputHeightPx,
    );
    return {
        contentWidthPx,
        contentHeightPx,
        intrinsicRasterWidthPx,
        intrinsicRasterHeightPx,
        matchScaleX: contentWidthPx / intrinsicRasterWidthPx,
        matchScaleY: contentHeightPx / intrinsicRasterHeightPx,
        effectivePlacementOffsetXPx: input.placementOffsetXPx
            - (input.matchedCanvasIntrinsicOverflowLeftPx ?? 0),
        effectivePlacementOffsetYPx: input.placementOffsetYPx
            - (input.matchedCanvasIntrinsicOverflowTopPx ?? 0),
    };
}

export interface IScanCleanupOrientedRect {
    widthPoints: number;
    heightPoints: number;
}

/**
 * Stable bridge/cache identity for the document canvas the shared planner
 * already owns. Keep this beside the planner so callers never invent a second
 * representation of matched-page geometry.
 */
export function scanCleanupDocumentCanvasSignature(
    canvas: IScanCleanupDocumentCanvasPlan | null,
) {
    return JSON.stringify(canvas === null
        ? null
        : [
            canvas.widthPoints,
            canvas.heightPoints,
            canvas.widthPx,
            canvas.heightPx,
        ]);
}

function normalizeScanCleanupQuarterTurns(rotationDegrees: number) {
    return ((Math.round(rotationDegrees / 90) % 4) + 4) % 4;
}

function orient(rect: IScanCleanupOrientedRect, quarterTurns: number): IScanCleanupOrientedRect {
    return quarterTurns % 2 === 0
        ? rect
        : {
            widthPoints: rect.heightPoints,
            heightPoints: rect.widthPoints,
        };
}

/**
 * The rectangle a page is presented on: its page view turned by the display
 * rotation the document carries. A landscape scan stored as a rotated portrait
 * page is a landscape rectangle here, which is what both the preview raster
 * and the assembled output actually show.
 */
function resolveScanCleanupOrientedPageRect(pageSize: IPdfPageSize): IScanCleanupOrientedRect {
    return orient({
        widthPoints: pageSize.widthPoints,
        heightPoints: pageSize.heightPoints,
    }, normalizeScanCleanupQuarterTurns(pageSize.rotation));
}

/**
 * How many output pages the sheet's presented width is divided into. A spread
 * carries two book pages side by side, so each produced page is half the sheet;
 * keeping one side of a spread produces one output that is still half a sheet.
 *
 * The answer comes from the layout the run will use — the page's own override,
 * then the document's layout mode — and, for pages left on automatic, from the
 * classification the caller has already observed for that page. A page nobody
 * has classified yet keeps its whole sheet: guessing that it is a spread
 * because its neighbours are would halve the rectangle the document is
 * normalized onto, which silently places every page that is *not* a spread at
 * half the document's scale. Measuring the sheet is the answer that can only
 * leave a page padded, never shrunk, and the run reports how many pages it had
 * to measure that way — see resolveScanCleanupUnclassifiedPages.
 */
function resolveSheetShares(
    options: IScanCleanupOptions,
    pageNumber: number,
    layoutByPage: TScanCleanupLayoutByPage | undefined,
) {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    if (layout === 'force-two-page' || layout === 'keep-left' || layout === 'keep-right') {
        return 2;
    }
    if (layout === 'force-single') {
        return 1;
    }
    if (pageOverride.manualSplit !== null) {
        return 2;
    }
    return readObservedLayout(layoutByPage, pageNumber) === 'two-page-spread' ? 2 : 1;
}

function isAutomaticLayout(options: IScanCleanupOptions, pageNumber: number) {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    return pageOverride.manualSplit === null
        && resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride) === 'auto';
}

function readObservedLayout(layoutByPage: TScanCleanupLayoutByPage | undefined, pageNumber: number) {
    return layoutByPage?.[String(pageNumber)];
}

type TScanCleanupCanvasShare = 1 | 2;

export interface IScanCleanupCanvasSummaryBucket {
    count: number;
    hasContinuousTone: boolean;
    largestOutputRect: IScanCleanupOrientedRect | null;
}

/**
 * The bounded state needed to answer the document-canvas decision. The two
 * automatic layout buckets are the only dynamic groups, so this remains a
 * constant-size summary even when the source has millions of pages.
 */
export interface IScanCleanupDocumentCanvasAccumulator {
    producedPageCount: number;
    unclassifiedAutomaticPageCount: number;
    forced: IScanCleanupCanvasSummaryBucket;
    automaticSingle: IScanCleanupCanvasSummaryBucket;
    automaticSpread: IScanCleanupCanvasSummaryBucket;
    automaticUnclassified: IScanCleanupCanvasSummaryBucket;
    firstObservedAutomaticShare: TScanCleanupCanvasShare | null;
}

function createScanCleanupCanvasSummaryBucket(): IScanCleanupCanvasSummaryBucket {
    return {
        count: 0,
        hasContinuousTone: false,
        largestOutputRect: null,
    };
}

export function createScanCleanupDocumentCanvasAccumulator(): IScanCleanupDocumentCanvasAccumulator {
    return {
        producedPageCount: 0,
        unclassifiedAutomaticPageCount: 0,
        forced: createScanCleanupCanvasSummaryBucket(),
        automaticSingle: createScanCleanupCanvasSummaryBucket(),
        automaticSpread: createScanCleanupCanvasSummaryBucket(),
        automaticUnclassified: createScanCleanupCanvasSummaryBucket(),
        firstObservedAutomaticShare: null,
    };
}

function isLargerOutputRect(
    candidate: IScanCleanupOrientedRect,
    current: IScanCleanupOrientedRect | null,
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

function addScanCleanupCanvasSummaryPage(
    bucket: IScanCleanupCanvasSummaryBucket,
    pageSize: IPdfPageSize,
    options: IScanCleanupOptions,
    shares: number,
) {
    bucket.count += 1;
    const outputMode = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageSize.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    ).outputModeOverride
        ?? options.outputMode;
    bucket.hasContinuousTone ||= outputMode !== 'bw';
    const outputRect = resolveScanCleanupOutputPageRect(pageSize, shares);
    if (isLargerOutputRect(outputRect, bucket.largestOutputRect)) {
        bucket.largestOutputRect = outputRect;
    }
}

/** Add one page's geometry to the constant-size canvas summary. */
export function addScanCleanupDocumentCanvasPage(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
    pageSize: IPdfPageSize,
    options: IScanCleanupOptions,
    observedLayout?: TScanCleanupLayoutClassification,
) {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageSize.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    if (pageOverride.excluded) {
        return false;
    }
    accumulator.producedPageCount += 1;
    if (!isAutomaticLayout(options, pageSize.pageNumber)) {
        addScanCleanupCanvasSummaryPage(
            accumulator.forced,
            pageSize,
            options,
            resolveSheetShares(options, pageSize.pageNumber, {[String(pageSize.pageNumber)]: observedLayout}),
        );
        return false;
    }
    if (observedLayout === undefined) {
        accumulator.unclassifiedAutomaticPageCount += 1;
        addScanCleanupCanvasSummaryPage(
            accumulator.automaticUnclassified,
            pageSize,
            options,
            1,
        );
        return true;
    }
    addScanCleanupDocumentCanvasObservedPage(accumulator, pageSize, options, observedLayout);
    return false;
}

/**
 * Add a known automatic-layout observation to its bounded share bucket. The
 * caller supplies the page from its current geometry window, so no geometry
 * cache grows with the document.
 */
export function addScanCleanupDocumentCanvasObservedPage(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
    pageSize: IPdfPageSize,
    options: IScanCleanupOptions,
    observedLayout: TScanCleanupLayoutClassification,
) {
    if (getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageSize.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    ).excluded) {
        return;
    }
    if (!isAutomaticLayout(options, pageSize.pageNumber)) {
        return;
    }
    const shares = resolveSheetShares(options, pageSize.pageNumber, {[String(pageSize.pageNumber)]: observedLayout});
    const bucket = shares === 2 ? accumulator.automaticSpread : accumulator.automaticSingle;
    accumulator.firstObservedAutomaticShare ??= shares === 2 ? 2 : 1;
    addScanCleanupCanvasSummaryPage(bucket, pageSize, options, shares);
}

function resolveScanCleanupCanvasSummaryRect(
    buckets: readonly IScanCleanupCanvasSummaryBucket[],
) {
    let largest: IScanCleanupOrientedRect | null = null;
    let hasContinuousTone = false;
    for (const bucket of buckets) {
        hasContinuousTone ||= bucket.hasContinuousTone;
        if (bucket.largestOutputRect !== null && isLargerOutputRect(bucket.largestOutputRect, largest)) {
            largest = bucket.largestOutputRect;
        }
    }
    return {
        largest,
        hasContinuousTone,
    };
}

function resolveCanvasMaxPixels(
    configuredMaxPixels: number,
    rasterMaxPixels: number | undefined,
) {
    return rasterMaxPixels === undefined
        ? configuredMaxPixels
        : Math.max(1, Math.min(configuredMaxPixels, Math.floor(rasterMaxPixels)));
}

/** Resolve the canvas from bounded summary state rather than page arrays. */
export function resolveScanCleanupDocumentCanvasFromAccumulator(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
    renderDpi: number,
    options: IScanCleanupOptions,
    layoutEvidenceComplete = false,
    rasterMaxPixels?: number,
): IScanCleanupDocumentCanvasPlan | null {
    void options;
    if (accumulator.producedPageCount === 0 || !Number.isFinite(renderDpi) || renderDpi <= 0) {
        return null;
    }
    let buckets: IScanCleanupCanvasSummaryBucket[] = [accumulator.forced];
    let dominantCandidates: readonly IScanCleanupCanvasSummaryBucket[] = [];
    if (layoutEvidenceComplete) {
        buckets = [
            ...buckets,
            accumulator.automaticSingle,
            accumulator.automaticSpread,
            accumulator.automaticUnclassified,
        ];
    } else {
        // Unknown automatic pages must still contribute their whole sheet.
        // A partial observation cannot safely halve the document canvas: an
        // unclassified page may be a single sheet even when the first verdict
        // was a spread. This is the same conservative answer as the legacy
        // page-array planner and keeps an all-unknown document measurable.
        buckets = [
            ...buckets,
            accumulator.automaticUnclassified,
        ];
        dominantCandidates = accumulator.firstObservedAutomaticShare === 2
            ? [
                accumulator.automaticSpread,
                accumulator.automaticSingle,
            ]
            : [
                accumulator.automaticSingle,
                accumulator.automaticSpread,
            ];
    }
    return resolveScanCleanupDocumentCanvasPlanFromBuckets(
        buckets,
        renderDpi,
        dominantCandidates,
        rasterMaxPixels,
    );
}

/**
 * Resolve the preview canvas from only the layout cohorts already observed.
 * Unknown automatic pages are deliberately omitted while reconciliation is
 * open, matching the page-array provisional planner without retaining those
 * pages in memory.
 */
export function resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
    renderDpi: number,
    options: IScanCleanupOptions,
    layoutEvidenceComplete = false,
    rasterMaxPixels?: number,
): IScanCleanupDocumentCanvasPlan | null {
    if (layoutEvidenceComplete) {
        return resolveScanCleanupDocumentCanvasFromAccumulator(
            accumulator,
            renderDpi,
            options,
            true,
            rasterMaxPixels,
        );
    }
    if (accumulator.producedPageCount === 0 || !Number.isFinite(renderDpi) || renderDpi <= 0) {
        return null;
    }
    const buckets: IScanCleanupCanvasSummaryBucket[] = [accumulator.forced];
    const dominantCandidates = accumulator.firstObservedAutomaticShare === 2
        ? [
            accumulator.automaticSpread,
            accumulator.automaticSingle,
        ]
        : [
            accumulator.automaticSingle,
            accumulator.automaticSpread,
        ];
    return resolveScanCleanupDocumentCanvasPlanFromBuckets(
        buckets,
        renderDpi,
        dominantCandidates,
        rasterMaxPixels,
    );
}

function resolveScanCleanupDocumentCanvasPlanFromBuckets(
    buckets: readonly IScanCleanupCanvasSummaryBucket[],
    renderDpi: number,
    dominantCandidates: readonly IScanCleanupCanvasSummaryBucket[] = [],
    rasterMaxPixels?: number,
): IScanCleanupDocumentCanvasPlan | null {
    const dominant = dominantCandidates.reduce<IScanCleanupCanvasSummaryBucket | null>((best, candidate) => {
        if (candidate.count === 0) {
            return best;
        }
        if (best === null || candidate.count > best.count) {
            return candidate;
        }
        return best;
    }, null);
    const selectedBuckets = dominant === null
        ? buckets
        : [
            ...buckets,
            dominant,
        ];
    const {
        largest,
        hasContinuousTone,
    } = resolveScanCleanupCanvasSummaryRect(selectedBuckets);
    if (largest === null) {
        return null;
    }
    const maxPixels = resolveCanvasMaxPixels(
        resolveScanCleanupMatchedCanvasMaxPixels([hasContinuousTone ? 'color' : 'bw']),
        rasterMaxPixels,
    );
    const dpi = resolveCanvasDpi(largest, renderDpi, maxPixels);
    const plan = {
        widthPoints: largest.widthPoints,
        heightPoints: largest.heightPoints,
        ...resolveCanvasGrid(largest, dpi, maxPixels),
    };
    return Object.values(plan).every(value => Number.isFinite(value) && value > 0)
        ? plan
        : null;
}

export function resolveScanCleanupDroppedMatchWarningEventFromAccumulator(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
): TScanCleanupWarningEvent | null {
    return accumulator.producedPageCount === 0
        ? null
        : {code: 'matched-canvas-dropped'};
}

/**
 * The best matched-page rectangle a preview can honestly claim while automatic
 * layout detection is still open.
 *
 * Unknown automatic sheets are omitted instead of being guessed as either a
 * full page or a spread. Forced/manual pages are already facts. While native
 * reconciliation is open, automatic pages contribute only through the
 * dominant output-count cohort: a lone provisional single-page verdict cannot
 * resize every already-proven spread leaf onto a landscape canvas. Once the
 * caller says reconciliation is complete, every observed page speaks for
 * itself and a genuinely mixed document is measured in full.
 *
 * Final conversion deliberately does not use this helper. It waits for page
 * plans and then calls `resolveScanCleanupDocumentCanvas` over the full
 * document, whose conservative treatment of missing evidence remains the
 * fail-safe contract for direct/core callers.
 */
export function resolveScanCleanupProvisionalDocumentCanvas(
    pageSizes: readonly IPdfPageSize[],
    renderDpi: number,
    options: IScanCleanupOptions,
    layoutByPage?: TScanCleanupLayoutByPage,
    layoutEvidenceComplete = false,
    rasterMaxPixels?: number,
): IScanCleanupDocumentCanvasPlan | null {
    if (layoutEvidenceComplete) {
        return resolveScanCleanupDocumentCanvas(
            pageSizes,
            renderDpi,
            options,
            layoutByPage,
            rasterMaxPixels,
        );
    }
    const automaticEvidence = pageSizes.filter(pageSize => (
        !getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
            options.pageOverrideDefaults,
            options.marginsMm,
        ).excluded
        && isAutomaticLayout(options, pageSize.pageNumber)
        && readObservedLayout(layoutByPage, pageSize.pageNumber) !== undefined
    ));
    let dominantShares: number | null = null;
    if (automaticEvidence.length > 0) {
        const firstShares = resolveSheetShares(
            options,
            automaticEvidence[0]!.pageNumber,
            layoutByPage,
        );
        const counts = new Map<number, number>();
        for (const pageSize of automaticEvidence) {
            const shares = resolveSheetShares(options, pageSize.pageNumber, layoutByPage);
            counts.set(shares, (counts.get(shares) ?? 0) + 1);
        }
        dominantShares = [...counts].reduce((best, candidate) => (
            candidate[1] > best[1] ? candidate : best
        ), [
            firstShares,
            counts.get(firstShares) ?? 0,
        ])[0];
    }
    const evidencedPages = pageSizes.filter(pageSize => {
        if (!isAutomaticLayout(options, pageSize.pageNumber)) {
            return true;
        }
        return dominantShares !== null
            && readObservedLayout(layoutByPage, pageSize.pageNumber) !== undefined
            && resolveSheetShares(options, pageSize.pageNumber, layoutByPage) === dominantShares;
    });
    return resolveScanCleanupDocumentCanvas(
        evidencedPages,
        renderDpi,
        options,
        layoutByPage,
        rasterMaxPixels,
    );
}

/**
 * The rectangle one output page of this sheet is presented on: the sheet as the
 * reader sees it, divided across the outputs it is cut into. This is the
 * rectangle matched page size normalizes, because it is the paper the reader
 * ends up holding — a spread sheet produces two pages of half its width, and
 * measuring the sheet instead would leave every half on a canvas it fills only
 * halfway.
 */
export function resolveScanCleanupOutputPageRect(
    pageSize: IPdfPageSize,
    shares: number,
): IScanCleanupOrientedRect {
    const rect = resolveScanCleanupOrientedPageRect(pageSize);
    return {
        widthPoints: rect.widthPoints / Math.max(1, shares),
        heightPoints: rect.heightPoints,
    };
}

/**
 * Keeps the one document-wide pixel grid inside the guardrails a single page
 * has, by lowering the resolution the whole document is normalized to rather
 * than letting one oversized rectangle fail the run.
 */
function resolveCanvasDpi(canvas: IScanCleanupOrientedRect, renderDpi: number, maxPixels: number) {
    const widthPx = Math.max(1, canvas.widthPoints / 72 * renderDpi);
    const heightPx = Math.max(1, canvas.heightPoints / 72 * renderDpi);
    return renderDpi * Math.min(
        1,
        Math.sqrt(maxPixels / (widthPx * heightPx)),
        SCAN_CLEANUP_MAX_DIMENSION_PX / widthPx,
        SCAN_CLEANUP_MAX_DIMENSION_PX / heightPx,
    );
}

function clampCanvasPixels(exactPixels: number) {
    return Math.min(
        SCAN_CLEANUP_MAX_DIMENSION_PX,
        Math.max(1, Math.ceil(exactPixels)),
    );
}

/**
 * The pixel grid the canvas rectangle is rendered on, rounded the way Poppler
 * rounds a page rectangle — up — and then held inside the guardrails the engine
 * enforces on it.
 *
 * `validate_canvas` rejects a grid whose area is past `maxPixels` at all, so
 * rounding up is the one step that can turn a resolution measured to fit into a
 * grid that does not: the resolution above lands the exact rectangle on the
 * budget, and two rounded-up axes carry it over by up to a row and a column.
 * The rounding is given back on the axis it inflated most, one row or column at
 * a time, until the grid is back inside the budget — for a grid that only
 * rounding pushed over, that is the row and the column rounding added. The
 * rectangle in points is not touched at all: it is the
 * paper the document is normalized to, and the grid is how finely that paper is
 * sampled.
 */
function resolveCanvasGrid(
    canvas: IScanCleanupOrientedRect,
    dpi: number,
    maxPixels: number,
) {
    const exactWidthPx = canvas.widthPoints / 72 * dpi;
    const exactHeightPx = canvas.heightPoints / 72 * dpi;
    let widthPx = clampCanvasPixels(exactWidthPx);
    let heightPx = clampCanvasPixels(exactHeightPx);
    while (widthPx * heightPx > maxPixels && (widthPx > 1 || heightPx > 1)) {
        const heightIsMoreRounded = heightPx - exactHeightPx >= widthPx - exactWidthPx;
        if (widthPx === 1 || (heightIsMoreRounded && heightPx > 1)) {
            heightPx -= 1;
        } else {
            widthPx -= 1;
        }
    }
    return {
        widthPx,
        heightPx,
    };
}

/**
 * The DPI represented by the pixel grid in a document-canvas plan.
 *
 * The final sidecar render reconstructs a page canvas from its physical
 * rectangle and that page's render DPI. Keeping this conversion beside the
 * planner makes the DPI used by that consumer explicit instead of allowing a
 * page's independent render plan to recreate a grid larger than the plan.
 */
export function resolveScanCleanupDocumentCanvasDpi(
    canvas: IScanCleanupDocumentCanvasPlan,
) {
    return canvas.widthPx / canvas.widthPoints * 72;
}

/**
 * Normalizes a page render to the grid the shared document canvas carries.
 * Low-resolution pages must be raised to this DPI as well as high-resolution
 * pages being capped; otherwise native reconstructs a different pixel grid
 * for each page from the shared physical rectangle and that page's DPI.
 * The floor is intentional: the native canvas reconstruction rounds pixel
 * dimensions, so a fractional cap could round an axis above the planned grid.
 */
export function resolveScanCleanupDocumentCanvasRenderDpi(
    renderDpi: number,
    canvas: IScanCleanupDocumentCanvasPlan | null,
) {
    if (canvas === null) {
        return renderDpi;
    }
    return Math.max(
        1,
        Math.floor(resolveScanCleanupDocumentCanvasDpi(canvas)),
    );
}

/**
 * The one rectangle and pixel grid every matched output of a document is
 * normalized onto, or null when the document carries no readable geometry.
 *
 * The rectangle is an *actual* output page rectangle — the largest the document
 * produces, chosen by area and then by width and height so the same document
 * always answers the same rectangle — rather than independent maxima, which
 * would invent a rectangle no page has. Nothing grows it: margins are laid out
 * inside it and a rotation override turns that page's content within it, so
 * neither a 5 mm margin nor a quarter turn can resize a Letter document.
 *
 * The pixel grid is that rectangle at the resolution the run renders with, so
 * every page carries identical pixel dimensions at an identical DPI, and a page
 * whose paper is smaller is resampled up to the document's visual scale instead
 * of being padded into a corner of the sheet.
 *
 * It is measured over the whole document rather than over the pages one run was
 * asked to clean: cleaning a selection has to produce pages that belong to the
 * same document as a full run's, so the rectangle cannot depend on the scope.
 * It is a function of the source geometry, the layouts the caller has observed
 * and the run's resolution alone, so the preview that runs before any analysis
 * and the final run that happens after it derive the identical rectangle.
 */
export function resolveScanCleanupDocumentCanvas(
    pageSizes: readonly IPdfPageSize[],
    renderDpi: number,
    options: IScanCleanupOptions,
    layoutByPage?: TScanCleanupLayoutByPage,
    rasterMaxPixels?: number,
): IScanCleanupDocumentCanvasPlan | null {
    // A page the user excluded is not on the sheet and must not decide its
    // size. A page outside a partial run's scope still is: it belongs to the
    // same document, and the run's output has to sit beside it.
    const produced = pageSizes.filter(
        pageSize => !getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
            options.pageOverrideDefaults,
            options.marginsMm,
        ).excluded,
    );
    if (produced.length === 0 || !Number.isFinite(renderDpi) || renderDpi <= 0) {
        return null;
    }
    const outputRects = produced.map(pageSize => resolveScanCleanupOutputPageRect(
        pageSize,
        resolveSheetShares(options, pageSize.pageNumber, layoutByPage),
    ));
    let canvas = outputRects[0]!;
    for (const rect of outputRects.slice(1)) {
        const area = rect.widthPoints * rect.heightPoints;
        const bestArea = canvas.widthPoints * canvas.heightPoints;
        if (
            area > bestArea
            || (area === bestArea && rect.widthPoints > canvas.widthPoints)
            || (area === bestArea && rect.widthPoints === canvas.widthPoints && rect.heightPoints > canvas.heightPoints)
        ) {
            canvas = rect;
        }
    }
    const maxPixels = resolveCanvasMaxPixels(
        resolveScanCleanupMatchedCanvasMaxPixels(produced.map(
            pageSize => getScanCleanupPageOverride(
                options.pageOverrides,
                requirePageNumber(pageSize.pageNumber),
                options.pageOverrideDefaults,
                options.marginsMm,
            ).outputModeOverride
                ?? options.outputMode,
        )),
        rasterMaxPixels,
    );
    const dpi = resolveCanvasDpi(canvas, renderDpi, maxPixels);
    const plan = {
        widthPoints: canvas.widthPoints,
        heightPoints: canvas.heightPoints,
        ...resolveCanvasGrid(canvas, dpi, maxPixels),
    };
    // A page whose paper measures as zero, negative or unreadable answers a
    // rectangle nothing can be normalized onto — and handing the sidecar one
    // fails the whole run. It is the same answer as a document that carries no
    // geometry at all: no canvas, so the caller drops matching and says so.
    return Object.values(plan).every(value => Number.isFinite(value) && value > 0)
        ? plan
        : null;
}

/**
 * How much a rectangle has to grow (or shrink) to become the box it is
 * normalized onto, with its aspect ratio intact. The rectangle is a page's own
 * paper — not its cropped content — so a lower-resolution scan of the same
 * original, which the PDF carries as a physically smaller page, is enlarged to
 * the document's visual scale, and paper that already is the canvas answers
 * exactly 1.
 */
export function resolveScanCleanupCanvasFitScale(
    box: IScanCleanupOrientedRect,
    paper: IScanCleanupOrientedRect,
) {
    return Math.min(
        box.widthPoints / paper.widthPoints,
        box.heightPoints / paper.heightPoints,
    );
}

// Paper that is already the canvas needs no scaling at all; anything past this
// is a real difference in the paper the scanner produced.
export const CANVAS_CONTENT_SCALE_EPSILON = 0.001;

// The lossless path never rasterizes, so its canvas grid is nominal: it exists
// only so both quality paths carry the same plan shape, and the rectangle —
// which is all the split assembler consumes — is identical either way.
export const SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI = 300;

/**
 * Store-backed counterpart for conversion. Read geometry in bounded chunks and
 * ask the raster source for only the same bounded window, so matched-canvas
 * planning does not recreate a document-sized page array.
 */
export async function resolveMatchedCanvasResamplePagesFromStore(input: {
    pageSizeStore: IPdfPageSizeStore;
    documentPageCount: number;
    canvas: IScanCleanupDocumentCanvasPlan | null;
    options: IScanCleanupOptions;
    rasterSource: IScanCleanupPageRasterSource;
    rasterDetectionAvailable: boolean;
    layoutByPage?: TScanCleanupLayoutByPage;
}) {
    const canvas = input.canvas;
    if (canvas === null) {
        return [];
    }
    const resampledPages: number[] = [];
    let expectedPageNumber = 1;
    await input.pageSizeStore.forEachChunk(async chunk => {
        if (chunk.pageCount !== input.documentPageCount) {
            throw new Error(
                `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(input.documentPageCount)} document pages`,
            );
        }
        const pageNumbers = chunk.pages.map(pageSize => requirePageNumber(pageSize.pageNumber));
        for (const pageNumber of pageNumbers) {
            if (pageNumber !== expectedPageNumber) {
                throw new Error(
                    `Scan cleanup page-size store returned page ${String(pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                );
            }
            expectedPageNumber += 1;
        }
        const rasters = input.rasterDetectionAvailable
            ? await Promise.all(pageNumbers.map(pageNumber => Promise.resolve(
                input.rasterSource.getPageRaster(pageNumber),
            )))
            : chunk.pages.map(() => undefined);
        for (const [
            index,
            pageSize,
        ] of chunk.pages.entries()) {
            const pageNumber = pageNumbers[index]!;
            if (getScanCleanupPageOverride(input.options.pageOverrides, pageNumber).excluded) {
                continue;
            }
            const carriesRaster = !input.rasterDetectionAvailable || rasters[index] !== undefined;
            if (!carriesRaster) continue;
            const shares = resolveSheetShares(input.options, pageNumber, input.layoutByPage);
            const scale = resolveScanCleanupCanvasFitScale(
                canvas,
                resolveScanCleanupOutputPageRect(pageSize, shares),
            );
            if (Math.abs(scale - 1) > CANVAS_CONTENT_SCALE_EPSILON) {
                resampledPages.push(pageNumber);
            }
        }
    });
    if (expectedPageNumber - 1 !== input.documentPageCount) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(expectedPageNumber - 1)} pages for ${String(input.documentPageCount)} document pages`,
        );
    }
    return resampledPages;
}

