import type {
    INativeScanCleanupPageMetadataV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IScanCleanupWasmPlane,
    IScanCleanupWasmRenderPageRequest,
    IScanCleanupWasmRenderPageResult,
    TScanCleanupWasmPlaneRole,
} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import type {
    OutputPlanes,
    PageOutput,
} from '@contracts/scan-cleanup/nativeWire.generated';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {isQpdfSuccessExitCode} from '@pdf-core/qpdfCommands';
import {
    resolveSourceDpi,
    type IPdfPageSize,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupOutputMapping,
} from '@evb/scan-cleanup/core/types';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/createArrayBackedPdfPageSizeStore';
import {
    createScanCleanupActivePageTracker,
    type TEmitScanCleanupProgress,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    buildScanCleanupConversionProvenanceStamp,
    commitScanCleanupRenderedPageSummary,
    coordinateScanCleanupConversion,
    finalizeScanCleanupLosslessOutputs,
    reduceScanCleanupLosslessPage,
    type IScanCleanupAnalyzedLosslessPage,
    type TScanCleanupWarnEvent,
} from '@evb/scan-cleanup/core/coordinateScanCleanupConversion';
import {
    createPageGeometryRasterSource,
    describeScanCleanupFinalPage,
    planScanCleanupFinalPages,
    resolveScanCleanupSourceMrcCandidacy,
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
    resolveCompactSourcePreservation,
    resolveScanCleanupMixedLayerExpectation,
    serializeScanCleanupCombinePage,
    type IScanCleanupRenderedOutput,
} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
import {composeScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/provenanceStamp';
import {
    reduceScanCleanupRasterRows,
    toScanCleanupPageRasterSource,
} from '@evb/scan-cleanup/core/sourceRasterFacts';
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
import {buildShapeOnlyNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/assembleNativeScanCleanupManifest';
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
import type {TScanCleanupPageScope} from '@evb/scan-cleanup/core/pageScope';
import {
    ScanCleanupContractError,
    ScanCleanupPdfValidationError,
    ScanCleanupStreamingEvidenceError,
} from '@evb/scan-cleanup/core/errors';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {runBoundedRasterProducerConsumer} from '@evb/scan-cleanup/core/streamingRasterHandoff';
import {
    estimateBrowserScanCleanupEngineBytes,
    resetDrainingBrowserScanCleanupWorkers,
    runBrowserScanCleanupWorkerRequest,
} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import {resolveBrowserPageLanes} from '@app/platform/browser-api/browserWorkerClient';
import {runBrowserPdfCombineWorkerRequest} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {
    createOrderedPdfMerge,
    overlayPdfTextLayers,
    splitPdfPages,
} from '@app/platform/browser-api/browserPageOpsCore';
import {runBrowserQpdfCommand} from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    pageRasterPixels,
    renderPageRaster,
    runBrowserScanCleanupAnalysis,
    unwrapBrowserScanCleanupOutcome,
    type IBrowserScanCleanupSource,
} from '@app/platform/browser-api/browserScanCleanupJob';

type TPlaneName = string;
type TRenderedOutput = IScanCleanupRenderedOutput<TPlaneName>;

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

type TEngineRole = 'scanCleanup' | 'pdfImageCombine' | 'pdfPageOps';

/** An engine module changed during a run; its source must be inspected again before a retry. */
export class BrowserScanCleanupEngineChangedError extends ScanCleanupContractError {
    public constructor(role: string) {
        super(`The browser ${role} engine changed during the run; run it again`);
        this.name = 'BrowserScanCleanupEngineChangedError';
    }
}

/**
 * The engine modules this run executed, identified by the bytes each worker
 * compiled, as desktop hashes the binaries it ran. A module that changes
 * mid-run, or a run step that names no module, cannot be stamped.
 */
function createEngineIdentities() {
    const identities: Partial<Record<TEngineRole, string>> = {};
    let conflict: string | null = null;
    const observe = (role: TEngineRole) => (sha256: string) => {
        const known = identities[role];
        if (known !== undefined && known !== sha256) {conflict = role;}
        identities[role] = sha256;
    };
    const throwIfChanged = () => {
        if (conflict !== null) {throw new BrowserScanCleanupEngineChangedError(conflict);}
    };
    return {
        observe,
        /** Ends the run as soon as a module changed, rather than after its last page. */
        throwIfChanged,
        settled(roles: readonly TEngineRole[]) {
            throwIfChanged();
            const missing = roles.find(role => identities[role] === undefined);
            if (missing !== undefined) {
                throw new ScanCleanupContractError(`The browser ${missing} engine did not identify its module`);
            }
            return Object.fromEntries(roles.map(role => [
                role,
                identities[role]!,
            ]));
        },
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

interface IBrowserConversionContext {
    request: IRunScanCleanupPipelineRequest;
    source: IBrowserScanCleanupSource;
    signal: AbortSignal;
    summary: TScanCleanupSummary;
    warn: (message: string, level?: 'warn' | 'error') => void;
    warnEvent: TScanCleanupWarnEvent;
    emitProgress: TEmitScanCleanupProgress;
    pageNumbers: TScanCleanupPageScope;
    pageCount: number;
    documentPageCount: number;
    documentCanvas: TScanCleanupDocumentCanvas | null;
    options: IRunScanCleanupPipelineRequest['options'];
    sourceBytes: Uint8Array;
    sourceSha256: string;
    engines: ReturnType<typeof createEngineIdentities>;
}

/**
 * Thin browser WASM adapter over the unified host-agnostic scan-cleanup
 * conversion coordinator. Preserves bounded raster caching, warm worker pools,
 * parallel render + combine lanes, and OPFS source reads.
 */
export async function runBrowserScanCleanupConversion({
    request: inputRequest,
    source,
    readSource,
    signal,
    onProgress,
}: IRunBrowserScanCleanupConversionInput): Promise<IBrowserScanCleanupConversionResult> {
    // Reclaim any retiring warm-canceled preview worker immediately so a 1-page
    // conversion sharing its threaded worker key never waits for its drain timer.
    resetDrainingBrowserScanCleanupWorkers();
    const geometryRecords: IPdfPageSize[] = [];
    return coordinateScanCleanupConversion<
        IBrowserScanCleanupConversionResult,
        Uint8Array,
        ReturnType<typeof createArrayBackedPdfPageSizeStore>
    >({
        request: inputRequest,
        signal,
        onProgress,
        host: {
            prepareSource() {
                return Promise.resolve({
                    documentPageCount: source.pageSizes.length,
                    preparedWarnings: [],
                    prepared: undefined,
                });
            },
            async openGeometryAndProbe({
                request,
                documentPageCount,
                pageNumbers,
                pageCount,
                largeStreamingRun,
                fullDocumentRun,
                emitProgress,
                signal: opSignal,
            }) {
                const metadataPages: IPdfPageSize[] = [];
                for (let pageNumber = 1; !largeStreamingRun && pageNumber <= documentPageCount; pageNumber += 1) {
                    const page = request.sourcePageMetadataByPage?.[String(pageNumber)];
                    if (page?.pageNumber !== pageNumber) {break;}
                    metadataPages.push(page);
                }
                const pageSizeStore = createArrayBackedPdfPageSizeStore(
                    metadataPages.length === documentPageCount ? metadataPages : source.pageSizes,
                );
                emitProgress('probing', 0, documentPageCount, []);
                const probesWholeDocument = request.options.matchPageSize
                    || fullDocumentRun
                    || pageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES;
                const probedPages = probesWholeDocument ? null : new Set(pageNumbers);
                const inScope = (pageNumber: number) => probedPages === null || probedPages.has(pageNumber);
                const structural = toScanCleanupPageRasterSource(
                    reduceScanCleanupRasterRows(source.rasterRows.filter(row => inScope(row.pageNumber))),
                    ![...source.incompleteRasterPages].some(inScope),
                );
                const geometry = structural.detected
                    ? null
                    : await createPageGeometryRasterSource(pageSizeStore, documentPageCount, opSignal);
                const rasterSource = geometry === null
                    ? structural
                    : {
                        ...geometry,
                        compactLayeredPageCountComplete: structural.compactLayeredPageCountComplete !== false,
                    };
                emitProgress('probing', documentPageCount, documentPageCount);
                if (fullDocumentRun && request.options.outputMode === 'auto' && rasterSource.compactLayeredPageCountComplete === false) {
                    throw new ScanCleanupStreamingEvidenceError(
                        'browser-raster-inventory',
                        'Automatic scan cleanup could not establish a bounded compact-source budget for the full document; '
                        + 'source raster probing was incomplete, so publication was refused',
                    );
                }
                return {
                    pageSizeStore,
                    rasterSource,
                    rasterDetectionAvailable: true,
                    ...(largeStreamingRun
                        ? {
                            onGeometryPage: page => {
                                geometryRecords.push(page);
                            },
                        }
                        : {}),
                };
            },
            async executeConversion(coordinated) {
                const finalPageSizeStore = coordinated.largeStreamingRun
                    ? createArrayBackedPdfPageSizeStore(geometryRecords)
                    : coordinated.pageSizeStore;
                const engines = createEngineIdentities();
                if (source.pageOpsEngineSha256 !== null) {engines.observe('pdfPageOps')(source.pageOpsEngineSha256);}
                const sourceBytes = await readSource();
                const sourceSha256 = await sha256Hex(new Uint8Array(sourceBytes));
                const browserContext: IBrowserConversionContext = {
                    request: coordinated.request,
                    source,
                    signal: coordinated.signal,
                    summary: coordinated.summary,
                    warn: coordinated.warn,
                    warnEvent: coordinated.warnEvent,
                    emitProgress: coordinated.emitProgress,
                    pageNumbers: coordinated.pageNumbers,
                    pageCount: coordinated.pageCount,
                    documentPageCount: coordinated.documentPageCount,
                    documentCanvas: coordinated.qualityPlan.documentCanvas,
                    options: coordinated.qualityPlan.options,
                    sourceBytes,
                    sourceSha256,
                    engines,
                };
                return coordinated.qualityPlan.losslessRun
                    ? runLosslessConversion(browserContext, coordinated.rasterSource, finalPageSizeStore)
                    : runRasterConversion(browserContext, coordinated.rasterSource, finalPageSizeStore);
            },
            async validateAndPublish(coordinated, pdf) {
                const {
                    pageNumbers,
                    pageCount,
                    summary,
                    emitProgress,
                    signal: opSignal,
                } = coordinated;
                emitProgress('handoff', 0, pageCount, []);
                opSignal.throwIfAborted();
                const check = await runBrowserQpdfCommand('check', new Uint8Array(pdf), {signal: opSignal});
                opSignal.throwIfAborted();
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
            },
        },
    });
}

function rasterizePage(
    context: IBrowserConversionContext,
    pageSize: IPdfPageSize,
    dpi: number,
    maxPixels: number,
    signal = context.signal,
) {
    return renderPageRaster(context.source, pageSize, dpi, maxPixels, signal, undefined, context.engines.observe('pdfPageOps'));
}

async function runRasterConversion(
    context: IBrowserConversionContext,
    rasterSource: Parameters<typeof planScanCleanupFinalPages>[0]['rasterSource'],
    pageSizeStore: ReturnType<typeof createArrayBackedPdfPageSizeStore>,
) {
    const {
        request, signal, summary, emitProgress, pageNumbers, pageCount, options, documentCanvas,
    } = context;
    const output = createOrderedPdfMerge({
        signal,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
        createError: reason => new ScanCleanupContractError(`Scan cleanup could not merge its output pages: ${reason}`),
    });
    const outputPages: TRenderedOutput[] = [];
    const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
    const nativeOptionsBySource = new Map<number, NonNullable<ReturnType<typeof buildShapeOnlyNativeScanCleanupManifest>['pages'][number]['options']>>();
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const pageGeometryByNumber = new Map<number, IPdfPageSize>();
    const textPages: IScanCleanupTextLayerInstruction[] = [];
    const skippedNonAffine: number[] = [];
    const fittedMarginBoxPages = new Set<number>();
    const rasterizedPageNumbers = new Set<number>();
    const completedPageNumbers = new Set<number>();
    let completedPagesVersion = 0;
    const activePages = createScanCleanupActivePageTracker();
    let sourceMrcFallbackReported = false;
    const detectedRasterByPage = new Map<number, NonNullable<Awaited<ReturnType<typeof rasterSource.getPageRaster>>>>();
    const publishRendering = () => {
        emitProgress('rendering', completedPageNumbers.size, pageCount, completedPageNumbers, {
            completedPagesVersion,
            rasterizedUnits: rasterizedPageNumbers.size,
            ...activePages.snapshot(),
        });
    };
    publishRendering();
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
        const planned = await planScanCleanupFinalPages({
            request: batchRequest,
            documentCanvas,
            rasterSource,
            pageSizeStore,
            log: () => undefined,
            signal,
            warnEvent: context.warnEvent,
            probeGuardrail: async (_pageNumber, page) => {
                const probe = await rasterizePage(context, page, SCAN_CLEANUP_SIZE_PROBE_DPI, SCAN_CLEANUP_RASTER_MAX_PIXELS);
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
        ] of planned.detectedRasterByPage) {detectedRasterByPage.set(pageNumber, raster);}
        if (!sourceMrcFallbackReported && planned.rasterPlans.some(plan => resolveScanCleanupSourceMrcCandidacy(
            batchRequest,
            plan,
            planned.pageGeometryByNumber.get(plan.pageNumber)!,
            planned.detectedRasterByPage.get(plan.pageNumber),
        ).eligible)) {
            sourceMrcFallbackReported = true;
            summary.sourceLayersReconstructed = true;
        }
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
        const budget = resolveBrowserPageLanes();
        const concurrency = Math.min(budget.producerConcurrency, manifest.pages.length);
        await runBoundedRasterProducerConsumer<typeof manifest.pages[number], {
            index: number;
            prepared: Omit<IPreparedRenderedPage, 'planes'>;
            combinedData: Uint8Array | null;
        }>({
            items: manifest.pages,
            budget,
            signal,
            estimateItemBytes: (_manifestPage, index) => {
                const plan = planned.rasterPlans[index]!;
                return estimateBrowserScanCleanupEngineBytes(
                    pageRasterPixels(
                        planned.pageGeometryByNumber.get(plan.pageNumber)!,
                        plan.dpi,
                        resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode, undefined),
                    ),
                    plan.resolvedOutputMode !== 'bw' && plan.resolvedOutputMode !== 'grayscale',
                );
            },
            produce: async (manifestPage, index, pageSignal) => {
                const plan = planned.rasterPlans[index]!;
                const pageNumber = plan.pageNumber;
                const pageGeometry = planned.pageGeometryByNumber.get(pageNumber)!;
                const maxPixels = resolveScanCleanupPipelineMaxPixels(plan.resolvedOutputMode, undefined);
                activePages.start(pageNumber);
                if (!pageSignal.aborted) {publishRendering();}
                try {
                    const raster = await rasterizePage(context, pageGeometry, plan.dpi, maxPixels, pageSignal);
                    if (!pageSignal.aborted) {
                        rasterizedPageNumbers.add(pageNumber);
                        publishRendering();
                    }
                    const analysisDpi = planned.analysisDpiByPage.get(pageNumber)!;
                    const analysisMaxPixels = Math.min(maxPixels, SCAN_CLEANUP_RASTER_MAX_PIXELS);
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
                            raster: (await rasterizePage(context, pageGeometry, analysisDpi, analysisMaxPixels, pageSignal)).ppm,
                            dpi: analysisDpi,
                        };
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
                    }, pageSignal, context.engines.observe('scanCleanup'), concurrency, subProgress => {
                        if (!pageSignal.aborted) {
                            activePages.setStage(pageNumber, subProgress.stage);
                            publishRendering();
                        }
                    }));
                    context.engines.throwIfChanged();
                    if (activePages.clearStage(pageNumber) && !pageSignal.aborted) {
                        publishRendering();
                    }
                    const prepared = prepareRenderedPage(context, {
                        pageNumber,
                        plan,
                        pageMetadata: rendered.pageMetadata,
                        rendered,
                        declaredOutputCount: manifestPage.outputs.length,
                        detectedRaster: planned.detectedRasterByPage.get(pageNumber),
                        pageGeometry,
                        resolvePageOutputMode: planned.resolvePageOutputMode,
                    });
                    let combinedData: Uint8Array | null = null;
                    if (prepared.pageOutputs.length > 0) {
                        const combined = await runBrowserPdfCombineWorkerRequest('combinePdfs', {
                            inputs: [...prepared.planes].map(([
                                fileName,
                                data,
                            ]) => ({
                                fileName,
                                data,
                            })),
                            wasmImagePreprocessing: {compactManifestLines: prepared.pageOutputs.map(pageOutput => serializeScanCleanupCombinePage(
                                planScanCleanupCombinePage(pageOutput, undefined),
                            ))},
                        }, pageSignal, {onEngineIdentity: context.engines.observe('pdfImageCombine')});
                        context.engines.throwIfChanged();
                        combinedData = combined.data;
                    }
                    const {
                        planes: _combinedPlanes,
                        ...preparedForCommit
                    } = prepared;
                    activePages.finish(pageNumber);
                    if (!pageSignal.aborted) {
                        const previousSize = completedPageNumbers.size;
                        completedPageNumbers.add(pageNumber);
                        if (completedPageNumbers.size !== previousSize) {completedPagesVersion += 1;}
                        publishRendering();
                    }
                    return {
                        staged: {
                            index,
                            prepared: preparedForCommit,
                            combinedData,
                        },
                        actualBytes: combinedData?.byteLength ?? 0,
                    };
                } catch (error) {
                    activePages.finish(pageNumber);
                    throw error;
                }
            },
            consumeChunk: async (chunk) => {
                for (const {
                    index, prepared, combinedData,
                } of chunk) {
                    const manifestPage = manifest.pages[index]!;
                    const plan = planned.rasterPlans[index]!;
                    const pageNumber = plan.pageNumber;
                    const pageGeometry = planned.pageGeometryByNumber.get(pageNumber)!;
                    pageGeometryByNumber.set(pageNumber, pageGeometry);
                    nativeOptionsBySource.set(pageNumber, manifestPage.options);
                    pageMetadataBySource.set(pageNumber, prepared.pageMetadata);
                    commitScanCleanupRenderedPageSummary({
                        summary,
                        pageNumber,
                        pageMetadata: prepared.pageMetadata,
                        pageOutputs: prepared.pageOutputs,
                        deskewSkipped: prepared.deskewSkipped,
                        cropSkipped: prepared.cropSkipped,
                        mixedLayerMismatchWarnings: prepared.mixedLayerMismatchWarnings,
                        pageEmptyOutputMappings: prepared.emptyOutputMappings,
                        emptyOutputMappings,
                        fittedMarginBoxPages,
                        warn: context.warn,
                    });
                    if (prepared.pageOutputs.length > 0) {
                        const textPlan = buildScanCleanupTextLayerPlanFromPageSizeMap(
                            prepared.pageOutputs,
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
                        output.append(combinedData!);
                        outputPages.push(...prepared.pageOutputs);
                    }
                }
            },
            cleanupStaged: () => Promise.resolve(),
        });
    }
    activePages.clear();
    if (fittedMarginBoxPages.size > 0) {
        context.warnEvent({
            code: 'matched-canvas-content-fitted-pages',
            pages: [...fittedMarginBoxPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    summary.outputPages = outputPages.length;
    emitProgress('assembling', 0, 2, []);
    const assembled = await output.merge();
    if (assembled === null || outputPages.length === 0) {
        throw new ScanCleanupContractError('evb-scan-cleanup produced no output pages');
    }
    const refusedAnnotatedPage = skippedNonAffine.find(pageNumber => context.source.annotatedPages.has(pageNumber));
    if (refusedAnnotatedPage !== undefined) {
        throw new ScanCleanupContractError(
            `Cannot preserve annotations on source page ${String(refusedAnnotatedPage)} `
            + 'without affine cleanup geometry. Disable dewarping or preserve original quality.',
        );
    }
    const outputMappings = buildScanCleanupOutputMappings(outputPages, emptyOutputMappings);
    const {stampHex} = buildScanCleanupConversionProvenanceStamp({
        options,
        pageNumbers,
        qualityPath: 'raster',
        sourceSha256: context.sourceSha256,
        nativeOptionsBySource,
        pageMetadataBySource,
        outputMappings,
        buildIds: composeScanCleanupStampBuildIds({
            nativeBinarySha256s: context.engines.settled([
                'scanCleanup',
                'pdfImageCombine',
                'pdfPageOps',
            ]),
            assemblerBackend: 'browser-wasm-pdf-image-combine',
            transportMode: 'browser-wasm-encoded',
        }),
    });
    emitProgress('assembling', 1, 2);
    const overlaid = await overlayPdfTextLayers(assembled, new Uint8Array(context.sourceBytes), {
        pages: textPages,
        provenanceStampHex: stampHex,
    }, {
        signal,
        requireWorker: true,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
    });
    summary.accessibilityTagsRemoved = overlaid.report.accessibilityTagsRemoved;
    emitProgress('assembling', 2, 2);
    context.engines.settled([
        'scanCleanup',
        'pdfImageCombine',
        'pdfPageOps',
    ]);
    summary.sourceTextOmission = await inspectOmittedSourceText(context, [
        ...skippedNonAffine,
        ...overlaid.report.textOmittedSourcePages,
    ]);
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

interface IPrepareRenderedPageInput {
    pageNumber: number;
    plan: Awaited<ReturnType<typeof planScanCleanupFinalPages>>['rasterPlans'][number];
    pageMetadata: INativeScanCleanupPageMetadataV3;
    rendered: IScanCleanupWasmRenderPageResult;
    declaredOutputCount: number;
    detectedRaster: Parameters<typeof resolveCompactSourcePreservation>[5];
    pageGeometry: IPdfPageSize;
    resolvePageOutputMode: (pageNumber: number) => TRenderedOutput['resolvedOutputMode'];
}

interface IPreparedRenderedPage {
    pageNumber: number;
    pageMetadata: INativeScanCleanupPageMetadataV3;
    pageOutputs: TRenderedOutput[];
    planes: Map<TPlaneName, Uint8Array>;
    emptyOutputMappings: IScanCleanupOutputMapping[];
    mixedLayerMismatchWarnings: string[];
    deskewSkipped: number;
    cropSkipped: number;
}

function prepareRenderedPage(context: IBrowserConversionContext, input: IPrepareRenderedPageInput): IPreparedRenderedPage {
    const {request} = context;
    const {
        pageNumber, pageMetadata, rendered,
    } = input;
    const planes = new Map<TPlaneName, Uint8Array>();
    const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
    const mixedLayerMismatchWarnings: string[] = [];
    if (pageMetadata.excluded) {
        emptyOutputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: pageMetadata.rotationDegrees,
            excluded: true,
            blank: false,
        });
        return {
            pageNumber,
            pageMetadata,
            pageOutputs: [],
            planes,
            emptyOutputMappings,
            mixedLayerMismatchWarnings,
            deskewSkipped: 0,
            cropSkipped: 0,
        };
    }
    if (rendered.outputs.length !== pageMetadata.outputCount) {
        throw new ScanCleanupContractError(
            `Scan cleanup page ${String(pageNumber)} published ${String(rendered.outputs.length)} of its ${String(pageMetadata.outputCount)} outputs`,
        );
    }
    const intentionallyBlankOutputCount = pageMetadata.blankOutputsSkipped > 0
        ? Math.max(0, input.declaredOutputCount - pageMetadata.outputCount)
        : 0;
    const pageOutputs: TRenderedOutput[] = [];
    let deskewSkipped = 0;
    let cropSkipped = 0;
    for (const [
        outputIndex,
        output,
    ] of rendered.outputs.entries()) {
        const {metadata} = output;
        const name = (plane: IScanCleanupWasmPlane) => `p${String(pageNumber)}-${String(outputIndex)}-${plane.role}.${planeExtension(plane)}`;
        const plane = (role: TScanCleanupWasmPlaneRole, description: string) => {
            const found = output.planes.find(candidate => candidate.role === role);
            if (found === undefined) {
                throw new ScanCleanupContractError(`Scan cleanup page ${String(pageNumber)} published no ${description}`);
            }
            planes.set(name(found), found.data);
            return found;
        };
        const composite = output.planes.find(candidate => candidate.role === 'composite');
        const requireComposite = (description: string) => {
            if (composite === undefined) {
                throw new ScanCleanupContractError(
                    `Scan cleanup page ${String(pageNumber)} published no ${description}`,
                );
            }
            planes.set(name(composite), composite.data);
        };
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
                    backgroundIsColor: background.encoding === 'ppm',
                };
            } else {
                planes.delete(name(background));
                planes.delete(name(foreground));
                requireComposite('non-MRC composite fallback after invalid mixed layers');
                mixedLayerMismatchWarnings.push(
                    `Page ${String(pageNumber)} mixed layer dimensions do not match metadata ${mismatch}; using the non-MRC composite path`,
                );
            }
        } else if (metadata.bilevelWritten) {
            layers = {bilevelPath: name(plane('bilevel', 'bilevel output'))};
        } else {
            requireComposite('composite output');
        }
        const renderedOutput: TRenderedOutput = {
            sourcePageNumber: pageNumber,
            path: composite === undefined ? `p${String(pageNumber)}-${String(outputIndex)}-composite.png` : name(composite),
            ...layers,
            dpi: metadata.renderDpi ?? input.plan.dpi,
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
        if (!metadata.skewApplied) {deskewSkipped += 1;}
        if (request.options.crop && metadata.contentBox == null) {cropSkipped += 1;}
    }
    collectScanCleanupPageOutputs({
        request,
        sourcePageNumber: pageNumber,
        pageMetadata,
        pageOutputPages: pageOutputs,
        intentionallyBlankOutputCount,
        emptyOutputMappings,
    });
    return {
        pageNumber,
        pageMetadata,
        pageOutputs,
        planes,
        emptyOutputMappings,
        mixedLayerMismatchWarnings,
        deskewSkipped,
        cropSkipped,
    };
}

