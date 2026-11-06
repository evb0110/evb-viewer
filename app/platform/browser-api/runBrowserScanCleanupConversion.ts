import type {
    INativeScanCleanupPageMetadataV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {
    IScanCleanupWasmPlane,
    IScanCleanupWasmRenderPageRequest,
    IScanCleanupWasmRenderPageResult,
    TScanCleanupWasmPlaneRole,
} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {BROWSER_SCAN_CLEANUP_WASM_PATH} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import type {
    OutputPlanes,
    PageOutput,
} from '@contracts/scan-cleanup/nativeWire.generated';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {isQpdfSuccessExitCode} from '@pdf-core/qpdfCommands';
import {
    resolveSourceDpi,
    type IPdfPageSize,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupOutputMapping,
} from '@evb/scan-cleanup/core/types';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/createArrayBackedPdfPageSizeStore';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
    createScanCleanupSummaryWarningReporter,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    assertScanCleanupInkAnchorCapacity,
    createPageGeometryRasterSource,
    describeScanCleanupFinalPage,
    planScanCleanupFinalPages,
    planScanCleanupRunQuality,
    readDetectionResultsForPageNumbers,
    buildBoundedDetectionRequestFields,
    withBoundedDetectionFields,
    type TScanCleanupDocumentCanvas,
} from '@evb/scan-cleanup/core/scanCleanupConversionPlan';
import {
    buildScanCleanupOutputMappings,
    collectScanCleanupPageOutputs,
    describeScanCleanupMixedLayerMismatch,
    planScanCleanupCombinePage,
    reportScanCleanupNativeWarnings,
    resolveCompactSourcePreservation,
    resolveScanCleanupMixedLayerExpectation,
    serializeScanCleanupCombinePage,
    type IScanCleanupRenderedOutput,
} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    composeScanCleanupStampBuildIds,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {toScanCleanupPageRasterSource} from '@evb/scan-cleanup/core/sourceRasterFacts';
import {
    buildScanCleanupTextLayerPlanFromPageSizeMap,
    reduceScanCleanupSourceTextOmission,
} from '@evb/scan-cleanup/core/sourceTextLayer';
import type {IScanCleanupTextLayerInstruction} from '@evb/scan-cleanup/core/compactManifest';
import {buildScanCleanupPageOpsInstructions} from '@evb/scan-cleanup/core/compactManifest';
import {
    assertScanCleanupCompactSourceBudget,
    resolveScanCleanupCompactSourceBudget,
} from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';
import {buildShapeOnlyNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    resolveScanCleanupPipelineMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    SCAN_CLEANUP_SIZE_PROBE_DPI,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {
    resolveScanCleanupAnalysisDpi,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
} from '@evb/scan-cleanup/core/pageBatches';
import {
    mapScanCleanupPageScope,
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {
    ScanCleanupContractError,
    ScanCleanupPdfValidationError,
} from '@evb/scan-cleanup/core/errors';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {runBrowserScanCleanupWorkerRequest} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import {runBrowserPdfCombineWorkerRequest} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {
    mergePdfPages,
    overlayPdfTextLayers,
    splitPdfPages,
} from '@app/platform/browser-api/browserPageOpsCore';
import {runBrowserQpdfCommand} from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    renderPageRaster,
    unwrapBrowserScanCleanupOutcome,
    type IBrowserScanCleanupSource,
    type IPageRaster,
} from '@app/platform/browser-api/browserScanCleanupJob';

const PDF_IMAGE_COMBINE_WASM_PATH = '/wasm/evb-pdf-image-combine.wasm';
const PDF_PAGE_OPS_WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';

type TPlaneName = string;
type TRenderedOutput = IScanCleanupRenderedOutput<TPlaneName>;
type TWarnEvent = (event: TScanCleanupWarningEvent, pageNumber?: number) => void;

export interface IRunBrowserScanCleanupConversionInput {
    request: IRunScanCleanupPipelineRequest;
    source: IBrowserScanCleanupSource;
    /** The source revision's bytes, read again where a writer needs the whole document. */
    readSource: () => Promise<Uint8Array>;
    signal: AbortSignal;
    onProgress: (progress: TScanCleanupProgress) => void;
}

export interface IBrowserScanCleanupConversionResult {
    pdf: Uint8Array;
    summary: TScanCleanupSummary;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The engines this run executes, identified by their bytes as desktop hashes its binaries. */
async function hashBrowserScanCleanupEngines(signal: AbortSignal) {
    const hash = async (path: string) => {
        const response = await fetch(path, {
            signal,
            cache: 'force-cache',
        });
        if (!response.ok) throw new Error(`Scan cleanup could not read ${path} to identify it`);
        return sha256Hex(new Uint8Array(await response.arrayBuffer()));
    };
    const [
        scanCleanup,
        pdfImageCombine,
        pdfPageOps,
    ] = await Promise.all([
        hash(BROWSER_SCAN_CLEANUP_WASM_PATH),
        hash(PDF_IMAGE_COMBINE_WASM_PATH),
        hash(PDF_PAGE_OPS_WASM_PATH),
    ]);
    return {
        scanCleanup,
        pdfImageCombine,
        pdfPageOps,
    };
}

function planeExtension(plane: IScanCleanupWasmPlane) {
    if (plane.encoding === 'raw') {
        throw new ScanCleanupContractError(`Scan cleanup returned an unencoded ${plane.role} plane`);
    }
    return plane.encoding;
}

/** The planes a manifest output declares, as the engine's render request names them. */
function declaredOutputPlanes(output: PageOutput): OutputPlanes {
    const background = output.backgroundOutputPath?.split('.').pop();
    return {
        ...(output.bilevelOutputPath == null ? {} : {bilevel: true}),
        ...(background === 'png' || background === 'ppm' || background === 'pgm' ? {background} : {}),
        ...(output.foregroundMaskOutputPath == null ? {} : {foregroundMask: true}),
        ...(output.foregroundAlphaOutputPath == null ? {} : {foregroundAlpha: true}),
        ...(output.pictureMaskOutputPath == null ? {} : {pictureMask: true}),
        ...(output.tonePreservationAlphaOutputPath == null ? {} : {tonePreservationAlpha: true}),
    };
}

/** The output slots one page declares; desktop's batch gives every page two. */
function declarePageOutputs(pageNumber: number) {
    return [
        0,
        1,
    ].map(outputIndex => ({
        outputPath: `/browser/clean-${pageNumber}-${outputIndex}.png`,
        metadataPath: `/browser/clean-${pageNumber}-${outputIndex}.json`,
        bilevelOutputPath: `/browser/clean-${pageNumber}-${outputIndex}.pbm`,
        backgroundOutputPath: `/browser/clean-${pageNumber}-${outputIndex}-background.ppm`,
        foregroundMaskOutputPath: `/browser/clean-${pageNumber}-${outputIndex}-mask.pbm`,
        foregroundAlphaOutputPath: `/browser/clean-${pageNumber}-${outputIndex}-alpha.pgm`,
    }));
}

/**
 * The browser's Scan Cleanup conversion, as desktop's coordinator runs it:
 * one quality decision for the document, then each page rendered by the same
 * cleanup engine at its planned resolution, composed by the same manifest
 * grammar, merged, overlaid with the source's text and navigation, stamped,
 * budgeted and checked. One source page is staged at a time.
 */
export async function runBrowserScanCleanupConversion({
    request: inputRequest,
    source,
    readSource,
    signal,
    onProgress,
}: IRunBrowserScanCleanupConversionInput): Promise<IBrowserScanCleanupConversionResult> {
    let losslessRun = inputRequest.options.preserveOriginalQuality === true;
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun);
    emitProgress('normalizing', 0, 1, []);
    const documentPageCount = source.pageSizes.length;
    const pageNumbers = resolveScanCleanupPageScopeLazy(
        inputRequest.sourcePageNumbers,
        documentPageCount,
        inputRequest.sourcePageRange,
    );
    const pageCount = pageNumbers.length;
    assertScanCleanupInkAnchorCapacity(pageCount, inputRequest.options, inputRequest.placementAnchorSummary);
    // A small document's decisions are materialized once from its store, as
    // a desktop run of one batch does.
    const request = inputRequest.detectionResultStore === undefined || documentPageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ? inputRequest
        : withBoundedDetectionFields(inputRequest, buildBoundedDetectionRequestFields(
            inputRequest,
            await readDetectionResultsForPageNumbers(
                inputRequest.detectionResultStore,
                Array.from({length: documentPageCount}, (_, index) => index + 1),
                signal,
            ),
            Array.from({length: documentPageCount}, (_, index) => index + 1),
        ));
    const summary = createEmptyScanCleanupSummary(pageCount, []);
    const warn = createScanCleanupSummaryWarningReporter(summary, () => undefined);
    const warnEvent: TWarnEvent = (event, pageNumber) => {
        reportScanCleanupSummaryWarningEvent(summary, {
            event,
            ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
        }, warn);
    };
    emitProgress('normalizing', 1, 1);
    const pageSizeStore = createArrayBackedPdfPageSizeStore(source.pageSizes);
    emitProgress('probing', 0, documentPageCount, []);
    // The inventory answers what desktop's pdfimages probe does; page geometry
    // stands in, as on desktop, where it found no raster at all.
    const structural = toScanCleanupPageRasterSource(source.rasterFacts, source.rasterFacts.complete);
    const rasterSource = structural.detected
        ? structural
        : await createPageGeometryRasterSource(pageSizeStore, documentPageCount, signal) ?? structural;
    emitProgress('probing', documentPageCount, documentPageCount);
    const quality = await planScanCleanupRunQuality({
        request,
        documentPageCount,
        pageSizeStore,
        rasterSource,
        rasterDetectionAvailable: true,
        signal,
        warn,
        warnEvent,
    });
    losslessRun = quality.losslessRun;
    const [
        sourceBytes,
        engines,
    ] = await Promise.all([
        readSource(),
        hashBrowserScanCleanupEngines(signal),
    ]);
    const sourceSha256 = await sha256Hex(new Uint8Array(sourceBytes));
    const context: IConversionContext = {
        request,
        source,
        signal,
        summary,
        warn,
        warnEvent,
        emitProgress,
        pageNumbers,
        pageCount,
        documentPageCount,
        documentCanvas: quality.documentCanvas,
        options: quality.options,
        sourceBytes,
        sourceSha256,
        engines,
    };
    const pdf = losslessRun
        ? await runLosslessConversion(context, rasterSource)
        : await runRasterConversion(context, rasterSource, pageSizeStore);
    emitProgress('handoff', 0, pageCount, []);
    signal.throwIfAborted();
    const check = await runBrowserQpdfCommand('check', new Uint8Array(pdf), {signal});
    if (!isQpdfSuccessExitCode(check.exitCode)) {
        throw new ScanCleanupPdfValidationError(
            `qpdf rejected the cleaned PDF (exit ${String(check.exitCode)}): ${check.stderr.trim()}`,
        );
    }
    emitProgress('handoff', pageCount, pageCount, pageNumbers);
    return {
        pdf,
        summary,
    };
}

interface IConversionContext {
    request: IRunScanCleanupPipelineRequest;
    source: IBrowserScanCleanupSource;
    signal: AbortSignal;
    summary: TScanCleanupSummary;
    warn: ReturnType<typeof createScanCleanupSummaryWarningReporter>;
    warnEvent: TWarnEvent;
    emitProgress: ReturnType<typeof createScanCleanupProgressReporter>;
    pageNumbers: TScanCleanupPageScope;
    pageCount: number;
    documentPageCount: number;
    documentCanvas: TScanCleanupDocumentCanvas | null;
    options: IRunScanCleanupPipelineRequest['options'];
    sourceBytes: Uint8Array;
    sourceSha256: string;
    engines: Awaited<ReturnType<typeof hashBrowserScanCleanupEngines>>;
}

async function rasterizePage(
    context: IConversionContext,
    pageSize: IPdfPageSize,
    pageNumber: number,
    dpi: number,
    maxPixels: number,
) {
    const page = await context.source.pdf.getPage(pageNumber);
    try {
        return await renderPageRaster(page, pageSize, dpi, maxPixels, context.signal);
    } finally {
        page.cleanup();
    }
}

/** The rolling output: each page's PDF merged onto the pages before it. */
function createRollingOutput() {
    let merged: Uint8Array | null = null;
    return {
        async append(pagePdf: Uint8Array) {
            merged = merged === null ? pagePdf : (await mergePdfPages([
                merged,
                pagePdf,
            ])).data;
        },
        get pdf() {
            return merged;
        },
    };
}

async function runRasterConversion(
    context: IConversionContext,
    rasterSource: Parameters<typeof planScanCleanupFinalPages>[0]['rasterSource'],
    pageSizeStore: ReturnType<typeof createArrayBackedPdfPageSizeStore>,
) {
    const {
        request, signal, summary, emitProgress, pageNumbers, pageCount, options, documentCanvas,
    } = context;
    const output = createRollingOutput();
    const outputPages: TRenderedOutput[] = [];
    const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
    const nativeOptionsBySource = new Map<number, NonNullable<ReturnType<typeof buildShapeOnlyNativeScanCleanupManifest>['pages'][number]['options']>>();
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const pageGeometryByNumber = new Map<number, IPdfPageSize>();
    const textPages: IScanCleanupTextLayerInstruction[] = [];
    const skippedNonAffine: number[] = [];
    const fittedMarginBoxPages = new Set<number>();
    const completedPageNumbers = new Set<number>();
    const detectedRasterByPage = new Map<number, NonNullable<Awaited<ReturnType<typeof rasterSource.getPageRaster>>>>();
    for (const batch of iterateScanCleanupPageBatches(pageCount)) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
        // A long document's decisions are read one batch at a time.
        const batchRequest = request.detectionResultStore === undefined
            ? request
            : withBoundedDetectionFields(request, buildBoundedDetectionRequestFields(
                request,
                await readDetectionResultsForPageNumbers(request.detectionResultStore, batchPageNumbers, signal),
                batchPageNumbers,
            ));
        const planned = await planScanCleanupFinalPages({
            request: batchRequest,
            documentCanvas,
            rasterSource,
            pageSizeStore,
            log: () => undefined,
            signal,
            warnEvent: context.warnEvent,
            probeGuardrail: async (pageNumber, page) => {
                const probe = await rasterizePage(context, page, pageNumber, SCAN_CLEANUP_SIZE_PROBE_DPI, SCAN_CLEANUP_RASTER_MAX_PIXELS);
                return {
                    dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
                    width: probe.width,
                    height: probe.height,
                };
            },
        }, batchPageNumbers);
        for (const [
            pageNumber,
            raster,
        ] of planned.detectedRasterByPage) detectedRasterByPage.set(pageNumber, raster);
        const manifest = buildShapeOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            ...(documentCanvas === null ? {} : {documentCanvas}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined ? {} : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: planned.rasterPlans.map(plan => ({
                inputPath: `/browser/source-${plan.pageNumber}.ppm`,
                analysisInputPath: `/browser/source-${plan.pageNumber}-analysis.ppm`,
                ...describeScanCleanupFinalPage(batchRequest, plan, {
                    analysisDpi: planned.analysisDpiByPage.get(plan.pageNumber)!,
                    detectedRaster: planned.detectedRasterByPage.get(plan.pageNumber),
                    pageGeometry: planned.pageGeometryByNumber.get(plan.pageNumber),
                    resolvedPagePlan: planned.resolvedPagePlanByNumber.get(plan.pageNumber),
                }),
                pageMetadataPath: `/browser/clean-${plan.pageNumber}-page.json`,
                outputs: declarePageOutputs(plan.pageNumber),
            })),
        });
        for (const [
            index,
            manifestPage,
        ] of manifest.pages.entries()) {
            signal.throwIfAborted();
            const plan = planned.rasterPlans[index]!;
            const pageNumber = plan.pageNumber;
            const pageGeometry = planned.pageGeometryByNumber.get(pageNumber)!;
            pageGeometryByNumber.set(pageNumber, pageGeometry);
            nativeOptionsBySource.set(pageNumber, manifestPage.options);
            const maxPixels = resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode, undefined);
            emitProgress('rasterizing', completedPageNumbers.size, pageCount, completedPageNumbers);
            const raster = await rasterizePage(context, pageGeometry, pageNumber, plan.dpi, maxPixels);
            const analysisDpi = planned.analysisDpiByPage.get(pageNumber)!;
            const analysisMaxPixels = Math.min(maxPixels, SCAN_CLEANUP_RASTER_MAX_PIXELS);
            // At the same resolution the canonical analysis raster is this
            // render; desktop links the file instead of rendering it again.
            const analysisPlane: IScanCleanupWasmRenderPageRequest['analysisPlane'] = analysisDpi === plan.dpi
                && raster.width <= SCAN_CLEANUP_MAX_DIMENSION_PX
                && raster.height <= SCAN_CLEANUP_MAX_DIMENSION_PX
                && raster.width * raster.height <= analysisMaxPixels
                ? {
                    source: 'input',
                    dpi: analysisDpi,
                }
                : {
                    source: 'raster',
                    raster: (await rasterizePage(context, pageGeometry, pageNumber, analysisDpi, analysisMaxPixels)).ppm,
                    dpi: analysisDpi,
                };
            emitProgress('rendering', completedPageNumbers.size, pageCount, completedPageNumbers);
            const rendered = unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest('render-page', {
                input: raster.ppm,
                page: {
                    options: manifestPage.options,
                    sourcePageIndex: manifestPage.sourcePageIndex,
                    canvasScope: 'document',
                    renderMode: 'final',
                    ...(manifestPage.documentPrior == null ? {} : {documentPrior: manifestPage.documentPrior}),
                    ...(manifest.documentCanvas === undefined ? {} : {documentCanvas: manifest.documentCanvas}),
                    ...(manifestPage.pdfPage == null ? {} : {pdfPage: manifestPage.pdfPage}),
                    outputs: manifestPage.outputs.map(declaredOutputPlanes),
                },
                analysisPlane,
                planes: 'encoded',
            }, signal));
            const pageMetadata = decodeNativeScanCleanupPageMetadataJson(rendered.pageMetadataJson);
            pageMetadataBySource.set(pageNumber, pageMetadata);
            emitProgress('collecting', completedPageNumbers.size, pageCount, completedPageNumbers);
            const collected = collectRenderedPage(context, {
                pageNumber,
                plan,
                pageMetadata,
                rendered,
                declaredOutputCount: manifestPage.outputs.length,
                detectedRaster: planned.detectedRasterByPage.get(pageNumber),
                pageGeometry,
                resolvePageOutputMode: planned.resolvePageOutputMode,
                fittedMarginBoxPages,
                emptyOutputMappings,
            });
            if (collected.pageOutputs.length > 0) {
                const textPlan = buildScanCleanupTextLayerPlanFromPageSizeMap(
                    collected.pageOutputs,
                    new Map([[
                        pageNumber,
                        pageGeometry,
                    ]]),
                );
                textPages.push(...textPlan.pages.map(page => ({
                    ...page,
                    outputPageIndex: page.outputPageIndex + outputPages.length,
                })));
                skippedNonAffine.push(...textPlan.skippedNonAffine);
                emitProgress('assembling', outputPages.length, outputPages.length + collected.pageOutputs.length);
                const combined = await runBrowserPdfCombineWorkerRequest('combinePdfs', {
                    inputs: [...collected.planes].map(([
                        fileName,
                        data,
                    ]) => ({
                        fileName,
                        data,
                    })),
                    wasmImagePreprocessing: {compactManifestLines: collected.pageOutputs.map(pageOutput => serializeScanCleanupCombinePage(
                        planScanCleanupCombinePage(pageOutput, undefined),
                    ))},
                }, signal);
                await output.append(combined.data);
                outputPages.push(...collected.pageOutputs);
            }
            completedPageNumbers.add(pageNumber);
            emitProgress('rendering', completedPageNumbers.size, pageCount, completedPageNumbers);
        }
    }
    if (fittedMarginBoxPages.size > 0) {
        context.warnEvent({
            code: 'matched-canvas-content-fitted-pages',
            pages: [...fittedMarginBoxPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    summary.outputPages = outputPages.length;
    const assembled = output.pdf;
    if (assembled === null || outputPages.length === 0) {
        throw new ScanCleanupContractError('evb-scan-cleanup produced no output pages');
    }
    // Non-affine pixels cannot carry positioned annotations without data loss.
    const refusedAnnotatedPage = skippedNonAffine.find(pageNumber => context.source.annotatedPages.has(pageNumber));
    if (refusedAnnotatedPage !== undefined) {
        throw new ScanCleanupContractError(
            `Cannot preserve annotations on source page ${String(refusedAnnotatedPage)} `
            + 'without affine cleanup geometry. Disable dewarping or preserve original quality.',
        );
    }
    const outputMappings = buildScanCleanupOutputMappings(outputPages, emptyOutputMappings);
    const effectiveOptions = mapScanCleanupPageScope(pageNumbers, sourcePage => {
        const nativeOptions = nativeOptionsBySource.get(sourcePage);
        if (nativeOptions === undefined) {
            throw new ScanCleanupContractError(`Scan cleanup lost manifest page ${String(sourcePage)} during batching`);
        }
        return {
            sourcePage,
            options: materializeScanCleanupStampOptions({
                nativeOptions,
                options,
                qualityPath: 'raster',
            }),
        };
    });
    const stampHex = encodeScanCleanupProvenanceStampHex(buildScanCleanupProvenanceStamp({
        sourceSha256: context.sourceSha256,
        effectiveOptions,
        outputMappings,
        pagePlanDigests: effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
            record.sourcePage,
            record.options,
            pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
        )),
        buildIds: composeScanCleanupStampBuildIds({
            nativeBinarySha256s: context.engines,
            assemblerBackend: 'browser-wasm-pdf-image-combine',
            transportMode: 'browser-wasm-encoded',
        }),
    }));
    // One overlay over the merged output: a link may name another page's target.
    const overlaid = await overlayPdfTextLayers(assembled, new Uint8Array(context.sourceBytes), {
        pages: textPages,
        provenanceStampHex: stampHex,
    }, {signal});
    summary.accessibilityTagsRemoved = overlaid.report.accessibilityTagsRemoved;
    summary.sourceTextOmission = await inspectOmittedSourceText(context, skippedNonAffine);
    const budget = resolveScanCleanupCompactSourceBudget({
        documentPageCount: context.documentPageCount,
        options: request.options,
        rasterByPage: detectedRasterByPage,
        partialRun: request.sourcePageNumbers !== undefined || request.sourcePageRange !== undefined,
        sourceBytes: context.sourceBytes.byteLength,
    });
    assertScanCleanupCompactSourceBudget(overlaid.data.byteLength, budget);
    return overlaid.data;
}

interface ICollectRenderedPageInput {
    pageNumber: number;
    plan: Awaited<ReturnType<typeof planScanCleanupFinalPages>>['rasterPlans'][number];
    pageMetadata: INativeScanCleanupPageMetadataV3;
    rendered: IScanCleanupWasmRenderPageResult;
    declaredOutputCount: number;
    detectedRaster: Parameters<typeof resolveCompactSourcePreservation>[5];
    pageGeometry: IPdfPageSize;
    resolvePageOutputMode: (pageNumber: number) => TRenderedOutput['resolvedOutputMode'];
    fittedMarginBoxPages: Set<number>;
    emptyOutputMappings: IScanCleanupOutputMapping[];
}

/**
 * One rendered page's outputs, checked and ordered as desktop collects its
 * manifest files, with each plane named for the page's composition request.
 */
function collectRenderedPage(context: IConversionContext, input: ICollectRenderedPageInput) {
    const {
        summary, request,
    } = context;
    const {
        pageNumber, pageMetadata, rendered,
    } = input;
    const planes = new Map<TPlaneName, Uint8Array>();
    if (pageMetadata.excluded) {
        summary.excludedPages += 1;
        input.emptyOutputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: pageMetadata.rotationDegrees,
            excluded: true,
            blank: false,
        });
        return {
            pageOutputs: [] as TRenderedOutput[],
            planes,
        };
    }
    summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
    if (rendered.outputs.length !== pageMetadata.outputCount) {
        throw new ScanCleanupContractError(
            `Scan cleanup page ${String(pageNumber)} published ${String(rendered.outputs.length)} of its ${String(pageMetadata.outputCount)} outputs`,
        );
    }
    // Declared slots past the page's output count are the halves it left blank.
    const intentionallyBlankOutputCount = pageMetadata.blankOutputsSkipped > 0
        ? Math.max(0, input.declaredOutputCount - pageMetadata.outputCount)
        : 0;
    const pageOutputs: TRenderedOutput[] = [];
    for (const [
        outputIndex,
        output,
    ] of rendered.outputs.entries()) {
        const metadata = decodeNativeScanCleanupOutputMetadataJson(output.metadataJson);
        const name = (plane: IScanCleanupWasmPlane) => `p${String(pageNumber)}-${String(outputIndex)}-${plane.role}.${planeExtension(plane)}`;
        const plane = (role: TScanCleanupWasmPlaneRole, description: string) => {
            const found = output.planes.find(candidate => candidate.role === role);
            if (found === undefined) {
                throw new ScanCleanupContractError(`Scan cleanup page ${String(pageNumber)} published no ${description}`);
            }
            planes.set(name(found), found.data);
            return found;
        };
        const composite = plane('composite', 'composite output');
        let layers: Pick<TRenderedOutput, 'bilevelPath' | 'backgroundPath' | 'foregroundMaskPath' | 'foregroundAlphaPath' | 'backgroundIsColor'> = {};
        if (metadata.layeredWritten) {
            const background = plane('background', 'mixed background layer');
            const foreground = metadata.layeredForegroundKind === 'soft-alpha'
                ? plane('foreground-alpha', 'mixed soft foreground alpha')
                : plane('foreground-mask', 'mixed foreground mask');
            const mismatch = describeScanCleanupMixedLayerMismatch(
                resolveScanCleanupMixedLayerExpectation(metadata, metadata.renderDpi ?? input.plan.dpi, pageNumber),
                background,
                foreground,
            );
            if (mismatch === null) {
                layers = {
                    backgroundPath: name(background),
                    ...(foreground.role === 'foreground-alpha'
                        ? {foregroundAlphaPath: name(foreground)}
                        : {foregroundMaskPath: name(foreground)}),
                    backgroundIsColor: background.kind === 'rgb8',
                };
            } else {
                summary.warnings.push(`Page ${String(pageNumber)} mixed layer dimensions do not match metadata ${mismatch}; using the non-MRC composite path`);
            }
        } else if (metadata.bilevelWritten) {
            layers = {bilevelPath: name(plane('bilevel', 'bilevel output'))};
        }
        const renderedOutput: TRenderedOutput = {
            sourcePageNumber: pageNumber,
            path: name(composite),
            ...layers,
            dpi: metadata.renderDpi ?? input.plan.dpi,
            // The engine reports the mode it rendered with once Auto resolves.
            resolvedOutputMode: (metadata.outputMode === 'auto' ? undefined : metadata.outputMode)
                ?? input.resolvePageOutputMode(pageNumber)
                ?? 'color',
            metadata,
        };
        if (resolveCompactSourcePreservation(request, pageNumber, pageMetadata, renderedOutput, input.pageGeometry, input.detectedRaster) !== undefined) {
            throw new ScanCleanupContractError(
                `Page ${String(pageNumber)} keeps its compact source page in Auto, which the browser cannot assemble yet. `
                + 'Choose Color, Gray, B&W or Keep original images, or clean it in the desktop app.',
            );
        }
        pageOutputs.push(renderedOutput);
        if (!metadata.skewApplied) summary.deskewSkipped += 1;
        if (request.options.crop && metadata.contentBox == null) summary.cropSkipped += 1;
        reportScanCleanupNativeWarnings(summary, metadata, pageNumber, input.fittedMarginBoxPages, context.warn);
    }
    collectScanCleanupPageOutputs({
        request,
        sourcePageNumber: pageNumber,
        pageMetadata,
        pageOutputPages: pageOutputs,
        intentionallyBlankOutputCount,
        emptyOutputMappings: input.emptyOutputMappings,
    });
    if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
    if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
    return {
        pageOutputs,
        planes,
    };
}

