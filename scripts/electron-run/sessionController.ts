import { getErrorMessage } from '@contracts/getErrorMessage';
import { join } from 'node:path';
import { startSessionRecording } from '@scripts/electron-run/sessionRecording';
import { logLauncher } from '@scripts/electron-run/terminalLog';
import { APP_LOG_FILE_NAME } from '@contracts/logRecord';
import { assertRecordingTools } from '@scripts/electron-run/recordingVideo';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { delay } from 'es-toolkit/promise';
import { safeJsonParse } from '@contracts/safeJsonParse';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { attachPageDiagnostics } from '@scripts/electron-run/attachPageDiagnostics';
import { E2E_RUN_ID_ENV } from '@scripts/electron-run/electronRunRunId';
import {
    closeActiveDevServerOutputTee,
    installDevServerOutputTee,
    type IDevServerOutputTee,
} from '@scripts/electron-run/devServerOutputTee';
import {
    hasOtherAliveSessionUsingNuxt,
    readNuxtSessionShareMetadata,
    startNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    killProcessTrees,
    killSpawnedProcessTree,
    waitForProcessExit,
} from '@scripts/electron-run/electronRunProcessTree';
import { createStartupLogger } from '@scripts/electron-run/createStartupLogger';
import { usesBuiltRenderer } from '@scripts/electron-run/appRendererUrl';
import {
    findSessionOwnedElectronPids,
    killVerifiedSessionProcess,
} from '@scripts/electron-run/electronRunProcessIdentity';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { parseElectronRunCommandRequest } from '@scripts/electron-run/electronRunProtocol';
import {
    allocateAutomationPorts,
    killElectronProcessesByCdpPort,
    launchAutomationSessionWithRecovery,
    normalizeInitialOpenPaths,
    readInitialOpenPathsFromEnv,
} from '@scripts/electron-run/electronLaunch';
import {
    cleanupStaleSessionArtifacts,
    cleanupSessionStartingAttempt,
    canProceedAfterStaleArtifactCleanup,
    clearSessionStarting,
    getSessionInfo,
    isSessionRunning,
    isSessionStarting,
    listRunningSessions,
    markSessionStarting,
    waitForSessionReady,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    cleanupSessionAppTempIfUnowned,
    hasWorkspaceRecoveryEvidence,
} from '@scripts/electron-run/electronRunSessionCleanup';
import {
    electronUserDataPath,
    getCurrentSessionName,
    resolveAutomationFileLogDir,
    sessionDir,
    sessionFilePath,
    sessionKeepNuxtMarkerPath,
    sessionPreserveWorkspaceCheckpointMarkerPath,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';
import {
    clearAutomationWorkspaceCrashCheckpoint,
    workspaceCrashCheckpointPath,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';

let sessionState: ISessionState | null = null;
let sessionOwnerLost = false;

const handleCommand = createCommandHandler(() => sessionState);
const ELECTRON_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

export function shouldClearAutomationWorkspaceCrashCheckpointOnExit(exitCode: number) {
    return [
        0,
        130,
        143,
    ].includes(exitCode);
}

export function clearAutomationWorkspaceCrashCheckpointAfterSessionExit(
    exitCode: number,
    sessionName = getCurrentSessionName(),
) {
    return shouldClearAutomationWorkspaceCrashCheckpointOnExit(exitCode)
        && clearAutomationWorkspaceCrashCheckpoint(sessionName);
}

export function shouldPreserveWorkspaceRecoveryArtifacts(
    exitCode: number,
    preserveMarkerExists: boolean,
    checkpointExists: boolean,
) {
    return preserveMarkerExists
        || (!shouldClearAutomationWorkspaceCrashCheckpointOnExit(exitCode) && checkpointExists);
}

async function ensureSessionCanStart() {
    const cleanupResult = await cleanupStaleSessionArtifacts();
    if (!canProceedAfterStaleArtifactCleanup(cleanupResult)) {
        throw new Error(cleanupResult.reason ?? 'Session cleanup was refused because ownership evidence is unresolved.');
    }

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running. Use \`pnpm electron:run stop --session=${getCurrentSessionName()}\` to stop it.`);
        return false;
    }
    if (!isSessionStarting()) {
        markSessionStarting(process.pid);
        return true;
    }

    console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
    const ready = await waitForSessionReady(90_000);
    if (!ready) {
        throw new Error(`Session '${getCurrentSessionName()}' startup is stuck. Run stop and retry.`);
    }
    return false;
}

