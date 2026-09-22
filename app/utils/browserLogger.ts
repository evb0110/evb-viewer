import { getErrorMessage } from '@app/utils/error';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import type { IRendererLogEntry } from '@contracts/electronApiCommon';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {decodeFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {
    DiagnosticCode,
    DiagnosticContext,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    captureRendererFailure,
    initializeRendererFailureReporter,
} from '@app/utils/failureReporter';
import { createIsoTimestamp } from '@contracts/timestamps';

type TBrowserLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type TEmitLogLevel = Exclude<TBrowserLogLevel, 'silent'>;
type TLazyValue = unknown | (() => unknown);

interface IBrowserLoggerErrorOptions<C extends DiagnosticCode> {
    code: C;
    context: DiagnosticContext<C>;
}

const ORIGINAL_CONSOLE_SINKS = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
};

const LOG_LEVELS: Record<TBrowserLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};

function normalizeLogLevel(value: unknown): TBrowserLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
        normalized === 'debug'
        || normalized === 'info'
        || normalized === 'warn'
        || normalized === 'error'
        || normalized === 'silent'
    ) {
        return normalized;
    }

    return null;
}

// Development keeps info records so the app log explains what happened before
// a warning; packaged builds forward warnings and errors only.
const DEFAULT_LOG_LEVEL: TBrowserLogLevel = import.meta.dev ? 'info' : 'warn';
const THROTTLED_LOG_STATE = new Map<string, {
    lastAtMs: number;
    suppressedCount: number;
}>();
const MAX_THROTTLED_LOG_STATE_ENTRIES = 512;

const configuredLogLevel = (() => {
    if (typeof window === 'undefined') {
        return DEFAULT_LOG_LEVEL;
    }

    try {
        const fromStorage = normalizeLogLevel(window.localStorage.getItem(STORAGE_KEYS.LOG_LEVEL));
        if (fromStorage) {
            return fromStorage;
        }
    } catch {
        // Ignore localStorage errors (privacy mode / disabled storage)
    }

    const maybeGlobal = normalizeLogLevel((window as Window & {__logLevel?: unknown;}).__logLevel);
    if (maybeGlobal) {
        return maybeGlobal;
    }

    return DEFAULT_LOG_LEVEL;
})();

function shouldLog(level: TBrowserLogLevel) {
    return LOG_LEVELS[level] >= LOG_LEVELS[configuredLogLevel];
}

function isDiagnosticWarnForced() {
    if (typeof window === 'undefined') {
        return false;
    }

    const forceWarningMode = (window as Window & {__diagnosticWarnAsWarn?: boolean;}).__diagnosticWarnAsWarn;
    return forceWarningMode === true;
}

function isPdfNavConsoleDiagnosticEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    return (window as Window & {__pdfNavLogConsole?: boolean;}).__pdfNavLogConsole === true;
}

function hasElectronRendererBridge() {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        const electronAPI: unknown = Reflect.get(window, 'electronAPI');
        return electronAPI !== null && typeof electronAPI === 'object';
    } catch {
        return false;
    }
}

function serializeForRendererLog(value: unknown) {
    if (value === undefined) {
        return undefined;
    }

    try {
        const serialized = JSON.stringify(value, (_key, currentValue) => {
            if (currentValue instanceof Error) {
                return {
                    name: currentValue.name,
                    message: getErrorMessage(currentValue),
                    stack: currentValue.stack,
                };
            }

            if (typeof currentValue === 'bigint') {
                return currentValue.toString();
            }

            const normalizedValue: unknown = currentValue;
            return normalizedValue;
        });
        const parsed: unknown = JSON.parse(serialized);
        return parsed;
    } catch {
        if (typeof value === 'object' && value !== null) {
            return '[unserializable object]';
        }
        const serializedValue: unknown = JSON.stringify(value);
        return typeof serializedValue === 'string'
            ? serializedValue
            : '<unserializable value>';
    }
}

