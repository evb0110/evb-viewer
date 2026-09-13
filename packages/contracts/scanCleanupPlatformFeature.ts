import type {
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPlacementAnchorCalibrationRequest,
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupStartRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/ipc';
import {
    decodeDetectionArgs,
    decodeOwnedJobId,
    decodePlacementAnchorCalibrationArgs,
    decodePreviewArgs,
    decodePreviewCancelArgs,
    decodeStartArgs,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    decodeDetectionStartResult,
    decodeScanCleanupDetectionJobState,
    decodeScanCleanupJobState,
    decodeScanCleanupPlacementAnchorCalibration,
    decodeScanCleanupPreviewResult,
    decodeScanCleanupRawPreviewEvent,
    decodeStartResult,
} from '@contracts/scan-cleanup/ipcResultCodecs';
import { requirePageNumber } from '@contracts/pageNumbers';
import { createJobId } from '@contracts/shared';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    createDefaultScanCleanupSettingsFile,
    decodeScanCleanupSettingsFile,
    decodeScanCleanupSettingsReadRequest,
    decodeScanCleanupSettingsUpdateRequest,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
    type IScanCleanupSettingsUpdateRequest,
} from '@contracts/scanCleanupSettings';
import {
    parseJobId,
    parseRequestId,
    type TJobId,
} from '@contracts/shared';
import {createEpochMs} from '@contracts/timestamps';

const owner: IScanCleanupOwnerContext = {
    ownerId: 'scan-cleanup-fixture',
    documentRevision: 'revision-1',
};
const options = {
    preserveOriginalQuality: false,
    layoutMode: 'auto' as const,
    outputMode: 'color' as const,
    readingOrder: 'ltr' as const,
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center' as const,
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};
const previewRequest: IScanCleanupPreviewRequest = {
    ...owner,
    requestId: parseRequestId('preview-request-1') ?? (() => {
        throw new Error('invalid fixture request ID');
    })(),
    sourcePdfPath: '/tmp/source.pdf',
    pageNumber: requirePageNumber(1),
    options,
};
const cancelPreviewRequest: IScanCleanupPreviewCancelRequest = {
    ...owner,
    sourcePdfPath: '/tmp/source.pdf',
};
const detectionRequest: IScanCleanupDetectionRequest = {
    ...cancelPreviewRequest,
    options,
};
const startRequest: IScanCleanupStartRequest = detectionRequest;
const placementAnchorCalibrationRequest: IScanCleanupPlacementAnchorCalibrationRequest = {
    ...owner,
    sourcePdfPath: '/tmp/source.pdf',
    detectionResultStoreId: 'scan-cleanup-fixture-store',
    options,
    pageNumber: requirePageNumber(1),
};
const queuedProgress = {
    stage: 'queued' as const,
    completedUnits: 0,
    totalUnits: 0,
    percent: 0,
    completedPageNumbers: [],
};
const queuedJobState: TScanCleanupJobState = {
    jobId: parseJobId('scan-cleanup-fixture') ?? (() => {
        throw new Error('invalid fixture job ID');
    })(),
    status: 'queued',
    progress: queuedProgress,
    updatedAtMs: createEpochMs(0),
};
const queuedDetectionState: TScanCleanupDetectionJobState = {
    jobId: parseJobId('scan-cleanup-detect-fixture') ?? (() => {
        throw new Error('invalid fixture job ID');
    })(),
    status: 'queued',
    progress: queuedProgress,
    results: [],
    updatedAtMs: createEpochMs(0),
};
const booleanResult = s.boolean();
const nonNegativeInteger = s.number({
    integer: true,
    min: 0,
    message: 'invalid scan-cleanup non-negative integer result',
});
const decodeArgs = <T>(decode: (value: readonly unknown[]) => T) =>
    (value: unknown) => decode(Array.isArray(value) ? value : []);
