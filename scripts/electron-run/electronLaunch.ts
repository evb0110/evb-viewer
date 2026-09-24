import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { safeJsonParse } from '@contracts/safeJsonParse';
import {
    buildElectronAutomationArgs,
    buildElectronExecutablePath,
    prepareAutomationAppEntry,
    prepareSharedMacOSHiddenAppBundle,
    resolveAutomationRendererReadyEnv,
    resolveAutomationWindowEnv,
    sanitizeElectronLaunchEnv,
    shouldBootstrapInteractiveDevProfile,
    shouldUseMacOSHiddenAppLauncher,
} from '@scripts/electron-run/electronRunLaunchConfig';
import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';
import { getActiveDevServerOutputTee } from '@scripts/electron-run/devServerOutputTee';
import {
    ELECTRON_SERVER_PATH,
    startNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    findFreePort,
    isProcessAlive,
    killProcessTrees,
    killSpawnedProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import { findSessionOwnedElectronPids } from '@scripts/electron-run/electronRunProcessIdentity';
import { formatElectronStartupDiagnostics } from '@scripts/electron-run/electronRunStartupDiagnostics';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    createElectronOutputRecordStream,
    logLauncher,
    printTerminalLogRecord,
    resolveTerminalLogLevel,
} from '@scripts/electron-run/terminalLog';
import { recordSessionStartingAttempt } from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    getCurrentSessionName,
    sessionDir,
    resolveAutomationFileLogDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    connectToBrowser,
    isRendererReadinessError,
    isViteOptimizeDepError,
} from '@scripts/electron-run/rendererReadiness';

const ELECTRON_START_TIMEOUT_MS = 45_000;
const ELECTRON_LAUNCH_ATTEMPTS = 3;
const ELECTRON_LAUNCH_RETRY_DELAY_MS = 5_000;
const ELECTRON_STARTUP_LOG_MAX_LINES = 300;
const ELECTRON_STARTUP_LOG_TAIL_LINES = 60;
export const INITIAL_OPEN_PATHS_ENV = 'EVB_AUTOMATION_INITIAL_OPEN_PATHS';

export async function killElectronProcessesByCdpPort(cdpPort: number | null | undefined) {
    if (!Number.isFinite(cdpPort) || (cdpPort ?? 0) <= 0) {
        return;
    }

    const pids = findSessionOwnedElectronPids({
        kind: 'electron',
        sessionName: getCurrentSessionName(),
        cdpPort,
    });
    await killProcessTrees(pids, 500);
}

function createElectronStartupLog() {
    const startupLogLines: string[] = [];
    return {
        push(stream: 'stdout' | 'stderr', chunk: string) {
            if (!chunk) {
                return;
            }

            const lines = chunk
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);
            for (const line of lines) {
                startupLogLines.push(`[${stream}] ${line}`);
            }
            if (startupLogLines.length > ELECTRON_STARTUP_LOG_MAX_LINES) {
                startupLogLines.splice(0, startupLogLines.length - ELECTRON_STARTUP_LOG_MAX_LINES);
            }
        },
        formatFailure(reason: string, details: {
            code: number | null;
            signal: NodeJS.Signals | null
        }) {
            const tail = startupLogLines
                .slice(-ELECTRON_STARTUP_LOG_TAIL_LINES)
                .join('\n')
                .trim();
            const exitInfo = `code=${details.code ?? 'null'}, signal=${details.signal ?? 'null'}`;
            const baseMessage = tail
                ? `${reason} (${exitInfo})\n--- Electron output tail ---\n${tail}`
                : `${reason} (${exitInfo})`;
            const includeMacOSLog = details.signal === 'SIGKILL';
            return `${baseMessage}\n${formatElectronStartupDiagnostics({ includeMacOSLog })}`;
        },
    };
}

