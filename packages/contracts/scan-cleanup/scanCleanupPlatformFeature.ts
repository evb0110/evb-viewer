import * as v from 'valibot';
import type {TRequestId} from '@contracts/shared';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    SCAN_CLEANUP_DETECTION_ARGS_SCHEMA,
    SCAN_CLEANUP_OWNED_JOB_ARGS_SCHEMA,
    SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_ARGS_SCHEMA,
    SCAN_CLEANUP_PREVIEW_ARGS_SCHEMA,
    SCAN_CLEANUP_PREVIEW_CANCEL_ARGS_SCHEMA,
    SCAN_CLEANUP_START_ARGS_SCHEMA,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import type {
    IScanCleanupPlacementAnchorCalibration,
    IScanCleanupRawPreviewEvent,
    TScanCleanupDetectionJobState,
    TScanCleanupDetectionStartResult,
    TScanCleanupJobState,
    TScanCleanupPreviewWireResult,
    TScanCleanupStartResult,
} from '@contracts/scan-cleanup/ipc';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    decodeScanCleanupSettingsReadRequest,
    decodeScanCleanupSettingsUpdateRequest,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupSettingsResult,
} from '@contracts/scan-cleanup/scanCleanupSettings';

const booleanResult = v.boolean();
const documentRef = v.pipe(v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'invalid scan-cleanup document reference'),
    v.transform(value => parseDocumentRef(value)!));
const voidResult = v.pipe(v.undefined(), v.transform(() => {}));
const nonNegativeInteger = v.message(v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    'invalid scan-cleanup non-negative integer result');
// Settings request decoders retain legacy key normalization and file repair semantics.
const settingsReadArgs = v.strictTuple([v.pipe(v.unknown(), v.transform(decodeScanCleanupSettingsReadRequest))]);
const settingsUpdateArgs = v.strictTuple([v.pipe(v.unknown(), v.transform(decodeScanCleanupSettingsUpdateRequest))]);
const previewArgs = SCAN_CLEANUP_PREVIEW_ARGS_SCHEMA;
const cancelPreviewArgs = SCAN_CLEANUP_PREVIEW_CANCEL_ARGS_SCHEMA;
const detectionArgs = SCAN_CLEANUP_DETECTION_ARGS_SCHEMA;
const startArgs = SCAN_CLEANUP_START_ARGS_SCHEMA;
const placementAnchorCalibrationArgs = SCAN_CLEANUP_PLACEMENT_ANCHOR_CALIBRATION_ARGS_SCHEMA;
const ownedJobArgs = SCAN_CLEANUP_OWNED_JOB_ARGS_SCHEMA;
// Main is the trusted side of the bridge: what it returns or emits is typed, not decoded again.
const trusted = <T>() => v.custom<T>(() => true);
const rawPreviewEvent = trusted<IScanCleanupRawPreviewEvent>();
const previewResult = trusted<TScanCleanupPreviewWireResult>();
const detectionStartResult = trusted<TScanCleanupDetectionStartResult>();
const startResult = trusted<TScanCleanupStartResult>();
const placementAnchorCalibrationResult = trusted<IScanCleanupPlacementAnchorCalibration>();
const jobState = trusted<TScanCleanupJobState | null>();
const detectionJobState = trusted<TScanCleanupDetectionJobState | null>();
const jobEvent = trusted<TScanCleanupJobState>();
const detectionEvent = trusted<TScanCleanupDetectionJobState>();
const settingsFile = trusted<IScanCleanupSettingsResult>();
const settingsChange = trusted<{
    settings: IScanCleanupGlobalPreferences;
    requestId?: TRequestId;
}>();
const method = defineForwardedPlatformMethod;
const supportResult = v.strictObject({
    preview: v.boolean(),
    detection: v.boolean(),
    calibration: v.boolean(),
    conversion: v.boolean(),
});

export const SCAN_CLEANUP_PLATFORM_FEATURE = definePlatformFeature({
    path: ['scanCleanup'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        // Which operations the platform runs, answered without a round trip.
        getSupport: {
            kind: 'sync',
            args: v.strictTuple([]),
            result: supportResult,
            browser: {method: 'getSupport'},
            lazy: 'direct',
        },
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
        onSettingsChanged: {
            kind: 'event',
            channel: 'scan-cleanup:settings:changed',
            payload: settingsChange,
            browser: {method: 'onSettingsChanged'},
            lazy: 'forwarded',
        },
    },
});

export type IScanCleanupCapability = TFeatureCapability<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;

/**
 * Which Scan Cleanup operations a platform can run. Controls for an
 * unsupported operation, and the automatic callers behind them, stay off
 * rather than failing.
 */
export type IScanCleanupSupport = v.InferOutput<typeof supportResult>;

/** Desktop runs every operation. */
export const FULL_SCAN_CLEANUP_SUPPORT: IScanCleanupSupport = Object.freeze({
    preview: true,
    detection: true,
    calibration: true,
    conversion: true,
});
const NO_SCAN_CLEANUP_SUPPORT: IScanCleanupSupport = Object.freeze({
    preview: false,
    detection: false,
    calibration: false,
    conversion: false,
});

/** What a capability can run; nothing without one. */
export function resolveScanCleanupSupport(capability: IScanCleanupCapability | null): IScanCleanupSupport {
    return capability?.getSupport() ?? NO_SCAN_CLEANUP_SUPPORT;
}
export type IScanCleanupInvokeMap = TFeatureInvokeMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
export type IScanCleanupEventMap = TFeatureEventMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