function resolveForceCleanStart(forceClean: boolean) {
    const otherRunning = listRunningSessions().filter(name => name !== getCurrentSessionName());
    if (forceClean && otherRunning.length > 0) {
        logLauncher('info', 'nuxt', `${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
        return {
            forceClean: false,
            otherRunning,
        };
    }
    return {
        forceClean,
        otherRunning,
    };
}

function clearElectronUserDataCache() {
    try {
        rmSync(electronUserDataPath(), {
            recursive: true,
            force: true,
        });
        logLauncher('info', 'cache', `Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
    } catch {}
}

async function killStaleElectronForCurrentSession() {
    const staleInfo = getSessionInfo();
    const expectation = {
        kind: 'electron' as const,
        sessionName: getCurrentSessionName(),
        cdpPort: staleInfo?.cdpPort,
    };
    const pids = new Set(findSessionOwnedElectronPids(expectation));

    if (pids.size > 0) {
        await killProcessTrees([...pids], 500);
    }
    if (staleInfo?.electronPid && isProcessAlive(staleInfo.electronPid) && !pids.has(staleInfo.electronPid)) {
        await killVerifiedSessionProcess({
            pid: staleInfo.electronPid,
            expectation,
            graceMs: 500,
        });
    }
    if (staleInfo?.cdpPort) {
        await killElectronProcessesByCdpPort(staleInfo.cdpPort);
    }
    if (pids.size > 0 || staleInfo?.cdpPort) {
        await delay(500);
    }
}

interface IStartSessionOptions {
    initialOpenPaths?: string[];
    /** Stream whose EOF means the owning process exited; see startSessionDetached. */
    ownerLease?: NodeJS.ReadableStream & {unref?: () => void};
}

function watchSessionOwnerLease(lease: NonNullable<IStartSessionOptions['ownerLease']>) {
    const onOwnerLost = () => {
        if (sessionOwnerLost) {
            return;
        }
        sessionOwnerLost = true;
        logLauncher('warn', 'session', 'Owner process exited - shutting down session...');
        // Take the SIGTERM path of whichever phase is active. Startup
        // cleanup that has not installed its handler yet checks the flag.
        process.emit('SIGTERM', 'SIGTERM');
    };
    lease.once('end', onOwnerLost);
    lease.once('close', onOwnerLost);
    lease.once('error', onOwnerLost);
    lease.resume();
    lease.unref?.();
}

async function stopSessionElectronProcess(state: ISessionState | null) {
    if (!state) {
        return;
    }

    const electronPid = state.electronProcess.pid ?? null;
    const shutdownStartedAt = Date.now();
    if (state.browser.connected) {
        logLauncher('info', 'electron', 'Requesting graceful app shutdown...');
        // Browser.close enters Electron's coordinated before-quit path. Calling
        // windowTabs.closeCurrentWindow here would instead run the user-facing
        // dirty-document close handshake, which cannot receive a dialog decision
        // from a hidden automation session.
        void state.browser.close().catch(error => {
            console.warn(`[Electron] Graceful app shutdown request failed: ${getErrorMessage(error)}`);
        });
    }

    if (electronPid) {
        const remainingMs = Math.max(
            0,
            ELECTRON_GRACEFUL_SHUTDOWN_TIMEOUT_MS - (Date.now() - shutdownStartedAt),
        );
        if (remainingMs > 0 && await waitForProcessExit(electronPid, remainingMs)) {
            logLauncher('info', 'electron', 'Graceful app shutdown complete');
            return;
        }
        if (!isProcessAlive(electronPid)) {
            logLauncher('info', 'electron', 'Graceful app shutdown complete');
            return;
        }
    }

    await state.browser.disconnect().catch(() => {});
    console.warn('[Electron] Graceful shutdown timed out; using process-tree fallback');
    await killSpawnedProcessTree(state.electronProcess, 800);
}

async function stopSessionNuxtProcess(state: ISessionState | null, keepNuxtOnStop: boolean) {
    if (!state?.nuxtProcess) {
        return;
    }
    if (keepNuxtOnStop) {
        state.nuxtProcess.unref();
        return;
    }
    const nuxtPid = state.nuxtProcess.pid ?? null;
    if (
        nuxtPid
        && hasOtherAliveSessionUsingNuxt(
            readNuxtSessionShareMetadata(),
            getCurrentSessionName(),
            nuxtPid,
            getNuxtPort(),
        )
    ) {
        logLauncher('info', 'nuxt', 'Left running (shared with other session)');
        return;
    }
    await killSpawnedProcessTree(state.nuxtProcess, 1200);
}

function clearRuntimeSessionFiles() {
    try {
        unlinkSync(sessionFilePath());
    } catch {}
    try {
        unlinkSync(sessionKeepNuxtMarkerPath());
    } catch {}
    clearSessionStarting();
}

async function cleanupSessionAndExit(exitCode: number, httpServer: ReturnType<typeof createServer> | null) {
    console.log('\nShutting down...');
    const keepNuxtOnStop = existsSync(sessionKeepNuxtMarkerPath());
    const preserveWorkspaceCheckpoint = shouldPreserveWorkspaceRecoveryArtifacts(
        exitCode,
        existsSync(sessionPreserveWorkspaceCheckpointMarkerPath()),
        existsSync(workspaceCrashCheckpointPath(getCurrentSessionName())),
    );
    if (keepNuxtOnStop) {
        logLauncher('info', 'nuxt', 'Keeping dev server alive for fast restart');
    }

    httpServer?.close();
    if (sessionState?.recording) {
        const evidence = await sessionState.recording.stop(exitCode).catch(error => {
            console.error(`[Recording] Finalization failed: ${getErrorMessage(error)}`);
            return null;
        });
        logLauncher(evidence?.status === 'complete' ? 'info' : 'warn', 'recording', 'Recording evidence', {
            status: evidence?.status ?? 'failed',
            review: sessionState.recording.manifest.reviewPath,
        });
        if (evidence?.status !== 'complete') { exitCode = exitCode || 1; }
    }
    await stopSessionElectronProcess(sessionState);
    clearRuntimeSessionFiles();
    // SIGINT/SIGTERM are normal developer-owned restarts. Electron has already
    // been closed gracefully above, so retaining its checkpoint here turns a
    // successful `pnpm dev` restart into an accidental document restore.
    if (!preserveWorkspaceCheckpoint) {
        clearAutomationWorkspaceCrashCheckpointAfterSessionExit(exitCode);
    }
    try {
        unlinkSync(sessionPreserveWorkspaceCheckpointMarkerPath());
    } catch {}
    if (!preserveWorkspaceCheckpoint) {
        if (!cleanupSessionAppTempIfUnowned()) {
            console.warn('[Session] App temp cleanup retained the namespace because a session-owned Electron process is still alive.');
        }
    }
    await stopSessionNuxtProcess(sessionState, keepNuxtOnStop);
    sessionState = null;
    closeActiveDevServerOutputTee();
    process.exit(exitCode);
}

function getSignalExitCode(signal: NodeJS.Signals) {
    if (signal === 'SIGINT') {
        return 130;
    }
    return 143;
}

function installStartupSignalCleanup() {
    let active = true;
    let cleanupStarted = false;
    let cleanupPromise: Promise<unknown> | null = null;

    const handleStartupSignal = (signal: NodeJS.Signals) => {
        if (!active || cleanupStarted) {
            return;
        }
        cleanupStarted = true;
        logLauncher('info', 'session', `Received ${signal} during startup, cleaning up...`);
        cleanupPromise = cleanupSessionStartingAttempt()
            .catch((error) => {
                const message = getErrorMessage(error);
                console.error(`[Session] Startup cleanup failed: ${message}`);
                return {
                    completed: false,
                    reason: message,
                };
            })
            .then((cleanupResult) => {
                if (!cleanupResult.completed) {
                    console.warn(`[Session] Startup cleanup retained its artifacts: ${cleanupResult.reason ?? 'ownership was unresolved.'}`);
                    return;
                }
                try {
                    if (!hasWorkspaceRecoveryEvidence() && !cleanupSessionAppTempIfUnowned()) {
                        console.warn('[Session] Startup app temp cleanup retained the namespace because a session-owned Electron process is still alive.');
                    }
                } catch (error) {
                    console.error(`[Session] Startup app temp cleanup failed: ${getErrorMessage(error)}`);
                }
            })
            .finally(() => {
                process.exit(getSignalExitCode(signal));
            });
        void cleanupPromise;
    };

    process.once('SIGINT', handleStartupSignal);
    process.once('SIGTERM', handleStartupSignal);
    if (sessionOwnerLost) {
        handleStartupSignal('SIGTERM');
    }

    return {
        disarm() {
            active = false;
            process.off('SIGINT', handleStartupSignal);
            process.off('SIGTERM', handleStartupSignal);
        },
        wasTriggered() {
            return cleanupStarted;
        },
        async waitForCleanup() {
            await cleanupPromise;
        },
    };
}

function createSessionCommandServer(onShutdownRequest: () => void) {
    return createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method not allowed');
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            try {
                const requestPayload = parseElectronRunCommandRequest(safeJsonParse(body));
                if (!requestPayload) {
                    throw new Error('Malformed command payload');
                }
                if (requestPayload.command === 'shutdown') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        result: { accepted: true },
                    }), () => {
                        setImmediate(onShutdownRequest);
                    });
                    return;
                }
                const result = await handleCommand(requestPayload.command, requestPayload.args);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    result,
                }));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: getErrorMessage(error),
                }));
            }
        });
    });
}

