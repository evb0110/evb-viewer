import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {AnnotationMode} from '@app/services/pdfjs/runtimeLib';
import {
    createBrowserPdfBoxRaster,
    renderBrowserPdfRaster,
} from '@app/platform/browser-api/browserPdfRaster';
import {runBrowserScanCleanupWorkerRequest} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewEvent,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
    type TNativeScanCleanupPreviewOutputArtifactMetadataV3,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {IScanCleanupWasmRenderPreviewRequest} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import type {TScanCleanupWasmOutcome} from '@contracts/scan-cleanup/browserScanCleanupWorker';
import {SCAN_CLEANUP_MAX_DIMENSION_PX} from '@contracts/scan-cleanup/inputLimits';
import {
    detectPageRasterFromPageSize,
    type IPdfPageSize,
} from '@evb/scan-cleanup/core/types';
import {
    PREVIEW_DPI,
    resolvePagePreviewDpi,
    resolvePreviewProcessingDpi,
    resolveScanCleanupAnalysisDpi,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {
    DEFAULT_SOURCE_DPI,
    planScanCleanupDetailPreview,
    projectScanCleanupDetailOutputMetadata,
    projectScanCleanupLosslessPreview,
    projectScanCleanupPreviewOutputMetadata,
    projectScanCleanupPreviewPageMetadata,
    resolveFallbackDetailDpi,
    scanCleanupPageNeedsMatchedResample,
    type TScanCleanupPreviewBaseOutputs,
} from '@evb/scan-cleanup/core/policy/scanCleanupPreviewPolicy';
import {
    resolveScanCleanupManifestPageOptions,
    serializeScanCleanupManifestDocumentPrior,
    type IScanCleanupManifestPageFacts,
} from '@evb/scan-cleanup/core/policy/scanCleanupManifestPagePolicy';
import {
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupProvisionalDocumentCanvasFromAccumulator,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {resolveReusablePagePlan} from '@evb/scan-cleanup/core/policy/effectiveOptions';

/**
 * One immutable revision of a source document, opened once for every page a
 * cleanup operation reads: its page records, the ones desktop's page-size
 * sidecar writes, and the PDF.js document its rasters are painted from.
 */
export interface IBrowserScanCleanupSource {
    ref: string;
    revision: string;
    pageSizes: readonly IPdfPageSize[];
    pdf: IPdfDocument;
}

/** A page raster the engine reads: a binary PPM and its size and resolution. */
interface IPageRaster {
    ppm: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
    dpi: number;
}

/**
 * What a detail render of this base needs: the base's source raster and each
 * output's metadata and cleaned composite, as desktop keeps them on disk.
 */
export interface IBrowserScanCleanupPreviewBase {
    /** The page view the base rendered, so a detail renders the same pixels. */
    pageSize: IPdfPageSize;
    /** The displayed original's size and resolution. */
    raw: Omit<IPageRaster, 'ppm'>;
    /** The cleanup input the base rendered at its render resolution. */
    source: IPageRaster;
    sourceDpiCandidate: number | undefined;
    sourceRasterDetected: boolean;
    outputMode: TNativeScanCleanupPreviewOutputArtifactMetadataV3['outputMode'] | undefined;
    outputs: TScanCleanupPreviewBaseOutputs;
    metadataJsonByHalf: Partial<Record<string, string>>;
    cleanedByHalf: Partial<Record<string, Uint8Array>>;
    pageMetadata: Extract<TScanCleanupPreviewWireResult, {pageMetadata: unknown}>['pageMetadata'];
    totalPages: number;
}

export class BrowserScanCleanupEngineError extends Error {
    public constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'BrowserScanCleanupEngineError';
    }
}

function unwrap<TResult>(outcome: TScanCleanupWasmOutcome<TResult>): TResult {
    if (outcome.status === 'failed') {
        throw new BrowserScanCleanupEngineError(outcome.error.code, outcome.error.message);
    }
    return outcome.result;
}

/**
 * Paints the page view the desktop page record describes, annotation-free and
 * on white as Poppler renders a cleanup raster, and reads it back in the
 * cleanup worker. A region renders one tile of the full raster.
 */
async function renderPageRaster(
    page: IPdfPage,
    pageSize: IPdfPageSize,
    dpi: number,
    maxPixels: number,
    signal: AbortSignal,
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
): Promise<IPageRaster> {
    const box = createBrowserPdfBoxRaster(page, pageSize, dpi);
    const painted = await renderBrowserPdfRaster(page, box.viewport, signal, {
        annotationMode: AnnotationMode.DISABLE,
        maxPixels,
        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
        region: region === undefined
            ? box
            : {
                x: box.x + region.x,
                y: box.y + region.y,
                width: region.width,
                height: region.height,
            },
        tooLarge: (width, height) => new BrowserScanCleanupEngineError(
            'too-large',
            `Scan cleanup page raster ${String(width)}x${String(height)} exceeds the engine's limits`,
        ),
    });
    const ppm = painted.image instanceof Uint8Array
        ? new Uint8Array(painted.image)
        : (await runBrowserScanCleanupWorkerRequest('assemble-raster', {image: painted.image}, signal)).ppm;
    return {
        ppm,
        width: region?.width ?? box.width,
        height: region?.height ?? box.height,
        dpi,
    };
}

/** A copy for the worker, which takes over every buffer it is sent. */
function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
}

