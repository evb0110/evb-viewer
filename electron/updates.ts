import {app} from 'electron';
import electronUpdater, {CancellationToken} from 'electron-updater';
import { clamp } from 'es-toolkit/math';
import type {
    ProgressInfo,
    UpdateDownloadedEvent,
    UpdateInfo,
} from 'electron-updater';
import type {
    IAppUpdateStatus,
    TAppUpdateCheckOrigin,
    TAppUpdateReason,
} from '@contracts/updatesPlatformFeature';
import { config } from '@electron/config';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { redactElectronLogText } from '@electron/utils/redactElectronLogText';
import { isExpectedUpdateNetworkError } from '@electron/utils/isExpectedUpdateNetworkError';
import {
    compareVersions,
    normalizeVersion,
} from '@electron/updates/versionCompare';
import { checkMacCodeSignature } from '@electron/updates/checkMacCodeSignature';
import {
    getSuppressedUpdateVersion,
    markUpdateInstallPending,
    recordPendingUpdateStartup,
    UPDATE_STARTUP_FAILURE_THRESHOLD,
} from '@electron/updateHealthMarker';
import { runDetached } from '@electron/utils/runDetached';
import { resolveApplicationVersion } from '@electron/appVersion';
import { fetchLatestReleaseMetadataVersion } from '@electron/updates/fetchLatestReleaseMetadataVersion';

const { autoUpdater } = electronUpdater;

