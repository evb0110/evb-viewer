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
    scenarioRetiresSupersededDocumentsForSameSourcePath,
    scenarioReleasesClaimAfterExceptionalRetainedByteRead,
    scenarioReleasesClaimAfterExceptionalRetainedMetadataRead,
} from '@tests/unit/electron/scanCleanupRasterRetentionScenarios';

describe('scanCleanupRasterRetentionTest', () => {
    it('exposes its retention boundary as the live raw-raster owner', async () => {
        const owner = scanCleanupRasterRetention(defaultDependencies);
        expect(owner).toHaveProperty('retain');
        await expect(owner.dispose()).resolves.toBeUndefined();
    });
    const scenarios = [
        [
            'avoid reading path-only processing PNGs',
            scenarioDoesNotReadTheFullRetainedPNGWhenAProcessingRasterIsPathOnly,
        ],
        [
            'surface corrupt path-only rasters',
            scenarioSurfacesACorruptRetainedPathOnlyRasterWithoutSilentlyRerenderingIt,
        ],
        [
            'remove a canceled path-only raster',
            scenarioRemovesAPathOnlyRasterCanceledAfterRenderingAndBeforeRetention,
        ],
        [
            'preserve adopted rasters across slot release',
            scenarioNeverUnlinksAnAdoptedRasterHoweverOftenItsSlotIsGivenBack,
        ],
        [
            'serve forked page-size reads',
            scenarioServesRasterPageReadsFromAForkedPageSizeStoreWithoutTouchingTheParentCursor,
        ],
        [
            'serialize cursor-only page reads',
            scenarioSerializesConcurrentRasterPageReadsOnACursorOnlyPageSizeStore,
        ],
        [
            'coalesce bounded native raster batches',
            scenarioCoalescesSerializedRasterFactsIntoBoundedNativeBatches,
        ],
        [
            'open bounded geometry without legacy arrays',
            scenarioOpensBoundedPageGeometryAndRasterFactsWithoutTheLegacyArrays,
        ],
        [
            'bound source-DPI measurements',
            scenarioBoundsSourceDPIMeasurementsWhilePreservingRecentPageValues,
        ],
        [
            'plan bounded matched previews',
            scenarioPlansABoundedMatchedPreviewFromChunkedGeometryAndPageRasterMetadata,
        ],
        [
            'coalesce fallback raster probes',
            scenarioCoalescesFallbackRasterProbesIntoBoundedStreamingWindows,
        ],
        [
            'isolate concurrent page windows',
            scenarioKeepsConcurrentRasterPageWindowsIsolatedForACursorOnlyPageSizeStore,
        ],
        [
            'reject implicit million-page probes',
            scenarioRefusesAnImplicitAllPageLegacyRasterProbeForMillionPageDocuments,
        ],
        [
            'reject million-page legacy geometry',
            scenarioRefusesLegacyArrayGeometryForMillionPagePreviews,
        ],
        [
            'stop protecting forgotten adopted rasters',
            scenarioStopsProtectingAnAdoptedRasterOnceTheIndexHasForgottenIt,
        ],
        [
            'preserve a preview-adopted staged raster',
            scenarioKeepsAStagedRasterAPreviewAdoptedWhileDetectionRecyclesItsSlot,
        ],
        [
            'preserve a raster held by a sidecar',
            scenarioKeepsARasterItsSidecarIsReadingWhenTheSamePageIsRetainedAgain,
        ],
        [
            'protect page release across owner claims',
            scenarioProtectsPageReleaseAcrossOwnerClaimsAndHeldReads,
        ],
        [
            'preserve another owner during canceled publication',
            scenarioPreservesAnotherOwnersRasterWhenPublicationIsCanceled,
        ],
        [
            'retire superseded documents for one source path',
            scenarioRetiresSupersededDocumentsForSameSourcePath,
        ],
        [
            'release claims after byte-read failure',
            scenarioReleasesClaimAfterExceptionalRetainedByteRead,
        ],
        [
            'release claims after metadata-read failure',
            scenarioReleasesClaimAfterExceptionalRetainedMetadataRead,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
