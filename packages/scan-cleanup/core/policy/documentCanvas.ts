import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupOptions,
    IScanCleanupPixelRect,
    IScanCleanupPlacementAnchor,
    TScanCleanupLayoutByPage,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputHalf,
    TScanCleanupPageRotation,
    TScanCleanupWarningEvent,
} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    resolveScanCleanupPlacementOffset,
} from '@contracts/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    assertCanonicalPdfPageSizes,
    type IPdfPageSize,
} from '@evb/scan-cleanup/core/types';
import {
    resolveScanCleanupMatchedCanvasMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

export interface IScanCleanupRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IScanCleanupMatchedCanvasPlacement {
    contentWidthPx: number;
    contentHeightPx: number;
    intrinsicRasterWidthPx: number;
    intrinsicRasterHeightPx: number;
    matchScaleX: number;
    matchScaleY: number;
    effectivePlacementOffsetXPx: number;
    effectivePlacementOffsetYPx: number;
}

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
}): IScanCleanupMatchedCanvasPlacement {
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

/**
 * Places a canvas-sized box around fixed content without scaling the content.
 * The shared placement resolver speaks top-left free-space offsets; PDF
 * consumers use a bottom-left y origin, so this is the one conversion owner
 * for the lossless assembler and compact-source preservation path.
 *
 * `displayRotationDegrees` is the quarter turn a reader applies to that page.
 * An alignment names visual edges — `top-center` is the top of the sheet the
 * reader holds — so the offsets are resolved on the presented rectangle and the
 * insets they produce are turned back into page space, exactly as the margins
 * beside them are. Resolving them in page space instead sent a quarter-turned
 * page to whichever edge happened to carry the same page-space letter, which
 * put its content up to 67 mm from where the raster and preview fitters put it.
 */
export function placeScanCleanupCanvasBox(
    content: IScanCleanupRect,
    width: number,
    height: number,
    alignment: IScanCleanupOptions['pageAlignment'],
    anchor?: IScanCleanupPlacementAnchor,
    displayRotationDegrees = 0,
): IScanCleanupRect {
    const quarterTurns = normalizeScanCleanupQuarterTurns(displayRotationDegrees);
    const swapsAxes = quarterTurns % 2 === 1;
    const availableWidth = swapsAxes ? height - content.height : width - content.width;
    const availableHeight = swapsAxes ? width - content.width : height - content.height;
    const placement = resolveScanCleanupPlacementOffset(
        availableWidth,
        availableHeight,
        alignment,
        anchor === undefined
            ? undefined
            : {
                anchor,
                contentHeight: swapsAxes ? content.width : content.height,
            },
    );
    const pageInsets = orientScanCleanupInsetsToPageSpace({
        left: placement.x,
        top: placement.y,
        right: availableWidth - placement.x,
        bottom: availableHeight - placement.y,
    }, quarterTurns * 90);
    return {
        x: content.x - pageInsets.left,
        y: content.y - pageInsets.bottom,
        width,
        height,
    };
}

export interface IScanCleanupOrientedRect {
    widthPoints: number;
    heightPoints: number;
}

export interface IScanCleanupOutputPaperPixels {
    widthPx: number;
    heightPx: number;
}

export interface IScanCleanupInsets {
    left: number;
    top: number;
    right: number;
    bottom: number;
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
 * The physical source-paper frame represented by one cleanup output.
 *
 * A split region is pixel-selection geometry: an automatic or manual cutter
 * may be off centre because the gutter is wide, curved, or contaminated. It
 * does not make the two leaves live at different source scales. Paper matching
 * therefore divides the oriented source sheet by output count and lets the
 * crop/cutter choose pixels inside that stable frame.
 */
export function resolveScanCleanupOutputPaperPixels(input: {
    half: TScanCleanupOutputHalf;
    inputWidthPx: number;
    inputHeightPx: number;
    rotationDegrees: TScanCleanupPageRotation;
}): IScanCleanupOutputPaperPixels {
    const swapsAxes = normalizeScanCleanupQuarterTurns(input.rotationDegrees) % 2 === 1;
    const orientedWidth = swapsAxes ? input.inputHeightPx : input.inputWidthPx;
    const orientedHeight = swapsAxes ? input.inputWidthPx : input.inputHeightPx;
    return {
        widthPx: orientedWidth / (input.half === 'full' ? 1 : 2),
        heightPx: orientedHeight,
    };
}

/**
 * Turns margins expressed on the displayed sheet back into the unrotated PDF
 * user space consumed by page-ops. This mirrors `resolveScanCleanupPageCanvasBox`:
 * the delivered top/left/right/bottom remain visual directions even when the
 * source page carries a rotation entry.
 */
export function orientScanCleanupInsetsToPageSpace(
    insets: IScanCleanupInsets,
    rotationDegrees: number,
): IScanCleanupInsets {
    switch (normalizeScanCleanupQuarterTurns(rotationDegrees)) {
        case 1:
            return {
                left: insets.top,
                top: insets.right,
                right: insets.bottom,
                bottom: insets.left,
            };
        case 2:
            return {
                left: insets.right,
                top: insets.bottom,
                right: insets.left,
                bottom: insets.top,
            };
        case 3:
            return {
                left: insets.bottom,
                top: insets.left,
                right: insets.top,
                bottom: insets.right,
            };
        default:
            return {...insets};
    }
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
    );
    if (pageOverride.excluded) {
        return;
    }
    accumulator.producedPageCount += 1;
    if (!isAutomaticLayout(options, pageSize.pageNumber)) {
        addScanCleanupCanvasSummaryPage(
            accumulator.forced,
            pageSize,
            options,
            resolveSheetShares(options, pageSize.pageNumber, {[String(pageSize.pageNumber)]: observedLayout}),
        );
        return;
    }
    if (observedLayout === undefined) {
        accumulator.unclassifiedAutomaticPageCount += 1;
        addScanCleanupCanvasSummaryPage(
            accumulator.automaticUnclassified,
            pageSize,
            options,
            1,
        );
        return;
    }
    addScanCleanupDocumentCanvasObservedPage(accumulator, pageSize, options, observedLayout);
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

/** Resolve the canvas from bounded summary state rather than page arrays. */
export function resolveScanCleanupDocumentCanvasFromAccumulator(
    accumulator: IScanCleanupDocumentCanvasAccumulator,
    renderDpi: number,
    options: IScanCleanupOptions,
    layoutEvidenceComplete = false,
): IScanCleanupDocumentCanvasPlan | null {
    void options;
    if (accumulator.producedPageCount === 0 || !Number.isFinite(renderDpi) || renderDpi <= 0) {
        return null;
    }
    const buckets: IScanCleanupCanvasSummaryBucket[] = [accumulator.forced];
    if (layoutEvidenceComplete) {
        buckets.push(
            accumulator.automaticSingle,
            accumulator.automaticSpread,
            accumulator.automaticUnclassified,
        );
    } else {
        // Unknown automatic pages must still contribute their whole sheet.
        // A partial observation cannot safely halve the document canvas: an
        // unclassified page may be a single sheet even when the first verdict
        // was a spread. This is the same conservative answer as the legacy
        // page-array planner and keeps an all-unknown document measurable.
        buckets.push(accumulator.automaticUnclassified);
        const observedBuckets = accumulator.firstObservedAutomaticShare === 2
            ? [
                accumulator.automaticSpread,
                accumulator.automaticSingle,
            ]
            : [
                accumulator.automaticSingle,
                accumulator.automaticSpread,
            ];
        const dominant = observedBuckets.reduce<IScanCleanupCanvasSummaryBucket | null>((best, candidate) => {
            if (candidate.count === 0) {
                return best;
            }
            if (best === null || candidate.count > best.count) {
                return candidate;
            }
            return best;
        }, null);
        if (dominant !== null) buckets.push(dominant);
    }
    const {
        largest,
        hasContinuousTone,
    } = resolveScanCleanupCanvasSummaryRect(buckets);
    if (largest === null) {
        return null;
    }
    const maxPixels = resolveScanCleanupMatchedCanvasMaxPixels([hasContinuousTone ? 'color' : 'bw']);
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
 * The produced pages left on automatic layout that nobody has classified yet.
 * Their sheet is measured whole, so a run started before detection finished
 * still writes one rectangle — but a page of that set that turns out to be a
 * spread lands on the document rectangle without being scaled to it, which is
 * a visible result the run has to name rather than leave to be discovered.
 */
export function resolveScanCleanupUnclassifiedPages(
    pageSizes: readonly IPdfPageSize[],
    options: IScanCleanupOptions,
    layoutByPage?: TScanCleanupLayoutByPage,
) {
    return pageSizes
        .filter(pageSize => !getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
        ).excluded
            && isAutomaticLayout(options, pageSize.pageNumber)
            && readObservedLayout(layoutByPage, pageSize.pageNumber) === undefined)
        .map(pageSize => pageSize.pageNumber);
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
): IScanCleanupDocumentCanvasPlan | null {
    if (layoutEvidenceComplete) {
        return resolveScanCleanupDocumentCanvas(
            pageSizes,
            renderDpi,
            options,
            layoutByPage,
        );
    }
    const automaticEvidence = pageSizes.filter(pageSize => (
        !getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
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
    );
}

/**
 * What a run tells the user when a document it *could* measure still answers no
 * canvas, or null when there is nothing to say.
 *
 * Both quality paths drop matching on a null canvas, so both report it the same
 * way: pages of differing size are what the setting was turned on to prevent,
 * and a run that silently stops preventing them is the one thing the user
 * cannot see from the output.
 *
 * A document whose every page the user excluded is the exception. It has no
 * canvas because it produces no pages at all, which is what the user asked for
 * — not geometry the run failed to read — and a warning there names a problem
 * that does not exist.
 */
export function resolveScanCleanupDroppedMatchWarningEvent(
    pageSizes: readonly IPdfPageSize[],
    options: IScanCleanupOptions,
): TScanCleanupWarningEvent | null {
    return pageSizes.every(
        pageSize => getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
        ).excluded,
    )
        ? null
        : {code: 'matched-canvas-dropped'};
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
 * The logical output paper expressed in the source PDF page's unrotated user
 * space. Split-pages consumes this coordinate system, so a quarter-turned page
 * divides its raw height: that is the axis presented horizontally when the
 * cutter runs.
 */
export function resolveScanCleanupOutputPageSpacePaperRect(
    pageSize: IPdfPageSize,
    shares: number,
    rotationDegreesOverride = 0,
): IScanCleanupOrientedRect {
    const divisor = Math.max(1, shares);
    const swapsAxes = normalizeScanCleanupQuarterTurns(
        pageSize.rotation + rotationDegreesOverride,
    ) % 2 === 1;
    return swapsAxes
        ? {
            widthPoints: pageSize.widthPoints,
            heightPoints: pageSize.heightPoints / divisor,
        }
        : {
            widthPoints: pageSize.widthPoints / divisor,
            heightPoints: pageSize.heightPoints,
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
 * The pixel grid the shared canvas rectangle is sampled on at one page's render
 * resolution, and the one rule every consumer of that grid answers by.
 *
 * The plan's own `widthPx`/`heightPx` are the rectangle rounded up at the
 * resolution the document was planned at; a page renders at its own resolution,
 * and the sidecar rebuilds the grid from the rectangle and that resolution by
 * rounding to nearest. A consumer that instead rescales the plan's pixel counts
 * lands a whole pixel away from the page the run actually produces — which is
 * what made the preview fitter present a 297 px canvas for the 296 px page the
 * output carried, and decide the margin-fitting boundary differently from it.
 */
export function resolveScanCleanupCanvasGridAtDpi(
    canvas: IScanCleanupOrientedRect,
    dpi: number,
) {
    return {
        widthPx: Math.max(1, Math.round(canvas.widthPoints / 72 * dpi)),
        heightPx: Math.max(1, Math.round(canvas.heightPoints / 72 * dpi)),
    };
}

/**
 * Fits one axis of a requested margin pair onto the matched canvas grid: the
 * single margin-fit policy every quality route answers by.
 *
 * A pair that does not leave one content pixel on its axis is reduced to the
 * pair that does, keeping the requested ratio so an off-centre request stays
 * off-centre. `native/scan-cleanup/src/adapters/batch_cli.rs` states the same
 * rule for the raster route it plans inside the sidecar; the preview fitter and
 * the lossless assembler call this one, so a page cannot be reported reduced on
 * one route and delivered exact on the other.
 */
export function fitScanCleanupMarginAxisPx(
    leadingPx: number,
    trailingPx: number,
    totalPx: number,
) {
    const sum = leadingPx + trailingPx;
    if (sum < totalPx || sum === 0) {
        return [
            leadingPx,
            trailingPx,
        ] as const;
    }
    const availablePx = Math.max(0, totalPx - 1);
    const fittedLeadingPx = Math.min(availablePx, Math.round(availablePx * leadingPx / sum));
    return [
        fittedLeadingPx,
        availablePx - fittedLeadingPx,
    ] as const;
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
): IScanCleanupDocumentCanvasPlan | null {
    // A page the user excluded is not on the sheet and must not decide its
    // size. A page outside a partial run's scope still is: it belongs to the
    // same document, and the run's output has to sit beside it.
    const produced = pageSizes.filter(
        pageSize => !getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
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
    const maxPixels = resolveScanCleanupMatchedCanvasMaxPixels(produced.map(
        pageSize => getScanCleanupPageOverride(
            options.pageOverrides,
            requirePageNumber(pageSize.pageNumber),
        ).outputModeOverride
            ?? options.outputMode,
    ));
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

/**
 * The canvas expressed in the page's own unrotated PDF user space, which is
 * where `evb-pdf-page-ops split-pages` writes the MediaBox. The output page
 * carries the source rotation plus the page's rotation override, so the box
 * that displays as the canvas is the canvas turned back by the same amount.
 */
export function resolveScanCleanupPageCanvasBox(
    canvas: IScanCleanupDocumentCanvasPlan,
    pageSize: IPdfPageSize,
    rotationDegreesOverride: number,
) {
    return orient({
        widthPoints: canvas.widthPoints,
        heightPoints: canvas.heightPoints,
    }, normalizeScanCleanupQuarterTurns(pageSize.rotation + rotationDegreesOverride));
}

// Paper that is already the canvas needs no scaling at all; anything past this
// is a real difference in the paper the scanner produced.
export const CANVAS_CONTENT_SCALE_EPSILON = 0.001;

/**
 * How much larger than the canvas a sheet may measure and still be the sheet
 * the canvas was measured from. A page rounded onto the shared grid can land a
 * pixel past the rectangle it is identical to, and only paper that needs more
 * grid than there is — a sheet cut into fewer pages than the rectangle expected
 * — is a real difference.
 *
 * The bound is exactly one pixel because it is stated in the units of the
 * shared grid, and that grid puts each rectangle on a whole pixel by rounding
 * to nearest (`Math.round` in `resolveScanCleanupCanvasGridAtDpi`): two
 * rectangles the run lands on the same pixel count differ by strictly less than
 * one pixel. A grid that stopped rounding to whole pixels, or a caller that
 * compared counts built at some other resolution, could move a rectangle
 * further than that and would have to raise this number with it.
 */
const SCAN_CLEANUP_CANVAS_GRID_TOLERANCE_PX = 1;

/**
 * Whether this output's paper is larger than the canvas it is normalized onto,
 * decided against the shared pixel grid rather than against a bare ratio.
 *
 * Every matched-canvas fitter reports the same condition for the same page, so
 * the decision lives here once. A fitter that measured its paper in its own
 * raster pixels and compared the ratio to 1 called a half sheet undersized
 * because halving an odd pixel count rounds.
 */
export function isScanCleanupPaperLargerThanCanvas(
    canvas: IScanCleanupDocumentCanvasPlan,
    paper: IScanCleanupOrientedRect,
) {
    return paper.widthPoints / canvas.widthPoints * canvas.widthPx
        > canvas.widthPx + SCAN_CLEANUP_CANVAS_GRID_TOLERANCE_PX
        || paper.heightPoints / canvas.heightPoints * canvas.heightPx
        > canvas.heightPx + SCAN_CLEANUP_CANVAS_GRID_TOLERANCE_PX;
}

// The lossless path never rasterizes, so its canvas grid is nominal: it exists
// only so both quality paths carry the same plan shape, and the rectangle —
// which is all the split assembler consumes — is identical either way.
export const SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI = 300;

/**
 * The pages matched page size cannot normalize without re-rendering them: they
 * carry a raster, and their content has to change scale to reach the document
 * canvas. Scaling such a page losslessly keeps its own pixels, which leaves it
 * on the shared sheet at a visibly different resolution — matched page size
 * promises one grid, so those pages are rendered instead.
 *
 * A page with no raster (vector or text) is not on this list: a content
 * transform places it on the canvas exactly, at any scale.
 *
 * This reads `pageSizes[pageNumber - 1]`, and the preview service reaches it
 * with geometry from an injectable dependency that no earlier call has
 * admitted, so the order check belongs here rather than at the callers.
 */
export function resolveMatchedCanvasResamplePages(
    pageSizes: readonly IPdfPageSize[],
    pageNumbers: readonly number[],
    options: IScanCleanupOptions,
    canvasGridDpi: number,
    rasterPages: {has: (pageNumber: number) => boolean},
    rasterDetectionAvailable: boolean,
    layoutByPage?: TScanCleanupLayoutByPage,
) {
    assertCanonicalPdfPageSizes(pageSizes, 'Scan cleanup matched canvas resample planning');
    const canvas = options.matchPageSize
        ? resolveScanCleanupDocumentCanvas(pageSizes, canvasGridDpi, options, layoutByPage)
        : null;
    if (!canvas) {
        return [];
    }
    return pageNumbers.filter(pageNumber => {
        const validPageNumber = requirePageNumber(pageNumber);
        const pageSize = pageSizes[pageNumber - 1];
        if (!pageSize || getScanCleanupPageOverride(options.pageOverrides, validPageNumber).excluded) {
            return false;
        }
        const scale = resolveScanCleanupCanvasFitScale(canvas, resolveScanCleanupOutputPageRect(
            pageSize,
            resolveSheetShares(options, pageNumber, layoutByPage),
        ));
        // Without pdfimages every page has to be treated as one that carries a
        // raster, because there is no evidence that it does not.
        const carriesRaster = !rasterDetectionAvailable || rasterPages.has(pageNumber);
        return carriesRaster && Math.abs(scale - 1) > CANVAS_CONTENT_SCALE_EPSILON;
    });
}

function rectFromPoints(points: Array<{
    x: number;
    y: number
}>): IScanCleanupRect {
    const left = Math.min(...points.map(point => point.x));
    const right = Math.max(...points.map(point => point.x));
    const bottom = Math.min(...points.map(point => point.y));
    const top = Math.max(...points.map(point => point.y));
    return {
        x: left,
        y: bottom,
        width: right - left,
        height: top - bottom,
    };
}

function unrotateAnalysisPoint(
    point: {
        x: number;
        y: number
    },
    inputWidthPx: number,
    inputHeightPx: number,
    rotationDegrees: TScanCleanupPageRotation,
) {
    if (rotationDegrees === 90) {
        return {
            x: point.y,
            y: inputHeightPx - point.x,
        };
    }
    if (rotationDegrees === 180) {
        return {
            x: inputWidthPx - point.x,
            y: inputHeightPx - point.y,
        };
    }
    if (rotationDegrees === 270) {
        return {
            x: inputWidthPx - point.y,
            y: point.x,
        };
    }
    return point;
}

function displayPointToPdf(
    point: {
        x: number;
        y: number
    },
    inputWidthPx: number,
    inputHeightPx: number,
    page: IPdfPageSize,
) {
    const markerX = point.x / inputWidthPx;
    const markerY = point.y / inputHeightPx;
    const x = page.xPoints;
    const y = page.yPoints;
    const rotation = ((Math.round(page.rotation / 90) * 90 % 360) + 360) % 360;
    if (rotation === 90) {
        return {
            x: x + markerY * page.widthPoints,
            y: y + markerX * page.heightPoints,
        };
    }
    if (rotation === 180) {
        return {
            x: x + (1 - markerX) * page.widthPoints,
            y: y + markerY * page.heightPoints,
        };
    }
    if (rotation === 270) {
        return {
            x: x + (1 - markerY) * page.widthPoints,
            y: y + (1 - markerX) * page.heightPoints,
        };
    }
    return {
        x: x + markerX * page.widthPoints,
        y: y + (1 - markerY) * page.heightPoints,
    };
}

/**
 * Where a rectangle the sidecar measured on a rendered page lands in the page's
 * own PDF user space. The lossless assembler never rasterizes, so every crop and
 * every share of the paper it is given has to be expressed in the coordinates
 * the page carries — through the display rotation the document applies and the
 * quarter turn the user asked for.
 */
export function mapLosslessAnalysisRectToPdf(
    rect: IScanCleanupPixelRect,
    inputWidthPx: number,
    inputHeightPx: number,
    cleanupRotation: TScanCleanupPageRotation,
    page: IPdfPageSize,
) {
    const corners = [
        {
            x: rect.xPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx,
        },
        {
            x: rect.xPx,
            y: rect.yPx + rect.heightPx,
        },
        {
            x: rect.xPx + rect.widthPx,
            y: rect.yPx + rect.heightPx,
        },
    ].map(point => unrotateAnalysisPoint(point, inputWidthPx, inputHeightPx, cleanupRotation))
        .map(point => displayPointToPdf(point, inputWidthPx, inputHeightPx, page));
    return rectFromPoints(corners);
}
