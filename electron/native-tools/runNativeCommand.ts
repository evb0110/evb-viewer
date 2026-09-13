import { spawn } from 'child_process';
import type { ChildProcessByStdio } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { Readable } from 'stream';
import {
    formatArgForLog,
    formatCommandFailureMessage,
    createAbortError,
    NativeProcessError,
    type IProcessResult,
    type TProcessLog,
} from '@electron/native-tools/processResult';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    getCommandDirectory,
    prependDirectoryToPath,
} from '@electron/native-tools/toolRegistry';
import { getErrorMessage } from '@electron/utils/error';
import { createTextChunkAccumulator } from '@electron/native-tools/createTextChunkAccumulator';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';
import { createLogger } from '@electron/utils/createLogger';
import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';

export interface IRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    log?: TProcessLog;
    defaultCwdToCommandDir?: boolean;
    prependCommandDirToPath?: boolean;
    includeProcessEnv?: boolean;
    windowsHide?: boolean;
    rejectOnStdoutTruncation?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onSpawn?: (pid: number) => void;
    terminationGraceMs?: number;
}

const DEFAULT_MAX_STDOUT_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDOUT_BYTES', 262_144, 1_024);
const DEFAULT_MAX_STDERR_BYTES = parseIntegerEnv('EVB_NATIVE_TOOL_MAX_STDERR_BYTES', 262_144, 1_024);
const DEFAULT_TERMINATION_GRACE_MS = parseIntegerEnv('EVB_NATIVE_TOOL_TERMINATION_GRACE_MS', 1_000, 250);
const nativeProcessTelemetryLog = createLogger('native-process-telemetry');
let activeNativeProcessCount = 0;
const DEFAULT_NATIVE_COMMAND_TIMEOUT_MS = parseIntegerEnv(
    'EVB_NATIVE_COMMAND_TIMEOUT_MS',
    15 * 60 * 1_000,
    1_000,
);
const MAX_CONCURRENT_NATIVE_COMMANDS = parseIntegerEnv('EVB_NATIVE_COMMAND_MAX_CONCURRENCY', 8, 1);
const MAX_QUEUED_NATIVE_COMMANDS = parseIntegerEnv('EVB_NATIVE_COMMAND_MAX_QUEUED', 128, 1);
const NATIVE_COMMAND_ADMISSION_TIMEOUT_MS = parseIntegerEnv(
    'EVB_NATIVE_COMMAND_ADMISSION_TIMEOUT_MS',
    30_000,
    1_000,
);

interface INativeCommandAdmissionWaiter {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal | undefined;
    abort?: (() => void) | undefined;
    timeout: NodeJS.Timeout;
}

let activeNativeCommandAdmissions = 0;
const nativeCommandAdmissionWaiters: INativeCommandAdmissionWaiter[] = [];

function createNativeCommandAdmissionRelease() {
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        activeNativeCommandAdmissions = Math.max(0, activeNativeCommandAdmissions - 1);
        pumpNativeCommandAdmissionWaiters();
    };
}

function admitNativeCommandNow() {
    activeNativeCommandAdmissions += 1;
    return createNativeCommandAdmissionRelease();
}

function cleanupNativeCommandAdmissionWaiter(waiter: INativeCommandAdmissionWaiter) {
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort);
    }
}

function pumpNativeCommandAdmissionWaiters() {
    while (
        activeNativeCommandAdmissions < MAX_CONCURRENT_NATIVE_COMMANDS
        && nativeCommandAdmissionWaiters.length > 0
    ) {
        const waiter = nativeCommandAdmissionWaiters.shift()!;
        cleanupNativeCommandAdmissionWaiter(waiter);
        if (waiter.signal?.aborted) {
            waiter.reject(abortErrorFromSignal(waiter.signal));
            continue;
        }
        waiter.resolve(admitNativeCommandNow());
    }
}

