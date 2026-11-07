import type {IScanCleanupDetectionRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {INativeScanCleanupPageMetadataV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {IScanCleanupWasmReconcileDocumentResult} from '@contracts/scan-cleanup/browserScanCleanupWasm';
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
import {
    deriveScanCleanupAnalysisVerdict,
    type TScanCleanupAnalysisVerdict,
} from '@evb/scan-cleanup/core/policy/scanCleanupDetectionResultPolicy';
import {
    DETECTION_DPI,
    resolveScanCleanupAnalysisDpi,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
    toCropBoxPageSize,
    toMediaBoxPageSize,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {resolveScanCleanupManifestPageOptions} from '@evb/scan-cleanup/core/policy/scanCleanupManifestPagePolicy';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
} from '@evb/scan-cleanup/core/pageBatches';
import {resolveScanCleanupPageScopeLazy} from '@evb/scan-cleanup/core/pageScope';
import {runBrowserScanCleanupWorkerRequest} from '@app/platform/browser-api/browserScanCleanupWorkerClient';
import {
    renderPageRaster,
    sourceLayerFacts,
    unwrapBrowserScanCleanupOutcome,
    type IBrowserScanCleanupSource,
    type IPageRaster,
} from '@app/platform/browser-api/browserScanCleanupJob';

/** One page an analyze pass reads: its source page, the view it is analyzed on, and that view's resolution. */
interface IAnalysisPage {
    pageNumber: number;
    view: IPdfPageSize;
    dpi: number;
    /** The source resolution the engine's options are resolved with. */
    manifestSourceDpi: number;
}

interface IFinishedAnalysis {
    page: IAnalysisPage;
    metadata: INativeScanCleanupPageMetadataV3;
    verdict: TScanCleanupAnalysisVerdict;
    raster: Pick<IPageRaster, 'width' | 'height'>;
}

export interface IRunBrowserScanCleanupDetectionInput {
    request: IScanCleanupDetectionRequest;
    source: IBrowserScanCleanupSource;
    resultStore: IScanCleanupDetectionResultStore;
    signal: AbortSignal;
    publish: TScanCleanupDetectionPublish;
}

/**
 * Detects every page's layout, content and recommended mode as desktop
 * detection does, with the browser's rasters and engine: each page's CropBox
 * raster at its canonical analysis resolution, analyzed, reconciled with its
 * batch, and finished, then the optional MediaBox retry. The shared recorder
 * turns the verdicts into the results and progress desktop publishes.
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

        const analyze = async (
            page: IAnalysisPage,
            raster: IPageRaster,
            documentPrior?: NonNullable<IScanCleanupWasmReconcileDocumentResult['pages'][number]>['prior'],
        ) => unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest('analyze-page', {
            input: raster.ppm,
            page: {
                options: resolveScanCleanupManifestPageOptions({
                    options: request.options,
                    analysisPurpose: 'page-plan',
                    qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
                    experimental: {
                        autoDewarp: request.options.autoDewarp ?? false,
                        ...(request.options.autoDewarpDepth === undefined
                            ? {}
                            : {autoDewarpDepth: request.options.autoDewarpDepth}),
                    },
                    page: {
                        pageNumber: page.pageNumber,
                        dpi: page.dpi,
                        sourceDpi: page.manifestSourceDpi,
                        ...sourceLayerFacts(source, page.pageNumber),
                    },
                }),
                sourcePageIndex: page.pageNumber - 1,
                canvasScope: 'page',
                analysisPurpose: 'page-plan',
                ...(documentPrior === undefined ? {} : {documentPrior}),
            },
        }, signal));
        const rasterize = async (page: IAnalysisPage) => {
            const pdfPage = await source.pdf.getPage(page.pageNumber);
            try {
                return await renderPageRaster(pdfPage, page.view, page.dpi, SCAN_CLEANUP_RASTER_MAX_PIXELS, signal);
            } finally {
                pdfPage.cleanup();
            }
        };

        /**
         * One analyze manifest's work, as the engine runs it: every page's first
         * pass, the batch's reconciliation, each rerun under its prior, and then
         * every page finished in order. Rasters are rendered when a pass needs
         * them and dropped after, so a batch holds one at a time.
         */
        const analyzeBatch = async (pages: readonly IAnalysisPage[], hooks: {
            rendered?: (page: IAnalysisPage, index: number) => void;
            analyzed?: (finished: IFinishedAnalysis, index: number) => Promise<void>;
            rerendered?: () => void;
            completed?: (finished: IFinishedAnalysis, index: number) => Promise<void>;
            rasterFailed?: (page: IAnalysisPage, error: unknown) => boolean;
        }) => {
            const firstPass: Array<{
                page: IAnalysisPage;
                pageMetadataJson: string;
                reconciliation: Awaited<ReturnType<typeof analyze>>['reconciliation'];
                raster: Pick<IPageRaster, 'width' | 'height'>;
            }> = [];
            for (const [
                index,
                page,
            ] of pages.entries()) {
                signal.throwIfAborted();
                let raster: IPageRaster;
                try {
                    raster = await rasterize(page);
                } catch (error) {
                    if (signal.aborted || hooks.rasterFailed?.(page, error) !== true) throw error;
                    continue;
                }
                hooks.rendered?.(page, index);
                const analysis = await analyze(page, raster);
                firstPass.push({
                    page,
                    pageMetadataJson: analysis.pageMetadataJson,
                    reconciliation: analysis.reconciliation,
                    raster: {
                        width: raster.width,
                        height: raster.height,
                    },
                });
                await hooks.analyzed?.({
                    page,
                    metadata: analysis.pageMetadata,
                    verdict: deriveScanCleanupAnalysisVerdict(analysis.pageMetadata),
                    raster: firstPass.at(-1)!.raster,
                }, firstPass.length - 1);
            }
            if (firstPass.length === 0) return [];
            const {pages: decisions} = unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest(
                'reconcile-document',
                {candidates: firstPass.map(entry => entry.reconciliation)},
                signal,
            ));
            // The engine reruns every page reconciliation sends back, one at a
            // time, before it finishes any page.
            const analysisJson: string[] = [];
            for (const [
                index,
                entry,
            ] of firstPass.entries()) {
                const decision = decisions[index] ?? null;
                if (decision?.kind !== 'rerun') {
                    analysisJson.push(entry.pageMetadataJson);
                    continue;
                }
                signal.throwIfAborted();
                hooks.rerendered?.();
                analysisJson.push((await analyze(entry.page, await rasterize(entry.page), decision.prior)).pageMetadataJson);
            }
            const finished: IFinishedAnalysis[] = [];
            for (const [
                index,
                entry,
            ] of firstPass.entries()) {
                signal.throwIfAborted();
                const decision = decisions[index] ?? null;
                const result = unwrapBrowserScanCleanupOutcome(await runBrowserScanCleanupWorkerRequest('finish-page-analysis', {
                    pageMetadataJson: analysisJson[index]!,
                    ...(decision === null ? {} : {reconciliation: decision}),
                }, signal));
                const completed: IFinishedAnalysis = {
                    page: entry.page,
                    metadata: result.pageMetadata,
                    verdict: deriveScanCleanupAnalysisVerdict(result.pageMetadata),
                    raster: entry.raster,
                };
                finished.push(completed);
                await hooks.completed?.(completed, index);
            }
            return finished;
        };

        const pageScope = resolveScanCleanupPageScopeLazy(undefined, totalPages);
        for (const batch of iterateScanCleanupPageBatches(pageScope.length, SCAN_CLEANUP_STREAMING_BATCH_PAGES)) {
            signal.throwIfAborted();
            const batchRecorder = recorder.beginBatch(batch);
            const pages = collectScanCleanupPageScopeBatch(pageScope, batch).map((pageNumber): IAnalysisPage => {
                const view = toCropBoxPageSize(source.pageSizes[pageNumber - 1]!);
                const dpi = resolveScanCleanupAnalysisDpi(view);
                return {
                    pageNumber,
                    view,
                    dpi,
                    manifestSourceDpi: pageSourceDpi(view) ?? dpi,
                };
            });
            const verdictInput = (finished: IFinishedAnalysis, index: number) => ({
                sourcePageNumber: finished.page.pageNumber,
                verdict: finished.verdict,
                completedPages: index + 1,
                read: () => Promise.resolve({
                    sourcePage: finished.page.view,
                    sourceDpi: pageSourceDpi(finished.page.view),
                    metadata: finished.metadata,
                }),
            });
            await analyzeBatch(pages, {
                rendered: page => {
                    batchRecorder.markRasterized(page.pageNumber);
                    if (batchRecorder.awaitingFirstVerdict) recorder.markProgress();
                },
                analyzed: (finished, index) => batchRecorder.recordAnalyzed(verdictInput(finished, index)),
                rerendered: () => batchRecorder.noteInputRequired(),
                completed: (finished, index) => batchRecorder.recordComplete(verdictInput(finished, index)),
            });
            batchRecorder.end(pages.map(page => ({
                pageNumber: page.pageNumber,
                sourcePage: page.view,
            })));
        }
        recorder.assertComplete('The browser cleanup engine');

        const candidates = recorder.mediaBoxRetryCandidates;
        if (candidates.length > 0) {
            const retryPages = candidates.map((candidate): IAnalysisPage => {
                const view = toMediaBoxPageSize(candidate.sourcePage);
                return {
                    pageNumber: candidate.pageNumber,
                    view,
                    dpi: resolveScanCleanupAnalysisDpi(view),
                    manifestSourceDpi: pageSourceDpi(candidate.sourcePage) ?? DETECTION_DPI,
                };
            });
            const retried = await analyzeBatch(retryPages, {
                rendered: () => recorder.markRechecked(),
                // An optional retry whose raster fails keeps the first pass.
                rasterFailed: (page, error) => {
                    console.warn(`Scan cleanup kept the first-pass classification for page ${String(page.pageNumber)} because its optional MediaBox retry failed: ${getErrorMessage(error)}`);
                    return true;
                },
            });
            for (const finished of retried) {
                const candidate = candidates.find(entry => entry.pageNumber === finished.page.pageNumber)!;
                await recorder.acceptMediaBoxRetry({
                    pageNumber: finished.page.pageNumber,
                    verdict: finished.verdict,
                    metadata: finished.metadata,
                    rasterWidth: finished.raster.width,
                    rasterHeight: finished.raster.height,
                    mediaPage: finished.page.view,
                    sourceDpi: pageSourceDpi(candidate.sourcePage) ?? DETECTION_DPI,
                });
            }
        }
        return await recorder.finish();
    } finally {
        recorder.dispose();
    }
}
