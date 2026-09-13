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
    const scenarios = [
        [
            'return real sidecar bytes and metadata',
            scenarioReturnsRealSidecarBytesAndValidatedMetadata,
        ],
        [
            'avoid upscaling a proven 72-DPI document',
            scenarioDoesNotUpscaleAProven72DPIRasterDocumentForItsBasePreview,
        ],
        [
            'bound an oversized raster before Poppler',
            scenarioBoundsAPhysicallyOversizedScanPreviewBeforePopplerRasterizesIt,
        ],
        [
            'stream display raster and clean source-grid text',
            scenarioStreamsTheDisplayRasterButCleansBinaryPreviewTextOnTheSourceGrid,
        ],
        [
            'render a bounded detail region',
            scenarioRendersOnlyTheRequestedZoomRegionAtTrueOutputDPIWithinTheTileBudget,
        ],
        [
            'handoff detail through shared raster retention',
            scenarioHandsTheDetailTileToTheSidecarThroughTheSharedRasterHandoff,
        ],
        [
            'retain recent base analysis while pruning stale entries',
            scenarioKeepsARecentlyReadBaseAnalysisWhilePruningAStaleEntry,
        ],
        [
            'probe only the requested page first',
            scenarioProbesOnlyTheRequestedPageForTheFirstPreviewRasterStructure,
        ],
        [
            'keep intrinsic canvases without geometry',
            scenarioKeepsIntrinsicPageCanvasesWhenTheDocumentGeometryCannotBeRead,
        ],
        [
            'present classified spreads on half-sheet canvas',
            scenarioPresentsAClassifiedSpreadOnAHalfSheetCanvasWithoutForcingAnUnmeasuredCut,
        ],
        [
            'reuse detected output mode',
            scenarioReusesTheDetectedOutputModeForAnAutomaticPreview,
        ],
        [
            'stop canceled trusted extraction',
            scenarioDoesNotTurnACanceledTrustedLayerExtractionIntoARasterFallback,
        ],
        [
            'reuse base geometry for detail',
            scenarioReusesBaseGeometryForDetailAfterDetectionResolvesAuto,
        ],
        [
            'render matched lossless page with fallback',
            scenarioRendersAMatchedLosslessPageTheFinalRunCannotKeepLossless,
        ],
        [
            'keep matched lossless page lossless',
            scenarioKeepsAMatchedLosslessPageLosslessWhenTheDocumentSharesOneGrid,
        ],
        [
            'use analysis-only lossless metadata',
            scenarioUsesAnalysisOnlyOutputMetadataForTheLosslessOriginalPagePreview,
        ],
        [
            'fit lossless spread pair-wide',
            scenarioUsesThePairWideLosslessFitWhenOneSpreadLeafReachesTheMarginBox,
        ],
        [
            'reserve exact matched margins',
            scenarioReservesExactFinalCanvasMarginsInAMatchedLosslessPreviewAndSaysWhenContentIsFitted,
        ],
        [
            'sample the carried output grid',
            scenarioSamplesTheMatchedPreviewCanvasOnTheGridTheOutputPageCarries,
        ],
        [
            'name paper outside the canvas',
            scenarioNamesPaperTheMatchedPreviewCanvasCannotHold,
        ],
        [
            'match provisional known-page previews',
            scenarioMatchesProvisionalPreviewsFromKnownPagesWithoutGuessingUnknownLayouts,
        ],
        [
            'keep separate crops without matching',
            scenarioLeavesEveryPageItsOwnCropWhenPageSizesAreNotMatched,
        ],
        [
            'retry measurement after fallback',
            scenarioPreviewsWithoutMatchingWhenItCannotMeasureAndMeasuresAgainNextTime,
        ],
        [
            'measure under the document owner',
            scenarioMeasuresUnderTheDocumentRatherThanUnderTheRequestThatAskedFirst,
        ],
        [
            'carry engine fit across the bridge',
            scenarioCarriesAPageTheEngineFittedBelowTheDocumentScaleAcrossTheBridge,
        ],
        [
            'reject content outside its named canvas',
            scenarioRejectsAMatchedPageWhoseContentBoxDoesNotFitTheCanvasItNames,
        ],
        [
            'answer visible page after prefetch drop',
            scenarioAnswersTheVisiblePageWhenThePrefetchThatStartedTheMeasurementIsDropped,
        ],
        [
            'keep shared measurement for another awaiter',
            scenarioKeepsTheSharedMeasurementAliveWhenALaterAwaiterIsCancelled,
        ],
        [
            'publish over a held destination safely',
            scenarioPublishesAReRenderedRasterOverADestinationAnotherRequestStillHolds,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
