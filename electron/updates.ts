import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type {
    ProgressInfo,
    UpdateDownloadedEvent,
    UpdateInfo,
} from 'electron-updater';
import type {
    IAppUpdateStatus,
    TAppUpdateCheckOrigin,
} from '@app/types/electron-api';
import { config } from '@electron/config';
import {
    loadSettings,
    saveSettings,
} from '@electron/settings';
import { createLogger } from '@electron/utils/logger';

const { autoUpdater } = electronUpdater;

interface ILandingLatestReleaseResponse {release?: {tag?: string;};}

const logger = createLogger('updates');
const UPDATER_SUPPORTED_PLATFORMS = new Set([
    'darwin',
    'win32',
]);
const METADATA_REQUEST_TIMEOUT_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_JITTER_RATIO = 0.12;

const defaultStatus: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

let status: IAppUpdateStatus = { ...defaultStatus };
let emitStatus: (status: IAppUpdateStatus) => void = () => {};
let initialized = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentCheckPromise: Promise<void> | null = null;
let currentCheckOrigin: TAppUpdateCheckOrigin = 'auto';
let downloadedVersion: string | null = null;
let pendingVersion: string | null = null;

function normalizeVersion(version: string | null | undefined) {
    if (!version) {
        return '';
    }

    return version.trim().replace(/^v/i, '').split('-')[0] ?? '';
}

function versionParts(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return [] as number[];
    }

    return normalized.split('.').map((segment) => {
        const parsed = Number.parseInt(segment, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    });
}

function compareVersions(left: string, right: string) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const maxLength = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < maxLength; i += 1) {
        const leftValue = leftParts[i] ?? 0;
        const rightValue = rightParts[i] ?? 0;
        if (leftValue === rightValue) {
            continue;
        }
        return leftValue > rightValue ? 1 : -1;
    }

    return 0;
}

function updateStatus(next: Partial<IAppUpdateStatus>) {
    status = {
        ...status,
        ...next,
    };
    emitStatus(status);
}

function isUpdaterSupported() {
    return app.isPackaged && UPDATER_SUPPORTED_PLATFORMS.has(process.platform);
}

function isAbortError(error: unknown) {
    return error instanceof Error
        && (error.name === 'AbortError' || error.message.includes('aborted'));
}

async function readSkippedVersion() {
    const settings = await loadSettings();
    const skipped = normalizeVersion(settings.skippedUpdateVersion);
    return skipped || null;
}

async function writeSkippedVersion(version: string | null) {
    const settings = await loadSettings();
    const normalized = normalizeVersion(version);
    settings.skippedUpdateVersion = normalized || undefined;
    await saveSettings(settings);
}

async function fetchLatestMetadataVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), METADATA_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(config.updates.metadataUrl, {
            headers: {accept: 'application/json'},
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`Metadata endpoint responded with ${response.status}`);
        }

        const payload = await response.json() as ILandingLatestReleaseResponse;
        const latestTag = normalizeVersion(payload.release?.tag);
        if (!latestTag) {
            throw new Error('Metadata endpoint did not return release.tag');
        }
        return latestTag;
    } finally {
        clearTimeout(timeout);
    }
}

function scheduleNextPoll() {
    if (!isUpdaterSupported()) {
        return;
    }

    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    const baseInterval = Math.max(config.updates.pollIntervalMs, MIN_POLL_INTERVAL_MS);
    const jitter = Math.round(baseInterval * ((Math.random() * 2 * MAX_JITTER_RATIO) - MAX_JITTER_RATIO));
    const delay = Math.max(MIN_POLL_INTERVAL_MS, baseInterval + jitter);

    pollTimer = setTimeout(() => {
        void checkForUpdates('auto').finally(() => {
            scheduleNextPoll();
        });
    }, delay);
}

function setAutoUpdaterListeners() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => {
        updateStatus({
            phase: 'checking',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: null,
            message: null,
        });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
        const version = normalizeVersion(info.version) || pendingVersion;
        pendingVersion = version || null;
        updateStatus({
            phase: 'downloading',
            origin: currentCheckOrigin,
            version: version || null,
            percent: 0,
            message: null,
        });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
        updateStatus({
            phase: 'downloading',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: progress.percent,
            message: null,
        });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
        pendingVersion = null;
        if (currentCheckOrigin !== 'manual') {
            return;
        }

        updateStatus({
            phase: 'no-update',
            origin: 'manual',
            version: normalizeVersion(info.version) || normalizeVersion(app.getVersion()) || null,
            percent: null,
            message: null,
        });
    });

    autoUpdater.on('error', (error) => {
        logger.error(`Updater error: ${error instanceof Error ? error.message : String(error)}`);
        if (currentCheckOrigin !== 'manual') {
            return;
        }

        updateStatus({
            phase: 'error',
            origin: 'manual',
            version: pendingVersion,
            percent: null,
            message: error instanceof Error ? error.message : String(error),
        });
    });

    autoUpdater.on('update-downloaded', async (event: UpdateDownloadedEvent) => {
        const version = normalizeVersion(event.version) || pendingVersion;
        pendingVersion = version || null;
        downloadedVersion = version || null;

        const skippedVersion = await readSkippedVersion();
        if (
            currentCheckOrigin === 'auto'
            && skippedVersion
            && version
            && skippedVersion === version
        ) {
            logger.info(`Update ${version} downloaded but skipped for automatic prompts`);
            updateStatus({
                phase: 'idle',
                origin: 'auto',
                version,
                percent: null,
                message: null,
            });
            return;
        }

        updateStatus({
            phase: 'downloaded',
            origin: currentCheckOrigin,
            version: version || null,
            percent: 100,
            message: null,
        });
    });
}

