import {
    defineForwardedPlatformEvent,
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import {
    HOST_RASTER_BUDGET_MAX_WINDOWS,
    HOST_RASTER_POOL_MAX_BYTES,
    HOST_RASTER_POOL_MIN_BYTES,
    HOST_WINDOW_RASTER_SHARE_MIN_BYTES,
    type IHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';
import * as v from 'valibot';

const HOST_OS_SCALE_FACTOR_MAX = 8;
/** Carries the window's host snapshot to its preload, so the first layout can use it. */
export const HOST_ENVIRONMENT_ARGUMENT_PREFIX = '--evb-host-environment=';
const hostEnvironmentSchema = v.object(
    {
        platform: v.picklist(['darwin', 'win32', 'linux'], 'invalid host environment'),
        osScaleFactor: v.pipe(
            v.number('invalid host environment'),
            v.finite('invalid host environment'),
            v.check((value) => value > 0 && value <= HOST_OS_SCALE_FACTOR_MAX, 'invalid host environment'),
        ),
    },
    'invalid host environment',
);

export type IHostEnvironmentSnapshot = v.InferOutput<typeof hostEnvironmentSchema>;
export type THostPlatform = IHostEnvironmentSnapshot['platform'];

export function decodeHostEnvironmentSnapshot(value: unknown): IHostEnvironmentSnapshot | null {
    const result = v.safeParse(hostEnvironmentSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

const hostZenModeStateSchema = v.object(
    {
        active: v.boolean('invalid host zen mode state'),
        supported: v.boolean('invalid host zen mode state'),
    },
    'invalid host zen mode state',
);
export type IHostZenModeState = v.InferOutput<typeof hostZenModeStateSchema>;

// A whole number of device-independent pixels a window can have.
const windowDimension = v.pipe(
    v.number('invalid host window size'),
    v.integer('invalid host window size'),
    v.minValue(1, 'invalid host window size'),
    v.maxValue(32_768, 'invalid host window size'),
);
const hostWindowSizeSchema = v.strictObject(
    {
        width: windowDimension,
        height: windowDimension,
    },
    'invalid host window size',
);
/** A width and height in device-independent pixels: a content area or a display's work area. */
export type IHostWindowSize = v.InferOutput<typeof hostWindowSizeSchema>;

/** Native placement of the window: fullscreen and maximized both override its own size. */
const hostWindowStateSchema = v.object(
    {
        fullScreen: v.boolean('invalid host window state'),
        maximized: v.boolean('invalid host window state'),
        supported: v.boolean('invalid host window state'),
        /** The native content size the window reached, where the host can tell. */
        contentSize: v.optional(hostWindowSizeSchema),
        /** The work area of the display the window is on, which bounds its size. */
        workAreaSize: v.optional(hostWindowSizeSchema),
    },
    'invalid host window state',
);
export type IHostWindowState = v.InferOutput<typeof hostWindowStateSchema>;

/** Serialized bug report. Content free by construction; see the writer. */
export type IHostBugReportBundle = v.InferOutput<typeof hostBugReportBundleSchema>;
/** Timestamp directory the bundle landed in, never a full path. */
export type IHostBugReportWriteResult = v.InferOutput<typeof hostBugReportWriteResultSchema>;

/** Counted in UTF-16 code units, which is what `String.length` measures. */
const HOST_BUG_REPORT_MAX_JSON_CHARS = 256 * 1024;
/** Longer than any path a filesystem accepts, so a real one always fits. */
const HOST_BUG_REPORT_MAX_SOURCE_PATH_CHARS = 4_096;
const hostBugReportBundleSchema = v.object(
    {
        reportJson: v.pipe(
            v.string('invalid host bug report bundle'),
            v.minLength(1, 'invalid host bug report bundle'),
            v.maxLength(HOST_BUG_REPORT_MAX_JSON_CHARS, 'invalid host bug report bundle'),
        ),
        sourcePath: v.pipe(
            v.string('invalid host bug report bundle'),
            v.maxLength(HOST_BUG_REPORT_MAX_SOURCE_PATH_CHARS, 'invalid host bug report bundle'),
        ),
    },
    'invalid host bug report bundle',
);
const hostBugReportWriteResultSchema = v.object(
    {
        directoryName: v.string('invalid host bug report write result'),
        screenshotWritten: v.boolean('invalid host bug report write result'),
        written: v.boolean('invalid host bug report write result'),
    },
    'invalid host bug report write result',
);

const hostRasterBudgetSchema = v.pipe(
    v.strictObject(
        {
            maxRasterSurfaceBytes: v.pipe(
                v.number('invalid host raster budget'),
                v.integer('invalid host raster budget'),
                v.minValue(HOST_WINDOW_RASTER_SHARE_MIN_BYTES, 'invalid host raster budget'),
                v.maxValue(HOST_RASTER_POOL_MAX_BYTES, 'invalid host raster budget'),
            ),
            hostPoolBytes: v.pipe(
                v.number('invalid host raster budget'),
                v.integer('invalid host raster budget'),
                v.minValue(HOST_RASTER_POOL_MIN_BYTES, 'invalid host raster budget'),
                v.maxValue(HOST_RASTER_POOL_MAX_BYTES, 'invalid host raster budget'),
            ),
            windowCount: v.pipe(
                v.number('invalid host raster budget'),
                v.integer('invalid host raster budget'),
                v.minValue(1, 'invalid host raster budget'),
                v.maxValue(HOST_RASTER_BUDGET_MAX_WINDOWS, 'invalid host raster budget'),
            ),
        },
        'invalid host raster budget',
    ),
    v.check((value) => value.maxRasterSurfaceBytes <= value.hostPoolBytes, 'invalid host raster budget'),
);
export type IHostRasterBudgetSnapshot = v.InferOutput<typeof hostRasterBudgetSchema>;

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
        getRasterBudget: defineForwardedPlatformMethod({
            name: 'getRasterBudget',
            channel: 'host:getRasterBudget',
            args: noArgs,
            result: v.nullable(hostRasterBudgetSchema),
            main: 'snapshotHostRasterBudgetForWindow',
        }),
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
        // Leaves fullscreen and maximized, so a later size request is the window's own,
        // then gives the content area the size asked for, if any. Answers the state
        // the window reached, which may still be fullscreen or maximized.
        restoreNormalWindow: defineForwardedPlatformMethod({
            name: 'restoreNormalWindow',
            channel: 'host:restoreNormalWindow',
            args: v.union([v.strictTuple([]), v.strictTuple([hostWindowSizeSchema])]),
            result: hostWindowStateSchema,
            main: 'restoreHostNormalWindowForWindow',
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
        onRasterBudgetChange: defineForwardedPlatformEvent({
            name: 'onRasterBudgetChange',
            channel: 'host:rasterBudgetChanged',
            payload: hostRasterBudgetSchema,
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
            payload: v.picklist(['begin', 'end']),
        }),
    },
});

export type IHostCapability = TFeatureCapability<typeof HOST_PLATFORM_FEATURE>;
export type {IHostResourceProfileSnapshot};
