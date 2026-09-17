import type { TPageNumber } from '@contracts/pageNumbers';
import {parsePageNumber} from '@contracts/pageNumbers';

import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputHalf,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/domain';
import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/geometry';
import type {
    IScanCleanupPlacementAnchorSummaryCluster,
    IScanCleanupPreviewMetadata,
} from '@contracts/scan-cleanup/ipc';
import type {IScanCleanupPlacementAnchor} from '@contracts/scan-cleanup/nativeProtocolV3';

export type TScanCleanupResolvedPageLayout = ReturnType<typeof resolveScanCleanupPageLayout>;

export const DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE: Readonly<IScanCleanupPageOverride> = Object.freeze({
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
});

export const SCAN_CLEANUP_OUTPUT_HALVES = [
    'full',
    'left',
    'right',
] as const satisfies readonly TScanCleanupOutputHalf[];

export function usesScanCleanupInkAlignment(options: IScanCleanupOptions) {
    return options.matchPageSize
        && (options.pageAlignment === 'ink'
            || Object.values(options.pageOverrideDefaults?.placementOverrides ?? {})
                .some(alignment => alignment === 'ink')
            || Object.values(options.pageOverrides).some(override => Object
                .values(override.placementOverrides ?? {})
                .some(alignment => alignment === 'ink')));
}

// The options object crosses both Vue reactivity and worker structured-clone
// boundaries. Keep the renderer-only association out of the page map so the
// map remains a plain sparse record, and carry the scalar through options as
// `pageOverrideDefaults`. Main and worker entry points attach it again before
// calling the shared page resolver.
const scanCleanupPageOverrideDefaults = new WeakMap<
    TScanCleanupPageOverrides,
    IScanCleanupPageOverride
>();

export function createScanCleanupPageOverride(
    value: Partial<IScanCleanupPageOverride> = {},
    documentMargins?: IScanCleanupMarginsMm,
): IScanCleanupPageOverride {
    const {
        manualContentBoxes,
        manualZones,
        manualSkewDegrees,
        marginsMm,
        outputModeOverride,
        placementOverrides,
        ...scalarValues
    } = value;
    return {
        ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        ...scalarValues,
        ...(manualSkewDegrees === undefined ? {} : {manualSkewDegrees}),
        ...(manualContentBoxes ? {manualContentBoxes: {...manualContentBoxes}} : {}),
        ...(manualZones ? {manualZones: {
            picture: manualZones.picture.map(zone => ({
                layer: zone.layer,
                polygon: {
                    points: zone.polygon.points.map(point => ({...point})),
                    rotationDegrees: zone.polygon.rotationDegrees,
                },
            })),
            fill: manualZones.fill.map(polygon => ({
                points: polygon.points.map(point => ({...point})),
                rotationDegrees: polygon.rotationDegrees,
            })),
        }} : {}),
        ...(outputModeOverride ? {outputModeOverride} : {}),
        ...(marginsMm && (!documentMargins || !areScanCleanupMarginsMmEqual(marginsMm, documentMargins))
            ? {marginsMm: {...marginsMm}}
            : {}),
        ...(placementOverrides ? {placementOverrides: {...placementOverrides}} : {}),
    };
}

/**
 * Associates a document-wide default with a sparse page override record.
 * The association is intentionally O(1); callers that cross a process boundary
 * must pass the same value as `IScanCleanupOptions.pageOverrideDefaults` and
 * attach it after decoding the request.
 */
export function attachScanCleanupPageOverrideDefaults(
    overrides: TScanCleanupPageOverrides,
    defaults: IScanCleanupPageOverride | undefined,
    documentMargins?: IScanCleanupMarginsMm,
) {
    if (defaults === undefined) {
        scanCleanupPageOverrideDefaults.delete(overrides);
        return;
    }
    scanCleanupPageOverrideDefaults.set(
        overrides,
        createScanCleanupPageOverride(defaults, documentMargins),
    );
}

export function setScanCleanupPageOverrideDefaults(
    overrides: TScanCleanupPageOverrides,
    defaults: IScanCleanupPageOverride,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const normalized = createScanCleanupPageOverride(defaults, documentMargins);
    scanCleanupPageOverrideDefaults.set(overrides, normalized);
    return normalized;
}

export function getScanCleanupPageOverrideDefaults(
    overrides: TScanCleanupPageOverrides,
): IScanCleanupPageOverride {
    return createScanCleanupPageOverride(scanCleanupPageOverrideDefaults.get(overrides));
}

export function getScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: TPageNumber,
): IScanCleanupPageOverride {
    const explicit = overrides[String(pageNumber)];
    return explicit === undefined
        ? createScanCleanupPageOverride(scanCleanupPageOverrideDefaults.get(overrides))
        : createScanCleanupPageOverride(explicit);
}

export function setScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: TPageNumber,
    value: IScanCleanupPageOverride,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const key = String(pageNumber);
    const normalized = createScanCleanupPageOverride(value, documentMargins);
    if (isDefaultScanCleanupPageOverride(normalized)) {
        Reflect.deleteProperty(overrides, key);
        return;
    }
    overrides[key] = normalized;
}

export function isDefaultScanCleanupPageOverride(value: IScanCleanupPageOverride) {
    return value.rotationDegrees === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees
        && value.layoutOverride === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride
        && value.excluded === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded
        && value.manualSplit === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.manualSplit
        && value.manualSkewDegrees === undefined
        && value.outputModeOverride === undefined
        && Object.keys(value.manualContentBoxes ?? {}).length === 0
        && (value.manualZones?.picture.length ?? 0) === 0
        && (value.manualZones?.fill.length ?? 0) === 0
        && value.marginsMm === undefined
        && Object.keys(value.placementOverrides ?? {}).length === 0;
}

