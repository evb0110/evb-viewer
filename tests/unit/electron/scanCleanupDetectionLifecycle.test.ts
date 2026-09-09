import {
    describe,
    it,
    expect,
} from 'vitest';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
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

describe('scanCleanupDetectionLifecycleTest', () => {
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
