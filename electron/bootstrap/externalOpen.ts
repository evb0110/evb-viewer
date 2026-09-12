import type { ILogger } from '@electron/utils/createLogger';
import { existsSync } from 'fs';
import {
    extname,
    isAbsolute,
    resolve,
} from 'path';
import { fileURLToPath } from 'url';
import { uniq } from 'es-toolkit/array';
import { getErrorMessage } from '@electron/utils/error';
import { focusWindowForUser } from '@electron/window/focusWindowForUser';

const SUPPORTED_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
]);

const EXTERNAL_OPEN_SINGLETON_BATCH_WINDOW_MS = 100;
const EXTERNAL_OPEN_MULTI_PATH_BATCH_WINDOW_MS = 800;
const EXTERNAL_OPEN_MAX_BATCH_WAIT_MS = 10_000;
const EXTERNAL_OPEN_RETRY_DISPATCH_MS = 1_000;
// A batch that cannot be delivered has to stop retrying, but "no window yet"
// also reports as undeliverable, so the ceiling has to outlast a cold start or
// it would discard the file the user just double-clicked. Reuse the pipeline's
// own patience budget rather than inventing a second one.
const EXTERNAL_OPEN_MAX_DISPATCH_FAILURES
    = Math.ceil(EXTERNAL_OPEN_MAX_BATCH_WAIT_MS / EXTERNAL_OPEN_RETRY_DISPATCH_MS);
const EXTERNAL_OPEN_STARTUP_EMPTY_CLAIM_GRACE_MS = 300;
const EXTERNAL_OPEN_PENDING_MAX_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_EXTERNAL_OPEN_PENDING_MAX_PATHS ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 256;
    }
    return Math.min(parsed, 4_096);
})();

interface IExternalOpenManagerSink {
    queueOpenRequest(paths: string[]): void;
    requestMainWindowForExternalOpen(): void;
}

interface IWindowLike {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    webContents: {focus(): void;};
}

interface IApplicationLike {focus(options: { steal: true; }): void;}

interface ICreateExternalOpenManagerOptions {
    application: IApplicationLike;
    logger: ILogger;
    noFocus: boolean;
    logStartupPhase: (phase: string) => void;
    isMainWindowRendererReady: () => boolean;
    getMainWindow: () => IWindowLike | null;
    hasWindows: () => boolean;
    createWindow: () => Promise<unknown>;
    grantOpenPaths?: (paths: string[]) => void;
    dispatchOpenPaths: (paths: string[]) => boolean;
}

type TExternalOpenBatchPhase =
    | { type: 'idle'; }
    | {
        type: 'singleton';
        deadline: number;
    }
    | {
        type: 'multi-path';
        deadline: number;
    };

