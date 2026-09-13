import { isMainThread } from 'worker_threads';
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
import {
    dirname,
    join,
} from 'path';
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

interface ILogMessage {
    source: string;
    message: string;
    timestamp: string;
    level: TLogLevel;
    failureRef?: IFailureRef;
}

interface IFailureRef {
    eventId: FailureReceipt['eventId'];
    code: FailureReceipt['code'];
    severity: FailureReceipt['severity'];
}

export interface ILogger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error<C extends DiagnosticCode = DiagnosticCode>(
        msg: string,
        failure: FailureReceipt | ILoggerFailureInput<C>,
    ): FailureReceipt | undefined;
}

export type ILoggerFailureInput<C extends DiagnosticCode = DiagnosticCode> = Pick<
    CaptureFailureInput<C>,
    'code' | 'severity' | 'operation' | 'context'
> & {cause?: unknown;};

interface ILoggerOptions {broadcastToRenderers?: boolean;}

interface IFileLogState {
    source: string;
    queue: Promise<void>;
    initialized: boolean;
    approximateBytes: number;
    pendingWrites: number;
    droppedWrites: number;
    buffer: string[];
    bufferBytes: number;
    flushTimer: NodeJS.Timeout | null;
}

type TLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<TLogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
};

const IS_PACKAGED_RUNTIME = !process.execPath.toLowerCase().includes('node_modules');
const FILE_LOG_LEVEL = normalizeLogLevel(process.env.ELECTRON_FILE_LOG_LEVEL)
    ?? (IS_PACKAGED_RUNTIME ? 'INFO' : 'DEBUG');
const RENDER_LOG_LEVEL = normalizeLogLevel(process.env.ELECTRON_RENDER_LOG_LEVEL)
    ?? 'WARN';
