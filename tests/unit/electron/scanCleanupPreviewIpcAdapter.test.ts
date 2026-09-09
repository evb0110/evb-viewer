import {
    describe,
    it,
    expect,
    vi,
} from 'vitest';
import type {IpcMainInvokeEvent} from 'electron';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {registerPlatformFeatureHandlers} from '@electron/platform-ipc/validatedIpcRegistrar';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {
    createFeatureRegistrarCases,
    createValidatedRegistrarHarness,
    getCapturedIpcHandler,
    createHarnessEvent,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';
import {
    scenarioPreservesFoldClippingThroughNativeArtifactAndIPCCodecBoundaries,
    scenarioAcceptsFourInRangeMarginsAndRejectsInvalidOrIncompleteMarginShapes,
    scenarioRoundTripsNormalizedOverrideGeometryThroughTheIPCCodec,
    scenarioValidatesHighDetailViewportRequests,
    scenarioValidatesTheRetainedNavigationWindowOnAPreviewCancellation,
    scenarioSerializesNestedReactivePageOverridesForEveryIPCRequest,
    scenarioRejectsAsymmetricStartErrorsAndImpossibleJobProgress,
    scenarioDemandMaterializesLazyOriginalInputBeforeScanCleanupPreview,
    scenarioCancelsPreviewWorkWhoseWorkingCopyRegistrationWasRetired,
    scenarioReportsPreviewWorkForASourceThisOwnerNeverHeldAsAFailure,
    scenarioSerializesNativePreviewErrorCodesThroughTheMessageOnlyIPCBoundary,
    scenarioSkipsMaterializationForQueuedPreviewWorkCanceledBeforeItDequeues,
    scenarioKeepsEagerScanCleanupPreviewPathsUnchanged,
    scenarioAcceptsUnboundedNonnegativeSkewEvidenceAndRejectsInvalidValuesAtBothMetadataBoundaries,
    scenarioValidatesAdditiveRenderRegionMetadataAgainstTheFullIntrinsicOutput,
    scenarioRejectsOversizedEncodedImageResponsesAtTheIPCBoundary,
    scenarioRejectsLayoutConfidenceOutsideTheUnitIntervalAtTheIPCBoundary,
    scenarioRejectsMalformedCleanupDiagnosticFlagsAtTheIPCBoundary,
    scenarioRejectsNonNumericRotationsAndUnsafePixelGeometryAtTheIPCBoundary,
    scenarioRequiresNamedFiniteAppliedMarginsAtTheIPCBoundary,
    scenarioRejectsFullyOffCanvasAndInconsistentIntrinsicOverflowIntervalsAtTheIPCBoundary,
    scenarioAcceptsOptionalDetectionTextAxisAndRecommendationReasonsAndRejectsMalformedValues,
    scenarioKeepsTheOwnerListenersUntilItsLastPreviewJobEnds,
    scenarioCancelsAPreviewImmediatelyWhenItsWebContentsIsAlreadyDestroyed,
} from '@tests/unit/electron/scanCleanupPreviewIpcScenarios';

const trustedSender = vi.hoisted(() => ({
    isTrustedIpcInvokeSender: vi.fn(() => true),
    isTrustedWebContentsSender: vi.fn(() => true),
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => trustedSender);

describe('scanCleanupPreviewIpcAdapterTest', () => {
    it('crosses the descriptor-built Electron platform fixture with scan-cleanup methods', async () => {
        const preview = vi.fn();
        const cancelPreview = vi.fn();
        const api = createElectronPlatformApiFixture({scanCleanup: {
            preview,
            cancelPreview,
        }});
        const cases = createFeatureRegistrarCases(SCAN_CLEANUP_PLATFORM_FEATURE);
        const previewArgs = cases.find(testCase => testCase.channel === SCAN_CLEANUP_PLATFORM_FEATURE.methods.preview.channel)!.validArgs;
        const cancelArgs = cases.find(testCase => testCase.channel === SCAN_CLEANUP_PLATFORM_FEATURE.methods.cancelPreview.channel)!.validArgs;
        const expectedPreview = SCAN_CLEANUP_PLATFORM_FEATURE.methods.preview.ipc.result.example();
        preview.mockResolvedValue(expectedPreview);
        cancelPreview.mockResolvedValue(true);

        await expect(api.scanCleanup!.preview(...previewArgs)).resolves.toEqual(expectedPreview);
        await expect(api.scanCleanup!.cancelPreview(...cancelArgs)).resolves.toBe(true);
        expect(preview).toHaveBeenCalledWith(...previewArgs);
        expect(cancelPreview).toHaveBeenCalledWith(...cancelArgs);
    });

    it('invokes the captured scan-cleanup handlers through the validated boundary', async () => {
        const previewResult = SCAN_CLEANUP_PLATFORM_FEATURE.methods.preview.ipc.result.example();
        const cancelResult = SCAN_CLEANUP_PLATFORM_FEATURE.methods.cancelPreview.ipc.result.example();
        type TScanCleanupBindings = TFeatureMainBindings<typeof SCAN_CLEANUP_PLATFORM_FEATURE, IpcMainInvokeEvent>;
        const preview = vi.fn<TScanCleanupBindings['preview']>(async () => previewResult);
        const cancelPreview = vi.fn<TScanCleanupBindings['cancelPreview']>(async () => cancelResult);
        const bindings: TScanCleanupBindings = {
            preview,
            cancelPreview,
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            getSettings: vi.fn(),
            updateSettings: vi.fn(),
        };
        const handlers = createValidatedRegistrarHarness({
            channels: SCAN_CLEANUP_PLATFORM_FEATURE.invokeChannels,
            codecs: SCAN_CLEANUP_PLATFORM_FEATURE.ipcCodecs,
            register: (registrar, service) => {
                const registrarAdapter: Parameters<typeof registerPlatformFeatureHandlers>[0] = {handle: (channel, handler) => {
                    Reflect.apply(registrar.handle, registrar, [
                        channel,
                        handler,
                    ]);
                }};
                registerPlatformFeatureHandlers(registrarAdapter, SCAN_CLEANUP_PLATFORM_FEATURE, service);
            },
            service: bindings,
        });

        const previewChannel = SCAN_CLEANUP_PLATFORM_FEATURE.methods.preview.channel;
        const cancelChannel = SCAN_CLEANUP_PLATFORM_FEATURE.methods.cancelPreview.channel;
        const previewHandler = getCapturedIpcHandler(handlers, previewChannel);
        const cancelHandler = getCapturedIpcHandler(handlers, cancelChannel);
        expect(previewHandler).toBeTypeOf('function');
        expect(cancelHandler).toBeTypeOf('function');
        const previewCase = createFeatureRegistrarCases(SCAN_CLEANUP_PLATFORM_FEATURE)
            .find(testCase => testCase.channel === previewChannel)!;
        const cancelCase = createFeatureRegistrarCases(SCAN_CLEANUP_PLATFORM_FEATURE)
            .find(testCase => testCase.channel === cancelChannel)!;
        const event = createHarnessEvent(41);
        trustedSender.isTrustedIpcInvokeSender.mockReturnValue(true);
        await expect(previewHandler(event, ...previewCase.validArgs)).resolves.toEqual(previewResult);
        await expect(cancelHandler(event, ...cancelCase.validArgs)).resolves.toEqual(cancelResult);
        expect(preview).toHaveBeenCalledWith(
            {
                sender: event.sender,
                senderId: event.sender.id,
            },
            ...previewCase.validArgs,
        );
        expect(cancelPreview).toHaveBeenCalledWith(
            {
                sender: event.sender,
                senderId: event.sender.id,
            },
            ...cancelCase.validArgs,
        );
        expect(preview.mock.calls[0]?.[0].sender).toBe(event.sender);
        expect(cancelPreview.mock.calls[0]?.[0].sender).toBe(event.sender);

        preview.mockClear();
        cancelPreview.mockClear();
        await expect(previewHandler(event, Symbol('malformed'))).rejects.toThrow(
            `Invalid IPC arguments for ${previewChannel}`,
        );
        await expect(cancelHandler(event, Symbol('malformed'))).rejects.toThrow(
            `Invalid IPC arguments for ${cancelChannel}`,
        );
        await expect(previewHandler(event, ...previewCase.validArgs, Symbol('trailing'))).rejects.toThrow(
            `Invalid IPC arguments for ${previewChannel}`,
        );
        await expect(cancelHandler(event, ...cancelCase.validArgs, Symbol('trailing'))).rejects.toThrow(
            `Invalid IPC arguments for ${cancelChannel}`,
        );
        expect(preview).not.toHaveBeenCalled();
        expect(cancelPreview).not.toHaveBeenCalled();

        trustedSender.isTrustedIpcInvokeSender.mockReturnValue(false);
        await expect(previewHandler(createHarnessEvent(99), ...previewCase.validArgs)).rejects.toThrow(
            'IPC sender is not trusted',
        );
        await expect(cancelHandler(createHarnessEvent(99), ...cancelCase.validArgs)).rejects.toThrow(
            'IPC sender is not trusted',
        );
        expect(preview).not.toHaveBeenCalled();
        expect(cancelPreview).not.toHaveBeenCalled();
    });

    it('preserves fold clipping through native artifact and IPC codec boundaries', async () => {

        await scenarioPreservesFoldClippingThroughNativeArtifactAndIPCCodecBoundaries();

    });
    it('accepts four in-range margins and rejects invalid or incomplete margin shapes', async () => {
        await scenarioAcceptsFourInRangeMarginsAndRejectsInvalidOrIncompleteMarginShapes();
    });
    it('round-trips normalized override geometry through the IPC codec', async () => {
        await scenarioRoundTripsNormalizedOverrideGeometryThroughTheIPCCodec();
    });
    it('validates high-detail viewport requests', async () => {
        await scenarioValidatesHighDetailViewportRequests();
    });
    it('validates the retained navigation window on a preview cancellation', async () => {
        await scenarioValidatesTheRetainedNavigationWindowOnAPreviewCancellation();
    });
    it('serializes nested reactive page overrides for every IPC request', async () => {
        await scenarioSerializesNestedReactivePageOverridesForEveryIPCRequest();
    });
    it('rejects asymmetric start errors and impossible job progress', async () => {
        await scenarioRejectsAsymmetricStartErrorsAndImpossibleJobProgress();
    });
    it('demand-materializes lazy-original input before scan-cleanup preview', async () => {
        await scenarioDemandMaterializesLazyOriginalInputBeforeScanCleanupPreview();
    });
    it('cancels preview work whose working copy registration was retired', async () => {
        await scenarioCancelsPreviewWorkWhoseWorkingCopyRegistrationWasRetired();
    });
    it('reports preview work for a source this owner never held as a failure', async () => {
        await scenarioReportsPreviewWorkForASourceThisOwnerNeverHeldAsAFailure();
    });
    it('serializes native preview error codes through the message-only IPC boundary', async () => {
        await scenarioSerializesNativePreviewErrorCodesThroughTheMessageOnlyIPCBoundary();
    });
    it('skips materialization for queued preview work canceled before it dequeues', async () => {
        await scenarioSkipsMaterializationForQueuedPreviewWorkCanceledBeforeItDequeues();
    });
    it('keeps eager scan-cleanup preview paths unchanged', async () => {
        await scenarioKeepsEagerScanCleanupPreviewPathsUnchanged();
    });
    it('accepts unbounded nonnegative skew evidence and rejects invalid values at both metadata boundaries', async () => {
        await scenarioAcceptsUnboundedNonnegativeSkewEvidenceAndRejectsInvalidValuesAtBothMetadataBoundaries();
    });
    it('validates additive render-region metadata against the full intrinsic output', async () => {
        await scenarioValidatesAdditiveRenderRegionMetadataAgainstTheFullIntrinsicOutput();
    });
    it('rejects oversized encoded image responses at the IPC boundary', async () => {
        await scenarioRejectsOversizedEncodedImageResponsesAtTheIPCBoundary();
    });
    it('rejects layout confidence outside the unit interval at the IPC boundary', async () => {
        await scenarioRejectsLayoutConfidenceOutsideTheUnitIntervalAtTheIPCBoundary();
    });
    it('rejects malformed cleanup diagnostic flags at the IPC boundary', async () => {
        await scenarioRejectsMalformedCleanupDiagnosticFlagsAtTheIPCBoundary();
    });
    it('rejects non-numeric rotations and unsafe pixel geometry at the IPC boundary', async () => {
        await scenarioRejectsNonNumericRotationsAndUnsafePixelGeometryAtTheIPCBoundary();
    });
    it('requires named finite applied margins at the IPC boundary', async () => {
        await scenarioRequiresNamedFiniteAppliedMarginsAtTheIPCBoundary();
    });
    it('rejects fully off-canvas and inconsistent intrinsic overflow intervals at the IPC boundary', async () => {
        await scenarioRejectsFullyOffCanvasAndInconsistentIntrinsicOverflowIntervalsAtTheIPCBoundary();
    });
    it('accepts optional detection text-axis and recommendation reasons and rejects malformed values', async () => {
        await scenarioAcceptsOptionalDetectionTextAxisAndRecommendationReasonsAndRejectsMalformedValues();
    });
    it('keeps the owner listeners until its last preview job ends', async () => {
        await scenarioKeepsTheOwnerListenersUntilItsLastPreviewJobEnds();
    });
    it('cancels a preview immediately when its webContents is already destroyed', async () => {
        await scenarioCancelsAPreviewImmediatelyWhenItsWebContentsIsAlreadyDestroyed();
    });
});
