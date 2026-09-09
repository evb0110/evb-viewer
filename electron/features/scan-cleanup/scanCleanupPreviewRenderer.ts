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
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
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
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPlacementOffset,
} from '@contracts/scanCleanupPageOverrides';
import { resolveScanCleanupEffectiveOutputMode } from '@contracts/electronApiScanCleanup';
import {
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    formatScanCleanupWarningEvent,
    describeScanCleanupNativeWarnings,
    toScanCleanupPercentTenths,
} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import { resolveReusablePagePlan } from '@evb/scan-cleanup/core/policy/effectiveOptions';
import { buildRunnableNativeScanCleanupManifest } from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    isScanCleanupPaperLargerThanCanvas,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvasDpi,
    resolveScanCleanupOutputPageRect,
    resolveScanCleanupOutputPaperPixels,
    resolveScanCleanupCanvasGridAtDpi,
    CANVAS_CONTENT_SCALE_EPSILON,
    resolveScanCleanupProvisionalDocumentCanvas,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    resolveMatchedCanvasResamplePages,
    fitScanCleanupMarginAxisPx,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
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
    DEFAULT_SOURCE_DPI,
    PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES,
    hasBoundedMatchedRasterResample,
    isScanCleanupSignalAborted,
    readBoundedPreviewGeometry,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {baseAnalysisKey} from '@electron/features/scan-cleanup/scanCleanupPreviewSupport';
