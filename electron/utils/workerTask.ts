import { existsSync } from 'fs';
import { join } from 'path';
import {
    Worker,
    type ResourceLimits,
} from 'worker_threads';
import { isRecord } from '@contracts/runtimeGuards';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} from '@electron/utils/nativeTerminationProof';

const workerTaskLog = createLogger('worker-task');

export interface IWorkerTaskErrorFrame {
    message: string;
    name?: string;
    code?: string;
    canceled?: boolean;
    retryable?: boolean;
    source?: string;
    /**
     * Set when the worker stopped a native process tree without being able to
     * prove it died. A symbol-tagged error cannot survive the structured clone
     * between a worker and main, so the outcome travels as data on the frame and
     * is re-attached to the `WorkerTaskError` main throws.
     */
    terminationUnproven?: string;
}

type TResultWorkerPayload =
    | {
        type: 'result';
        ok: true;
        data?: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
        errorFrame?: IWorkerTaskErrorFrame;
    };

type TResultWorkerDecoder<T> = (data: unknown) => T | null;

interface IRunResultWorkerTaskBaseOptions {
    workerPath: string;
    workerData: unknown;
    invalidPayloadMessage: string;
    createStartError?: ((message: string) => Error) | null;
    createStartupError?: (message: string) => Error;
    createStartupExitError?: (code: number) => Error;
    createWorkerExitError: (code: number) => Error;
    onProgressMessage?: (payload: unknown) => boolean;
    invalidResultMessage?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    createCancelMessage?: (reason: 'abort' | 'timeout') => unknown;
    cooperativeCancelDelayMs?: number;
    resourceLimits?: ResourceLimits;
}

interface IDecodedResultWorkerTaskOptions<T> extends IRunResultWorkerTaskBaseOptions {decodeResult: TResultWorkerDecoder<T>;}

interface IUnknownResultWorkerTaskOptions extends IRunResultWorkerTaskBaseOptions {decodeResult?: undefined;}

type TRunResultWorkerTaskOptions<T = unknown> =
    | IDecodedResultWorkerTaskOptions<T>
    | IUnknownResultWorkerTaskOptions;

export interface IStreamingWorkerTaskHandle<T> {
    worker: Worker;
    promise: Promise<T>;
}

export class WorkerTaskError extends Error {
    readonly code: string | undefined;
    readonly canceled: boolean;
    readonly retryable: boolean;
    readonly source: string | undefined;

    constructor(frame: IWorkerTaskErrorFrame) {
        super(frame.message);
        this.name = frame.name ?? 'WorkerTaskError';
        this.code = frame.code;
        this.canceled = frame.canceled ?? false;
        this.retryable = frame.retryable ?? false;
        this.source = frame.source;
        if (frame.terminationUnproven !== undefined) {
            markUnprovenNativeTermination(this, frame.terminationUnproven);
        }
    }
}

function getErrorStringProperty(error: unknown, key: 'name' | 'code') {
    if (!error || typeof error !== 'object') {
        return undefined;
    }
    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

export function createWorkerTaskErrorFrame(
    error: unknown,
    options: {
        source?: string;
        retryable?: boolean;
    } = {},
): IWorkerTaskErrorFrame {
    const frame: IWorkerTaskErrorFrame = {
        message: getErrorMessage(error),
        canceled: isAbortError(error),
        retryable: options.retryable ?? false,
    };
    const name = getErrorStringProperty(error, 'name');
    if (name !== undefined) {
        frame.name = name;
    }
    const code = getErrorStringProperty(error, 'code');
    if (code !== undefined) {
        frame.code = code;
    } else if (frame.canceled) {
        frame.code = 'ABORT_ERR';
    }
    if (options.source) {
        frame.source = options.source;
    }
    const terminationUnproven = getUnprovenNativeTerminationDetail(error);
    if (terminationUnproven !== undefined) {
        frame.terminationUnproven = terminationUnproven;
    }
    return frame;
}

export function resolveUnpackedWorkerPath(baseDir: string, workerFileName: string) {
    const defaultPath = join(baseDir, workerFileName);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }
    return defaultPath;
}

