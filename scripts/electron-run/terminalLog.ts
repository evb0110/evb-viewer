import { stripVTControlCharacters } from 'node:util';
import {
    decodeLogRecord,
    formatLogRecordLine,
    isLogLevelEnabled,
    parseLogLevel,
    toLogData,
    type ILogRecord,
    type TLogData,
    type TLogLevel,
    type TLogProcess,
} from '@contracts/logRecord';

/**
 * The dev launcher's single terminal format. Main-process records arrive as
 * NDJSON on Electron stdout, renderer console messages arrive over CDP, and
 * raw Electron/Chromium/Node stderr is classified here. All three print
 * through `printTerminalLogRecord` so every line has the same shape:
 * `HH:MM:SS.mmm LEVEL proc/scope message key=value …`.
 */

export const TERMINAL_LOG_LEVEL_ENV = 'EVB_LOG_LEVEL';
const TERMINAL_MAX_DATA_CHARS = 600;

export function resolveTerminalLogLevel(env: NodeJS.ProcessEnv = process.env): TLogLevel {
    return parseLogLevel(env[TERMINAL_LOG_LEVEL_ENV]) ?? 'info';
}

const ANSI = {
    reset: '\u001B[0m',
    dim: '\u001B[2m',
    red: '\u001B[31m',
    yellow: '\u001B[33m',
    cyan: '\u001B[36m',
    gray: '\u001B[90m',
} as const;

function shouldUseColor(stream: NodeJS.WriteStream = process.stdout) {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
        return false;
    }
    return Boolean(stream.isTTY) || process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true';
}

function colorize(part: 'time' | 'level' | 'origin' | 'data', text: string, level: TLogLevel) {
    if (part === 'time' || part === 'data') {
        return `${ANSI.gray}${text}${ANSI.reset}`;
    }
    if (part === 'origin') {
        return `${ANSI.cyan}${text}${ANSI.reset}`;
    }
    if (level === 'error') {
        return `${ANSI.red}${text}${ANSI.reset}`;
    }
    if (level === 'warn') {
        return `${ANSI.yellow}${text}${ANSI.reset}`;
    }
    return level === 'debug' ? `${ANSI.dim}${text}${ANSI.reset}` : text;
}

export function formatTerminalLogRecord(record: ILogRecord, options: {color?: boolean;} = {}) {
    return formatLogRecordLine(record, {
        time: 'clock',
        maxDataChars: TERMINAL_MAX_DATA_CHARS,
        ...(options.color ? {decorate: colorize} : {}),
    });
}

export function printTerminalLogRecord(record: ILogRecord, minimumLevel = resolveTerminalLogLevel()) {
    if (!isLogLevelEnabled(record.level, minimumLevel)) {
        return;
    }
    const stream = process.stdout;
    stream.write(`${formatTerminalLogRecord(record, {color: shouldUseColor(stream)})}\n`);
}

export function createLogRecord(
    level: TLogLevel,
    proc: TLogProcess,
    scope: string,
    msg: string,
    data?: unknown,
): ILogRecord {
    const normalized = toLogData(data);
    return {
        ts: new Date().toISOString(),
        level,
        proc,
        scope,
        msg,
        ...(normalized ? {data: normalized} : {}),
    };
}

// ---------------------------------------------------------------------------
// Renderer console (CDP)

const CONSOLE_TYPE_LEVELS: Record<string, TLogLevel> = {
    debug: 'debug',
    verbose: 'debug',
    trace: 'debug',
    log: 'info',
    info: 'info',
    dir: 'info',
    table: 'info',
    warn: 'warn',
    warning: 'warn',
    error: 'error',
    assert: 'error',
};

/** BrowserLogger's console line: `[ISO] [section] message`. */
const BROWSER_LOGGER_LINE_PATTERN = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] \[([^\]]+)\] ([\s\S]*)$/u;
const VITE_LINE_PATTERN = /^\[vite\] ([\s\S]*)$/u;

// Known development-only console output that says nothing about the app.
const RENDERER_CONSOLE_NOISE: readonly RegExp[] = [
    /^Electron Security Warning/u,
    /^<Suspense> is an experimental feature/u,
    /^Download the Vue Devtools extension/u,
];