interface IDocumentFacts {
    previewDpi: number;
    pageSourceDpi: number | undefined;
}

/**
 * The document resolution a preview starts from, as desktop measures it over
 * the page records: the finest scan, when every page records one.
 */
function readDocumentFacts(source: IBrowserScanCleanupSource, pageSize: IPdfPageSize | undefined): IDocumentFacts {
    let allPagesHaveRasterMetadata = true;
    let documentDpi = 0;
    for (const page of source.pageSizes) {
        const raster = detectPageRasterFromPageSize(page);
        if (raster === undefined) {
            allPagesHaveRasterMetadata = false;
        } else {
            documentDpi = Math.max(documentDpi, raster.dpi);
        }
    }
    const pageRaster = pageSize === undefined ? undefined : detectPageRasterFromPageSize(pageSize);
    return {
        previewDpi: allPagesHaveRasterMetadata && documentDpi > 0 ? Math.min(PREVIEW_DPI, documentDpi) : PREVIEW_DPI,
        pageSourceDpi: allPagesHaveRasterMetadata ? pageRaster?.dpi : undefined,
    };
}

function provisionalCanvasAccumulator(source: IBrowserScanCleanupSource, request: IScanCleanupPreviewRequest) {
    const accumulator = createScanCleanupDocumentCanvasAccumulator();
    for (const page of source.pageSizes) {
        addScanCleanupDocumentCanvasPage(accumulator, page, request.options, request.layoutByPage?.[String(page.pageNumber)]);
    }
    return accumulator;
}

export interface IRenderBrowserScanCleanupPreviewInput {
    request: IScanCleanupPreviewRequest;
    source: IBrowserScanCleanupSource;
    signal: AbortSignal;
    /** The base preview of this page under the same identity, for a detail request. */
    base: IBrowserScanCleanupPreviewBase | null;
    emitRaw: (event: IScanCleanupRawPreviewEvent) => void;
}

export interface IBrowserScanCleanupPreviewRendering {
    result: TScanCleanupPreviewWireResult;
    /** Set when this render is a base a later detail can refine. */
    base: IBrowserScanCleanupPreviewBase | null;
}

/**
 * Renders one page of the workspace preview as desktop's preview renderer
 * does: the original at the base preview resolution, streamed as soon as it
 * is painted, then each output's cleaned composite, or a detail tile over a
 * base this session already rendered. Every decision is the shared policy's;
 * only the rasters (PDF.js instead of Poppler) and the engine host differ.
 */
