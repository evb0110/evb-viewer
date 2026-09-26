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
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    resolveSourceDpi,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupProvenanceInputs,
    type IScanCleanupWorkerPaths,
    type IPdfPageSize,
    type IDetectedPageRaster,
    type IScanCleanupOutputMapping,
    type IScanCleanupRepresentationReport,
    type IScanCleanupPageRasterSource,
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
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupDroppedMatchWarningEventFromAccumulator,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {createPagePlanResolver} from '@evb/scan-cleanup/core/createPagePlanResolver';
import type {TEmitScanCleanupProgress} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupSummaryWarningReporter,
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

/**
 * A streaming child may inherit the parent's document canvas. In that case the
 * child must not restart a full geometry-sidecar pass just to rediscover the
 * same rectangle. `documentCanvas: null` is an explicit decision to run without
 * matched-page normalization; omitting it keeps the direct-call behavior.
 */
export interface IScanCleanupLosslessRunContext {
    documentCanvas?: IScanCleanupDocumentCanvasPlan | null;
    provenance?: IScanCleanupProvenanceInputs;
    skipDocumentCanvasMeasurement?: boolean;
}

function resolveLosslessDpiSource(
    source: IScanCleanupPageRasterSource,
): IScanCleanupPageRasterSource {
    return source;
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
    const analyzedPages: Array<{
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        outputs: Array<{
            half: INativeScanCleanupAnalysisOutputV3['half'];
            placement: NonNullable<INativeScanCleanupAnalysisOutputV3['pdfPlacement']>;
        }>;
        sourceDpi: number;
        sourceRasterDetected: boolean;
    }> = [];
    const pageMetadataBySource = new Map<number, INativeScanCleanupPageMetadataV3>();
    const nativeOptionsBySource = new Map<number, INativeScanCleanupOptionsV3>();
    const rasterizedPageNumbers = new Set<number>();
    const classifiedPageNumbers = new Set<number>();
    const collectedPageNumbers = new Set<number>();
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
        for (const [
            pageNumber,
            raster,
        ] of batchRasterByNumber) {
            dpiSource.recordPageRaster?.(pageNumber, raster);
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
        const pageInputs = await mapScanCleanupRasterPages(rasterPlans, policy.rasterConcurrency, async plan => {
            signal.throwIfAborted();
            const extension = rasterHandoff.format;
            const inputPath = join(scratch, `analysis-${plan.pageNumber}.${extension}`);
            const renderer = extension === 'ppm'
                ? dependencies.renderPagePpm
                : dependencies.renderPage;
            const pageSize = pageSizeByNumber.get(plan.pageNumber)!;
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
                    pageSize.renderBox ?? 'cropbox',
                );
                rasterizedCount += 1;
                rasterizedPageNumbers.add(plan.pageNumber);
                emitProgress('rasterizing', rasterizedCount, pageNumbers.length, rasterizedPageNumbers);
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
        emitProgress('classifying', classifiedCount, pageNumbers.length, classifiedPageNumbers);
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
            }, {
                allowedPathRoot: scratch,
                ...(paths.sidecarRegistryRoot === undefined
                    ? {}
                    : {sidecarRegistryRoot: paths.sidecarRegistryRoot}),
            });
            emitProgress('collecting', collectedCount, pageNumbers.length, collectedPageNumbers);
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
                const sourcePageNumber = batchPageNumbers[index]!;
                collectedPageNumbers.add(sourcePageNumber);
                collectedCount += 1;
                emitProgress('collecting', collectedCount, pageNumbers.length, collectedPageNumbers);
                // Placement is planned from the canvas rather than observed on
                // the page, so the provenance evidence stays the analysis alone.
                pageMetadataBySource.set(sourcePageNumber, metadata.outputs === undefined ? metadata : {
                    ...metadata,
                    outputs: metadata.outputs.map(({
                        pdfPlacement: _pdfPlacement, ...output
                    }) => output),
                });
                const pageOverride = getScanCleanupPageOverride(
                    request.options.pageOverrides,
                    requirePageNumber(sourcePageNumber),
                    request.options.pageOverrideDefaults,
                    request.options.marginsMm,
                );
                if (metadata.excluded) {
                    summary.excludedPages += 1;
                    continue;
                }
                if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
                if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
                const outputs = (metadata.outputs ?? []).map(output => {
                    if (output.pdfPlacement === undefined) {
                        throw new Error(`evb-scan-cleanup returned no placement for page ${String(sourcePageNumber)}`);
                    }
                    return {
                        half: output.half,
                        placement: output.pdfPlacement,
                    };
                });
                if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') {
                    outputs.reverse();
                }
                analyzedPages.push({
                    sourcePageIndex: sourcePageNumber - 1,
                    rotationQuarterTurns: pageOverride.rotationDegrees / 90,
                    outputs,
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
    // A source that has no compact-layer probe is still a valid page raster
    // source. Only an explicit incomplete result proves that automatic source
    // budgeting cannot be trusted.
    const compactLayeredPageCountComplete = dpiSource.compactLayeredPageCountComplete !== false;
    const compactLayeredPageCount = dpiSource.compactLayeredPageCount ?? 0;
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
    const allOutputs = analyzedPages.flatMap(page => page.outputs.map(output => ({
        ...output,
        sourcePageIndex: page.sourcePageIndex,
        sourceDpi: page.sourceDpi,
        sourceRasterDetected: page.sourceRasterDetected,
    })));
    if (allOutputs.length === 0) {
        throw new Error('evb-scan-cleanup analysis produced no output pages');
    }
    if (documentCanvas === null && request.options.matchPageSize) {
        const droppedEvent = resolveScanCleanupDroppedMatchWarningEventFromAccumulator(canvasAccumulator);
        if (droppedEvent) warnEvent(droppedEvent);
    }
    const scaledRasterPages = new Set<number>();
    const fittedPageEvents: Parameters<typeof warnEvent>[] = [];
    for (const page of analyzedPages) {
        for (const {
            half, placement,
        } of page.outputs) {
            for (const event of placement.warningEvents ?? []) {
                fittedPageEvents.push([
                    event,
                    page.sourcePageIndex + 1,
                    half,
                ]);
            }
            if (placement.contentScaled && page.sourceRasterDetected) {
                scaledRasterPages.add(page.sourcePageIndex + 1);
            }
        }
    }
    if (scaledRasterPages.size > 0) {
        warnEvent({
            code: 'matched-canvas-pages-scaled-in-place',
            pages: [...scaledRasterPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    for (const fitted of fittedPageEvents) warnEvent(...fitted);
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
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
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
        ...(context.provenance === undefined
            ? {}
            : {reusableNativeBinarySha256s: context.provenance.nativeBinarySha256s}),
    });
    const stamp = buildScanCleanupProvenanceStamp({
        sourceSha256: context.provenance?.sourceSha256 ?? await sha256ScanCleanupFile(preparedPdfPath),
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
        outputs: page.outputs.map(({placement}) => ({
            cropRect: placement.cropRect,
            ...(placement.contentTransform ? {contentTransform: placement.contentTransform} : {}),
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
