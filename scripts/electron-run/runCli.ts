import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    constants,
    copyFileSync,
    existsSync,
    readFileSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { delay } from 'es-toolkit/promise';
import { safeJsonParse } from '@contracts/safeJsonParse';
import { sendCommand } from '@scripts/electron-run/sendCommand';
import { COMMAND_EXECUTION_TIMEOUT_MS } from '@scripts/electron-run/electronRunTimeouts';
import {
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    getSessionInfo,
    getSessionStartingInfo,
    isSessionRunning,
    listAllSessionNames,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    getCurrentSessionName,
    sessionFilePath,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import { isProcessAlive } from '@scripts/electron-run/electronRunProcessTree';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { devSupervisor } from '@scripts/electron-run/devSupervisor';
import { runDevLogs } from '@scripts/devLogs';
import { startSessionDetached } from '@scripts/electron-run/startSessionDetached';
import {
    stopSession,
    stopSingleSession,
} from '@scripts/electron-run/stopSession';

const CLI_COMMANDS = [
    'start',
    'cleanstart',
    'startd',
    'stop',
    'status',
    'restart',
    'restartd',
    'list',
    'logs',
    'screenshot',
    'screenshots',
    'console',
    'devtools',
    'click',
    'type',
    'content',
    'waitfor',
    'resize',
    'viewport',
    'run',
    'run-file',
    'eval',
    'openPdf',
    'health',
] as const;

type TCliCommand = typeof CLI_COMMANDS[number];
const CLI_COMMAND_SET: ReadonlySet<string> = new Set<TCliCommand>(CLI_COMMANDS);

function isCliCommand(value: string): value is TCliCommand {
    return CLI_COMMAND_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parsePositivePid(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : null;
}

type TLegacySessionFileKind = 'session' | 'starting';
type TLegacySessionFileState = 'live' | 'dead' | 'malformed' | 'unreadable';

interface ILegacySessionFileObservation {
    kind: TLegacySessionFileKind;
    filePath: string;
    state: TLegacySessionFileState;
    pid: number | null;
    reason: string;
    source: string | null;
    device: number | null;
    inode: number | null;
}

const READ_ONLY_CLI_COMMANDS: ReadonlySet<TCliCommand> = new Set([
    'status',
    'list',
    'health',
    'logs',
]);

function legacySessionFileLabel(kind: TLegacySessionFileKind) {
    return kind === 'session' ? 'session' : 'startup';
}

function legacySessionFilePaths() {
    return [
        {
            kind: 'session' as const,
            filePath: join(projectRoot, '.devkit', 'electron-session.json'),
        },
        {
            kind: 'starting' as const,
            filePath: join(projectRoot, '.devkit', 'electron-session-starting.json'),
        },
    ];
}

function inspectLegacySessionFile(
    kind: TLegacySessionFileKind,
    filePath: string,
): ILegacySessionFileObservation | null {
    try {
        if (!existsSync(filePath)) {
            return null;
        }
    } catch {
        return {
            kind,
            filePath,
            state: 'unreadable',
            pid: null,
            reason: 'the legacy metadata path could not be inspected',
            source: null,
            device: null,
            inode: null,
        };
    }

    let source: string;
    try {
        source = readFileSync(filePath, 'utf8');
    } catch {
        return {
            kind,
            filePath,
            state: 'unreadable',
            pid: null,
            reason: 'the legacy metadata could not be read',
            source: null,
            device: null,
            inode: null,
        };
    }

    let pid: number | null;
    let fileIdentity: {
        device: number;
        inode: number;
    } | null = null;
    try {
        const fileStat = statSync(filePath);
        fileIdentity = {
            device: fileStat.dev,
            inode: fileStat.ino,
        };
    } catch {
        return {
            kind,
            filePath,
            state: 'unreadable',
            pid: null,
            reason: 'the legacy metadata changed while it was being inspected',
            source,
            device: null,
            inode: null,
        };
    }
    try {
        const parsed = safeJsonParse(source, isRecord);
        pid = parsePositivePid(parsed.pid);
    } catch {
        return {
            kind,
            filePath,
            state: 'malformed',
            pid: null,
            reason: 'the legacy metadata is not a valid JSON record with a positive numeric PID',
            source,
            device: fileIdentity.device,
            inode: fileIdentity.inode,
        };
    }

    if (!pid) {
        return {
            kind,
            filePath,
            state: 'malformed',
            pid: null,
            reason: 'the legacy metadata does not contain a positive numeric PID',
            source,
            device: fileIdentity.device,
            inode: fileIdentity.inode,
        };
    }

    let processIsAlive: boolean;
    try {
        processIsAlive = isProcessAlive(pid);
    } catch {
        return {
            kind,
            filePath,
            state: 'unreadable',
            pid,
            reason: 'the recorded PID could not be checked safely',
            source,
            device: fileIdentity.device,
            inode: fileIdentity.inode,
        };
    }

    if (processIsAlive) {
        return {
            kind,
            filePath,
            state: 'live',
            pid,
            reason: 'the PID is live, but ownership is ambiguous because legacy metadata has no exact executable, process start-time, project, or session identity',
            source,
            device: fileIdentity.device,
            inode: fileIdentity.inode,
        };
    }

    return {
        kind,
        filePath,
        state: 'dead',
        pid,
        reason: 'the recorded PID is not running',
        source,
        device: fileIdentity.device,
        inode: fileIdentity.inode,
    };
}

function inspectLegacySessionFiles() {
    return legacySessionFilePaths()
        .map(({
            kind,
            filePath,
        }) => inspectLegacySessionFile(kind, filePath))
        .filter((observation): observation is ILegacySessionFileObservation => observation !== null);
}

function printLegacySessionInspection(observations: readonly ILegacySessionFileObservation[]) {
    if (observations.length === 0) {
        return;
    }

    console.log('Legacy Electron session metadata:');
    for (const observation of observations) {
        const label = legacySessionFileLabel(observation.kind);
        const pid = observation.pid === null ? '' : ` PID ${observation.pid}.`;
        console.log(`  ${label}: ${observation.filePath}`);
        console.log(`    Status: ${observation.state}.${pid} ${observation.reason}. Preserved; no process signal was sent.`);
    }
}

function archiveDeadLegacySessionFile(observation: ILegacySessionFileObservation) {
    const archivePath = `${observation.filePath}.migrated`;
    try {
        if (!existsSync(observation.filePath)) {
            throw new Error('the source metadata disappeared before migration');
        }
        const currentSource = readFileSync(observation.filePath, 'utf8');
        const currentStat = statSync(observation.filePath);
        if (currentSource !== observation.source
            || currentStat.dev !== observation.device
            || currentStat.ino !== observation.inode) {
            throw new Error('the source metadata changed after inspection');
        }
        // COPYFILE_EXCL makes archive creation no-clobber. If interrupted
        // before the source unlink, both copies remain available for recovery.
        copyFileSync(observation.filePath, archivePath, constants.COPYFILE_EXCL);
        const beforeUnlink = statSync(observation.filePath);
        if (beforeUnlink.dev !== observation.device
            || beforeUnlink.ino !== observation.inode
            || readFileSync(observation.filePath, 'utf8') !== observation.source) {
            throw new Error('the source metadata changed before migration could finish');
        }
        unlinkSync(observation.filePath);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Legacy ${legacySessionFileLabel(observation.kind)} metadata at ${observation.filePath} `
            + `was retained because migration could not complete: ${detail}`,
        );
    }
    console.log(`[Migration] Archived inactive legacy ${legacySessionFileLabel(observation.kind)} metadata at ${archivePath}`);
}

function migrateLegacySessionFiles(observations: readonly ILegacySessionFileObservation[]) {
    const unresolvedObservations = observations.filter(observation => (
        observation.state === 'live'
        || observation.state === 'malformed'
        || observation.state === 'unreadable'
    ));
    if (unresolvedObservations.length > 0) {
        const details = unresolvedObservations
            .map(observation => `${observation.filePath} (${observation.state}${observation.pid ? `, PID ${String(observation.pid)}` : ''})`)
            .join(', ');
        throw new Error(
            `Refused legacy session migration for ${details}: the live PID is ambiguous because `
            + 'legacy metadata lacks exact executable, process start-time, project, and session identity. '
            + 'No process was signaled and the metadata was retained. Inspect the live PID, then move or delete the named legacy session file when it is safe.',
        );
    }

    for (const observation of observations) {
        if (observation.state === 'dead') {
            archiveDeadLegacySessionFile(observation);
        } else {
            console.warn(
                `[Migration] Retained legacy ${legacySessionFileLabel(observation.kind)} metadata at `
                + `${observation.filePath}: ${observation.reason}.`,
            );
        }
    }
}

function parsePingResult(value: unknown) {
    if (!isRecord(value) || typeof value.uptime !== 'number' || !Number.isFinite(value.uptime)) {
        return null;
    }
    return {uptime: value.uptime};
}

function parseHealthResult(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }

    const healthValue = value.health;
    const health = isRecord(healthValue)
        ? {
            openFileDirect: typeof healthValue.openFileDirect === 'string' ? healthValue.openFileDirect : undefined,
            electronAPI: typeof healthValue.electronAPI === 'string' ? healthValue.electronAPI : undefined,
        }
        : undefined;

    return {
        ready: typeof value.ready === 'boolean' ? value.ready : undefined,
        health,
    };
}

function printUsage() {
    console.log(`
Electron Puppeteer Control - Multi-Session

Usage:
  pnpm electron:run [--session <name>] <command> [args...]

Options:
  --session <name>, -s <name>   Session name (default: "default")
  --all                         Apply to all sessions (with stop)
  --keep-nuxt                   Keep the default Nuxt dev server alive when stopping one session

Session:
  start               Start session (foreground, Ctrl+C to stop)
  startd              Start session in background (detached) and return
  cleanstart          Start with fresh Nuxt server (clears stale cache)
  stop                Stop session (or --all to stop every session)
  status              Check session health (shows connection status)
  restart             Stop and restart the session (useful for recovery)
  restartd            Stop and restart in detached mode
  list                List all sessions and their status
  logs [--follow] [--since=15m] [--tail=200]
                     Read the stable merged Electron, renderer, and Nuxt log

Commands (require running session):
  health              Check app health status (loaded, API availability)
  screenshot [name] [fullPage]
                     Take screenshot -> .devkit/sessions/<name>/screenshots/<name>.png
  screenshots <baseName> [count] [intervalMs] [fullPage]
                     Capture multiple screenshots at intervals in one command
  console [level] [limit]
                     Get console messages (all|log|warn|error|info|debug)
  devtools [section] [limit]
                     DevTools diagnostics (summary|console|network|errors|metrics|all)
  run <code>          Run Puppeteer code (access: page, screenshot, sleep/wait)
  run-file <path>     Run Puppeteer code from a JS file
  eval <code>         Evaluate JS in page
  click <selector> [timeoutMs]
                     Click element and return captured click-event metadata
  type <sel> <text>   Type into element
  content <selector>  Get text content
  waitfor <selector> [timeoutMs]
                     Wait until selector appears (useful for scripted flows)
  resize <w> <h>      Resize viewport (Puppeteer viewport)
  viewport            Print current viewport dimensions
  openPdf <path>      Open PDF file by absolute path

Examples:
  pnpm electron:run startd                        # Start default session
  pnpm electron:run -s test startd                 # Start "test" session
  pnpm electron:run -s test screenshot "home"      # Screenshot in "test" session
  pnpm electron:run screenshots "progress" 12 500  # 12 shots every 500ms
  pnpm electron:run devtools network 200           # Recent network diagnostics
  pnpm electron:run logs --follow --since=15m      # Follow merged current-session logs
  pnpm electron:run viewport                       # Read current viewport/window size
  pnpm electron:run resize 1280 820               # Set viewport for deterministic screenshots
  pnpm electron:run list                           # Show all running sessions
  pnpm electron:run stop --all                     # Stop everything
  pnpm electron:run -s test openPdf "/path/to.pdf"
  pnpm electron:run run "await sleep(500); return await page.title()"
`);
}

interface IParsedCliArgs {
    sessionName: string;
    stopAll: boolean;
    keepNuxt: boolean;
    rawCommand: string | null;
    command: TCliCommand | null;
    args: string[];
}

function parseCliArgs(rawArgs: string[]): IParsedCliArgs {
    let sessionName = 'default';
    let stopAll = false;
    let keepNuxt = false;
    const filteredArgs: string[] = [];

    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg?.startsWith('--session=')) {
            sessionName = arg.split('=')[1] ?? 'default';
        } else if (arg === '--session' || arg === '-s') {
            sessionName = rawArgs[++i] ?? 'default';
        } else if (arg === '--all') {
            stopAll = true;
        } else if (arg === '--keep-nuxt') {
            keepNuxt = true;
        } else if (arg) {
            filteredArgs.push(arg);
        }
    }

    const [
        rawCommand = null,
        ...args
    ] = filteredArgs;

    return {
        sessionName,
        stopAll,
        keepNuxt,
        rawCommand,
        command: rawCommand && isCliCommand(rawCommand) ? rawCommand : null,
        args,
    };
}

function resolveCliCommand(parsed: IParsedCliArgs) {
    if (!parsed.rawCommand) {
        printUsage();
        process.exit(0);
    }
    if (!parsed.command) {
        console.error(`Unknown command: ${parsed.rawCommand}`);
        process.exit(1);
    }
    return parsed.command;
}

function printJson(result: unknown) {
    console.log(JSON.stringify(result, null, 2));
}

async function printJsonCommand(command: Parameters<typeof sendCommand>[0], args: string[], timeoutMs?: number) {
    printJson(await sendCommand(command, args, timeoutMs));
}

function requireFirstArg(args: string[], errorMessage: string) {
    const value = args[0];
    if (!value) {
        console.error(errorMessage);
        process.exit(1);
    }
    return value;
}

function requireJoinedArgs(args: string[], errorMessage: string) {
    const code = args.join(' ');
    if (!code) {
        console.error(errorMessage);
        process.exit(1);
    }
    return code;
}

async function printSessionHealthStatus(port: number, uptime: number) {
    try {
        const healthResult = parseHealthResult(await sendCommand('health'));
        if (healthResult?.ready) {
            console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - App ready \u2713`);
            return;
        }
        const openFileDirect = healthResult?.health?.openFileDirect ?? 'unknown';
        const electronAPI = healthResult?.health?.electronAPI ?? 'unknown';
        console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - \u26a0\ufe0f  App not ready (openFileDirect=${openFileDirect}, electronAPI=${electronAPI})`);
    } catch {
        console.log(`Session '${getCurrentSessionName()}' running (port: ${port}, uptime: ${Math.round(uptime)}s) - \u26a0\ufe0f  Electron DISCONNECTED`);
        console.log(`  Use \`pnpm electron:run --session=${getCurrentSessionName()} restart\` to recover.`);
    }
}

