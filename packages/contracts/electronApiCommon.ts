import {
    isFailureCode,
    isFailureEventId,
    type FailureReceipt,
    type FailureSeverity,
} from '@contracts/diagnostics/failureReceipt';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    parseIsoTimestamp,
    type TIsoTimestamp,
} from '@contracts/timestamps';

export type TMenuEventCallback = () => void;

export type TMenuEventUnsubscribe = () => void;

export type TDebugLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type TRendererLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The only identity a main-process ERROR projection may carry.
 * `decodeDebugLogEntry` enforces that this closed object appears only on an
 * ERROR entry. Reference-free ERROR entries are rejected.
 */
export interface IDebugLogFailureRef {
    readonly eventId: string;
    readonly code: string;
    readonly severity: FailureSeverity;
}

interface IDebugLogEntryBase {
    readonly source: string;
    readonly message: string;
    // Keep the ISO string because Electron logger consumers persist this wire shape.
    readonly timestamp: TIsoTimestamp;
}

// Main-process diagnostic logs use the native Electron/logger channel casing.
// The ERROR branch requires a main-owned failure identity. The non-ERROR branch
// makes it impossible to attach one.
export type IDebugLogEntry = IDebugLogEntryBase & (
    | {
        readonly level?: Exclude<TDebugLogLevel, 'ERROR'>;
        readonly failureRef?: never;
    }
    | {
        readonly level: 'ERROR';
        readonly failureRef: IDebugLogFailureRef;
    }
);

const DEBUG_LOG_LEVELS = [
    'DEBUG',
    'INFO',
    'WARN',
    'ERROR',
] as const satisfies readonly TDebugLogLevel[];

const DEBUG_LOG_ENTRY_KEYS = [
    'source',
    'message',
    'timestamp',
    'level',
    'failureRef',
] as const;

const DEBUG_LOG_FAILURE_REF_KEYS = [
    'eventId',
    'code',
    'severity',
] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
    try {
        return Reflect.ownKeys(value).every(key => (
            typeof key === 'string' && allowedKeys.includes(key)
        ));
    } catch {
        return false;
    }
}

function decodeDebugLogFailureRef(value: unknown): IDebugLogFailureRef | null {
    if (!isRecord(value) || !hasOnlyKeys(value, DEBUG_LOG_FAILURE_REF_KEYS)
        || !Object.hasOwn(value, 'eventId')
        || !Object.hasOwn(value, 'code')
        || !Object.hasOwn(value, 'severity')
        || !isFailureEventId(value.eventId)
        || !isFailureCode(value.code)
        || (value.severity !== 'error' && value.severity !== 'fatal')) {
        return null;
    }

    return {
        eventId: value.eventId,
        code: value.code,
        severity: value.severity,
    };
}

/**
 * Decodes the one closed debug-log envelope used by settings and diagnostics.
 * Reference-free ERROR entries are rejected because the renderer must never
 * reinterpret a main-process error as a new occurrence.
 */
export function decodeDebugLogEntry(value: unknown): IDebugLogEntry | null {
    try {
        const timestamp = isRecord(value) ? parseIsoTimestamp(value.timestamp) : null;
        if (!isRecord(value)
            || !hasOnlyKeys(value, DEBUG_LOG_ENTRY_KEYS)
            || typeof value.source !== 'string'
            || typeof value.message !== 'string'
            || timestamp === null
            || (value.level !== undefined && !isOneOf(DEBUG_LOG_LEVELS, value.level))) {
            return null;
        }

        if (value.failureRef === undefined) {
            if (value.level === 'ERROR') {
                return null;
            }
            return {
                source: value.source,
                message: value.message,
                timestamp,
                ...(value.level === undefined ? {} : {level: value.level}),
            };
        }

        // A reference without an explicit ERROR level cannot be proven to be a
        // main-owned failure.
        if (value.level !== 'ERROR') {
            return null;
        }
        const failureRef = decodeDebugLogFailureRef(value.failureRef);
        if (failureRef === null) {
            return null;
        }

        return {
            source: value.source,
            message: value.message,
            timestamp,
            level: 'ERROR',
            failureRef,
        };
    } catch {
        return null;
    }
}

export interface IRendererLogEntry {
    // Renderer logs mirror BrowserLogger casing before they are bridged to main.
    readonly level: TRendererLogLevel;
    readonly section: string;
    readonly message: string;
    // Keep the ISO string because renderer log entries cross the logger bridge unchanged.
    readonly timestamp: TIsoTimestamp;
    readonly data?: unknown;
    readonly failureRef?: FailureReceipt;
}