const LOG_FILE_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_MAX_BYTES ?? `${5 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 256 * 1024) {
        return 5 * 1024 * 1024;
    }
    return Math.min(parsed, 256 * 1024 * 1024);
})();
const LOG_FILE_MAX_BACKUPS = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_MAX_BACKUPS ?? '3', 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 3;
    }
    return Math.min(parsed, 16);
})();
const LOG_DIR_MAX_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_DIR_MAX_BYTES ?? `${64 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024 * 1024) {
        return 64 * 1024 * 1024;
    }
    return Math.min(parsed, 2 * 1024 * 1024 * 1024);
})();
const LOG_WRITE_QUEUE_MAX_PENDING = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_QUEUE_MAX_PENDING ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 2_000;
    }
    return Math.min(parsed, 100_000);
})();
const LOG_WRITE_FLUSH_INTERVAL_MS = 100;
const LOG_WRITE_FLUSH_BYTES = 8 * 1024;
const LOG_DIR_PRUNE_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_FILE_LOG_DIR_PRUNE_INTERVAL_MS ?? `${60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 60 * 1_000;
    }
    return parsed;
})();

const LOG_DIR = process.env.EVB_FILE_LOG_DIR ?? join(tmpdir(), 'electron-logs');
const fileLogStates = new Map<string, IFileLogState>();
let logDirPruneLastAt = 0;
let logDirPrunePromise: Promise<void> | null = null;

function normalizeLogLevel(value: unknown): TLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toUpperCase();
    if (normalized === 'DEBUG' || normalized === 'INFO' || normalized === 'WARN' || normalized === 'ERROR') {
        return normalized;
    }

    return null;
}

function shouldLog(level: TLogLevel, minLevel: TLogLevel) {
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

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

function ensureState(logFile: string, source: string): IFileLogState {
    const existingState = fileLogStates.get(logFile);
    if (existingState) {
        return existingState;
    }

    const nextState: IFileLogState = {
        source,
        queue: Promise.resolve(),
        initialized: false,
        approximateBytes: 0,
        pendingWrites: 0,
        droppedWrites: 0,
        buffer: [],
        bufferBytes: 0,
        flushTimer: null,
    };
    fileLogStates.set(logFile, nextState);
    return nextState;
}

async function initializeState(logFile: string, state: IFileLogState) {
    if (state.initialized) {
        return;
    }
    state.initialized = true;

    try {
        await appendFile(logFile, '', 'utf8');
    } catch {
        // Ignore initialization failures, writes will keep retrying.
    }

    try {
        const fileStat = statSync(logFile);
        state.approximateBytes = fileStat.size;
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

        let totalBytes = sumBy(files, file => file.size);
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
                fileLogStates.delete(file.path);
            } catch {
                // Ignore cleanup failures and continue pruning.
            }
        }
    })().finally(() => {
        logDirPrunePromise = null;
    });

    return logDirPrunePromise;
}

function flushState(logFile: string, state: IFileLogState) {
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
            await initializeState(logFile, state);

            const linesToWrite: string[] = [];
            if (state.droppedWrites > 0) {
                linesToWrite.push(
                    `[${new Date().toISOString()}] [${state.source}] [WARN] `
                    + `Dropped ${state.droppedWrites} buffered log message(s) due to logger backpressure`,
                );
                state.droppedWrites = 0;
            }
            linesToWrite.push(...bufferedLines);
            const payload = `${linesToWrite.join('\n')}\n`;
            const payloadBytes = Buffer.byteLength(payload, 'utf8');

            if (state.approximateBytes + payloadBytes > LOG_FILE_MAX_BYTES) {
                await rotateFile(logFile);
                state.approximateBytes = 0;
            }

            await appendFile(logFile, payload, 'utf8');
            state.approximateBytes += payloadBytes;
        })
        .catch(() => {
            // Avoid throwing from logger writes.
        })
        .finally(() => {
            state.pendingWrites = Math.max(0, state.pendingWrites - bufferedLines.length);
        });
    void state.queue.then(() => {
        void pruneLogDirectory().catch(() => undefined);
    });

    return state.queue;
}

function enqueueWrite(
    source: string,
    logFile: string,
    line: string,
    level: TLogLevel,
) {
    const state = ensureState(logFile, source);
    if (state.pendingWrites >= LOG_WRITE_QUEUE_MAX_PENDING) {
        state.droppedWrites += 1;
        return;
    }
    state.pendingWrites += 1;
    state.buffer.push(line);
    state.bufferBytes += Buffer.byteLength(line, 'utf8') + 1;

    // Errors are the lines most likely to be needed after a crash, so they never wait
    // on the coalescing window.
    if (level === 'ERROR' || state.bufferBytes >= LOG_WRITE_FLUSH_BYTES) {
        void flushState(logFile, state);
        return;
    }
    if (state.flushTimer) {
        return;
    }
    state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void flushState(logFile, state);
    }, LOG_WRITE_FLUSH_INTERVAL_MS);
    state.flushTimer.unref();
}

/**
 * Drains every buffered and in-flight log write. Shutdown must await this before the
 * process exits, otherwise coalesced lines are lost.
 */
export async function flushPendingLogWrites() {
    await Promise.all([...fileLogStates].map(
        ([
            logFile,
            state,
        ]) => flushState(logFile, state).catch(() => undefined),
    ));
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

export function createLogger(source: string, options: ILoggerOptions = {}): ILogger {
    const logFile = join(LOG_DIR, `${source}.log`);
    const broadcastToRenderersEnabled = options.broadcastToRenderers ?? true;

    try {
        mkdirSync(dirname(logFile), { recursive: true });
    } catch {
        // Ignore
    }

    function log(level: TLogLevel, msg: string, failureRef?: IFailureRef) {
        const ts = new Date().toISOString();
        const redactedMsg = redactElectronLogText(msg);
        const formattedMsg = `[${ts}] [${source}] [${level}] ${redactedMsg}`;

        if (shouldLog(level, FILE_LOG_LEVEL)) {
            enqueueWrite(source, logFile, formattedMsg, level);
        }

        const canBroadcast = level !== 'ERROR' || (isMainThread && failureRef !== undefined);
        if (broadcastToRenderersEnabled && canBroadcast && shouldLog(level, RENDER_LOG_LEVEL)) {
            void broadcastToRenderers({
                source,
                message: `[${level}] ${redactedMsg}`,
                timestamp: ts,
                level,
                ...(level === 'ERROR' && isMainThread && failureRef ? {failureRef} : {}),
            });
        }
    }

    return {
        debug: (msg) => log('DEBUG', msg),
        info: (msg) => log('INFO', msg),
        warn: (msg) => log('WARN', msg),
        error: (msg, existingReceipt) => {
            if (!isMainThread) {
                log('ERROR', msg);
                return undefined;
            }

            const reporter = getMainFailureReporter();
            const receipt = isFailureReceipt(existingReceipt)
                ? existingReceipt
                : reporter ? captureMainLoggerFailure(source, msg, existingReceipt) : undefined;
            log('ERROR', msg, toFailureRef(receipt));
            return receipt;
        },
    };
}

void pruneLogDirectory(true).catch(() => {});
