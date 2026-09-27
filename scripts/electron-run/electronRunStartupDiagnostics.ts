import { execFileSync } from 'node:child_process';
import { projectRoot } from '@scripts/electron-run/projectRoot';

const COMMAND_TIMEOUT_MS = 1_500;
const MAX_COMMAND_BUFFER_BYTES = 256 * 1024;
const MAX_SECTION_CHARS = 12_000;
const MAX_SECTION_LINES = 80;
const MAX_PROCESS_ROWS = 80;
const MAX_COMMAND_CHARS = 260;

export interface IProcessSnapshotRow {
    pid: number;
    ppid: number;
    stat: string;
    elapsed: string;
    command: string;
}

export interface IProcessSnapshotSummary {
    projectRoot: number;
    electron: number;
    nuxt: number;
    pnpm: number;
    interesting: number;
}

interface IStartupDiagnosticCommandResult {
    ok: boolean;
    output: string;
    error: string;
}

interface IStartupDiagnosticsOptions {
    includeMacOSLog?: boolean;
    platform?: NodeJS.Platform;
    root?: string;
}

function toText(value: unknown) {
    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }
    if (typeof value === 'string') {
        return value;
    }
    return '';
}

function truncateText(value: string, options: {
    maxChars?: number;
    maxLines?: number;
} = {}) {
    const maxChars = options.maxChars ?? MAX_SECTION_CHARS;
    const maxLines = options.maxLines ?? MAX_SECTION_LINES;
    const normalized = value.replace(/\r\n/g, '\n').trim();
    const lines = normalized.split('\n').filter(Boolean);
    const lineCapped = lines.length > maxLines
        ? [
            ...lines.slice(0, maxLines),
            `... truncated ${lines.length - maxLines} additional line(s) ...`,
        ].join('\n')
        : lines.join('\n');
    if (lineCapped.length <= maxChars) {
        return lineCapped;
    }
    return `${lineCapped.slice(0, maxChars)}\n... truncated ${lineCapped.length - maxChars} additional character(s) ...`;
}

function runCommand(command: string, args: string[]): IStartupDiagnosticCommandResult {
    try {
        return {
            ok: true,
            output: toText(execFileSync(command, args, {
                encoding: 'utf8',
                maxBuffer: MAX_COMMAND_BUFFER_BYTES,
                timeout: COMMAND_TIMEOUT_MS,
            })),
            error: '',
        };
    } catch (error) {
        const candidate = error as {
            stdout?: unknown;
            stderr?: unknown;
            message?: unknown;
        };
        const output = [
            toText(candidate.stdout),
            toText(candidate.stderr),
        ].filter(Boolean).join('\n');
        const message = typeof candidate.message === 'string'
            ? candidate.message
            : String(error);
        return {
            ok: false,
            output,
            error: message,
        };
    }
}

export function parseUnixProcessSnapshot(output: string): IProcessSnapshotRow[] {
    const rows: IProcessSnapshotRow[] = [];
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) {
            continue;
        }
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const command = match[5]?.trim() ?? '';
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid < 0 || !command) {
            continue;
        }
        rows.push({
            pid,
            ppid,
            stat: match[3] ?? '',
            elapsed: match[4] ?? '',
            command,
        });
    }
    return rows;
}

function normalizePathForMatch(path: string) {
    return path.replace(/\\/g, '/');
}

function isElectronProcess(command: string) {
    return /\bElectron(?:\.app)?\b/.test(command)
        || command.includes('node_modules/electron')
        || command.includes('--remote-debugging-port=');
}

function isNuxtProcess(command: string) {
    return /\b(?:nuxt|nuxi|vite|nitro)\b/i.test(command);
}

function isPnpmProcess(command: string) {
    return /\bpnpm(?:\.cmd)?\b/i.test(command);
}

function classifyProcessSnapshotRow(row: IProcessSnapshotRow, root = projectRoot) {
    const normalizedCommand = normalizePathForMatch(row.command);
    const normalizedRoot = normalizePathForMatch(root);
    return {
        projectRoot: normalizedCommand.includes(normalizedRoot),
        electron: isElectronProcess(normalizedCommand),
        nuxt: isNuxtProcess(normalizedCommand),
        pnpm: isPnpmProcess(normalizedCommand),
    };
}