const settingsReadArgs = s.fromParser(
    decodeArgs(value => [decodeScanCleanupSettingsReadRequest(value[0])] as [IScanCleanupSettingsReadRequest]),
    () => [{}],
);
const settingsUpdateArgs = s.fromParser(
    decodeArgs<IScanCleanupSettingsUpdateRequest[]>(value => [decodeScanCleanupSettingsUpdateRequest(value[0])]),
    () => [{settings: createDefaultScanCleanupSettingsFile().settings}],
);
const settingsFile = s.fromParser(
    decodeScanCleanupSettingsFile,
    (): IScanCleanupSettingsFile => createDefaultScanCleanupSettingsFile(),
);
const previewArgs = s.fromParser(decodeArgs(decodePreviewArgs), () => [previewRequest]);
const cancelPreviewArgs = s.fromParser(decodeArgs(decodePreviewCancelArgs), () => [cancelPreviewRequest]);
const detectionArgs = s.fromParser(decodeArgs(decodeDetectionArgs), () => [detectionRequest]);
const startArgs = s.fromParser(decodeArgs(decodeStartArgs), () => [startRequest]);
const placementAnchorCalibrationArgs = s.fromParser(
    decodeArgs(decodePlacementAnchorCalibrationArgs),
    () => [placementAnchorCalibrationRequest],
);
const ownedJobArgs = s.fromParser(decodeArgs(decodeOwnedJobId), () => [
    parseJobId('scan-cleanup-fixture') ?? (() => {
        throw new Error('invalid fixture job ID');
    })(),
    owner,
] as [TJobId, IScanCleanupOwnerContext]);
const rawPreviewEvent = s.fromParser(decodeScanCleanupRawPreviewEvent, () => ({
    ...owner,
    requestId: parseRequestId('preview-request-1') ?? (() => {
        throw new Error('invalid fixture request ID');
    })(),
    pageNumber: requirePageNumber(1),
    totalPages: 1,
    rawImageData: new Uint8Array([1]),
    rawWidthPx: 1,
    rawHeightPx: 1,
}));
const previewResult = s.fromParser(
    decodeScanCleanupPreviewResult,
    () => ({
        pageNumber: requirePageNumber(1),
        totalPages: 1,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1,
        rawHeightPx: 1,
        pageMetadata: {
            layoutClassification: 'single-uncut-page' as const,
            cutterXPx: null,
            rotationDegrees: 0 as const,
            canvasScope: 'document' as const,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page' as const,
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [],
    }),
);
const detectionStartResult = s.fromParser(decodeDetectionStartResult, () => ({
    started: true as const,
    jobId: createJobId('scan-cleanup-detect-fixture'),
}));
const startResult = s.fromParser(decodeStartResult, () => ({
    started: true as const,
    jobId: createJobId('scan-cleanup-fixture'),
    outputPdfPath: '/tmp/cleaned.pdf',
}));
const placementAnchorCalibrationResult = s.fromParser(
    decodeScanCleanupPlacementAnchorCalibration,
    (): IScanCleanupPlacementAnchorCalibration => ({
        summary: {
            schemaVersion: 1,
            sampleCount: 0,
            referenceHeightPoints: 0,
            toleranceNormalized: 0,
            topEdgeNormalized: 0,
            identity: {
                documentRevision: 'revision-1',
                detectionSignature: 'detection-1',
                calibrationSignature: 'calibration-1',
            },
            clusters: [],
            samples: [],
        },
        placementAnchors: {},
    }),
);
const jobState = s.fromParser(decodeScanCleanupJobState, () => null);
const detectionJobState = s.fromParser(decodeScanCleanupDetectionJobState, () => null);
const jobEvent = s.fromNullableDecoder(
    decodeScanCleanupJobState,
    'scan-cleanup job state',
    () => queuedJobState,
);
const detectionEvent = s.fromNullableDecoder(
    decodeScanCleanupDetectionJobState,
    'scan-cleanup detection job state',
    () => queuedDetectionState,
);
const method = defineForwardedPlatformMethod;

export const SCAN_CLEANUP_PLATFORM_FEATURE = definePlatformFeature({
    path: ['scanCleanup'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        preview: method({
            name: 'preview',
            channel: 'scan-cleanup:preview',
            args: previewArgs,
            result: previewResult,
            main: 'preview',
        }),
        resolvePlacementAnchorCalibration: method({
            name: 'resolvePlacementAnchorCalibration',
            channel: 'scan-cleanup:placement-anchor-calibration',
            args: placementAnchorCalibrationArgs,
            result: placementAnchorCalibrationResult,
            main: 'resolvePlacementAnchorCalibration',
            optionalWhenImplemented: true,
        }),
        cancelPreview: method({
            name: 'cancelPreview',
            channel: 'scan-cleanup:preview:cancel',
            args: cancelPreviewArgs,
            result: booleanResult,
            main: 'cancelPreview',
        }),
        detectAll: method({
            name: 'detectAll',
            channel: 'scan-cleanup:detect-all',
            args: detectionArgs,
            result: detectionStartResult,
            main: 'detectAll',
        }),
        cancelDetection: method({
            name: 'cancelDetection',
            channel: 'scan-cleanup:detect-all:cancel',
            args: ownedJobArgs,
            result: booleanResult,
            main: 'cancelDetection',
        }),
        getDetectionJobState: method({
            name: 'getDetectionJobState',
            channel: 'scan-cleanup:detect-all:get-state',
            args: ownedJobArgs,
            result: detectionJobState,
            main: 'getDetectionJobState',
        }),
        subscribeDetectionJob: method({
            name: 'subscribeDetectionJob',
            channel: 'scan-cleanup:detect-all:subscribe',
            args: ownedJobArgs,
            result: detectionJobState,
            main: 'subscribeDetectionJob',
        }),
        start: method({
            name: 'start',
            channel: 'scan-cleanup:start',
            args: startArgs,
            result: startResult,
            main: 'start',
        }),
        cancel: method({
            name: 'cancel',
            channel: 'scan-cleanup:cancel',
            args: ownedJobArgs,
            result: booleanResult,
            main: 'cancel',
        }),
        getJobState: method({
            name: 'getJobState',
            channel: 'scan-cleanup:job:get-state',
            args: ownedJobArgs,
            result: jobState,
            main: 'getJobState',
        }),
        subscribeJob: method({
            name: 'subscribeJob',
            channel: 'scan-cleanup:job:subscribe',
            args: ownedJobArgs,
            result: jobState,
            main: 'subscribeJob',
        }),
        reconnectJob: method({
            name: 'reconnectJob',
            channel: 'scan-cleanup:job:reconnect',
            args: ownedJobArgs,
            result: jobState,
            main: 'reconnectJob',
        }),
        pruneGeneratedOutputs: {
            kind: 'async',
            channel: 'scan-cleanup:output:prune',
            ipc: {
                args: s.tuple([]),
                result: nonNegativeInteger,
            },
            main: {
                method: 'pruneGeneratedOutputs',
                context: 'none',
            },
            browser: {method: 'pruneGeneratedOutputs'},
            lazy: 'forwarded',
        },
        getSettings: method({
            name: 'getSettings',
            channel: 'scan-cleanup:settings:get',
            args: settingsReadArgs,
            result: settingsFile,
            main: 'getSettings',
            optionalWhenImplemented: true,
        }),
        updateSettings: method({
            name: 'updateSettings',
            channel: 'scan-cleanup:settings:update',
            args: settingsUpdateArgs,
            result: settingsFile,
            main: 'updateSettings',
            optionalWhenImplemented: true,
        }),
    },
    events: {
        onPreviewRaw: {
            kind: 'event',
            channel: 'scan-cleanup:preview:raw',
            payload: rawPreviewEvent,
            browser: {method: 'onPreviewRaw'},
            lazy: 'forwarded',
        },
        onJobState: {
            kind: 'event',
            channel: 'scan-cleanup:job:state',
            payload: jobEvent,
            browser: {method: 'onJobState'},
            lazy: 'forwarded',
        },
        onDetectionJobState: {
            kind: 'event',
            channel: 'scan-cleanup:detect-all:state',
            payload: detectionEvent,
            browser: {method: 'onDetectionJobState'},
            lazy: 'forwarded',
        },
    },
});

export type IScanCleanupCapability = TFeatureCapability<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
export type IScanCleanupInvokeMap = TFeatureInvokeMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
export type IScanCleanupEventMap = TFeatureEventMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