const logger = createLogger('updates');
const METADATA_REQUEST_TIMEOUT_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_JITTER_RATIO = 0.12;
const UPDATE_PROGRESS_BROADCAST_THROTTLE_MS = 250;
const UPDATER_SHUTDOWN_CHECK_WAIT_TIMEOUT_MS = 3_000;
const UPDATER_SHUTDOWN_DOWNLOAD_WAIT_TIMEOUT_MS = 3_000;
const GITHUB_RELEASE_OWNER = 'evb0110';
const GITHUB_RELEASE_REPOSITORY = 'evb-viewer';
const GITHUB_RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${GITHUB_RELEASE_OWNER}/${GITHUB_RELEASE_REPOSITORY}/releases/download`;
let resolvedReleaseFeedBaseUrl = GITHUB_RELEASE_DOWNLOAD_BASE_URL;

interface IUpdaterCheckDecision {
    shouldCheck: boolean;
    targetVersion: string | null;
    errorMessage?: string;
    errorReason?: TAppUpdateReason;
}

const defaultStatus: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

let status: IAppUpdateStatus = { ...defaultStatus };
// Each window gets its own copy of the status, built from its webContents id.
export type TUpdateStatusBroadcast = (status: IAppUpdateStatus) => void;
export interface IUpdateRequester {senderId: number;}
let emitStatus: TUpdateStatusBroadcast = () => {};
// Requesters belong to the operation, including its asynchronous install callback.
let operationRequesters: Set<number> | null = null;
let statusRequesters: Set<number> | null = null;
let pendingStartupFailure: IAppUpdateStatus | null = null;
let initialized = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentCheckPromise: Promise<void> | null = null;
let currentDownloadPromise: Promise<void> | null = null;
let currentDownloadCancellationToken: CancellationToken | null = null;
let currentCheckOrigin: TAppUpdateCheckOrigin = 'auto';
let isShuttingDown = false;
let downloadedVersion: string | null = null;
let pendingVersion: string | null = null;
let approvedDownloadAndInstallVersion: string | null = null;
let codeSignatureCheckPromise: Promise<boolean> | null = null;
let codeSignatureValid: boolean | null = null;
let listenersRegistered = false;
let progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressBroadcastAt = 0;
const autoUpdaterListenerUnsubscribe: Array<() => void> = [];
type TUpdateInstallShutdownRequester = (install: () => Promise<void>) => void;
function runUpdateInstallImmediately(install: () => Promise<void>) {
    // No coordinator is wired up, so nothing awaits the install; its failure has
    // to be reported here or it becomes an unhandled rejection.
    void install().catch(error => {
        logger.error(`Update installation action failed: ${getErrorMessage(error)}`, {
            code: 'MAIN_UPDATE_INSTALL_FAILED',
            cause: error,
        });
    });
}

let requestUpdateInstallShutdown: TUpdateInstallShutdownRequester = runUpdateInstallImmediately;
function logUpdateCheckFailure(error: unknown, origin: TAppUpdateCheckOrigin) {
    const message = `Update check failed: ${getErrorMessage(error)}`;
    if (origin === 'auto' || isExpectedUpdateNetworkError(error)) {
        logger.warn(message);
        return;
    }
    logger.error(message, {
        code: 'MAIN_UPDATE_CHECK_FAILED',
        cause: error,
    });
}

export function configureUpdateInstallShutdown(requester: TUpdateInstallShutdownRequester | null) {
    requestUpdateInstallShutdown = requester ?? runUpdateInstallImmediately;
}

function getCurrentVersion() {
    return normalizeVersion(resolveApplicationVersion(app)) || null;
}

function clearProgressBroadcastTimer() {
    if (!progressBroadcastTimer) {
        return;
    }

    clearTimeout(progressBroadcastTimer);
    progressBroadcastTimer = null;
}

export function projectUpdateStatusForWindow(snapshot: IAppUpdateStatus, senderId: number): IAppUpdateStatus {
    const requestedHere = snapshot === pendingStartupFailure
        || statusRequesters === null || statusRequesters.has(senderId);
    if (snapshot === pendingStartupFailure) pendingStartupFailure = null;
    return {
        ...snapshot,
        ...(snapshot.phase === 'downloading' && !requestedHere ? {
            phase: 'available' as const,
            percent: null,
        } : {}),
        requestedHere,
    };
}

function broadcastStatusNow() {
    emitStatus(status);
}

function broadcastProgressStatus() {
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = Date.now();
    broadcastStatusNow();
}

function updateStatus(next: Partial<IAppUpdateStatus>, requesters = operationRequesters) {
    statusRequesters = requesters;
    const message = next.message === undefined
        ? status.message
        : typeof next.message === 'string'
            ? redactElectronLogText(next.message)
            : next.message;
    status = {
        ...status,
        ...next,
        message,
        reason: next.reason ?? (next.message === undefined ? status.reason : undefined),
    };

    if (next === pendingStartupFailure) {
        pendingStartupFailure = status;
    }
    if (status.phase !== 'downloading') {
        clearProgressBroadcastTimer();
        broadcastStatusNow();
        return;
    }

    const now = Date.now();
    const elapsed = now - lastProgressBroadcastAt;
    const shouldBroadcastImmediately = lastProgressBroadcastAt === 0
        || status.percent === 0
        || status.percent === 100
        || elapsed >= UPDATE_PROGRESS_BROADCAST_THROTTLE_MS;

    if (shouldBroadcastImmediately) {
        broadcastProgressStatus();
        return;
    }

    if (!progressBroadcastTimer) {
        const delay = Math.max(0, UPDATE_PROGRESS_BROADCAST_THROTTLE_MS - elapsed);
        progressBroadcastTimer = setTimeout(() => {
            progressBroadcastTimer = null;
            if (status.phase !== 'downloading') {
                return;
            }
            broadcastProgressStatus();
        }, delay);
        progressBroadcastTimer.unref();
    }
}

function setIdleStatus(origin: TAppUpdateCheckOrigin, version: string | null = getCurrentVersion()) {
    updateStatus({
        phase: 'idle',
        origin,
        version,
        percent: null,
        message: null,
    });
}

// Store builds use Store updates. Standalone Windows installers have separate
// architecture feeds; electron-updater verifies publisher signatures when configured.
function isUpdaterRuntimeSupported() {
    return app.isPackaged
        && process.windowsStore !== true
        && ((process.platform === 'darwin' && process.arch === 'arm64')
            || (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')));
}

function getUpdateFailureReason(error: unknown, operation: 'check' | 'download' | 'install'): TAppUpdateReason {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (isAbortError(cause) || (cause instanceof Error && cause.name === 'TimeoutError')) {
        return operation === 'check' ? 'check-timed-out' : `${operation}-failed`;
    }
    return isExpectedUpdateNetworkError(cause) ? 'network-unavailable' : `${operation}-failed`;
}

async function ensureUpdaterSupported() {
    if (!isUpdaterRuntimeSupported()) {
        return false;
    }
    if (process.platform !== 'darwin') {
        return true;
    }
    if (codeSignatureValid !== null) {
        return codeSignatureValid;
    }

    codeSignatureCheckPromise ??= checkMacCodeSignature()
        .then((valid) => {
            if (valid !== null) {
                codeSignatureValid = valid;
            }
            if (valid === false) {
                logger.info('Ad-hoc code signature detected; auto-updates require Developer ID signing');
            } else if (valid === null) {
                logger.info('Unable to validate macOS code signature; will retry updater support check');
            }
            return valid === true;
        })
        .catch(() => {
            logger.info('Unable to validate macOS code signature; will retry updater support check');
            return false;
        })
        .finally(() => {
            codeSignatureCheckPromise = null;
        });

    return codeSignatureCheckPromise;
}

async function readSkippedVersion() {
    const settings = await loadSettings();
    return normalizeVersion(settings.skippedUpdateVersion) || null;
}

async function writeSkippedVersion(version: string | null) {
    const normalized = normalizeVersion(version);
    await updateSettings((settings) => {
        if (normalized) {
            settings.skippedUpdateVersion = normalized;
        } else {
            delete settings.skippedUpdateVersion;
        }
        return undefined;
    });
}

function getUpdaterMetadataAssetName() {
    if (process.platform === 'win32') {
        return `latest-win-${process.arch}.yml`;
    }
    if (process.platform === 'darwin') {
        return 'latest-mac.yml';
    }
    return null;
}

function getReleaseTag(version: string) {
    return version.startsWith('v') ? version : `v${version}`;
}

function getUpdaterReleaseFeedUrl(version: string, baseUrl = resolvedReleaseFeedBaseUrl) {
    return `${baseUrl}/${encodeURIComponent(getReleaseTag(version))}`;
}

function configureUpdaterFeed(targetVersion: string) {
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: getUpdaterReleaseFeedUrl(targetVersion),
        ...(process.platform === 'win32' ? {channel: `latest-win-${process.arch}`} : {}),
        // GitHub release downloads redirect through S3, whose responses do
        // not support electron-updater's multi-range request format.
        useMultipleRangeRequest: false,
    });
}

async function hasUpdaterMetadataForVersion(version: string) {
    const assetName = getUpdaterMetadataAssetName();
    if (!assetName) {
        return false;
    }

    const errors: Array<{
        baseUrl: string;
        error: unknown
    }> = [];
    for (const baseUrl of [
        GITHUB_RELEASE_DOWNLOAD_BASE_URL,
        config.updates.mirrorReleaseBaseUrl,
    ]) {
        try {
            const url = `${getUpdaterReleaseFeedUrl(version, baseUrl)}/${assetName}`;
            const response = await fetch(url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
            });
            if (response.status === 404) {
                continue;
            }
            if (!response.ok) {
                throw new Error(`Updater metadata probe responded with ${response.status}`);
            }
            resolvedReleaseFeedBaseUrl = baseUrl;
            return true;
        } catch (error) {
            errors.push({
                baseUrl,
                error,
            });
        }
    }
    if (errors.length > 0) {
        throw new Error(`Updater feed verification was inconclusive (${errors.map(({
            baseUrl, error,
        }) => `${baseUrl}: ${getErrorMessage(error)}`).join('; ')})`, {cause: errors[0]?.error});
    }
    return false;
}

function validateDownloadedUpdateForInstall(version: string) {
    const currentVersion = getCurrentVersion();
    if (!currentVersion || compareVersions(version, currentVersion) <= 0) {
        throw new Error(`Downloaded update ${version} is not newer than the running version ${currentVersion ?? 'unknown'}`);
    }
}

function clearDownloadedCandidate(version: string) {
    if (downloadedVersion === version) {
        downloadedVersion = null;
    }
    if (pendingVersion === version) {
        pendingVersion = null;
    }
    if (approvedDownloadAndInstallVersion === version) {
        approvedDownloadAndInstallVersion = null;
    }
}

function discardDownloadedCandidateIfNotNewer(context: string) {
    if (!downloadedVersion) {
        return false;
    }
    const currentVersion = getCurrentVersion();
    if (!currentVersion || compareVersions(downloadedVersion, currentVersion) > 0) {
        return false;
    }

    const invalidVersion = downloadedVersion;
    clearDownloadedCandidate(invalidVersion);
    logger.warn(
        `Discarding downloaded update ${invalidVersion} during ${context}; running version is ${currentVersion}`,
    );
    return true;
}

async function maybeClearSupersededDownloadedVersion() {
    if (!downloadedVersion) {
        return false;
    }

    try {
        const latestVersion = await fetchLatestReleaseMetadataVersion(config.updates.metadataUrl, logger);
        const comparison = compareVersions(latestVersion, downloadedVersion);
        if (comparison < 0) {
            logger.warn(
                `Discarding cached downloaded update ${downloadedVersion}; current metadata rolled back to ${latestVersion}`,
            );
            downloadedVersion = null;
            pendingVersion = latestVersion;
            return true;
        }

        if (comparison === 0) {
            if (!await hasUpdaterMetadataForVersion(downloadedVersion)) {
                logger.warn(
                    `Discarding cached downloaded update ${downloadedVersion}; its updater feed is no longer published`,
                );
                downloadedVersion = null;
                pendingVersion = null;
                return true;
            }
            return false;
        }

        if (!await hasUpdaterMetadataForVersion(latestVersion)) {
            logger.info(
                `Keeping cached downloaded update ${downloadedVersion}; newer release ${latestVersion} has no ${getUpdaterMetadataAssetName() ?? '<unsupported platform>'} updater feed`,
            );
            return false;
        }

        logger.info(
            `Discarding cached downloaded update ${downloadedVersion} in favor of newer metadata release ${latestVersion}`,
        );
        downloadedVersion = null;
        pendingVersion = latestVersion;
        return true;
    } catch (error) {
        logger.warn(
            `Unable to verify whether downloaded update ${downloadedVersion ?? '<unknown>'} is current: ${
                getErrorMessage(error)
            }`,
        );
        return false;
    }
}

function scheduleNextPoll() {
    if (isShuttingDown) {
        return;
    }
    if (!isUpdaterRuntimeSupported()) {
        return;
    }

    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    const baseInterval = clamp(config.updates.pollIntervalMs, MIN_POLL_INTERVAL_MS, Number.POSITIVE_INFINITY);
    const jitter = Math.round(baseInterval * ((Math.random() * 2 * MAX_JITTER_RATIO) - MAX_JITTER_RATIO));
    const delay = clamp(baseInterval + jitter, MIN_POLL_INTERVAL_MS, Number.POSITIVE_INFINITY);

    pollTimer = schedulePollTimer(delay, 'Automatic update poll failed');
}

function schedulePollTimer(delayMs: number, failureLogPrefix: string) {
    return setTimeout(() => {
        if (isShuttingDown) {
            return;
        }
        void checkForUpdates('auto')
            .catch((error) => {
                logger.warn(`${failureLogPrefix}: ${getErrorMessage(error)}`);
            })
            .finally(() => {
                if (!isShuttingDown) {
                    scheduleNextPoll();
                }
            });
    }, delayMs);
}

function setAutoUpdaterListeners() {
    if (listenersRegistered) {
        return;
    }
    listenersRegistered = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    const onCheckingForUpdate = () => {
        updateStatus({
            phase: 'checking',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('checking-for-update', onCheckingForUpdate);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('checking-for-update', onCheckingForUpdate);
    });

    const onUpdateAvailable = (info: UpdateInfo) => {
        const version = normalizeVersion(info.version) || pendingVersion;
        pendingVersion = version;
        updateStatus({
            phase: 'available',
            origin: currentCheckOrigin,
            version,
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('update-available', onUpdateAvailable);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-available', onUpdateAvailable);
    });

    const onDownloadProgress = (progress: ProgressInfo) => {
        updateStatus({
            phase: 'downloading',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: progress.percent,
            message: null,
        });
    };
    autoUpdater.on('download-progress', onDownloadProgress);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('download-progress', onDownloadProgress);
    });

    const onUpdateNotAvailable = (info: UpdateInfo) => {
        pendingVersion = null;
        if (currentCheckOrigin !== 'manual') {
            setIdleStatus('auto', normalizeVersion(info.version) || getCurrentVersion());
            return;
        }

        updateStatus({
            phase: 'no-update',
            origin: 'manual',
            version: normalizeVersion(info.version) || getCurrentVersion(),
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('update-not-available', onUpdateNotAvailable);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
    });

    const onUpdaterError = (error: unknown) => {
        // electron-updater emits then rejects. The operation's catch owns its
        // terminal result; the event handles only failures outside those promises.
        if (currentCheckPromise || currentDownloadPromise) {
            return;
        }
        logUpdateCheckFailure(error, currentCheckOrigin);
        const version = downloadedVersion;
        if (!version) return;
        clearDownloadedCandidate(version);
        updateStatus({
            phase: 'error',
            reason: getUpdateFailureReason(error, 'install'),
            origin: 'manual',
            version,
            percent: null,
            message: getErrorMessage(error),
        }, statusRequesters);
    };
    autoUpdater.on('error', onUpdaterError);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('error', onUpdaterError);
    });

    const onUpdateDownloaded = (event: UpdateDownloadedEvent) => {
        downloadedVersion = normalizeVersion(event.version) || pendingVersion;
    };
    autoUpdater.on('update-downloaded', onUpdateDownloaded);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
    });
}

async function finishDownloadedUpdate(requesters: Set<number> | null) {
    const version = downloadedVersion;
    if (!version) return;
    try {
        if (discardDownloadedCandidateIfNotNewer('download event')) {
            updateStatus({
                phase: currentCheckOrigin === 'manual' ? 'no-update' : 'idle',
                origin: currentCheckOrigin,
                version: getCurrentVersion(),
                percent: null,
                message: null,
            }, requesters);
            return;
        }

        const skippedVersion = await readSkippedVersion();
        if (
            currentCheckOrigin === 'auto'
            && skippedVersion
            && skippedVersion === version
        ) {
            logger.info(`Update ${version} downloaded but skipped for automatic prompts`);
            updateStatus({
                phase: 'idle',
                origin: 'auto',
                version,
                percent: null,
                message: null,
            }, requesters);
            return;
        }

        if (approvedDownloadAndInstallVersion) {
            await installDownloadedUpdate(null, requesters);
            return;
        }

        updateStatus({
            phase: 'downloaded',
            origin: currentCheckOrigin,
            version,
            percent: 100,
            message: null,
        }, requesters);
    } catch (error) {
        const message = `Update install preparation failed: ${getErrorMessage(error)}`;
        logger.error(message, {
            code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
            cause: error,
        });
        updateStatus({
            phase: 'error',
            reason: 'install-preparation-failed',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: null,
            message,
        }, requesters);
    }
}

async function resolveUpdaterCheckDecision(): Promise<IUpdaterCheckDecision> {
    const currentVersion = normalizeVersion(resolveApplicationVersion(app));
    let latestVersion: string;
    resolvedReleaseFeedBaseUrl = GITHUB_RELEASE_DOWNLOAD_BASE_URL;

    try {
        latestVersion = await fetchLatestReleaseMetadataVersion(config.updates.metadataUrl, logger);
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking for updates.'
            : `Update check failed: ${getErrorMessage(error)}`;
        logger.warn(`Unable to query update metadata: ${message}`);
        return {
            shouldCheck: false,
            targetVersion: null,
            errorMessage: message,
            errorReason: getUpdateFailureReason(error, 'check'),
        };
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
        pendingVersion = null;
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    const suppressedVersion = await getSuppressedUpdateVersion(currentVersion);
    if (suppressedVersion === latestVersion) {
        logger.info(`Suppressing update ${latestVersion} after repeated startup failures; install a newer candidate or update manually`);
        pendingVersion = null;
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    try {
        if (!await hasUpdaterMetadataForVersion(latestVersion)) {
            logger.info(`Release ${latestVersion} has no ${getUpdaterMetadataAssetName() ?? '<unsupported platform>'} updater feed; skipping in-app updater check`);
            pendingVersion = null;
            return {
                shouldCheck: false,
                targetVersion: latestVersion,
                errorReason: 'feed-unavailable',
                errorMessage: `Update ${latestVersion} is available, but its ${getUpdaterMetadataAssetName() ?? '<unsupported platform>'} feed is not published. Download the release manually.`,
            };
        }
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking updater metadata.'
            : `Update feed verification failed: ${getErrorMessage(error)}`;
        logger.warn(`Unable to verify updater metadata for ${latestVersion}: ${message}`);
        return {
            shouldCheck: false,
            targetVersion: null,
            errorMessage: message,
            errorReason: getUpdateFailureReason(error, 'check'),
        };
    }

    const skippedVersion = await readSkippedVersion();
    if (
        skippedVersion
        && compareVersions(latestVersion, skippedVersion) > 0
    ) {
        // Newer release exists; stale skip can be dropped.
        await writeSkippedVersion(null);
    }

    if (skippedVersion && skippedVersion === latestVersion) {
        logger.info(`Skipping automatic prompt for ignored version ${latestVersion}`);
        pendingVersion = null;
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    pendingVersion = latestVersion;
    return {
        shouldCheck: true,
        targetVersion: latestVersion,
    };
}

async function checkForUpdates(origin: TAppUpdateCheckOrigin) {
    if (isShuttingDown) {
        return;
    }
    if (currentCheckPromise) {
        if (origin === 'manual') {
            updateStatus({
                phase: 'checking',
                origin,
                version: pendingVersion,
                percent: null,
                message: null,
            });
            if (currentCheckOrigin === 'auto') {
                await currentCheckPromise;
                return checkForUpdates('manual');
            }
        }
        return currentCheckPromise;
    }
    currentCheckOrigin = origin;
    const requesters = operationRequesters;
    currentCheckPromise = (async () => {
        if (!isUpdaterRuntimeSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: null,
                    reason: process.windowsStore === true ? 'store-updates' : 'runtime-unsupported',
                });
            }
            return;
        }
        if (!await ensureUpdaterSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: 'Updates require a signed packaged build.',
                    reason: 'signed-build-required',
                });
            } else {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'auto',
                    version: getCurrentVersion(),
                    percent: null,
                    message: null,
                });
            }
            return;
        }

        discardDownloadedCandidateIfNotNewer('update check');
        const supersededDownloadedVersion = await maybeClearSupersededDownloadedVersion();
        if (downloadedVersion && !supersededDownloadedVersion) {
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

        const decision = await resolveUpdaterCheckDecision();
        if (!decision.shouldCheck) {
            if (decision.errorMessage && origin === 'manual') {
                updateStatus({
                    phase: 'error',
                    reason: decision.errorReason,
                    origin,
                    version: decision.targetVersion ?? pendingVersion ?? getCurrentVersion(),
                    percent: null,
                    message: decision.errorMessage,
                });
                return;
            }
            if (decision.errorMessage) {
                setIdleStatus('auto');
                return;
            }
            if (origin === 'manual') {
                updateStatus({
                    phase: 'no-update',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: null,
                });
            } else {
                setIdleStatus('auto');
            }
            return;
        }

        // The rollout endpoint owns candidate selection, rather than GitHub latest.
        if (!decision.targetVersion) {
            throw new Error('Update metadata selected no target release.');
        }
        configureUpdaterFeed(decision.targetVersion);
        await autoUpdater.checkForUpdates();
        await finishDownloadedUpdate(requesters);
    })().catch(error => {
        logUpdateCheckFailure(error, origin);
        updateStatus({
            phase: 'error',
            reason: getUpdateFailureReason(error, 'check'),
            origin,
            version: pendingVersion,
            percent: null,
            message: `Update check failed: ${getErrorMessage(error)}`,
        }, requesters);
    }).finally(() => {
        currentCheckPromise = null;
    });
    return currentCheckPromise;
}

export function initializeUpdates(broadcast: TUpdateStatusBroadcast) {
    isShuttingDown = false;
    emitStatus = broadcast;
    broadcastStatusNow();

    if (initialized) {
        return;
    }
    initialized = true;

    const currentVersion = getCurrentVersion();
    if (currentVersion) {
        runDetached(
            async () => {
                const marker = await recordPendingUpdateStartup(currentVersion);
                if (marker && !marker.installationApplied) {
                    const message = `Update installation failed: ${marker.pendingVersion} could not be installed; version ${currentVersion} was relaunched`;
                    logger.error(message, {
                        code: 'MAIN_UPDATE_STARTUP_FAILED',
                        cause: marker,
                    });
                    pendingStartupFailure = {
                        phase: 'error',
                        reason: 'install-failed',
                        origin: 'manual',
                        version: marker.pendingVersion,
                        percent: null,
                        message,
                    };
                    updateStatus(pendingStartupFailure, new Set());

                } else if (marker && marker.startupAttempts >= UPDATE_STARTUP_FAILURE_THRESHOLD) {
                    logger.error(
                        `Update ${currentVersion} failed to reach renderer readiness on ${marker.startupAttempts} consecutive startups`,
                        {
                            code: 'MAIN_UPDATE_STARTUP_FAILED',
                            cause: marker,
                        },
                    );
                }
            },
            {
                label: 'record pending update startup',
                logger,
            },
        );
    }

    setAutoUpdaterListeners();

    if (!isUpdaterRuntimeSupported()) {
        logger.info('Automatic updates disabled in this runtime');
        updateStatus({
            phase: 'unsupported',
            origin: 'auto',
            version: getCurrentVersion(),
            percent: null,
            message: null,
        });
        return;
    }

    if (process.platform === 'darwin') {
        void ensureUpdaterSupported()
            .then((supported) => {
                if (supported) {
                    return;
                }
                if (codeSignatureValid === null) {
                    return;
                }
                if (pollTimer) {
                    clearTimeout(pollTimer);
                    pollTimer = null;
                }
                updateStatus({
                    phase: 'unsupported',
                    origin: 'auto',
                    version: getCurrentVersion(),
                    percent: null,
                    message: null,
                });
            })
            .catch((error) => {
                logger.warn(`Updater signature check failed: ${getErrorMessage(error)}`);
            });
    }

    const initialDelayMs = Math.max(config.updates.initialDelayMs, 1000);
    pollTimer = schedulePollTimer(initialDelayMs, 'Initial automatic update check failed');
}

export async function triggerManualUpdateCheck(requester: IUpdateRequester) {
    if (isShuttingDown) {
        return { started: false };
    }
    if (currentDownloadPromise && status.phase !== 'downloading') {
        await currentDownloadPromise;
    }
    const requesters = operationRequesters ?? new Set<number>();
    operationRequesters = requesters;
    requesters.add(requester.senderId);
    if (currentDownloadPromise) {
        broadcastStatusNow();
        await currentDownloadPromise;
    } else {
        try {
            await checkForUpdates('manual');
        } finally {
            if (operationRequesters === requesters && !currentCheckPromise) {
                operationRequesters = null;
            }
        }
    }
    return { started: true };
}

export function getUpdateStatus(requester?: IUpdateRequester) {
    if (requester && pendingStartupFailure) {
        const failure = pendingStartupFailure;
        pendingStartupFailure = null;
        return {
            ...failure,
            requestedHere: true,
        };
    }
    return status.version !== null ? status : {
        ...status,
        version: getCurrentVersion(),
    };
}

export function downloadAvailableUpdate(requester: IUpdateRequester) {
    if (isShuttingDown || !pendingVersion || downloadedVersion) {
        return { started: false };
    }

    if (currentDownloadPromise) {
        operationRequesters?.add(requester.senderId);
        broadcastStatusNow();
        return {started: true};
    }
    const requesters = new Set([requester.senderId]);
    operationRequesters = requesters;
    const candidateVersion = pendingVersion;
    approvedDownloadAndInstallVersion = candidateVersion;
    currentCheckOrigin = 'manual';
    updateStatus({
        phase: 'downloading',
        origin: 'manual',
        version: candidateVersion,
        percent: 0,
        message: null,
    });

    const downloadCancellationToken = new CancellationToken();
    currentDownloadCancellationToken = downloadCancellationToken;
    currentDownloadPromise = Promise.resolve()
        .then(() => {
            if (isShuttingDown || downloadCancellationToken.cancelled) {
                return;
            }
            return autoUpdater.downloadUpdate(downloadCancellationToken);
        })
        .then(() => finishDownloadedUpdate(requesters))
        .catch((error) => {
            if (isShuttingDown || downloadCancellationToken.cancelled) {
                return;
            }
            downloadedVersion = null;
            approvedDownloadAndInstallVersion = null;
            const message = `Update download failed: ${getErrorMessage(error)}`;
            if (isExpectedUpdateNetworkError(error)) {
                logger.warn(message);
            } else {
                logger.error(message, {
                    code: 'MAIN_UPDATE_DOWNLOAD_FAILED',
                    cause: error,
                });
            }
            updateStatus({
                phase: 'error',
                reason: getUpdateFailureReason(error, 'download'),
                origin: 'manual',
                version: candidateVersion,
                percent: null,
                message,
            }, requesters);
        })
        .finally(() => {
            downloadCancellationToken.dispose();
            if (currentDownloadCancellationToken === downloadCancellationToken) {
                currentDownloadCancellationToken = null;
            }
            currentDownloadPromise = null;
            if (operationRequesters === requesters) operationRequesters = null;
        });

    return { started: true };
}

// A null requester is the approved download finishing: its window already asked.
export async function installDownloadedUpdate(requester: IUpdateRequester | null, requesters = operationRequesters) {
    if (!downloadedVersion) {
        return { started: false };
    }

    if (requester) {
        requesters = new Set([requester.senderId]);
    }
    const candidateVersion = approvedDownloadAndInstallVersion ?? downloadedVersion;
    approvedDownloadAndInstallVersion = null;

    // Installation is always user-initiated, so errors must surface to the UI
    currentCheckOrigin = 'manual';

    try {
        if (downloadedVersion !== candidateVersion) {
            throw new Error(`Downloaded update ${downloadedVersion} did not match approved version ${candidateVersion}`);
        }
        validateDownloadedUpdateForInstall(candidateVersion);
    } catch (error) {
        clearDownloadedCandidate(downloadedVersion);
        const message = `Update installation failed: ${getErrorMessage(error)}`;
        logger.warn(message);
        updateStatus({
            phase: 'error',
            reason: 'install-failed',
            origin: 'manual',
            version: candidateVersion,
            percent: null,
            message,
        }, requesters);
        return { started: false };
    }

    try {
        await writeSkippedVersion(null);
    } catch (error) {
        logger.warn(`Failed to clear skipped update version before install: ${getErrorMessage(error)}`);
    }
    // The marker is written here rather than before the quit request, because a
    // quit that is held or superseded never reaches this callback. A marker left
    // behind by an install that was never attempted reads on the next launch as
    // a failed install, and three of those suppress the version for a week.
    statusRequesters = requesters;
    requestUpdateInstallShutdown(async () => {
        try {
            await markUpdateInstallPending(candidateVersion);
        } catch (error) {
            const message = `Update installation aborted: failed to write update health marker: ${getErrorMessage(error)}`;
            logger.error(message, {
                code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
                cause: error,
            });
            updateStatus({
                phase: 'error',
                reason: 'install-preparation-failed',
                origin: 'manual',
                version: candidateVersion,
                percent: null,
                message,
            }, requesters);
            return;
        }
        autoUpdater.quitAndInstall(false, true);
    });
    return { started: true };
}

// fallow-ignore-next-line unused-export
export function deferDownloadedUpdate() {
    const candidateVersion = downloadedVersion ?? pendingVersion;
    if (!candidateVersion) {
        return;
    }

    approvedDownloadAndInstallVersion = null;

    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: candidateVersion,
        percent: null,
        message: null,
    });
}

// fallow-ignore-next-line unused-export
export async function skipUpdateVersion(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return;
    }

    await writeSkippedVersion(normalized);
    approvedDownloadAndInstallVersion = null;
    downloadedVersion = null;
    pendingVersion = null;
    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: normalized,
        percent: null,
        message: null,
    });
}

export async function shutdownUpdates() {
    isShuttingDown = true;
    approvedDownloadAndInstallVersion = null;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = 0;
    currentDownloadCancellationToken?.cancel();

    if (currentCheckPromise) {
        let timeoutHandle = null as ReturnType<typeof setTimeout> | null;
        try {
            await Promise.race([
                currentCheckPromise,
                new Promise<void>((resolve) => {
                    timeoutHandle = setTimeout(resolve, UPDATER_SHUTDOWN_CHECK_WAIT_TIMEOUT_MS);
                    timeoutHandle.unref();
                }),
            ]);
        } catch {
            // Ignore in-flight check failures during shutdown.
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    if (currentDownloadPromise) {
        let timeoutHandle = null as ReturnType<typeof setTimeout> | null;
        try {
            await Promise.race([
                currentDownloadPromise,
                new Promise<void>((resolve) => {
                    timeoutHandle = setTimeout(resolve, UPDATER_SHUTDOWN_DOWNLOAD_WAIT_TIMEOUT_MS);
                    timeoutHandle.unref();
                }),
            ]);
        } catch {
            // Ignore in-flight download failures during shutdown.
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    for (const unsubscribe of autoUpdaterListenerUnsubscribe.splice(0)) {
        try {
            unsubscribe();
        } catch {
            // Ignore listener cleanup failures.
        }
    }
    listenersRegistered = false;
}