function parseWorkerTaskErrorFrame(value: unknown): IWorkerTaskErrorFrame | null {
    if (!isRecord(value) || typeof value.message !== 'string') {
        return null;
    }
    if (value.name !== undefined && typeof value.name !== 'string') {
        return null;
    }
    if (value.code !== undefined && typeof value.code !== 'string') {
        return null;
    }
    if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
        return null;
    }
    if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
        return null;
    }
    if (value.source !== undefined && typeof value.source !== 'string') {
        return null;
    }
    if (value.terminationUnproven !== undefined && typeof value.terminationUnproven !== 'string') {
        return null;
    }
    return {
        message: value.message,
        ...(value.name === undefined ? {} : {name: value.name}),
        ...(value.code === undefined ? {} : {code: value.code}),
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(value.retryable === undefined ? {} : {retryable: value.retryable}),
        ...(value.source === undefined ? {} : {source: value.source}),
        ...(value.terminationUnproven === undefined ? {} : {terminationUnproven: value.terminationUnproven}),
    };
}

function parseResultWorkerPayload(payload: unknown): TResultWorkerPayload | null {
    if (!isRecord(payload) || payload.type !== 'result') {
        return null;
    }

    if (payload.ok === true) {
        return {
            type: 'result',
            ok: true,
            ...('data' in payload ? {data: payload.data} : {}),
        };
    }

    if (payload.ok === false) {
        const errorFrame = parseWorkerTaskErrorFrame(payload.errorFrame);
        if (typeof payload.error !== 'string' && errorFrame === null) {
            return null;
        }
        return {
            type: 'result',
            ok: false,
            error: typeof payload.error === 'string' ? payload.error : errorFrame?.message ?? 'Worker task failed',
            ...(errorFrame === null ? {} : {errorFrame}),
        };
    }

    return null;
}

// One underlying worker failure is one diagnostic. This layer already logs the
// rejection it produces at error level, and every wrapper above it re-throws the
// same object, so a wrapper that logs the failure again would give the renderer's
// runtime-report stream two entries, keyed by different sources and messages so
// they dedupe apart, for a single fault. Wrappers ask this before deciding their
// own severity.
const reportedWorkerTaskErrors = new WeakMap<object, FailureReceipt>();

function markWorkerTaskErrorReported<T>(error: T, receipt: FailureReceipt | undefined): T {
    if (typeof error === 'object' && error !== null && receipt !== undefined) {
        reportedWorkerTaskErrors.set(error, receipt);
    }
    return error;
}

export function getWorkerTaskFailureReceipt(error: unknown) {
    return typeof error === 'object' && error !== null
        ? reportedWorkerTaskErrors.get(error)
        : undefined;
}

export function rememberWorkerTaskFailureReceipt(error: unknown, receipt: FailureReceipt | undefined) {
    markWorkerTaskErrorReported(error, receipt);
    return receipt;
}

// A cancelled worker still reports what it managed to stop. The frame is the
// only channel that survives the structured clone, so the mark is lifted off it
// and onto the rejection the caller actually sees.
function withWorkerReportedTerminationProof<T>(error: T, payload: unknown): T {
    const resultPayload = parseResultWorkerPayload(payload);
    if (!resultPayload || resultPayload.ok) {
        return error;
    }
    const detail = resultPayload.errorFrame?.terminationUnproven;
    return detail === undefined ? error : markUnprovenNativeTermination(error, detail);
}

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

function createWorkerTaskError(payload: Extract<TResultWorkerPayload, {ok: false;}>) {
    return new WorkerTaskError(payload.errorFrame ?? {
        message: payload.error,
        canceled: false,
        retryable: false,
    });
}

function getAbortReason(signal: AbortSignal) {
    if (signal.reason !== undefined) {
        const reason: unknown = signal.reason;
        return reason;
    }
    return new DOMException('The operation was aborted', 'AbortError');
}

function createWorkerOptions(workerData: unknown, resourceLimits: ResourceLimits | undefined) {
    const workerOptions: {
        workerData: unknown;
        resourceLimits?: ResourceLimits;
    } = { workerData };
    if (resourceLimits) {
        workerOptions.resourceLimits = resourceLimits;
    }
    return workerOptions;
}

