import * as v from 'valibot';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    SCAN_CLEANUP_DETECTION_ARGS_SCHEMA,
    SCAN_CLEANUP_OWNED_JOB_ARGS_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_ARGS_SCHEMA,
    SCAN_CLEANUP_PREVIEW_ARGS_SCHEMA,
    SCAN_CLEANUP_PREVIEW_CANCEL_ARGS_SCHEMA,
    SCAN_CLEANUP_START_ARGS_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA,
    SCAN_CLEANUP_DETECTION_START_RESULT_SCHEMA,
    SCAN_CLEANUP_JOB_STATE_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_SCHEMA,
    SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA,
    SCAN_CLEANUP_RAW_PREVIEW_EVENT_SCHEMA,
    SCAN_CLEANUP_START_RESULT_SCHEMA,
} from '@contracts/scan-cleanup/ipcResultCodecs';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    decodeScanCleanupSettingsResult,
    decodeScanCleanupSettingsReadRequest,
    decodeScanCleanupSettingsUpdateRequest,
} from '@contracts/scan-cleanup/scanCleanupSettings';

const booleanResult = v.boolean();
const documentRef = v.pipe(v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'invalid scan-cleanup document reference'),
    v.transform(value => parseDocumentRef(value)!));
const voidResult = v.pipe(v.undefined(), v.transform(() => {}));
const nonNegativeInteger = v.message(v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    'invalid scan-cleanup non-negative integer result');
// Settings decoders retain legacy key normalization and file repair semantics.
const settingsReadArgs = v.strictTuple([v.pipe(v.unknown(), v.transform(decodeScanCleanupSettingsReadRequest))]);
const settingsUpdateArgs = v.strictTuple([v.pipe(v.unknown(), v.transform(decodeScanCleanupSettingsUpdateRequest))]);
const settingsFile = v.pipe(v.unknown(), v.transform(decodeScanCleanupSettingsResult));
const previewArgs = SCAN_CLEANUP_PREVIEW_ARGS_SCHEMA;
const cancelPreviewArgs = SCAN_CLEANUP_PREVIEW_CANCEL_ARGS_SCHEMA;
const detectionArgs = SCAN_CLEANUP_DETECTION_ARGS_SCHEMA;
const startArgs = SCAN_CLEANUP_START_ARGS_SCHEMA;
const placementAnchorCalibrationArgs = SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_ARGS_SCHEMA;
const ownedJobArgs = SCAN_CLEANUP_OWNED_JOB_ARGS_SCHEMA;
const rawPreviewEvent = SCAN_CLEANUP_RAW_PREVIEW_EVENT_SCHEMA;
const previewResult = SCAN_CLEANUP_PREVIEW_RESULT_SCHEMA;
const detectionStartResult = SCAN_CLEANUP_DETECTION_START_RESULT_SCHEMA;
const startResult = SCAN_CLEANUP_START_RESULT_SCHEMA;
const placementAnchorCalibrationResult = SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_SCHEMA;
const jobState = SCAN_CLEANUP_JOB_STATE_SCHEMA;
const detectionJobState = SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA;
const jobEvent = v.pipe(SCAN_CLEANUP_JOB_STATE_SCHEMA,
    v.check(state => state !== null, 'invalid scan-cleanup job state'),
    v.transform(state => state!));
const detectionEvent = v.pipe(SCAN_CLEANUP_DETECTION_JOB_STATE_SCHEMA,
    v.check(state => state !== null, 'invalid scan-cleanup detection job state'),
    v.transform(state => state!));
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
            channel: 'scan-cleanup:job:cancel',
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
                args: v.strictTuple([]),
                result: nonNegativeInteger,
            },
            main: {
                method: 'pruneGeneratedOutputs',
                context: 'none',
            },
            browser: {method: 'pruneGeneratedOutputs'},
            lazy: 'forwarded',
        },
        getPendingCompletedOutputs: {
            kind: 'async',
            channel: 'scan-cleanup:output:pending',
            ipc: {
                args: v.strictTuple([]),
                result: v.array(documentRef),
            },
            main: {
                method: 'getPendingCompletedOutputs',
                context: 'sender',
            },
            browser: {method: 'getPendingCompletedOutputs'},
            optionalWhenImplemented: true,
            lazy: 'forwarded',
        },
        acknowledgeCompletedOutputs: {
            kind: 'async',
            channel: 'scan-cleanup:output:acknowledge',
            ipc: {
                args: v.strictTuple([v.array(documentRef)]),
                result: voidResult,
            },
            main: {
                method: 'acknowledgeCompletedOutputs',
                context: 'none',
            },
            browser: {method: 'acknowledgeCompletedOutputs'},
            optionalWhenImplemented: true,
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
