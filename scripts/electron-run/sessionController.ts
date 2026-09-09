import { getErrorMessage } from '@contracts/getErrorMessage';
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
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { attachPageDiagnostics } from '@scripts/electron-run/attachPageDiagnostics';
import { applyE2ESharedRendererPort } from '@scripts/electron-run/electronRunE2ESharedRenderer';
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
    waitForReusableNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    killProcessTrees,
    killSpawnedProcessTree,
    waitForProcessExit,
} from '@scripts/electron-run/electronRunProcessTree';
import { createStartupLogger } from '@scripts/electron-run/createStartupLogger';
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
        console.log(`[Nuxt] ${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
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
        console.log(`[Cache] Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
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

interface IStartSessionOptions {initialOpenPaths?: string[];}

async function stopSessionElectronProcess(state: ISessionState | null) {
    if (!state) {
        return;
    }

    const electronPid = state.electronProcess.pid ?? null;
    const shutdownStartedAt = Date.now();
    if (state.browser.connected) {
        console.log('[Electron] Requesting graceful app shutdown...');
        const didRequestWindowClose = await Promise.race([
            state.page.evaluate(() => {
                const rendererWindow = window as Window & {electronAPI?: {windowTabs: IWindowTabsCapability}};
                const closeCurrentWindow = rendererWindow.electronAPI?.windowTabs.closeCurrentWindow;
                if (!closeCurrentWindow) {
                    return false;
                }
                void closeCurrentWindow();
                return true;
            }).catch(() => false),
            delay(1_000).then(() => false),
        ]);
        if (!didRequestWindowClose) {
            console.warn('[Electron] Renderer window close request did not complete before the deadline');
        }
    }

    if (electronPid) {
        const remainingMs = Math.max(
            0,
            ELECTRON_GRACEFUL_SHUTDOWN_TIMEOUT_MS - (Date.now() - shutdownStartedAt),
        );
        if (remainingMs > 0 && await waitForProcessExit(electronPid, remainingMs)) {
            console.log('[Electron] Graceful app shutdown complete');
            return;
        }
        if (!isProcessAlive(electronPid)) {
            console.log('[Electron] Graceful app shutdown complete');
            return;
        }
    }

    if (state.browser.connected) {
        await state.browser.close().catch(() => {});
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
        console.log('[Nuxt] Left running (shared with other session)');
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
        console.log('[Nuxt] Keeping dev server alive for fast restart');
    }

    clearRuntimeSessionFiles();
    httpServer?.close();
    await stopSessionElectronProcess(sessionState);
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
        console.log(`\n[Session] Received ${signal} during startup, cleaning up...`);
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
    const outputTee = installDevServerOutputTee();
    if (outputTee) {
        console.log(`[DevOutput] Tee logs: ${outputTee.relativeRunDir}`);
        console.log(`[DevOutput] Stable session log: ${outputTee.sessionLogFile}`);
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
        const sharedRenderer = applyE2ESharedRendererPort(process.env);
        const startupOptions = resolveForceCleanStart(sharedRenderer ? false : forceClean);
        let nuxtProcess: ChildProcess | null = null;
        if (sharedRenderer) {
            console.log(`[Nuxt] Using shared Electron E2E renderer at http://127.0.0.1:${sharedRenderer.port}/electron`);
            if (!await waitForReusableNuxtServer(30_000)) {
                throw new Error(`Shared Electron E2E renderer on port ${sharedRenderer.port} did not become reusable`);
            }
            logTiming('Shared renderer reuse confirmed');
        } else {
            nuxtProcess = await startNuxtServer(startupOptions.forceClean);
            logTiming('Nuxt startup phase complete');
        }
        if (await stopIfStartupInterrupted()) {
            return;
        }

        if (!sharedRenderer && startupOptions.forceClean) {
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
            console.log(`[Electron] Initial open path(s): ${initialOpenPaths.length}`);
        }
        const launch = await launchAutomationSessionWithRecovery({
            cdpPort: ports.cdpPort,
            initialOpenPaths,
            nuxtProcess,
            otherRunning: startupOptions.otherRunning,
            usesSharedRenderer: sharedRenderer !== null,
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
            console.log(`\n[Electron] Process exited (code: ${code ?? '<unknown>'}, signal: ${signal ?? '<unknown>'})`);
            console.log('[Session] Electron died - shutting down session...');
            void cleanupAndExit(1);
        });

        launch.browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            console.log('\n[Puppeteer] Browser disconnected');
            console.log('[Session] Lost connection to Electron - shutting down session...');
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