export function areScanCleanupMarginsMmEqual(
    left: IScanCleanupMarginsMm,
    right: IScanCleanupMarginsMm,
) {
    return left.leftMm === right.leftMm
        && left.topMm === right.topMm
        && left.rightMm === right.rightMm
        && left.bottomMm === right.bottomMm;
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
 * The content height `ink` placement needs on top of the free space every
 * other alignment is resolved from: the anchor addresses the inner rect the
 * margins leave, not the free space, so the content's own size has to come back
 * in to convert between the two.
 */
export interface IScanCleanupInkPlacement {
    anchor: IScanCleanupPlacementAnchor;
    contentHeight: number;
}

function clampScanCleanupOffset(value: number, available: number) {
    return Math.min(Math.max(value, 0), Math.max(available, 0));
}

export function resolveScanCleanupPlacementOffset(
    availableWidth: number,
    availableHeight: number,
    alignment: IScanCleanupOptions['pageAlignment'],
    ink?: IScanCleanupInkPlacement,
) {
    if (alignment === 'ink') {
        // Ink moves content vertically only; horizontally it is centred like
        // `top-center`, which is also what an output without a resolved anchor
        // falls back to, and what native does for the same page. The anchor is
        // applied to the inner rect the margins leave rather than the source
        // sheet it was measured on, so distances below the top edge scale with
        // the printable height — the same proportion the content itself keeps.
        return {
            x: availableWidth / 2,
            y: ink === undefined
                ? 0
                : clampScanCleanupOffset(
                    ink.anchor.yNormalized * (availableHeight + ink.contentHeight),
                    availableHeight,
                ),
        };
    }
    const [
        vertical,
        horizontal = vertical,
    ] = alignment.split('-');
    return {
        // Keep this in the geometry contract's native currency. Pixel callers
        // may quantize the result at their serialization boundary, while the
        // lossless PDF path must retain the fractional point offset.
        x: horizontal === 'left' ? 0 : horizontal === 'right' ? availableWidth : availableWidth / 2,
        y: vertical === 'top' ? 0 : vertical === 'bottom' ? availableHeight : availableHeight / 2,
    };
}

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
 * Clusters are grown greedily over the sorted values while the run stays within
 * the tolerance of its first member, so a slow drift across the document splits
 * instead of chaining every page into one cluster. Ordering and tie-breaks are
 * fully determined by (value, page, half), so the same document resolves to
 * the same anchors whatever order its evidence arrived in.
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
    const snapped = new Array<number>(samples.length);
    const clusters: IScanCleanupAnchorCluster[] = [];
    let cluster: typeof ordered = [];
    const flushCluster = () => {
        const [first] = cluster;
        const last = cluster.at(-1);
        if (first === undefined || last === undefined) {
            return;
        }
        const value = resolveScanCleanupAnchorClusterValue(cluster.map(entry => entry.sample.yNormalized));
        for (const entry of cluster) {
            snapped[entry.index] = value;
        }
        clusters.push({
            start: first.sample.yNormalized,
            end: last.sample.yNormalized,
            value,
            size: cluster.length,
        });
        cluster = [];
    };
    for (const entry of ordered) {
        const [first] = cluster;
        if (first !== undefined && entry.sample.yNormalized - first.sample.yNormalized > tolerance) {
            flushCluster();
        }
        cluster.push(entry);
    }
    flushCluster();
    return {
        clusters,
        snapped,
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
    } = snapScanCleanupAnchors(samples, tolerance);
    // A sparse calibration window represents the full document. Use the
    // window's cardinality for its support threshold so a common cluster is
    // not discarded simply because it was downsampled to 256 entries.
    const representedSampleCount = Number.isSafeInteger(sampleCount) && sampleCount > 0
        ? Math.min(sampleCount, samples.length)
        : samples.length;
    const topEdge = resolveScanCleanupInkTopEdge(clusters, representedSampleCount);
    samples.forEach((sample, index) => {
        const snappedValue = snapped[index] ?? sample.yNormalized;
        const page = anchorsByPage.get(sample.pageNumber) ?? {};
        page[sample.half] = {yNormalized: Math.max(0, snappedValue - topEdge)};
        anchorsByPage.set(sample.pageNumber, page);
    });
    return {
        anchorsByPage,
        topEdgeNormalized: topEdge,
        clusters: clusters.map(cluster => ({
            startNormalized: cluster.start,
            endNormalized: cluster.end,
            valueNormalized: cluster.value,
        })),
    };
}

/**
 * Turns the ink tops a document measured into the vertical positions its
 * outputs will actually be printed at.
 *
 * Pages whose ink starts within a few millimetres of each other were meant to
 * start in the same place, and a reader flipping through the finished book sees
 * the difference as the text block jumping; every member of such a cluster is
 * snapped to the cluster's median, the position that moves the fewest pages.
 * Versos and rectos are clustered together: a book has one top margin, and the
 * canvas gives every leaf the same height to measure it against.
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
    const defaults = serialize(pageOverrideDefaults ?? getScanCleanupPageOverrideDefaults(overrides));
    const defaultEntry = defaults === ':auto::' ? '' : `@default=${defaults}`;
    const pageEntries = Object.keys(overrides)
        .map(pageKey => {
            const pageNumber = parsePageNumber(Number(pageKey));
            if (pageNumber === null) {
                return '';
            }
            const canvasInputs = serialize(getScanCleanupPageOverride(overrides, pageNumber));
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