// `worker.terminate()` is asynchronous: it resolves once the thread has actually
// stopped, and until then the thread can still be running the code that holds
// this task's inputs open. Closing a document deletes the working copy the
// worker was reading, so that caller needs the arrival and not the request. The
// task promise therefore waits for it.
//
// A stopped thread is not the same as a stopped process tree. Nothing in Node
// reaps the children a worker spawned, so this fence only proves the JavaScript
// side is done; a worker that unwound cooperatively reports what happened to its
// native children on its result frame, and one that had to be force terminated
// never got the chance to stop them at all.
//
// There is no stronger kill than `terminate()` for a worker thread, so a thread
// wedged in native code has no completion fence left to offer. This harness
// re-issues termination on a bounded schedule and keeps waiting rather than
// pretending the worker stopped: the task stays unsettled, the main operation
// that owns it stays pending, and the close path that owns the working copy
// decides what to do about a dependency that will not let go. Reporting a wedged
// worker as stopped would let that path delete a directory a live Poppler child
// is still reading, which is the failure this bound exists to prevent.
export const WORKER_TERMINATION_ESCALATION_INTERVAL_MS = 10_000;
export const WORKER_TERMINATION_ESCALATION_LIMIT = 3;

interface ITerminateWorkerAfterTaskOptions {
    workerPath: string;
    hasExited: () => boolean;
}

function attachLateWorkerErrorHandler(worker: Worker, workerPath: string) {
    // `Worker` is an `EventEmitter`, so an 'error' event with no listener is
    // rethrown into the main process. A worker that is still unwinding can emit
    // one long after its task stopped listening, so this listener stays attached
    // for the rest of the worker's life and keeps the late error below the
    // severity that turns into a user-facing diagnostic.
    worker.on('error', (error: unknown) => {
        workerTaskLog.info(
            `Worker emitted an error after its task settled: path=${workerPath} `
            + `message=${getErrorMessage(error)}`,
        );
    });
}

async function terminateWorkerAfterTask(
    worker: Worker,
    {
        workerPath,
        hasExited,
    }: ITerminateWorkerAfterTaskOptions,
) {
    worker.removeAllListeners('message');
    worker.removeAllListeners('online');
    worker.removeAllListeners('exit');
    worker.removeAllListeners('error');
    attachLateWorkerErrorHandler(worker, workerPath);
    if (hasExited()) {
        return;
    }

    let resolveStopped: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const markStopped = () => {
        resolveStopped?.();
    };
    // Two things prove the thread is gone: the 'exit' event, and `terminate()`
    // resolving. A rejected termination request proves nothing about the thread,
    // so it falls through to the exit event instead.
    worker.once('exit', markStopped);
    const reportUnprovenTermination = (attempt: number, error: unknown) => {
        workerTaskLog.warn(
            `Worker termination request did not complete: path=${workerPath} attempt=${attempt} `
            + `message=${getErrorMessage(error)}; waiting for the worker to exit`,
        );
    };
    // `worker.terminate()` can also fail synchronously. Evaluating the call
    // inside `Promise.resolve(...)` lets that throw escape past the rejection
    // handler and unwind `finalize`, where the task would look complete while
    // the thread is still running. A synchronous throw proves exactly as little
    // as a rejected promise, so both land in the same waiting state.
    const requestTermination = (attempt: number) => {
        let termination: Promise<number>;
        try {
            termination = Promise.resolve(worker.terminate());
        } catch (error) {
            reportUnprovenTermination(attempt, error);
            return;
        }
        void termination.then(markStopped, (error: unknown) => {
            reportUnprovenTermination(attempt, error);
        });
    };

    let attempts = 1;
    let escalationTimer = null as NodeJS.Timeout | null;
    const scheduleEscalation = () => {
        escalationTimer = setTimeout(() => {
            if (attempts >= WORKER_TERMINATION_ESCALATION_LIMIT) {
                // A wedged worker is a quarantine, not an application fault: the
                // task stays unsettled and the working-copy owner retains the
                // bytes. Reporting it at error level would turn a contained,
                // correct outcome into a user-facing runtime report.
                workerTaskLog.warn(
                    `Worker has not stopped after ${attempts} termination requests over `
                    + `${attempts * WORKER_TERMINATION_ESCALATION_INTERVAL_MS}ms: path=${workerPath}. `
                    + 'Its task stays unsettled so nothing reclaims resources the worker may still be reading',
                );
                return;
            }
            attempts += 1;
            workerTaskLog.warn(
                `Worker has not stopped ${WORKER_TERMINATION_ESCALATION_INTERVAL_MS}ms after termination was `
                + `requested: path=${workerPath}; re-issuing terminate (attempt ${attempts})`,
            );
            requestTermination(attempts);
            scheduleEscalation();
        }, WORKER_TERMINATION_ESCALATION_INTERVAL_MS);
        escalationTimer.unref();
    };

    requestTermination(attempts);
    scheduleEscalation();
    try {
        await stopped;
    } finally {
        if (escalationTimer) {
            clearTimeout(escalationTimer);
        }
    }
}

