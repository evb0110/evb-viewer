import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    existsSync,
    readFileSync,
    watchFile,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    electronFileLogDir,
    validateSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    APP_LOG_FILE_NAME,
    decodeLogRecord,
    formatLogOrigin,
    isLogLevelEnabled,
    parseLogLevel,
    type ILogRecord,
    type TLogLevel,
} from '@contracts/logRecord';
import { formatTerminalLogRecord } from '@scripts/electron-run/terminalLog';

interface IDevLogsOptions {
    follow: boolean;
    sessionName: string;
    sinceMs: number | null;
    tailLines: number;
    /** Read the structured app log instead of the terminal transcript. */
    app: boolean;
    json: boolean;
    level: TLogLevel;
    scope: string | null;
    grep: RegExp | null;
}

interface ILogManifest {
    sessionLogFile?: string;
    runDir?: string;
}

function parseSince(value: string, nowMs: number) {
    const duration = /^(\d+)(ms|s|m|h|d)$/u.exec(value);
    if (duration) {
        const amount = Number(duration[1]);
        const unitMs = {
            ms: 1,
            s: 1_000,
            m: 60_000,
            h: 3_600_000,
            d: 86_400_000,
        }[duration[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
        return nowMs - amount * unitMs;
    }

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new Error(`Invalid --since value: ${value}. Use an ISO timestamp or a duration such as 15m.`);
    }
    return timestamp;
}

export function parseDevLogsArgs(args: readonly string[], nowMs = Date.now()): IDevLogsOptions {
    let follow = false;
    let sessionName = 'default';
    let sinceMs: number | null = null;
    let tailLines = 200;
    let app = false;
    let json = false;
    let level: TLogLevel = 'debug';
    let scope: string | null = null;
    let grep: RegExp | null = null;
    const readValue = (arg: string, name: string, index: number) => (
        arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : args[index + 1] ?? ''
    );

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--follow' || arg === '-f') {
            follow = true;
        } else if (arg === '--session' || arg === '-s') {
            sessionName = args[++index] ?? '';
        } else if (arg?.startsWith('--session=')) {
            sessionName = arg.slice('--session='.length);
        } else if (arg === '--since') {
            sinceMs = parseSince(args[++index] ?? '', nowMs);
        } else if (arg?.startsWith('--since=')) {
            sinceMs = parseSince(arg.slice('--since='.length), nowMs);
        } else if (arg === '--tail' || arg === '-n') {
            tailLines = Number(args[++index]);
        } else if (arg?.startsWith('--tail=')) {
            tailLines = Number(arg.slice('--tail='.length));
        } else if (arg === '--app') {
            app = true;
        } else if (arg === '--json') {
            app = true;
            json = true;
        } else if (arg === '--level' || arg?.startsWith('--level=')) {
            const value = readValue(arg, '--level', index);
            if (!arg.includes('=')) index += 1;
            const parsed = parseLogLevel(value);
            if (!parsed) {
                throw new Error(`Invalid --level value: ${value}. Use debug, info, warn, or error.`);
            }
            app = true;
            level = parsed;
        } else if (arg === '--scope' || arg?.startsWith('--scope=')) {
            scope = readValue(arg, '--scope', index);
            if (!arg.includes('=')) index += 1;
            app = true;
        } else if (arg === '--grep' || arg?.startsWith('--grep=')) {
            const value = readValue(arg, '--grep', index);
            if (!arg.includes('=')) index += 1;
            grep = new RegExp(value, 'iu');
            app = true;
        } else {
            throw new Error(`Unknown argument: ${arg ?? '<missing>'}`);
        }
    }

    validateSessionName(sessionName);
    if (!Number.isSafeInteger(tailLines) || tailLines < 0) {
        throw new Error('--tail must be a non-negative integer.');
    }
    return {
        follow,
        sessionName,
        sinceMs,
        tailLines,
        app,
        json,
        level,
        scope,
        grep,
    };
}

type TAppLogFilter = Pick<IDevLogsOptions, 'sinceMs' | 'level' | 'scope' | 'grep'>;

function matchesAppLogFilter(record: ILogRecord, filter: TAppLogFilter) {
    if (!isLogLevelEnabled(record.level, filter.level)) {
        return false;
    }
    if (filter.sinceMs !== null && Date.parse(record.ts) < filter.sinceMs) {
        return false;
    }
    if (filter.scope !== null && !formatLogOrigin(record).includes(filter.scope)) {
        return false;
    }
    return filter.grep === null || filter.grep.test(`${record.msg} ${JSON.stringify(record.data ?? {})}`);
}

/**
 * Formats NDJSON app-log text. Lines that are not records (for example a
 * partially written tail) are skipped.
 */
