import {
    describe,
    it,
    expect,
    vi,
} from 'vitest';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    IScanCleanupPlacementAnchorCalibrationRequest,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createScanCleanupDetectionSignature} from '@contracts/scan-cleanup/createScanCleanupDetectionSignature';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import type {IScanCleanupDetectionSubscriber} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {scanCleanupDetectionOwner} from '@electron/features/scan-cleanup/scanCleanupDetectionLifecycle';
import {
    scenarioPublishesProvisionalPageResultsBeforeDocumentReconciliationCompletes,
    scenarioStagesEveryReplayableDetectionRasterBeforeNativeAnalysisBegins,
    scenarioRemovesTemporaryDetectionRasterPathsWhenNativeAnalysisFails,
    scenarioDoesNotHangWhenDetectionAbortsDuringNativeAnalysis,
    scenarioReconcilesEveryDetectionClassificationAgainstTheWholeDocumentNotAWindowOfIt,
    scenarioRasterizesDetectionPagesStraightToDiskInsteadOfBufferingThem,
    scenarioAnalyzesEveryPageOnTheSameCanonical150DPIGridAsFinalRendering,
    scenarioPreviewsAPageDetectionRasterizedWithoutARendererAndWithoutASecondPageCount,
    scenarioStreamsABrokeredDetectAllLifecycleAndHandsItsRastersToLaterPreviewRequests,
    scenarioRasterizesDetectionPagesAsWideAsThe11CoreHostAllowsAndLeasesThatWidth,
    scenarioIncludesTheClassifierSidecarInStreamingDetectionAdmission,
    scenarioFallsBackFromRasterStreamingUntilBrokerCapacityCanAdmitItsSidecar,
    scenarioStreamsEveryDetectionClassificationToTheSubscriberExactlyOnce,
    scenarioKeepsXlargeDetectionEventPayloadsWithinTheRendererPageWindow,
    scenarioReDetectsAChangedPageOverTheRastersItAlreadyHoldsPageForPage,
    scenarioRasterizesOnlyThePagesRetentionNoLongerHoldsAndStillReconcilesOverTheWholeDocument,
    scenarioCancelsDetectAllThroughItsSignalAndRemovesItsScratchArtifacts,
    scenarioJoinsIdenticalDetectionWorkAndReplacesAChangedRequestForTheSameOwner,
    scenarioStartsFreshIdenticalDetectionAfterCancellationIsAcknowledgedButNotTerminal,
    scenarioCancelsDetectAllWhenTheOwningRendererIsDestroyed,
    scenarioDoesNotDeliverTerminalDetectionStateAfterARendererIsDestroyed,
} from '@tests/unit/electron/scanCleanupDetectionLifecycleScenarios';
import {registerScanCleanupDetectionResultStore} from '@electron/features/scan-cleanup/detectionResultStoreRegistry';

