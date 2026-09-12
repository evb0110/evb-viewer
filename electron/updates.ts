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
} from '@contracts/updatesPlatformFeature';
import {normalizeDiagnosticAttempt} from '@contracts/diagnostics/diagnosticCodes';
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
}

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
            context: {},
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
        context: {origin},
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

function broadcastStatusNow() {
    emitStatus(status);
}

function broadcastProgressStatus() {
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = Date.now();
    broadcastStatusNow();
}

function updateStatus(next: Partial<IAppUpdateStatus>) {
    const message = next.message === undefined
        ? status.message
        : typeof next.message === 'string'
            ? redactElectronLogText(next.message)
            : next.message;
    status = {
        ...status,
        ...next,
        message,
    };

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

// Release metadata is published only for the signed mac arm64 updater lane.
// Windows remains manual-install only until its signing credentials exist.
function isUpdaterRuntimeSupported() {
    return app.isPackaged
        && process.windowsStore !== true
        && process.platform === 'darwin'
        && process.arch === 'arm64';
}

function getUnsupportedRuntimeMessage() {
    if (process.windowsStore === true) {
        return 'Updates for the Microsoft Store build are delivered by Microsoft Store.';
    }
    if (process.platform === 'win32') {
        // A packaged Windows build is the right platform and the right arch;
        // naming the runtime would suggest otherwise. Falling back to the
        // localized message says only that this build cannot update itself.
        return null;
    }
    return `Updates are available only in packaged macOS arm64 builds. Current runtime: ${process.platform}-${process.arch}.`;
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
    const skipped = normalizeVersion(settings.skippedUpdateVersion);
    return skipped || null;
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

    const errors: string[] = [];
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
            errors.push(`${baseUrl}: ${getErrorMessage(error)}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`Updater feed verification was inconclusive (${errors.join('; ')})`);
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
        const normalizedVersion = normalizeVersion(info.version);
        const version = normalizedVersion.length > 0 ? normalizedVersion : pendingVersion;
        pendingVersion = version && version.length > 0 ? version : null;
        updateStatus({
            phase: 'available',
            origin: currentCheckOrigin,
            version: version && version.length > 0 ? version : null,
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
        approvedDownloadAndInstallVersion = null;
        const failedOperation = status.phase === 'downloading'
            ? 'Update download failed'
            : status.phase === 'downloaded'
                ? 'Update installation failed'
                : 'Update check failed';
        const message = `${failedOperation}: ${getErrorMessage(error)}`;
        if (
            currentCheckOrigin !== 'manual'
            || isExpectedUpdateNetworkError(error)
        ) {
            logger.warn(message);
        } else if (status.phase === 'downloading') {
            logger.error(message, {
                code: 'MAIN_UPDATE_DOWNLOAD_FAILED',
                context: {},
                cause: error,
            });
        } else if (status.phase === 'downloaded') {
            logger.error(message, {
                code: 'MAIN_UPDATE_INSTALL_FAILED',
                context: {},
                cause: error,
            });
        } else {
            logger.error(message, {
                code: 'MAIN_UPDATE_CHECK_FAILED',
                context: {origin: 'manual'},
                cause: error,
            });
        }
        if (currentCheckOrigin !== 'manual') {
            pendingVersion = null;
            setIdleStatus('auto');
            return;
        }

        updateStatus({
            phase: 'error',
            origin: 'manual',
            version: pendingVersion,
            percent: null,
            message,
        });
    };
    autoUpdater.on('error', onUpdaterError);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('error', onUpdaterError);
    });

    const onUpdateDownloaded = async (event: UpdateDownloadedEvent) => {
        try {
            const normalizedVersion = normalizeVersion(event.version);
            const version = normalizedVersion.length > 0 ? normalizedVersion : pendingVersion;
            pendingVersion = version && version.length > 0 ? version : null;
            downloadedVersion = version && version.length > 0 ? version : null;

            if (discardDownloadedCandidateIfNotNewer('download event')) {
                if (currentCheckOrigin === 'manual') {
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

            if (approvedDownloadAndInstallVersion) {
                const approvedVersion = approvedDownloadAndInstallVersion;
                approvedDownloadAndInstallVersion = null;

                if (version !== approvedVersion) {
                    if (version) {
                        clearDownloadedCandidate(version);
                    }
                    const message = `Downloaded update ${version ?? 'unknown'} did not match approved version ${approvedVersion}`;
                    logger.warn(message);
                    updateStatus({
                        phase: 'error',
                        origin: 'manual',
                        version: approvedVersion,
                        percent: null,
                        message,
                    });
                    return;
                }

                await installDownloadedUpdate();
                return;
            }

            updateStatus({
                phase: 'downloaded',
                origin: currentCheckOrigin,
                version: version && version.length > 0 ? version : null,
                percent: 100,
                message: null,
            });
        } catch (error) {
            const message = `Update install preparation failed: ${getErrorMessage(error)}`;
            logger.error(message, {
                code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
                context: {},
                cause: error,
            });
            updateStatus({
                phase: 'error',
                origin: currentCheckOrigin,
                version: pendingVersion,
                percent: null,
                message,
            });
        }
    };
    autoUpdater.on('update-downloaded', onUpdateDownloaded);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
    });
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
    try {
        if (isShuttingDown) {
            return;
        }
        if (!isUpdaterRuntimeSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: getUnsupportedRuntimeMessage(),
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

        if (currentCheckPromise) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'checking',
                    origin: 'manual',
                    version: pendingVersion,
                    percent: null,
                    message: null,
                });
                if (currentCheckOrigin === 'auto') {
                    await currentCheckPromise;
                    return await checkForUpdates('manual');
                }
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

        currentCheckOrigin = origin;
        currentCheckPromise = (async () => {
            const decision = await resolveUpdaterCheckDecision();
            if (!decision.shouldCheck) {
                if (decision.errorMessage && origin === 'manual') {
                    updateStatus({
                        phase: 'error',
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

            try {
                // The rollout endpoint is the source of truth for the eligible
                // release. Point electron-updater at that release's directory
                // so GitHub's independently mutable `latest` pointer cannot
                // make a stale client download an intermediate version first.
                if (!decision.targetVersion) {
                    throw new Error('Update metadata selected no target release.');
                }
                configureUpdaterFeed(decision.targetVersion);
                await autoUpdater.checkForUpdates();
            } catch (error) {
                const message = `Update check failed: ${getErrorMessage(error)}`;
                logUpdateCheckFailure(error, origin);
                updateStatus({
                    phase: 'error',
                    origin,
                    version: pendingVersion,
                    percent: null,
                    message,
                });
            }
        })().finally(() => {
            currentCheckPromise = null;
        });

        await currentCheckPromise;
    } catch (error) {
        const message = `Update check failed: ${getErrorMessage(error)}`;
        logger.warn(message);
        updateStatus({
            phase: 'error',
            origin,
            version: pendingVersion,
            percent: null,
            message,
        });
    }
}

export function initializeUpdates(onStatus: (status: IAppUpdateStatus) => void) {
    isShuttingDown = false;
    emitStatus = onStatus;
    emitStatus(status);

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
                        context: {
                            phase: 'installation',
                            attempt: normalizeDiagnosticAttempt(marker.startupAttempts),
                        },
                        cause: marker,
                    });
                    updateStatus({
                        phase: 'error',
                        origin: 'manual',
                        version: marker.pendingVersion,
                        percent: null,
                        message,
                    });
                } else if (marker && marker.startupAttempts >= UPDATE_STARTUP_FAILURE_THRESHOLD) {
                    logger.error(
                        `Update ${currentVersion} failed to reach renderer readiness on ${marker.startupAttempts} consecutive startups`,
                        {
                            code: 'MAIN_UPDATE_STARTUP_FAILED',
                            context: {
                                phase: 'renderer-readiness',
                                attempt: normalizeDiagnosticAttempt(marker.startupAttempts),
                            },
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

export async function triggerManualUpdateCheck() {
    if (isShuttingDown) {
        return { started: false };
    }
    await checkForUpdates('manual');
    return { started: true };
}

export function getUpdateStatus() {
    if (status.version !== null) {
        return status;
    }
    return {
        ...status,
        version: getCurrentVersion(),
    };
}

export function downloadAvailableUpdate() {
    if (isShuttingDown || !pendingVersion || downloadedVersion || currentDownloadPromise) {
        return { started: false };
    }

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
        .then(() => undefined)
        .catch((error) => {
            if (isShuttingDown || downloadCancellationToken.cancelled) {
                return;
            }
            if (approvedDownloadAndInstallVersion === candidateVersion) {
                approvedDownloadAndInstallVersion = null;
            }
            const message = `Update download failed: ${getErrorMessage(error)}`;
            if (isExpectedUpdateNetworkError(error)) {
                logger.warn(message);
            } else {
                logger.error(message, {
                    code: 'MAIN_UPDATE_DOWNLOAD_FAILED',
                    context: {},
                    cause: error,
                });
            }
            updateStatus({
                phase: 'error',
                origin: 'manual',
                version: candidateVersion,
                percent: null,
                message,
            });
        })
        .finally(() => {
            downloadCancellationToken.dispose();
            if (currentDownloadCancellationToken === downloadCancellationToken) {
                currentDownloadCancellationToken = null;
            }
            currentDownloadPromise = null;
        });

    return { started: true };
}

export async function installDownloadedUpdate() {
    if (!downloadedVersion) {
        return { started: false };
    }

    const candidateVersion = downloadedVersion;

    // Installation is always user-initiated, so errors must surface to the UI
    currentCheckOrigin = 'manual';

    try {
        validateDownloadedUpdateForInstall(candidateVersion);
    } catch (error) {
        clearDownloadedCandidate(candidateVersion);
        const message = `Update installation failed: ${getErrorMessage(error)}`;
        logger.warn(message);
        updateStatus({
            phase: 'error',
            origin: 'manual',
            version: candidateVersion,
            percent: null,
            message,
        });
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
    requestUpdateInstallShutdown(async () => {
        try {
            await markUpdateInstallPending(candidateVersion);
        } catch (error) {
            const message = `Update installation aborted: failed to write update health marker: ${getErrorMessage(error)}`;
            logger.error(message, {
                code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
                context: {},
                cause: error,
            });
            updateStatus({
                phase: 'error',
                origin: 'manual',
                version: candidateVersion,
                percent: null,
                message,
            });
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
