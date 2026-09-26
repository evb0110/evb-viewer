import {
    defineForwardedPlatformEvent,
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import * as v from 'valibot';

const HOST_OS_SCALE_FACTOR_MAX = 8;
const hostEnvironmentSchema = v.object({
    platform: v.picklist([
        'darwin',
        'win32',
        'linux',
    ], 'invalid host environment'),
    osScaleFactor: v.pipe(
        v.number('invalid host environment'),
        v.finite('invalid host environment'),
        v.check(value => value > 0 && value <= HOST_OS_SCALE_FACTOR_MAX, 'invalid host environment'),
    ),
}, 'invalid host environment');

export type IHostEnvironmentSnapshot = v.InferOutput<typeof hostEnvironmentSchema>;
export type THostPlatform = IHostEnvironmentSnapshot['platform'];

export function decodeHostEnvironmentSnapshot(value: unknown): IHostEnvironmentSnapshot | null {
    const result = v.safeParse(hostEnvironmentSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

const hostZenModeStateSchema = v.object({
    active: v.boolean('invalid host zen mode state'),
    supported: v.boolean('invalid host zen mode state'),
}, 'invalid host zen mode state');
export type IHostZenModeState = v.InferOutput<typeof hostZenModeStateSchema>;

/** Serialized bug report. Content free by construction; see the writer. */
export type IHostBugReportBundle = v.InferOutput<typeof hostBugReportBundleSchema>;
/** Timestamp directory the bundle landed in, never a full path. */
export type IHostBugReportWriteResult = v.InferOutput<typeof hostBugReportWriteResultSchema>;

/** Counted in UTF-16 code units, which is what `String.length` measures. */
const HOST_BUG_REPORT_MAX_JSON_CHARS = 256 * 1024;
/** Longer than any path a filesystem accepts, so a real one always fits. */
const HOST_BUG_REPORT_MAX_SOURCE_PATH_CHARS = 4_096;
const hostBugReportBundleSchema = v.object({
    reportJson: v.pipe(
        v.string('invalid host bug report bundle'),
        v.minLength(1, 'invalid host bug report bundle'),
        v.maxLength(HOST_BUG_REPORT_MAX_JSON_CHARS, 'invalid host bug report bundle'),
    ),
    sourcePath: v.pipe(
        v.string('invalid host bug report bundle'),
        v.maxLength(HOST_BUG_REPORT_MAX_SOURCE_PATH_CHARS, 'invalid host bug report bundle'),
    ),
}, 'invalid host bug report bundle');
const hostBugReportWriteResultSchema = v.object({
    directoryName: v.string('invalid host bug report write result'),
    screenshotWritten: v.boolean('invalid host bug report write result'),
    written: v.boolean('invalid host bug report write result'),
}, 'invalid host bug report write result');

const resourceProfileSchema = v.custom<IHostResourceProfileSnapshot | null>(() => true);
const noArgs = v.strictTuple([]);

export const HOST_PLATFORM_FEATURE = definePlatformFeature({
    path: ['host'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        getResourceProfile: {
            kind: 'sync',
            args: noArgs,
            result: resourceProfileSchema,
            browser: {method: 'getResourceProfile'},
            lazy: 'direct',
        },
        getEnvironment: defineForwardedPlatformMethod({
            name: 'getEnvironment',
            channel: 'host:getEnvironment',
            args: noArgs,
            result: hostEnvironmentSchema,
            main: 'snapshotHostEnvironmentForWindow',
        }),
        getZenModeState: defineForwardedPlatformMethod({
            name: 'getZenModeState',
            channel: 'host:getZenModeState',
            args: noArgs,
            result: hostZenModeStateSchema,
            main: 'snapshotHostZenModeForWindow',
        }),
        setZenMode: defineForwardedPlatformMethod({
            name: 'setZenMode',
            channel: 'host:setZenMode',
            args: v.strictTuple([v.boolean('expected a boolean IPC result')]),
            result: hostZenModeStateSchema,
            main: 'setHostZenModeForWindow',
        }),
        writeBugReportBundle: defineForwardedPlatformMethod({
            name: 'writeBugReportBundle',
            channel: 'host:writeBugReportBundle',
            args: v.strictTuple([hostBugReportBundleSchema]),
            result: hostBugReportWriteResultSchema,
            main: 'writeHostBugReportBundleForWindow',
        }),
    },
    events: {
        onEnvironmentChange: defineForwardedPlatformEvent({
            name: 'onEnvironmentChange',
            channel: 'host:environmentChanged',
            payload: hostEnvironmentSchema,
        }),
        onZenModeChange: defineForwardedPlatformEvent({
            name: 'onZenModeChange',
            channel: 'host:zenModeChanged',
            payload: hostZenModeStateSchema,
        }),
        // The browser process owns a wheel scroll sequence, including its inertial tail.
        onWheelScrollSequenceChange: defineForwardedPlatformEvent({
            name: 'onWheelScrollSequenceChange',
            channel: 'host:wheelScrollSequenceChanged',
            payload: v.picklist([
                'begin',
                'end',
            ]),
        }),
    },
});

export type IHostCapability = TFeatureCapability<typeof HOST_PLATFORM_FEATURE>;
export type {IHostResourceProfileSnapshot};
