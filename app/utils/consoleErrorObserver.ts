import {
    normalizeCanonicalApplicationFrames,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';
import {
    createDiagnosticEventId,
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    DIAGNOSTIC_RECORD_SCHEMA_VERSION,
    decodeDiagnosticRecord,
    type DiagnosticRuntime,
} from '@contracts/diagnostics/diagnosticRecord';
import {
    getRendererFailureReporter,
    initializeRendererFailureReporter,
    type IRendererFailureReporter,
} from '@app/utils/failureReporter';
import {hasElectronAPI} from '@app/utils/platform';
import {
    notifyRendererDiagnosticNotice,
    redactRendererDiagnosticSignature,
} from '@app/utils/rendererDiagnosticNotices';

const CONSOLE_OBSERVER_MODULE_SUFFIX = 'app/utils/consoleErrorObserver.ts';
const MAX_HEALTH_COUNTER = Number.MAX_SAFE_INTEGER;

type TConsoleError = (...args: unknown[]) => unknown;

export interface IConsoleErrorTarget {error: TConsoleError;}

export interface IConsoleErrorObserverOptions {
    target?: IConsoleErrorTarget;
    reporter?: IRendererFailureReporter;
    runtime?: Extract<DiagnosticRuntime, 'electron-renderer' | 'hosted-browser'>;
    now?: () => number;
    createEventId?: () => DiagnosticEventId;
    captureStack?: (observer: TConsoleError) => string;
}

export interface IConsoleErrorObserverHealthSnapshot {framelessDropped: number;}

export interface IConsoleErrorObserverHandle {
    cleanup: () => void;
    getHealthSnapshot: () => IConsoleErrorObserverHealthSnapshot;
}

interface IWindowObserverState {
    target: IConsoleErrorTarget;
    handle: IConsoleErrorObserverHandle;
}

type TErrorWithCaptureStackTrace = ErrorConstructor & {captureStackTrace?: (target: object, constructor?: (...args: unknown[]) => unknown) => void;};

type TObserverWindow = Window & {__evbConsoleErrorObserverState?: IWindowObserverState;};

const activeObservers = new WeakMap<object, IConsoleErrorObserverHandle>();

let fallbackEventIdCounter = 0;

function increment(value: number) {
    return value >= MAX_HEALTH_COUNTER ? MAX_HEALTH_COUNTER : value + 1;
}

function safeNow(now: () => number) {
    try {
        const value = now();
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

function createFallbackEventId(): DiagnosticEventId {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    let timestamp = 0;
    try {
        timestamp = Date.now();
    } catch {
        // Keep the record valid if the clock is unavailable.
    }
    return `${timestamp.toString(16)}${fallbackEventIdCounter.toString(16)}`
        .slice(-32)
        .padStart(32, '0') as DiagnosticEventId;
}

function createSafeEventId(factory: () => DiagnosticEventId) {
    try {
        const eventId = factory();
        if (isDiagnosticEventId(eventId)) {
            return eventId;
        }
    } catch {
        // Use the local fallback below.
    }

    try {
        return createDiagnosticEventId();
    } catch {
        return createFallbackEventId();
    }
}

function captureFreshCallSiteStack(observer: TConsoleError) {
    try {
        const holder: {stack?: string} = {};
        const captureStackTrace = (Error as TErrorWithCaptureStackTrace).captureStackTrace;
        if (typeof captureStackTrace === 'function') {
            captureStackTrace(holder, observer);
            return typeof holder.stack === 'string' ? holder.stack : '';
        }
    } catch {
        // Fall through to the standard Error stack.
    }

    try {
        return new Error().stack ?? '';
    } catch {
        return '';
    }
}

function isObserverFrame(frame: CanonicalAppFrame) {
    return frame.module === CONSOLE_OBSERVER_MODULE_SUFFIX
        || frame.module.endsWith(`/${CONSOLE_OBSERVER_MODULE_SUFFIX}`);
}

function getApplicationFrames(stack: string) {
    try {
        return normalizeCanonicalApplicationFrames(stack).frames.filter(frame => !isObserverFrame(frame));
    } catch {
        return [];
    }
}

function createClosedConsoleRecord(
    stack: string,
    runtime: Extract<DiagnosticRuntime, 'electron-renderer' | 'hosted-browser'>,
    now: () => number,
    createEventId: () => DiagnosticEventId,
) {
    const frames = getApplicationFrames(stack);
    if (frames.length === 0) {
        return null;
    }

    try {
        return decodeDiagnosticRecord({
            schemaVersion: DIAGNOSTIC_RECORD_SCHEMA_VERSION,
            eventId: createSafeEventId(createEventId),
            code: 'UNCLASSIFIED_CONSOLE_ERROR',
            severity: 'error',
            runtime,
            operation: 'console-error',
            occurredAt: safeNow(now),
            frames,
            context: {},
        });
    } catch {
        return null;
    }
}

function resolveRuntime(
    runtime: IConsoleErrorObserverOptions['runtime'],
): Extract<DiagnosticRuntime, 'electron-renderer' | 'hosted-browser'> {
    if (runtime !== undefined) {
        return runtime;
    }
    return hasElectronAPI() ? 'electron-renderer' : 'hosted-browser';
}

function getWindowState(target: IConsoleErrorTarget) {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const state = (window as TObserverWindow).__evbConsoleErrorObserverState;
        return state?.target === target ? state : null;
    } catch {
        return null;
    }
}

function setWindowState(target: IConsoleErrorTarget, handle: IConsoleErrorObserverHandle) {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        (window as TObserverWindow).__evbConsoleErrorObserverState = {
            target,
            handle,
        };
    } catch {
        // The observer still has target-local idempotence if window state is unavailable.
    }
}

function clearWindowState(target: IConsoleErrorTarget, handle: IConsoleErrorObserverHandle) {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        const windowWithState = window as TObserverWindow;
        if (
            windowWithState.__evbConsoleErrorObserverState?.target === target
            && windowWithState.__evbConsoleErrorObserverState.handle === handle
        ) {
            delete windowWithState.__evbConsoleErrorObserverState;
        }
    } catch {
        // Cleanup remains best effort and never changes console behavior.
    }
}

