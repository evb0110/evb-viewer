import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import * as v from 'valibot';

const APP_UPDATE_VERSION_MAX_LENGTH = 128;
const APP_UPDATE_MESSAGE_MAX_LENGTH = 4_096;
const appUpdatePhaseSchema = v.picklist([
    'idle',
    'checking',
    'available',
    'downloading',
    'downloaded',
    'no-update',
    'error',
    'unsupported',
], 'invalid app update status');
const appUpdateStatusSchema = v.object({
    phase: appUpdatePhaseSchema,
    origin: v.picklist([
        'auto',
        'manual',
    ], 'invalid app update status'),
    version: v.nullable(v.pipe(
        v.string('invalid app update status'),
        v.maxLength(APP_UPDATE_VERSION_MAX_LENGTH, 'invalid app update status'),
    )),
    percent: v.nullable(v.pipe(
        v.number('invalid app update status'),
        v.finite('invalid app update status'),
        v.minValue(0, 'invalid app update status'),
        v.maxValue(100, 'invalid app update status'),
    )),
    message: v.nullable(v.pipe(
        v.string('invalid app update status'),
        v.maxLength(APP_UPDATE_MESSAGE_MAX_LENGTH, 'invalid app update status'),
    )),
}, 'invalid app update status');
export type IAppUpdateStatus = v.InferOutput<typeof appUpdateStatusSchema>;
export type TAppUpdateCheckOrigin = IAppUpdateStatus['origin'];
export type TAppUpdatePhase = IAppUpdateStatus['phase'];

export function decodeAppUpdateStatus(value: unknown): IAppUpdateStatus | null {
    const result = v.safeParse(appUpdateStatusSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

const noArgs = v.strictTuple([]);
const startedResult = v.object({started: v.boolean('expected a started result')}, 'expected a started result');
const voidResult = v.pipe(
    v.undefined('expected an undefined IPC result'),
    v.transform((): void => undefined),
);
const browserUnsupported = {
    unsupported: 'omitted',
    reason: 'requires-native-backend',
} as const;

export const UPDATES_PLATFORM_FEATURE = definePlatformFeature({
    path: ['updates'],
    required: {
        browser: false,
        electron: true,
    },
    manifestPath: ['updates'],
    methods: {
        getState: {
            kind: 'async',
            channel: 'updates:getState',
            ipc: {
                args: noArgs,
                result: appUpdateStatusSchema,
            },
            main: {
                method: 'getUpdateStatus',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        check: {
            kind: 'async',
            channel: 'updates:check',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'triggerManualUpdateCheck',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        download: {
            kind: 'async',
            channel: 'updates:download',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'downloadAvailableUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        install: {
            kind: 'async',
            channel: 'updates:install',
            ipc: {
                args: noArgs,
                result: startedResult,
            },
            main: {
                method: 'installDownloadedUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        defer: {
            kind: 'async',
            channel: 'updates:defer',
            ipc: {
                args: noArgs,
                result: voidResult,
            },
            main: {
                method: 'deferDownloadedUpdate',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
        skipVersion: {
            kind: 'async',
            channel: 'updates:skipVersion',
            ipc: {
                args: v.strictTuple([v.string('expected a string')]),
                result: voidResult,
            },
            main: {
                method: 'skipUpdateVersion',
                context: 'none',
            },
            browser: browserUnsupported,
            lazy: 'forwarded',
        },
    },
    events: {onStatus: {
        kind: 'event',
        channel: 'updates:status',
        payload: appUpdateStatusSchema,
        browser: browserUnsupported,
        lazy: 'forwarded',
    }},
});

interface IUpdatesMenuCapability {onMenuCheckForUpdates: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;}

export type IUpdatesCapability =
    TFeatureCapability<typeof UPDATES_PLATFORM_FEATURE> & IUpdatesMenuCapability;
export type IUpdatesInvokeMap = TFeatureInvokeMap<typeof UPDATES_PLATFORM_FEATURE>;
export type IUpdatesEventMap = TFeatureEventMap<typeof UPDATES_PLATFORM_FEATURE>;
