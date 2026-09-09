import {
    describe,
    it,
    expect,
} from 'vitest';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import {
    scenarioDoesNotReadTheFullRetainedPNGWhenAProcessingRasterIsPathOnly,
    scenarioSurfacesACorruptRetainedPathOnlyRasterWithoutSilentlyRerenderingIt,
    scenarioRemovesAPathOnlyRasterCanceledAfterRenderingAndBeforeRetention,
    scenarioNeverUnlinksAnAdoptedRasterHoweverOftenItsSlotIsGivenBack,
    scenarioServesRasterPageReadsFromAForkedPageSizeStoreWithoutTouchingTheParentCursor,
    scenarioSerializesConcurrentRasterPageReadsOnACursorOnlyPageSizeStore,
    scenarioCoalescesSerializedRasterFactsIntoBoundedNativeBatches,
    scenarioOpensBoundedPageGeometryAndRasterFactsWithoutTheLegacyArrays,
    scenarioBoundsSourceDPIMeasurementsWhilePreservingRecentPageValues,
    scenarioPlansABoundedMatchedPreviewFromChunkedGeometryAndPageRasterMetadata,
    scenarioCoalescesFallbackRasterProbesIntoBoundedStreamingWindows,
    scenarioKeepsConcurrentRasterPageWindowsIsolatedForACursorOnlyPageSizeStore,
    scenarioRefusesAnImplicitAllPageLegacyRasterProbeForMillionPageDocuments,
    scenarioRefusesLegacyArrayGeometryForMillionPagePreviews,
    scenarioStopsProtectingAnAdoptedRasterOnceTheIndexHasForgottenIt,
    scenarioKeepsAStagedRasterAPreviewAdoptedWhileDetectionRecyclesItsSlot,
    scenarioKeepsARasterItsSidecarIsReadingWhenTheSamePageIsRetainedAgain,
    scenarioProtectsPageReleaseAcrossOwnerClaimsAndHeldReads,
    scenarioPreservesAnotherOwnersRasterWhenPublicationIsCanceled,
    scenarioReleasesClaimAfterExceptionalRetainedByteRead,
    scenarioReleasesClaimAfterExceptionalRetainedMetadataRead,
} from '@tests/unit/electron/scanCleanupRasterRetentionScenarios';

describe('scanCleanupRasterRetentionTest', () => {
    it('exposes its retention boundary as the live raw-raster owner', async () => {
        const owner = scanCleanupRasterRetention(defaultDependencies);
        expect(owner).toHaveProperty('retain');
        await expect(owner.dispose()).resolves.toBeUndefined();
    });
    it('does not read the full retained PNG when a processing raster is path-only', async () => {
        await scenarioDoesNotReadTheFullRetainedPNGWhenAProcessingRasterIsPathOnly();
    });
    it('surfaces a corrupt retained path-only raster without silently rerendering it', async () => {
        await scenarioSurfacesACorruptRetainedPathOnlyRasterWithoutSilentlyRerenderingIt();
    });
    it('removes a path-only raster canceled after rendering and before retention', async () => {
        await scenarioRemovesAPathOnlyRasterCanceledAfterRenderingAndBeforeRetention();
    });
    it('never unlinks an adopted raster however often its slot is given back', async () => {
        await scenarioNeverUnlinksAnAdoptedRasterHoweverOftenItsSlotIsGivenBack();
    });
    it('serves raster page reads from a forked page-size store without touching the parent cursor', async () => {
        await scenarioServesRasterPageReadsFromAForkedPageSizeStoreWithoutTouchingTheParentCursor();
    });
    it('serializes concurrent raster page reads on a cursor-only page-size store', async () => {
        await scenarioSerializesConcurrentRasterPageReadsOnACursorOnlyPageSizeStore();
    });
    it('coalesces serialized raster facts into bounded native batches', async () => {
        await scenarioCoalescesSerializedRasterFactsIntoBoundedNativeBatches();
    });
    it('opens bounded page geometry and raster facts without the legacy arrays', async () => {
        await scenarioOpensBoundedPageGeometryAndRasterFactsWithoutTheLegacyArrays();
    });
    it('bounds source-DPI measurements while preserving recent page values', async () => {
        await scenarioBoundsSourceDPIMeasurementsWhilePreservingRecentPageValues();
    });
    it('plans a bounded matched preview from chunked geometry and page raster metadata', async () => {
        await scenarioPlansABoundedMatchedPreviewFromChunkedGeometryAndPageRasterMetadata();
    });
    it('coalesces fallback raster probes into bounded streaming windows', async () => {
        await scenarioCoalescesFallbackRasterProbesIntoBoundedStreamingWindows();
    });
    it('keeps concurrent raster page windows isolated for a cursor-only page-size store', async () => {
        await scenarioKeepsConcurrentRasterPageWindowsIsolatedForACursorOnlyPageSizeStore();
    });
    it('refuses an implicit all-page legacy raster probe for million-page documents', async () => {
        await scenarioRefusesAnImplicitAllPageLegacyRasterProbeForMillionPageDocuments();
    });
    it('refuses legacy array geometry for million-page previews', async () => {
        await scenarioRefusesLegacyArrayGeometryForMillionPagePreviews();
    });
    it('stops protecting an adopted raster once the index has forgotten it', async () => {
        await scenarioStopsProtectingAnAdoptedRasterOnceTheIndexHasForgottenIt();
    });
    it('keeps a staged raster a preview adopted while detection recycles its slot', async () => {
        await scenarioKeepsAStagedRasterAPreviewAdoptedWhileDetectionRecyclesItsSlot();
    });
    it('keeps a raster its sidecar is reading when the same page is retained again', async () => {
        await scenarioKeepsARasterItsSidecarIsReadingWhenTheSamePageIsRetainedAgain();
    });
    it('protects page release across owner claims and held reads', async () => {
        await scenarioProtectsPageReleaseAcrossOwnerClaimsAndHeldReads();
    });
    it('preserves another owner\'s raster when publication is canceled', async () => {
        await scenarioPreservesAnotherOwnersRasterWhenPublicationIsCanceled();
    });
    it('releases a claim after an exceptional retained byte read', async () => {
        await scenarioReleasesClaimAfterExceptionalRetainedByteRead();
    });
    it('releases a claim after an exceptional retained metadata read', async () => {
        await scenarioReleasesClaimAfterExceptionalRetainedMetadataRead();
    });
});