function postWorkerCancelMessage(worker: Worker, message: unknown) {
    try {
        worker.postMessage(message);
    } catch {
        // Worker may already be exiting.
    }
}

interface IAttachWorkerHandlersOptions<T> {
    worker: Worker;
    options: TRunResultWorkerTaskOptions<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    startedAt: number;
}

function attachWorkerHandlers<T>({
    worker,
    options,
    resolve,
    reject,
    startedAt,
}: IAttachWorkerHandlersOptions<T>) {
    const {
        invalidPayloadMessage,
        createStartupError,
        createStartupExitError,
        createWorkerExitError,
        onProgressMessage,
        decodeResult,
        invalidResultMessage,
    } = options;
    let settled = false;
    let online = false;
    let workerExited = false;
    let timeout: NodeJS.Timeout | null = null;
    let inactivityTimeout: NodeJS.Timeout | null = null;
    let cooperativeCancelTimer: NodeJS.Timeout | null = null;
    let hasPendingCancelError = false;
    let pendingCancelError: unknown;
    let cancellationAcknowledged = false;
    let firstMessageObserved = false;

    const markUnprovenPendingCancellation = () => {
        if (!hasPendingCancelError || cancellationAcknowledged) {
            return;
        }
        pendingCancelError = markUnprovenNativeTermination(
            pendingCancelError,
            `worker ${options.workerPath} ended before acknowledging cancellation; native processes it spawned were never confirmed stopped`,
        );
    };

    const cleanup = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = null;
        }
        if (cooperativeCancelTimer) {
            clearTimeout(cooperativeCancelTimer);
            cooperativeCancelTimer = null;
        }
        options.signal?.removeEventListener('abort', handleAbort);
    };

    const finalize = (callback: () => void) => {
        if (settled) {
            return;
        }
        settled = true;
        cleanup();
        void terminateWorkerAfterTask(worker, {
            workerPath: options.workerPath,
            hasExited: () => workerExited,
        }).then(callback, callback);
    };

    const requestCancel = (reason: 'abort' | 'timeout', error: unknown) => {
        if (settled || hasPendingCancelError) {
            return;
        }
        workerTaskLog.warn(
            `Worker cancellation requested: path=${options.workerPath} reason=${reason} `
            + `elapsedMs=${Math.round(performance.now() - startedAt)}`,
        );
        const cancelMessage = options.createCancelMessage?.(reason);
        if (cancelMessage === undefined) {
            finalize(() => {
                reject(error);
            });
            return;
        }

        pendingCancelError = error;
        hasPendingCancelError = true;
        cleanup();
        postWorkerCancelMessage(worker, cancelMessage);
        const cooperativeCancelDelayMs = options.cooperativeCancelDelayMs ?? 1_000;
        cooperativeCancelTimer = setTimeout(() => {
            // `worker.terminate()` stops the thread. It does not stop the
            // processes that thread spawned, and a worker that never answered
            // the cooperative cancel never got to stop them either. Whatever
            // those children were reading has to be treated as still open.
            workerTaskLog.warn(
                `Worker did not acknowledge cancellation within ${cooperativeCancelDelayMs}ms: `
                + `path=${options.workerPath}; force terminating with its native children unaccounted for`,
            );
            finalize(() => {
                reject(markUnprovenNativeTermination(
                    error,
                    `worker ${options.workerPath} was force terminated after ignoring cancellation for `
                    + `${cooperativeCancelDelayMs}ms; native processes it spawned were never confirmed stopped`,
                ));
            });
        }, cooperativeCancelDelayMs);
        cooperativeCancelTimer.unref();
    };

    const handleAbort = () => {
        requestCancel('abort', getAbortReason(options.signal!));
    };

    const restartInactivityTimeout = () => {
        const inactivityTimeoutMs = options.inactivityTimeoutMs;
        if (inactivityTimeoutMs === undefined || settled || hasPendingCancelError) {
            return;
        }
        if (inactivityTimeout) {
            clearTimeout(inactivityTimeout);
        }
        inactivityTimeout = setTimeout(() => {
            requestCancel(
                'timeout',
                new Error(`Worker task timed out after ${inactivityTimeoutMs}ms without progress`),
            );
        }, inactivityTimeoutMs);
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            requestCancel('timeout', new Error(`Worker task timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    }
    restartInactivityTimeout();

    worker.once('online', () => {
        online = true;
        workerTaskLog.debug(
            `Worker online: path=${options.workerPath} onlineMs=${Math.round(performance.now() - startedAt)}`,
        );
    });

    const handleMessage = (payload: unknown) => {
        if (!firstMessageObserved) {
            firstMessageObserved = true;
            workerTaskLog.debug(
                `Worker first message: path=${options.workerPath} firstMessageMs=${Math.round(performance.now() - startedAt)}`,
            );
        }
        if (onProgressMessage?.(payload)) {
            restartInactivityTimeout();
            return;
        }
        if (hasPendingCancelError && parseResultWorkerPayload(payload) !== null) {
            cancellationAcknowledged = true;
        }
        finalize(() => {
            if (hasPendingCancelError) {
                // The cancellation is the outcome, so the abort reason stays the
                // rejection. What the worker reported about its own stop still
                // matters though: a run that could not prove its native tree
                // died is the reason the working-copy owner keeps the bytes, and
                // dropping that here would strand the evidence on the discarded
                // frame.
                reject(withWorkerReportedTerminationProof(pendingCancelError, payload));
                return;
            }
            const resultPayload = parseResultWorkerPayload(payload);
            if (!resultPayload) {
                const error = new Error(invalidPayloadMessage);
                const receipt = workerTaskLog.error(
                    `Worker returned an invalid payload: path=${options.workerPath} `
                    + `elapsedMs=${Math.round(performance.now() - startedAt)}`,
                    {
                        code: 'MAIN_WORKER_TASK_FAILED',
                        context: {},
                        cause: error,
                    },
                );
                reject(markWorkerTaskErrorReported(error, receipt));
                return;
            }
            if (!resultPayload.ok) {
                const workerError = createWorkerTaskError(resultPayload);
                const summary = `path=${options.workerPath} `
                    + `elapsedMs=${Math.round(performance.now() - startedAt)} `
                    + `message=${resultPayload.error}`;
                // A worker that reports its own abort is finishing the
                // cancellation it was asked for, not failing.
                if (workerError.canceled) {
                    workerTaskLog.info(`Worker reported cancellation: ${summary}`);
                } else {
                    const receipt = workerTaskLog.error(`Worker reported failure: ${summary}`, {
                        code: 'MAIN_WORKER_TASK_FAILED',
                        context: {},
                        cause: workerError,
                    });
                    markWorkerTaskErrorReported(workerError, receipt);
                }
                reject(workerError);
                return;
            }
            if (decodeResult) {
                const decoded = decodeResult(resultPayload.data);
                if (decoded === null) {
                    const receipt = workerTaskLog.error(
                        `Worker returned an invalid result: path=${options.workerPath} `
                        + `elapsedMs=${Math.round(performance.now() - startedAt)}`,
                        {
                            code: 'MAIN_WORKER_TASK_FAILED',
                            context: {},
                        },
                    );
                    reject(markWorkerTaskErrorReported(
                        new Error(invalidResultMessage ?? invalidPayloadMessage),
                        receipt,
                    ));
                    return;
                }
                workerTaskLog.debug(
                    `Worker completed: path=${options.workerPath} `
                    + `elapsedMs=${Math.round(performance.now() - startedAt)}`,
                );
                resolve(decoded);
                return;
            }
            workerTaskLog.debug(
                `Worker completed: path=${options.workerPath} `
                + `elapsedMs=${Math.round(performance.now() - startedAt)}`,
            );
            resolve(resultPayload.data as T);
        });
    };

    if (onProgressMessage) {
        worker.on('message', handleMessage);
    } else {
        worker.once('message', handleMessage);
    }

    worker.once('error', (error) => {
        const summary = `path=${options.workerPath} `
            + `online=${online} elapsedMs=${Math.round(performance.now() - startedAt)} `
            + `message=${getErrorMessage(error)}`;
        // A worker torn down by a cancellation already in flight is expected to
        // die noisily; the cancellation is the outcome, so it is not an app error.
        let receipt: FailureReceipt | undefined;
        if (hasPendingCancelError) {
            workerTaskLog.info(`Worker emitted an error while cancelling: ${summary}`);
        } else {
            receipt = workerTaskLog.error(`Worker emitted an error: ${summary}`, {
                code: 'MAIN_WORKER_TASK_FAILED',
                context: {},
                cause: error,
            });
        }
        finalize(() => {
            if (hasPendingCancelError) {
                markUnprovenPendingCancellation();
                reject(pendingCancelError);
                return;
            }
            if (!online && createStartupError) {
                reject(markWorkerTaskErrorReported(createStartupError(getErrorMessage(error)), receipt));
                return;
            }
            reject(markWorkerTaskErrorReported(toError(error), receipt));
        });
    });

    worker.once('exit', (code) => {
        // Recorded before the settled check so a task that finalized on another
        // event knows the thread is already gone and has nothing left to await.
        workerExited = true;
        if (settled) {
            return;
        }
        const summary = `path=${options.workerPath} `
            + `code=${code} online=${online} `
            + `elapsedMs=${Math.round(performance.now() - startedAt)}`;
        let receipt: FailureReceipt | undefined;
        if (hasPendingCancelError) {
            workerTaskLog.info(`Worker exited while cancelling: ${summary}`);
        } else {
            receipt = workerTaskLog.error(`Worker exited before returning a result: ${summary}`, {
                code: 'MAIN_WORKER_TASK_FAILED',
                context: {},
            });
        }
        finalize(() => {
            if (hasPendingCancelError) {
                markUnprovenPendingCancellation();
                reject(pendingCancelError);
                return;
            }
            if (code === 0) {
                reject(markWorkerTaskErrorReported(
                    new Error(invalidResultMessage ?? invalidPayloadMessage),
                    receipt,
                ));
                return;
            }
            if (!online && createStartupExitError) {
                reject(markWorkerTaskErrorReported(createStartupExitError(code), receipt));
                return;
            }
            reject(markWorkerTaskErrorReported(createWorkerExitError(code), receipt));
        });
    });

    if (options.signal?.aborted) {
        handleAbort();
    }
}

export function runResultWorkerTask<T>(options: IDecodedResultWorkerTaskOptions<T>): Promise<T>;
export function runResultWorkerTask(options: IUnknownResultWorkerTaskOptions): Promise<unknown>;
export async function runResultWorkerTask<T>(
    options: TRunResultWorkerTaskOptions<T>,
): Promise<T | unknown> {
    const {
        workerPath,
        workerData,
        createStartError,
        createStartupError,
    } = options;
    if (options.signal?.aborted) {
        throw getAbortReason(options.signal);
    }
    return new Promise<T | unknown>((resolve, reject) => {
        let worker: Worker;
        const startedAt = performance.now();
        try {
            worker = new Worker(workerPath, createWorkerOptions(workerData, options.resourceLimits));
        } catch (error) {
            const buildStartError = createStartError === null
                ? undefined
                : createStartError ?? createStartupError;
            reject(buildStartError ? buildStartError(getErrorMessage(error)) : toError(error));
            return;
        }
        attachWorkerHandlers<T | unknown>({
            worker,
            options,
            resolve,
            reject,
            startedAt,
        });
    });
}

export function startStreamingWorkerTask<T>(
    options: IDecodedResultWorkerTaskOptions<T> & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<T>;
export function startStreamingWorkerTask(
    options: IUnknownResultWorkerTaskOptions & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<unknown>;
export function startStreamingWorkerTask<T>(
    options: TRunResultWorkerTaskOptions<T> & { createStartupError: (message: string) => Error },
): IStreamingWorkerTaskHandle<T | unknown> {
    const {
        workerPath,
        workerData,
        createStartupError,
    } = options;
    if (options.signal?.aborted) {
        throw getAbortReason(options.signal);
    }
    if (!existsSync(workerPath)) {
        throw createStartupError(`Worker unavailable at path: ${workerPath}`);
    }
    let worker: Worker;
    const startedAt = performance.now();
    try {
        worker = new Worker(workerPath, createWorkerOptions(workerData, options.resourceLimits));
    } catch (error) {
        throw createStartupError(getErrorMessage(error));
    }
    const promise = new Promise<T | unknown>((resolve, reject) => {
        attachWorkerHandlers<T | unknown>({
            worker,
            options,
            resolve,
            reject,
            startedAt,
        });
    });
    return {
        worker,
        promise,
    };
}