function createNoopHandle(): IConsoleErrorObserverHandle {
    return {
        cleanup: () => {},
        getHealthSnapshot: () => ({framelessDropped: 0}),
    };
}

export function installConsoleErrorObserver(
    options: IConsoleErrorObserverOptions = {},
): IConsoleErrorObserverHandle {
    const target = options.target ?? console;
    const windowState = getWindowState(target);
    if (windowState !== null) {
        return windowState.handle;
    }

    const activeHandle = activeObservers.get(target);
    if (activeHandle !== undefined) {
        return activeHandle;
    }

    const originalError = target.error;
    if (typeof originalError !== 'function') {
        return createNoopHandle();
    }

    const reporter = options.reporter ?? getRendererFailureReporter() ?? initializeRendererFailureReporter({host: resolveRuntime(options.runtime) === 'electron-renderer' ? 'electron' : 'hosted-browser'});
    const runtime = resolveRuntime(options.runtime);
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const captureStack = options.captureStack ?? captureFreshCallSiteStack;
    let framelessDropped = 0;
    let reentrancyDepth = 0;
    let cleanedUp = false;

    function safelyInvokeRawConsoleError(thisArg: unknown, args: ArrayLike<unknown>) {
        try {
            Reflect.apply(originalError, thisArg, args);
        } catch {
            // A broken console sink must not change the originating error path.
        }
    }

    function observedConsoleError(this: unknown) {
        const wasReentrant = reentrancyDepth > 0;
        if (!wasReentrant) {
            reentrancyDepth = 1;
        }

        try {
            // Keep the raw console contract intact without exposing values to the observer.
            // eslint-disable-next-line prefer-rest-params -- The captured sink receives the untouched argument list.
            safelyInvokeRawConsoleError(this ?? target, arguments);
            if (wasReentrant) {
                return;
            }

            let stack = '';
            try {
                stack = captureStack(observedConsoleError);
            } catch {
                stack = '';
            }

            const record = createClosedConsoleRecord(stack, runtime, now, createEventId);
            if (record === null) {
                framelessDropped = increment(framelessDropped);
                return;
            }

            try {
                reporter.captureRecord(record);
            } catch {
                // The reporter is best effort. The original console call already ran.
            }
            // The observer never reads the console arguments, so the notice
            // carries the closed record's own call site instead of the message.
            notifyRendererDiagnosticNotice({
                occurredAt: record.occurredAt,
                signature: redactRendererDiagnosticSignature(
                    `console-error ${record.frames[0]?.module ?? 'unknown'}`
                    + `#${record.frames[0]?.function ?? 'anonymous'}`,
                ),
                source: 'console-error',
            });
        } finally {
            if (!wasReentrant) {
                reentrancyDepth = 0;
            }
        }
    }

    const handle: IConsoleErrorObserverHandle = {
        cleanup: () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            if (target.error === observedConsoleError) {
                try {
                    target.error = originalError;
                } catch {
                    // A non-writable console property cannot be restored here.
                }
            }
            if (activeObservers.get(target) === handle) {
                activeObservers.delete(target);
            }
            clearWindowState(target, handle);
        },
        getHealthSnapshot: () => Object.freeze({framelessDropped}),
    };

    try {
        target.error = observedConsoleError;
    } catch {
        return createNoopHandle();
    }

    activeObservers.set(target, handle);
    setWindowState(target, handle);
    return handle;
}

export const createConsoleErrorObserver = installConsoleErrorObserver;

/** Exercises the installed observer only from the isolated packaged canary. */
export function emitObservedConsoleErrorForCanary() {
    console.error('Packaged direct-console diagnostics canary');
}