import {
    persistBaseAnalysisArtifacts,
    pruneBaseAnalysisCache,
    readPreviewBytes,
    removeBaseAnalysisArtifacts,
    resolveFallbackDetailDpi,
    runDetailPreview,
    logScanCleanupMessage,
} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingPipeline';
const logger = createLogger('scan-cleanup-preview-renderer');
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
        const legacyGeometry = dependencies.getPageSizeStore === undefined;
        if (legacyGeometry && totalPages > PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES) {
            throw new Error(
                'Scan cleanup preview requires a bounded page-size store for large documents',
            );
        }
        let compatibilityPageSizes: IPdfPageSize[] | null = null;
        let pageSizeStore: IPdfPageSizeStore | null = null;
        let pageSize: IPdfPageSize | undefined;
        let boundedGeometry: IBoundedPreviewGeometry | null = null;
        let previewRasterPlan = resolvePreviewRasterPlan(null, new Map<number, number>());
        try {
            if (legacyGeometry) {
                compatibilityPageSizes = await retention.previewPageSizes(document, signal);
                pageSize = compatibilityPageSizes.find(candidate => candidate.pageNumber === request.pageNumber);
                previewRasterPlan = resolvePreviewRasterPlan(compatibilityPageSizes);
            } else {
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
            }
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
            ? legacyGeometry && compatibilityPageSizes !== null
                ? resolveScanCleanupProvisionalDocumentCanvas(
                    compatibilityPageSizes,
                    previewRasterPlan.dpi,
                    request.options,
                    request.layoutByPage,
                    request.layoutDetectionComplete === true,
                )
                : boundedGeometry === null
                    ? null
                    : resolveScanCleanupDocumentCanvasFromAccumulator(
                        boundedGeometry.accumulator,
                        previewRasterPlan.dpi,
                        request.options,
                        request.layoutDetectionComplete === true,
                    )
            : null;
        let boundedRasterSource: IScanCleanupPageRasterSource | null = null;
        let boundedRasterPage: IDetectedPageRaster | undefined;
        let boundedRasterizedByMatching = false;
        if (!legacyGeometry) {
            boundedRasterSource = await retention.rasterPageSource(document, signal);
            boundedRasterPage = await boundedRasterSource.getPageRaster(request.pageNumber);
            if (
                request.options.preserveOriginalQuality === true
                && request.options.matchPageSize
                && documentCanvas !== null
                && pageSizeStore !== null
            ) {
                boundedRasterizedByMatching = await hasBoundedMatchedRasterResample({
                    canvas: documentCanvas,
                    layoutByPage: request.layoutByPage,
                    options: request.options,
                    pageSizeStore,
                    rasterSource: boundedRasterSource,
                });
            }
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
        const rasterPages = request.options.preserveOriginalQuality === true
            && request.options.matchPageSize
            && compatibilityPageSizes?.length
            ? await retention.previewRasterPages(document, signal)
            : null;
        const sourceRasterPage = legacyGeometry
            ? rasterPages ?? await retention.rasterPage(document, request.pageNumber, signal)
            : null;
        const sourceRasterDetected = legacyGeometry
            ? sourceRasterPage!.pages.has(request.pageNumber)
            : boundedRasterPage !== undefined;
        sourceDpi = legacyGeometry
            ? sourceRasterPage!.sourceDpiByPage?.get(request.pageNumber) ?? sourceDpi
            : boundedRasterPage?.dpi ?? sourceDpi;
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
                ? legacyGeometry && compatibilityPageSizes !== null
                    ? resolveScanCleanupProvisionalDocumentCanvas(
                        compatibilityPageSizes,
                        requestedPreviewProcessingDpi,
                        request.options,
                        request.layoutByPage,
                        request.layoutDetectionComplete === true,
                    )
                    : boundedGeometry === null
                        ? null
                        : resolveScanCleanupDocumentCanvasFromAccumulator(
                            boundedGeometry.accumulator,
                            requestedPreviewProcessingDpi,
                            request.options,
                            request.layoutDetectionComplete === true,
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
        const rasterizedByMatching = legacyGeometry
            ? compatibilityPageSizes !== null
                && rasterPages !== null
                && resolveMatchedCanvasResamplePages(
                    compatibilityPageSizes,
                    compatibilityPageSizes.map(pageSize => pageSize.pageNumber),
                    request.options,
                    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                    rasterPages.pages,
                    rasterPages.detected,
                    request.layoutByPage,
                ).length > 0
            : boundedRasterizedByMatching;
        const lossless = request.options.preserveOriginalQuality === true && !rasterizedByMatching;
        const matchedCanvas = documentCanvas ?? undefined;
        const effectiveOptions = (matchedCanvas === undefined && request.options.matchPageSize)
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        const sourceBackgroundDpi = legacyGeometry
            ? sourceRasterPage!.backgroundDpiByPage?.get(request.pageNumber)
            : boundedRasterPage?.backgroundDpi;
        const sourceHasBilevelLayer = legacyGeometry
            ? sourceRasterPage!.bilevelLayerPages?.has(request.pageNumber) === true
            : boundedRasterPage?.hasBilevelLayer === true;
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
            }],
            allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir(),
        });
        await fileSystem.writeFile(manifestPath, JSON.stringify(manifest));
        const sidecarCapabilities = await dependencies.runSidecar(
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
            const canvasGridDpi = matchedCanvas === undefined
                ? renderDpi
                : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(matchedCanvas)));
            const previewCanvasGrid = matchedCanvas === undefined
                ? null
                : resolveScanCleanupCanvasGridAtDpi(matchedCanvas, canvasGridDpi);
            const canvasWidthPx = previewCanvasGrid?.widthPx ?? null;
            const canvasHeightPx = previewCanvasGrid?.heightPx ?? null;
            const previewPageSize = pageSize;
            const marginsMm = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
            const requestedMargins = matchedCanvas === undefined
                ? {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                }
                : {
                    leftPx: Math.max(0, Math.round(marginsMm.leftMm / 25.4 * canvasGridDpi)),
                    topPx: Math.max(0, Math.round(marginsMm.topMm / 25.4 * canvasGridDpi)),
                    rightPx: Math.max(0, Math.round(marginsMm.rightMm / 25.4 * canvasGridDpi)),
                    bottomPx: Math.max(0, Math.round(marginsMm.bottomMm / 25.4 * canvasGridDpi)),
                };
            const marginsRequested = Object.values(requestedMargins).some(margin => margin > 0);
            const plannedOutputs = analyzedOutputs.map(output => {
                const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
                const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
                const resolvedCanvasWidth = canvasWidthPx ?? outputWidthPx;
                const resolvedCanvasHeight = canvasHeightPx ?? outputHeightPx;
                const marginsAvailable = request.options.crop;
                const appliedMargins = matchedCanvas === undefined
                    ? output.appliedMargins
                    : marginsAvailable ? requestedMargins : {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    };
                const [
                    marginLeft,
                    marginRight,
                ] = fitScanCleanupMarginAxisPx(appliedMargins.leftPx, appliedMargins.rightPx, resolvedCanvasWidth);
                const [
                    marginTop,
                    marginBottom,
                ] = fitScanCleanupMarginAxisPx(appliedMargins.topPx, appliedMargins.bottomPx, resolvedCanvasHeight);
                const deliveredMargins = {
                    leftPx: marginLeft,
                    topPx: marginTop,
                    rightPx: marginRight,
                    bottomPx: marginBottom,
                };
                const innerCanvasWidth = Math.max(1, resolvedCanvasWidth - marginLeft - marginRight);
                const innerCanvasHeight = Math.max(1, resolvedCanvasHeight - marginTop - marginBottom);
                const outputPaper = resolveScanCleanupOutputPaperPixels({
                    half: output.half,
                    inputWidthPx: output.inputWidthPx,
                    inputHeightPx: output.inputHeightPx,
                    rotationDegrees: pageMetadata.rotationDegrees,
                });
                const paperPoints = previewPageSize === undefined
                    ? null
                    : resolveScanCleanupOutputPageRect(
                        previewPageSize,
                        output.half === 'full' ? 1 : 2,
                    );
                const paperScale = canvasWidthPx === null || canvasHeightPx === null
                    ? 1
                    : resolveScanCleanupCanvasFitScale({
                        widthPoints: canvasWidthPx,
                        heightPoints: canvasHeightPx,
                    }, {
                        widthPoints: Math.max(1, outputPaper.widthPx),
                        heightPoints: Math.max(1, outputPaper.heightPx),
                    });
                const paperLargerThanCanvas = matchedCanvas !== undefined
                    && previewCanvasGrid !== null
                    && paperPoints !== null
                    && isScanCleanupPaperLargerThanCanvas({
                        ...matchedCanvas,
                        ...previewCanvasGrid,
                    }, paperPoints);
                const contentScale = paperScale * Math.min(1, resolveScanCleanupCanvasFitScale({
                    widthPoints: innerCanvasWidth,
                    heightPoints: innerCanvasHeight,
                }, {
                    widthPoints: Math.max(1, outputWidthPx * paperScale),
                    heightPoints: Math.max(1, outputHeightPx * paperScale),
                }));
                return {
                    appliedMargins,
                    contentScale,
                    deliveredMargins,
                    innerCanvasHeight,
                    innerCanvasWidth,
                    marginLeft,
                    marginTop,
                    marginsAvailable,
                    output,
                    outputHeightPx,
                    outputWidthPx,
                    paperLargerThanCanvas,
                    paperScale,
                    resolvedCanvasHeight,
                    resolvedCanvasWidth,
                };
            });
            const spreadContentScale = plannedOutputs.length === 2
                && plannedOutputs.some(({output}) => output.half === 'left')
                && plannedOutputs.some(({output}) => output.half === 'right')
                ? Math.min(...plannedOutputs.map(({contentScale}) => contentScale))
                : null;
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
                outputs: plannedOutputs.map(({
                    appliedMargins,
                    contentScale: leafContentScale,
                    deliveredMargins,
                    innerCanvasHeight,
                    innerCanvasWidth,
                    marginLeft,
                    marginTop,
                    marginsAvailable,
                    output,
                    outputHeightPx,
                    outputWidthPx,
                    paperLargerThanCanvas,
                    paperScale,
                    resolvedCanvasHeight,
                    resolvedCanvasWidth,
                }) => {
                    const contentScale = spreadContentScale ?? leafContentScale;
                    const contentWidthPx = Math.min(
                        innerCanvasWidth,
                        Math.max(1, Math.round(outputWidthPx * contentScale)),
                    );
                    const contentHeightPx = Math.min(
                        innerCanvasHeight,
                        Math.max(1, Math.round(outputHeightPx * contentScale)),
                    );
                    const canvasOverflow = contentScale < paperScale * (1 - CANVAS_CONTENT_SCALE_EPSILON);
                    const placementAnchor = request.placementAnchors?.[output.half];
                    const placement = resolveScanCleanupPlacementOffset(
                        innerCanvasWidth - contentWidthPx,
                        innerCanvasHeight - contentHeightPx,
                        pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment,
                        placementAnchor === undefined
                            ? undefined
                            : {
                                anchor: placementAnchor,
                                contentHeight: contentHeightPx,
                            },
                    );
                    return {
                        imageData: baseRaw.bytes,
                        metadata: {
                            half: output.half,
                            layoutClassification: pageMetadata.layoutClassification,
                            layoutConfidence: pageMetadata.layoutConfidence ?? 0,
                            sourceRegion: output.sourceRegion,
                            contentBox: output.contentBox,
                            cropRect: output.cropRect,
                            ...(output.contentDiagnostics === undefined
                                ? {}
                                : {contentDiagnostics: output.contentDiagnostics}),
                            appliedMargins: deliveredMargins,
                            outputWidthPx,
                            outputHeightPx,
                            canvasWidthPx: resolvedCanvasWidth,
                            canvasHeightPx: resolvedCanvasHeight,
                            placementOffsetXPx: marginLeft + Math.floor(placement.x),
                            placementOffsetYPx: marginTop + Math.floor(placement.y),
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
                            canvasOverflow,
                            matchedCanvasTargetWidthPx: canvasWidthPx,
                            matchedCanvasTargetHeightPx: canvasHeightPx,
                            matchedCanvasTargetWidthPoints: matchedCanvas?.widthPoints ?? null,
                            matchedCanvasTargetHeightPoints: matchedCanvas?.heightPoints ?? null,
                            matchedCanvasContentWidthPx: contentWidthPx,
                            matchedCanvasContentHeightPx: contentHeightPx,
                            warnings: [
                                ...previewWarningEvents,
                                ...(matchedCanvas !== undefined && marginsRequested && !marginsAvailable
                                    ? [{code: 'matched-canvas-margins-unavailable'} as const]
                                    : []),
                                ...(deliveredMargins.leftPx !== appliedMargins.leftPx
                                    || deliveredMargins.topPx !== appliedMargins.topPx
                                    || deliveredMargins.rightPx !== appliedMargins.rightPx
                                    || deliveredMargins.bottomPx !== appliedMargins.bottomPx
                                    ? [{code: 'matched-canvas-margins-reduced'} as const]
                                    : []),
                                ...(paperLargerThanCanvas
                                    ? [{
                                        code: 'matched-canvas-paper-downscaled',
                                        unit: 'px',
                                        scalePercentTenths: toScanCleanupPercentTenths(paperScale * 100),
                                        documentCanvasWidth: resolvedCanvasWidth,
                                        documentCanvasHeight: resolvedCanvasHeight,
                                    } as const]
                                    : []),
                                ...(canvasOverflow
                                    ? [{
                                        code: 'matched-canvas-content-fitted',
                                        unit: 'px',
                                        contentWidth: contentWidthPx,
                                        contentHeight: contentHeightPx,
                                        innerWidth: innerCanvasWidth,
                                        innerHeight: innerCanvasHeight,
                                        documentCanvasWidth: resolvedCanvasWidth,
                                        documentCanvasHeight: resolvedCanvasHeight,
                                    } as const]
                                    : []),
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
                                ...(sidecarCapabilities?.structuredWarningEventsSupported === true
                                    ? nativeMetadata.warningEvents ?? []
                                    : []),
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
