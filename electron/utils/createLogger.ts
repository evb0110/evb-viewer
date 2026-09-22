import {
    isMainThread,
    threadId,
} from 'worker_threads';
import { tmpdir } from 'os';
import {
    mkdirSync,
    statSync,
} from 'fs';
import {
    appendFile,
    readdir,
    rename,
    rm,
} from 'fs/promises';
import { join } from 'path';
import { sortBy } from 'es-toolkit/array';
import { sumBy } from 'es-toolkit/math';
import {
    decodeDiagnosticContext,
    isDiagnosticCode,
    isDiagnosticOperation,
    type DiagnosticCode,
} from '@contracts/diagnostics/diagnosticCodes';
import {isDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {
    FAILURE_SEVERITIES,
    type FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import {
    getFailureReceipt,
    type CaptureFailureInput,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {getMainFailureReporter} from '@electron/features/diagnostics/public';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import { redactElectronLogText } from '@electron/utils/redactElectronLogText';
import {
    APP_LOG_FILE_NAME,
    formatLogData,
    isLogLevelEnabled,
    parseLogLevel,
    toLogData,
    type ILogRecord,
    type TLogData,
    type TLogLevel,
    type TLogProcess,
} from '@contracts/logRecord';

interface ILogMessage {
    source: string;
    message: string;
    timestamp: string;
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    failureRef?: IFailureRef;
}

interface IFailureRef {
    eventId: FailureReceipt['eventId'];
    code: FailureReceipt['code'];
    severity: FailureReceipt['severity'];
}

/**
 * Main-process and worker logger. `msg` is a short, stable sentence; variable
 * details belong in `data`, which every sink formats the same way. Do not
 * interpolate JSON into `msg`.
 */
export interface ILogger {
    debug(msg: string, data?: unknown): void;
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error<C extends DiagnosticCode = DiagnosticCode>(
        msg: string,
        failure: FailureReceipt | ILoggerFailureInput<C>,
        data?: unknown,
    ): FailureReceipt | undefined;
}

export type ILoggerFailureInput<C extends DiagnosticCode = DiagnosticCode> = Pick<
    CaptureFailureInput<C>,
    'code' | 'severity' | 'operation' | 'context'
> & {cause?: unknown;};

interface ILoggerOptions {broadcastToRenderers?: boolean;}

interface IFileLogState {
    queue: Promise<void>;
    initialized: boolean;
    approximateBytes: number;
    pendingWrites: number;
    droppedWrites: number;
    buffer: string[];
    bufferBytes: number;
    flushTimer: NodeJS.Timeout | null;
}

function readIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return Math.min(parsed, maximum);
}

const IS_PACKAGED_RUNTIME = !process.execPath.toLowerCase().includes('node_modules');
const FILE_LOG_LEVEL: TLogLevel = parseLogLevel(process.env.ELECTRON_FILE_LOG_LEVEL)
    ?? (IS_PACKAGED_RUNTIME ? 'info' : 'debug');
const RENDER_LOG_LEVEL: TLogLevel = parseLogLevel(process.env.ELECTRON_RENDER_LOG_LEVEL) ?? 'warn';
/**
 * `EVB_LOG_STDOUT=ndjson` mirrors records to stdout as NDJSON. The dev
 * launcher sets it and formats the stream, which is how main-process and
 * worker records reach the `pnpm dev` terminal.
 */
const STDOUT_LOG_ENABLED = process.env.EVB_LOG_STDOUT === 'ndjson';
const STDOUT_LOG_LEVEL: TLogLevel = parseLogLevel(process.env.EVB_LOG_STDOUT_LEVEL) ?? 'info';
const LOG_FILE_MAX_BYTES = readIntegerEnv('EVB_FILE_LOG_MAX_BYTES', 16 * 1024 * 1024, 256 * 1024, 256 * 1024 * 1024);
const LOG_FILE_MAX_BACKUPS = readIntegerEnv('EVB_FILE_LOG_MAX_BACKUPS', 3, 0, 16);
const LOG_DIR_MAX_BYTES = readIntegerEnv('EVB_FILE_LOG_DIR_MAX_BYTES', 96 * 1024 * 1024, 1024 * 1024, 2 * 1024 * 1024 * 1024);
const LOG_WRITE_QUEUE_MAX_PENDING = readIntegerEnv('EVB_FILE_LOG_QUEUE_MAX_PENDING', 4_000, 64, 100_000);
const LOG_WRITE_FLUSH_INTERVAL_MS = 100;
const LOG_WRITE_FLUSH_BYTES = 16 * 1024;
const LOG_DIR_PRUNE_INTERVAL_MS = readIntegerEnv('EVB_FILE_LOG_DIR_PRUNE_INTERVAL_MS', 60 * 1_000, 5_000, Number.MAX_SAFE_INTEGER);

const LOG_DIR = process.env.EVB_FILE_LOG_DIR ?? join(tmpdir(), 'electron-logs');
/**
 * Every source, thread and the renderer bridge append to this one timeline.
 * Only the main thread rotates it; workers append to whatever file currently
 * owns the path.
 */
const APP_LOG_FILE = join(LOG_DIR, APP_LOG_FILE_NAME);
const fileLogState: IFileLogState = {
    queue: Promise.resolve(),
    initialized: false,
    approximateBytes: 0,
    pendingWrites: 0,
    droppedWrites: 0,
    buffer: [],
    bufferBytes: 0,
    flushTimer: null,
};
// Read lazily: importing the logger must not touch worker_threads state.
function processKind(): TLogProcess {
    return isMainThread ? 'main' : 'worker';
}
let logDirPruneLastAt = 0;
let logDirPrunePromise: Promise<void> | null = null;
let stdoutMirrorBroken = false;
let sessionStartWritten = false;

try {
    mkdirSync(LOG_DIR, { recursive: true });
} catch {
    // Ignore if already exists
}

async function broadcastToRenderers(data: ILogMessage) {
    if (!isMainThread) {
        return;
    }

    try {
        const { BrowserWindow } = await import('electron');
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(CORE_IPC_EVENT_CHANNELS.debugLog, data);
            }
        }
    } catch {
        // Silently ignore IPC errors in edge cases
    }
}