export function formatAppLogText(
    text: string,
    options: TAppLogFilter & Pick<IDevLogsOptions, 'json'> & {
        tailLines?: number;
        color?: boolean;
    },
) {
    const lines: string[] = [];
    for (const line of text.split('\n')) {
        const record = decodeLogRecord(line.trim());
        if (!record || !matchesAppLogFilter(record, options)) {
            continue;
        }
        lines.push(options.json ? line.trim() : formatTerminalLogRecord(record, {color: options.color ?? false}));
    }
    const tailLines = options.tailLines ?? 0;
    return (tailLines > 0 && lines.length > tailLines ? lines.slice(-tailLines) : lines).join('\n');
}

function runAppLogs(options: IDevLogsOptions) {
    const logFile = join(electronFileLogDir(options.sessionName), APP_LOG_FILE_NAME);
    if (!existsSync(logFile)) {
        throw new Error(`No app log is available for session '${options.sessionName}'. Expected ${logFile}`);
    }
    process.stderr.write(`[dev:logs] session=${options.sessionName}\n`);
    process.stderr.write(`[dev:logs] app-log=${logFile}\n`);
    const color = Boolean(process.stdout.isTTY) && !options.json;
    let content = readFileSync(logFile, 'utf8');
    const initial = formatAppLogText(content, {
        ...options,
        color,
    });
    if (initial) process.stdout.write(`${initial}\n`);
    let offset = Buffer.byteLength(content);
    let pending = '';
    if (!options.follow) {
        return;
    }
    watchFile(logFile, {interval: 250}, (current) => {
        if (current.size < offset) {
            // Rotated: continue from the start of the new file.
            offset = 0;
            pending = '';
        }
        if (current.size === offset) {
            return;
        }
        content = readFileSync(logFile, 'utf8');
        const appended = pending + Buffer.from(content).subarray(offset).toString('utf8');
        offset = Buffer.byteLength(content);
        const lastNewline = appended.lastIndexOf('\n');
        pending = appended.slice(lastNewline + 1);
        const formatted = formatAppLogText(appended.slice(0, lastNewline + 1), {
            ...options,
            tailLines: 0,
            color,
        });
        if (formatted) process.stdout.write(`${formatted}\n`);
    });
}

function readManifest(path: string): ILogManifest | null {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as ILogManifest;
    } catch {
        return null;
    }
}

export function filterDevLogText(text: string, options: Pick<IDevLogsOptions, 'sinceMs' | 'tailLines'>) {
    let lines = text.split('\n');
    if (options.sinceMs !== null) {
        let currentTimestamp: number | null = null;
        lines = lines.filter((line) => {
            const match = /^\[([^\s\]]+)/u.exec(line);
            if (match) {
                const parsed = Date.parse(match[1] ?? '');
                if (Number.isFinite(parsed)) currentTimestamp = parsed;
            }
            return currentTimestamp === null || currentTimestamp >= options.sinceMs!;
        });
    }
    if (options.tailLines > 0 && lines.length > options.tailLines) {
        lines = lines.slice(-options.tailLines);
    }
    return lines.join('\n').replace(/^\n+/u, '');
}

export function runDevLogs(args = process.argv.slice(2)) {
    const options = parseDevLogsArgs(args);
    if (options.app) {
        runAppLogs(options);
        return;
    }
    const sessionDir = join(projectRoot, '.devkit', 'sessions', options.sessionName);
    const manifestFile = join(sessionDir, 'logs.json');
    const manifest = readManifest(manifestFile);
    const sessionLogFile = manifest?.sessionLogFile ?? join(sessionDir, 'session.log');
    if (!existsSync(sessionLogFile)) {
        throw new Error(`No log is available for session '${options.sessionName}'. Expected ${sessionLogFile}`);
    }

    process.stderr.write(`[dev:logs] session=${options.sessionName}\n`);
    process.stderr.write(`[dev:logs] log=${sessionLogFile}\n`);
    if (manifest?.runDir) process.stderr.write(`[dev:logs] run=${manifest.runDir}\n`);

    let content = readFileSync(sessionLogFile, 'utf8');
    const initial = filterDevLogText(content, options);
    if (initial) process.stdout.write(initial.endsWith('\n') ? initial : `${initial}\n`);
    let offset = Buffer.byteLength(content);

    if (!options.follow) {
        return;
    }

    watchFile(sessionLogFile, {interval: 250}, (current) => {
        if (current.size < offset) offset = 0;
        if (current.size === offset) {
            return;
        }
        content = readFileSync(sessionLogFile, 'utf8');
        const appended = Buffer.from(content).subarray(offset).toString('utf8');
        offset = Buffer.byteLength(content);
        if (appended) process.stdout.write(appended);
    });
}

const isDirectRun = process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
if (isDirectRun) {
    try {
        runDevLogs();
    } catch (error) {
        process.stderr.write(`${getErrorMessage(error)}\n`);
        process.exitCode = 1;
    }
}
