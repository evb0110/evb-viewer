import {
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import {
    normalizeCanonicalApplicationFrames,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';
import {
    createDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    createDiagnosticFallbackEventId,
    createSafeDiagnosticEventId,
    safeDiagnosticNow,
} from '@contracts/diagnostics/diagnosticReporterIdentity';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    decodeStartupCrashMarkerRecord,
    DESKTOP_DIAGNOSTIC_DIST_IDENTITIES,
    STARTUP_CRASH_MARKER_SCHEMA_VERSION,
    type DesktopDiagnosticDist,
    type StartupCrashMarkerRecord,
} from '@contracts/diagnostics/startupCrashMarker';

export const STARTUP_CRASH_MARKER_FILE_NAME = 'startup-crash-marker.json';

type TUncaughtExceptionMonitorListener = (error: unknown) => void;

export interface IStartupCrashMarkerProcess {
    on(
        event: 'uncaughtExceptionMonitor',
        listener: TUncaughtExceptionMonitorListener,
    ): unknown;
    off?: (
        event: 'uncaughtExceptionMonitor',
        listener: TUncaughtExceptionMonitorListener,
    ) => unknown;
    removeListener?: (
        event: 'uncaughtExceptionMonitor',
        listener: TUncaughtExceptionMonitorListener,
    ) => unknown;
}

export interface IStartupCrashMarkerFileSystem {
    readFileSync(path: string, encoding: 'utf8'): string;
    unlinkSync(path: string): void;
    writeFileSync(
        path: string,
        data: string,
        options: {
            encoding: 'utf8';
            flag: 'w'
        },
    ): void;
}

type TStartupCrashMarkerPreference = unknown | (() => unknown);

export interface IStartupCrashMarkerOptions {
    markerPath: string;
    preference: TStartupCrashMarkerPreference;
    release: string;
    dist: DesktopDiagnosticDist | null;
    createEventId?: () => DiagnosticEventId;
    fileSystem?: IStartupCrashMarkerFileSystem;
    isLiveDeliveryAvailable?: () => boolean;
    now?: () => number;
    process?: IStartupCrashMarkerProcess;
}

export interface IStartupCrashMarkerReplayOptions {
    preference: TStartupCrashMarkerPreference;
    release: string;
    dist: DesktopDiagnosticDist | null;
    send: (marker: StartupCrashMarkerRecord) => unknown;
    onDiscard?: (reason: 'build-identity-mismatch') => void;
}

export interface IStartupCrashMarkerController {
    disarm(): void;
    isArmed(): boolean;
    markPrimaryInstanceReady(): void;
    onLiveAdapterReady(options: IStartupCrashMarkerReplayOptions): void;
    captureLiveException(error: unknown): FailureReceipt | undefined;
}

let activeController: IStartupCrashMarkerController | null = null;

/**
 * The real diagnostics adapter calls this after it has installed a live
 * transport. Reporter construction alone is not sufficient because its
 * bootstrap transport is intentionally a no-op.
 */
export function notifyStartupCrashMarkerAdapterReady(
    options: IStartupCrashMarkerReplayOptions,
): boolean {
    if (activeController === null) {
        return false;
    }
    activeController.onLiveAdapterReady(options);
    return true;
}

const DEFAULT_FILE_SYSTEM: IStartupCrashMarkerFileSystem = {
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    unlinkSync,
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
};

let fallbackEventIdCounter = 0;

function readSeamValue(value: TStartupCrashMarkerPreference): unknown {
    if (typeof value !== 'function') {
        return value;
    }
    try {
        return (value as () => unknown)();
    } catch {
        return 'unknown';
    }
}

function isGranted(preference: TStartupCrashMarkerPreference) {
    return readSeamValue(preference) === 'granted';
}

function readBooleanSeam(seam: (() => boolean) | undefined) {
    if (!seam) {
        return false;
    }
    try {
        return seam() === true;
    } catch {
        return false;
    }
}

function nextFallbackEventIdCounter() {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    return fallbackEventIdCounter;
}

const createFallbackEventId = () => createDiagnosticFallbackEventId(nextFallbackEventIdCounter, true);

function readErrorStack(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (typeof error !== 'object' || error === null) {
        return '';
    }
    try {
        const stack = (error as {stack?: unknown}).stack;
        return typeof stack === 'string' ? stack : '';
    } catch {
        return '';
    }
}

function normalizeErrorFrames(error: unknown): readonly CanonicalAppFrame[] {
    try {
        return normalizeCanonicalApplicationFrames(readErrorStack(error)).frames;
    } catch {
        return [];
    }
}

function decodeMarkerText(value: string): StartupCrashMarkerRecord | null {
    try {
        return decodeStartupCrashMarkerRecord(JSON.parse(value) as unknown);
    } catch {
        return null;
    }
}

function observeDeliveryResult(value: unknown) {
    if (
        value === null
        || typeof value !== 'object' && typeof value !== 'function'
    ) {
        return;
    }
    try {
        // The adapter seam is fire-and-forget, but a returned Promise must not
        // become an unhandled rejection during uncaught-exception handling.
        void Promise.resolve(value).catch(() => {});
    } catch {
        // Treat thenable inspection failures like any other delivery failure.
    }
}

function toFailureReceipt(marker: StartupCrashMarkerRecord): FailureReceipt {
    return {
        eventId: marker.eventId,
        code: marker.code,
        occurredAt: marker.timestamp,
        severity: 'fatal',
    };
}

export function resolveDesktopDiagnosticDist(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
    configuredDist: unknown = process.env.EVB_DIAGNOSTIC_DIST,
): DesktopDiagnosticDist | null {
    if (
        typeof configuredDist === 'string'
        && DESKTOP_DIAGNOSTIC_DIST_IDENTITIES.includes(
            configuredDist as DesktopDiagnosticDist,
        )
    ) {
        return configuredDist as DesktopDiagnosticDist;
    }

    const platformName = platform === 'darwin'
        ? 'macos'
        : platform === 'win32'
            ? 'windows'
            : platform === 'linux'
                ? 'linux'
                : null;
    const architecture = arch === 'arm64'
        ? 'arm64'
        : arch === 'x64'
            ? 'x64'
            : null;
    if (platformName === null || architecture === null) {
        return null;
    }

    const identity = `${platformName}-${architecture}`;
    return DESKTOP_DIAGNOSTIC_DIST_IDENTITIES.includes(
        identity as DesktopDiagnosticDist,
    )
        ? identity as DesktopDiagnosticDist
        : null;
}

export function installStartupCrashMarker(
    options: IStartupCrashMarkerOptions,
): IStartupCrashMarkerController {
    const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
    const processSource = options.process ?? process;
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const isLiveDeliveryAvailable = options.isLiveDeliveryAvailable;

    const takePersistedMarker = () => {
        let marker: StartupCrashMarkerRecord | null = null;
        try {
            marker = decodeMarkerText(fileSystem.readFileSync(options.markerPath, 'utf8'));
        } catch {
            // Missing, corrupt, partial, and unreadable markers are local-only.
        } finally {
            try {
                fileSystem.unlinkSync(options.markerPath);
            } catch {
                // The next launch must never leave a marker queued on disk.
            }
        }
        return marker;
    };

    let armed = isGranted(options.preference)
        && !readBooleanSeam(isLiveDeliveryAvailable);
    let monitorInstalled = false;
    let markerWriteAttempted = false;
    let replayAttempted = false;
    let persistedMarkerLoaded = false;
    let pendingReplayMarker: StartupCrashMarkerRecord | null = null;
    let liveAdapter: IStartupCrashMarkerReplayOptions | null = null;
    let liveOccurrenceAttempted = false;
    let liveReceipt: FailureReceipt | undefined;

    const removeMonitor = () => {
        if (!monitorInstalled) {
            return;
        }
        monitorInstalled = false;
        try {
            if (typeof processSource.off === 'function') {
                processSource.off('uncaughtExceptionMonitor', handleUncaughtException);
                return;
            }
        } catch {
            // Try the older spelling below when available.
        }
        try {
            processSource.removeListener?.(
                'uncaughtExceptionMonitor',
                handleUncaughtException,
            );
        } catch {
            // The state flag still prevents any further marker write.
        }
    };

    const disarm = () => {
        armed = false;
        removeMonitor();
    };

    const createMarker = (error: unknown): StartupCrashMarkerRecord | null => {
        const decoded = decodeStartupCrashMarkerRecord({
            schemaVersion: STARTUP_CRASH_MARKER_SCHEMA_VERSION,
            eventId: createSafeDiagnosticEventId(createEventId, createFallbackEventId),
            code: 'MAIN_STARTUP_CRASH',
            frames: normalizeErrorFrames(error),
            timestamp: safeDiagnosticNow(now),
            release: options.release,
            dist: options.dist,
        });
        return decoded;
    };

    const writeMarker = (error: unknown) => {
        const marker = createMarker(error);
        if (marker === null) {
            return;
        }

        try {
            const serialized = JSON.stringify(marker);
            fileSystem.writeFileSync(options.markerPath, serialized, {
                encoding: 'utf8',
                flag: 'w',
            });
        } catch {
            // A marker write is best-effort local evidence. Never report its failure.
        }
    };

    function handleUncaughtException(error: unknown) {
        if (!armed || markerWriteAttempted) {
            return;
        }
        if (!isGranted(options.preference)) {
            disarm();
            return;
        }
        if (readBooleanSeam(isLiveDeliveryAvailable)) {
            disarm();
            return;
        }

        // Reserve the one marker before inspecting the error or touching the file.
        markerWriteAttempted = true;
        writeMarker(error);
        disarm();
    }

    const processListener = handleUncaughtException;
    try {
        processSource.on('uncaughtExceptionMonitor', processListener);
        monitorInstalled = true;
    } catch {
        armed = false;
    }

    if (readBooleanSeam(isLiveDeliveryAvailable)) {
        disarm();
    }

    const replayMarkerForReadyAdapter = (
        replayOptions: IStartupCrashMarkerReplayOptions,
    ): StartupCrashMarkerRecord | null => {
        disarm();
        if (!persistedMarkerLoaded || replayAttempted) {
            return null;
        }
        replayAttempted = true;

        let sentMarker: StartupCrashMarkerRecord | null = null;
        const marker = pendingReplayMarker;
        pendingReplayMarker = null;
        const replayPreference = replayOptions.preference;
        if (marker !== null && isGranted(replayPreference)) {
            if (marker.release !== replayOptions.release || marker.dist !== replayOptions.dist) {
                try {
                    replayOptions.onDiscard?.('build-identity-mismatch');
                } catch {
                    // Local discard accounting must never affect startup recovery.
                }
                return sentMarker;
            }
            sentMarker = marker;
            try {
                observeDeliveryResult(replayOptions.send(marker));
            } catch {
                // Delivery failure must not turn the marker into a queue.
            }
        }
        return sentMarker;
    };

    /**
     * Reading the marker deletes it, so it must not be read by a launch that is
     * about to exit as a duplicate: that launch would consume the marker written
     * by the crash of the instance still running, and the crash would never be
     * reported.
     */
    const markPrimaryInstanceReady = () => {
        if (persistedMarkerLoaded) {
            return;
        }
        persistedMarkerLoaded = true;
        pendingReplayMarker = takePersistedMarker();
        if (liveAdapter !== null) {
            replayMarkerForReadyAdapter(liveAdapter);
        }
    };

    const controller: IStartupCrashMarkerController = {
        disarm,
        isArmed: () => armed,
        markPrimaryInstanceReady,
        onLiveAdapterReady: (replayOptions) => {
            liveAdapter = replayOptions;
            disarm();
            if (persistedMarkerLoaded) {
                replayMarkerForReadyAdapter(replayOptions);
            }
        },
        captureLiveException: (error) => {
            if (liveReceipt !== undefined) {
                return liveReceipt;
            }
            if (
                liveAdapter === null
                || liveOccurrenceAttempted
                || !isGranted(liveAdapter.preference)
            ) {
                return undefined;
            }

            liveOccurrenceAttempted = true;
            const marker = createMarker(error);
            if (marker === null) {
                return undefined;
            }
            liveReceipt = toFailureReceipt(marker);
            try {
                observeDeliveryResult(liveAdapter.send(marker));
            } catch {
                // The live adapter owns delivery failures. Never create a marker queue.
            }
            return liveReceipt;
        },
    };

    activeController = controller;
    return controller;
}