async function shouldRunUpdaterCheck(origin: TAppUpdateCheckOrigin) {
    const currentVersion = normalizeVersion(app.getVersion());
    let latestVersion: string;

    try {
        latestVersion = await fetchLatestMetadataVersion();
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking for updates.'
            : (error instanceof Error ? error.message : String(error));
        logger.warn(`Unable to query update metadata: ${message}`);

        if (origin === 'manual') {
            updateStatus({
                phase: 'error',
                origin: 'manual',
                version: currentVersion || null,
                percent: null,
                message,
            });
        }
        return false;
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
        if (origin === 'manual') {
            updateStatus({
                phase: 'no-update',
                origin: 'manual',
                version: currentVersion || latestVersion,
                percent: null,
                message: null,
            });
        }
        return false;
    }

    const skippedVersion = await readSkippedVersion();
    if (
        skippedVersion
        && compareVersions(latestVersion, skippedVersion) > 0
    ) {
        // Newer release exists; stale skip can be dropped.
        await writeSkippedVersion(null);
    }

    if (origin === 'auto' && skippedVersion && skippedVersion === latestVersion) {
        logger.info(`Skipping automatic prompt for ignored version ${latestVersion}`);
        return false;
    }

    pendingVersion = latestVersion;
    return true;
}

async function checkForUpdates(origin: TAppUpdateCheckOrigin) {
    if (!isUpdaterSupported()) {
        if (origin === 'manual') {
            updateStatus({
                phase: 'unsupported',
                origin: 'manual',
                version: normalizeVersion(app.getVersion()) || null,
                percent: null,
                message: 'Updates are available only in packaged macOS/Windows builds.',
            });
        }
        return;
    }

    if (downloadedVersion) {
        const skippedVersion = await readSkippedVersion();
        if (!(origin === 'auto' && skippedVersion === downloadedVersion)) {
            updateStatus({
                phase: 'downloaded',
                origin,
                version: downloadedVersion,
                percent: 100,
                message: null,
            });
        }
        return;
    }

    if (currentCheckPromise) {
        if (origin === 'manual') {
            updateStatus({
                phase: 'checking',
                origin: 'manual',
                version: pendingVersion,
                percent: null,
                message: null,
            });
        }
        return;
    }

    currentCheckOrigin = origin;
    currentCheckPromise = (async () => {
        const shouldCheckBinary = await shouldRunUpdaterCheck(origin);
        if (!shouldCheckBinary) {
            return;
        }

        try {
            await autoUpdater.checkForUpdates();
        } catch (error) {
            logger.error(`checkForUpdates failed: ${error instanceof Error ? error.message : String(error)}`);
            if (origin === 'manual') {
                updateStatus({
                    phase: 'error',
                    origin: 'manual',
                    version: pendingVersion,
                    percent: null,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    })().finally(() => {
        currentCheckPromise = null;
    });

    await currentCheckPromise;
}

export function initializeUpdates(onStatus: (status: IAppUpdateStatus) => void) {
    emitStatus = onStatus;
    emitStatus(status);

    if (initialized) {
        return;
    }
    initialized = true;

    setAutoUpdaterListeners();

    if (!isUpdaterSupported()) {
        logger.info('Automatic updates disabled in this runtime');
        return;
    }

    const initialDelayMs = Math.max(config.updates.initialDelayMs, 1000);
    pollTimer = setTimeout(() => {
        void checkForUpdates('auto').finally(() => {
            scheduleNextPoll();
        });
    }, initialDelayMs);
}

export async function triggerManualUpdateCheck() {
    await checkForUpdates('manual');
    return { started: true };
}

export function getUpdateStatus() {
    return status;
}

export async function installDownloadedUpdate() {
    if (!downloadedVersion) {
        return { started: false };
    }

    await writeSkippedVersion(null);
    autoUpdater.quitAndInstall(false, true);
    return { started: true };
}

export async function deferDownloadedUpdate() {
    if (!downloadedVersion) {
        return;
    }

    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: downloadedVersion,
        percent: null,
        message: null,
    });
}

export async function skipUpdateVersion(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return;
    }

    await writeSkippedVersion(normalized);
    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: normalized,
        percent: null,
        message: null,
    });
}