function listenForSessionCommands(options: {
    server: ReturnType<typeof createServer>;
    serverPort: number;
    cdpPort: number;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    outputTee: IDevServerOutputTee | null;
    logTiming: (message: string) => void;
}) {
    options.server.listen(options.serverPort, '127.0.0.1', () => {
        mkdirSync(sessionDir(), { recursive: true });
        writeFileSync(sessionFilePath(), JSON.stringify({
            port: options.serverPort,
            pid: process.pid,
            cdpPort: options.cdpPort,
            electronPid: options.electronProcess.pid ?? null,
            nuxtPid: options.nuxtProcess?.pid ?? null,
            nuxtPort: getNuxtPort(),
            runId: process.env[E2E_RUN_ID_ENV] ?? null,
            ...(sessionState?.recording ? {recording: sessionState.recording.manifest.manifestPath} : {}),
            ...(options.outputTee ? {logs: {
                manifestFile: options.outputTee.logManifestFile,
                sessionLogFile: options.outputTee.sessionLogFile,
                runDir: options.outputTee.runDir,
                relativeRunDir: options.outputTee.relativeRunDir,
                runCombinedLogFile: options.outputTee.runCombinedLogFile,
            }} : {}),
        }));
        clearSessionStarting();

        console.log(`\n\u2713 Session '${getCurrentSessionName()}' ready on port ${options.serverPort}`);
        options.logTiming('Session command server ready');
        console.log('  Press Ctrl+C to stop\n');
    });
}

