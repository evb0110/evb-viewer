import {
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupOptionsV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupDocumentCanvasPlan,
    TScanCleanupOutputHalf,
    TScanCleanupWarningEvent,
} from '@contracts/electronApiScanCleanup';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
} from '@contracts/scanCleanupPageOverrides';
import {
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IPdfPageSize,
    type IDetectedPageRaster,
    type IScanCleanupOutputMapping,
    type IScanCleanupRepresentationReport,
    type IScanCleanupPageRasterSource,
    type ISourceDpiDetectionResult,
    type TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import {
    toCropBoxPageSize,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {DETECTION_DPI} from '@evb/scan-cleanup/core/detection';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    buildScanCleanupPageOpsInstructions,
    isScanCleanupCliFallbackSentinel,
    serializeLegacyScanCleanupPageOpsInstructions,
    serializeScanCleanupPageOpsInstructions,
} from '@evb/scan-cleanup/core/compactManifest';
import {buildScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/buildManifest';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    sha256ScanCleanupFile,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {
    CANVAS_CONTENT_SCALE_EPSILON,
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    fitScanCleanupMarginAxisPx,
    isScanCleanupPaperLargerThanCanvas,
    type IScanCleanupRect,
    mapLosslessAnalysisRectToPdf,
    orientScanCleanupInsetsToPageSpace,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupCanvasGridAtDpi,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDroppedMatchWarningEventFromAccumulator,
    resolveScanCleanupOutputPageSpacePaperRect,
    resolveScanCleanupPageCanvasBox,
    placeScanCleanupCanvasBox,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {toScanCleanupPercentTenths} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import type {TEmitScanCleanupProgress} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    createEmptyScanCleanupSummary,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    ScanCleanupNativeToolUnavailableError,
    ScanCleanupStreamingEvidenceError,
} from '@evb/scan-cleanup/core/errors';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
} from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
} from '@evb/scan-cleanup/core/pageBatches';
import type {TScanCleanupPageScope} from '@evb/scan-cleanup/core/pageScope';
import {
    logRasterHandoff,
    mapScanCleanupRasterPages,
    resolveRasterHandoff,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';

/** The legacy map form remains accepted for focused direct/core tests. */
type TScanCleanupLosslessDpiSource = IScanCleanupPageRasterSource | ISourceDpiDetectionResult;

function isCompactLayeredRaster(raster: IDetectedPageRaster | undefined) {
    return raster?.hasBilevelLayer === true
        && raster.backgroundDpi !== undefined
        && Number.isFinite(raster.backgroundDpi)
        && raster.backgroundDpi > 0;
}

/**
 * A streaming child may inherit the parent's document canvas. In that case the
 * child must not restart a full geometry-sidecar pass just to rediscover the
 * same rectangle. `documentCanvas: null` is an explicit decision to run without
 * matched-page normalization; omitting it keeps the direct-call behavior.
 */
export interface IScanCleanupLosslessRunContext {
    documentCanvas?: IScanCleanupDocumentCanvasPlan | null;
    skipDocumentCanvasMeasurement?: boolean;
}

function resolveLosslessDpiSource(
    source: TScanCleanupLosslessDpiSource,
): IScanCleanupPageRasterSource {
    if ('getPageRaster' in source) {
        return source;
    }
    return {
        detected: source.pageRasterByNumber.size > 0,
        documentDpi: source.documentDpi,
        getPageRaster: pageNumber => source.pageRasterByNumber.get(pageNumber),
    };
}

async function readLosslessPageSizeBatch(
    pageSizeStore: IPdfPageSizeStore,
    pageNumbers: readonly number[],
) {
    if (pageNumbers.length === 0) {
        return [] as IPdfPageSize[];
    }
    const contiguous = pageNumbers.every((pageNumber, index) => (
        index === 0 || pageNumber === pageNumbers[index - 1]! + 1
    ));
    const pages = contiguous
        ? await pageSizeStore.readRange(pageNumbers[0]!, pageNumbers[pageNumbers.length - 1]! + 1)
        : await Promise.all(pageNumbers.map(pageNumber => pageSizeStore.getPage(pageNumber)));
    if (pages.length !== pageNumbers.length) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(pages.length)} pages for ${String(pageNumbers.length)} requested pages`,
        );
    }
    for (const [
        index,
        page,
    ] of pages.entries()) {
        const expectedPageNumber = pageNumbers[index]!;
        if (page.pageNumber !== expectedPageNumber) {
            throw new Error(
                `Scan cleanup page-size store returned page ${String(page.pageNumber)} for requested page ${String(expectedPageNumber)}`,
            );
        }
    }
    return pages;
}

export async function runLosslessScanCleanup(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    preparedWarnings: string[],
    pageNumbers: TScanCleanupPageScope,
    pageSizeStore: IPdfPageSizeStore,
    dpiDetails: TScanCleanupLosslessDpiSource,
    scratch: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    emitProgress: TEmitScanCleanupProgress,
    log: TScanCleanupLog,
    policy: IScanCleanupRuntimePolicy,
    dependencies: IRunScanCleanupPipelineDependencies,
    context: IScanCleanupLosslessRunContext = {},
) {
    // The assembler crops in the source page's own user space, so a page that
    // is handed another page's box writes a wrong document rather than a
    // failing one. This entry is reachable directly, not only through the
    // conversion run that already admitted its geometry.
    const dpiSource = resolveLosslessDpiSource(dpiDetails);
    if (!paths.pdfPageOpsBinary) {
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
    }
    const documentDpi = resolveSourceDpi(dpiSource.documentDpi);
    const resolveRasterPlan = (pageNumber: number, detected?: IDetectedPageRaster) => {
        const dpi = resolveSourceDpi(detected?.dpi, documentDpi);
        return {
            pageNumber,
            dpi,
            raster: detected === undefined
                ? undefined
                : {
                    dpi,
                    width: detected.width,
                    height: detected.height,
                },
        };
    };
    let rasterizedCount = 0;
    // A full lossless run may span many native batches. Count compact source
    // pages as each bounded raster window is read instead of rebuilding a
    // document-sized raster map just to calculate the publication budget.
    const sourceReportedIncompleteCompactCount = dpiSource.compactLayeredPageCountComplete === false;
    let compactLayeredPageCount = sourceReportedIncompleteCompactCount
        ? 0
        : dpiSource.compactLayeredPageCount ?? 0;
    const shouldCountCompactPages = sourceReportedIncompleteCompactCount
        || dpiSource.compactLayeredPageCount === undefined;
    let compactLayeredPageCountComplete = !sourceReportedIncompleteCompactCount;
    const pagePlanResolver = createPagePlanResolver(request, log, 'lossless');
    emitProgress('rasterizing', 0, pageNumbers.length, []);
    const summary = createEmptyScanCleanupSummary(pageNumbers.length, preparedWarnings);
    const warn = (message: string) => {
        summary.warnings.push(message);
        log('warn', `Scan cleanup: ${message}`);
    };
    // Every condition this run reports travels twice: as the sentence the user
    // reads and as the typed event it was formatted from. A consumer of the run
    // — the CLI summary, a caller checking what a lossless conversion had to do
    // — reads the code instead of parsing the sentence back.
    const warnEvent = (
        event: TScanCleanupWarningEvent,
        pageNumber?: number,
        half?: TScanCleanupOutputHalf,
    ) => {
        reportScanCleanupSummaryWarningEvent(summary, {
            event,
            ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
            ...(half === undefined ? {} : {half}),
        }, warn);
    };
    const canvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    if (
        request.options.matchPageSize
        && context.documentCanvas === undefined
        && context.skipDocumentCanvasMeasurement !== true
    ) {
        await pageSizeStore.forEachChunk(chunk => {
            signal.throwIfAborted();
            for (const page of chunk.pages) {
                signal.throwIfAborted();
                addScanCleanupDocumentCanvasPage(
                    canvasAccumulator,
                    toCropBoxPageSize(page),
                    request.options,
                    request.layoutByPage?.[String(page.pageNumber)],
                );
            }
        });
    }
    const analyzedPages: Array<{
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        outputs: Array<{
            half: INativeScanCleanupAnalysisOutputV3['half'];
            cropRect: IScanCleanupRect;
            paperRect: IScanCleanupRect;
            contentTransform?: {
                scale: number;
                translateX: number;
                translateY: number;
            };
            contentDetected: boolean;
        }>;
        pageOverride: ReturnType<typeof getScanCleanupPageOverride>;
        pageSize: IPdfPageSize;
        sourceDpi: number;
        sourceRasterDetected: boolean;
    }> = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const nativeOptionsBySource = new Map<number, INativeScanCleanupOptionsV3>();
    let classifiedCount = 0;
    let collectedCount = 0;
    for (const batch of iterateScanCleanupPageBatches(pageNumbers.length)) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
        const batchPageSizes = await readLosslessPageSizeBatch(pageSizeStore, batchPageNumbers);
        const pageSizeByNumber = new Map(batchPageSizes.map(page => [
            page.pageNumber,
            page,
        ]));
        const batchRasterByNumber = new Map(await Promise.all(batchPageNumbers.map(async pageNumber => [
            pageNumber,
            await dpiSource.getPageRaster(pageNumber),
        ] as const)));
        if (shouldCountCompactPages) {
            for (const raster of batchRasterByNumber.values()) {
                if (isCompactLayeredRaster(raster)) {
                    compactLayeredPageCount += 1;
                }
            }
        }
        const rasterPlans = batchPageNumbers.map(pageNumber => resolveRasterPlan(
            pageNumber,
            batchRasterByNumber.get(pageNumber),
        ));
        const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: DETECTION_DPI,
            raster: plan.raster,
        })), scratch, dependencies.getAvailableScratchBytes);
        logRasterHandoff(log, 'lossless analysis', rasterHandoff);
        const batchRasterizedPageNumbers = new Set<number>();
        const pageInputs = await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async plan => {
            signal.throwIfAborted();
            const extension = rasterHandoff.format;
            const inputPath = join(scratch, `analysis-${plan.pageNumber}.${extension}`);
            const renderer = extension === 'ppm'
                ? dependencies.renderPagePpm
                : dependencies.renderPage;
            try {
                await renderer(
                    paths,
                    log,
                    plan.pageNumber,
                    preparedPdfPath,
                    inputPath,
                    DETECTION_DPI,
                    undefined,
                    signal,
                    undefined,
                    undefined,
                    pageSizeByNumber.get(plan.pageNumber)?.renderBox ?? 'cropbox',
                );
                rasterizedCount += 1;
                batchRasterizedPageNumbers.add(plan.pageNumber);
                emitProgress('rasterizing', rasterizedCount, pageNumbers.length, batchRasterizedPageNumbers);
                return {
                    inputPath,
                    analysisInputPath: inputPath,
                    analysisDpi: DETECTION_DPI,
                    pageNumber: plan.pageNumber,
                    dpi: DETECTION_DPI,
                    ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                        ? {}
                        : {observedLayout: request.layoutByPage[String(plan.pageNumber)]}),
                    ...pagePlanResolver.resolve(plan.pageNumber),
                    pageMetadataPath: join(scratch, `analysis-${plan.pageNumber}.json`),
                };
            } catch (error) {
                await rm(inputPath, {force: true}).catch(() => undefined);
                throw error;
            }
        });
        const manifest = buildRunnableNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'lossless',
            hostMemoryBytes: policy.totalRamBytes,
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
            // Lossless analysis reads rasters and trusted layers staged by the
            // caller under the shared temp root, not only this scratch.
            allowedPathRoot: paths.tempDir,
        });
        const pages = manifest.pages;
        const manifestPath = join(scratch, 'lossless-analysis-manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        for (const [
            index,
            page,
        ] of pages.entries()) {
            nativeOptionsBySource.set(batchPageNumbers[index]!, page.options);
        }
        const classifiedPageNumbers = new Set<number>();
        emitProgress('classifying', classifiedCount, pageNumbers.length, []);
        try {
            await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, nativeProgress => {
                // Native reports page numbers relative to this manifest. Keep
                // the source mapping local to the bounded batch.
                if (nativeProgress.totalPages !== pages.length) {
                    throw new Error(
                        `evb-scan-cleanup analysis reported ${String(nativeProgress.totalPages)} total pages`
                        + ` for ${String(pages.length)} submitted pages`,
                    );
                }
                if (nativeProgress.stage !== 'page-complete') {
                    return;
                }
                if (nativeProgress.pageNumber !== undefined) {
                    const sourcePageNumber = batchPageNumbers[nativeProgress.pageNumber - 1];
                    if (sourcePageNumber === undefined) {
                        throw new Error(
                            `evb-scan-cleanup analysis reported unknown page index ${String(nativeProgress.pageNumber)}`,
                        );
                    }
                    if (!classifiedPageNumbers.has(sourcePageNumber)) {
                        classifiedPageNumbers.add(sourcePageNumber);
                        classifiedCount += 1;
                    }
                }
                emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers);
            }, {allowedPathRoot: paths.tempDir});
            emitProgress('collecting', collectedCount, pageNumbers.length, []);
        } finally {
            // Metadata is decoded below before this batch is discarded. The
            // raster inputs can go as soon as the sidecar exits, so a long run
            // never leaves one input per source page in scratch.
            await Promise.all(pages.map(page => rm(page.inputPath, {force: true})));
        }
        try {
            for (const [
                index,
                page,
            ] of pages.entries()) {
                const metadata = decodeNativeScanCleanupPageMetadataJson(
                    await readFile(page.pageMetadataPath, 'utf8'),
                );
                collectedCount += 1;
                emitProgress('collecting', collectedCount, pageNumbers.length);
                const sourcePageNumber = batchPageNumbers[index]!;
                pageMetadataBySource.set(sourcePageNumber, metadata);
                const pageOverride = getScanCleanupPageOverride(
                    request.options.pageOverrides,
                    requirePageNumber(sourcePageNumber),
                );
                if (metadata.excluded) {
                    summary.excludedPages += 1;
                    continue;
                }
                if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
                if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
                const pageSize = pageSizeByNumber.get(sourcePageNumber);
                if (!pageSize) {
                    throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(sourcePageNumber)}`);
                }
                const outputs = (metadata.outputs ?? []).map(output => {
                    const paper = resolveScanCleanupOutputPageSpacePaperRect(
                        pageSize,
                        output.half === 'full' ? 1 : 2,
                        pageOverride.rotationDegrees,
                    );
                    return {
                        half: output.half,
                        contentDetected: output.contentBox !== undefined,
                        cropRect: mapLosslessAnalysisRectToPdf(
                            output.cropRect,
                            output.inputWidthPx,
                            output.inputHeightPx,
                            metadata.rotationDegrees,
                            pageSize,
                        ),
                        // The cutter selects source pixels; it does not measure the
                        // paper. Both spread leaves inherit one half of the oriented
                        // source sheet even when their selected regions are unequal.
                        paperRect: {
                            x: 0,
                            y: 0,
                            width: paper.widthPoints,
                            height: paper.heightPoints,
                        },
                    };
                });
                if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') {
                    outputs.reverse();
                }
                analyzedPages.push({
                    sourcePageIndex: sourcePageNumber - 1,
                    rotationQuarterTurns: pageOverride.rotationDegrees / 90,
                    outputs,
                    pageOverride,
                    pageSize,
                    sourceDpi: resolveRasterPlan(
                        sourcePageNumber,
                        batchRasterByNumber.get(sourcePageNumber),
                    ).dpi,
                    sourceRasterDetected: batchRasterByNumber.get(sourcePageNumber) !== undefined,
                });
            }
        } finally {
            await Promise.all(pages.map(page => rm(page.pageMetadataPath, {force: true})));
        }
    }
    pagePlanResolver.report();
    const allOutputs = analyzedPages.flatMap(page => page.outputs.map(output => ({
        ...output,
        sourcePageIndex: page.sourcePageIndex,
        sourceDpi: page.sourceDpi,
        sourceRasterDetected: page.sourceRasterDetected,
    })));
    if (allOutputs.length === 0) {
        throw new Error('evb-scan-cleanup analysis produced no output pages');
    }
    const computedDocumentCanvas = request.options.matchPageSize
        ? resolveScanCleanupDocumentCanvasFromAccumulator(
            canvasAccumulator,
            SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
            request.options,
            true,
        )
        : null;
    const documentCanvas = context.documentCanvas === undefined
        ? computedDocumentCanvas
        : context.documentCanvas;
    if (documentCanvas === null && request.options.matchPageSize) {
        const droppedEvent = resolveScanCleanupDroppedMatchWarningEventFromAccumulator(canvasAccumulator);
        if (droppedEvent) warnEvent(droppedEvent);
    }
    const scaledRasterPages = new Set<number>();
    const fittedPageEvents: Array<{
        pageNumber: number;
        half: TScanCleanupOutputHalf;
        event: TScanCleanupWarningEvent
    }> = [];
    if (documentCanvas) {
        for (const page of analyzedPages) {
            const box = resolveScanCleanupPageCanvasBox(
                documentCanvas,
                page.pageSize,
                page.pageOverride.rotationDegrees,
            );
            // Margins are fitted on the pixel grid this page's raster would
            // carry, because that is the grid the raster route fits them on. A
            // pair the canvas rounds up to exactly its own width is a pair the
            // raster route has to reduce, while the same request measured in
            // exact points still fits — so the two quality routes of one
            // document disagreed about whether margins were reduced at all,
            // and delivered a margin that differed by the rounding. One grid
            // for the decision, exact points for the placement inside it.
            // Every analyzed page resolves through the same source-DPI helper;
            // an undetected page falls back to the document resolution, so a
            // page can never be measured against an unplanned resolution.
            const pageRenderDpi = page.sourceDpi;
            const canvasGrid = resolveScanCleanupCanvasGridAtDpi(documentCanvas, pageRenderDpi);
            // The same grid seen from the page's own unrotated user space,
            // where its paper rectangle is stated.
            const pageCanvasGrid = resolveScanCleanupCanvasGridAtDpi(box, pageRenderDpi);
            const canvasGridDpi = canvasGrid.widthPx / documentCanvas.widthPoints * 72;
            const pointsPerPixelX = documentCanvas.widthPoints / canvasGrid.widthPx;
            const pointsPerPixelY = documentCanvas.heightPoints / canvasGrid.heightPx;
            const marginsMm = resolveScanCleanupMarginsMm(request.options.marginsMm, page.pageOverride);
            const requestedVisualMarginsPx = {
                left: Math.max(0, Math.round(marginsMm.leftMm * canvasGridDpi / 25.4)),
                top: Math.max(0, Math.round(marginsMm.topMm * canvasGridDpi / 25.4)),
                right: Math.max(0, Math.round(marginsMm.rightMm * canvasGridDpi / 25.4)),
                bottom: Math.max(0, Math.round(marginsMm.bottomMm * canvasGridDpi / 25.4)),
            };
            /**
             * The margins this output actually delivers, in the page's own
             * unrotated user space, and whether fitting had to reduce them.
             * `pageAlignment` and the request both name visual edges, so the
             * fit happens on the presented canvas and only its result is
             * turned into page space.
             */
            const resolveFittedMargins = (marginsAvailable: boolean) => {
                const requested = marginsAvailable ? requestedVisualMarginsPx : {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                const [
                    leftPx,
                    rightPx,
                ] = fitScanCleanupMarginAxisPx(requested.left, requested.right, canvasGrid.widthPx);
                const [
                    topPx,
                    bottomPx,
                ] = fitScanCleanupMarginAxisPx(requested.top, requested.bottom, canvasGrid.heightPx);
                const visual = orientScanCleanupInsetsToPageSpace({
                    left: leftPx * pointsPerPixelX,
                    top: topPx * pointsPerPixelY,
                    right: rightPx * pointsPerPixelX,
                    bottom: bottomPx * pointsPerPixelY,
                }, page.pageSize.rotation + page.pageOverride.rotationDegrees);
                return {
                    marginLeft: visual.left,
                    marginBottom: visual.bottom,
                    innerWidth: Math.max(
                        pointsPerPixelX,
                        box.widthPoints - visual.left - visual.right,
                    ),
                    innerHeight: Math.max(
                        pointsPerPixelY,
                        box.heightPoints - visual.top - visual.bottom,
                    ),
                    reduced: leftPx !== requested.left
                        || topPx !== requested.top
                        || rightPx !== requested.right
                        || bottomPx !== requested.bottom,
                };
            };
            const marginsRequested = Object.values(requestedVisualMarginsPx)
                .some(margin => margin > 0);
            // A spread's shared scale is the smallest of the very numbers this
            // loop then places each leaf with, so both are measured once, here.
            // Deriving them twice let the scale a leaf was compared at and the
            // scale it was placed at drift apart under any later edit.
            const fittedOutputs = page.outputs.map(output => {
                const marginsAvailable = request.options.crop && output.contentDetected;
                const fitted = resolveFittedMargins(marginsAvailable);
                const paperScale = resolveScanCleanupCanvasFitScale(box, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                });
                const leafFit = Math.min(1, resolveScanCleanupCanvasFitScale({
                    widthPoints: fitted.innerWidth,
                    heightPoints: fitted.innerHeight,
                }, {
                    widthPoints: output.cropRect.width * paperScale,
                    heightPoints: output.cropRect.height * paperScale,
                }));
                return {
                    output,
                    marginsAvailable,
                    paperScale,
                    leafFit,
                    ...fitted,
                };
            });
            const sharedSpreadScale = page.outputs.length === 2
                && page.outputs.some(output => output.half === 'left')
                && page.outputs.some(output => output.half === 'right')
                ? Math.min(...fittedOutputs.map(fitted => fitted.paperScale * fitted.leafFit))
                : null;
            for (const {
                output,
                marginsAvailable,
                paperScale,
                leafFit,
                marginLeft,
                marginBottom,
                innerWidth,
                innerHeight,
                reduced,
            } of fittedOutputs) {
                if (marginsRequested && !marginsAvailable) {
                    fittedPageEvents.push({
                        pageNumber: page.sourcePageIndex + 1,
                        half: output.half,
                        event: {code: 'matched-canvas-margins-unavailable'},
                    });
                }
                if (reduced) {
                    fittedPageEvents.push({
                        pageNumber: page.sourcePageIndex + 1,
                        half: output.half,
                        event: {code: 'matched-canvas-margins-reduced'},
                    });
                }
                const scale = sharedSpreadScale ?? paperScale * leafFit;
                const fit = scale / paperScale;
                if (isScanCleanupPaperLargerThanCanvas({
                    widthPoints: box.widthPoints,
                    heightPoints: box.heightPoints,
                    ...pageCanvasGrid,
                }, {
                    widthPoints: output.paperRect.width,
                    heightPoints: output.paperRect.height,
                })) {
                    fittedPageEvents.push({
                        pageNumber: page.sourcePageIndex + 1,
                        half: output.half,
                        event: {
                            code: 'matched-canvas-paper-downscaled',
                            unit: 'pt',
                            scalePercentTenths: toScanCleanupPercentTenths(paperScale * 100),
                            documentCanvasWidth: box.widthPoints,
                            documentCanvasHeight: box.heightPoints,
                            paperWidth: output.paperRect.width,
                            paperHeight: output.paperRect.height,
                        },
                    });
                }
                if (fit < 1 - CANVAS_CONTENT_SCALE_EPSILON) {
                    fittedPageEvents.push({
                        pageNumber: page.sourcePageIndex + 1,
                        half: output.half,
                        event: {
                            code: 'matched-canvas-content-fitted',
                            unit: 'pt',
                            contentWidth: output.cropRect.width * scale,
                            contentHeight: output.cropRect.height * scale,
                            innerWidth,
                            innerHeight,
                        },
                    });
                }
                const alignment = page.pageOverride.placementOverrides?.[output.half]
                    ?? request.options.pageAlignment;
                const placementAnchor = request.placementAnchorsByPage?.[
                    String(page.sourcePageIndex + 1)
                ]?.[output.half];
                if (Math.abs(scale - 1) <= CANVAS_CONTENT_SCALE_EPSILON) {
                    const innerBox = placeScanCleanupCanvasBox(
                        output.cropRect,
                        innerWidth,
                        innerHeight,
                        alignment,
                        placementAnchor,
                        page.pageSize.rotation + page.pageOverride.rotationDegrees,
                    );
                    output.cropRect = {
                        x: innerBox.x - marginLeft,
                        y: innerBox.y - marginBottom,
                        width: box.widthPoints,
                        height: box.heightPoints,
                    };
                    continue;
                }
                const placed = placeScanCleanupCanvasBox(
                    {
                        x: output.cropRect.x * scale,
                        y: output.cropRect.y * scale,
                        width: output.cropRect.width * scale,
                        height: output.cropRect.height * scale,
                    },
                    innerWidth,
                    innerHeight,
                    alignment,
                    placementAnchor,
                    page.pageSize.rotation + page.pageOverride.rotationDegrees,
                );
                output.contentTransform = {
                    scale,
                    translateX: -(placed.x - marginLeft),
                    translateY: -(placed.y - marginBottom),
                };
                output.cropRect = {
                    x: 0,
                    y: 0,
                    width: box.widthPoints,
                    height: box.heightPoints,
                };
                if (page.sourceRasterDetected) {
                    scaledRasterPages.add(page.sourcePageIndex + 1);
                }
            }
        }
    }
    if (scaledRasterPages.size > 0) {
        warnEvent({
            code: 'matched-canvas-pages-scaled-in-place',
            pages: [...scaledRasterPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    for (const fitted of fittedPageEvents) warnEvent(fitted.event, fitted.pageNumber, fitted.half);
    summary.outputPages = allOutputs.length;
    const outputMappings: IScanCleanupOutputMapping[] = allOutputs.map((output, outputIndex) => {
        const sourcePage = output.sourcePageIndex + 1;
        const metadata = pageMetadataBySource.get(sourcePage);
        return {
            sourcePage,
            half: output.half,
            outputOrdinal: outputIndex + 1,
            rotationDegrees: metadata?.rotationDegrees ?? 0,
            excluded: false,
            blank: false,
        };
    });
    for (const pageNumber of pageNumbers) {
        const metadata = pageMetadataBySource.get(pageNumber);
        const hasOutput = outputMappings.some(mapping => mapping.sourcePage === pageNumber);
        if (hasOutput) continue;
        outputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: metadata?.rotationDegrees ?? getScanCleanupPageOverride(
                request.options.pageOverrides,
                requirePageNumber(pageNumber),
            ).rotationDegrees,
            excluded: metadata?.excluded === true,
            blank: metadata?.excluded !== true,
        });
    }
    const effectiveOptions: Array<{
        sourcePage: number;
        options: ReturnType<typeof materializeScanCleanupStampOptions>;
    }> = [];
    for (const sourcePage of pageNumbers) {
        const nativeOptions = nativeOptionsBySource.get(sourcePage);
        if (nativeOptions === undefined) {
            throw new Error(`evb-scan-cleanup returned no options for page ${String(sourcePage)}`);
        }
        effectiveOptions.push({
            sourcePage,
            options: materializeScanCleanupStampOptions({
                nativeOptions,
                options: request.options,
                qualityPath: 'lossless',
            }),
        });
    }
    const pagePlanDigests = effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
        record.sourcePage,
        record.options,
        pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
    ));
    const buildIds = await buildScanCleanupStampBuildIds({
        paths,
        ...(dependencies.hashNativeBinary === undefined
            ? {}
            : {hashNativeBinary: dependencies.hashNativeBinary}),
        assemblerBackend: request.assemblyBackend
            ?? paths.assemblyBackend
            ?? (isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
                ? 'cli-fallback-qpdf-page-ops'
                : 'native-pdf-page-ops'),
        transportMode: request.transportMode
            ?? paths.transportMode
            ?? 'source-preserved',
    });
    const stamp = buildScanCleanupProvenanceStamp({
        sourceSha256: await sha256ScanCleanupFile(preparedPdfPath),
        effectiveOptions,
        outputMappings,
        pagePlanDigests,
        buildIds,
    });
    const provenanceStampHex = encodeScanCleanupProvenanceStampHex(stamp);
    await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    const instructionsPath = join(scratch, 'split-pages.json');
    const instructions = buildScanCleanupPageOpsInstructions(analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(output => ({
            cropRect: output.cropRect,
            ...(output.contentTransform ? {contentTransform: output.contentTransform} : {}),
        })),
    })), provenanceStampHex);
    await writeFile(
        instructionsPath,
        paths.provenanceStampSupport === false
            ? serializeLegacyScanCleanupPageOpsInstructions(instructions)
            : serializeScanCleanupPageOpsInstructions(instructions),
    );
    emitProgress('assembling', 0, allOutputs.length, []);
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'split-pages',
        '--input',
        preparedPdfPath,
        '--qpdf',
        paths.qpdfBinary,
        '--output',
        stagedPdfPath,
        '--instructions-file',
        instructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(split-pages:scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        log,
    });
    emitProgress('assembling', allOutputs.length, allOutputs.length);
    const [
        sourceFile,
        outputFile,
    ] = await Promise.all([
        stat(preparedPdfPath),
        stat(stagedPdfPath),
    ]);
    const fullDocumentRun = request.sourcePageNumbers === undefined
        && request.sourcePageRange === undefined;
    if (
        fullDocumentRun
        && request.options.outputMode === 'auto'
        && !sourceReportedIncompleteCompactCount
    ) {
        compactLayeredPageCountComplete = true;
    }
    if (
        fullDocumentRun
        && request.options.outputMode === 'auto'
        && !compactLayeredPageCountComplete
    ) {
        throw new ScanCleanupStreamingEvidenceError(
            join(scratch, 'scan-cleanup-representation-report.json'),
            'Automatic scan cleanup could not establish a bounded compact-source budget for the full lossless document; '
            + 'source raster probing was incomplete, so publication was refused',
        );
    }
    const compactSourceBudget = resolveScanCleanupCompactSourceBudget({
        documentPageCount: pageNumbers.length,
        options: request.options,
        ...(compactLayeredPageCountComplete
            ? {compactLayeredPageCount}
            : {}),
        partialRun: !fullDocumentRun,
        sourceBytes: sourceFile.size,
    });
    const representationReport = {
        schemaVersion: 1 as const,
        sourceBytes: sourceFile.size,
        outputBytes: outputFile.size,
        outputToSourceByteRatio: outputFile.size / sourceFile.size,
        compactSourceBudget,
        outputMappings,
        pages: allOutputs.map((output, outputIndex) => {
            const sourcePageNumber = output.sourcePageIndex + 1;
            const metadata = pageMetadataBySource.get(sourcePageNumber);
            return {
                outputPageNumber: outputIndex + 1,
                outputOrdinal: outputIndex + 1,
                sourcePageNumber,
                semanticMode: 'color' as const,
                representation: 'source-preserved',
                preservationReason: 'source-preserved',
                sourceDpi: output.sourceDpi,
                sourceBackgroundDpi: null,
                renderDpi: output.sourceDpi,
                illuminationNormalized: false,
                textToneApplied: false,
                binarizationMode: null,
                half: output.half,
                rotationDegrees: metadata?.rotationDegrees ?? 0,
                excluded: false,
                blank: false,
            };
        }),
    } satisfies IScanCleanupRepresentationReport;
    await writeFile(
        join(scratch, 'scan-cleanup-representation-report.json'),
        `${JSON.stringify(representationReport, null, 2)}\n`,
    );
    assertScanCleanupCompactSourceBudget(outputFile.size, compactSourceBudget);
    return summary;
}