async function printStatus() {
    const info = getSessionInfo();
    if (!info) {
        console.log(`No session '${getCurrentSessionName()}' running.`);
        process.exit(1);
    }

    try {
        const pingResult = parsePingResult(await sendCommand('ping'));
        if (!pingResult) {
            throw new Error('Malformed ping response payload');
        }
        await printSessionHealthStatus(info.port, pingResult.uptime);
        if (info.logs) {
            console.log(`  Logs: ${info.logs.sessionLogFile}`);
            console.log(`  Follow: pnpm electron:run --session=${getCurrentSessionName()} logs --follow`);
        }
    } catch {
        console.log('Session file exists but server not responding.');
        console.log('  Retaining session metadata for ownership recovery.');
        process.exit(1);
    }
}

async function printSessionListItem(name: string) {
    const cleanupResult = await cleanupStaleSessionArtifacts(name);
    if (cleanupResult.retained) {
        console.log(`  ${name}`);
        console.log(`    Status:  retained (${cleanupResult.reason ?? 'ownership is unresolved'})`);
        console.log('    Cleanup was refused; session evidence was preserved.');
        console.log('');
        return;
    }
    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);

    if (info && isProcessAlive(info.pid)) {
        const running = await isSessionRunning(name);
        const status = running ? 'running' : 'starting';
        console.log(`  ${name}`);
        console.log(`    Status:  ${status}`);
        console.log(`    PID:     ${info.pid}`);
        console.log(`    Ports:   server=${info.port}, cdp=${info.cdpPort}`);
        if (info.logs) {
            console.log(`    Logs:    ${info.logs.sessionLogFile}`);
        }
        console.log('');
        return;
    }

    if (starting && isProcessAlive(starting.pid)) {
        console.log(`  ${name}`);
        console.log('    Status:  starting');
        console.log(`    PID:     ${starting.pid}`);
        console.log('');
        return;
    }

    try {
        unlinkSync(sessionFilePath(name));
    } catch {}
    clearSessionStarting(name);
}

