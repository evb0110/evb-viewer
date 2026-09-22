import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

/**
 * One structured log record shared by every EVB sink: the main-process file
 * log, worker threads, the renderer bridge, the dev launcher terminal, and
 * `electron:run logs`. Producers pass a short message plus a data object;
 * sinks format it. Nothing below the producer stringifies data by hand.
 */
export const LOG_LEVELS = [
    'debug',
    'info',
    'warn',
    'error',
] as const;

export type TLogLevel = typeof LOG_LEVELS[number];

/** The one NDJSON app log inside the Electron log directory. */
export const APP_LOG_FILE_NAME = 'app.ndjson';

/** Which process produced the record. */
export type TLogProcess = 'main' | 'worker' | 'renderer' | 'launcher' | 'electron';

export type TLogData = Record<string, unknown>;

export interface ILogRecord {
    readonly ts: string;
    readonly level: TLogLevel;
    readonly proc: TLogProcess;
    readonly scope: string;
    readonly msg: string;
    readonly data?: TLogData;
    /** Diagnostic event id for an ERROR record that captured a failure. */
    readonly errorId?: string;
    readonly code?: string;
    readonly pid?: number;
    /** Worker thread id for `proc: 'worker'`. */
    readonly thread?: number;
    /** webContents id for `proc: 'renderer'`. */
    readonly window?: number;
}

const LOG_LEVEL_RANK: Record<TLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const LOG_PROCESSES = [
    'main',
    'worker',
    'renderer',
    'launcher',
    'electron',
] as const satisfies readonly TLogProcess[];

export function parseLogLevel(value: unknown): TLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'warning') {
        return 'warn';
    }
    return isOneOf(LOG_LEVELS, normalized) ? normalized : null;
}

export function isLogLevelEnabled(level: TLogLevel, minimum: TLogLevel) {
    return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[minimum];
}

export interface ILogDataLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxStringChars: number;
    readonly maxArrayItems: number;
    readonly maxObjectKeys: number;
}

export const DEFAULT_LOG_DATA_LIMITS: ILogDataLimits = {
    maxDepth: 4,
    maxNodes: 256,
    maxStringChars: 4_000,
    maxArrayItems: 20,
    maxObjectKeys: 40,
};

interface INormalizeState {
    readonly limits: ILogDataLimits;
    remainingNodes: number;
    readonly seen: WeakSet<object>;
}

function clampLogString(value: string, maxChars: number) {
    return value.length <= maxChars
        ? value
        : `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)`;
}

const SERIALIZED_ERROR_KEYS = new Set([
    'name',
    'message',
    'stack',
    'code',
    'cause',
]);

function isErrorLike(value: object): value is {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
    code?: unknown;
} {
    if (value instanceof Error) {
        return true;
    }
    // A serialized error that crossed IPC is a plain {name, message, stack}.
    // Any other key (for example an errorId merged in by BrowserLogger) makes
    // it an ordinary object whose fields must all survive.
    return isRecord(value)
        && typeof value.name === 'string'
        && typeof value.message === 'string'
        && typeof value.stack === 'string'
        && Object.keys(value).every(key => SERIALIZED_ERROR_KEYS.has(key));
}

function normalizeErrorLike(
    value: {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        code?: unknown;
    },
    depth: number,
    state: INormalizeState,
) {
    const normalized: TLogData = {
        name: value.name,
        message: clampLogString(value.message, state.limits.maxStringChars),
    };
    if (typeof value.code === 'string' || typeof value.code === 'number') {
        normalized.code = value.code;
    }
    if (typeof value.stack === 'string') {
        normalized.stack = clampLogString(value.stack, state.limits.maxStringChars);
    }
    if (value.cause !== undefined) {
        normalized.cause = normalizeLogValue(value.cause, depth + 1, state);
    }
    return normalized;
}

function normalizeLogValue(value: unknown, depth: number, state: INormalizeState): unknown {
    if (value === null || value === undefined) {
        return value ?? null;
    }
    switch (typeof value) {
        case 'string':
            return clampLogString(value, state.limits.maxStringChars);
        case 'number':
            return Number.isFinite(value) ? value : String(value);
        case 'boolean':
            return value;
        case 'bigint':
            return `${value.toString()}n`;
        case 'symbol':
            return value.toString();
        case 'function':
            return `[Function ${value.name || 'anonymous'}]`;
        case 'undefined':
            return null;
        case 'object':
            break;
    }

    const objectValue = value;
    if (state.remainingNodes <= 0) {
        return '[Truncated]';
    }
    if (objectValue instanceof Date) {
        return Number.isFinite(objectValue.getTime()) ? objectValue.toISOString() : 'Invalid Date';
    }
    if (objectValue instanceof RegExp) {
        return String(objectValue);
    }
    if (ArrayBuffer.isView(objectValue)) {
        return `[${objectValue.constructor.name}(${objectValue.byteLength})]`;
    }
    if (objectValue instanceof ArrayBuffer) {
        return `[ArrayBuffer(${objectValue.byteLength})]`;
    }
    if (state.seen.has(objectValue)) {
        return '[Circular]';
    }
    if (isErrorLike(objectValue)) {
        state.remainingNodes -= 1;
        state.seen.add(objectValue);
        try {
            return normalizeErrorLike(objectValue, depth, state);
        } finally {
            state.seen.delete(objectValue);
        }
    }
    if (depth >= state.limits.maxDepth) {
        return Array.isArray(objectValue) ? `[Array(${objectValue.length})]` : '[Object]';
    }

    state.remainingNodes -= 1;
    state.seen.add(objectValue);
    try {
        if (Array.isArray(objectValue)) {
            const items = objectValue
                .slice(0, state.limits.maxArrayItems)
                .map(item => normalizeLogValue(item, depth + 1, state));
            if (objectValue.length > state.limits.maxArrayItems) {
                items.push(`[+${objectValue.length - state.limits.maxArrayItems} more]`);
            }
            return items;
        }
        if (objectValue instanceof Map) {
            return normalizeLogValue(Object.fromEntries(objectValue), depth, state);
        }
        if (objectValue instanceof Set) {
            return normalizeLogValue([...objectValue], depth, state);
        }

        const normalized: TLogData = {};
        let keyCount = 0;
        let droppedKeys = 0;
        for (const key of Object.keys(objectValue)) {
            if (keyCount >= state.limits.maxObjectKeys) {
                droppedKeys += 1;
                continue;
            }
            const entry: unknown = Reflect.get(objectValue, key);
            if (entry === undefined) {
                continue;
            }
            normalized[key] = normalizeLogValue(entry, depth + 1, state);
            keyCount += 1;
        }
        if (droppedKeys > 0) {
            normalized['…'] = `+${droppedKeys} keys`;
        }
        return normalized;
    } catch {
        return '[Unreadable]';
    } finally {
        state.seen.delete(objectValue);
    }
}