export function buildElectronRuntimeEnv(cdpPort: number, mainJs: string, initialOpenPaths: string[] = []) {
    const automationUserDataDir = electronUserDataPath();
    const automationWindowEnv = resolveAutomationWindowEnv(process.env);
    const shouldBootstrapDevProfile = shouldBootstrapInteractiveDevProfile({
        env: process.env,
        sessionName: getCurrentSessionName(),
        automationWindowEnv,
    });
    const electronRuntimeEnv = {
        ...process.env,
        EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
        EVB_SERVER_PORT: String(getNuxtPort()),
        EVB_SERVER_PATH: ELECTRON_SERVER_PATH,
        EVB_WAIT_RENDERER_READY: resolveAutomationRendererReadyEnv(process.env, automationWindowEnv),
        ...automationWindowEnv,
        EVB_AUTOMATION_USER_DATA_DIR: automationUserDataDir,
        EVB_AUTOMATION_SESSION_NAME: getCurrentSessionName(),
        EVB_FILE_LOG_DIR: resolveAutomationFileLogDir(process.env),
        EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE: shouldBootstrapDevProfile ? '1' : '0',
        EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
        ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
        // The logger infers "packaged" from an execPath outside node_modules,
        // which the hidden macOS bundle copy also has. Dev sessions keep the
        // full timeline in app.ndjson.
        ELECTRON_FILE_LOG_LEVEL: process.env.ELECTRON_FILE_LOG_LEVEL ?? 'debug',
        // The launcher formats main-process records from this NDJSON mirror.
        EVB_LOG_STDOUT: 'ndjson',
        EVB_LOG_STDOUT_LEVEL: resolveTerminalLogLevel(process.env),
        ELECTRON_ENABLE_STACK_DUMPING: process.env.ELECTRON_ENABLE_STACK_DUMPING ?? '1',
    } satisfies NodeJS.ProcessEnv;

    return {
        automationUserDataDir,
        automationWindowEnv,
        electronRuntimeEnv,
        electronArgs: buildElectronAutomationArgs({
            cdpPort,
            automationUserDataDir,
            mainJs,
            initialOpenPaths,
            env: electronRuntimeEnv,
        }),
    };
}

function buildElectronLaunchPlan(cdpPort: number, mainJs: string, initialOpenPaths: string[] = []) {
    const automationAppEntryPath = prepareAutomationAppEntry({
        destinationRoot: join(sessionDir(), 'automation-electron-app-entry'),
        mainJs,
    }).appPath;
    const {
        electronRuntimeEnv,
        electronArgs,
    } = buildElectronRuntimeEnv(cdpPort, automationAppEntryPath, initialOpenPaths);
    const electronPath = buildElectronExecutablePath();
    const electronAppPath = join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
    const launchViaHiddenMacApp = shouldUseMacOSHiddenAppLauncher(electronRuntimeEnv)
        && existsSync(electronAppPath);
    if (!launchViaHiddenMacApp && !existsSync(electronPath)) {
        throw new Error(
            `Electron executable not found at ${electronPath}. `
            + 'Ensure pnpm install completed Electron binary download successfully.',
        );
    }
    const hiddenAutomationBundlePaths = launchViaHiddenMacApp
        ? prepareSharedMacOSHiddenAppBundle({ sourceAppPath: electronAppPath })
        : null;
    if (hiddenAutomationBundlePaths && hiddenAutomationBundlePaths.removedStaleBundleDirs.length > 0) {
        logLauncher('info', 'launcher', `Removed ${hiddenAutomationBundlePaths.removedStaleBundleDirs.length} stale hidden Electron bundle dir(s).`);
    }
    const launchCommand = launchViaHiddenMacApp
        ? hiddenAutomationBundlePaths!.executablePath
        : electronPath;

    return {
        launchCommand,
        launchArgs: electronArgs,
        electronRuntimeEnv,
    };
}

