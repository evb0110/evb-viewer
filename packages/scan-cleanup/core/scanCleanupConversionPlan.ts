/**
 * Platform-neutral final conversion planning. Desktop and browser adapters
 * supply bounded page-size, raster-fact and detection readers; this module
 * owns every decision those readers feed: the run's quality path, the
 * document canvas and each page's render plan.
 */
import type {
    IScanCleanupDetectionResult,
    IScanCleanupPlacementAnchorSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {
    collectScanCleanupSheetInkTops,
    usesScanCleanupInkAlignment,
} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {resolveScanCleanupSheetAnchorsFromSummary} from '@evb/scan-cleanup/core/placementAnchors';
import {
    detectPageRasterFromPageSize,
    resolveSourceDpi,
    type IDetectedPageRaster,
    type IPdfPageSize,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupPageRasterSource,
    type TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    ScanCleanupContractError, ScanCleanupTooLargeError,
} from '@evb/scan-cleanup/core/errors';
import {
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveMatchedCanvasResamplePagesFromStore,
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDocumentCanvasRenderDpi,
    resolveScanCleanupDroppedMatchWarningEventFromAccumulator,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {
    resolveScanCleanupCanvasPageDpi,
    resolveScanCleanupDocumentGuardrail,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupPlannedDpi,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {
    PDF_PAGE_SIZE_STORE_MAX_READ_PAGES,
    resolveScanCleanupAnalysisDpi,
    toCropBoxPageSize,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {
    describePageNumbers,
    toScanCleanupDpiThousandths,
} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';

export type TScanCleanupBoundedDetectionRequestFields = Pick<IRunScanCleanupPipelineRequest,
    | 'documentPriorByPage'
    | 'layoutByPage'
    | 'outputModeRecommendations'
    | 'pagePlanEvidenceByPage'
    | 'placementAnchorsByPage'
    | 'softAlphaForegroundRecommendations'
    | 'sourcePageMetadataByPage'
>;

export type TScanCleanupDocumentCanvas = NonNullable<
    ReturnType<typeof resolveScanCleanupDocumentCanvasFromAccumulator>
>;

type TScanCleanupOptions = IRunScanCleanupPipelineRequest['options'];
type TWarn = (message: string, level?: 'warn' | 'error') => void;
type TWarnEvent = (event: TScanCleanupWarningEvent, pageNumber?: number) => void;

export function createEmptyPageRasterSource(): IScanCleanupPageRasterSource {
    return {
        detected: false,
        documentDpi: null,
        compactLayeredPageCountComplete: true,
        getPageRaster: () => undefined,
    };
}

/** The dominant raster facts page geometry already carries, or null when any page lacks one. */
export async function createPageGeometryRasterSource(
    pageSizeStore: IPdfPageSizeStore,
    documentPageCount: number,
    signal: AbortSignal,
): Promise<IScanCleanupPageRasterSource | null> {
    let observedPages = 0;
    let expectedPageNumber = 1;
    let documentDpi = 0;
    let everyPageHasRaster = true;
    await pageSizeStore.forEachChunk(chunk => {
        signal.throwIfAborted();
        if (chunk.pageCount !== documentPageCount) {
            throw new Error(
                `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(documentPageCount)} document pages`,
            );
        }
        for (const page of chunk.pages) {
            if (page.pageNumber !== expectedPageNumber) {
                throw new Error(
                    `Scan cleanup page-size store returned page ${String(page.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                );
            }
            expectedPageNumber += 1;
            observedPages += 1;
            const raster = detectPageRasterFromPageSize(page);
            if (raster === undefined) {
                everyPageHasRaster = false;
                continue;
            }
            documentDpi = Math.max(documentDpi, raster.dpi);
        }
    });
    if (
        !everyPageHasRaster
        || observedPages !== documentPageCount
        || expectedPageNumber - 1 !== documentPageCount
        || documentDpi <= 0
    ) {
        return null;
    }
    return {
        detected: true,
        documentDpi,
        compactLayeredPageCountComplete: true,
        getPageRaster: async pageNumber => detectPageRasterFromPageSize(
            await pageSizeStore.getPage(pageNumber),
        ),
    };
}

export function assertScanCleanupInkAnchorCapacity(
    pageCount: number,
    options: TScanCleanupOptions,
    placementAnchorSummary: IRunScanCleanupPipelineRequest['placementAnchorSummary'],
) {
    if (
        pageCount > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES
        && usesScanCleanupInkAlignment(options)
        && placementAnchorSummary === undefined
    ) {
        throw new ScanCleanupTooLargeError();
    }
}

function resolveBatchPlacementAnchors(
    baseRequest: IRunScanCleanupPipelineRequest,
    results: ReadonlyMap<number, IScanCleanupDetectionResult>,
    pageNumbers: readonly number[],
    summary: IScanCleanupPlacementAnchorSummary | undefined,
) {
    const anchorsByPage: NonNullable<IRunScanCleanupPipelineRequest['placementAnchorsByPage']> = {};
    for (const pageNumber of pageNumbers) {
        const key = String(pageNumber);
        const result = results.get(pageNumber);
        const evidence = result?.pagePlanEvidence ?? baseRequest.pagePlanEvidenceByPage?.[key];
        // The sheet's correction is chosen from all of its `ink` halves, so an
        // explicit anchor for one half still lets that half vote for the other.
        const resolved = {
            ...(summary === undefined ? {} : resolveScanCleanupSheetAnchorsFromSummary(
                summary,
                collectScanCleanupSheetInkTops(baseRequest.options, {
                    pageNumber,
                    layoutClassification: result?.classification ?? evidence?.layoutClassification,
                    evidence,
                    metadata: result?.sourcePageMetadata ?? baseRequest.sourcePageMetadataByPage?.[key],
                }, summary.referenceHeightPoints),
            )),
            ...baseRequest.placementAnchorsByPage?.[key],
        };
        if (Object.keys(resolved).length > 0) {
            anchorsByPage[key] = resolved;
        }
    }
    return anchorsByPage;
}

/** Read only one bounded conversion window from the detection store. */
export async function readDetectionResultsForPageNumbers(
    store: IRunScanCleanupPipelineRequest['detectionResultStore'],
    pageNumbers: readonly number[],
    signal: AbortSignal,
) {
    const results: IScanCleanupDetectionResult[] = [];
    if (store === undefined || pageNumbers.length === 0) {
        return results;
    }
    if (!pageNumbers.every((pageNumber, index) => pageNumber === pageNumbers[0]! + index)) {
        for (const pageNumber of pageNumbers) {
            signal.throwIfAborted();
            const result = await store.getPage(pageNumber);
            if (result !== undefined) results.push(result);
        }
        return results;
    }
    for (let start = 0; start < pageNumbers.length; start += PDF_PAGE_SIZE_STORE_MAX_READ_PAGES) {
        signal.throwIfAborted();
        const firstPageNumber = pageNumbers[start]!;
        const lastPageNumberExclusive = pageNumbers[
            Math.min(pageNumbers.length, start + PDF_PAGE_SIZE_STORE_MAX_READ_PAGES) - 1
        ]! + 1;
        results.push(...await store.readRange(firstPageNumber, lastPageNumberExclusive));
    }
    return results;
}

export function buildBoundedDetectionRequestFields(
    baseRequest: IRunScanCleanupPipelineRequest,
    results: readonly IScanCleanupDetectionResult[],
    pageNumbers: readonly number[],
): TScanCleanupBoundedDetectionRequestFields {
    const resultByPage = new Map(results.map(result => [
        result.pageNumber,
        result,
    ] as const));
    const layoutByPage: NonNullable<IRunScanCleanupPipelineRequest['layoutByPage']> = {};
    const pagePlanEvidenceByPage: NonNullable<IRunScanCleanupPipelineRequest['pagePlanEvidenceByPage']> = {};
    const outputModeRecommendations: NonNullable<IRunScanCleanupPipelineRequest['outputModeRecommendations']> = {};
    const softAlphaForegroundRecommendations: NonNullable<IRunScanCleanupPipelineRequest['softAlphaForegroundRecommendations']> = {};
    const sourcePageMetadataByPage: NonNullable<IRunScanCleanupPipelineRequest['sourcePageMetadataByPage']> = {};
    const documentPriorByPage: NonNullable<IRunScanCleanupPipelineRequest['documentPriorByPage']> = {};
    for (const pageNumber of pageNumbers) {
        const key = String(pageNumber);
        const result = resultByPage.get(requirePageNumber(pageNumber));
        const layout = result?.classification ?? baseRequest.layoutByPage?.[key];
        if (layout !== undefined) layoutByPage[key] = layout;
        const pagePlanEvidence = result?.pagePlanEvidence ?? baseRequest.pagePlanEvidenceByPage?.[key];
        if (pagePlanEvidence !== undefined) pagePlanEvidenceByPage[key] = pagePlanEvidence;
        const outputMode = result?.recommendedOutputMode ?? baseRequest.outputModeRecommendations?.[key];
        if (outputMode !== undefined) outputModeRecommendations[key] = outputMode;
        const softAlpha = result?.softAlphaForegroundRecommendation
            ?? baseRequest.softAlphaForegroundRecommendations?.[key];
        if (softAlpha !== undefined) softAlphaForegroundRecommendations[key] = softAlpha;
        const sourcePageMetadata = result?.sourcePageMetadata ?? baseRequest.sourcePageMetadataByPage?.[key];
        if (sourcePageMetadata !== undefined) sourcePageMetadataByPage[key] = sourcePageMetadata;
        const documentPrior = result?.documentPrior ?? baseRequest.documentPriorByPage?.[key];
        if (documentPrior !== undefined) documentPriorByPage[key] = documentPrior;
    }
    return {
        documentPriorByPage,
        layoutByPage,
        outputModeRecommendations,
        pagePlanEvidenceByPage,
        placementAnchorsByPage: resolveBatchPlacementAnchors(
            baseRequest,
            resultByPage,
            pageNumbers,
            baseRequest.placementAnchorSummary,
        ),
        softAlphaForegroundRecommendations,
        sourcePageMetadataByPage,
    };
}

/** A request that carries one batch's decisions in place of the store they came from. */
export function withBoundedDetectionFields(
    request: IRunScanCleanupPipelineRequest,
    fields: TScanCleanupBoundedDetectionRequestFields,
): IRunScanCleanupPipelineRequest {
    const {
        detectionResultStore: _detectionResultStore,
        ...requestWithoutStore
    } = request;
    return {
        ...requestWithoutStore,
        ...fields,
    };
}

export interface IPlanScanCleanupRunQualityInput {
    request: IRunScanCleanupPipelineRequest;
    documentPageCount: number;
    pageSizeStore: IPdfPageSizeStore;
    rasterSource: IScanCleanupPageRasterSource;
    /** Whether a structural raster probe could answer for pages geometry cannot. */
    rasterDetectionAvailable: boolean;
    rasterMaxPixels?: number | undefined;
    signal: AbortSignal;
    warn: TWarn;
    warnEvent: TWarnEvent;
    /** Receives every page of the ordered geometry pass; supplying it forces that pass. */
    onGeometryPage?: (page: IPdfPageSize) => Promise<void>;
}

export interface IScanCleanupRunQualityPlan {
    documentCanvas: TScanCleanupDocumentCanvas | null;
    /** The request options with the run's single quality and matching decision applied. */
    options: TScanCleanupOptions;
    losslessRun: boolean;
}

/**
 * Decide, once for the whole document, which quality path the run takes and
 * which rectangle and grid matched pages share. Bounded children and every
 * platform execute this decision; none of them re-derive it.
 */
export async function planScanCleanupRunQuality({
    request, documentPageCount, pageSizeStore, rasterSource, rasterDetectionAvailable,
    rasterMaxPixels, signal, warn, warnEvent, onGeometryPage,
}: IPlanScanCleanupRunQualityInput): Promise<IScanCleanupRunQualityPlan> {
    let losslessRun = request.options.preserveOriginalQuality === true;
    let documentDpi = resolveSourceDpi(rasterSource.documentDpi);
    const documentCanvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    let layoutEvidenceComplete = true;
    let finestCanvasDpi = 0;
    const unclassifiedPages: number[] = [];
    if (onGeometryPage !== undefined || request.options.matchPageSize) {
        let expectedGeometryPageNumber = 1;
        await pageSizeStore.forEachChunk(async chunk => {
            signal.throwIfAborted();
            if (chunk.pageCount !== documentPageCount) {
                throw new Error(
                    `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(documentPageCount)} document pages`,
                );
            }
            const detectionByPage = new Map((await readDetectionResultsForPageNumbers(
                request.detectionResultStore,
                chunk.pages.map(page => page.pageNumber),
                signal,
            )).map(result => [
                result.pageNumber,
                result,
            ] as const));
            for (const measuredPage of chunk.pages) {
                if (measuredPage.pageNumber !== expectedGeometryPageNumber) {
                    throw new Error(
                        `Scan cleanup page-size store returned page ${String(measuredPage.pageNumber)} where page ${String(expectedGeometryPageNumber)} was expected`,
                    );
                }
                expectedGeometryPageNumber += 1;
                const detectionResult = detectionByPage.get(requirePageNumber(measuredPage.pageNumber));
                const detectedPageMetadata = detectionResult?.sourcePageMetadata;
                const page = detectedPageMetadata?.renderBox === 'mediabox'
                    ? detectedPageMetadata
                    : toCropBoxPageSize(detectedPageMetadata ?? measuredPage);
                if (onGeometryPage !== undefined) await onGeometryPage(page);
                if (!request.options.matchPageSize) continue;
                const pageNumber = page.pageNumber;
                const observedLayout = detectionResult?.classification
                    ?? request.layoutByPage?.[String(pageNumber)];
                if (observedLayout === undefined) layoutEvidenceComplete = false;
                if (addScanCleanupDocumentCanvasPage(
                    documentCanvasAccumulator,
                    page,
                    request.options,
                    observedLayout,
                )) {
                    unclassifiedPages.push(pageNumber);
                }
                const pageOverride = getScanCleanupPageOverride(
                    request.options.pageOverrides,
                    requirePageNumber(pageNumber),
                    request.options.pageOverrideDefaults,
                    request.options.marginsMm,
                );
                // Probe every page in the ordered geometry pass, even when an
                // override excludes its output. The full-run Auto budget
                // describes the source document, and the scalar observer must
                // not mistake an excluded page for a failed or out-of-order
                // raster probe.
                const sourceRaster = await rasterSource.getPageRaster(pageNumber);
                if (!pageOverride.excluded) {
                    if (rasterSource.documentDpi !== undefined && rasterSource.documentDpi !== null) {
                        documentDpi = Math.max(documentDpi, resolveSourceDpi(rasterSource.documentDpi));
                    }
                    const sourceDpi = resolveSourceDpi(sourceRaster?.dpi, documentDpi);
                    const outputMode = resolveScanCleanupEffectiveOutputMode({
                        options: request.options,
                        pageOverride,
                        detectedOutputMode: detectionResult?.recommendedOutputMode
                            ?? request.outputModeRecommendations?.[String(pageNumber)],
                    });
                    finestCanvasDpi = Math.max(finestCanvasDpi, resolveScanCleanupCanvasPageDpi({
                        configuredMode: outputMode
                            ?? pageOverride.outputModeOverride
                            ?? request.options.outputMode,
                        sourceDpi,
                        sourceRasterDetected: sourceRaster !== undefined,
                        guardrail: resolveScanCleanupDocumentGuardrail(sourceRaster, sourceDpi, page),
                    }));
                }
            }
        });
        if (expectedGeometryPageNumber - 1 !== documentPageCount) {
            throw new Error(
                `Scan cleanup page-size store returned ${String(expectedGeometryPageNumber - 1)} pages for ${String(documentPageCount)} document pages`,
            );
        }
    }
    // A page left on automatic that detection has not classified is measured
    // as the whole sheet it is: assuming it is a spread because its neighbours
    // are would halve the document rectangle and place every page that is not
    // a spread at half the document's scale. Measuring the sheet can only leave
    // such a page padded, and the run names the pages it had to measure that way.
    const unclassifiedPageCount = request.options.matchPageSize
        ? documentCanvasAccumulator.unclassifiedAutomaticPageCount
        : 0;
    if (unclassifiedPageCount > 0) {
        warn(
            `Matched page size measured ${String(unclassifiedPageCount)} page(s) as whole sheets `
            + 'because layout detection had not classified them when the run started; '
            + 'a page among them that is a two-page spread is placed on the document rectangle '
            + (unclassifiedPages.length > 0
                ? `without being scaled to it: ${describePageNumbers(unclassifiedPages)}`
                : 'without being scaled to it on the document rectangle'),
        );
    }
    // Matching a document onto one rectangle also means one content scale.
    // The lossless assembler can carry a page's own objects at a different
    // scale, but it cannot give a page that was scanned at a lower resolution
    // the document's pixel grid without resampling it. Where the two promises
    // collide, matched page size wins and this run renders, and it says so
    // rather than shipping a document whose pages are the same paper at
    // visibly different resolutions.
    const resampleCanvas = request.options.matchPageSize
        ? resolveScanCleanupDocumentCanvasFromAccumulator(
            documentCanvasAccumulator,
            SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
            request.options,
            layoutEvidenceComplete,
        )
        : null;
    const resampledPages = request.options.preserveOriginalQuality === true
        ? await resolveMatchedCanvasResamplePagesFromStore({
            pageSizeStore,
            documentPageCount,
            canvas: resampleCanvas,
            options: request.options,
            rasterSource,
            rasterDetectionAvailable,
            // The layouts the canvas pass read.
            readLayouts: async pageNumbers => buildBoundedDetectionRequestFields(
                request,
                await readDetectionResultsForPageNumbers(request.detectionResultStore, pageNumbers, signal),
                pageNumbers,
            ).layoutByPage ?? {},
        })
        : [];
    if (resampledPages.length > 0) {
        losslessRun = false;
        warnEvent({
            code: 'matched-canvas-pages-resampled',
            pages: resampledPages.map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    // The rectangle the preview presented, on the finest resolution the
    // *document* is rendered at, so it has one output DPI and no page is
    // resampled below the detail it arrived with. Auto decisions are already
    // locked at this point; canvas planning must consume those same modes or
    // a Color/Gray book is silently allocated on the binary synthesis grid.
    // Run scope still cannot affect the grid because decisions and source
    // raster facts are supplied for the complete document.
    const documentCanvas = request.options.matchPageSize
        && documentCanvasAccumulator.producedPageCount > 0
        ? resolveScanCleanupDocumentCanvasFromAccumulator(
            documentCanvasAccumulator,
            losslessRun ? SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI : finestCanvasDpi,
            request.options,
            losslessRun || layoutEvidenceComplete,
            rasterMaxPixels,
        )
        : null;
    // One page scanned far finer than the rest raises the grid the whole
    // document is normalized onto, and the pixel budget its output modes allow
    // is what stops that becoming a document nothing can render. That is a
    // real loss against what the finest page asked for, so the run names the
    // resolution it actually normalized at.
    const canvasDpi = documentCanvas === null
        ? finestCanvasDpi
        : resolveScanCleanupDocumentCanvasDpi(documentCanvas);
    if (!losslessRun && canvasDpi < finestCanvasDpi * 0.99) {
        warnEvent({
            code: 'matched-canvas-document-dpi-normalized',
            canvasDpi,
            finestPageDpi: finestCanvasDpi,
        });
    }
    const options = {
        ...request.options,
        // One quality decision at every document size: a coordinator never
        // enters a planner itself, and each bounded child runs the path this
        // run decided.
        preserveOriginalQuality: losslessRun,
        matchPageSize: documentCanvas !== null && request.options.matchPageSize,
    };
    if (request.options.matchPageSize && !options.matchPageSize) {
        const droppedEvent = resolveScanCleanupDroppedMatchWarningEventFromAccumulator(documentCanvasAccumulator);
        if (droppedEvent) warnEvent(droppedEvent);
    }
    return {
        documentCanvas,
        options,
        losslessRun,
    };
}

export interface IScanCleanupRasterGuardrail {
    dpi: number;
    width: number;
    height: number;
}

export interface IPlanScanCleanupFinalPagesInput {
    request: IRunScanCleanupPipelineRequest;
    documentCanvas: TScanCleanupDocumentCanvas | null;
    rasterSource: IScanCleanupPageRasterSource;
    pageSizeStore: IPdfPageSizeStore;
    rasterMaxPixels?: number | undefined;
    log: TScanCleanupLog;
    signal: AbortSignal;
    warnEvent: TWarnEvent;
    /** Measure a bilevel page whose geometry names no trusted raster. */
    probeGuardrail: (pageNumber: number, page: IPdfPageSize) => Promise<IScanCleanupRasterGuardrail>;
}

export type TScanCleanupFinalPagePlan = Awaited<ReturnType<typeof planScanCleanupFinalPages>>['rasterPlans'][number];

/**
 * Resolve each page's locked output mode, guardrail, render and analysis DPI
 * and page plan for one bounded page set. Every final output mode is
 * preflighted from trusted geometry before any producer starts.
 */
export async function planScanCleanupFinalPages(
    {
        request, documentCanvas, rasterSource, pageSizeStore, rasterMaxPixels, log, signal, warnEvent, probeGuardrail,
    }:
    IPlanScanCleanupFinalPagesInput,
    pageNumbers: Iterable<number>,
) {
    const documentDpi = resolveSourceDpi(rasterSource.documentDpi);
    // Materialize raster facts only for this bounded page set.
    const detectedRasterByPage = new Map<number, IDetectedPageRaster>();
    for (const pageNumber of pageNumbers) {
        const raster = await rasterSource.getPageRaster(pageNumber);
        if (raster !== undefined) detectedRasterByPage.set(pageNumber, raster);
    }
    const resolvePageSourceDpi = (pageNumber: number) => resolveSourceDpi(
        detectedRasterByPage.get(pageNumber)?.dpi,
        rasterSource.documentDpi === undefined || rasterSource.documentDpi === null
            ? documentDpi
            : Math.max(documentDpi, resolveSourceDpi(rasterSource.documentDpi)),
    );
    const resolvePageOutputMode = (pageNumber: number) => {
        const pageOverride = getScanCleanupPageOverride(
            request.options.pageOverrides,
            requirePageNumber(pageNumber),
            request.options.pageOverrideDefaults,
            request.options.marginsMm,
        );
        if (pageOverride.excluded) {
            return 'color' as const;
        }
        const outputMode = resolveScanCleanupEffectiveOutputMode({
            options: request.options,
            pageOverride,
            detectedOutputMode: request.outputModeRecommendations?.[String(pageNumber)],
        });
        // Every page in this admitted batch must carry the decision already
        // exposed in preview.
        if (outputMode !== undefined) {
            return outputMode;
        }
        throw new ScanCleanupContractError(
            `Scan cleanup page ${String(pageNumber)} has no locked Auto output-mode decision`,
        );
    };
    const requiresBilevelQuality = (pageNumber: number) => {
        const mode = resolvePageOutputMode(pageNumber);
        return mode === 'bw' || mode === 'mixed';
    };
    // A detected source raster is the most exact guardrail; otherwise the PDF
    // page view is the same CropBox rectangle the renderer will materialize.
    const pageGeometryByNumber = new Map<number, IPdfPageSize>();
    const ensureGuardrail = async (pageNumber: number) => {
        const detected = detectedRasterByPage.get(pageNumber);
        const sourceDpi = resolvePageSourceDpi(pageNumber);
        const page = await pageSizeStore.getPage(pageNumber);
        pageGeometryByNumber.set(pageNumber, page);
        let guardrail: IScanCleanupRasterGuardrail | undefined = resolveScanCleanupDocumentGuardrail(
            detected,
            sourceDpi,
            page,
        );
        if (guardrail === undefined && requiresBilevelQuality(pageNumber)) {
            signal.throwIfAborted();
            guardrail = await probeGuardrail(pageNumber, page);
        }
        if (guardrail === undefined) {
            throw new ScanCleanupContractError(
                `Scan cleanup has no trusted raster geometry for page ${String(pageNumber)}`,
            );
        }
        return guardrail;
    };
    // What this run renders each page at, read off the mode the run resolved
    // for it. The shared canvas may not read that mode: see
    // resolveScanCleanupCanvasPageDpi.
    const resolveRasterPlan = (
        pageNumber: number,
        guardrail: IScanCleanupRasterGuardrail,
        renderBox: 'cropbox' | 'mediabox',
    ) => {
        const resolvedOutputMode = resolvePageOutputMode(pageNumber);
        return {
            pageNumber,
            renderBox,
            resolvedOutputMode,
            ...resolveScanCleanupPlannedDpi({
                sourceDpi: resolvePageSourceDpi(pageNumber),
                outputCarriesBinaryLayer: requiresBilevelQuality(pageNumber),
                sourceRasterDetected: detectedRasterByPage.has(pageNumber),
                maxPixels: resolveScanCleanupPipelineMaxPixels(resolvedOutputMode, rasterMaxPixels),
                guardrail,
            }),
            guardrail,
        };
    };
    // Native reconstructs the final uniform canvas from each page's render DPI
    // and the document rectangle. The plan's pixel fields alone cannot
    // constrain that reconstruction, so every page that would recreate a
    // different grid is normalized before its raster is rendered. This raises
    // coarse scans onto the document grid as well as capping pages that would
    // exceed it, so a partial run cannot silently fall back to the selected
    // page's lower resolution.
    const capRasterPlanDpi = (plan: ReturnType<typeof resolveRasterPlan>) => {
        // A page already lowered by its own raster guardrail cannot safely be
        // raised again merely to reach the document grid. Native will fit that
        // bounded raster onto the shared physical canvas.
        const dpi = plan.dpi < plan.requestedRenderDpi
            ? plan.dpi
            : resolveScanCleanupDocumentCanvasRenderDpi(plan.dpi, documentCanvas);
        if (dpi < plan.dpi) {
            warnEvent({
                code: 'matched-canvas-page-dpi-capped',
                pageNumber: requirePageNumber(plan.pageNumber),
                appliedDpiThousandths: toScanCleanupDpiThousandths(dpi),
                requestedDpiThousandths: toScanCleanupDpiThousandths(plan.dpi),
            });
        }
        return dpi === plan.dpi ? plan : {
            ...plan,
            dpi,
        };
    };
    const pagePlanResolver = createPagePlanResolver(request, log, 'final');
    const rasterPlans: Array<ReturnType<typeof capRasterPlanDpi>> = [];
    for (const pageNumber of pageNumbers) {
        const guardrail = await ensureGuardrail(pageNumber);
        const page = pageGeometryByNumber.get(pageNumber)!;
        rasterPlans.push(capRasterPlanDpi(resolveRasterPlan(
            pageNumber,
            guardrail,
            page.renderBox ?? 'cropbox',
        )));
    }
    const resolvedPagePlanByNumber = new Map(rasterPlans.map(plan => [
        plan.pageNumber,
        pagePlanResolver.resolve(plan.pageNumber),
    ]));
    pagePlanResolver.report();
    // Detection classified each page on this plane, and routing must see the
    // same one, so the page's geometry record chooses it.
    const analysisDpiByPage = new Map(rasterPlans.map(plan => [
        plan.pageNumber,
        resolveScanCleanupAnalysisDpi(pageGeometryByNumber.get(plan.pageNumber)),
    ]));
    return {
        documentDpi,
        rasterPlans,
        pageGeometryByNumber,
        detectedRasterByPage,
        resolvedPagePlanByNumber,
        analysisDpiByPage,
        resolvePageOutputMode,
        resolvePageSourceDpi,
    };
}

type TResolvedPagePlan = ReturnType<ReturnType<typeof createPagePlanResolver>['resolve']>;

/**
 * The native manifest fields one final page carries besides its staging
 * locations: render facts, source facts and the locked decisions.
 */
export function describeScanCleanupFinalPage(
    request: IRunScanCleanupPipelineRequest,
    plan: TScanCleanupFinalPagePlan,
    {
        analysisDpi, detectedRaster, pageGeometry, resolvedPagePlan,
    }: {
        analysisDpi: number;
        detectedRaster: IDetectedPageRaster | undefined;
        pageGeometry: IPdfPageSize | undefined;
        resolvedPagePlan: TResolvedPagePlan | undefined;
    },
) {
    const pageKey = String(plan.pageNumber);
    return {
        analysisDpi,
        pageNumber: plan.pageNumber,
        dpi: plan.dpi,
        sourceDpi: plan.sourceDpi,
        ...(pageGeometry === undefined ? {} : {pdfPage: {
            xPoints: pageGeometry.xPoints,
            yPoints: pageGeometry.yPoints,
            widthPoints: pageGeometry.widthPoints,
            heightPoints: pageGeometry.heightPoints,
            rotation: pageGeometry.rotation,
            sourceDpi: plan.sourceDpi,
        }}),
        sourceHasBilevelLayer: detectedRaster?.hasBilevelLayer ?? false,
        ...(detectedRaster?.backgroundDpi === undefined
            ? {}
            : {sourceBackgroundDpi: detectedRaster.backgroundDpi}),
        requestedRenderDpi: plan.requestedRenderDpi,
        ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
        ...(request.softAlphaForegroundRecommendations?.[pageKey] === undefined
            ? {}
            : {preferSoftAlphaForeground: request.softAlphaForegroundRecommendations[pageKey]}),
        ...(request.layoutByPage?.[pageKey] === undefined
            ? {}
            : {observedLayout: request.layoutByPage[pageKey]!}),
        ...(request.documentPriorByPage?.[pageKey] === undefined
            ? {}
            : {documentPrior: request.documentPriorByPage[pageKey]}),
        ...resolvedPagePlan,
    };
}