export async function renderBrowserScanCleanupWorkspacePreview(
    input: IRenderBrowserScanCleanupPreviewInput,
): Promise<IBrowserScanCleanupPreviewRendering> {
    const {
        request, source, signal,
    } = input;
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    const totalPages = source.pageSizes.length;
    const recordedPageSize = source.pageSizes[request.pageNumber - 1];
    if (recordedPageSize === undefined) {
        throw new RangeError(`Scan cleanup preview page ${String(request.pageNumber)} is outside the document`);
    }
    // A page whose plan detection measured on its MediaBox view is previewed
    // through that view, as cleanup renders it.
    const pageSize: IPdfPageSize = request.sourcePageMetadata?.renderBox === 'mediabox'
        ? {
            ...recordedPageSize,
            xPoints: request.sourcePageMetadata.xPoints,
            yPoints: request.sourcePageMetadata.yPoints,
            widthPoints: request.sourcePageMetadata.widthPoints,
            heightPoints: request.sourcePageMetadata.heightPoints,
            renderBox: 'mediabox',
        }
        : recordedPageSize;
    const facts = readDocumentFacts(source, recordedPageSize);
    const pageRaster = detectPageRasterFromPageSize(pageSize);
    const sourceDpiCandidate = pageRaster?.dpi;
    let previewDpi = facts.previewDpi;
    let pageSourceDpi = facts.pageSourceDpi;
    let pagePreviewRenderDpi = resolvePagePreviewDpi(pageSize, Math.min(PREVIEW_DPI, pageSourceDpi ?? previewDpi));
    if (!request.options.matchPageSize && sourceDpiCandidate !== undefined) {
        previewDpi = Math.min(PREVIEW_DPI, sourceDpiCandidate);
        pageSourceDpi = sourceDpiCandidate;
        pagePreviewRenderDpi = resolvePagePreviewDpi(pageSize, previewDpi);
    }
    const accumulator = request.options.matchPageSize ? provisionalCanvasAccumulator(source, request) : null;
    const documentCanvas = accumulator === null
        ? null
        : resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(
            accumulator,
            previewDpi,
            request.options,
            request.layoutDetectionComplete === true,
        );
    const matchingCanvas = request.options.preserveOriginalQuality && accumulator !== null
        ? documentCanvas ?? resolveScanCleanupDocumentCanvasFromAccumulator(
            accumulator,
            previewDpi,
            request.options,
            request.layoutDetectionComplete === true,
        )
        : null;
    const rasterizedByMatching = matchingCanvas !== null && source.pageSizes.some(page => scanCleanupPageNeedsMatchedResample({
        page,
        carriesRaster: detectPageRasterFromPageSize(page) !== undefined,
        canvas: matchingCanvas,
        options: request.options,
        layoutByPage: request.layoutByPage,
    }));
    const basePreviewDpi = documentCanvas === null
        ? pagePreviewRenderDpi
        : Math.min(pagePreviewRenderDpi, Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(documentCanvas))));
    const page = await source.pdf.getPage(request.pageNumber);
    try {
        if (request.detail !== undefined) {
            return await renderDetail(input, page, pageSize, documentCanvas, sourceDpiCandidate);
        }
        const baseRaw = await renderPageRaster(page, pageSize, basePreviewDpi, SCAN_CLEANUP_RASTER_MAX_PIXELS, signal);
        const {png} = await runBrowserScanCleanupWorkerRequest('encode-png', {ppm: copy(baseRaw.ppm)}, signal);
        signal.throwIfAborted();
        input.emitRaw({
            ownerId: request.ownerId,
            documentRevision: request.documentRevision,
            requestId: request.requestId,
            pageNumber: request.pageNumber,
            totalPages,
            rawImageData: png,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
        });
        const sourceDpi = pageRaster?.dpi ?? pageSourceDpi ?? previewDpi;
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        const outputMode = resolveScanCleanupEffectiveOutputMode({
            options: request.options,
            pageOverride,
            detectedOutputMode: request.outputModeRecommendation,
        });
        const requestedProcessingDpi = resolvePreviewProcessingDpi({
            displayDpi: basePreviewDpi,
            outputMode,
            sourceDpi,
        });
        const processingCanvas = documentCanvas !== null && accumulator !== null && requestedProcessingDpi > basePreviewDpi
            ? resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(
                accumulator,
                requestedProcessingDpi,
                request.options,
                request.layoutDetectionComplete === true,
            )
            : null;
        const renderDpi = processingCanvas === null
            ? requestedProcessingDpi
            : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(processingCanvas)));
        return await renderBase(input, page, pageSize, {
            raw: {
                width: baseRaw.width,
                height: baseRaw.height,
                dpi: baseRaw.dpi,
            },
            rawPng: png,
            rendered: [baseRaw],
            renderDpi,
            sourceDpi,
            sourceDpiCandidate,
            documentCanvas,
            lossless: request.options.preserveOriginalQuality && !rasterizedByMatching,
            resolvedOutputMode: request.outputModeRecommendation,
            retainBase: true,
        });
    } finally {
        page.cleanup();
    }
}