async function initializeState(state: IFileLogState) {
    if (state.initialized) {
        return;
    }
    state.initialized = true;

    try {
        await appendFile(APP_LOG_FILE, '', 'utf8');
    } catch {
        // Ignore initialization failures, writes will keep retrying.
    }

    try {
        state.approximateBytes = statSync(APP_LOG_FILE).size;
    } catch {
        state.approximateBytes = 0;
    }
}

async function rotateFile(logFile: string) {
    if (LOG_FILE_MAX_BACKUPS <= 0) {
        try {
            await rm(logFile, { force: true });
        } catch {
            // Ignore cleanup failures.
        }
        return;
    }

    for (let index = LOG_FILE_MAX_BACKUPS; index >= 1; index -= 1) {
        const source = index === 1
            ? logFile
            : `${logFile}.${index - 1}`;
        const destination = `${logFile}.${index}`;

        try {
            await rm(destination, { force: true });
        } catch {
            // Ignore destination cleanup failures.
        }

        try {
            await rename(source, destination);
        } catch {
            // Ignore missing source entries.
        }
    }
}

async function pruneLogDirectory(force = false) {
    const now = Date.now();
    if (!force && now - logDirPruneLastAt < LOG_DIR_PRUNE_INTERVAL_MS) {
        return;
    }
    logDirPruneLastAt = now;

    if (logDirPrunePromise) {
        return logDirPrunePromise;
    }

    logDirPrunePromise = (async () => {
        interface IFileEntry {
            path: string;
            size: number;
            mtimeMs: number;
        }

        let entries: string[] = [];
        try {
            entries = await readdir(LOG_DIR);
        } catch {
            return;
        }

        const files: IFileEntry[] = [];
        for (const entry of entries) {
            const filePath = join(LOG_DIR, entry);
            if (filePath === APP_LOG_FILE) {
                continue;
            }
            try {
                const fileStat = statSync(filePath);
                if (!fileStat.isFile()) {
                    continue;
                }
                files.push({
                    path: filePath,
                    size: fileStat.size,
                    mtimeMs: fileStat.mtimeMs,
                });
            } catch {
                // Ignore files disappearing while pruning.
            }
        }

        let totalBytes = sumBy(files, file => file.size) + fileLogState.approximateBytes;
        if (totalBytes <= LOG_DIR_MAX_BYTES) {
            return;
        }

        for (const file of sortBy(files, ['mtimeMs'])) {
            if (totalBytes <= LOG_DIR_MAX_BYTES) {
                break;
            }

            try {
                await rm(file.path, { force: true });
                totalBytes -= file.size;
            } catch {
                // Ignore cleanup failures and continue pruning.
            }
        }
    })().finally(() => {
        logDirPrunePromise = null;
    });

    return logDirPrunePromise;
}