function forwardToMain(entry: IRendererLogEntry) {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        const electronAPI: unknown = Reflect.get(window, 'electronAPI');
        const settings: unknown = typeof electronAPI === 'object' && electronAPI !== null
            ? Reflect.get(electronAPI, 'settings')
            : null;
        const rendererLog = getOptionalFunction<[IRendererLogEntry]>(settings, 'rendererLog');
        if (rendererLog) {
            rendererLog.call(settings, entry);
        }
    } catch {
        // Ignore IPC bridge failures in browser logger
    }
}

function resolveLazyValue(value: TLazyValue | undefined) {
    return typeof value === 'function'
        ? (value as () => unknown)()
        : value;
}

function isFailureReceipt(value: unknown): value is FailureReceipt {
    return decodeFailureReceipt(value) !== null;
}

function takeThrottledLogSuppressionCount(
    section: string,
    key: string,
    intervalMs: number,
) {
    const compositeKey = `${section}:${key}`;
    const nowMs = Date.now();
    const state = THROTTLED_LOG_STATE.get(compositeKey);
    if (!state) {
        THROTTLED_LOG_STATE.set(compositeKey, {
            lastAtMs: nowMs,
            suppressedCount: 0,
        });
        if (THROTTLED_LOG_STATE.size > MAX_THROTTLED_LOG_STATE_ENTRIES) {
            let deleted = 0;
            for (const [mapKey] of THROTTLED_LOG_STATE) {
                THROTTLED_LOG_STATE.delete(mapKey);
                deleted += 1;
                if (deleted >= 64) {
                    break;
                }
            }
        }
        return {
            allowed: true,
            suppressedCount: 0,
            compositeKey,
        };
    }

    if (nowMs - state.lastAtMs < Math.max(1, intervalMs)) {
        state.suppressedCount += 1;
        THROTTLED_LOG_STATE.set(compositeKey, state);
        return {
            allowed: false,
            suppressedCount: state.suppressedCount,
            compositeKey,
        };
    }

    const suppressedCount = state.suppressedCount;
    state.lastAtMs = nowMs;
    state.suppressedCount = 0;
    THROTTLED_LOG_STATE.set(compositeKey, state);
    return {
        allowed: true,
        suppressedCount,
        compositeKey,
    };
}

function enrichThrottledPayload(
    resolved: unknown,
    suppressedCount: number,
    intervalMs: number,
    key: string,
) {
    if (suppressedCount <= 0) {
        return resolved;
    }

    if (
        typeof resolved === 'object'
        && resolved !== null
        && !Array.isArray(resolved)
    ) {
        return {
            ...resolved,
            throttledSuppressedCount: suppressedCount,
            throttledIntervalMs: intervalMs,
            throttledKey: key,
        };
    }

    return {
        value: resolved,
        throttledSuppressedCount: suppressedCount,
        throttledIntervalMs: intervalMs,
        throttledKey: key,
    };
}

function withErrorId(resolved: unknown, errorId: string) {
    return typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)
        ? {
            ...resolved,
            errorId,
        }
        : {
            ...(resolved === undefined ? {} : {value: resolved}),
            errorId,
        };
}

function writeToConsole(level: TEmitLogLevel, line: string, resolved: unknown) {
    const sink = ORIGINAL_CONSOLE_SINKS[level];
    if (resolved !== undefined) {
        sink(line, resolved);
    } else {
        sink(line);
    }
}

function emitLog(
    level: TEmitLogLevel,
    section: string,
    message: string,
    data?: TLazyValue,
    options: {
        failureRef?: FailureReceipt;
        writeConsole?: boolean;
    } = {},
) {
    if (!shouldLog(level)) {
        return;
    }

    const timestamp = createIsoTimestamp();
    const resolved = serializeForRendererLog(resolveLazyValue(data));
    if (options.writeConsole !== false) {
        writeToConsole(
            level,
            `[${timestamp}] [${section}] ${message}`,
            options.failureRef ? withErrorId(resolved, options.failureRef.eventId) : resolved,
        );
    }

    forwardToMain({
        level,
        section,
        message,
        timestamp,
        data: resolved,
        ...(options.failureRef ? {failureRef: options.failureRef} : {}),
    });
}