function isSupportedExternalOpenPath(filePath: string) {
    return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function doesExternalOpenPathExist(filePath: string) {
    try {
        return existsSync(filePath);
    } catch {
        return false;
    }
}

/**
 * A command-line argument is relative to the shell's working directory, which
 * is what `resolve` anchors to. Both platforms' rules must not be accepted at
 * once: on Windows a leading `/` is drive-relative rather than absolute, so
 * treating it as already-absolute would leave it unresolved.
 */
function normalizeExternalOpenPath(filePath: string) {
    return isAbsolute(filePath) ? filePath : resolve(filePath);
}

export function createMacOpenFileRouter(options: { logger: ILogger; }) {
    const pendingPaths: string[] = [];
    let externalOpenManager: IExternalOpenManagerSink | null = null;

    function handleOpenFile(filePath: string) {
        const normalizedPath = filePath.trim();
        if (!normalizedPath) {
            options.logger.warn('Ignoring empty macOS open-file path');
            return;
        }

        if (!isSupportedExternalOpenPath(normalizedPath)) {
            options.logger.warn(`Ignoring unsupported macOS open-file path: ${normalizedPath}`);
            return;
        }

        if (!externalOpenManager) {
            pendingPaths.push(normalizedPath);
            options.logger.debug(`Buffered macOS open-file path before external open manager init: ${normalizedPath}`);
            return;
        }

        externalOpenManager.queueOpenRequest([normalizedPath]);
        externalOpenManager.requestMainWindowForExternalOpen();
    }

    function attachExternalOpenManager(manager: IExternalOpenManagerSink) {
        externalOpenManager = manager;

        if (pendingPaths.length === 0) {
            return;
        }

        const bufferedPaths = pendingPaths.splice(0, pendingPaths.length);
        options.logger.info(`Flushing ${bufferedPaths.length} early macOS open-file path(s)`);
        externalOpenManager.queueOpenRequest(bufferedPaths);
        externalOpenManager.requestMainWindowForExternalOpen();
    }

    return {
        attachExternalOpenManager,
        handleOpenFile,
    };
}

export function createExternalOpenManager(options: ICreateExternalOpenManagerOptions) {
    const pendingExternalOpenPaths: string[] = [];
    const pendingExternalOpenPathSet = new Set<string>();
    let flushPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
    let retryPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
    let batchPhase: TExternalOpenBatchPhase = { type: 'idle' };
    let externalOpenBootstrapReady = false;
    let ensureWindowForExternalOpenPromise: Promise<void> | null = null;
    let hasHandledInitialExternalOpenDispatch = false;
    let pendingFlushRequested = false;
    let dispatchFailureCount = 0;
    let startupEmptyClaimGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let startupEmptyClaimGraceResolve: (() => void) | null = null;
    let startupEmptyClaimGracePromise: Promise<void> | null = null;

    function normalizeCommandLineArg(arg: string) {
        let normalized = arg.trim();
        if (!normalized || normalized.startsWith('-')) {
            return null;
        }

        if (
            (normalized.startsWith('"') && normalized.endsWith('"'))
            || (normalized.startsWith('\'') && normalized.endsWith('\''))
        ) {
            normalized = normalized.slice(1, -1);
        }

        if (!normalized) {
            return null;
        }

        if (process.platform === 'win32' && normalized.startsWith('/')) {
            return null;
        }

        if (normalized.startsWith('file://')) {
            try {
                return fileURLToPath(normalized);
            } catch {
                return null;
            }
        }

        return normalized;
    }

    function findJoinedSupportedPath(args: string[], startIndex: number, firstToken: string) {
        let candidate = firstToken;
        for (let cursor = startIndex + 1; cursor < args.length && cursor <= startIndex + 7; cursor += 1) {
            const nextToken = normalizeCommandLineArg(args[cursor] ?? '');
            if (!nextToken) {
                break;
            }
            candidate = `${candidate} ${nextToken}`;
            if (isSupportedExternalOpenPath(candidate)) {
                return {
                    path: candidate,
                    endIndex: cursor,
                };
            }
        }

        return null;
    }

    function collectSupportedPathsFromArgs(args: string[]) {
        const files: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
            const normalized = normalizeCommandLineArg(args[i] ?? '');
            if (!normalized) {
                continue;
            }

            if (isSupportedExternalOpenPath(normalized)) {
                files.push(normalized);
                continue;
            }

            const joinedPath = findJoinedSupportedPath(args, i, normalized);
            if (joinedPath) {
                files.push(joinedPath.path);
                i = joinedPath.endIndex;
            }
        }
        return files;
    }

    function normalizeOpenRequestPaths(paths: string[]) {
        return uniq(paths
            .map(path => path.trim())
            .filter(path => path.length > 0)
            .map(normalizeExternalOpenPath));
    }

    function validateClaimedOpenPaths(paths: string[], source: string) {
        const normalizedPaths = normalizeOpenRequestPaths(paths);
        if (normalizedPaths.length === 0) {
            return {
                normalizedPaths,
                validPaths: [],
            };
        }

        if (normalizedPaths.length > EXTERNAL_OPEN_PENDING_MAX_PATHS) {
            options.logger.warn(
                `Ignoring ${source} external open batch over cap (${normalizedPaths.length}/${EXTERNAL_OPEN_PENDING_MAX_PATHS})`,
            );
            return {
                normalizedPaths,
                validPaths: [],
            };
        }

        const validPaths: string[] = [];
        for (const normalizedPath of normalizedPaths) {
            if (!isSupportedExternalOpenPath(normalizedPath)) {
                options.logger.warn(`Ignoring unsupported ${source} external open path: ${normalizedPath}`);
                continue;
            }
            if (!doesExternalOpenPathExist(normalizedPath)) {
                options.logger.warn(`Ignoring missing ${source} external open path: ${normalizedPath}`);
                continue;
            }
            validPaths.push(normalizedPath);
        }
        return {
            normalizedPaths,
            validPaths,
        };
    }

    function enqueueExternalOpenPath(normalizedPath: string) {
        let droppedCount = 0;

        if (pendingExternalOpenPathSet.has(normalizedPath)) {
            return {
                coalescedCount: 1,
                droppedCount,
                newPathCount: 0,
            };
        }

        pendingExternalOpenPaths.push(normalizedPath);
        pendingExternalOpenPathSet.add(normalizedPath);

        while (pendingExternalOpenPaths.length > EXTERNAL_OPEN_PENDING_MAX_PATHS) {
            const droppedPath = pendingExternalOpenPaths.shift();
            if (!droppedPath) {
                break;
            }
            pendingExternalOpenPathSet.delete(droppedPath);
            droppedCount += 1;
        }

        return {
            coalescedCount: 0,
            droppedCount,
            newPathCount: 1,
        };
    }

    function queueOpenRequest(paths: string[]) {
        const normalizedPaths = normalizeOpenRequestPaths(paths);
        if (normalizedPaths.length === 0) {
            return;
        }

        let coalescedCount = 0;
        let droppedCount = 0;
        let newPathCount = 0;
        for (const normalizedPath of normalizedPaths) {
            const result = enqueueExternalOpenPath(normalizedPath);
            coalescedCount += result.coalescedCount;
            droppedCount += result.droppedCount;
            newPathCount += result.newPathCount;
        }

        if (coalescedCount > 0) {
            options.logger.debug(`Coalesced ${coalescedCount} duplicate external open path(s)`);
        }
        if (droppedCount > 0) {
            options.logger.warn(
                `External open queue exceeded cap (${EXTERNAL_OPEN_PENDING_MAX_PATHS}); dropped ${droppedCount} oldest path(s)`,
            );
        }

        finishStartupEmptyClaimGrace();
        if (externalOpenBootstrapReady && options.hasWindows()) {
            scheduleFlushPendingFiles(newPathCount);
        }
    }

    function getPendingPathsSnapshot() {
        return pendingExternalOpenPaths.slice();
    }

    function removePendingPaths(paths: string[]) {
        for (const path of paths) {
            const existingIndex = pendingExternalOpenPaths.indexOf(path);
            if (existingIndex >= 0) {
                pendingExternalOpenPaths.splice(existingIndex, 1);
            }
            pendingExternalOpenPathSet.delete(path);
        }
    }

    function finishStartupEmptyClaimGrace() {
        if (startupEmptyClaimGraceTimer) {
            clearTimeout(startupEmptyClaimGraceTimer);
            startupEmptyClaimGraceTimer = null;
        }

        const resolve = startupEmptyClaimGraceResolve;
        startupEmptyClaimGraceResolve = null;
        startupEmptyClaimGracePromise = null;
        resolve?.();
    }

    function waitForStartupExternalOpenGraceIfEmpty() {
        if (
            pendingExternalOpenPaths.length > 0
            || hasHandledInitialExternalOpenDispatch
        ) {
            return Promise.resolve();
        }

        if (startupEmptyClaimGracePromise) {
            return startupEmptyClaimGracePromise;
        }

        startupEmptyClaimGracePromise = new Promise<void>((resolve) => {
            startupEmptyClaimGraceResolve = resolve;
            startupEmptyClaimGraceTimer = setTimeout(
                finishStartupEmptyClaimGrace,
                EXTERNAL_OPEN_STARTUP_EMPTY_CLAIM_GRACE_MS,
            );
            startupEmptyClaimGraceTimer.unref();
        });
        return startupEmptyClaimGracePromise;
    }

    async function claimPendingOpenPaths() {
        await waitForStartupExternalOpenGraceIfEmpty();
        const validation = validateClaimedOpenPaths(getPendingPathsSnapshot(), 'startup claim');
        const paths = validation.validPaths;
        removePendingPaths(validation.normalizedPaths);
        if (paths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return [];
        }

        hasHandledInitialExternalOpenDispatch = true;
        pendingFlushRequested = pendingExternalOpenPaths.length > 0;
        if (pendingExternalOpenPaths.length === 0) {
            clearTimers();
        }
        options.logStartupPhase(`Claimed external file open batch (${paths.length} path(s))`);
        return paths;
    }

    function acknowledgeClaimedOpenPaths(failedPaths: string[]) {
        const normalizedFailedPaths = validateClaimedOpenPaths(failedPaths, 'startup acknowledgement').validPaths;
        if (normalizedFailedPaths.length === 0) {
            return;
        }

        for (const path of normalizedFailedPaths) {
            enqueueExternalOpenPath(path);
        }
        pendingFlushRequested = true;
        options.logger.warn(`Requeued ${normalizedFailedPaths.length} failed startup external open path(s)`);
    }

    function queueOpenRequestFromArgs(args: string[]) {
        const parsedPaths = collectSupportedPathsFromArgs(args);
        if (parsedPaths.length > 0) {
            options.logger.info(`Parsed external open paths (${parsedPaths.length}): ${parsedPaths.join(' | ')}`);
        }
        queueOpenRequest(parsedPaths);
    }

    function focusMainWindow() {
        const window = options.getMainWindow();
        if (!window) {
            return;
        }

        focusWindowForUser(window, {
            application: options.application,
            noFocus: options.noFocus,
        });
    }

    function clearRetryPendingFilesTimer() {
        if (!retryPendingFilesTimer) {
            return;
        }

        clearTimeout(retryPendingFilesTimer);
        retryPendingFilesTimer = null;
    }

    function scheduleRetryPendingFiles() {
        if (
            retryPendingFilesTimer
            || !externalOpenBootstrapReady
            || pendingExternalOpenPaths.length === 0
        ) {
            return;
        }

        retryPendingFilesTimer = setTimeout(() => {
            retryPendingFilesTimer = null;
            flushPendingFiles();
        }, EXTERNAL_OPEN_RETRY_DISPATCH_MS);
        retryPendingFilesTimer.unref();
    }

    async function ensureMainWindowForExternalOpen() {
        if (!externalOpenBootstrapReady) {
            return;
        }

        if (!options.hasWindows()) {
            options.logger.info('External open requested without active windows; creating main window');
            await options.createWindow();
            options.logStartupPhase('Main window creation requested by external open');
        }

        focusMainWindow();
        scheduleFlushPendingFiles();
    }

    function requestMainWindowForExternalOpen() {
        if (ensureWindowForExternalOpenPromise) {
            return;
        }

        ensureWindowForExternalOpenPromise = (async () => {
            try {
                await ensureMainWindowForExternalOpen();
            } catch (error) {
                options.logger.error(`Failed to prepare window for external open: ${getErrorMessage(error)}`, {
                    code: 'MAIN_EXTERNAL_OPEN_FAILED',
                    context: {phase: 'prepare-window'},
                    cause: error,
                });
            } finally {
                ensureWindowForExternalOpenPromise = null;
            }
        })();
    }

    function flushPendingFiles() {
        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
            flushPendingFilesTimer = null;
        }
        batchPhase = { type: 'idle' };

        if (pendingExternalOpenPaths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return;
        }

        if (!options.isMainWindowRendererReady()) {
            pendingFlushRequested = true;
            scheduleRetryPendingFiles();
            return;
        }

        clearRetryPendingFilesTimer();
        const validation = validateClaimedOpenPaths(getPendingPathsSnapshot(), 'dispatch');
        const paths = validation.validPaths;
        if (paths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            dispatchFailureCount = 0;
            removePendingPaths(validation.normalizedPaths);
            return;
        }

        options.logger.info(`Flushing ${paths.length} batched external open path(s)`);
        options.grantOpenPaths?.(paths);
        const dispatched = options.dispatchOpenPaths(paths);
        if (!dispatched) {
            dispatchFailureCount += 1;
            if (dispatchFailureCount >= EXTERNAL_OPEN_MAX_DISPATCH_FAILURES) {
                pendingFlushRequested = false;
                removePendingPaths(validation.normalizedPaths);
                options.logger.warn(
                    `External open dispatch failed ${dispatchFailureCount} times; dropping ${validation.normalizedPaths.length} queued path(s)`,
                );
                dispatchFailureCount = 0;
                return;
            }

            pendingFlushRequested = true;
            options.logger.warn('External open dispatch could not reach the renderer; keeping paths queued for retry');
            scheduleRetryPendingFiles();
            return;
        }

        dispatchFailureCount = 0;
        removePendingPaths(validation.normalizedPaths);
        pendingFlushRequested = pendingExternalOpenPaths.length > 0;
        options.logStartupPhase(`Dispatched external file open batch (${paths.length} path(s))`);
    }

    function armBatchTimer(windowMs: number) {
        if (batchPhase.type === 'idle') {
            return;
        }

        const remainingMs = batchPhase.deadline - Date.now();
        if (remainingMs <= 0) {
            flushPendingFiles();
            return;
        }

        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
        }

        flushPendingFilesTimer = setTimeout(
            flushPendingFiles,
            Math.min(windowMs, remainingMs),
        );
        flushPendingFilesTimer.unref();
    }

    function scheduleFlushPendingFiles(newPathCount = 0) {
        if (pendingExternalOpenPaths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return;
        }

        pendingFlushRequested = true;

        if (!options.isMainWindowRendererReady()) {
            scheduleRetryPendingFiles();
            return;
        }

        if (!hasHandledInitialExternalOpenDispatch) {
            hasHandledInitialExternalOpenDispatch = true;
            flushPendingFiles();
            return;
        }

        if (retryPendingFilesTimer) {
            return;
        }

        if (batchPhase.type === 'idle') {
            const deadline = Date.now() + EXTERNAL_OPEN_MAX_BATCH_WAIT_MS;
            if (pendingExternalOpenPaths.length === 1) {
                batchPhase = {
                    type: 'singleton',
                    deadline,
                };
                armBatchTimer(EXTERNAL_OPEN_SINGLETON_BATCH_WINDOW_MS);
            } else {
                batchPhase = {
                    type: 'multi-path',
                    deadline,
                };
                armBatchTimer(EXTERNAL_OPEN_MULTI_PATH_BATCH_WINDOW_MS);
            }
            return;
        }

        if (newPathCount === 0) {
            return;
        }

        if (batchPhase.type === 'singleton') {
            batchPhase = {
                type: 'multi-path',
                deadline: batchPhase.deadline,
            };
        }
        armBatchTimer(EXTERNAL_OPEN_MULTI_PATH_BATCH_WINDOW_MS);
    }

    function clearTimers() {
        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
            flushPendingFilesTimer = null;
        }
        clearRetryPendingFilesTimer();
        finishStartupEmptyClaimGrace();
        batchPhase = { type: 'idle' };
    }

    return {
        clearTimers,
        isSupportedFile: isSupportedExternalOpenPath,
        markBootstrapReady() {
            externalOpenBootstrapReady = true;
            if (pendingFlushRequested || pendingExternalOpenPaths.length > 0) {
                scheduleRetryPendingFiles();
            }
        },
        queueOpenRequest,
        queueOpenRequestFromArgs,
        claimPendingOpenPaths,
        acknowledgeClaimedOpenPaths,
        requestMainWindowForExternalOpen,
        scheduleFlushPendingFiles,
    };
}