function createDroppedWritesRecord(droppedWrites: number) {
    return JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        proc: processKind(),
        scope: 'logger',
        msg: 'Dropped buffered log records due to logger backpressure',
        data: {droppedWrites},
        pid: process.pid,
        ...(isMainThread ? {} : {thread: threadId}),
    } satisfies ILogRecord);
}

function flushState(state: IFileLogState) {
    if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
    }
    // droppedWrites can be pending with an empty buffer when every dropped
    // line arrived while the previous batch was in flight; the warning must
    // still reach the file on the final flush.
    if (state.buffer.length === 0 && state.droppedWrites === 0) {
        return state.queue;
    }

    const bufferedLines = state.buffer;
    state.buffer = [];
    state.bufferBytes = 0;

    state.queue = state.queue
        .then(async () => {
            await initializeState(state);

            const linesToWrite: string[] = [];
            if (state.droppedWrites > 0) {
                linesToWrite.push(createDroppedWritesRecord(state.droppedWrites));
                state.droppedWrites = 0;
            }
            linesToWrite.push(...bufferedLines);
            const payload = `${linesToWrite.join('\n')}\n`;
            const payloadBytes = Buffer.byteLength(payload, 'utf8');

            if (isMainThread && state.approximateBytes + payloadBytes > LOG_FILE_MAX_BYTES) {
                // Workers append to the same file, so re-read the real size
                // before deciding to rotate.
                try {
                    state.approximateBytes = statSync(APP_LOG_FILE).size;
                } catch {
                    state.approximateBytes = 0;
                }
                if (state.approximateBytes + payloadBytes > LOG_FILE_MAX_BYTES) {
                    await rotateFile(APP_LOG_FILE);
                    state.approximateBytes = 0;
                }
            }

            await appendFile(APP_LOG_FILE, payload, 'utf8');
            state.approximateBytes += payloadBytes;
        })
        .catch(() => {
            // Avoid throwing from logger writes.
        })
        .finally(() => {
            state.pendingWrites = Math.max(0, state.pendingWrites - bufferedLines.length);
        });
    if (isMainThread) {
        void state.queue.then(() => {
            void pruneLogDirectory().catch(() => undefined);
        });
    }

    return state.queue;
}

function enqueueWrite(line: string, level: TLogLevel) {
    const state = fileLogState;
    if (state.pendingWrites >= LOG_WRITE_QUEUE_MAX_PENDING) {
        state.droppedWrites += 1;
        return;
    }
    state.pendingWrites += 1;
    state.buffer.push(line);
    state.bufferBytes += Buffer.byteLength(line, 'utf8') + 1;

    // Errors are the lines most likely to be needed after a crash, so they never wait
    // on the coalescing window.
    if (level === 'error' || state.bufferBytes >= LOG_WRITE_FLUSH_BYTES) {
        void flushState(state);
        return;
    }
    if (state.flushTimer) {
        return;
    }
    state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void flushState(state);
    }, LOG_WRITE_FLUSH_INTERVAL_MS);
    state.flushTimer.unref();
}

function writeStdoutMirror(line: string) {
    if (stdoutMirrorBroken) {
        return;
    }
    try {
        process.stdout.write(`${line}\n`);
    } catch {
        stdoutMirrorBroken = true;
    }
}

if (STDOUT_LOG_ENABLED) {
    // The launcher may exit before Electron. A closed pipe must disable the
    // mirror, not surface as an uncaught EPIPE in the main process.
    process.stdout.on?.('error', () => {
        stdoutMirrorBroken = true;
    });
}

/**
 * Drains every buffered and in-flight log write. Shutdown must await this before the
 * process exits, otherwise coalesced lines are lost.
 */