export async function startControlledSession(forceClean = false, options: IStartSessionOptions = {}) {
    if (options.ownerLease) {
        watchSessionOwnerLease(options.ownerLease);
    }
    const outputTee = installDevServerOutputTee();
    if (outputTee) {
        logLauncher('info', 'logs', 'Session logs', {
            run: outputTee.relativeRunDir,
            session: outputTee.sessionLogFile,
            app: join(resolveAutomationFileLogDir(process.env), APP_LOG_FILE_NAME),
        });
    }

    const logTiming = createStartupLogger();
    if (!await ensureSessionCanStart()) {
        closeActiveDevServerOutputTee();
        return;
    }

    console.log(`Starting Electron Puppeteer session '${getCurrentSessionName()}'...\n`);
    const startupSignalCleanup = installStartupSignalCleanup();
    const stopIfStartupInterrupted = async () => {
        if (!startupSignalCleanup.wasTriggered()) {
            return false;
        }
        await startupSignalCleanup.waitForCleanup();
        return true;
    };

    try {
        if (process.env.EVB_RECORD_SESSION === '1') { await assertRecordingTools(); }
        // A built-renderer session loads nuxt-output/public through the app
        // protocol, so it has no Nuxt server to start.
        const builtRenderer = usesBuiltRenderer(process.env);
        const startupOptions = resolveForceCleanStart(builtRenderer ? false : forceClean);
        let nuxtProcess: ChildProcess | null = null;
        if (builtRenderer) {
            logLauncher('info', 'renderer', 'Using the built renderer in nuxt-output/public');
        } else {
            nuxtProcess = await startNuxtServer(startupOptions.forceClean);
            logTiming('Nuxt startup phase complete');
        }
        if (await stopIfStartupInterrupted()) {
            return;
        }

        if (!builtRenderer && startupOptions.forceClean) {
            clearElectronUserDataCache();
        }

        await killStaleElectronForCurrentSession();
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const ports = await allocateAutomationPorts(logTiming);
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const initialOpenPaths = normalizeInitialOpenPaths([
            ...readInitialOpenPathsFromEnv(),
            ...(options.initialOpenPaths ?? []),
        ]);
        if (initialOpenPaths.length > 0) {
            logLauncher('info', 'electron', `Initial open path(s): ${initialOpenPaths.length}`);
        }
        const launch = await launchAutomationSessionWithRecovery({
            cdpPort: ports.cdpPort,
            initialOpenPaths,
            nuxtProcess,
            otherRunning: startupOptions.otherRunning,
            logTiming,
        });
        if (await stopIfStartupInterrupted()) {
            return;
        }
        const diagnostics = attachPageDiagnostics(launch.page);

        sessionState = {
            browser: launch.browser,
            page: launch.page,
            electronProcess: launch.electronProcess,
            nuxtProcess: launch.nuxtProcess,
            consoleMessages: diagnostics.consoleMessages,
            devtoolsEvents: diagnostics.devtoolsEvents,
        };

        if (process.env.EVB_RECORD_SESSION === '1') {
            sessionState.recording = await startSessionRecording(launch.browser, {
                directory: join(sessionDir(), 'recordings'),
                session: getCurrentSessionName(),
                cwd: projectRoot,
            });
            logLauncher('info', 'recording', `${sessionState.recording.manifest.manifestPath}`);
        }

        let isShuttingDown = false;
        let httpServer: ReturnType<typeof createServer> | null = null;
        const cleanupAndExit = async (exitCode: number) => {
            if (isShuttingDown) {
                return;
            }
            isShuttingDown = true;
            await cleanupSessionAndExit(exitCode, httpServer);
        };

        launch.electronProcess.on('exit', (code, signal) => {
            if (isShuttingDown) {
                return;
            }
            logLauncher('warn', 'electron', `Process exited (code: ${code ?? '<unknown>'}, signal: ${signal ?? '<unknown>'})`);
            logLauncher('warn', 'session', 'Electron died - shutting down session...');
            void cleanupAndExit(1);
        });

        launch.browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            logLauncher('info', 'cdp', 'Browser disconnected');
            logLauncher('warn', 'session', 'Lost connection to Electron - shutting down session...');
            void cleanupAndExit(1);
        });

        const server = createSessionCommandServer(() => {
            void cleanupAndExit(0);
        });
        httpServer = server;
        listenForSessionCommands({
            server,
            serverPort: ports.serverPort,
            cdpPort: launch.cdpPort,
            electronProcess: launch.electronProcess,
            nuxtProcess: launch.nuxtProcess,
            outputTee,
            logTiming,
        });

        startupSignalCleanup.disarm();
        process.on('SIGINT', () => {
            void cleanupAndExit(0);
        });
        process.on('SIGTERM', () => {
            void cleanupAndExit(0);
        });

        await new Promise(() => {});
    } catch (error) {
        startupSignalCleanup.disarm();
        try {
            const cleanupResult = await cleanupSessionStartingAttempt();
            if (!cleanupResult.completed) {
                throw new Error(cleanupResult.reason ?? 'Failed-start startup cleanup was retained.');
            }
        } finally {
            try {
                if (!hasWorkspaceRecoveryEvidence() && !cleanupSessionAppTempIfUnowned()) {
                    console.warn('[Session] Failed-start app temp cleanup retained the namespace because a session-owned Electron process is still alive.');
                }
            } catch (cleanupError) {
                console.error(`[Session] Failed-start app temp cleanup failed: ${getErrorMessage(cleanupError)}`);
            }
        }
        clearSessionStarting();
        closeActiveDevServerOutputTee();
        throw error;
    }
}