async function printSessionList() {
    const names = listAllSessionNames();
    if (names.length === 0) {
        console.log('No sessions found.');
        return;
    }

    console.log('Sessions:\n');
    for (const name of names) {
        await printSessionListItem(name);
    }
}

async function restartSession(detached: boolean) {
    console.log(detached
        ? `Restarting session '${getCurrentSessionName()}' in background...`
        : `Restarting session '${getCurrentSessionName()}'...`);
    await stopSingleSession(getCurrentSessionName());
    await delay(1000);
    if (detached) {
        await startSessionDetached();
    } else {
        await devSupervisor(false);
    }
}

type TCliCommandHandler = (args: string[], parsed: IParsedCliArgs) => Promise<void>;

const CLI_COMMAND_HANDLERS: Record<TCliCommand, TCliCommandHandler> = {
    async start() {
        console.log(`Starting session '${getCurrentSessionName()}'...`);
        await devSupervisor(false);
    },
    async cleanstart() {
        console.log(`Starting fresh session '${getCurrentSessionName()}'...`);
        await devSupervisor(true);
    },
    async startd() {
        await startSessionDetached();
    },
    async stop(args, parsed) {
        void args;
        await stopSession({
            stopAll: parsed.stopAll,
            keepNuxt: parsed.keepNuxt,
        });
    },
    async status() {
        await printStatus();
    },
    async restart() {
        await restartSession(false);
    },
    async restartd() {
        await restartSession(true);
    },
    async list() {
        await printSessionList();
    },
    logs(args) {
        runDevLogs([
            `--session=${getCurrentSessionName()}`,
            ...args,
        ]);
        return Promise.resolve();
    },
    screenshot: args => printJsonCommand('screenshot', args),
    screenshots: args => printJsonCommand('screenshots', args, 600_000),
    console: args => printJsonCommand('console', args),
    devtools: args => printJsonCommand('devtools', args),
    click: args => printJsonCommand('click', args),
    type: args => printJsonCommand('type', args),
    async content(args) {
        console.log(await sendCommand('content', args));
    },
    waitfor: args => printJsonCommand('waitfor', args, COMMAND_EXECUTION_TIMEOUT_MS),
    resize: args => printJsonCommand('resize', args),
    viewport: args => printJsonCommand('viewport', args),
    async run(args) {
        const code = requireJoinedArgs(args, 'No code provided');
        const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
        if (result !== undefined) {
            printJson(result);
        }
    },
    async 'run-file'(args) {
        const filePath = requireFirstArg(args, 'JS file path required');
        const code = readFileSync(filePath, 'utf8');
        const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
        if (result !== undefined) {
            printJson(result);
        }
    },
    async eval(args) {
        const code = requireJoinedArgs(args, 'No code provided');
        printJson(await sendCommand('eval', [code], COMMAND_EXECUTION_TIMEOUT_MS));
    },
    async openPdf(args) {
        const pdfPath = requireFirstArg(args, 'PDF path required');
        printJson(await sendCommand('openPdf', [pdfPath], COMMAND_EXECUTION_TIMEOUT_MS));
    },
    async health() {
        printJson(await sendCommand('health'));
    },
};

export async function runCli() {
    const parsed = parseCliArgs(process.argv.slice(2));
    setCurrentSessionName(parsed.sessionName);
    const command = resolveCliCommand(parsed);

    try {
        const legacyObservations = inspectLegacySessionFiles();
        if (READ_ONLY_CLI_COMMANDS.has(command)) {
            printLegacySessionInspection(legacyObservations);
        } else {
            migrateLegacySessionFiles(legacyObservations);
        }
        await CLI_COMMAND_HANDLERS[command](parsed.args, parsed);
    } catch (error) {
        console.error('Error:', error instanceof Error ? getErrorMessage(error) : error);
        process.exit(1);
    }
}