export async function flushPendingLogWrites() {
    await flushState(fileLogState).catch(() => undefined);
}

/** Redacts data with the one Electron redaction policy, keeping its structure. */
export function redactLogData(data: TLogData | undefined): TLogData | undefined {
    if (!data) {
        return undefined;
    }
    let serialized: string;
    try {
        serialized = JSON.stringify(data);
    } catch {
        return {value: '[Unserializable]'};
    }
    const redacted = redactElectronLogText(serialized);
    if (redacted === serialized) {
        return data;
    }
    try {
        const parsed: unknown = JSON.parse(redacted);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as TLogData
            : {value: redacted};
    } catch {
        return {value: redacted};
    }
}

/** `stdout: false` keeps a record out of the stdout mirror (the launcher already sees it). */
export interface IWriteLogRecordOptions {readonly stdout?: boolean;}

/**
 * Normalizes, redacts and writes one record to the app log and, when enabled,
 * the stdout mirror. Level filtering for each sink happens here.
 */
export function writeLogRecord(
    input: Omit<ILogRecord, 'ts' | 'pid' | 'data'> & {
        ts?: string;
        data?: unknown;
    },
    options: IWriteLogRecordOptions = {},
): ILogRecord | null {
    const toFile = isLogLevelEnabled(input.level, FILE_LOG_LEVEL);
    const toStdout = STDOUT_LOG_ENABLED
        && options.stdout !== false
        && isLogLevelEnabled(input.level, STDOUT_LOG_LEVEL);
    if (!toFile && !toStdout) {
        return null;
    }

    const data = redactLogData(toLogData(input.data));
    const record: ILogRecord = {
        ts: input.ts ?? new Date().toISOString(),
        level: input.level,
        proc: input.proc,
        scope: input.scope,
        msg: redactElectronLogText(input.msg),
        ...(data ? {data} : {}),
        ...(input.errorId ? {errorId: input.errorId} : {}),
        ...(input.code ? {code: input.code} : {}),
        pid: process.pid,
        ...(input.thread === undefined ? {} : {thread: input.thread}),
        ...(input.window === undefined ? {} : {window: input.window}),
    };
    ensureSessionStartRecord();
    const line = JSON.stringify(record);
    if (toFile) {
        enqueueWrite(line, record.level);
    }
    if (toStdout) {
        writeStdoutMirror(line);
    }
    return record;
}

/**
 * One marker per process start, so a log that spans many runs still shows
 * where each run began.
 */
function ensureSessionStartRecord() {
    if (sessionStartWritten || !isMainThread) {
        return;
    }
    sessionStartWritten = true;
    void pruneLogDirectory(true).catch(() => {});
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        proc: 'main',
        scope: 'logger',
        msg: 'Log session started',
        data: {
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron ?? null,
            node: process.versions.node,
            packaged: IS_PACKAGED_RUNTIME,
            fileLevel: FILE_LOG_LEVEL,
        },
        pid: process.pid,
    } satisfies ILogRecord);
    enqueueWrite(line, 'info');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function isFailureReceipt(value: unknown): value is FailureReceipt {
    try {
        return value !== undefined
            && typeof value === 'object'
            && value !== null
            && isDiagnosticEventId((value as FailureReceipt).eventId)
            && isDiagnosticCode((value as FailureReceipt).code)
            && FAILURE_SEVERITIES.includes((value as FailureReceipt).severity)
            && Number.isSafeInteger((value as FailureReceipt).occurredAt)
            && (value as FailureReceipt).occurredAt >= 0;
    } catch {
        return false;
    }
}

function toFailureRef(receipt: FailureReceipt | undefined): IFailureRef | undefined {
    if (!isFailureReceipt(receipt)) {
        return undefined;
    }
    return {
        eventId: receipt.eventId,
        code: receipt.code,
        severity: receipt.severity,
    };
}

function decodeLoggerFailureInput(value: unknown): ILoggerFailureInput | undefined {
    if (!isPlainRecord(value) || !isDiagnosticCode(value.code)) {
        return undefined;
    }
    if (
        value.severity !== undefined
        && !FAILURE_SEVERITIES.includes(value.severity as FailureSeverity)
    ) {
        return undefined;
    }
    if (
        value.operation !== undefined
        && !isDiagnosticOperation(value.operation)
    ) {
        return undefined;
    }
    return value as ILoggerFailureInput;
}

