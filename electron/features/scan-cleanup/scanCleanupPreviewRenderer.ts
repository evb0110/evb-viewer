import {
    isAbsolute,
    join,
} from 'path';
import type {
    IPdfMrcLayers,
    IDetectedPageRaster,
    IScanCleanupPageRasterSource,
} from '@evb/scan-cleanup/core/types';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import {
    DETECTION_DPI,
    PREVIEW_DPI,
    resolvePagePreviewDpi,
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
} from '@evb/scan-cleanup/core/detection';
import {
    attachScanCleanupPageOverrideDefaults,
    getScanCleanupPageOverride,
} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import { resolveScanCleanupEffectiveOutputMode } from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    formatScanCleanupWarningEvent,
    describeScanCleanupNativeWarnings,
} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import { resolveReusablePagePlan } from '@evb/scan-cleanup/core/policy/effectiveOptions';
import { buildRunnableNativeScanCleanupManifest } from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveScanCleanupProvisionalDocumentCanvasFromAccumulator,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import { shouldExtractTrustedMrcForeground } from '@evb/scan-cleanup/core/policy/scanCleanupRepresentationPolicy';


import { getErrorMessage } from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';
import type { TScanCleanupWarningEvent } from '@contracts/scan-cleanup/nativeProtocolV3';
import type {
    IBasePreviewAnalysis,
    IBoundedPreviewGeometry,
    IScanCleanupRenderingDependencies,
    IScanCleanupRenderingRetention,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    previewIdentityKey,
    DEFAULT_SOURCE_DPI,
    hasBoundedMatchedRasterResample,
    isScanCleanupSignalAborted,
    readBoundedPreviewGeometry,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    persistBaseAnalysisArtifacts,
    pruneBaseAnalysisCache,
    removeBaseAnalysisArtifacts,
    resolveFallbackDetailDpi,
    runDetailPreview,
    logScanCleanupMessage,
} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingPipeline';
import {readPreviewBytes} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';
const logger = createLogger('scan-cleanup-preview-renderer');

