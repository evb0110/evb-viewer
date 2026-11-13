import type {
    INativeScanCleanupPageMetadataV3,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
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
import {
    mapScanCleanupPageScope,
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {
    ScanCleanupContractError,
    ScanCleanupPdfValidationError,
    ScanCleanupStreamingEvidenceError,
} from '@evb/scan-cleanup/core/errors';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {runBrowserScanCleanupWorkerRequest} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import {runBrowserPdfCombineWorkerRequest} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {
    overlayPdfTextLayers,
    splitPdfPages,
} from '@app/platform/browser-api/browserPageOpsCore';
import {runBrowserQpdfCommand} from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    renderPageRaster,
    runBrowserScanCleanupAnalysis,
    unwrapBrowserScanCleanupOutcome,
    type IBrowserScanCleanupSource,
} from '@app/platform/browser-api/browserScanCleanupJob';


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
        if (known !== undefined && known !== sha256) conflict = role;
        identities[role] = sha256;
    };
    return {
        observe,
        settled(roles: readonly TEngineRole[]) {
            if (conflict !== null) {
                throw new BrowserScanCleanupEngineChangedError(conflict);
            }
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
    const largeRun = documentPageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES;
    // Detection's page records are the geometry a small run renders: they
    // carry the page view detection chose, MediaBox included, as on desktop.
    const metadataPages: IPdfPageSize[] = [];
    for (let pageNumber = 1; !largeRun && pageNumber <= documentPageCount; pageNumber += 1) {
        const page = request.sourcePageMetadataByPage?.[String(pageNumber)];
        if (page?.pageNumber !== pageNumber) break;
        metadataPages.push(page);
    }
    const pageSizeStore = createArrayBackedPdfPageSizeStore(
        metadataPages.length === documentPageCount ? metadataPages : source.pageSizes,
    );
    emitProgress('probing', 0, documentPageCount, []);
    // The inventory answers what desktop's pdfimages probe does, over the
    // pages desktop would probe; page geometry stands in where it found no
    // raster at all, without hiding an incomplete inventory.
    const probesWholeDocument = request.options.matchPageSize
        || (request.sourcePageNumbers === undefined && request.sourcePageRange === undefined)
        || pageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES;
    const probedPages = probesWholeDocument ? null : new Set(pageNumbers);
    const inScope = (pageNumber: number) => probedPages === null || probedPages.has(pageNumber);
    const structural = toScanCleanupPageRasterSource(
        reduceScanCleanupRasterRows(source.rasterRows.filter(row => inScope(row.pageNumber))),
        ![...source.incompleteRasterPages].some(inScope),
    );
    const geometry = structural.detected
        ? null
        : await createPageGeometryRasterSource(pageSizeStore, documentPageCount, signal);
    const rasterSource = geometry === null
        ? structural
        : {
            ...geometry,
            compactLayeredPageCountComplete: structural.compactLayeredPageCountComplete !== false,
        };
    emitProgress('probing', documentPageCount, documentPageCount);
    // An Auto run over the whole document budgets its output against the
    // source's compact pages; unknown pages make that budget unknown.
    const fullDocumentRun = request.sourcePageNumbers === undefined && request.sourcePageRange === undefined;
    if (fullDocumentRun && request.options.outputMode === 'auto' && rasterSource.compactLayeredPageCountComplete === false) {
        throw new ScanCleanupStreamingEvidenceError(
            'browser-raster-inventory',
            'Automatic scan cleanup could not establish a bounded compact-source budget for the full document; '
            + 'source raster probing was incomplete, so publication was refused',
        );
    }
    const geometryRecords: IPdfPageSize[] = [];
    const quality = await planScanCleanupRunQuality({
        // The store, not its materialized copy: the planner reads each page's
        // chosen view from it, as desktop's does.
        request: inputRequest,
        documentPageCount,
        pageSizeStore,
        rasterSource,
        rasterDetectionAvailable: true,
        signal,
        warn,
        warnEvent,
        // A long run renders the page views its geometry pass settled on.
        ...(largeRun ? {onGeometryPage: page => {
            geometryRecords.push(page);
            return Promise.resolve();
        }} : {}),
    });
    const finalPageSizeStore = largeRun ? createArrayBackedPdfPageSizeStore(geometryRecords) : pageSizeStore;
    losslessRun = quality.losslessRun;
    const engines = createEngineIdentities();
    if (source.pageOpsEngineSha256 !== null) engines.observe('pdfPageOps')(source.pageOpsEngineSha256);
    const sourceBytes = await readSource();
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
        ? await runLosslessConversion(context, rasterSource, finalPageSizeStore)
        : await runRasterConversion(context, rasterSource, finalPageSizeStore);
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
    engines: ReturnType<typeof createEngineIdentities>;
}

function rasterizePage(context: IConversionContext, pageSize: IPdfPageSize, dpi: number, maxPixels: number) {
    return renderPageRaster(context.source, pageSize, dpi, maxPixels, context.signal, undefined, context.engines.observe('pdfPageOps'));
}

/** The output pages' PDFs, joined once in the page-ops worker, as on desktop. */
function createOutputPages(signal: AbortSignal, onEngineIdentity: (sha256: string) => void) {
    const pages: Uint8Array[] = [];
    return {
        append: (pagePdf: Uint8Array) => pages.push(pagePdf),
        async merge() {
            if (pages.length < 2) return pages[0] ?? null;
            const result = await runBrowserPageOpsWorkerRequest('pageStructure', {
                edit: {kind: 'merge'},
                sources: pages.map(page => new Blob([page as Uint8Array<ArrayBuffer>])),
                output: null,
            }, {
                signal,
                dedicated: true,
                requireWorker: true,
                onEngineIdentity,
            });
            if (result.status !== 'written' || !result.data) {
                const reason = result.status === 'failed' ? result.error.message : 'the browser\'s storage is full';
                throw new ScanCleanupContractError(`Scan cleanup could not merge its output pages: ${reason}`);
            }
            return result.data;
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
    const output = createOutputPages(signal, context.engines.observe('pdfPageOps'));
    const outputPages: TRenderedOutput[] = [];
    const emptyOutputMappings: IScanCleanupOutputMapping[] = [];
    const nativeOptionsBySource = new Map<number, NonNullable<ReturnType<typeof buildShapeOnlyNativeScanCleanupManifest>['pages'][number]['options']>>();
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const pageGeometryByNumber = new Map<number, IPdfPageSize>();
    const textPages: IScanCleanupTextLayerInstruction[] = [];
    const skippedNonAffine: number[] = [];
    const fittedMarginBoxPages = new Set<number>();
    const completedPageNumbers = new Set<number>();
    let sourceMrcFallbackReported = false;
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
        ] of planned.detectedRasterByPage) detectedRasterByPage.set(pageNumber, raster);
        // Desktop reuses an eligible page's compact source layers; the
        // browser reconstructs it from its raster and says so once.
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
            const raster = await rasterizePage(context, pageGeometry, plan.dpi, maxPixels);
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
                    raster: (await rasterizePage(context, pageGeometry, analysisDpi, analysisMaxPixels)).ppm,
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
            }, signal, context.engines.observe('scanCleanup')));
            const pageMetadata = rendered.pageMetadata;
            pageMetadataBySource.set(pageNumber, pageMetadata);
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
                }, signal, {onEngineIdentity: context.engines.observe('pdfImageCombine')});
                output.append(combined.data);
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
    const assembled = await output.merge();
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
            nativeBinarySha256s: context.engines.settled([
                'scanCleanup',
                'pdfImageCombine',
                'pdfPageOps',
            ]),
            assemblerBackend: 'browser-wasm-pdf-image-combine',
            transportMode: 'browser-wasm-encoded',
        }),
    }));
    emitProgress('assembling', 0, 1, []);
    // One overlay over the merged output: a link may name another page's target.
    const overlaid = await overlayPdfTextLayers(assembled, new Uint8Array(context.sourceBytes), {
        pages: textPages,
        provenanceStampHex: stampHex,
    }, {
        signal,
        requireWorker: true,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
    });
    summary.accessibilityTagsRemoved = overlaid.report.accessibilityTagsRemoved;
    emitProgress('assembling', 1, 1);
    // The overlay names its module only now; it must be the one stamped.
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
        // The engine publishes a composite only where neither primary
        // representation was written, or as the fallback for invalid layers.
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
                    // Desktop reads this from the background file's header,
                    // and the background destination is always a PPM.
                    backgroundIsColor: background.encoding === 'ppm',
                };
            } else {
                planes.delete(name(background));
                planes.delete(name(foreground));
                requireComposite('non-MRC composite fallback after invalid mixed layers');
                context.warn(
                    `Page ${String(pageNumber)} mixed layer dimensions do not match metadata ${mismatch}; using the non-MRC composite path`,
                    'error',
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

async function inspectOmittedSourceText(context: IConversionContext, pages: readonly number[]) {
    if (pages.length === 0) return undefined;
    const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
        data: new Uint8Array(context.sourceBytes),
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
    context: IConversionContext,
    rasterSource: Parameters<typeof planScanCleanupFinalPages>[0]['rasterSource'],
    pageSizeStore: ReturnType<typeof createArrayBackedPdfPageSizeStore>,
) {
    const {
        request, signal, summary, emitProgress, pageNumbers, pageCount, documentCanvas,
    } = context;
    const documentDpi = resolveSourceDpi(rasterSource.documentDpi);
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
        // Each batch resolves its pinned plans from its own bounded decisions.
        const pagePlanResolver = createPagePlanResolver(batchRequest, () => undefined, 'lossless');
        const facts = await Promise.all(batchPageNumbers.map(async pageNumber => {
            const view = await pageSizeStore.getPage(pageNumber);
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
        pagePlanResolver.report();
        for (const [
            index,
            page,
        ] of facts.entries()) nativeOptionsBySource.set(page.pageNumber, manifest.pages[index]!.options);
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
            rasterize: async job => {
                const page = facts[job.index]!;
                return (await rasterizePage(context, page.view, page.analysisDpi, SCAN_CLEANUP_RASTER_MAX_PIXELS)).ppm;
            },
            onAnalyzed: () => emitProgress('classifying', completed.size, pageCount, completed),
        });
        for (const [
            index,
            finished,
        ] of finishedPages.entries()) {
            signal.throwIfAborted();
            const page = facts[index]!;
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
            emitProgress('classifying', completed.size, pageCount, completed);
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
            nativeBinarySha256s: context.engines.settled([
                'scanCleanup',
                'pdfPageOps',
            ]),
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
    const split = await splitPdfPages(new Uint8Array(context.sourceBytes), instructions, {
        signal,
        requireWorker: true,
        onEngineIdentity: context.engines.observe('pdfPageOps'),
    });
    // The split names its module only now; it must be the one stamped.
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