function spawnElectronProcess(
    cdpPort: number,
    mainJs: string,
    startupLog: ReturnType<typeof createElectronStartupLog>,
    initialOpenPaths: string[] = [],
) {
    const {
        launchCommand,
        launchArgs,
        electronRuntimeEnv,
    } = buildElectronLaunchPlan(cdpPort, mainJs, initialOpenPaths);
    const electron = spawn(launchCommand, launchArgs, {
        cwd: projectRoot,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        env: sanitizeElectronLaunchEnv(electronRuntimeEnv),
    });

    const terminalLevel = resolveTerminalLogLevel(process.env);
    const records = createElectronOutputRecordStream(record => printTerminalLogRecord(record, terminalLevel));
    const onElectronOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
        // Raw output stays in the run directory only; the session log gets
        // the formatted terminal line instead.
        getActiveDevServerOutputTee()?.write('electron-main-process', stream, data, {aggregate: false});
        const text = data.toString();
        startupLog.push(stream, text);
        if (text.includes('DevTools listening')) {
            logLauncher('debug', 'electron', 'CDP ready');
        }
        records.write(stream, data);
    };
    electron.stdout.on('data', (data: Buffer) => onElectronOutput('stdout', data));
    electron.stderr.on('data', (data: Buffer) => onElectronOutput('stderr', data));
    electron.once('exit', () => records.end());
    return electron;
}

function hasElectronExited(electron: ChildProcess, exitDetails: {
    code: number | null;
    signal: NodeJS.Signals | null;
}) {
    const electronPid = electron.pid ?? null;
    const hasKnownPid = typeof electronPid === 'number' && electronPid > 0;
    return exitDetails.code !== null
        || exitDetails.signal !== null
        || (hasKnownPid && !isProcessAlive(electronPid));
}

async function waitForElectronCdp(
    electron: ChildProcess,
    cdpPort: number,
    exitDetails: {
        code: number | null;
        signal: NodeJS.Signals | null;
    },
    startupLog: ReturnType<typeof createElectronStartupLog>,
) {
    const start = Date.now();
    while (Date.now() - start < ELECTRON_START_TIMEOUT_MS) {
        if (hasElectronExited(electron, exitDetails)) {
            throw new Error(startupLog.formatFailure('Electron exited before CDP became ready', exitDetails));
        }

        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
            if (res.ok) {
                logLauncher('debug', 'electron', 'App started');
                return electron;
            }
        } catch {}
        await delay(500);
    }

    throw new Error(startupLog.formatFailure('Electron failed to start CDP before timeout', exitDetails));
}

async function startElectron(cdpPort: number, initialOpenPaths: string[] = []): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.js not found. Run `pnpm run build:electron` first.');
    }

    logLauncher('info', 'electron', 'Starting Electron', {cdpPort});
    mkdirSync(sessionDir(), { recursive: true });

    const startupLog = createElectronStartupLog();
    const electron = spawnElectronProcess(cdpPort, mainJs, startupLog, initialOpenPaths);
    const exitDetails: {
        code: number | null;
        signal: NodeJS.Signals | null;
    } = {
        code: null,
        signal: null,
    };
    electron.on('exit', (code, signal) => {
        exitDetails.code = code;
        exitDetails.signal = signal;
    });

    try {
        await waitForElectronCdp(electron, cdpPort, exitDetails, startupLog);
        return electron;
    } catch (error) {
        if (!hasElectronExited(electron, exitDetails)) {
            await stopElectronLaunchAttempt(electron, cdpPort);
        }
        throw error;
    }
}

export async function allocateAutomationPorts(logTiming: (message: string) => void) {
    const serverPort = await findFreePort();
    let cdpPort = await findFreePort();
    while (cdpPort === serverPort) cdpPort = await findFreePort();
    const ports = {
        serverPort,
        cdpPort,
    };
    logLauncher('debug', 'ports', 'Automation ports allocated', {
        cdpPort: ports.cdpPort,
        commandPort: ports.serverPort,
    });
    logTiming('Automation ports allocated');
    return ports;
}

async function stopElectronLaunchAttempt(electronProcess: ChildProcess, cdpPort: number) {
    await killSpawnedProcessTree(electronProcess, 800);
    await killElectronProcessesByCdpPort(cdpPort);
}