function isPlainObject(value: unknown): value is TLogData {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds one record from a console call's evaluated arguments. `args` are the
 * JSON values of the call; `fallbackText` is CDP's own text for arguments that
 * could not be evaluated. The old launcher printed `msg.text()` (which renders
 * objects as `[object Object]`) and then every argument again.
 */
export function consoleMessageToLogRecord(
    type: string,
    args: readonly unknown[],
    fallbackText: string,
): ILogRecord {
    let level = CONSOLE_TYPE_LEVELS[type] ?? 'info';
    const [
        first,
        ...rest
    ] = args.length > 0 ? args : [fallbackText];
    const head = typeof first === 'string' ? first : fallbackText;
    const extra = typeof first === 'string' ? rest : args;
    let data: unknown;
    if (extra.length === 1 && isPlainObject(extra[0])) {
        data = extra[0];
    } else if (extra.length > 0) {
        data = {args: extra};
    }

    let scope = 'console';
    let msg = head;
    let ts: string | undefined;
    const loggerMatch = BROWSER_LOGGER_LINE_PATTERN.exec(head);
    const viteMatch = loggerMatch ? null : VITE_LINE_PATTERN.exec(head);
    if (loggerMatch) {
        ts = loggerMatch[1];
        scope = loggerMatch[2] ?? scope;
        msg = loggerMatch[3] ?? '';
    } else if (viteMatch) {
        scope = 'vite';
        msg = viteMatch[1] ?? '';
        if (level === 'info') {
            level = 'debug';
        }
    } else if (head.startsWith('[Vue warn]: ')) {
        scope = 'vue';
        msg = head.slice('[Vue warn]: '.length);
    }
    if (RENDERER_CONSOLE_NOISE.some(pattern => pattern.test(msg))) {
        level = 'debug';
    }

    const record = createLogRecord(level, 'renderer', scope, msg.trim(), data);
    return ts && Number.isFinite(Date.parse(ts)) ? {
        ...record,
        ts,
    } : record;
}

// ---------------------------------------------------------------------------
// Electron process output

const CHROMIUM_LINE_PATTERN = /^\[\d+:\d+\/\d+\.\d+:([A-Z]+\d*):([^\]]+)\] ?(.*)$/u;
const IPC_HANDLER_ERROR_PATTERN = /^Error occurred in handler for '([^']+)': (.*)$/u;
const NODE_WARNING_PATTERN = /^\(node:\d+\) (?:\[[^\]]+\] )?([A-Za-z]*Warning): (.*)$/u;
const APPKIT_LINE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ Electron\[\d+:\d+\] (.*)$/u;
const CHROMIUM_CONSOLE_END_PATTERN = /", source: \S.* \(\d+\)$/u;

// Chromium ERROR lines that are routine on macOS and say nothing about EVB.
const CHROMIUM_NOISE: readonly RegExp[] = [
    /SharedImageManager::ProduceMemory/u,
    /task_policy_set TASK_SUPPRESSION_POLICY/u,
];
const STDERR_NOISE: readonly RegExp[] = [
    /^DevTools listening on /u,
    /^sandbox_extension_issue_file_to_process failed/u,
    /^\(Use `Electron --trace-warnings \.\.\.` to show where the warning was created\)$/u,
];

interface IStderrBlock {readonly lines: string[];}

function isContinuationLine(line: string) {
    return /^\s/u.test(line) || /^[}\])]/u.test(line);
}

function firstAppFrame(detailLines: readonly string[]) {
    return detailLines
        .map(line => line.trim())
        .find(line => line.startsWith('at ') && !line.includes('node:electron/') && !line.includes('node:internal/'));
}

export function classifyElectronStderrBlock(block: IStderrBlock): ILogRecord | null {
    const [
        header = '',
        ...detailLines
    ] = block.lines;
    const detail = detailLines.filter(line => line.trim().length > 0);

    const chromium = CHROMIUM_LINE_PATTERN.exec(header);
    if (chromium) {
        const severity = chromium[1] ?? 'INFO';
        const source = chromium[2] ?? '';
        const message = chromium[3] ?? '';
        if (source.startsWith('CONSOLE')) {
            // Duplicate of the renderer console that CDP already delivered.
            return null;
        }
        const noisy = CHROMIUM_NOISE.some(pattern => pattern.test(message));
        const level: TLogLevel = noisy || severity === 'INFO' || severity.startsWith('VERBOSE')
            ? 'debug'
            : 'warn';
        return createLogRecord(level, 'electron', 'chromium', message, {source: source.replace(/\(\d+\)$/u, '')});
    }

    const ipc = IPC_HANDLER_ERROR_PATTERN.exec(header);
    if (ipc) {
        // The validated IPC registrar already logged this rejection as a
        // structured `main/ipc` record; keep Electron's copy as detail only.
        const error = ipc[2] ?? '';
        const frame = firstAppFrame(detail);
        const properties = detail.filter(line => !line.trim().startsWith('at '));
        return createLogRecord(
            'debug',
            'electron',
            'ipc',
            'Electron reported IPC handler rejection',
            {
                channel: ipc[1],
                error,
                ...(frame ? {at: frame.slice(3)} : {}),
                ...(properties.length > 0 ? {detail: properties.map(line => line.trim()).join(' ')} : {}),
            },
        );
    }

    const nodeWarning = NODE_WARNING_PATTERN.exec(header);
    if (nodeWarning) {
        // The main process logs every warning with its stack through
        // `process.on('warning')`; this stderr copy is the duplicate.
        const message = nodeWarning[2] ?? '';
        const frame = firstAppFrame(detail);
        return createLogRecord('debug', 'main', 'node', message, {
            warning: nodeWarning[1],
            ...(frame ? {at: frame.slice(3)} : {}),
        });
    }

    const appKit = APPKIT_LINE_PATTERN.exec(header);
    if (appKit) {
        return createLogRecord('debug', 'electron', 'appkit', appKit[1] ?? '');
    }

    if (STDERR_NOISE.some(pattern => pattern.test(header))) {
        return createLogRecord('debug', 'electron', 'stderr', header);
    }

    if (header.startsWith('Error sending from webFrameMain:')) {
        return createLogRecord('warn', 'main', 'electron', header, {...(firstAppFrame(detail) ? {at: firstAppFrame(detail)!.slice(3)} : {})});
    }

    return createLogRecord('info', 'electron', 'stderr', header, detail.length > 0
        ? {detail: detail.slice(0, 12).map(line => line.trim()).join(' ⏎ ')}
        : undefined);
}