interface IBaseRenderPlan {
    /** The displayed original's size and resolution. */
    raw: Omit<IPageRaster, 'ppm'>;
    /** The original as PNG, which a preserve-quality preview shows as each output. */
    rawPng?: Uint8Array;
    /** Rasters of this page already painted, reused at their own resolution. */
    rendered: readonly IPageRaster[];
    renderDpi: number;
    sourceDpi: number;
    sourceDpiCandidate: number | undefined;
    documentCanvas: IScanCleanupDocumentCanvasPlan | null;
    lossless: boolean;
    resolvedOutputMode: IScanCleanupPreviewRequest['outputModeRecommendation'];
    /** A fallback detail renders a base it does not keep. */
    retainBase: boolean;
}

async function renderBase(
    input: IRenderBrowserScanCleanupPreviewInput,
    page: IPdfPage,
    pageSize: IPdfPageSize,
    plan: IBaseRenderPlan,
): Promise<IBrowserScanCleanupPreviewRendering> {
    const {
        request, source, signal,
    } = input;
    const totalPages = source.pageSizes.length;
    const rasterAt = async (dpi: number, rendered: readonly IPageRaster[]) => rendered.find(candidate => candidate.dpi === dpi)
        ?? renderPageRaster(page, pageSize, dpi, SCAN_CLEANUP_RASTER_MAX_PIXELS, signal);
    const raster = await rasterAt(plan.renderDpi, plan.rendered);
    const analysisDpi = resolveScanCleanupAnalysisDpi(pageSize);
    const canonical = await rasterAt(analysisDpi, [
        raster,
        ...plan.rendered,
    ]);
    const matchedCanvas = plan.documentCanvas ?? undefined;
    const effectiveOptions = matchedCanvas === undefined && request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const facts: IScanCleanupManifestPageFacts = {
        pageNumber: request.pageNumber,
        dpi: plan.lossless ? analysisDpi : plan.renderDpi,
        sourceDpi: plan.sourceDpi,
        sourceHasBilevelLayer: false,
        requestedRenderDpi: plan.renderDpi,
        ...(plan.resolvedOutputMode === undefined ? {} : {resolvedOutputMode: plan.resolvedOutputMode}),
        ...(request.softAlphaForegroundRecommendation === undefined
            ? {}
            : {preferSoftAlphaForeground: request.softAlphaForegroundRecommendation}),
        ...(request.layoutByPage?.[String(request.pageNumber)] === undefined
            ? {}
            : {observedLayout: request.layoutByPage[String(request.pageNumber)]!}),
        ...resolveReusablePagePlan(
            request.options,
            request.layoutByPage,
            request.pagePlanEvidence === undefined ? undefined : {[String(request.pageNumber)]: request.pagePlanEvidence},
            request.pageNumber,
        ),
        ...(request.placementAnchors === undefined ? {} : {placementAnchors: request.placementAnchors}),
    };
    const options = resolveScanCleanupManifestPageOptions({
        options: effectiveOptions,
        qualityPath: plan.lossless ? 'lossless' : 'raster',
        experimental: {
            autoDewarp: request.options.autoDewarp ?? false,
            ...(request.options.autoDewarpDepth === undefined ? {} : {autoDewarpDepth: request.options.autoDewarpDepth}),
        },
        page: facts,
    });
    const documentPrior = request.documentPrior === undefined
        ? {}
        : {documentPrior: serializeScanCleanupManifestDocumentPrior(request.documentPrior)};
    if (plan.lossless) {
        const analysis = unwrap(await runBrowserScanCleanupWorkerRequest('analyze-page', {
            input: copy(canonical.ppm),
            page: {
                options,
                sourcePageIndex: request.pageNumber - 1,
                canvasScope: 'page',
                ...documentPrior,
            },
        }, signal));
        const finished = unwrap(await runBrowserScanCleanupWorkerRequest('finish-page-analysis', {
            pageMetadataJson: analysis.pageMetadataJson,
            pdfPlacement: {
                pdfPage: {
                    xPoints: pageSize.xPoints,
                    yPoints: pageSize.yPoints,
                    widthPoints: pageSize.widthPoints,
                    heightPoints: pageSize.heightPoints,
                    rotation: pageSize.rotation,
                    sourceDpi: plan.sourceDpi,
                },
                options,
                renderMode: 'preview',
                ...(matchedCanvas === undefined ? {} : {documentCanvas: matchedCanvas}),
            },
        }, signal));
        if (plan.rawPng === undefined) throw new Error('Scan cleanup preserve-quality preview has no original');
        return {
            result: projectScanCleanupLosslessPreview({
                pageNumber: request.pageNumber,
                totalPages,
                raw: {
                    width: plan.raw.width,
                    height: plan.raw.height,
                    bytes: plan.rawPng,
                },
                pageMetadata: decodeNativeScanCleanupPreviewPageMetadataJson(finished.pageMetadataJson),
                previewWarningEvents: [],
                matchedCanvas,
                sourceDpi: plan.sourceDpi,
                renderDpi: plan.renderDpi,
                requestedRenderDpi: plan.renderDpi,
            }),
            base: null,
        };
    }
    const engineRequest: IScanCleanupWasmRenderPreviewRequest = {
        input: copy(raster.ppm),
        page: {
            options,
            sourcePageIndex: request.pageNumber - 1,
            canvasScope: 'page',
            ...documentPrior,
            ...(matchedCanvas === undefined ? {} : {documentCanvas: matchedCanvas}),
        },
        analysisPlane: canonical === raster
            ? {
                source: 'input',
                dpi: analysisDpi,
            }
            : {
                source: 'raster',
                raster: copy(canonical.ppm),
                dpi: analysisDpi,
            },
        planeEncoding: 'png',
    };
    const rendered = unwrap(await runBrowserScanCleanupWorkerRequest('render-preview', engineRequest, signal));
    const pageMetadata = decodeNativeScanCleanupPreviewPageMetadataJson(rendered.pageMetadataJson);
    const outputs: Extract<TScanCleanupPreviewWireResult, {pageMetadata: unknown}>['outputs'] = [];
    const nativeOutputs: TScanCleanupPreviewBaseOutputs = {};
    const metadataJsonByHalf: Partial<Record<string, string>> = {};
    const cleanedByHalf: Partial<Record<string, Uint8Array>> = {};
    for (const output of rendered.outputs) {
        const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(output.metadataJson);
        nativeOutputs[nativeMetadata.half] = nativeMetadata;
        metadataJsonByHalf[nativeMetadata.half] = output.metadataJson;
        cleanedByHalf[nativeMetadata.half] = output.plane.data;
        outputs.push({
            imageData: output.plane.data,
            metadata: projectScanCleanupPreviewOutputMetadata(nativeMetadata, []),
        });
    }
    const result = {
        pageNumber: request.pageNumber,
        totalPages,
        rawWidthPx: plan.raw.width,
        rawHeightPx: plan.raw.height,
        pageMetadata: projectScanCleanupPreviewPageMetadata(pageMetadata, outputs, request.options.autoDewarp === true),
        outputs,
    } satisfies TScanCleanupPreviewWireResult;
    return {
        result,
        base: plan.retainBase
            ? {
                pageSize,
                raw: plan.raw,
                source: raster,
                sourceDpiCandidate: plan.sourceDpiCandidate,
                sourceRasterDetected: plan.sourceDpiCandidate !== undefined,
                outputMode: outputs[0]?.metadata.outputMode,
                outputs: nativeOutputs,
                metadataJsonByHalf,
                cleanedByHalf,
                pageMetadata: result.pageMetadata,
                totalPages,
            }
            : null,
    };
}

