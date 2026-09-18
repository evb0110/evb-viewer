import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import {
    defineForwardedPlatformEvent,
    defineForwardedPlatformMethod,
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

export type THostPlatform = 'darwin' | 'win32' | 'linux';
const HOST_OS_SCALE_FACTOR_MAX = 8;

export interface IHostEnvironmentSnapshot {
    readonly platform: THostPlatform;
    readonly osScaleFactor: number;
}

export function decodeHostEnvironmentSnapshot(value: unknown): IHostEnvironmentSnapshot | null {
    if (
        !isRecord(value)
        || (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
        || !isFiniteNumber(value.osScaleFactor)
        || value.osScaleFactor <= 0
        || value.osScaleFactor > HOST_OS_SCALE_FACTOR_MAX
    ) {
        return null;
    }
    return {
        platform: value.platform,
        osScaleFactor: value.osScaleFactor,
    };
}

export interface IHostZenModeState {
    readonly active: boolean;
    readonly supported: boolean;
}

function decodeHostZenModeState(value: unknown): IHostZenModeState {
    if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.supported !== 'boolean') {
        throw new Error('invalid host zen mode state');
    }
    return {
        active: value.active,
        supported: value.supported,
    };
}

const resourceProfile = s.trustedDirect<IHostResourceProfileSnapshot | null>(() => ({
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
}));
const environment = s.fromNullableDecoder<IHostEnvironmentSnapshot>(
    decodeHostEnvironmentSnapshot,
    'host environment',
    () => ({
        platform: 'linux',
        osScaleFactor: 1,
    }),
);
const zenMode = s.fromParser<IHostZenModeState>(decodeHostZenModeState, () => ({
    active: false,
    supported: true,
}));

/** Serialized bug report. Content free by construction; see the writer. */
export interface IHostBugReportBundle {readonly reportJson: string;}

export interface IHostBugReportWriteResult {
    /** Timestamp directory the bundle landed in, never a full path. */
    readonly directoryName: string;
    readonly screenshotWritten: boolean;
    readonly written: boolean;
}

/** A bug report is a development aid, so the payload stays small on purpose. */
const HOST_BUG_REPORT_MAX_JSON_BYTES = 256 * 1024;

function decodeHostBugReportBundle(value: unknown): IHostBugReportBundle {
    if (
        !isRecord(value)
        || typeof value.reportJson !== 'string'
        || value.reportJson.length === 0
        || value.reportJson.length > HOST_BUG_REPORT_MAX_JSON_BYTES
    ) {
        throw new Error('invalid host bug report bundle');
    }
    return {reportJson: value.reportJson};
}

function decodeHostBugReportWriteResult(value: unknown): IHostBugReportWriteResult {
    if (
        !isRecord(value)
        || typeof value.directoryName !== 'string'
        || typeof value.screenshotWritten !== 'boolean'
        || typeof value.written !== 'boolean'
    ) {
        throw new Error('invalid host bug report write result');
    }
    return {
        directoryName: value.directoryName,
        screenshotWritten: value.screenshotWritten,
        written: value.written,
    };
}

const bugReportBundle = s.fromParser<IHostBugReportBundle>(
    decodeHostBugReportBundle,
    () => ({reportJson: '{}'}),
);
const bugReportWriteResult = s.fromParser<IHostBugReportWriteResult>(
    decodeHostBugReportWriteResult,
    () => ({
        directoryName: '1970-01-01T00-00-00.000Z',
        screenshotWritten: false,
        written: false,
    }),
);

export const HOST_PLATFORM_FEATURE = definePlatformFeature({
    path: ['host'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        getResourceProfile: {
            kind: 'sync',
            args: s.tuple([]),
            result: resourceProfile,
            browser: {method: 'getResourceProfile'},
            lazy: 'direct',
        },
        getEnvironment: defineForwardedPlatformMethod({
            name: 'getEnvironment',
            channel: 'host:getEnvironment',
            args: s.tuple([]),
            result: environment,
            main: 'snapshotHostEnvironmentForWindow',
        }),
        getZenModeState: defineForwardedPlatformMethod({
            name: 'getZenModeState',
            channel: 'host:getZenModeState',
            args: s.tuple([]),
            result: zenMode,
            main: 'snapshotHostZenModeForWindow',
        }),
        setZenMode: defineForwardedPlatformMethod({
            name: 'setZenMode',
            channel: 'host:setZenMode',
            args: s.tuple([s.boolean()]),
            result: zenMode,
            main: 'setHostZenModeForWindow',
        }),
        writeBugReportBundle: defineForwardedPlatformMethod({
            name: 'writeBugReportBundle',
            channel: 'host:writeBugReportBundle',
            args: s.tuple([bugReportBundle]),
            result: bugReportWriteResult,
            main: 'writeHostBugReportBundleForWindow',
        }),
    },
    events: {
        onEnvironmentChange: defineForwardedPlatformEvent({
            name: 'onEnvironmentChange',
            channel: 'host:environmentChanged',
            payload: environment,
        }),
        onZenModeChange: defineForwardedPlatformEvent({
            name: 'onZenModeChange',
            channel: 'host:zenModeChanged',
            payload: zenMode,
        }),
        // The browser process owns a wheel scroll sequence, including its
        // inertial tail, so only it knows when one is live. A renderer can
        // merely infer that from packet timing, and a busy main thread both
        // stretches the gaps between packets and delays the timer that would
        // notice the end.
        onWheelScrollSequenceChange: defineForwardedPlatformEvent({
            name: 'onWheelScrollSequenceChange',
            channel: 'host:wheelScrollSequenceChanged',
            payload: s.oneOf([
                'begin',
                'end',
            ]),
        }),
    },
});

export type IHostCapability = TFeatureCapability<typeof HOST_PLATFORM_FEATURE>;