interface IAutomationLaunchResult {
    electronProcess: ChildProcess;
    browser: Browser;
    page: Page;
    nuxtProcess: ChildProcess | null;
    cdpPort: number;
}

export function normalizeInitialOpenPaths(paths: string[] | undefined) {
    return (paths ?? [])
        .map(path => path.trim())
        .filter(Boolean);
}

export function readInitialOpenPathsFromEnv(env: NodeJS.ProcessEnv = process.env) {
    const rawValue = env[INITIAL_OPEN_PATHS_ENV];
    if (!rawValue) {
        return [];
    }

    try {
        const parsed = safeJsonParse(rawValue);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return normalizeInitialOpenPaths(parsed.filter((value): value is string => typeof value === 'string'));
    } catch {
        return [];
    }
}

export async function launchAutomationSessionWithRecovery(options: {
    cdpPort: number;
    initialOpenPaths: string[];
    nuxtProcess: ChildProcess | null;
    otherRunning: string[];
    logTiming: (message: string) => void;
}): Promise<IAutomationLaunchResult> {
    let cdpPort = options.cdpPort;
    let nuxtProcess = options.nuxtProcess;
    let launchError: unknown = null;

    for (let attempt = 0; attempt < ELECTRON_LAUNCH_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            cdpPort = await findFreePort();
            logLauncher('warn', 'recovery', `Retrying launch (attempt ${attempt + 1}/${ELECTRON_LAUNCH_ATTEMPTS}) with CDP port ${cdpPort}`);
        }

        let electronProcess: ChildProcess | null = null;

        try {
            recordSessionStartingAttempt({
                cdpPorts: [cdpPort],
                electronUserDataDir: electronUserDataPath(),
                nuxtPid: nuxtProcess?.pid ?? null,
                nuxtPort: getNuxtPort(),
            });
            electronProcess = await startElectron(cdpPort, options.initialOpenPaths);
            if (electronProcess.pid) {
                recordSessionStartingAttempt({electronPids: [electronProcess.pid]});
            }
            options.logTiming('Electron process/CDP ready');
            const {
                browser,
                page,
            } = await connectToBrowser(cdpPort);
            options.logTiming('Browser automation attached');
            return {
                electronProcess,
                browser,
                page,
                nuxtProcess,
                cdpPort,
            };
        } catch (error) {
            launchError = error;
            const message = getErrorMessage(error);
            const phase = electronProcess ? 'connect to browser' : 'start Electron';
            console.error(`[Session] Failed to ${phase}: ${message}`);
            if (electronProcess) {
                await stopElectronLaunchAttempt(electronProcess, cdpPort);
            } else {
                await killElectronProcessesByCdpPort(cdpPort);
            }

            if (isRendererReadinessError(error)) {
                throw error;
            }

            if (attempt === 0 && isViteOptimizeDepError(error)) {
                if (options.otherRunning.length > 0) {
                    throw new Error(`Detected Vite optimize-dep failure, but other sessions are active (${options.otherRunning.join(', ')}). Stop them and run cleanstart.`);
                }
                logLauncher('warn', 'recovery', 'Detected Vite optimize-dep issue. Restarting Nuxt with cleared cache...');
                nuxtProcess = await startNuxtServer(true);
                continue;
            }

            if (attempt === 0 && message.includes('frame was detached')) {
                logLauncher('warn', 'recovery', 'Frame detached during initial page load — retrying...');
                await delay(2000);
                continue;
            }

            if (attempt < ELECTRON_LAUNCH_ATTEMPTS - 1) {
                logLauncher('warn', 'recovery', 'Electron launch failed before readiness — retrying...');
                await delay(ELECTRON_LAUNCH_RETRY_DELAY_MS);
                continue;
            }

            break;
        }
    }

    console.error('[Session] Failed to initialize app session, cleaning up...');
    await killSpawnedProcessTree(nuxtProcess, 1200);
    if (launchError instanceof Error) {
        throw launchError;
    }
    throw new Error('Failed to initialize Electron session');
}
