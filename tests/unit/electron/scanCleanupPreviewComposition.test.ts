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
    it('lets a visible request run beside the adjacent prefetch instead of aborting it', async () => {
        await scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt();
    });
    it('adopts an identical in-flight preview instead of rendering the page a second time', async () => {
        await scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime();
    });
    it('supersedes an in-flight Auto preview when detection resolves another output mode', async () => {
        await scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode();
    });
    it('supersedes a stale options generation for the page it is rendering', async () => {
        await scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering();
    });
    it('cancels only the preview pages a navigation no longer wants', async () => {
        await scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants();
    });
    it('leaves the raster of a retained navigation alone and retires it on a full cancellation', async () => {
        await scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation();
    });
    it('runs detail tiles in a separate lane that never cancels the visible base preview', async () => {
        await scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview();
    });
    it('does not republish an invalidated raw raster after its renderer ignores cancellation', async () => {
        await scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation();
    });
    it('does not republish invalidated base geometry after its sidecar ignores cancellation', async () => {
        await scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation();
    });
    it('aborts a cleaned request when the same owner moves to another source path', async () => {
        await scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath();
    });
    it('aborts an in-flight request when the same owner moves to another document revision', async () => {
        await scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision();
    });
    it('reuses the raw page raster across option changes until the dialog session is invalidated', async () => {
        await scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated();
    });
    it('has already published the raw page when cleaned rendering fails', async () => {
        await scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails();
    });
    it('invalidates a stale raw raster when the document revision changes', async () => {
        await scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges();
    });
    it('invalidates a stale raw raster when the source bytes change under an unchanged revision', async () => {
        await scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision();
    });
    it('does not cross-cancel previews from two windows on the same document', async () => {
        await scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument();
    }, 15_000);
    it('keeps a live replacement reachable when an older generation retires late', async () => {
        await scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate();
    });
    it('readmits an adopted prefetch as the visible page and drops one nothing can admit', async () => {
        await scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit();
    });
    it('drops a prefetch nothing admits instead of leaving the page committed to it', async () => {
        await scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt();
    });
    it('does not queue for a preview lease when the run is canceled while its working copy materializes', async () => {
        await scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes();
    });
    it('settles a canceled preview when its working-copy registration disappears during materialization', async () => {
        await scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization();
    });
    it('schedules a page switch during detection instead of piling native processes onto the host', async () => {
        await scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost();
    });
    it('leases a visible preview ahead of a prefetch of the same document', async () => {
        await scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument();
    });
    it('keeps owner two resources usable while owner one cancels, then disposes them', async () => {
        await scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem();
    }, 15_000);
});

describe('parameterized fixture executions', () => {
    it('forwards trusted MRC layers for automatic B/W', async () => {
        await scenarioTrustedMrcAutomaticBwPreview();
    });
    it('forwards trusted MRC layers for explicit B/W', async () => {
        await scenarioTrustedMrcExplicitBwPreview();
    });
    it('uses a cache-order-independent raster canvas', async () => {
        await scenarioRasterCanvasCacheOrderIndependence();
    });
    it('uses a cache-order-independent lossless canvas', async () => {
        await scenarioLosslessCanvasCacheOrderIndependence();
    });
    it('cancels active work on destroyed', async () => {
        await scenarioDestroyedInFlightCancellation();
    });
    it('cancels active work on render-process-gone', async () => {
        await scenarioRenderProcessGoneInFlightCancellation();
    });
});