/**
 * Splits Electron's stdout and stderr into lines and turns them into records.
 * stdout lines are NDJSON from the main logger's mirror; anything else is
 * raw output. stderr lines are grouped with their indented continuation
 * lines (stacks, error properties) before classification.
 */
export function createElectronOutputRecordStream(onRecord: (record: ILogRecord) => void) {
    const partial: Record<'stdout' | 'stderr', string> = {
        stdout: '',
        stderr: '',
    };
    let pendingBlock: string[] | null = null;
    let pendingTimer: NodeJS.Timeout | null = null;
    // Continuation lines of a Chromium CONSOLE echo are dropped with it.
    let suppressContinuation = false;

    const flushBlock = () => {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        const lines = pendingBlock;
        pendingBlock = null;
        if (!lines) {
            return;
        }
        const record = classifyElectronStderrBlock({lines});
        if (record) {
            onRecord(record);
        }
    };

    const handleStdoutLine = (line: string) => {
        if (line.trim().length === 0) {
            return;
        }
        const record = decodeLogRecord(line);
        onRecord(record ?? createLogRecord('info', 'electron', 'stdout', line));
    };

    const handleStderrLine = (rawLine: string) => {
        const line = stripVTControlCharacters(rawLine);
        if (suppressContinuation) {
            suppressContinuation = !CHROMIUM_CONSOLE_END_PATTERN.test(line);
            return;
        }
        if (pendingBlock && (isContinuationLine(line) || line.length === 0)) {
            pendingBlock.push(line);
            return;
        }
        flushBlock();
        if (line.trim().length === 0) {
            return;
        }
        const chromium = CHROMIUM_LINE_PATTERN.exec(line);
        if (chromium && (chromium[2] ?? '').startsWith('CONSOLE')) {
            // Multi-line console text (for example Electron's CSP warning)
            // continues until Chromium's `", source: <url> (<line>)` suffix.
            suppressContinuation = !CHROMIUM_CONSOLE_END_PATTERN.test(line);
            return;
        }
        pendingBlock = [line];
        pendingTimer = setTimeout(flushBlock, 50);
        pendingTimer.unref?.();
    };

    return {
        write(stream: 'stdout' | 'stderr', chunk: Buffer | string) {
            const text = partial[stream] + chunk.toString();
            const lines = text.split(/\r?\n/u);
            partial[stream] = lines.pop() ?? '';
            for (const line of lines) {
                if (stream === 'stdout') {
                    handleStdoutLine(line);
                } else {
                    handleStderrLine(line);
                }
            }
        },
        end() {
            for (const stream of [
                'stdout',
                'stderr',
            ] as const) {
                if (partial[stream]) {
                    const line = partial[stream];
                    partial[stream] = '';
                    if (stream === 'stdout') {
                        handleStdoutLine(line);
                    } else {
                        handleStderrLine(line);
                    }
                }
            }
            flushBlock();
        },
    };
}

// ---------------------------------------------------------------------------
// Nuxt dev server output

const NUXT_CONTINUATION_PATTERN = /^\s|^[╰├│]|^>/u;
const NUXT_LEVEL_PATTERN = /(?:^|\s)(ERROR|WARN)\s/u;
// Consola indents its level label (` WARN  …`), so an indented line can still
// start a new block.
const NUXT_LEVEL_HEADER_PATTERN = /^\s*(?:ERROR|WARN|INFO|SUCCESS|FATAL)\s/u;

