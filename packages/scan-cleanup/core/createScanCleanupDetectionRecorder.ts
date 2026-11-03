import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    TScanCleanupProgress,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {INativeScanCleanupPageMetadataV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {
    createScanCleanupDetectionSignature,
    createScanCleanupPlacementAnchorCalibrationSignature,
} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import type {
    IPdfPageSize,
    IScanCleanupDetectionResultStore,
} from '@evb/scan-cleanup/core/types';
import {
    addScanCleanupDocumentCanvasObservedPage,
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    scanCleanupDocumentCanvasSignature,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {createScanCleanupProgressEtaEstimator} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    PREVIEW_DPI,
    resolveScanCleanupPagePreviewDpi,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
import {buildScanCleanupPlacementAnchorSummary} from '@evb/scan-cleanup/core/placementAnchors';
import {usesScanCleanupInkAlignment} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {
    completedPageProgress,
    isStrongMediaBoxSpread,
    MAX_MEDIA_BOX_RETRY_PAGES,
    projectScanCleanupDetectionResult,
    projectScanCleanupMediaBoxRetryResult,
    shouldRetryMediaBoxPage,
    type TScanCleanupAnalysisVerdict,
} from '@evb/scan-cleanup/core/policy/scanCleanupDetectionResultPolicy';

/** Completed pages a large document keeps in each progress event. */
const RECENT_PROGRESS_PAGES = 256;
/**
 * Large-document progress is a status update, not a page transport. Keep a
 * full second between live frames so a fast native batch cannot leave a
 * renderer restart decoding a long tail of short-lived result objects. Batch
 * ends still publish immediately, and the durable result store remains the
 * source for every page.
 */
const LARGE_PROGRESS_PUBLISH_INTERVAL_MS = 1_000;
const DETECTION_READ_ONLY_PROGRESS_INTERVAL_MS = 250;

export type TScanCleanupDetectionPublish = (
    results: IScanCleanupDetectionResult[],
    progress: TScanCleanupProgress,
    documentCanvasSignature: string,
) => void;

export interface IScanCleanupMediaBoxRetryCandidate {
    pageNumber: number;
    result: IScanCleanupDetectionResult;
    sourcePage: IPdfPageSize;
}

export interface IScanCleanupDetectionOutcome {
    blankPageCount: number;
    resultStore: IScanCleanupDetectionResultStore;
    results: IScanCleanupDetectionResult[];
    placementAnchorSummary?: Awaited<ReturnType<typeof buildScanCleanupPlacementAnchorSummary>>;
}

export interface ICreateScanCleanupDetectionRecorderInput {
    request: IScanCleanupDetectionRequest;
    totalPages: number;
    resultStore: IScanCleanupDetectionResultStore;
    signal: AbortSignal;
    /** Optional host-admission cap that also bounds the matched canvas. */
    rasterMaxPixels?: number | undefined;
    publish: TScanCleanupDetectionPublish;
}

/** One page's analysis as a detection transport reports it, keyed by source page. */
export interface IScanCleanupDetectionVerdictInput {
    sourcePageNumber: number;
    verdict: TScanCleanupAnalysisVerdict;
    /** Pages this batch's engine has reported in this stage. */
    completedPages: number;
    /**
     * The analyzed page: its CropBox view, source resolution and metadata.
     * Read only when the verdict carries a classification and confidence.
     */
    read: () => Promise<{
        sourcePage: IPdfPageSize;
        sourceDpi: number | undefined;
        metadata: INativeScanCleanupPageMetadataV3;
    }>;
}

/**
 * Turns a detection run's analyzed pages into published detection results, as
 * every host must: revisions, the result store, small-document results or a
 * large document's recent tail, the matched-canvas signature, progress counts
 * and throttling, MediaBox retry candidates, and the final summary. The host
 * transport owns rasters and the engine; it reports milestones here.
 */
export function createScanCleanupDetectionRecorder({
    request,
    totalPages,
    resultStore,
    signal,
    rasterMaxPixels,
    publish,
}: ICreateScanCleanupDetectionRecorderInput) {
    const canvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    // Keep the provisional summary used while reconciliation is still open
    // separate from the resolved summary. The former contains every automatic
    // page as unclassified geometry; the latter receives each page only after
    // its classification and can therefore answer the final document-canvas
    // question without retaining a layout map.
    const resolvedCanvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    let matchedPreviewDpi = Number.POSITIVE_INFINITY;
    let baselineCanvasSignature: string | null = null;
    const documentCanvasSignature = (layoutEvidenceComplete = false) => {
        if (!request.options.matchPageSize) {
            return '';
        }
        const signature = scanCleanupDocumentCanvasSignature(resolveScanCleanupDocumentCanvasFromAccumulator(
            layoutEvidenceComplete ? resolvedCanvasAccumulator : canvasAccumulator,
            matchedPreviewDpi,
            request.options,
            layoutEvidenceComplete,
            rasterMaxPixels,
        ));
        return signature === baselineCanvasSignature ? '' : signature;
    };
    // The bounded result store is authoritative for every document-scale run.
    // Keeping an in-memory snapshot is safe only for the explicit small-document
    // threshold, below the production batch size.
    const compatibilityResults = totalPages <= SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ? new Map<number, IScanCleanupDetectionResult>()
        : null;
    // Large documents publish only the results recorded since the previous
    // event. Preserve append order so a late reconciliation update remains in
    // the renderer's bounded tail even when it targets an early page. The
    // store holds the full set.
    const recentResults: IScanCleanupDetectionResult[] = [];
    let lastLargePublishAt = 0;
    const publishedResults = () => compatibilityResults === null
        ? []
        : [...compatibilityResults.values()]
            .sort((left, right) => left.pageNumber - right.pageNumber);
    const takePublishableResults = () => {
        if (compatibilityResults !== null) {
            return publishedResults();
        }
        const pending = recentResults.splice(0);
        return pending.length <= RECENT_PROGRESS_PAGES
            ? pending
            : pending.slice(-RECENT_PROGRESS_PAGES);
    };
    const shouldPublishLargeProgress = (terminal: boolean) => {
        if (compatibilityResults !== null || terminal) {
            return true;
        }
        if (recentResults.length >= RECENT_PROGRESS_PAGES) {
            return true;
        }
        const now = Date.now();
        if (now - lastLargePublishAt < LARGE_PROGRESS_PUBLISH_INTERVAL_MS) {
            return false;
        }
        lastLargePublishAt = now;
        return true;
    };

    let rasterizedPages = 0;
    let analyzedPages = 0;
    let recheckedPages = 0;
    let readOnlyProgressDirty = false;
    let lastReadOnlyPublishAt = Number.NEGATIVE_INFINITY;
    const reportedPageNumbers = new Set<number>();
    const etaEstimator = createScanCleanupProgressEtaEstimator();
    const mediaBoxRetryCandidates: IScanCleanupMediaBoxRetryCandidate[] = [];
    // The large-document path deliberately sends no document-sized completion
    // list through progress. A batch-local list still lets the UI identify the
    // pages represented by the latest frame without retaining a million page
    // numbers in the workflow.
    const progressWithEta = (
        stage: TScanCleanupProgress['stage'],
        completedUnits: number,
        totalUnits: number,
        progress: Pick<TScanCleanupProgress, 'percent' | 'completedPageNumbers' | 'completedPageNumbersTruncated'>,
    ): TScanCleanupProgress => {
        // Detection's published stage changes when the first verdict arrives,
        // but its rate must cover the whole job, including the initial raster
        // wait. Keep one estimator key for both published stages.
        const etaSeconds = etaEstimator.update('detecting', completedUnits, totalUnits, performance.now());
        return {
            stage,
            completedUnits,
            totalUnits,
            ...progress,
            rasterizedUnits: rasterizedPages,
            recheckedUnits: recheckedPages,
            ...(etaSeconds === undefined ? {} : {etaSeconds}),
        };
    };
    // A throttled frame is published when its window ends, so the last change
    // of a burst, such as a render finishing, is never left unreported.
    let trailingReadOnlyPublish: ReturnType<typeof setTimeout> | null = null;
    const publishReadOnlyProgress = (force = false) => {
        if (trailingReadOnlyPublish !== null && force) {
            clearTimeout(trailingReadOnlyPublish);
            trailingReadOnlyPublish = null;
        }
        if (!readOnlyProgressDirty || signal.aborted) return;
        const now = Date.now();
        const interval = compatibilityResults === null
            ? LARGE_PROGRESS_PUBLISH_INTERVAL_MS
            : DETECTION_READ_ONLY_PROGRESS_INTERVAL_MS;
        if (!force && now - lastReadOnlyPublishAt < interval) {
            trailingReadOnlyPublish ??= setTimeout(() => {
                trailingReadOnlyPublish = null;
                publishReadOnlyProgress();
            }, interval - (now - lastReadOnlyPublishAt));
            return;
        }
        readOnlyProgressDirty = false;
        lastReadOnlyPublishAt = now;
        const stage = analyzedPages > 0 ? 'detecting' : 'rasterizing';
        publish(takePublishableResults(), progressWithEta(
            stage,
            analyzedPages,
            totalPages,
            {
                percent: totalPages === 0
                    ? 100
                    : (stage === 'rasterizing' ? rasterizedPages : analyzedPages) / totalPages * 100,
                ...(analyzedPages === 0
                    ? {completedPageNumbers: []}
                    : completedPageProgress(reportedPageNumbers, analyzedPages)),
            },
        ), documentCanvasSignature(analyzedPages >= totalPages));
    };
    const markProgress = () => {
        readOnlyProgressDirty = true;
        publishReadOnlyProgress();
    };
    const includeContentBoxes = request.options.autoDewarp !== true;

    return {
        /** Adds one CropBox page view to the document geometry, in page order. */
        addGeometryPage(page: IPdfPageSize, sourceDpi: number | undefined) {
            addScanCleanupDocumentCanvasPage(canvasAccumulator, page, request.options);
            matchedPreviewDpi = Math.min(matchedPreviewDpi, resolveScanCleanupPagePreviewDpi(page, sourceDpi));
        },
        /** Fixes the baseline canvas once every geometry page is added, and publishes the first frame. */
        sealGeometry() {
            if (!Number.isFinite(matchedPreviewDpi)) matchedPreviewDpi = PREVIEW_DPI;
            baselineCanvasSignature = scanCleanupDocumentCanvasSignature(
                request.options.matchPageSize
                    ? resolveScanCleanupDocumentCanvasFromAccumulator(
                        canvasAccumulator,
                        matchedPreviewDpi,
                        request.options,
                        false,
                        rasterMaxPixels,
                    )
                    : null,
            );
            resolvedCanvasAccumulator.producedPageCount = canvasAccumulator.producedPageCount;
            resolvedCanvasAccumulator.forced = canvasAccumulator.forced;
            readOnlyProgressDirty = false;
            publish([], progressWithEta(
                'rasterizing',
                analyzedPages,
                totalPages,
                {
                    percent: totalPages === 0 ? 100 : rasterizedPages / totalPages * 100,
                    completedPageNumbers: [],
                },
            ), documentCanvasSignature());
        },
        /** Publishes a changed raster or recheck count, throttled. */
        markProgress,
        /** One page analyzed again after the first pass: a MediaBox retry raster. */
        markRechecked() {
            recheckedPages += 1;
            markProgress();
        },
        /** One bounded batch of the document, analyzed and reconciled together. */
        beginBatch(batch: {
            startOffset: number;
            endOffsetExclusive: number
        }) {
            const batchResults = new Map<number, IScanCleanupDetectionResult>();
            const countedRasterPages = new Set<number>();
            let firstVerdictsComplete = false;
            const recordResult = async (input: IScanCleanupDetectionVerdictInput) => {
                const {
                    sourcePage,
                    sourceDpi,
                    metadata,
                } = await input.read();
                const previousResult = batchResults.get(input.sourcePageNumber)
                    ?? compatibilityResults?.get(input.sourcePageNumber);
                const isFirstClassification = previousResult === undefined;
                const result = projectScanCleanupDetectionResult({
                    pageNumber: input.sourcePageNumber,
                    revision: (previousResult?.revision ?? 0) + 1,
                    verdict: input.verdict,
                    metadata,
                    sourcePage,
                    sourceDpi,
                    includeContentBoxes,
                });
                if (isFirstClassification) await resultStore.append(result);
                else await resultStore.replace(input.sourcePageNumber, result);
                batchResults.set(input.sourcePageNumber, result);
                compatibilityResults?.set(input.sourcePageNumber, result);
                if (compatibilityResults === null) {
                    recentResults.push(result);
                }
                if (isFirstClassification) {
                    addScanCleanupDocumentCanvasObservedPage(
                        canvasAccumulator,
                        sourcePage,
                        request.options,
                        result.classification,
                    );
                    addScanCleanupDocumentCanvasObservedPage(
                        resolvedCanvasAccumulator,
                        sourcePage,
                        request.options,
                        result.classification,
                    );
                }
                return result;
            };
            const reportPage = (pageNumber: number) => {
                reportedPageNumbers.add(pageNumber);
                if (reportedPageNumbers.size > RECENT_PROGRESS_PAGES) {
                    reportedPageNumbers.delete(reportedPageNumbers.values().next().value!);
                }
            };
            return {
                /** Pages whose rasters already exist count once, without a frame of their own. */
                addRetainedRasters(pageNumbers: Iterable<number>) {
                    let added = 0;
                    for (const pageNumber of pageNumbers) {
                        countedRasterPages.add(pageNumber);
                        added += 1;
                    }
                    rasterizedPages += added;
                    if (added > 0) markProgress();
                },
                /** One page's analysis raster exists; counted once however often it is rendered. */
                markRasterized(pageNumber: number) {
                    if (!countedRasterPages.has(pageNumber)) {
                        countedRasterPages.add(pageNumber);
                        rasterizedPages += 1;
                    }
                },
                /** No page of this run has a verdict yet. */
                get awaitingFirstVerdict() {
                    return (compatibilityResults?.size ?? batchResults.size) === 0;
                },
                /** An engine asked for a page's raster again; once its first pass is over, that is a recheck. */
                noteInputRequired() {
                    if (firstVerdictsComplete) {
                        recheckedPages += 1;
                        markProgress();
                    }
                },
                async recordAnalyzed(input: IScanCleanupDetectionVerdictInput) {
                    reportPage(input.sourcePageNumber);
                    analyzedPages = Math.max(analyzedPages, batch.startOffset + input.completedPages);
                    if (analyzedPages >= batch.endOffsetExclusive) {
                        firstVerdictsComplete = true;
                    }
                    if (input.verdict.classification === undefined || input.verdict.confidence === undefined) {
                        return;
                    }
                    await recordResult(input);
                    if (!shouldPublishLargeProgress(analyzedPages >= totalPages)) {
                        return;
                    }
                    readOnlyProgressDirty = false;
                    publish(takePublishableResults(), progressWithEta(
                        'detecting',
                        analyzedPages,
                        totalPages,
                        {
                            percent: totalPages === 0 ? 100 : analyzedPages / totalPages * 100,
                            ...completedPageProgress(reportedPageNumbers, analyzedPages),
                        },
                    ), documentCanvasSignature());
                },
                async recordComplete(input: IScanCleanupDetectionVerdictInput) {
                    reportPage(input.sourcePageNumber);
                    if (input.verdict.classification === undefined || input.verdict.confidence === undefined) {
                        return;
                    }
                    const previousPlan = batchResults.get(input.sourcePageNumber)?.pagePlanEvidence;
                    const result = await recordResult(input);
                    const planChanged = previousPlan !== undefined
                        && JSON.stringify(previousPlan) !== JSON.stringify(result.pagePlanEvidence);
                    const completedUnits = Math.max(
                        analyzedPages,
                        batch.startOffset + input.completedPages,
                    );
                    if (!planChanged && !shouldPublishLargeProgress(completedUnits >= totalPages)) {
                        return;
                    }
                    readOnlyProgressDirty = false;
                    publish(planChanged ? [result] : takePublishableResults(), progressWithEta(
                        'detecting',
                        completedUnits,
                        totalPages,
                        {
                            percent: totalPages === 0 ? 100 : completedUnits / totalPages * 100,
                            ...completedPageProgress(reportedPageNumbers, completedUnits),
                        },
                    ), documentCanvasSignature(completedUnits >= totalPages));
                },
                /** After the batch ends, its single pages whose CropBox may hide a spread, in page order. */
                collectMediaBoxCandidates(pages: ReadonlyArray<{
                    pageNumber: number;
                    sourcePage: IPdfPageSize | undefined
                }>) {
                    for (const {
                        pageNumber,
                        sourcePage,
                    } of pages) {
                        const result = batchResults.get(pageNumber);
                        if (
                            result !== undefined && sourcePage !== undefined
                            && mediaBoxRetryCandidates.length < MAX_MEDIA_BOX_RETRY_PAGES
                            && result.classification === 'single-uncut-page'
                            && shouldRetryMediaBoxPage(sourcePage, result)
                        ) {
                            mediaBoxRetryCandidates.push({
                                pageNumber,
                                result,
                                sourcePage,
                            });
                        }
                    }
                },
            };
        },
        /** Requires one classification per page once every batch has run. */
        assertComplete(engineName: string) {
            signal.throwIfAborted();
            if (resultStore.resultCount !== totalPages) {
                throw new Error(`${engineName} returned ${resultStore.resultCount} classifications for ${totalPages} pages`);
            }
        },
        get mediaBoxRetryCandidates(): readonly IScanCleanupMediaBoxRetryCandidate[] {
            return mediaBoxRetryCandidates;
        },
        /**
         * Replaces a page's result with its MediaBox retry when the retry proves
         * a spread locally; returns whether it did.
         */
        async acceptMediaBoxRetry(input: {
            pageNumber: number;
            verdict: TScanCleanupAnalysisVerdict;
            metadata: INativeScanCleanupPageMetadataV3;
            rasterWidth: number;
            rasterHeight: number;
            mediaPage: IPdfPageSize;
            sourceDpi: number;
        }) {
            if (!isStrongMediaBoxSpread(input.verdict, input.metadata, input.rasterWidth, input.rasterHeight)) {
                return false;
            }
            const result = await resultStore.getPage(input.pageNumber);
            if (result === undefined) return false;
            const accepted = projectScanCleanupMediaBoxRetryResult({
                previous: result,
                verdict: input.verdict,
                metadata: input.metadata,
                mediaPage: input.mediaPage,
                sourceDpi: input.sourceDpi,
                includeContentBoxes,
            });
            await resultStore.replace(input.pageNumber, accepted);
            compatibilityResults?.set(input.pageNumber, accepted);
            return true;
        },
        /** Publishes the last pending frame and summarizes the stored results. */
        async finish(): Promise<IScanCleanupDetectionOutcome> {
            publishReadOnlyProgress(true);
            const placementAnchorSummary = usesScanCleanupInkAlignment(request.options)
                ? await buildScanCleanupPlacementAnchorSummary({
                    options: request.options,
                    resultStore,
                    signal,
                    identity: {
                        documentRevision: request.documentRevision,
                        detectionSignature: createScanCleanupDetectionSignature(request.options),
                        calibrationSignature: createScanCleanupPlacementAnchorCalibrationSignature(request.options),
                    },
                })
                : undefined;
            // The terminal state carries per-page results only for small
            // documents, so the blank-page hint needs its own count of the
            // final records.
            let blankPageCount = 0;
            await resultStore.forEachChunk(results => {
                signal.throwIfAborted();
                for (const result of results) {
                    if (result.recommendedOutputModeReason === 'blank') blankPageCount += 1;
                }
            });
            return {
                blankPageCount,
                resultStore,
                results: publishedResults(),
                ...(placementAnchorSummary === undefined ? {} : {placementAnchorSummary}),
            };
        },
        /** Stops a pending throttled frame; for a run that ends without finishing. */
        dispose() {
            if (trailingReadOnlyPublish !== null) {
                clearTimeout(trailingReadOnlyPublish);
                trailingReadOnlyPublish = null;
            }
        },
    };
}

export type IScanCleanupDetectionRecorder = ReturnType<typeof createScanCleanupDetectionRecorder>;
export type IScanCleanupDetectionBatchRecorder = ReturnType<IScanCleanupDetectionRecorder['beginBatch']>;