function getFailureReceiptFromCause(cause: unknown) {
    try {
        return getFailureReceipt(cause);
    } catch {
        return undefined;
    }
}

function captureMainLoggerFailure<C extends DiagnosticCode>(
    source: string,
    message: string,
    failureInput: ILoggerFailureInput<C>,
) {
    if (!isMainThread) {
        return undefined;
    }

    const reporter = getMainFailureReporter();
    if (!reporter) {
        return undefined;
    }

    const decodedInput = decodeLoggerFailureInput(failureInput);
    if (!decodedInput) {
        return undefined;
    }
    const inheritedReceipt = getFailureReceiptFromCause(decodedInput.cause);
    if (inheritedReceipt) {
        return inheritedReceipt;
    }

    let callSiteStack = '';
    try {
        callSiteStack = new Error().stack ?? '';
    } catch {
        // The reporter still returns a valid receipt without a stack.
    }

    try {
        return reporter.capture({
            code: decodedInput.code,
            ...(decodedInput.severity === undefined ? {} : {severity: decodedInput.severity}),
            operation: decodedInput.operation ?? 'main-error',
            context: decodeDiagnosticContext(decodedInput.code, decodedInput.context) ?? {},
            local: {
                source,
                message,
                cause: decodedInput.cause ?? callSiteStack,
            },
        });
    } catch {
        return undefined;
    }
}


function toFailureData(failure: unknown, data: unknown) {
    const cause = isPlainRecord(failure) && !isFailureReceipt(failure) ? failure.cause : undefined;
    if (cause === undefined) {
        return data;
    }
    if (data === undefined) {
        return {cause};
    }
    return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? {
            ...data,
            cause,
        }
        : {
            value: data,
            cause,
        };
}

function toDebugLogLevel(level: TLogLevel): ILogMessage['level'] {
    switch (level) {
        case 'debug': return 'DEBUG';
        case 'info': return 'INFO';
        case 'warn': return 'WARN';
        case 'error': return 'ERROR';
    }
}

export function createLogger(source: string, options: ILoggerOptions = {}): ILogger {
    const broadcastToRenderersEnabled = options.broadcastToRenderers ?? true;

    function log(level: TLogLevel, msg: string, data: unknown, failureRef?: IFailureRef) {
        const record = writeLogRecord({
            level,
            proc: processKind(),
            scope: source,
            msg,
            data,
            ...(isMainThread ? {} : {thread: threadId}),
            ...(failureRef ? {
                errorId: failureRef.eventId,
                code: failureRef.code,
            } : {}),
        });

        const canBroadcast = level !== 'error' || (isMainThread && failureRef !== undefined);
        if (broadcastToRenderersEnabled && canBroadcast && isLogLevelEnabled(level, RENDER_LOG_LEVEL)) {
            // The broadcast has its own level; a record the file and stdout
            // sinks skipped still carries its (redacted) data here.
            const dataText = formatLogData(record ? record.data : redactLogData(toLogData(data)), 2_000);
            void broadcastToRenderers({
                source,
                message: `[${level.toUpperCase()}] ${record?.msg ?? redactElectronLogText(msg)}${dataText ? ` ${dataText}` : ''}`,
                timestamp: record?.ts ?? new Date().toISOString(),
                level: toDebugLogLevel(level),
                ...(level === 'error' && isMainThread && failureRef ? {failureRef} : {}),
            });
        }
    }

    return {
        debug: (msg, data) => log('debug', msg, data),
        info: (msg, data) => log('info', msg, data),
        warn: (msg, data) => log('warn', msg, data),
        error: (msg, existingReceipt, data) => {
            const recordData = toFailureData(existingReceipt, data);
            if (!isMainThread) {
                log('error', msg, recordData);
                return undefined;
            }

            const reporter = getMainFailureReporter();
            const receipt = isFailureReceipt(existingReceipt)
                ? existingReceipt
                : reporter ? captureMainLoggerFailure(source, msg, existingReceipt) : undefined;
            log('error', msg, recordData, toFailureRef(receipt));
            return receipt;
        },
    };
}