describe('scanCleanupDetectionLifecycleTest', () => {
    it('coalesces store calibration and rebuilds it for current placement options', async () => {
        const options: IScanCleanupOptions = {
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'bw',
            readingOrder: 'ltr',
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'ink',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        };
        const pageNumber = requirePageNumber(1);
        const record: IScanCleanupDetectionResult = {
            pageNumber,
            classification: 'single-uncut-page',
            confidence: 1,
            cutterXPx: null,
            documentPrior: null,
            tier1Verdict: 'single-uncut-page',
            reconciled: true,
            clusterAgreement: 1,
            sourcePageMetadata: {
                pageNumber,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                sourceDpi: 300,
            },
            pagePlanEvidence: {
                pageNumber,
                rotationDegrees: 0,
                layoutClassification: 'single-uncut-page',
                outputs: {full: {contentBox: {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                    widthNormalized: 0.8,
                    heightNormalized: 0.7,
                    rotationDegrees: 0,
                }}},
            },
        };
        let chunkReads = 0;
        const firstChunk = Promise.withResolvers<undefined>();
        const store: IScanCleanupDetectionResultStore = {
            pageCount: 1,
            resultCount: 1,
            append: async () => undefined,
            replace: async () => undefined,
            getPage: async requestedPage => requestedPage === 1 ? record : undefined,
            readRange: async () => [record],
            forEachChunk: async onChunk => {
                chunkReads += 1;
                if (chunkReads === 1) await firstChunk.promise;
                await onChunk([record], 1);
            },
            close: vi.fn(async () => undefined),
        };
        const ownerId = 'calibration-owner';
        const documentRevision = 'calibration-revision';
        const sourcePdfPath = '/document.pdf';
        const storeId = registerScanCleanupDetectionResultStore({
            detectionSignature: createScanCleanupDetectionSignature(options),
            documentRevision,
            ownerId,
            resultStore: store,
            sourcePdfPath,
        });
        const retention = scanCleanupRasterRetention(defaultDependencies);
        const owner = scanCleanupDetectionOwner(defaultDependencies, retention);
        owner.registerResultStore(storeId);
        const calibrationSender = {
            id: 1,
            isDestroyed: () => false,
            on: vi.fn(),
            once: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
        } satisfies IScanCleanupDetectionSubscriber;
        const request = {
            ownerId,
            documentRevision,
            sourcePdfPath,
            detectionResultStoreId: storeId,
            options,
            pageNumber,
        } satisfies IScanCleanupPlacementAnchorCalibrationRequest;
        try {
            const first = owner.resolvePlacementAnchorCalibration(calibrationSender, request);
            const second = owner.resolvePlacementAnchorCalibration(calibrationSender, request);
            await vi.waitFor(() => expect(chunkReads).toBe(1));
            const changedOptions = structuredClone(options);
            changedOptions.pageOverrides['1'] = {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualContentBoxes: {full: {
                    xNormalized: 0.1,
                    yNormalized: 0.3,
                    widthNormalized: 0.8,
                    heightNormalized: 0.7,
                    rotationDegrees: 0,
                }},
            };
            const changedRequest = {
                ...request,
                options: changedOptions,
            } satisfies IScanCleanupPlacementAnchorCalibrationRequest;
            const changed = owner.resolvePlacementAnchorCalibration(calibrationSender, changedRequest);
            await vi.waitFor(() => expect(chunkReads).toBe(3));
            firstChunk.resolve(undefined);
            const [
                firstCalibration,
                secondCalibration,
                changedCalibration,
            ] = await Promise.all(
                [
                    first,
                    second,
                    changed,
                ],
            );
            expect(firstCalibration).toEqual(secondCalibration);
            expect(firstCalibration.summary.samples[0]?.yNormalized).toBe(0.1);
            expect(changedCalibration.summary.samples[0]?.yNormalized).toBe(0.3);
            expect(chunkReads).toBe(4);
            await owner.resolvePlacementAnchorCalibration(calibrationSender, changedRequest);
            expect(chunkReads).toBe(4);
        } finally {
            await owner.dispose();
            await retention.dispose();
        }
    });

    it('uses the detection owner boundary for registry disposal', async () => {
        const retention = scanCleanupRasterRetention(defaultDependencies);
        const owner = scanCleanupDetectionOwner(defaultDependencies, retention);
        expect(owner).toHaveProperty('detectAll');
        await expect(owner.dispose()).resolves.toBeUndefined();
        await retention.dispose();
    });
    it('publishes provisional page results before document reconciliation completes', async () => {
        await scenarioPublishesProvisionalPageResultsBeforeDocumentReconciliationCompletes();
    });
    it('stages every replayable detection raster before native analysis begins', async () => {
        await scenarioStagesEveryReplayableDetectionRasterBeforeNativeAnalysisBegins();
    });
    it('removes temporary detection raster paths when native analysis fails', async () => {
        await scenarioRemovesTemporaryDetectionRasterPathsWhenNativeAnalysisFails();
    });
    it('does not hang when detection aborts during native analysis', async () => {
        await scenarioDoesNotHangWhenDetectionAbortsDuringNativeAnalysis();
    });
    it('reconciles every detection classification against the whole document, not a window of it', async () => {
        await scenarioReconcilesEveryDetectionClassificationAgainstTheWholeDocumentNotAWindowOfIt();
    });
    it('rasterizes detection pages straight to disk instead of buffering them', async () => {
        await scenarioRasterizesDetectionPagesStraightToDiskInsteadOfBufferingThem();
    });
    it('analyzes every page on the same canonical 150 DPI grid as final rendering', async () => {
        await scenarioAnalyzesEveryPageOnTheSameCanonical150DPIGridAsFinalRendering();
    });
    it('previews a page detection rasterized without a renderer and without a second page count', async () => {
        await scenarioPreviewsAPageDetectionRasterizedWithoutARendererAndWithoutASecondPageCount();
    });
    it('streams a brokered detect-all lifecycle and hands its rasters to later preview requests', async () => {
        await scenarioStreamsABrokeredDetectAllLifecycleAndHandsItsRastersToLaterPreviewRequests();
    });
    it('rasterizes detection pages as wide as the 11-core host allows and leases that width', async () => {
        await scenarioRasterizesDetectionPagesAsWideAsThe11CoreHostAllowsAndLeasesThatWidth();
    });
    it('includes the classifier sidecar in streaming detection admission', async () => {
        await scenarioIncludesTheClassifierSidecarInStreamingDetectionAdmission();
    });
    it('falls back from raster streaming until broker capacity can admit its sidecar', async () => {
        await scenarioFallsBackFromRasterStreamingUntilBrokerCapacityCanAdmitItsSidecar();
    });
    it('streams every detection classification to the subscriber exactly once', async () => {
        await scenarioStreamsEveryDetectionClassificationToTheSubscriberExactlyOnce();
    });
    it('keeps xlarge detection event payloads within the renderer page window', async () => {
        await scenarioKeepsXlargeDetectionEventPayloadsWithinTheRendererPageWindow();
    });
    it('re-detects a changed page over the rasters it already holds, page for page', async () => {
        await scenarioReDetectsAChangedPageOverTheRastersItAlreadyHoldsPageForPage();
    });
    it('rasterizes only the pages retention no longer holds and still reconciles over the whole document', async () => {
        await scenarioRasterizesOnlyThePagesRetentionNoLongerHoldsAndStillReconcilesOverTheWholeDocument();
    });
    it('cancels detect-all through its signal and removes its scratch artifacts', async () => {
        await scenarioCancelsDetectAllThroughItsSignalAndRemovesItsScratchArtifacts();
    });
    it('joins identical detection work and replaces a changed request for the same owner', async () => {
        await scenarioJoinsIdenticalDetectionWorkAndReplacesAChangedRequestForTheSameOwner();
    });
    it('starts fresh identical detection after cancellation is acknowledged but not terminal', async () => {
        await scenarioStartsFreshIdenticalDetectionAfterCancellationIsAcknowledgedButNotTerminal();
    });
    it('cancels detect-all when the owning renderer is destroyed', async () => {
        await scenarioCancelsDetectAllWhenTheOwningRendererIsDestroyed();
    });
    it('does not deliver terminal detection state after a renderer is destroyed', async () => {
        await scenarioDoesNotDeliverTerminalDetectionStateAfterARendererIsDestroyed();
    });
});