function baseAnalysisKey(
    request: Omit<IScanCleanupPreviewRequest, 'detail'>,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const {
        outputModeRecommendation: _outputModeRecommendation,
        softAlphaForegroundRecommendation: _softAlphaForegroundRecommendation,
        ...geometryRequest
    } = request;
    return JSON.stringify({
        identity: previewIdentityKey(geometryRequest),
        documentCanvas,
    });
}
export async function scanCleanupPreviewRenderer(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    retention: IScanCleanupRenderingRetention,
    baseAnalysisCache: Map<string, IBasePreviewAnalysis>,
    dependencies: IScanCleanupRenderingDependencies,
    emitRawRaster: (raw: IScanCleanupRawPreviewEvent) => void,
    managedScratchPath?: string,
    baseAnalysisPins: Map<string, number> = new Map(),
    scheduleBaseAnalysisRemoval?: (analysis: IBasePreviewAnalysis, analysisKey?: string) => Promise<void>,
    claimId?: string,
    releaseBaseAnalysisPin?: (analysisKey: string) => void,
    rasterMaxPixels?: number,
): Promise<TScanCleanupPreviewWireResult> {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup preview requires injected filesystem capabilities');
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    if (!dependencies.readFile) {
        throw new Error('Scan cleanup preview rendering requires an injected readFile capability');
    }
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    const document = await retention.openDocument(request, claimId);
    const scratch = managedScratchPath ?? await fileSystem.mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-preview-'))
        .catch(async (error: unknown) => {
            await retention.release(document, claimId);
            throw error;
        });
    let detailAnalysisKey: string | null = null;
    const claimedRasterPages = new Map<string, [number, number]>();
    const rememberRasterClaim = (pageNumber: number, dpi: number) => {
        if (claimId !== undefined) {
            claimedRasterPages.set(`${String(pageNumber)}\u0000${String(dpi)}`, [
                pageNumber,
                dpi,
            ]);
        }
    };
    try {
        const previewWarningEvents: TScanCleanupWarningEvent[] = [];
        const totalPages = await retention.pageCount(document, signal);
        let pageSizeStore: IPdfPageSizeStore | null = null;
        let pageSize: IPdfPageSize | undefined;
        let boundedGeometry: IBoundedPreviewGeometry | null = null;
        let previewRasterPlan = resolvePreviewRasterPlan(null, new Map<number, number>());
        try {
            pageSizeStore = await retention.pageSizeStore(document, signal);
            boundedGeometry = await readBoundedPreviewGeometry(
                pageSizeStore,
                totalPages,
                request,
            );
            pageSize = boundedGeometry.pageSize;
            const pageDpiByNumber = new Map<number, number>();
            if (boundedGeometry.pageSourceDpi !== undefined) {
                pageDpiByNumber.set(request.pageNumber, boundedGeometry.pageSourceDpi);
            }
            const renderDpiByPageNumber = new Map<number, number>();
            if (pageSize !== undefined) {
                renderDpiByPageNumber.set(
                    request.pageNumber,
                    resolvePagePreviewDpi(
                        pageSize,
                        Math.min(
                            PREVIEW_DPI,
                            boundedGeometry.pageSourceDpi ?? boundedGeometry.previewDpi,
                        ),
                    ),
                );
            }
            previewRasterPlan = {
                dpi: boundedGeometry.previewDpi,
                pageDpiByNumber,
                renderDpiByPageNumber,
            };
        } catch (error) {
            if (isScanCleanupSignalAborted(signal)) throw error;
            if (request.options.matchPageSize) {
                const detail = getErrorMessage(error);
                previewWarningEvents.push({
                    code: 'matched-canvas-geometry-unmeasured',
                    detail,
                });
                logger.warn(`Scan cleanup preview dropped matched page size: ${detail}`);
            } else {
                logger.debug(
                    `Scan cleanup preview kept the 150-DPI geometry fallback: ${getErrorMessage(error)}`,
                );
            }
        }
        let sourceDpiCandidate: number | null | undefined;
        if (!request.options.matchPageSize || request.detail !== undefined) {
            sourceDpiCandidate = await retention.sourceDpi(
                document,
                request.pageNumber,
                signal,
            );
        }
        if (!request.options.matchPageSize) {
            if (
                sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
            ) {
                const dpi = Math.min(PREVIEW_DPI, sourceDpiCandidate);
                const renderDpi = pageSize === undefined
                    ? dpi
                    : resolvePagePreviewDpi(pageSize, dpi);
                previewRasterPlan = {
                    dpi,
                    pageDpiByNumber: new Map([[
                        request.pageNumber,
                        sourceDpiCandidate,
                    ]]),
                    renderDpiByPageNumber: new Map([[
                        request.pageNumber,
                        renderDpi,
                    ]]),
                };
            }
        }
        const documentCanvas = request.options.matchPageSize
            ? boundedGeometry === null
                ? null
                : resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(
                    boundedGeometry.accumulator,
                    previewRasterPlan.dpi,
                    request.options,
                    request.layoutDetectionComplete === true,
                    rasterMaxPixels,
                )
            : null;
        let boundedRasterSource: IScanCleanupPageRasterSource | null = null;
        let boundedRasterPage: IDetectedPageRaster | undefined;
        let boundedRasterizedByMatching = false;
        if (pageSizeStore !== null) {
            boundedRasterSource = await retention.rasterPageSource(document, signal);
        }
        const matchingCanvas = request.options.preserveOriginalQuality === true
            && request.options.matchPageSize
            && boundedGeometry !== null
            ? documentCanvas
                ?? resolveScanCleanupDocumentCanvasFromAccumulator(
                    boundedGeometry.accumulator,
                    previewRasterPlan.dpi,
                    request.options,
                    request.layoutDetectionComplete === true,
                    rasterMaxPixels,
                )
            : null;
        if (
            request.options.preserveOriginalQuality === true
            && request.options.matchPageSize
            && matchingCanvas !== null
            && pageSizeStore !== null
            && boundedRasterSource !== null
        ) {
            boundedRasterizedByMatching = await hasBoundedMatchedRasterResample({
                canvas: matchingCanvas,
                layoutByPage: request.layoutByPage,
                options: request.options,
                pageSizeStore,
                rasterSource: boundedRasterSource,
            });
        }
        if (boundedRasterSource !== null) {
            boundedRasterPage = await boundedRasterSource.getPageRaster(request.pageNumber);
        }
        const pagePreviewRenderDpi = previewRasterPlan.renderDpiByPageNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        const basePreviewDpi = documentCanvas === null
            ? pagePreviewRenderDpi
            : Math.min(
                pagePreviewRenderDpi,
                Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(documentCanvas))),
            );
        const baseRaw = await retention.materializeRawRaster(
            document,
            request.pageNumber,
            signal,
            dependencies,
            totalPages,
            basePreviewDpi,
            pageSize,
            claimId,
        );
        rememberRasterClaim(request.pageNumber, baseRaw.dpi);
        const streamedRaw = request.detail === undefined;
        if (streamedRaw) {
            emitRawRaster({
                ownerId: request.ownerId,
                documentRevision: request.documentRevision,
                requestId: request.requestId,
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                rawImageData: baseRaw.bytes,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
            });
        }
        const rawImage = {};
        let inputPath = baseRaw.path;
        let renderDpi = basePreviewDpi;
        let requestedRenderDpi = basePreviewDpi;
        let sourceDpi = previewRasterPlan.pageDpiByNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        const sourceRasterDetected = boundedRasterPage !== undefined;
        sourceDpi = boundedRasterPage?.dpi ?? sourceDpi;
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        if (request.detail === undefined) {
            const outputMode = resolveScanCleanupEffectiveOutputMode({
                options: request.options,
                pageOverride,
                detectedOutputMode: request.outputModeRecommendation,
            });
            const requestedPreviewProcessingDpi = resolvePreviewProcessingDpi({
                displayDpi: basePreviewDpi,
                outputMode,
                sourceDpi,
            });
            const processingDocumentCanvas = documentCanvas !== null
                && requestedPreviewProcessingDpi > basePreviewDpi
                && boundedGeometry !== null
                ? resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(
                    boundedGeometry.accumulator,
                    requestedPreviewProcessingDpi,
                    request.options,
                    request.layoutDetectionComplete === true,
                    rasterMaxPixels,
                )
                : null;
            const previewProcessingDpi = processingDocumentCanvas === null
                ? requestedPreviewProcessingDpi
                : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(processingDocumentCanvas)));
            if (previewProcessingDpi !== basePreviewDpi) {
                ({path: inputPath} = await retention.materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    dependencies,
                    baseRaw.totalPages,
                    previewProcessingDpi,
                    pageSize,
                    claimId,
                ));
                rememberRasterClaim(request.pageNumber, previewProcessingDpi);
                renderDpi = previewProcessingDpi;
                requestedRenderDpi = previewProcessingDpi;
            }
        }
        let fallbackDetail = false;
        if (request.detail) {
            const {
                detail: _detail,
                ...baseRequest
            } = request;
            const analysisKey = baseAnalysisKey(baseRequest, documentCanvas);
            const analysis = baseAnalysisCache.get(analysisKey);
            if (analysis) {
                baseAnalysisCache.delete(analysisKey);
                baseAnalysisCache.set(analysisKey, analysis);
            }
            if (
                !analysis
                || analysis.sourceStatIdentity !== baseRaw.document.sourceStatIdentity
                || (
                    request.detail.outputMode !== 'mixed'
                    && analysis.outputMode !== request.detail.outputMode
                )
            ) {
                throw new Error(
                    'Scan cleanup detail geometry is unavailable; rebuild the base preview'
                    + ` (base mode ${analysis?.outputMode ?? 'unknown'}, detail ${JSON.stringify(request.detail)})`,
                );
            }
            baseAnalysisPins.set(analysisKey, (baseAnalysisPins.get(analysisKey) ?? 0) + 1);
            detailAnalysisKey = analysisKey;
            if (analysis.baseRenderDpi !== baseRaw.dpi) {
                ({path: inputPath} = await retention.materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    dependencies,
                    baseRaw.totalPages,
                    analysis.baseRenderDpi,
                    pageSize,
                    claimId,
                ));
                rememberRasterClaim(request.pageNumber, analysis.baseRenderDpi);
            }
            const detailRequest = request as IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>;};
            const hasManualZones = (pageOverride.manualZones?.picture.length ?? 0) > 0
                || (pageOverride.manualZones?.fill.length ?? 0) > 0;
            if (request.detail.outputMode !== 'mixed' && !hasManualZones) {
                return await runDetailPreview(
                    detailRequest,
                    signal,
                    baseRaw,
                    inputPath,
                    analysis,
                    sourceDpiCandidate,
                    sourceRasterDetected,
                    scratch,
                    dependencies,
                    rasterMaxPixels,
                );
            }
            fallbackDetail = true;
            sourceDpi = sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
                ? sourceDpiCandidate
                : DEFAULT_SOURCE_DPI;
            ({
                renderDpi,
                requestedRenderDpi,
            } = resolveFallbackDetailDpi(
                detailRequest,
                baseRaw,
                sourceDpi,
                sourceRasterDetected,
                documentCanvas,
            ));
            if (renderDpi !== baseRaw.dpi) {
                ({path: inputPath} = await retention.materializeRawRasterPath(
                    document,
                    request.pageNumber,
                    signal,
                    dependencies,
                    baseRaw.totalPages,
                    renderDpi,
                    pageSize,
                    claimId,
                ));
                rememberRasterClaim(request.pageNumber, renderDpi);
            }
        }
        if (isScanCleanupSignalAborted(signal)) throw signal.reason;
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const canonicalRaw = baseRaw.dpi === DETECTION_DPI
            ? baseRaw
            : await retention.materializeRawRasterPath(
                document,
                request.pageNumber,
                signal,
                dependencies,
                baseRaw.totalPages,
                DETECTION_DPI,
                pageSize,
                claimId,
            );
        if (canonicalRaw !== baseRaw) rememberRasterClaim(request.pageNumber, DETECTION_DPI);
        const outputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(scratch, `clean-${index}.png`),
            metadataPath: join(scratch, `clean-${index}.json`),
        }));
        const manifestPath = join(scratch, 'manifest.json');
        const pageMetadataPath = join(scratch, 'page.json');
        const reusablePagePlan = resolveReusablePagePlan(
            request.options,
            request.layoutByPage,
            request.pagePlanEvidence === undefined
                ? undefined
                : {[String(request.pageNumber)]: request.pagePlanEvidence},
            request.pageNumber,
        );
        const rasterizedByMatching = boundedRasterizedByMatching;
        const lossless = request.options.preserveOriginalQuality === true && !rasterizedByMatching;
        const matchedCanvas = documentCanvas ?? undefined;
        const effectiveOptions = (matchedCanvas === undefined && request.options.matchPageSize)
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        const sourceBackgroundDpi = boundedRasterPage?.backgroundDpi;
        const sourceHasBilevelLayer = boundedRasterPage?.hasBilevelLayer === true;
        let trustedMrcLayers: IPdfMrcLayers | null = null;
        if (
            shouldExtractTrustedMrcForeground(
                request.options.outputMode,
                pageOverride.outputModeOverride,
            )
            && request.options.thickness === 0
            && request.options.autoDewarp !== true
            && pageOverride.rotationDegrees === 0
            && (pageOverride.manualZones?.picture.length ?? 0) === 0
            && (pageOverride.manualZones?.fill.length ?? 0) === 0
            && sourceHasBilevelLayer
            && dependencies.extractMrcLayers !== undefined
        ) {
            const extractionStartedAt = performance.now();
            try {
                trustedMrcLayers = await dependencies.extractMrcLayers(
                    document.sourcePdfPath,
                    request.pageNumber,
                    join(scratch, 'source-mrc-selection.png'),
                    join(scratch, 'source-mrc-background.png'),
                    signal,
                    logScanCleanupMessage,
                );
                logger.debug(
                    `Scan cleanup preview source-layer extraction page ${String(request.pageNumber)} `
                    + `reused=${String(trustedMrcLayers !== null)} `
                    + `durationMs=${(performance.now() - extractionStartedAt).toFixed(0)}`,
                );
            } catch (error) {
                signal.throwIfAborted();
                logger.warn(
                    `Scan cleanup preview could not reuse page ${String(request.pageNumber)}'s `
                    + `compact MRC foreground; using raster reconstruction (${getErrorMessage(error)})`,
                );
            }
        }
        const manifest = buildRunnableNativeScanCleanupManifest({
            operation: lossless ? 'analyze' : 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: lossless ? 'lossless' : 'raster',
            options: effectiveOptions,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            ...(matchedCanvas === undefined ? {} : {documentCanvas: matchedCanvas}),
            ...(rasterMaxPixels === undefined ? {} : {rasterMaxPixels}),
            pages: [{
                inputPath: lossless ? canonicalRaw.path : inputPath,
                analysisInputPath: canonicalRaw.path,
                analysisDpi: DETECTION_DPI,
                ...(trustedMrcLayers === null
                    ? {}
                    : {
                        trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                        trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                    }),
                pageNumber: request.pageNumber,
                dpi: lossless ? DETECTION_DPI : renderDpi,
                sourceDpi,
                sourceHasBilevelLayer,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                requestedRenderDpi,
                ...(request.detail === undefined
                    ? (request.outputModeRecommendation === undefined
                        ? {}
                        : {resolvedOutputMode: request.outputModeRecommendation})
                    : {resolvedOutputMode: request.detail.outputMode}),
                ...(request.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {preferSoftAlphaForeground: request.softAlphaForegroundRecommendation}),
                ...(request.layoutByPage?.[String(request.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(request.pageNumber)]}),
                ...reusablePagePlan,
                ...(request.placementAnchors === undefined
                    ? {}
                    : {placementAnchors: request.placementAnchors}),
                pageMetadataPath,
                outputs,
                ...(request.documentPrior === undefined ? {} : {documentPrior: request.documentPrior}),
                ...(!lossless || pageSize === undefined ? {} : {pdfPage: {
                    xPoints: pageSize.xPoints,
                    yPoints: pageSize.yPoints,
                    widthPoints: pageSize.widthPoints,
                    heightPoints: pageSize.heightPoints,
                    rotation: pageSize.rotation,
                    sourceDpi,
                }}),
            }],
            allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir(),
        });
        await fileSystem.writeFile(manifestPath, JSON.stringify(manifest));
        await dependencies.runSidecar(
            binary,
            manifestPath,
            signal,
            logScanCleanupMessage,
            () => undefined,
            {allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir()},
        );
        const pageMetadata = decodeNativeScanCleanupPreviewPageMetadataJson(
            String(await dependencies.readFile(pageMetadataPath, 'utf8')),
        );
        if (lossless) {
            const analyzedOutputs = pageMetadata.outputs ?? [];
            return {
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                ...rawImage,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
                pageMetadata: {
                    ...pageMetadata,
                    outputDiagnostics: analyzedOutputs.map(output => ({
                        half: output.half,
                        ...(output.contentDiagnostics === undefined
                            ? {}
                            : {contentDiagnostics: output.contentDiagnostics}),
                        ...(output.textToneDiagnostics === undefined
                            ? {}
                            : {textToneDiagnostics: output.textToneDiagnostics}),
                    })),
                },
                outputs: analyzedOutputs.map(output => {
                    const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
                    const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
                    // Without page geometry there is no canvas to place on: the
                    // output is its own crop, exactly as the assembler writes it.
                    const placement = output.pdfPlacement?.preview ?? {
                        canvasWidthPx: outputWidthPx,
                        canvasHeightPx: outputHeightPx,
                        contentWidthPx: outputWidthPx,
                        contentHeightPx: outputHeightPx,
                        offsetXPx: 0,
                        offsetYPx: 0,
                        margins: {
                            leftPx: 0,
                            topPx: 0,
                            rightPx: 0,
                            bottomPx: 0,
                        },
                        canvasOverflow: false,
                    };
                    return {
                        imageData: baseRaw.bytes,
                        metadata: {
                            half: output.half,
                            layoutClassification: pageMetadata.layoutClassification,
                            layoutConfidence: pageMetadata.layoutConfidence,
                            sourceRegion: output.sourceRegion,
                            contentBox: output.contentBox,
                            cropRect: output.cropRect,
                            ...(output.contentDiagnostics === undefined
                                ? {}
                                : {contentDiagnostics: output.contentDiagnostics}),
                            appliedMargins: placement.margins,
                            outputWidthPx,
                            outputHeightPx,
                            canvasWidthPx: placement.canvasWidthPx,
                            canvasHeightPx: placement.canvasHeightPx,
                            placementOffsetXPx: placement.offsetXPx,
                            placementOffsetYPx: placement.offsetYPx,
                            forwardTransform: null,
                            cutterXPx: pageMetadata.cutterXPx,
                            inputWidthPx: output.inputWidthPx,
                            inputHeightPx: output.inputHeightPx,
                            rotationDegrees: pageMetadata.rotationDegrees,
                            canvasScope: 'page',
                            resamplePasses: 0,
                            sourceDpi,
                            renderDpi,
                            requestedRenderDpi,
                            rasterScaleLimited: false,
                            canvasPolicy: matchedCanvas === undefined ? 'intrinsic' : 'strict-maximum',
                            canvasOverflow: placement.canvasOverflow,
                            matchedCanvasTargetWidthPx: matchedCanvas === undefined ? null : placement.canvasWidthPx,
                            matchedCanvasTargetHeightPx: matchedCanvas === undefined ? null : placement.canvasHeightPx,
                            matchedCanvasTargetWidthPoints: matchedCanvas?.widthPoints ?? null,
                            matchedCanvasTargetHeightPoints: matchedCanvas?.heightPoints ?? null,
                            matchedCanvasContentWidthPx: placement.contentWidthPx,
                            matchedCanvasContentHeightPx: placement.contentHeightPx,
                            warnings: [
                                ...previewWarningEvents,
                                ...output.pdfPlacement?.warningEvents ?? [],
                            ].map(event => formatScanCleanupWarningEvent(event)),
                        },
                    };
                }),
            };
        }
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        const nativeOutputs: IBasePreviewAnalysis['outputs'] = {};
        const canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>> = {};
        let canonicalRasterBytes = 0;
        for (const output of outputs) {
            try {
                const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(
                    String(await dependencies.readFile(output.metadataPath, 'utf8')),
                );
                nativeOutputs[nativeMetadata.half] = nativeMetadata;
                const imageData = await readPreviewBytes(output.outputPath, dependencies);
                canonicalRasters[nativeMetadata.half] = imageData;
                canonicalRasterBytes += imageData.byteLength;
                cleaned.push({
                    imageData,
                    metadata: {
                        ...nativeMetadata,
                        ...(nativeMetadata.dewarpModel === undefined
                            ? {}
                            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
                        warnings: [
                            ...[
                                ...previewWarningEvents,
                                ...nativeMetadata.warningEvents ?? [],
                            ].map(event => formatScanCleanupWarningEvent(event)),
                            ...describeScanCleanupNativeWarnings({warnings: nativeMetadata.warnings}),
                        ],
                    },
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        const diagnosticMetadata = cleaned[0]?.metadata;
        const result: TScanCleanupPreviewWireResult = {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            ...rawImage,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: {
                ...pageMetadata,
                ...(diagnosticMetadata?.detectedSkewDegrees === undefined
                    ? {}
                    : {detectedSkewDegrees: diagnosticMetadata.detectedSkewDegrees}),
                ...(diagnosticMetadata?.skewConfidence === undefined
                    ? {}
                    : {skewConfidence: diagnosticMetadata.skewConfidence}),
                ...(diagnosticMetadata?.manualSkew === undefined
                    ? {}
                    : {manualSkew: diagnosticMetadata.manualSkew}),
                ...(diagnosticMetadata?.binarizationMode === undefined
                    ? {}
                    : {binarizationMode: diagnosticMetadata.binarizationMode}),
                ...(diagnosticMetadata?.binarizationDiagnostics === undefined
                    ? {}
                    : {binarizationDiagnostics: diagnosticMetadata.binarizationDiagnostics}),
                ...(diagnosticMetadata?.textToneDiagnostics === undefined
                    ? {}
                    : {textToneDiagnostics: diagnosticMetadata.textToneDiagnostics}),
                ...(diagnosticMetadata?.despeckleFallback === undefined
                    ? {}
                    : {despeckleFallback: diagnosticMetadata.despeckleFallback}),
                ...(diagnosticMetadata?.dewarpConfidence === undefined
                    ? {}
                    : {dewarpConfidence: diagnosticMetadata.dewarpConfidence}),
                ...(diagnosticMetadata?.dewarpApplied === undefined
                    ? {}
                    : {dewarpApplied: diagnosticMetadata.dewarpApplied}),
                outputDiagnostics: cleaned.map(output => ({
                    half: output.metadata.half,
                    ...(output.metadata.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: output.metadata.contentDiagnostics}),
                    ...(output.metadata.textToneDiagnostics === undefined
                        ? {}
                        : {textToneDiagnostics: output.metadata.textToneDiagnostics}),
                })),
                autoDewarpAttempted: request.options.autoDewarp === true,
            },
            outputs: cleaned,
        };
        if (!fallbackDetail) {
            signal.throwIfAborted();
            const analysisKey = baseAnalysisKey(request, documentCanvas);
            const artifacts = await persistBaseAnalysisArtifacts(
                nativeOutputs,
                canonicalRasters,
                signal,
                dependencies,
            );
            const previous = baseAnalysisCache.get(analysisKey);
            if (previous) {
                baseAnalysisCache.delete(analysisKey);
                const removePrevious = scheduleBaseAnalysisRemoval
                    ?? ((analysis: IBasePreviewAnalysis) => removeBaseAnalysisArtifacts(analysis, dependencies));
                void removePrevious(previous, analysisKey);
            }
            baseAnalysisCache.set(analysisKey, {
                sourcePdfPath: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                sourceStatIdentity: baseRaw.document.sourceStatIdentity,
                ...(result.outputs[0]?.metadata.outputMode === undefined
                    ? {}
                    : {outputMode: result.outputs[0].metadata.outputMode}),
                pageMetadata: result.pageMetadata,
                outputs: nativeOutputs,
                ...artifacts,
                canonicalRasterBytes,
                baseRenderDpi: renderDpi,
            });
            await pruneBaseAnalysisCache(
                baseAnalysisCache,
                new Set(baseAnalysisPins.keys()),
                dependencies,
            );
        }
        return result;
    } finally {
        if (detailAnalysisKey !== null) {
            if (releaseBaseAnalysisPin) releaseBaseAnalysisPin(detailAnalysisKey);
            else {
                const pins = baseAnalysisPins.get(detailAnalysisKey) ?? 0;
                if (pins <= 1) baseAnalysisPins.delete(detailAnalysisKey);
                else baseAnalysisPins.set(detailAnalysisKey, pins - 1);
            }
        }
        await Promise.all([...claimedRasterPages.values()].map(([
            pageNumber,
            dpi,
        ]) => retention.releaseRaster(
            document,
            pageNumber,
            dpi,
            claimId,
        )));
        await retention.release(document, claimId);
        if (managedScratchPath === undefined) {
            await fileSystem.rm(scratch, {
                recursive: true,
                force: true,
            });
        }
    }
}