export function summarizeProcessSnapshot(rows: IProcessSnapshotRow[], root = projectRoot): IProcessSnapshotSummary {
    const interestingPids = new Set<number>();
    const summary: IProcessSnapshotSummary = {
        projectRoot: 0,
        electron: 0,
        nuxt: 0,
        pnpm: 0,
        interesting: 0,
    };

    for (const row of rows) {
        const classification = classifyProcessSnapshotRow(row, root);
        if (classification.projectRoot) {
            summary.projectRoot += 1;
            interestingPids.add(row.pid);
        }
        if (classification.electron) {
            summary.electron += 1;
            interestingPids.add(row.pid);
        }
        if (classification.nuxt) {
            summary.nuxt += 1;
            interestingPids.add(row.pid);
        }
        if (classification.pnpm) {
            summary.pnpm += 1;
            interestingPids.add(row.pid);
        }
    }

    summary.interesting = interestingPids.size;
    return summary;
}

export function selectInterestingProcessRows(rows: IProcessSnapshotRow[], root = projectRoot) {
    return rows.filter((row) => {
        const classification = classifyProcessSnapshotRow(row, root);
        return classification.projectRoot
            || classification.electron
            || classification.nuxt
            || classification.pnpm;
    });
}

export function formatProcessSnapshot(rows: IProcessSnapshotRow[], root = projectRoot) {
    const summary = summarizeProcessSnapshot(rows, root);
    const interestingRows = selectInterestingProcessRows(rows, root)
        .slice(0, MAX_PROCESS_ROWS);
    const header = [
        `Counts: projectRoot=${summary.projectRoot}, electron=${summary.electron}, nuxt=${summary.nuxt}, pnpm=${summary.pnpm}, interesting=${summary.interesting}`,
        'PID PPID STAT ELAPSED COMMAND',
    ];
    const body = interestingRows.map(row => [
        row.pid,
        row.ppid,
        row.stat,
        row.elapsed,
        row.command.length > MAX_COMMAND_CHARS
            ? `${row.command.slice(0, MAX_COMMAND_CHARS)}...`
            : row.command,
    ].join(' '));
    const overflow = summary.interesting > interestingRows.length
        ? [`... truncated ${summary.interesting - interestingRows.length} additional process row(s) ...`]
        : [];
    return [
        ...header,
        ...(body.length > 0 ? body : ['No project-rooted / Electron / Nuxt / pnpm processes found.']),
        ...overflow,
    ].join('\n');
}

function collectProcessSnapshot(platform: NodeJS.Platform, root: string) {
    if (platform === 'win32') {
        return 'Process snapshot unavailable on Windows hosts for this diagnostic.';
    }

    const result = runCommand('ps', [
        '-ax',
        '-o',
        'pid=,ppid=,stat=,etime=,command=',
    ]);
    if (!result.ok && !result.output.trim()) {
        return `Process snapshot unavailable: ${result.error}`;
    }
    const rows = parseUnixProcessSnapshot(result.output);
    return formatProcessSnapshot(rows, root);
}

function collectMacOSLogSnippet(platform: NodeJS.Platform) {
    if (platform !== 'darwin') {
        return 'macOS unified log unavailable on this host.';
    }

    const result = runCommand('log', [
        'show',
        '--style',
        'compact',
        '--last',
        '2m',
        '--predicate',
        'process == "Electron" OR process == "runningboardd" OR process == "kernel" OR eventMessage CONTAINS[c] "Electron" OR eventMessage CONTAINS[c] "SIGKILL" OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam"',
    ]);
    const output = truncateText(result.output || result.error, {
        maxChars: MAX_SECTION_CHARS,
        maxLines: MAX_SECTION_LINES,
    });
    if (output) {
        return output;
    }
    return result.ok
        ? 'No matching macOS unified log entries in the last 2m.'
        : `macOS unified log unavailable: ${result.error}`;
}

export function formatElectronStartupDiagnostics(options: IStartupDiagnosticsOptions = {}) {
    const platform = options.platform ?? process.platform;
    const root = options.root ?? projectRoot;
    const sections = [
        '--- Startup process snapshot ---',
        collectProcessSnapshot(platform, root),
    ];

    if (options.includeMacOSLog ?? platform === 'darwin') {
        sections.push(
            '--- macOS unified log (last 2m, Electron/runningboardd/kernel) ---',
            collectMacOSLogSnippet(platform),
        );
    }

    return sections.join('\n');
}