async function renderDetail(
    input: IRenderBrowserScanCleanupPreviewInput,
    page: IPdfPage,
    pageSize: IPdfPageSize,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
    sourceDpiCandidate: number | undefined,
): Promise<IBrowserScanCleanupPreviewRendering> {
    const {
        request, base, signal,
    } = input;
    const detail = request.detail!;
    if (base === null || (detail.outputMode !== 'mixed' && base.outputMode !== detail.outputMode)) {
        throw new Error(
            'Scan cleanup detail geometry is unavailable; rebuild the base preview'
            + ` (base mode ${base?.outputMode ?? 'unknown'}, detail ${JSON.stringify(detail)})`,
        );
    }
    const detailRequest = request as IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>};
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const hasManualZones = (pageOverride.manualZones?.picture.length ?? 0) > 0
        || (pageOverride.manualZones?.fill.length ?? 0) > 0;
    if (detail.outputMode === 'mixed' || hasManualZones) {
        // Like desktop, a mixed page or one with manual zones refines by
        // cleaning the whole page again at the detail resolution.
        const sourceDpi = sourceDpiCandidate ?? DEFAULT_SOURCE_DPI;
        const {renderDpi} = resolveFallbackDetailDpi(detailRequest, base.raw, sourceDpi, sourceDpiCandidate !== undefined, documentCanvas);
        return renderBase(input, page, pageSize, {
            raw: base.raw,
            rendered: [base.source],
            renderDpi,
            sourceDpi,
            sourceDpiCandidate,
            documentCanvas,
            lossless: false,
            resolvedOutputMode: detail.outputMode,
            retainBase: false,
        });
    }
    const plan = planScanCleanupDetailPreview({
        request: detailRequest,
        baseRaw: base.raw,
        baseOutputs: base.outputs,
        baseRenderDpi: base.source.dpi,
        sourceDpiCandidate,
        sourceRasterDetected: base.sourceRasterDetected,
    });
    const emptyResult = {
        pageNumber: request.pageNumber,
        totalPages: base.totalPages,
        rawWidthPx: base.raw.width,
        rawHeightPx: base.raw.height,
        pageMetadata: base.pageMetadata,
        outputs: [],
    } satisfies TScanCleanupPreviewWireResult;
    if (plan.kind === 'base-suffices') {
        return {
            result: emptyResult,
            base: null,
        };
    }
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const options = resolveScanCleanupManifestPageOptions({
        options: effectiveOptions,
        qualityPath: 'raster',
        experimental: {autoDewarp: false},
        page: {
            pageNumber: request.pageNumber,
            dpi: plan.renderDpi,
            sourceDpi: plan.sourceDpi,
            requestedRenderDpi: plan.requestedRenderDpi,
            resolvedOutputMode: detail.outputMode,
        },
    });
    const outputs: Extract<TScanCleanupPreviewWireResult, {pageMetadata: unknown}>['outputs'] = [];
    for (const half of plan.halves) {
        const tile = await renderPageRaster(page, base.pageSize, plan.renderDpi, plan.maxSourcePixels, signal, half.sourceCrop);
        const baseMetadataJson = base.metadataJsonByHalf[half.half];
        const baseCleaned = base.cleanedByHalf[half.half];
        if (baseMetadataJson === undefined || baseCleaned === undefined) {
            throw new Error(`Scan cleanup detail has no canonical ${half.half} base raster`);
        }
        const rendered = unwrap(await runBrowserScanCleanupWorkerRequest('render-preview', {
            input: tile.ppm,
            page: {
                options,
                sourcePageIndex: request.pageNumber - 1,
                canvasScope: 'page',
            },
            detail: {
                geometry: {
                    sourceCrop: {
                        xPx: half.sourceCrop.x,
                        yPx: half.sourceCrop.y,
                        widthPx: tile.width,
                        heightPx: tile.height,
                    },
                    fullSourceWidthPx: plan.fullSourceWidthPx,
                    fullSourceHeightPx: plan.fullSourceHeightPx,
                    scale: plan.renderScale,
                    renderRegion: half.renderRegion,
                    sampledRegion: half.sampledRegion,
                },
                baseMetadataJson,
                baseSource: copy(base.source.ppm),
                baseCleaned: copy(baseCleaned),
            },
            planeEncoding: 'png',
        }, signal));
        const [output] = rendered.outputs;
        if (output === undefined || rendered.outputs.length !== 1) {
            throw new Error('Scan cleanup detail render produced no single output');
        }
        outputs.push({
            imageData: output.plane.data,
            metadata: projectScanCleanupDetailOutputMetadata(decodeNativeScanCleanupPreviewOutputMetadataJson(output.metadataJson)),
        });
    }
    return {
        result: {
            ...emptyResult,
            outputs,
        },
        base: null,
    };
}