export function acquireNativeCommandAdmission(signal?: AbortSignal) {
    if (signal?.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }
    if (activeNativeCommandAdmissions < MAX_CONCURRENT_NATIVE_COMMANDS) {
        return admitNativeCommandNow();
    }
    if (nativeCommandAdmissionWaiters.length >= MAX_QUEUED_NATIVE_COMMANDS) {
        return Promise.reject(new Error('Native command queue is full; retry after active work finishes'));
    }
    return new Promise<() => void>((resolve, reject) => {
        const waiter: INativeCommandAdmissionWaiter = {
            resolve,
            reject,
            signal,
            timeout: setTimeout(() => {
                const index = nativeCommandAdmissionWaiters.indexOf(waiter);
                if (index >= 0) nativeCommandAdmissionWaiters.splice(index, 1);
                cleanupNativeCommandAdmissionWaiter(waiter);
                reject(new Error('Timed out waiting for native command capacity'));
            }, NATIVE_COMMAND_ADMISSION_TIMEOUT_MS),
        };
        if (signal) {
            waiter.abort = () => {
                const index = nativeCommandAdmissionWaiters.indexOf(waiter);
                if (index >= 0) nativeCommandAdmissionWaiters.splice(index, 1);
                cleanupNativeCommandAdmissionWaiter(waiter);
                reject(abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', waiter.abort, {once: true});
        }
        waiter.timeout.unref();
        nativeCommandAdmissionWaiters.push(waiter);
    });
}

type TNativeProcess = ChildProcessByStdio<null, Readable, Readable>;
type TCancelGroupHandler = () => void;
type TCancelGroupCompletion = () => Promise<boolean>;

const activeCancelGroups = new Map<string, Set<TCancelGroupHandler>>();
const activeCancelGroupCompletions = new Map<string, Set<TCancelGroupCompletion>>();

interface ICommandRunContext {
    effectiveCwd: string | undefined;
    effectiveEnv: NodeJS.ProcessEnv | undefined;
    displayName: string;
    displayCommand: string;
}

class NativeToolError extends Error {
    constructor(readonly code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'NativeToolError';
    }
}

function parseNativeErrorEnvelope(stderr: string): NativeToolError | null {
    const line = stderr.trim().split(/\r?\n/u).pop();
    if (!line) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(line);
        return isNativeErrorEnvelope(value)
            ? new NativeToolError(value.code, value.message)
            : null;
    } catch {
        // Only the last line is trusted: the tool writes its envelope last, and
        // scanning earlier lines let document content that happens to be a valid
        // envelope choose the error code.
        return null;
    }
}

function createCommandRunContext(command: string, args: string[], options: IRunCommandOptions): ICommandRunContext {
    const {
        cwd,
        env,
        commandLabel,
        defaultCwdToCommandDir = false,
        prependCommandDirToPath = false,
        includeProcessEnv = true,
    } = options;
    const commandDir = getCommandDirectory(command);
    const effectiveCwd = cwd ?? (defaultCwdToCommandDir ? commandDir ?? undefined : undefined);
    const baseEnv: NodeJS.ProcessEnv = includeProcessEnv ? { ...process.env } : {};
    const mergedEnv = env
        ? {
            ...baseEnv,
            ...env,
        }
        : (includeProcessEnv ? process.env : undefined);
    const effectiveEnv = commandDir && prependCommandDirToPath && mergedEnv
        ? prependDirectoryToPath(commandDir, mergedEnv)
        : mergedEnv;
    return {
        effectiveCwd,
        effectiveEnv,
        displayName: commandLabel ?? command,
        displayCommand: `${command} ${args.map(formatArgForLog).join(' ')}`.trim(),
    };
}

function createBoundedOutputCapture(maxStdoutBytes: number, maxStderrBytes: number) {
    const stdout = createTextChunkAccumulator(maxStdoutBytes);
    const stderr = createTextChunkAccumulator(maxStderrBytes);

    return {
        appendStdout(data: Buffer) {
            stdout.append(data);
        },
        appendStderr(data: Buffer) {
            stderr.append(data);
        },
        snapshot() {
            return {
                stdout: stdout.text(),
                stderr: stderr.text(),
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
            };
        },
    };
}

function spawnNativeProcess(
    command: string,
    args: string[],
    context: ICommandRunContext,
    windowsHide: boolean,
) {
    const spawnOptions = createDetachedChildProcessSpawnOptions({
        shell: false,
        windowsHide,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    if (context.effectiveCwd !== undefined) {
        spawnOptions.cwd = context.effectiveCwd;
    }
    if (context.effectiveEnv !== undefined) {
        spawnOptions.env = context.effectiveEnv;
    }
    return spawn(command, args, spawnOptions);
}

// Reports whether the process tree was proven dead, not whether the request was
// sent. A rejected or non-affirmative termination is treated as "still alive"
// because that is the only assumption that cannot lose a user's file.
async function terminateNativeProcessBestEffort(proc: TNativeProcess, graceMs: number) {
    return await terminateDetachedChildProcess(proc, graceMs) === true;
}

function getTruncatedOutputMessage(label: 'stdout' | 'stderr', truncated: boolean, maxBytes: number, text: string) {
    return truncated
        ? `[${label} truncated to ${maxBytes} bytes]\n${text}`
        : text;
}

export async function runNativeCommand(
    command: string,
    args: string[],
    options: IRunCommandOptions = {},
): Promise<IProcessResult> {
    const admission = acquireNativeCommandAdmission(options.signal);
    const releaseAdmission = typeof admission === 'function'
        ? admission
        : await admission;
    const {
        cwd,
        env,
        timeoutMs = DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
        maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
        maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
        allowedExitCodes = [0],
        signal,
        cancelGroup,
        commandLabel,
        log,
        defaultCwdToCommandDir = false,
        prependCommandDirToPath = false,
        includeProcessEnv = true,
        windowsHide = true,
        rejectOnStdoutTruncation = true,
        onStdout,
        onStderr,
        onSpawn,
        terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    } = options;

    return new Promise<IProcessResult>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortErrorFromSignal(signal));
            return;
        }

        let proc: TNativeProcess | null = null;
        let abortHandler: (() => void) | null = null;
        let cancelGroupHandler: TCancelGroupHandler | null = null;
        let cancelGroupCompletion: TCancelGroupCompletion | null = null;

        const contextOptions: IRunCommandOptions = {
            defaultCwdToCommandDir,
            prependCommandDirToPath,
            includeProcessEnv,
        };
        if (cwd !== undefined) {
            contextOptions.cwd = cwd;
        }
        if (env !== undefined) {
            contextOptions.env = env;
        }
        if (commandLabel !== undefined) {
            contextOptions.commandLabel = commandLabel;
        }

        const context = createCommandRunContext(command, args, contextOptions);
        const output = createBoundedOutputCapture(maxStdoutBytes, maxStderrBytes);
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let timeoutHandle: NodeJS.Timeout | null = null;
        let forceRejectHandle: NodeJS.Timeout | null = null;
        let pendingTerminationError = null as Error | null;
        let terminationPromise: Promise<boolean> | null = null;
        let settled = false as boolean;
        let processAdmitted = false;
        const startedAt = performance.now();
        let stdoutDataHandler: ((data: Buffer) => void) | null = null;
        let stderrDataHandler: ((data: Buffer) => void) | null = null;
        let processErrorHandler: ((error: Error) => void) | null = null;
        let processCloseHandler: ((code: number | null, closeSignal: NodeJS.Signals | null) => void) | null = null;
        const ignoreLateProcessError = () => undefined;

        const cleanupProcessOutput = (targetProc: TNativeProcess, destroyStreams: boolean) => {
            if (stdoutDataHandler) {
                targetProc.stdout.removeListener('data', stdoutDataHandler);
                stdoutDataHandler = null;
            }
            if (stderrDataHandler) {
                targetProc.stderr.removeListener('data', stderrDataHandler);
                stderrDataHandler = null;
            }
            if (!destroyStreams) {
                return;
            }
            targetProc.stdout.unpipe();
            targetProc.stderr.unpipe();
            targetProc.stdout.destroy();
            targetProc.stderr.destroy();
        };

        const cleanupProcessHandlers = () => {
            if (!proc) {
                return;
            }
            cleanupProcessOutput(proc, false);
            if (processErrorHandler) {
                proc.removeListener('error', processErrorHandler);
                processErrorHandler = null;
            }
            if (processCloseHandler) {
                proc.removeListener('close', processCloseHandler);
                processCloseHandler = null;
            }
            proc.on('error', ignoreLateProcessError);
        };

        // The force-reject timer bounds how long the caller waits; it is not
        // evidence the child died. Whichever path settles first records what it
        // actually knows, so a caller that owns files the child was reading can
        // tell "stopped" from "gave up waiting".
        const markTerminationUnproven = (error: Error) => markUnprovenNativeTermination(
            error,
            `${context.displayName} process tree (pid=${String(proc?.pid)}) was not proven dead within `
            + `${terminationGraceMs + 2_000}ms of termination; its inputs may still be open`,
        );

        const requestTermination = (error: Error) => {
            if (settled || pendingTerminationError) {
                return;
            }
            pendingTerminationError = error;
            const targetProc = proc;
            if (!targetProc) {
                finalizeReject(error);
                return;
            }

            cleanupProcessOutput(targetProc, true);
            terminationPromise = terminateNativeProcessBestEffort(targetProc, terminationGraceMs).then(
                terminated => terminated,
                () => false,
            );
            void terminationPromise.then((terminated) => {
                if (pendingTerminationError !== error) {
                    return;
                }
                if (!terminated) {
                    log?.(
                        'warn',
                        `${context.displayName} did not confirm process-tree termination; cmd=${context.displayCommand}`,
                    );
                    finalizeReject(markTerminationUnproven(error));
                    return;
                }
                finalizeReject(error);
            });

            forceRejectHandle = setTimeout(() => {
                finalizeReject(markTerminationUnproven(error));
            }, terminationGraceMs + 2_000);
            forceRejectHandle.unref();
        };

        const getPendingTerminationError = () => pendingTerminationError;

        const finalize = (complete: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (processAdmitted) {
                processAdmitted = false;
                activeNativeProcessCount = Math.max(0, activeNativeProcessCount - 1);
                nativeProcessTelemetryLog.debug(
                    `Native process settled: command=${context.displayName} durationMs=${Math.round(performance.now() - startedAt)} active=${activeNativeProcessCount}`,
                );
            }
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (forceRejectHandle) {
                clearTimeout(forceRejectHandle);
                forceRejectHandle = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            if (cancelGroup && cancelGroupHandler) {
                unregisterCancelGroupHandler(cancelGroup, cancelGroupHandler);
            }
            if (cancelGroup && cancelGroupCompletion) {
                unregisterCancelGroupCompletion(cancelGroup, cancelGroupCompletion);
            }
            cleanupProcessHandlers();
            complete();
        };

        const finalizeReject = (error: Error) => {
            finalize(() => {
                reject(error);
            });
        };

        const finalizeResolve = (result: IProcessResult) => {
            finalize(() => {
                resolve(result);
            });
        };

        if (signal) {
            abortHandler = () => {
                requestTermination(abortErrorFromSignal(signal));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        if (cancelGroup) {
            cancelGroupHandler = () => {
                requestTermination(createAbortError());
            };
            cancelGroupCompletion = () => terminationPromise ?? Promise.resolve(false);
            registerCancelGroupHandler(cancelGroup, cancelGroupHandler);
            registerCancelGroupCompletion(cancelGroup, cancelGroupCompletion);
        }
        if (settled) {
            return;
        }

        try {
            proc = spawnNativeProcess(command, args, context, windowsHide);
            processAdmitted = true;
            activeNativeProcessCount += 1;
            nativeProcessTelemetryLog.debug(
                `Native process spawned: command=${context.displayName} active=${activeNativeProcessCount}`,
            );
        } catch (error) {
            const message = `${context.displayName} failed to start: ${getErrorMessage(error)}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
            return;
        }
        if (onSpawn) {
            const pid = proc.pid;
            if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
                proc.on('error', ignoreLateProcessError);
                requestTermination(new Error(`${context.displayName} spawned without a valid process id`));
                return;
            }
            try {
                onSpawn(pid);
            } catch (error) {
                // The callback runs before the regular process listeners are
                // attached. Keep late child errors from becoming uncaught
                // exceptions while the failed spawn hook is being cleaned up.
                proc.on('error', ignoreLateProcessError);
                requestTermination(new Error(
                    `${context.displayName} spawn handler failed: ${getErrorMessage(error)}`,
                ));
                return;
            }
        }
        const appendDecodedStdout = (text: string) => {
            if (!text) {
                return;
            }
            try {
                onStdout?.(text);
            } catch (error) {
                requestTermination(new Error(
                    `${context.displayName} stdout handler failed: ${getErrorMessage(error)}`,
                ));
            }
        };
        const appendDecodedStderr = (text: string) => {
            if (!text) {
                return;
            }
            try {
                onStderr?.(text);
            } catch (error) {
                requestTermination(new Error(
                    `${context.displayName} stderr handler failed: ${getErrorMessage(error)}`,
                ));
            }
        };
        // The raw chunk goes to the capture and the decoder separately, rather
        // than the capture re-encoding what the decoder just decoded.
        stdoutDataHandler = (data: Buffer) => {
            output.appendStdout(data);
            appendDecodedStdout(stdoutDecoder.write(data));
        };
        stderrDataHandler = (data: Buffer) => {
            output.appendStderr(data);
            appendDecodedStderr(stderrDecoder.write(data));
        };
        proc.stdout.on('data', stdoutDataHandler);
        proc.stderr.on('data', stderrDataHandler);

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                log?.('error', `${context.displayName} timed out after ${timeoutMs}ms; cmd=${context.displayCommand}`);
                requestTermination(new Error(`${context.displayName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        if (signal?.aborted) {
            requestTermination(abortErrorFromSignal(signal));
        }

        processErrorHandler = (error) => {
            const message = `${context.displayName} failed to start: ${error.message}`;
            log?.('error', `${message}; cmd=${context.displayCommand}`);
            finalizeReject(new Error(message));
        };
        proc.on('error', processErrorHandler);

        processCloseHandler = (code, closeSignal) => {
            if (pendingTerminationError) {
                const terminationError = pendingTerminationError;
                // `close` means this child's stdio is done, which does not
                // prove the detached group it leads went with it; the
                // termination result stays the authority on that. An absent
                // result is an absent proof: the close arrived before the
                // termination request could record what it observed, so this
                // path has seen nothing that says the tree died.
                void (terminationPromise ?? Promise.resolve(false)).then((terminated) => {
                    if (pendingTerminationError !== terminationError) {
                        return;
                    }
                    finalizeReject(terminated ? terminationError : markTerminationUnproven(terminationError));
                });
                return;
            }

            appendDecodedStdout(stdoutDecoder.end());
            appendDecodedStderr(stderrDecoder.end());
            if (getPendingTerminationError()) {
                return;
            }
            const exitCode = typeof code === 'number' ? code : null;
            const outputSnapshot = output.snapshot();
            if (closeSignal || exitCode === null || !allowedExitCodes.includes(exitCode)) {
                if (!closeSignal) {
                    const structuredError = parseNativeErrorEnvelope(outputSnapshot.stderr);
                    if (structuredError) {
                        finalizeReject(structuredError);
                        return;
                    }
                }
                const failure = formatCommandFailureMessage(
                    context.displayName,
                    command,
                    args,
                    exitCode,
                    getTruncatedOutputMessage('stdout', outputSnapshot.stdoutTruncated, maxStdoutBytes, outputSnapshot.stdout),
                    getTruncatedOutputMessage('stderr', outputSnapshot.stderrTruncated, maxStderrBytes, outputSnapshot.stderr),
                    closeSignal,
                );
                log?.('error', `${failure.message}; cmd=${failure.displayCommand}`);
                finalizeReject(new NativeProcessError(
                    closeSignal ? 'signal' : 'exit-code',
                    exitCode,
                    closeSignal,
                    failure.message,
                ));
                return;
            }
            if (rejectOnStdoutTruncation && outputSnapshot.stdoutTruncated) {
                const message = `${context.displayName} stdout exceeded ${maxStdoutBytes} bytes`;
                log?.('error', `${message}; cmd=${context.displayCommand}`);
                finalizeReject(new Error(message));
                return;
            }

            finalizeResolve({
                stdout: outputSnapshot.stdout,
                stderr: outputSnapshot.stderr,
                exitCode,
            });
        };
        proc.on('close', processCloseHandler);
    }).finally(releaseAdmission);
}

function registerCancelGroupHandler(cancelGroup: string, handler: TCancelGroupHandler) {
    const handlers = activeCancelGroups.get(cancelGroup) ?? new Set<TCancelGroupHandler>();
    handlers.add(handler);
    activeCancelGroups.set(cancelGroup, handlers);
}

function unregisterCancelGroupHandler(cancelGroup: string, handler: TCancelGroupHandler) {
    const handlers = activeCancelGroups.get(cancelGroup);
    if (!handlers) {
        return;
    }
    handlers.delete(handler);
    if (handlers.size === 0) {
        activeCancelGroups.delete(cancelGroup);
    }
}

function registerCancelGroupCompletion(cancelGroup: string, completion: TCancelGroupCompletion) {
    const completions = activeCancelGroupCompletions.get(cancelGroup) ?? new Set<TCancelGroupCompletion>();
    completions.add(completion);
    activeCancelGroupCompletions.set(cancelGroup, completions);
}

function unregisterCancelGroupCompletion(cancelGroup: string, completion: TCancelGroupCompletion) {
    const completions = activeCancelGroupCompletions.get(cancelGroup);
    if (!completions) {
        return;
    }
    completions.delete(completion);
    if (completions.size === 0) {
        activeCancelGroupCompletions.delete(cancelGroup);
    }
}

export function cancelNativeCommandGroup(cancelGroup: string) {
    const handlers = activeCancelGroups.get(cancelGroup);
    if (!handlers || handlers.size === 0) {
        return false;
    }
    for (const handler of Array.from(handlers)) {
        handler();
    }
    return true;
}

export async function cancelNativeCommandGroupAndWait(cancelGroup: string) {
    const handlers = activeCancelGroups.get(cancelGroup);
    const completions = activeCancelGroupCompletions.get(cancelGroup);
    if (!handlers || !completions || handlers.size === 0 || completions.size === 0) {
        return false;
    }
    for (const handler of Array.from(handlers)) {
        handler();
    }
    const results = await Promise.all(Array.from(completions, completion => completion()));
    return results.every(Boolean);
}