function emitThrottled(
    level: TEmitLogLevel,
    section: string,
    key: string,
    intervalMs: number,
    message: string,
    data?: TLazyValue,
    options: {writeConsole?: boolean;} = {},
) {
    // Filtered levels must not resolve lazy payloads, so the level check happens
    // here rather than only inside emitLog after resolveLazyValue.
    if (!shouldLog(level)) {
        return;
    }

    const throttle = takeThrottledLogSuppressionCount(section, key, intervalMs);
    if (!throttle.allowed) {
        return;
    }

    const resolved = resolveLazyValue(data);
    const enriched = enrichThrottledPayload(
        resolved,
        throttle.suppressedCount,
        intervalMs,
        key,
    );
    emitLog(level, section, message, enriched, options);
}

export const BrowserLogger = {
    debug: (section: string, message: string, data?: TLazyValue) => {
        emitLog('debug', section, message, data);
    },

    info: (section: string, message: string, data?: TLazyValue) => {
        emitLog('info', section, message, data);
    },

    warn: (section: string, message: string, data?: TLazyValue) => {
        emitLog('warn', section, message, data);
    },

    warnThrottled: (
        section: string,
        key: string,
        intervalMs: number,
        message: string,
        data?: TLazyValue,
    ) => {
        emitThrottled('warn', section, key, intervalMs, message, data);
    },

    diagnostic: (section: string, message: string, data?: TLazyValue) => {
        const warnForced = isDiagnosticWarnForced();
        emitLog(warnForced ? 'warn' : 'debug', section, message, data, {writeConsole: warnForced || section !== 'pdf-nav' || isPdfNavConsoleDiagnosticEnabled()});
    },

    diagnosticThrottled: (
        section: string,
        key: string,
        intervalMs: number,
        message: string,
        data?: TLazyValue,
    ) => {
        const warnForced = isDiagnosticWarnForced();
        emitThrottled(
            warnForced ? 'warn' : 'debug',
            section,
            key,
            intervalMs,
            message,
            data,
            {writeConsole: warnForced || section !== 'pdf-nav' || isPdfNavConsoleDiagnosticEnabled()},
        );
    },

    error: <C extends DiagnosticCode>(
        section: string,
        message: string,
        error: TLazyValue | undefined,
        existingReceiptOrOptions: FailureReceipt | IBrowserLoggerErrorOptions<C>,
    ): FailureReceipt => {
        let existingReceipt: FailureReceipt | undefined;
        let diagnosticOptions: IBrowserLoggerErrorOptions<C> | undefined;
        if (isFailureReceipt(existingReceiptOrOptions)) {
            existingReceipt = existingReceiptOrOptions;
        } else {
            diagnosticOptions = existingReceiptOrOptions;
        }
        const resolved = resolveLazyValue(error);
        const local = {
            source: section,
            message,
            cause: resolved,
            data: resolved,
        };
        const captureOptions = {localAlreadyRecorded: true};
        let receipt: FailureReceipt;
        if (existingReceipt) {
            receipt = existingReceipt;
        } else if (diagnosticOptions) {
            const input: CaptureFailureInput<C> = {
                code: diagnosticOptions.code,
                context: diagnosticOptions.context,
                local,
            };
            receipt = captureRendererFailure(input, captureOptions)
                ?? initializeRendererFailureReporter({host: hasElectronRendererBridge() ? 'electron' : 'hosted-browser'}).capture(input, captureOptions);
        } else {
            const input: CaptureFailureInput<'UNCLASSIFIED_RENDERER_ERROR'> = {
                code: 'UNCLASSIFIED_RENDERER_ERROR',
                context: {phase: 'operation'},
                local,
            };
            receipt = captureRendererFailure(input, captureOptions)
                ?? initializeRendererFailureReporter({host: hasElectronRendererBridge() ? 'electron' : 'hosted-browser'}).capture(input, captureOptions);
            try {
                ORIGINAL_CONSOLE_SINKS.warn(
                    '[BrowserLogger] ERROR call used the closed unclassified fallback because its diagnostic input was invalid.',
                );
            } catch {
                // Local warning failure cannot interrupt the original error path.
            }
        }

        emitLog('error', section, message, resolved, {failureRef: receipt});
        return receipt;
    },
};