// Consola-formatted lines that restate what CDP or the dependency tree
// already says. They stay in the raw run files.
const NUXT_DEBUG_PATTERNS: readonly RegExp[] = [
    // Nuxt forwards browser console calls to the server terminal; CDP already
    // printed them with structured data.
    /\[console\.(?:log|info|warn|error|debug)\]/u,
    /\[Unhandled error\] Error: ResizeObserver loop/u,
    // Build-time analysis warnings about third-party plugins in node_modules.
    /Failed to parse static properties from plugin node_modules\//u,
    /ELIFECYCLE\s+Command failed/u,
];
const NUXT_BUILD_NOISE_PATTERNS: readonly RegExp[] = [
    /^[✔ℹ●│]/u,
    /^\[nitro\] ✔/u,
    /^➜/u,
    /^> /u,
];

export function classifyNuxtOutputBlock(lines: readonly string[]): ILogRecord | null {
    const [
        rawHeader = '',
        ...detailLines
    ] = lines;
    const header = rawHeader.trim();
    if (header.length === 0) {
        return null;
    }
    const detail = detailLines.map(line => line.trim()).filter(line => line.length > 0);
    const data = detail.length > 0 ? {detail: detail.slice(0, 8).join(' ⏎ ')} : undefined;
    const levelMatch = NUXT_LEVEL_PATTERN.exec(header);
    if (/^ℹ page reload /u.test(header)) {
        return createLogRecord('info', 'launcher', 'nuxt', header.replace(/^ℹ /u, ''));
    }
    if (NUXT_DEBUG_PATTERNS.some(pattern => pattern.test(header))) {
        return createLogRecord('debug', 'launcher', 'nuxt', header, data);
    }
    if (levelMatch) {
        const msg = header.replace(/^\[nitro\]\s*/u, 'nitro: ').replace(/\s*(ERROR|WARN)\s+/u, ' ').trim();
        return createLogRecord(levelMatch[1] === 'ERROR' ? 'error' : 'warn', 'launcher', 'nuxt', msg, data);
    }
    if (/\[vite\].*(?:error|Error)|Pre-transform error|Internal server error|error TS\d+/u.test(header)) {
        return createLogRecord('error', 'launcher', 'nuxt', header, data);
    }
    if (NUXT_BUILD_NOISE_PATTERNS.some(pattern => pattern.test(header))) {
        return createLogRecord('debug', 'launcher', 'nuxt', header, data);
    }
    return createLogRecord('debug', 'launcher', 'nuxt', header, data);
}

/**
 * Groups Nuxt's consola output (a header line followed by `├▶ fix:` style
 * continuation lines) and classifies each block. Only warnings, errors and
 * page reloads reach the terminal at the default level.
 */
export function createNuxtOutputRecordStream(onRecord: (record: ILogRecord) => void) {
    const partial: Record<'stdout' | 'stderr', string> = {
        stdout: '',
        stderr: '',
    };
    let block: string[] | null = null;
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const lines = block;
        block = null;
        const record = lines ? classifyNuxtOutputBlock(lines) : null;
        if (record) {
            onRecord(record);
        }
    };
    const handleLine = (rawLine: string) => {
        const line = stripVTControlCharacters(rawLine);
        if (line.trim().length === 0) {
            return;
        }
        if (block && NUXT_CONTINUATION_PATTERN.test(line) && !NUXT_LEVEL_HEADER_PATTERN.test(line)) {
            block.push(line);
            return;
        }
        flush();
        block = [line];
        timer = setTimeout(flush, 50);
        timer.unref?.();
    };
    return {
        write(stream: 'stdout' | 'stderr', chunk: Buffer | string) {
            const text = partial[stream] + chunk.toString();
            const lines = text.split(/\r?\n/u);
            partial[stream] = lines.pop() ?? '';
            lines.forEach(handleLine);
        },
        end() {
            for (const stream of [
                'stdout',
                'stderr',
            ] as const) {
                if (partial[stream]) {
                    handleLine(partial[stream]);
                    partial[stream] = '';
                }
            }
            flush();
        },
    };
}

// ---------------------------------------------------------------------------
// Launcher

/** The launcher's own process start, so every startup record shares one clock. */
const LAUNCHER_STARTED_AT = Date.now();

export function formatLauncherElapsed(startedAt = LAUNCHER_STARTED_AT) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

/** Prints a launcher record (`launcher/<scope>`) in the shared terminal format. */
export function logLauncher(level: TLogLevel, scope: string, msg: string, data?: unknown) {
    printTerminalLogRecord(createLogRecord(level, 'launcher', scope, msg, data));
}