async function inspectOmittedSourceText(context: IConversionContext, skippedNonAffine: readonly number[]) {
    if (skippedNonAffine.length === 0) return undefined;
    const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
        data: new Uint8Array(context.sourceBytes),
        pages: [...skippedNonAffine],
        withEvbOcrText: true,
    }, {signal: context.signal});
    return isBrowserPageOpsWasmFailure(report) ? undefined : reduceScanCleanupSourceTextOmission(report);
}

/**
 * Keep original images: every page analyzed, reconciled and placed as a
 * desktop lossless manifest does, then one split of the source itself.
 */
async function runLosslessConversion(
    context: IConversionContext,
    rasterSource: Parameters<typeof planScanCleanupFinalPages>[0]['rasterSource'],
) {
    const {
        request, signal, summary, emitProgress, pageNumbers, pageCount, documentCanvas,
    } = context;
    const documentDpi = resolveSourceDpi(rasterSource.documentDpi);
    const pagePlanResolver = createPagePlanResolver(request, () => undefined, 'lossless');
    const analyzedPages: Array<{
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        outputs: Array<{
            half: 'full' | 'left' | 'right';
            placement: NonNullable<NonNullable<INativeScanCleanupPageMetadataV3['outputs']>[number]['pdfPlacement']>;
        }>;
    }> = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const nativeOptionsBySource = new Map<number, ReturnType<typeof buildShapeOnlyNativeScanCleanupManifest>['pages'][number]['options']>();
    const completed = new Set<number>();
    for (const batch of iterateScanCleanupPageBatches(pageCount)) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageNumbers, batch);
        const batchRequest = request.detectionResultStore === undefined
            ? request
            : withBoundedDetectionFields(request, buildBoundedDetectionRequestFields(
                request,
                await readDetectionResultsForPageNumbers(request.detectionResultStore, batchPageNumbers, signal),
                batchPageNumbers,
            ));
        const facts = await Promise.all(batchPageNumbers.map(async pageNumber => {
            const view = context.source.pageSizes[pageNumber - 1]!;
            const detected = await rasterSource.getPageRaster(pageNumber);
            return {
                pageNumber,
                view,
                sourceDpi: resolveSourceDpi(detected?.dpi, documentDpi),
                analysisDpi: resolveScanCleanupAnalysisDpi(view),
            };
        }));
        // The pages a desktop lossless analyze manifest lists, so each page's
        // engine options are resolved exactly as desktop resolves them.
        const manifest = buildShapeOnlyNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'lossless',
            options: request.options,
            ...(documentCanvas === null ? {} : {documentCanvas}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined ? {} : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: facts.map(page => ({
                inputPath: `/browser/analysis-${String(page.pageNumber)}.ppm`,
                analysisInputPath: `/browser/analysis-${String(page.pageNumber)}.ppm`,
                analysisDpi: page.analysisDpi,
                pageNumber: page.pageNumber,
                dpi: page.analysisDpi,
                ...(batchRequest.layoutByPage?.[String(page.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: batchRequest.layoutByPage[String(page.pageNumber)]!}),
                ...pagePlanResolver.resolve(page.pageNumber),
                pdfPage: {
                    xPoints: page.view.xPoints,
                    yPoints: page.view.yPoints,
                    widthPoints: page.view.widthPoints,
                    heightPoints: page.view.heightPoints,
                    rotation: page.view.rotation,
                    sourceDpi: page.sourceDpi,
                },
                pageMetadataPath: `/browser/analysis-${String(page.pageNumber)}.json`,
            })),
        });
        const pages = facts.map((page, index) => {
            const options = manifest.pages[index]!.options;
            nativeOptionsBySource.set(page.pageNumber, options);
            return {
                ...page,
                options,
            };
        });
        const analyze = async (page: typeof pages[number], documentPrior?: unknown) => {
            const raster: IPageRaster = await rasterizePage(context, page.view, page.pageNumber, page.analysisDpi, SCAN_CLEANUP_RASTER_MAX_PIXELS);
            return unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest('analyze-page', {
                input: raster.ppm,
                page: {
                    options: page.options,
                    sourcePageIndex: page.pageNumber - 1,
                    canvasScope: 'document',
                    ...(documentPrior === undefined ? {} : {documentPrior: documentPrior as never}),
                },
            }, signal));
        };
        const firstPass = [];
        for (const page of pages) {
            emitProgress('rasterizing', completed.size, pageCount, completed);
            firstPass.push(await analyze(page));
        }
        const {pages: decisions} = unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest(
            'reconcile-document',
            {candidates: firstPass.map(entry => entry.reconciliation)},
            signal,
        ));
        for (const [
            index,
            page,
        ] of pages.entries()) {
            signal.throwIfAborted();
            const decision = decisions[index] ?? null;
            const analysisJson = decision?.kind === 'rerun'
                ? (await analyze(page, decision.prior)).pageMetadataJson
                : firstPass[index]!.pageMetadataJson;
            const finished = unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest('finish-page-analysis', {
                pageMetadataJson: analysisJson,
                ...(decision === null ? {} : {reconciliation: decision}),
                pdfPlacement: {
                    pdfPage: {
                        xPoints: page.view.xPoints,
                        yPoints: page.view.yPoints,
                        widthPoints: page.view.widthPoints,
                        heightPoints: page.view.heightPoints,
                        rotation: page.view.rotation,
                        sourceDpi: page.sourceDpi,
                    },
                    options: page.options,
                    renderMode: 'final',
                    ...(documentCanvas === null ? {} : {documentCanvas}),
                },
            }, signal));
            const metadata = finished.pageMetadata;
            // Placement is planned from the canvas, not observed on the page,
            // so the provenance evidence stays the analysis alone.
            pageMetadataBySource.set(page.pageNumber, metadata.outputs === undefined ? metadata : {
                ...metadata,
                outputs: metadata.outputs.map(({
                    pdfPlacement: _pdfPlacement, ...rest
                }) => rest),
            });
            completed.add(page.pageNumber);
            emitProgress('collecting', completed.size, pageCount, completed);
            if (metadata.excluded) {
                summary.excludedPages += 1;
                continue;
            }
            if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
            if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
            const outputs = (metadata.outputs ?? []).map(output => {
                if (output.pdfPlacement === undefined) {
                    throw new ScanCleanupContractError(`evb-scan-cleanup returned no placement for page ${String(page.pageNumber)}`);
                }
                return {
                    half: output.half,
                    placement: output.pdfPlacement,
                };
            });
            if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') outputs.reverse();
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                requirePageNumber(page.pageNumber),
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
            );
            analyzedPages.push({
                sourcePageIndex: page.pageNumber - 1,
                rotationQuarterTurns: pageOverride.rotationDegrees / 90,
                outputs,
            });
        }
    }
    pagePlanResolver.report();
    // A lossless page placed at another scale keeps its own pixels; the run
    // names those pages, and every page the canvas had to fit.
    const scaledRasterPages = new Set<number>();
    for (const page of analyzedPages) {
        const sourceRasterDetected = await rasterSource.getPageRaster(page.sourcePageIndex + 1) !== undefined;
        for (const {
            half, placement,
        } of page.outputs) {
            for (const event of placement.warningEvents ?? []) {
                reportScanCleanupSummaryWarningEvent(summary, {
                    event,
                    pageNumber: requirePageNumber(page.sourcePageIndex + 1),
                    half,
                }, context.warn);
            }
            if (placement.contentScaled && sourceRasterDetected) scaledRasterPages.add(page.sourcePageIndex + 1);
        }
    }
    if (scaledRasterPages.size > 0) {
        context.warnEvent({
            code: 'matched-canvas-pages-scaled-in-place',
            pages: [...scaledRasterPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    const allOutputs = analyzedPages.flatMap(page => page.outputs.map(output => ({
        ...output,
        sourcePageIndex: page.sourcePageIndex,
    })));
    if (allOutputs.length === 0) throw new ScanCleanupContractError('evb-scan-cleanup analysis produced no output pages');
    summary.outputPages = allOutputs.length;
    const outputMappings: IScanCleanupOutputMapping[] = allOutputs.map((output, outputIndex) => ({
        sourcePage: output.sourcePageIndex + 1,
        half: output.half,
        outputOrdinal: outputIndex + 1,
        rotationDegrees: pageMetadataBySource.get(output.sourcePageIndex + 1)?.rotationDegrees ?? 0,
        excluded: false,
        blank: false,
    }));
    for (const pageNumber of pageNumbers) {
        if (outputMappings.some(mapping => mapping.sourcePage === pageNumber)) continue;
        const metadata = pageMetadataBySource.get(pageNumber);
        outputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: metadata?.rotationDegrees ?? 0,
            excluded: metadata?.excluded === true,
            blank: metadata?.excluded !== true,
        });
    }
    const effectiveOptions = mapScanCleanupPageScope(pageNumbers, sourcePage => ({
        sourcePage,
        options: materializeScanCleanupStampOptions({
            nativeOptions: nativeOptionsBySource.get(sourcePage)!,
            options: request.options,
            qualityPath: 'lossless',
        }),
    }));
    const stampHex = encodeScanCleanupProvenanceStampHex(buildScanCleanupProvenanceStamp({
        sourceSha256: context.sourceSha256,
        effectiveOptions,
        outputMappings,
        pagePlanDigests: effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
            record.sourcePage,
            record.options,
            pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
        )),
        buildIds: composeScanCleanupStampBuildIds({
            nativeBinarySha256s: context.engines,
            assemblerBackend: 'browser-wasm-pdf-page-ops',
            transportMode: 'source-preserved',
        }),
    }));
    emitProgress('assembling', 0, allOutputs.length, []);
    const instructions = buildScanCleanupPageOpsInstructions(analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(({placement}) => ({
            cropRect: placement.cropRect,
            ...(placement.contentTransform ? {contentTransform: placement.contentTransform} : {}),
        })),
    })), stampHex);
    const split = await splitPdfPages(new Uint8Array(context.sourceBytes), instructions, {signal});
    summary.accessibilityTagsRemoved = split.report.accessibilityTagsRemoved;
    emitProgress('assembling', allOutputs.length, allOutputs.length);
    const budget = resolveScanCleanupCompactSourceBudget({
        documentPageCount: pageCount,
        options: request.options,
        ...(rasterSource.compactLayeredPageCountComplete === false
            ? {}
            : {compactLayeredPageCount: rasterSource.compactLayeredPageCount ?? 0}),
        partialRun: request.sourcePageNumbers !== undefined || request.sourcePageRange !== undefined,
        sourceBytes: context.sourceBytes.byteLength,
    });
    assertScanCleanupCompactSourceBudget(split.data.byteLength, budget);
    return split.data;
}
