import {
    closeSync,
    mkdirSync,
    openSync,
} from 'node:fs';
import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import { delay } from 'es-toolkit/promise';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { DEV_OUTPUT_TEE_STABLE_LOG_DISABLED_ENV } from '@scripts/electron-run/devServerOutputTee';
import {
    cleanupStaleSessionArtifacts,
    cleanupSessionStartingAttempt,
    classifySessionControllerOwnership,
    isSessionRunning,
    isSessionStarting,
    readSessionLogTail,
    waitForSessionReady,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    cleanupSessionAppTempIfUnowned,
    hasWorkspaceRecoveryEvidence,
} from '@scripts/electron-run/electronRunSessionCleanup';
import {
    getCurrentSessionName,
    sessionDir,
    sessionLogFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    INITIAL_OPEN_PATHS_ENV,
    normalizeInitialOpenPaths,
} from '@scripts/electron-run/electronLaunch';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const DEV_DETACHED_SESSION_READY_TIMEOUT_MS = 120_000;
const E2E_DETACHED_SESSION_READY_TIMEOUT_MS = 65_000;
export const E2E_SESSION_START_TIMEOUT_MS = 75_000;

export function resolveDetachedSessionReadyTimeoutMs(owner: 'dev' | 'e2e') {
    return owner === 'e2e'
        ? E2E_DETACHED_SESSION_READY_TIMEOUT_MS
        : DEV_DETACHED_SESSION_READY_TIMEOUT_MS;
}

export function resolveDetachedSessionLaunch(
    owner: 'dev' | 'e2e',
    sessionName: string,
    execPath = process.execPath,
    pnpmCommand = PNPM_COMMAND,
) {
    return owner === 'e2e'
        ? {
            args: [
                '--import',
                'tsx',
                'scripts/electron-run/ephemeralSessionEntry.ts',
                sessionName,
            ],
            command: execPath,
        }
        : {
            args: [
                'electron:run',
                `--session=${sessionName}`,
                'start',
            ],
            command: pnpmCommand,
        };
}

export function waitForDetachedChildSpawn(child: ChildProcess) {
    return new Promise<void>((resolve, reject) => {
        function cleanup() {
            child.off('error', onError);
            child.off('spawn', onSpawn);
        }
        function onError(error: Error) {
            cleanup();
            reject(error);
        }
        function onSpawn() {
            cleanup();
            resolve();
        }

        child.once('error', onError);
        child.once('spawn', onSpawn);
    });
}

export function createDetachedSessionReadinessFailure(
    message: string,
    cleanupErrors: unknown[],
) {
    const readinessFailure = new Error(message);
    return cleanupErrors.length === 0
        ? readinessFailure
        : new AggregateError(
            [
                readinessFailure,
                ...cleanupErrors,
            ],
            message,
        );
}

export async function startSessionDetached(options: {
    env?: NodeJS.ProcessEnv;
    owner?: 'dev' | 'e2e';
    initialOpenPaths?: string[];
} = {}) {
    const owner = options.owner ?? 'dev';
    const readyTimeoutMs = resolveDetachedSessionReadyTimeoutMs(owner);
    const cleanupResult = await cleanupStaleSessionArtifacts();
    if (cleanupResult.retained && classifySessionControllerOwnership(getCurrentSessionName()).status !== 'active') {
        throw new Error(cleanupResult.reason ?? 'Session cleanup was refused because ownership evidence is unresolved.');
    }

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(readyTimeoutMs);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFilePath()}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(sessionDir(), { recursive: true });
    const logFd = openSync(sessionLogFilePath(), 'w');
    const {
        args,
        command,
    } = resolveDetachedSessionLaunch(
        owner,
        getCurrentSessionName(),
    );
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd: projectRoot,
            detached: true,
            shell: false,
            stdio: [
                'ignore',
                logFd,
                logFd,
            ],
            env: {
                ...process.env,
                ...options.env,
                // This process already redirects its complete stdout/stderr stream
                // to the stable session log. The nested output tee still writes
                // timestamped per-source files and the discovery manifest, but it
                // must not append the same lines to session.log a second time.
                [DEV_OUTPUT_TEE_STABLE_LOG_DISABLED_ENV]: '1',
                ...(options.initialOpenPaths
                    ? { [INITIAL_OPEN_PATHS_ENV]: JSON.stringify(normalizeInitialOpenPaths(options.initialOpenPaths)) }
                    : {}),
            },
        });
    } finally {
        closeSync(logFd);
    }
    await waitForDetachedChildSpawn(child);
    child.unref();

    const start = Date.now();
    let ready = false;
    while (Date.now() - start < readyTimeoutMs) {
        if (await isSessionRunning()) {
            ready = true;
            break;
        }
        if (child.pid && !isProcessAlive(child.pid) && !isSessionStarting()) {
            break;
        }
        await delay(300);
    }
    if (!ready) {
        const cleanupErrors: unknown[] = [];
        try {
            if (child.pid && isProcessAlive(child.pid)) {
                await killProcessTree(child.pid, 1500);
            }
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            const cleanupResult = await cleanupSessionStartingAttempt();
            if (!cleanupResult.completed) {
                throw new Error(cleanupResult.reason ?? 'Detached startup cleanup was retained.');
            }
            if (!hasWorkspaceRecoveryEvidence() && !cleanupSessionAppTempIfUnowned()) {
                throw new Error('Detached session app temp cleanup was refused because a session-owned Electron process is still alive.');
            }
        } catch (error) {
            cleanupErrors.push(error);
        }
        const tail = readSessionLogTail();
        const details = tail ? `\n\n--- Recent session log ---\n${tail}` : '';
        throw createDetachedSessionReadinessFailure(
            `Detached session failed to become ready in ${Math.round(readyTimeoutMs / 1000)}s. Check logs: ${sessionLogFilePath()}${details}`,
            cleanupErrors,
        );
    }

    console.log(`Session '${getCurrentSessionName()}' started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFilePath()}`);
}
