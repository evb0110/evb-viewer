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
    scenarioCoalescesBackToBackIdenticalDetectionRequestsBeforeStart,
    scenarioStartsFreshIdenticalDetectionAfterCancellationIsAcknowledgedButNotTerminal,
    scenarioCancelsDetectAllWhenTheOwningRendererIsDestroyed,
    scenarioDoesNotDeliverTerminalDetectionStateAfterARendererIsDestroyed,
    scenarioRetainsBorrowedCompletedEvidenceUntilTheRendererOwnerCloses,
    scenarioDoesNotReleaseCompletedEvidenceWhenCancelIsRepeated,
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
            ownerKey: ownerId,
            resultStore: store,
            sourcePdfPath,
        });
        const retention = scanCleanupRasterRetention(defaultDependencies);
        const owner = scanCleanupDetectionOwner(defaultDependencies, retention);
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
    const scenarios = [
        [
            'publish provisional results before reconciliation',
            scenarioPublishesProvisionalPageResultsBeforeDocumentReconciliationCompletes,
        ],
        [
            'stage replayable rasters before native analysis',
            scenarioStagesEveryReplayableDetectionRasterBeforeNativeAnalysisBegins,
        ],
        [
            'remove temporary rasters after native failure',
            scenarioRemovesTemporaryDetectionRasterPathsWhenNativeAnalysisFails,
        ],
        [
            'settle abort during native analysis',
            scenarioDoesNotHangWhenDetectionAbortsDuringNativeAnalysis,
        ],
        [
            'reconcile the whole document',
            scenarioReconcilesEveryDetectionClassificationAgainstTheWholeDocumentNotAWindowOfIt,
        ],
        [
            'rasterize detection pages to disk',
            scenarioRasterizesDetectionPagesStraightToDiskInsteadOfBufferingThem,
        ],
        [
            'use the canonical detection grid',
            scenarioAnalyzesEveryPageOnTheSameCanonical150DPIGridAsFinalRendering,
        ],
        [
            'reuse a detection raster without a second page count',
            scenarioPreviewsAPageDetectionRasterizedWithoutARendererAndWithoutASecondPageCount,
        ],
        [
            'hand brokered rasters to later previews',
            scenarioStreamsABrokeredDetectAllLifecycleAndHandsItsRastersToLaterPreviewRequests,
        ],
        [
            'lease the host-wide raster width',
            scenarioRasterizesDetectionPagesAsWideAsThe11CoreHostAllowsAndLeasesThatWidth,
        ],
        [
            'admit the classifier sidecar',
            scenarioIncludesTheClassifierSidecarInStreamingDetectionAdmission,
        ],
        [
            'fall back when streaming cannot be admitted',
            scenarioFallsBackFromRasterStreamingUntilBrokerCapacityCanAdmitItsSidecar,
        ],
        [
            'emit each detection classification once',
            scenarioStreamsEveryDetectionClassificationToTheSubscriberExactlyOnce,
        ],
        [
            'bound xlarge renderer payloads',
            scenarioKeepsXlargeDetectionEventPayloadsWithinTheRendererPageWindow,
        ],
        [
            'redetect changed pages over held rasters',
            scenarioReDetectsAChangedPageOverTheRastersItAlreadyHoldsPageForPage,
        ],
        [
            'rasterize only pages retention released',
            scenarioRasterizesOnlyThePagesRetentionNoLongerHoldsAndStillReconcilesOverTheWholeDocument,
        ],
        [
            'cancel and remove detection scratch',
            scenarioCancelsDetectAllThroughItsSignalAndRemovesItsScratchArtifacts,
        ],
        [
            'join and replace same-owner work',
            scenarioJoinsIdenticalDetectionWorkAndReplacesAChangedRequestForTheSameOwner,
        ],
        [
            'coalesce identical work before start',
            scenarioCoalescesBackToBackIdenticalDetectionRequestsBeforeStart,
        ],
        [
            'start fresh after acknowledged cancellation',
            scenarioStartsFreshIdenticalDetectionAfterCancellationIsAcknowledgedButNotTerminal,
        ],
        [
            'cancel on renderer destruction',
            scenarioCancelsDetectAllWhenTheOwningRendererIsDestroyed,
        ],
        [
            'suppress terminal delivery after destruction',
            scenarioDoesNotDeliverTerminalDetectionStateAfterARendererIsDestroyed,
        ],
        [
            'retain completed evidence until owner close',
            scenarioRetainsBorrowedCompletedEvidenceUntilTheRendererOwnerCloses,
        ],
        [
            'keep repeated cancellation idempotent',
            scenarioDoesNotReleaseCompletedEvidenceWhenCancelIsRepeated,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