async function inspectOmittedSourceText(context: IBrowserConversionContext, pages: readonly number[]) {
    if (pages.length === 0) {return undefined;}
    const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
        source: new Blob([new Uint8Array(context.sourceBytes)]),
        pages: [...new Set(pages)],
        withEvbOcrText: true,
    }, {
        signal: context.signal,
        requireWorker: true,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
    });
    return isBrowserPageOpsWasmFailure(report) ? undefined : reduceScanCleanupSourceTextOmission(report);
}

/**
 * Keep original images: every page analyzed, reconciled and placed as a
 * desktop lossless manifest does, then one split of the source itself.
 */
async function runLosslessConversion(
    context: IBrowserConversionContext,
    rasterSource: Parameters<typeof planScanCleanupFinalPages>[0]['rasterSource'],
    pageSizeStore: ReturnType<typeof createArrayBackedPdfPageSizeStore>,
) {
    const {
        request, signal, summary, emitProgress, pageNumbers, pageCount, documentCanvas,
    } = context;
    const documentDpi = resolveSourceDpi(rasterSource.documentDpi);
    const analyzedPages: IScanCleanupAnalyzedLosslessPage[] = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const nativeOptionsBySource = new Map<number, ReturnType<typeof buildShapeOnlyNativeScanCleanupManifest>['pages'][number]['options']>();
    const rasterized = new Set<number>();
    const completed = new Set<number>();
    let completedVersion = 0;
    const activePages = createScanCleanupActivePageTracker();
    const publishClassifying = () => {
        emitProgress('classifying', completed.size, pageCount, completed, {
            completedPagesVersion: completedVersion,
            rasterizedUnits: rasterized.size,
            ...activePages.snapshot(),
        });
    };
    publishClassifying();
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
        const pagePlanResolver = createPagePlanResolver(batchRequest, () => undefined, 'lossless');
        const facts = await Promise.all(batchPageNumbers.map(async pageNumber => {
            const view = await pageSizeStore.getPage(pageNumber);
            const detected = await rasterSource.getPageRaster(pageNumber);
            return {
                pageNumber,
                view,
                sourceDpi: resolveSourceDpi(detected?.dpi, documentDpi),
                sourceRasterDetected: detected !== undefined,
                analysisDpi: resolveScanCleanupAnalysisDpi(view),
            };
        }));
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
        pagePlanResolver.report();
        for (const [
            index,
            page,
        ] of facts.entries()) {nativeOptionsBySource.set(page.pageNumber, manifest.pages[index]!.options);}
        const finishedPages = await runBrowserScanCleanupAnalysis({
            pages: facts.map((page, index) => ({
                options: manifest.pages[index]!.options,
                sourcePageIndex: page.pageNumber - 1,
                pdfPage: manifest.pages[index]!.pdfPage!,
            })),
            canvasScope: 'document',
            renderMode: 'final',
            ...(documentCanvas === null ? {} : {documentCanvas}),
            signal,
            onEngineIdentity: context.engines.observe('scanCleanup'),
            estimatePixels: (job) => {
                const page = facts[job.index]!;
                return pageRasterPixels(page.view, page.analysisDpi, SCAN_CLEANUP_RASTER_MAX_PIXELS);
            },
            rasterize: async (job, jobSignal) => {
                const page = facts[job.index]!;
                const raster = await rasterizePage(context, page.view, page.analysisDpi, SCAN_CLEANUP_RASTER_MAX_PIXELS, jobSignal);
                if (!job.rerun && !jobSignal.aborted) {
                    rasterized.add(page.pageNumber);
                    publishClassifying();
                }
                return raster.ppm;
            },
            onPageStarted: (job) => {
                activePages.start(facts[job.index]!.pageNumber);
                publishClassifying();
            },
            onPageStage: (job, subProgress) => {
                activePages.setStage(facts[job.index]!.pageNumber, subProgress.stage);
                publishClassifying();
            },
            onAnalyzed: (job) => {
                const pageNumber = facts[job.index]!.pageNumber;
                activePages.finish(pageNumber);
                if (job.view === 'primary' && !job.rerun) {
                    const previousSize = completed.size;
                    completed.add(pageNumber);
                    if (completed.size !== previousSize) {completedVersion += 1;}
                }
                publishClassifying();
            },
        });
        for (const [
            index,
            finished,
        ] of finishedPages.entries()) {
            signal.throwIfAborted();
            const page = facts[index]!;
            if (!completed.has(page.pageNumber)) {
                completed.add(page.pageNumber);
                completedVersion += 1;
                publishClassifying();
            }
            const analyzed = reduceScanCleanupLosslessPage({
                request,
                pageNumber: page.pageNumber,
                metadata: finished.pageMetadata,
                sourceDpi: page.sourceDpi,
                sourceRasterDetected: page.sourceRasterDetected,
                summary,
                pageMetadataBySource,
            });
            if (analyzed !== null) {analyzedPages.push(analyzed);}
        }
    }
    activePages.clear();
    const {
        allOutputs,
        outputMappings,
    } = finalizeScanCleanupLosslessOutputs({
        request,
        pageNumbers,
        analyzedPages,
        pageMetadataBySource,
        summary,
        warnEvent: context.warnEvent,
    });
    const {stampHex} = buildScanCleanupConversionProvenanceStamp({
        options: request.options,
        pageNumbers,
        qualityPath: 'lossless',
        sourceSha256: context.sourceSha256,
        nativeOptionsBySource,
        pageMetadataBySource,
        outputMappings,
        buildIds: composeScanCleanupStampBuildIds({
            nativeBinarySha256s: context.engines.settled([
                'scanCleanup',
                'pdfPageOps',
            ]),
            assemblerBackend: 'browser-wasm-pdf-page-ops',
            transportMode: 'source-preserved',
        }),
    });
    emitProgress('assembling', 0, allOutputs.length, []);
    const instructions = buildScanCleanupPageOpsInstructions(analyzedPages.map(page => ({
        sourcePageIndex: page.sourcePageIndex,
        rotationQuarterTurns: page.rotationQuarterTurns,
        outputs: page.outputs.map(({placement}) => ({
            cropRect: placement.cropRect,
            ...(placement.contentTransform ? {contentTransform: placement.contentTransform} : {}),
        })),
    })), stampHex);
    const split = await splitPdfPages(new Uint8Array(context.sourceBytes), instructions, {
        signal,
        requireWorker: true,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
    });
    context.engines.settled([
        'scanCleanup',
        'pdfPageOps',
    ]);
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