/**
 * Converts arbitrary caller data into a bounded JSON-safe object. A non-object
 * value is wrapped as `{value}` so every record's `data` has one shape.
 */
export function toLogData(
    value: unknown,
    limits: ILogDataLimits = DEFAULT_LOG_DATA_LIMITS,
): TLogData | undefined {
    if (value === undefined) {
        return undefined;
    }
    const normalized = normalizeLogValue(value, 0, {
        limits,
        remainingNodes: limits.maxNodes,
        seen: new WeakSet<object>(),
    });
    if (isRecord(normalized)) {
        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }
    return {value: normalized};
}

export function decodeLogRecord(line: string): ILogRecord | null {
    if (!line.startsWith('{')) {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.ts !== 'string'
        || typeof value.msg !== 'string'
        || typeof value.scope !== 'string'
        || !isOneOf(LOG_LEVELS, value.level)
        || !isOneOf(LOG_PROCESSES, value.proc)
        || (value.data !== undefined && !isRecord(value.data))
    ) {
        return null;
    }
    const optionalString = (key: 'errorId' | 'code') => (
        typeof value[key] === 'string' ? {[key]: value[key]} : {}
    );
    const optionalInteger = (key: 'pid' | 'thread' | 'window') => (
        Number.isSafeInteger(value[key]) ? {[key]: value[key] as number} : {}
    );
    return {
        ts: value.ts,
        level: value.level,
        proc: value.proc,
        scope: value.scope,
        msg: value.msg,
        ...(isRecord(value.data) ? {data: value.data} : {}),
        ...optionalString('errorId'),
        ...optionalString('code'),
        ...optionalInteger('pid'),
        ...optionalInteger('thread'),
        ...optionalInteger('window'),
    };
}

const BARE_LOG_VALUE_PATTERN = /^[^\s"'=\\]+$/u;

export function formatLogValue(value: unknown): string {
    if (typeof value === 'string') {
        return value.length > 0 && BARE_LOG_VALUE_PATTERN.test(value) ? value : JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return String(value);
    }
    try {
        return JSON.stringify(value) ?? '[Unserializable]';
    } catch {
        return '[Unserializable]';
    }
}

/** Formats data as `key=value` pairs; nested values stay compact JSON. */
export function formatLogData(data: TLogData | undefined, maxChars = Number.POSITIVE_INFINITY) {
    if (!data) {
        return '';
    }
    const text = Object.entries(data)
        .map(([
            key,
            value,
        ]) => `${key}=${formatLogValue(value)}`)
        .join(' ');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function formatLocalClock(ts: string) {
    const date = new Date(ts);
    if (!Number.isFinite(date.getTime())) {
        return ts;
    }
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export interface IFormatLogRecordOptions {
    /** `clock` prints local HH:MM:SS.mmm, `iso` the stored timestamp. */
    readonly time?: 'clock' | 'iso' | 'none';
    readonly maxDataChars?: number;
    readonly decorate?: (part: 'time' | 'level' | 'origin' | 'data', text: string, level: TLogLevel) => string;
}

export function formatLogOrigin(record: Pick<ILogRecord, 'proc' | 'scope' | 'thread' | 'window'>) {
    const processLabel = record.proc === 'worker' && record.thread !== undefined
        ? `worker#${record.thread}`
        : record.proc === 'renderer' && record.window !== undefined
            ? `renderer#${record.window}`
            : record.proc;
    return `${processLabel}/${record.scope}`;
}

/**
 * The one human line format: `time LEVEL proc/scope message key=value …`.
 * Multi-line values such as stacks stay inside JSON strings, so every record
 * is exactly one line.
 */
export function formatLogRecordLine(record: ILogRecord, options: IFormatLogRecordOptions = {}) {
    const decorate = options.decorate ?? ((_part, text) => text);
    const parts: string[] = [];
    if (options.time !== 'none') {
        parts.push(decorate('time', options.time === 'iso' ? record.ts : formatLocalClock(record.ts), record.level));
    }
    parts.push(decorate('level', record.level.toUpperCase().padEnd(5), record.level));
    parts.push(decorate('origin', formatLogOrigin(record), record.level));
    parts.push(record.msg.replace(/\r?\n/gu, ' ⏎ '));
    const trailer: TLogData = {
        ...(record.code ? {code: record.code} : {}),
        ...(record.errorId ? {errorId: record.errorId} : {}),
    };
    const dataText = formatLogData({
        ...record.data,
        ...trailer,
    }, options.maxDataChars);
    if (dataText) {
        parts.push(decorate('data', dataText, record.level));
    }
    return parts.join(' ');
}
