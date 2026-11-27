import {
    decodeScanCleanupPageOpsResult,
    decodeNativeScanCleanupPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupOptionsV3,
    INativeScanCleanupPageMetadataV3,
    IScanCleanupDocumentCanvasPlan,
    TScanCleanupOutputHalf,
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
    type IPdfPageSize,
    type IDetectedPageRaster,
    type IScanCleanupRepresentationReport,
    type IScanCleanupPageRasterSource,
    type TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import {
    toCropBoxPageSize,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {resolveScanCleanupAnalysisDpi} from '@evb/scan-cleanup/core/detection';
import {resolveScanCleanupRasterRenderLimits} from '@evb/scan-cleanup/core/rasterValidation';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildRunnableNativeScanCleanupManifest';
import {SCAN_CLEANUP_ASSEMBLY_STEP_TIMEOUT_MS} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
import {
    buildScanCleanupPageOpsInstructions,
    isScanCleanupCliFallbackSentinel,
    serializeLegacyScanCleanupPageOpsInstructions,
    serializeScanCleanupPageOpsInstructions,
} from '@evb/scan-cleanup/core/compactManifest';
import {buildScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/buildManifest';
import {sha256ScanCleanupFile} from '@evb/scan-cleanup/core/sha256ScanCleanupFile';
import {
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDroppedMatchWarningEventFromAccumulator,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import {
    collectSourceText,
    type IScanCleanupSourceTextSink,
} from '@evb/scan-cleanup/core/streamingSidecars';
import type {TEmitScanCleanupProgress} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupActivePageTracker,
    createScanCleanupSummaryWarningReporter,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    buildScanCleanupConversionProvenanceStamp,
    finalizeScanCleanupLosslessOutputs,
    reduceScanCleanupLosslessPage,
    type IScanCleanupAnalyzedLosslessPage,
} from '@evb/scan-cleanup/core/coordinateScanCleanupConversion';
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

/**
 * A streaming child may inherit the parent's document canvas. In that case the
 * child must not restart a full geometry-sidecar pass just to rediscover the
 * same rectangle. `documentCanvas: null` is an explicit decision to run without
 * matched-page normalization; omitting it keeps the direct-call behavior.
 */
export interface IScanCleanupLosslessRunContext {
    documentCanvas?: IScanCleanupDocumentCanvasPlan | null;
    skipDocumentCanvasMeasurement?: boolean;
    onRecoveryPending?: (recovery: Promise<boolean>) => void | Promise<void>;
    /**
     * Set when this run is one batch of a larger one. The batch may produce no
     * pages, and its pages become link targets of the run's final overlay,
     * which rebuilds navigation once the batches are merged.
     */
    streamingChildSourceText?: IScanCleanupSourceTextSink;
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
    dpiDetails: IScanCleanupPageRasterSource,
    scratch: string,
    stagedPdfPath: string,
    signal: AbortSignal,
    emitProgress: TEmitScanCleanupProgress,
    log: TScanCleanupLog,
    policy: IScanCleanupRuntimePolicy,
    dependencies: IRunScanCleanupPipelineDependencies,
    context: IScanCleanupLosslessRunContext = {},
    initialSummary?: TScanCleanupSummary,
) {
    // The assembler crops in the source page's own user space, so a page that
    // is handed another page's box writes a wrong document rather than a
    // failing one. This entry is reachable directly, not only through the
    // conversion run that already admitted its geometry.
    if (!paths.pdfPageOpsBinary) {
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
    }
    const documentDpi = resolveSourceDpi(dpiDetails.documentDpi);
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
    const fullDocumentRun = request.sourcePageNumbers === undefined
        && request.sourcePageRange === undefined;
    const pagePlanResolver = createPagePlanResolver(request, log, 'lossless');
    emitProgress('rasterizing', 0, pageNumbers.length, []);
    const summary = initialSummary ?? createEmptyScanCleanupSummary(pageNumbers.length, preparedWarnings);
    const warn = createScanCleanupSummaryWarningReporter(summary, log);
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
    const documentCanvas = context.documentCanvas === undefined
        ? request.options.matchPageSize
            ? resolveScanCleanupDocumentCanvasFromAccumulator(
                canvasAccumulator,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                request.options,
                true,
                policy.rasterMaxPixels,
            )
            : null
        : context.documentCanvas;
    const analyzedPages: IScanCleanupAnalyzedLosslessPage[] = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const nativeOptionsBySource = new Map<number, INativeScanCleanupOptionsV3>();
    const rasterizedPageNumbers = new Set<number>();
    const classifiedPageNumbers = new Set<number>();
    const collectedPageNumbers = new Set<number>();
    const activePages = createScanCleanupActivePageTracker();
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
            await dpiDetails.getPageRaster(pageNumber),
        ] as const)));
        for (const [
            pageNumber,
            raster,
        ] of batchRasterByNumber) {
            dpiDetails.recordPageRaster?.(pageNumber, raster);
        }
        const rasterPlans = batchPageNumbers.map(pageNumber => resolveRasterPlan(
            pageNumber,
            batchRasterByNumber.get(pageNumber),
        ));
        // Lossless pages are analyzed on the same plane detection classified
        // them on; the source pages themselves are preserved, not rendered.
        const analysisDpiByPage = new Map(batchPageNumbers.map(pageNumber => [
            pageNumber,
            resolveScanCleanupAnalysisDpi(pageSizeByNumber.get(pageNumber)),
        ]));
        const rasterHandoff = await resolveRasterHandoff(rasterPlans.map(plan => ({
            renderDpi: analysisDpiByPage.get(plan.pageNumber)!,
            raster: plan.raster,
        })), scratch, dependencies.getAvailableScratchBytes);
        logRasterHandoff(log, 'lossless analysis', rasterHandoff);
        const pageInputs = await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async plan => {
            signal.throwIfAborted();
            const inputPath = join(scratch, `analysis-${plan.pageNumber}.${rasterHandoff.format}`);
            const renderer = rasterHandoff.format === 'ppm'
                ? dependencies.renderPagePpm
                : dependencies.renderPage;
            const pageSize = pageSizeByNumber.get(plan.pageNumber)!;
            const analysisDpi = analysisDpiByPage.get(plan.pageNumber)!;
            await renderer(
                paths,
                log,
                plan.pageNumber,
                preparedPdfPath,
                inputPath,
                analysisDpi,
                undefined,
                signal,
                undefined,
                resolveScanCleanupRasterRenderLimits(pageSize, analysisDpi),
                pageSize.renderBox ?? 'cropbox',
                'exclude',
                context.onRecoveryPending,
            );
            rasterizedCount += 1;
            rasterizedPageNumbers.add(plan.pageNumber);
            emitProgress('rasterizing', rasterizedCount, pageNumbers.length, rasterizedPageNumbers);
            return {
                inputPath,
                analysisInputPath: inputPath,
                analysisDpi,
                pageNumber: plan.pageNumber,
                dpi: analysisDpi,
                ...(request.layoutByPage?.[String(plan.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(plan.pageNumber)]!}),
                ...pagePlanResolver.resolve(plan.pageNumber),
                pdfPage: {
                    xPoints: pageSize.xPoints,
                    yPoints: pageSize.yPoints,
                    widthPoints: pageSize.widthPoints,
                    heightPoints: pageSize.heightPoints,
                    rotation: pageSize.rotation,
                    sourceDpi: plan.dpi,
                },
                pageMetadataPath: join(scratch, `analysis-${plan.pageNumber}.json`),
            };
        });
        const manifest = buildRunnableNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'lossless',
            hostMemoryBytes: policy.totalRamBytes,
            options: request.options,
            ...(documentCanvas === null ? {} : {documentCanvas}),
            ...(policy.rasterMaxPixels === undefined ? {} : {rasterMaxPixels: policy.rasterMaxPixels}),
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: pageInputs,
            // Every path in this manifest is staged under this run's scratch.
            // Keeping the native boundary per-run prevents one conversion from
            // authorizing reads or writes in another conversion's workspace.
            allowedPathRoot: scratch,
        });
        const pages = manifest.pages;
        const manifestPath = join(
            scratch,
            `lossless-analysis-manifest-${String(batch.batchIndex)}.json`,
        );
        await writeFile(manifestPath, JSON.stringify(manifest));
        for (const [
            index,
            page,
        ] of pages.entries()) {
            nativeOptionsBySource.set(batchPageNumbers[index]!, page.options);
        }
        emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers, {
            rasterizedUnits: rasterizedCount,
        });
        await dependencies.runSidecar(paths.scanCleanupBinary, manifestPath, signal, log, nativeProgress => {
            // Native reports page numbers relative to this manifest. Keep
            // the source mapping local to the bounded batch.
            if (nativeProgress.totalPages !== pages.length) {
                throw new Error(
                    `evb-scan-cleanup analysis reported ${String(nativeProgress.totalPages)} total pages`
                        + ` for ${String(pages.length)} submitted pages`,
                );
            }
            if (nativeProgress.stage === 'page-started' && nativeProgress.pageNumber !== undefined) {
                const sourcePageNumber = batchPageNumbers[nativeProgress.pageNumber - 1];
                if (sourcePageNumber !== undefined) {
                    activePages.start(sourcePageNumber);
                    emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers, {
                        rasterizedUnits: rasterizedCount,
                        ...activePages.snapshot(),
                    });
                }
                return;
            }
            if (
                nativeProgress.stage === 'page-stage'
                && nativeProgress.pageNumber !== undefined
                && nativeProgress.subPageStage !== undefined
            ) {
                const sourcePageNumber = batchPageNumbers[nativeProgress.pageNumber - 1];
                if (sourcePageNumber !== undefined) {
                    activePages.setStage(sourcePageNumber, nativeProgress.subPageStage);
                    emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers, {
                        rasterizedUnits: rasterizedCount,
                        ...activePages.snapshot(),
                    });
                }
                return;
            }
            if (nativeProgress.stage === 'page-analyzed' && nativeProgress.pageNumber !== undefined) {
                const sourcePageNumber = batchPageNumbers[nativeProgress.pageNumber - 1];
                if (sourcePageNumber !== undefined && activePages.finish(sourcePageNumber)) {
                    emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers, {
                        rasterizedUnits: rasterizedCount,
                        ...activePages.snapshot(),
                    });
                }
                return;
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
                activePages.finish(sourcePageNumber);
                if (!classifiedPageNumbers.has(sourcePageNumber)) {
                    classifiedPageNumbers.add(sourcePageNumber);
                    classifiedCount += 1;
                }
            }
            emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers, {
                rasterizedUnits: rasterizedCount,
                ...activePages.snapshot(),
            });
        }, {
            allowedPathRoot: scratch,
            ...(context.onRecoveryPending === undefined ? {} : {onRecoveryPending: context.onRecoveryPending}),
        });
        activePages.clear();
        emitProgress('collecting', collectedCount, pageNumbers.length, collectedPageNumbers);
        // Release successful batches before rendering the next one. A failed
        // sidecar may still read these inputs; the job's recovery callback
        // retains their scratch until termination and recovery are proven.
        await Promise.all(pages.map(page => rm(page.inputPath, {force: true})));
        try {
            for (const [
                index,
                page,
            ] of pages.entries()) {
                const metadata = decodeNativeScanCleanupPageMetadataJson(
                    await readFile(page.pageMetadataPath, 'utf8'),
                );
                const sourcePageNumber = batchPageNumbers[index]!;
                collectedPageNumbers.add(sourcePageNumber);
                collectedCount += 1;
                emitProgress('collecting', collectedCount, pageNumbers.length, collectedPageNumbers);
                const analyzed = reduceScanCleanupLosslessPage({
                    request,
                    pageNumber: sourcePageNumber,
                    metadata,
                    sourceDpi: resolveRasterPlan(
                        sourcePageNumber,
                        batchRasterByNumber.get(sourcePageNumber),
                    ).dpi,
                    sourceRasterDetected: batchRasterByNumber.get(sourcePageNumber) !== undefined,
                    summary,
                    pageMetadataBySource,
                });
                if (analyzed !== null) {analyzedPages.push(analyzed);}
            }
        } finally {
            await Promise.all(pages.map(page => rm(page.pageMetadataPath, {force: true})));
        }
    }
    // A source that has no compact-layer probe is still a valid page raster
    // source. Only an explicit incomplete result proves that automatic source
    // budgeting cannot be trusted.
    const compactLayeredPageCountComplete = dpiDetails.compactLayeredPageCountComplete !== false;
    const compactLayeredPageCount = dpiDetails.compactLayeredPageCount ?? 0;
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
    pagePlanResolver.report();
    if (documentCanvas === null && request.options.matchPageSize) {
        const droppedEvent = resolveScanCleanupDroppedMatchWarningEventFromAccumulator(canvasAccumulator);
        if (droppedEvent) {warnEvent(droppedEvent);}
    }
    const {
        allOutputs,
        outputMappings,
    } = finalizeScanCleanupLosslessOutputs({
        request,
        pageNumbers,
        analyzedPages,
        pageMetadataBySource,
        summary,
        warnEvent,
        allowEmptyOutputs: context.streamingChildSourceText !== undefined,
    });
    const {
        stamp,
        stampHex,
    } = buildScanCleanupConversionProvenanceStamp({
        options: request.options,
        pageNumbers,
        qualityPath: 'lossless',
        sourceSha256: request.provenance?.sourceSha256 ?? await sha256ScanCleanupFile(preparedPdfPath),
        nativeOptionsBySource,
        pageMetadataBySource,
        outputMappings,
        buildIds: await buildScanCleanupStampBuildIds({
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
            ...(request.provenance === undefined
                ? {}
                : {reusableNativeBinarySha256s: request.provenance.nativeBinarySha256s}),
        }),
    });
    await writeFile(join(scratch, 'scan-cleanup-provenance-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    if (allOutputs.length === 0) {
        await writeFile(join(scratch, 'scan-cleanup-representation-report.json'), JSON.stringify({
            outputMappings,
            pages: [],
        }));
        return summary;
    }
    const instructionsPath = join(scratch, 'split-pages.json');
    await writeFile(instructionsPath, (paths.provenanceStampSupport === false
        ? serializeLegacyScanCleanupPageOpsInstructions
        : serializeScanCleanupPageOpsInstructions)(
        buildScanCleanupPageOpsInstructions(analyzedPages.map(page => ({
            sourcePageIndex: page.sourcePageIndex,
            rotationQuarterTurns: page.rotationQuarterTurns,
            outputs: page.outputs.map(({placement}) => ({
                cropRect: placement.cropRect,
                ...(placement.contentTransform ? {contentTransform: placement.contentTransform} : {}),
            })),
        })), stampHex),
    ));
    emitProgress('assembling', 0, allOutputs.length, []);
    const pageOps = await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'split-pages',
        '--input',
        preparedPdfPath,
        '--output',
        stagedPdfPath,
        '--instructions-file',
        instructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(split-pages:scan-cleanup)',
        timeoutMs: SCAN_CLEANUP_ASSEMBLY_STEP_TIMEOUT_MS,
        log,
        ...(context.onRecoveryPending === undefined ? {} : {onTerminationProof: context.onRecoveryPending}),
    });
    summary.accessibilityTagsRemoved = decodeScanCleanupPageOpsResult(pageOps.stdout).accessibilityTagsRemoved;
    if (context.streamingChildSourceText !== undefined) {
        // A merge drops this batch's catalog; each page it placed stays a
        // link target, positioned by its content transform, for the overlay.
        collectSourceText(context.streamingChildSourceText, {
            pages: allOutputs.map((output, outputPageIndex) => {
                const transform = output.placement.contentTransform;
                return {
                    sourcePageIndex: output.sourcePageIndex,
                    outputPageIndex,
                    matrix: [
                        transform?.scale ?? 1,
                        0,
                        0,
                        transform?.scale ?? 1,
                        transform?.translateX ?? 0,
                        transform?.translateY ?? 0,
                    ],
                    linkOnly: true,
                };
            }),
            skippedNonAffine: [],
            alreadyPreserved: allOutputs.map(output => output.sourcePageIndex + 1),
        });
    }
    emitProgress('assembling', allOutputs.length, allOutputs.length);
    const [
        sourceFile,
        outputFile,
    ] = await Promise.all([
        stat(preparedPdfPath),
        stat(stagedPdfPath),
    ]);
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
