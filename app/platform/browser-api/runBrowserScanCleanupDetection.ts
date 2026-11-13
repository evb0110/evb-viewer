import type {IScanCleanupDetectionRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {INativeScanCleanupPageMetadataV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {getErrorMessage} from '@app/utils/error';
import {
    detectPageRasterFromPageSize,
    type IPdfPageSize,
    type IScanCleanupDetectionResultStore,
} from '@evb/scan-cleanup/core/types';
import {
    createScanCleanupDetectionRecorder,
    type IScanCleanupDetectionOutcome,
    type TScanCleanupDetectionPublish,
} from '@evb/scan-cleanup/core/createScanCleanupDetectionRecorder';
import {deriveScanCleanupAnalysisVerdict} from '@evb/scan-cleanup/core/policy/scanCleanupDetectionResultPolicy';
import {
    DETECTION_DPI,
    describeScanCleanupAlternateView,
    resolveScanCleanupAnalysisDpi,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
    toCropBoxPageSize,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {
    resolveScanCleanupManifestPageOptions,
    type IScanCleanupManifestPageFacts,
} from '@evb/scan-cleanup/core/policy/scanCleanupManifestPagePolicy';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
} from '@evb/scan-cleanup/core/pageBatches';
import {resolveScanCleanupPageScopeLazy} from '@evb/scan-cleanup/core/pageScope';
import {
    renderPageRaster,
    runBrowserScanCleanupAnalysis,
    sourceLayerFacts,
    type IBrowserScanCleanupSource,
} from '@app/platform/browser-api/browserScanCleanupJob';

export interface IRunBrowserScanCleanupDetectionInput {
    request: IScanCleanupDetectionRequest;
    source: IBrowserScanCleanupSource;
    resultStore: IScanCleanupDetectionResultStore;
    signal: AbortSignal;
    publish: TScanCleanupDetectionPublish;
}

/**
 * Detects every page's layout, content and recommended mode as desktop
 * detection does, with the browser's rasters and engine: each batch is one
 * analyze manifest whose sequence the engine plans, reading each page's
 * CropBox raster at its canonical analysis resolution and, when it asks, its
 * MediaBox view. The shared recorder turns the verdicts into the results and
 * progress desktop publishes.
 */
export async function runBrowserScanCleanupDetection({
    request,
    source,
    resultStore,
    signal,
    publish,
}: IRunBrowserScanCleanupDetectionInput): Promise<IScanCleanupDetectionOutcome> {
    const totalPages = source.pageSizes.length;
    const recorder = createScanCleanupDetectionRecorder({
        request,
        totalPages,
        resultStore,
        signal,
        publish,
    });
    try {
        // The page records stand in for desktop's image probe: a page's scan
        // resolution is its dominant image's, and the document's the finest.
        let documentDpi = 0;
        for (const page of source.pageSizes) {
            documentDpi = Math.max(documentDpi, detectPageRasterFromPageSize(page)?.dpi ?? 0);
        }
        const pageSourceDpi = (page: IPdfPageSize) => detectPageRasterFromPageSize(page)?.dpi
            ?? (documentDpi > 0 ? documentDpi : undefined);
        for (const rawPage of source.pageSizes) {
            signal.throwIfAborted();
            const page = toCropBoxPageSize(rawPage);
            recorder.addGeometryPage(page, pageSourceDpi(page));
        }
        recorder.sealGeometry();

        const resolveOptions = (facts: IScanCleanupManifestPageFacts) => resolveScanCleanupManifestPageOptions({
            options: request.options,
            analysisPurpose: 'page-plan',
            qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            page: facts,
        });
        const rasterize = (view: IPdfPageSize, dpi: number) => renderPageRaster(source, view, dpi, SCAN_CLEANUP_RASTER_MAX_PIXELS, signal);

        const pageScope = resolveScanCleanupPageScopeLazy(undefined, totalPages);
        for (const batch of iterateScanCleanupPageBatches(pageScope.length, SCAN_CLEANUP_STREAMING_BATCH_PAGES)) {
            signal.throwIfAborted();
            const batchRecorder = recorder.beginBatch(batch);
            const pages = collectScanCleanupPageScopeBatch(pageScope, batch).map(pageNumber => {
                const view = toCropBoxPageSize(source.pageSizes[pageNumber - 1]!);
                const dpi = resolveScanCleanupAnalysisDpi(view);
                const facts: IScanCleanupManifestPageFacts = {
                    pageNumber,
                    dpi,
                    sourceDpi: pageSourceDpi(view) ?? dpi,
                    facingPairGeometry: recorder.isFacingPair(view),
                    ...sourceLayerFacts(source, pageNumber),
                };
                return {
                    pageNumber,
                    view,
                    dpi,
                    facts,
                    alternate: describeScanCleanupAlternateView(view, facts),
                };
            });
            let analyzedPages = 0;
            const verdictInput = (pageNumber: number, view: IPdfPageSize, metadata: INativeScanCleanupPageMetadataV3, completedPages: number) => ({
                sourcePageNumber: pageNumber,
                verdict: deriveScanCleanupAnalysisVerdict(metadata),
                completedPages,
                read: () => Promise.resolve({
                    sourcePage: view,
                    // A MediaBox view is only reproducible with its geometry recorded.
                    sourceDpi: metadata.alternateView === true ? pageSourceDpi(view) ?? DETECTION_DPI : pageSourceDpi(view),
                    metadata,
                }),
            });
            const finished = await runBrowserScanCleanupAnalysis({
                pages: pages.map(page => ({
                    options: resolveOptions(page.facts),
                    sourcePageIndex: page.pageNumber - 1,
                    ...(page.alternate === undefined
                        ? {}
                        : {alternateView: {
                            primaryWidthPoints: page.alternate.input.primaryWidthPoints,
                            primaryHeightPoints: page.alternate.input.primaryHeightPoints,
                            widthPoints: page.alternate.input.widthPoints,
                            heightPoints: page.alternate.input.heightPoints,
                            options: resolveOptions(page.alternate.input.page),
                        }}),
                })),
                canvasScope: 'page',
                analysisPurpose: 'page-plan',
                renderMode: 'preview',
                signal,
                rasterize: async job => {
                    const page = pages[job.index]!;
                    if (job.rerun || job.view === 'alternate') batchRecorder.noteInputRequired();
                    if (job.view === 'alternate') {
                        const media = page.alternate!.media;
                        try {
                            return (await rasterize(media, page.alternate!.input.page.dpi)).ppm;
                        } catch (error) {
                            if (signal.aborted) throw error;
                            // An optional wider view that fails keeps the first pass.
                            console.warn(`Scan cleanup kept the first-pass classification for page ${String(page.pageNumber)} because its MediaBox view failed: ${getErrorMessage(error)}`);
                            return null;
                        }
                    }
                    const raster = await rasterize(page.view, page.dpi);
                    if (!job.rerun) {
                        batchRecorder.markRasterized(page.pageNumber);
                        if (batchRecorder.awaitingFirstVerdict) recorder.markProgress();
                    }
                    return raster.ppm;
                },
                onAnalyzed: async (job, result) => {
                    if (job.view !== 'primary' || job.rerun) return;
                    analyzedPages += 1;
                    const page = pages[job.index]!;
                    await batchRecorder.recordAnalyzed(verdictInput(page.pageNumber, page.view, result.pageMetadata, analyzedPages));
                },
            });
            for (const [
                index,
                {pageMetadata},
            ] of finished.entries()) {
                const page = pages[index]!;
                const view = pageMetadata.alternateView === true ? page.alternate!.media : page.view;
                await batchRecorder.recordComplete(verdictInput(page.pageNumber, view, pageMetadata, index + 1));
            }
            batchRecorder.end();
        }
        recorder.assertComplete('The browser cleanup engine');
        return await recorder.finish();
    } finally {
        recorder.dispose();
    }
}
