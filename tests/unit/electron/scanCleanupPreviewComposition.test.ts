import {
    describe,
    it,
    expect,
} from 'vitest';
import {
    lstat,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {
    resolveScanCleanupPreviewRasterSlotResidentBytes,
    type TScanCleanupRasterBudgetOptions,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {
    scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt,
    scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime,
    scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode,
    scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering,
    scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants,
    scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation,
    scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview,
    scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation,
    scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation,
    scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath,
    scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision,
    scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated,
    scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails,
    scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges,
    scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision,
    scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument,
    scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate,
    scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit,
    scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt,
    scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes,
    scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization,
    scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost,
    scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument,
    scenarioTrustedMrcAutomaticBwPreview,
    scenarioTrustedMrcExplicitBwPreview,
    scenarioRasterCanvasCacheOrderIndependence,
    scenarioLosslessCanvasCacheOrderIndependence,
    scenarioDestroyedInFlightCancellation,
    scenarioRenderProcessGoneInFlightCancellation,
    scenarioReleasesPreviewArtifactsAfterExplicitCancellation,
    scenarioReleasesPreviewArtifactsWhenItsWorkingCopyCloses,
    scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem,
} from '@tests/unit/electron/scanCleanupPreviewCompositionScenarios';

describe('scanCleanupPreviewCompositionTest', () => {
    it('composes the public owners and exposes their disposal handoff', async () => {
        const composition = scanCleanupPreviewLifecycle(defaultDependencies);
        expect(composition).toHaveProperty('preview');
        expect(composition).toHaveProperty('detectAll');
        await expect(composition.dispose()).resolves.toBeUndefined();
    });
    it('keeps the native, filesystem, and policy capabilities composed at one boundary', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-defaults-test-'));
        try {
            const sourcePath = join(scratch, 'source.pdf');
            await writeFile(sourcePath, 'fixture');
            const entries = await defaultDependencies.fileSystem!.readdir(scratch, {withFileTypes: true});
            expect(entries.map(entry => entry.name)).toEqual(['source.pdf']);
            await expect(defaultDependencies.getSourceStatIdentity!(sourcePath)).resolves.toMatch(/^\d+:\d+$/u);
            expect(defaultDependencies.getPageSizes).toBeUndefined();
            expect(defaultDependencies.getPageSizeStore).toBeDefined();
            const rasterPolicy = defaultDependencies.resolveRasterAdmissionPolicy(true);
            expect(rasterPolicy.rasterConcurrency).toBeGreaterThan(0);
            const signal = new AbortController().signal;
            if (process.platform !== 'win32') {
                const pipePath = join(scratch, 'detection.pipe');
                await defaultDependencies.createRasterPipes!([pipePath], signal, () => undefined);
                expect((await lstat(pipePath)).isFIFO()).toBe(true);
            }
            const detectionLease = await defaultDependencies.acquireDetectionLease!(
                'scan-cleanup-defaults-test',
                signal,
                rasterPolicy,
            );
            expect(detectionLease.release()).toBe(true);
            const previewLease = await defaultDependencies.acquirePreviewLease!(
                'scan-cleanup-defaults-test',
                'visible',
                signal,
            );
            expect(previewLease.release()).toBe(true);
            expect(defaultDependencies.resolvePageOpsBinary()).toSatisfy(
                value => value === null || typeof value === 'string',
            );
            expect(defaultDependencies.resolveQpdfBinary!()).toEqual(expect.any(String));
            expect(defaultDependencies.resolvePdfInfoBinary!()).toEqual(expect.any(String));
            expect(defaultDependencies.getPdftoppmBinary()).toEqual(expect.any(String));
            expect(defaultDependencies.isRasterDetectionAvailable!()).toBeTypeOf('boolean');
            await expect(readFile(sourcePath, 'utf8')).resolves.toBe('fixture');
        } finally {
            await rm(scratch, {
                recursive: true,
                force: true,
            });
        }
    });
    it('derives raster residency from the configured canvas pixel budget', () => {
        const bilevel: TScanCleanupRasterBudgetOptions = {
            preserveOriginalQuality: false,
            outputMode: 'bw',
            pageOverrides: {},
        };
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes(bilevel)).toBe(640_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            outputMode: 'color',
        }))
            .toBe(320_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            preserveOriginalQuality: true,
        }))
            .toBe(320_000_000);
    });
    const scenarios = [
        [
            'visible beside adjacent prefetch',
            scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt,
        ],
        [
            'adopt identical in-flight preview',
            scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime,
        ],
        [
            'supersede Auto preview after detection',
            scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode,
        ],
        [
            'supersede stale options generation',
            scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering,
        ],
        [
            'cancel pages outside navigation window',
            scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants,
        ],
        [
            'retain navigation raster until full cancellation',
            scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation,
        ],
        [
            'keep detail in its own lane',
            scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview,
        ],
        [
            'fence invalidated raw raster publication',
            scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation,
        ],
        [
            'fence invalidated base geometry publication',
            scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation,
        ],
        [
            'abort when the source path changes',
            scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath,
        ],
        [
            'abort when the revision changes',
            scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision,
        ],
        [
            'reuse raw raster until session invalidation',
            scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated,
        ],
        [
            'publish raw raster before cleaned failure',
            scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails,
        ],
        [
            'invalidate stale raster on revision change',
            scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges,
        ],
        [
            'invalidate stale raster on source change',
            scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision,
        ],
        [
            'isolate two windows on one document',
            scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument,
        ],
        [
            'keep a late replacement reachable',
            scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate,
        ],
        [
            'readmit adopted prefetch',
            scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit,
        ],
        [
            'drop a prefetch that cannot be admitted',
            scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt,
        ],
        [
            'cancel during working-copy materialization',
            scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes,
        ],
        [
            'settle after working-copy retirement',
            scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization,
        ],
        [
            'schedule a page switch during detection',
            scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost,
        ],
        [
            'admit visible preview ahead of prefetch',
            scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument,
        ],
        [
            'preserve two-owner resources through cancellation',
            scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});

describe('parameterized fixture executions', () => {
    const scenarios = [
        [
            'forward trusted MRC layers for automatic B/W',
            scenarioTrustedMrcAutomaticBwPreview,
        ],
        [
            'forward trusted MRC layers for explicit B/W',
            scenarioTrustedMrcExplicitBwPreview,
        ],
        [
            'keep raster canvas cache order independent',
            scenarioRasterCanvasCacheOrderIndependence,
        ],
        [
            'keep lossless canvas cache order independent',
            scenarioLosslessCanvasCacheOrderIndependence,
        ],
        [
            'cancel active work on destroyed',
            scenarioDestroyedInFlightCancellation,
        ],
        [
            'cancel active work on render-process-gone',
            scenarioRenderProcessGoneInFlightCancellation,
        ],
        [
            'release artifacts after explicit cancellation',
            scenarioReleasesPreviewArtifactsAfterExplicitCancellation,
        ],
        [
            'release artifacts when working copy closes',
            scenarioReleasesPreviewArtifactsWhenItsWorkingCopyCloses,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
