import {
    describe,
    it,
    expect,
} from 'vitest';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import {scanCleanupPreviewRenderingOwner} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingOwner';
import {
    scenarioReturnsRealSidecarBytesAndValidatedMetadata,
    scenarioDoesNotUpscaleAProven72DPIRasterDocumentForItsBasePreview,
    scenarioBoundsAPhysicallyOversizedScanPreviewBeforePopplerRasterizesIt,
    scenarioStreamsTheDisplayRasterButCleansBinaryPreviewTextOnTheSourceGrid,
    scenarioRendersOnlyTheRequestedZoomRegionAtTrueOutputDPIWithinTheTileBudget,
    scenarioHandsTheDetailTileToTheSidecarThroughTheSharedRasterHandoff,
    scenarioKeepsARecentlyReadBaseAnalysisWhilePruningAStaleEntry,
    scenarioProbesOnlyTheRequestedPageForTheFirstPreviewRasterStructure,
    scenarioKeepsIntrinsicPageCanvasesWhenTheDocumentGeometryCannotBeRead,
    scenarioPresentsAClassifiedSpreadOnAHalfSheetCanvasWithoutForcingAnUnmeasuredCut,
    scenarioReusesTheDetectedOutputModeForAnAutomaticPreview,
    scenarioDoesNotTurnACanceledTrustedLayerExtractionIntoARasterFallback,
    scenarioReusesBaseGeometryForDetailAfterDetectionResolvesAuto,
    scenarioRendersAMatchedLosslessPageTheFinalRunCannotKeepLossless,
    scenarioKeepsAMatchedLosslessPageLosslessWhenTheDocumentSharesOneGrid,
    scenarioUsesAnalysisOnlyOutputMetadataForTheLosslessOriginalPagePreview,
    scenarioUsesThePairWideLosslessFitWhenOneSpreadLeafReachesTheMarginBox,
    scenarioReservesExactFinalCanvasMarginsInAMatchedLosslessPreviewAndSaysWhenContentIsFitted,
    scenarioSamplesTheMatchedPreviewCanvasOnTheGridTheOutputPageCarries,
    scenarioNamesPaperTheMatchedPreviewCanvasCannotHold,
    scenarioMatchesProvisionalPreviewsFromKnownPagesWithoutGuessingUnknownLayouts,
    scenarioLeavesEveryPageItsOwnCropWhenPageSizesAreNotMatched,
    scenarioPreviewsWithoutMatchingWhenItCannotMeasureAndMeasuresAgainNextTime,
    scenarioMeasuresUnderTheDocumentRatherThanUnderTheRequestThatAskedFirst,
    scenarioCarriesAPageTheEngineFittedBelowTheDocumentScaleAcrossTheBridge,
    scenarioRejectsAMatchedPageWhoseContentBoxDoesNotFitTheCanvasItNames,
    scenarioAnswersTheVisiblePageWhenThePrefetchThatStartedTheMeasurementIsDropped,
    scenarioKeepsTheSharedMeasurementAliveWhenALaterAwaiterIsCancelled,
    scenarioPublishesAReRenderedRasterOverADestinationAnotherRequestStillHolds,
} from '@tests/unit/electron/scanCleanupPreviewRenderingScenarios';

describe('scanCleanupPreviewRenderingTest', () => {
    it('uses the rendering owner boundary for job disposal', async () => {
        const retention = scanCleanupRasterRetention(defaultDependencies);
        const owner = scanCleanupPreviewRenderingOwner(defaultDependencies, retention);
        expect(owner).toHaveProperty('preview');
        await expect(owner.dispose()).resolves.toBeUndefined();
        await retention.dispose();
    });
    it('returns real sidecar bytes and validated metadata', async () => {
        await scenarioReturnsRealSidecarBytesAndValidatedMetadata();
    });
    it('does not upscale a proven 72-DPI raster document for its base preview', async () => {
        await scenarioDoesNotUpscaleAProven72DPIRasterDocumentForItsBasePreview();
    });
    it('bounds a physically oversized scan preview before Poppler rasterizes it', async () => {
        await scenarioBoundsAPhysicallyOversizedScanPreviewBeforePopplerRasterizesIt();
    });
    it('streams the display raster but cleans binary preview text on the source grid', async () => {
        await scenarioStreamsTheDisplayRasterButCleansBinaryPreviewTextOnTheSourceGrid();
    });
    it('renders only the requested zoom region at true output DPI within the tile budget', async () => {
        await scenarioRendersOnlyTheRequestedZoomRegionAtTrueOutputDPIWithinTheTileBudget();
    });
    it('hands the detail tile to the sidecar through the shared raster handoff', async () => {
        await scenarioHandsTheDetailTileToTheSidecarThroughTheSharedRasterHandoff();
    });
    it('keeps a recently-read base analysis while pruning a stale entry', async () => {
        await scenarioKeepsARecentlyReadBaseAnalysisWhilePruningAStaleEntry();
    });
    it('probes only the requested page for the first preview raster structure', async () => {
        await scenarioProbesOnlyTheRequestedPageForTheFirstPreviewRasterStructure();
    });
    it('keeps intrinsic page canvases when the document geometry cannot be read', async () => {
        await scenarioKeepsIntrinsicPageCanvasesWhenTheDocumentGeometryCannotBeRead();
    });
    it('presents a classified spread on a half-sheet canvas without forcing an unmeasured cut', async () => {
        await scenarioPresentsAClassifiedSpreadOnAHalfSheetCanvasWithoutForcingAnUnmeasuredCut();
    });
    it('reuses the detected output mode for an automatic preview', async () => {
        await scenarioReusesTheDetectedOutputModeForAnAutomaticPreview();
    });
    it('does not turn a canceled trusted-layer extraction into a raster fallback', async () => {
        await scenarioDoesNotTurnACanceledTrustedLayerExtractionIntoARasterFallback();
    });
    it('reuses base geometry for detail after detection resolves Auto', async () => {
        await scenarioReusesBaseGeometryForDetailAfterDetectionResolvesAuto();
    });
    it('renders a matched lossless page the final run cannot keep lossless', async () => {
        await scenarioRendersAMatchedLosslessPageTheFinalRunCannotKeepLossless();
    });
    it('keeps a matched lossless page lossless when the document shares one grid', async () => {
        await scenarioKeepsAMatchedLosslessPageLosslessWhenTheDocumentSharesOneGrid();
    });
    it('uses analysis-only output metadata for the lossless original-page preview', async () => {
        await scenarioUsesAnalysisOnlyOutputMetadataForTheLosslessOriginalPagePreview();
    });
    it('uses the pair-wide lossless fit when one spread leaf reaches the margin box', async () => {
        await scenarioUsesThePairWideLosslessFitWhenOneSpreadLeafReachesTheMarginBox();
    });
    it('reserves exact final-canvas margins in a matched lossless preview and says when content is fitted', async () => {
        await scenarioReservesExactFinalCanvasMarginsInAMatchedLosslessPreviewAndSaysWhenContentIsFitted();
    });
    it('samples the matched preview canvas on the grid the output page carries', async () => {
        await scenarioSamplesTheMatchedPreviewCanvasOnTheGridTheOutputPageCarries();
    });
    it('names paper the matched preview canvas cannot hold', async () => {
        await scenarioNamesPaperTheMatchedPreviewCanvasCannotHold();
    });
    it('matches provisional previews from known pages without guessing unknown layouts', async () => {
        await scenarioMatchesProvisionalPreviewsFromKnownPagesWithoutGuessingUnknownLayouts();
    });
    it('leaves every page its own crop when page sizes are not matched', async () => {
        await scenarioLeavesEveryPageItsOwnCropWhenPageSizesAreNotMatched();
    });
    it('previews without matching when it cannot measure, and measures again next time', async () => {
        await scenarioPreviewsWithoutMatchingWhenItCannotMeasureAndMeasuresAgainNextTime();
    });
    it('measures under the document rather than under the request that asked first', async () => {
        await scenarioMeasuresUnderTheDocumentRatherThanUnderTheRequestThatAskedFirst();
    });
    it('carries a page the engine fitted below the document scale across the bridge', async () => {
        await scenarioCarriesAPageTheEngineFittedBelowTheDocumentScaleAcrossTheBridge();
    });
    it('rejects a matched page whose content box does not fit the canvas it names', async () => {
        await scenarioRejectsAMatchedPageWhoseContentBoxDoesNotFitTheCanvasItNames();
    });
    it('answers the visible page when the prefetch that started the measurement is dropped', async () => {
        await scenarioAnswersTheVisiblePageWhenThePrefetchThatStartedTheMeasurementIsDropped();
    });
    it('keeps the shared measurement alive when a later awaiter is cancelled', async () => {
        await scenarioKeepsTheSharedMeasurementAliveWhenALaterAwaiterIsCancelled();
    });
    it('publishes a re-rendered raster over a destination another request still holds', async () => {
        await scenarioPublishesAReRenderedRasterOverADestinationAnotherRequestStillHolds();
    });
});
