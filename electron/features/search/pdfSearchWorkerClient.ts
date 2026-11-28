import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {NATIVE_ERROR_CODES, type TNativeErrorCode} from '@contracts/nativeErrors';
import {createPdfSearchWasmRunner, loadPdfSearchWasmModule, PdfSearchNativeError} from '@electron/features/search/pdfSearchWasmRunner';
import {
    createPdfSearchWorkerIndexCache,
    executePdfSearchWorkerCommand,
    type TPdfSearchWorkerCommand,
} from '@electron/features/search/pdfSearchWorkerOps';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_WARM_WORKERS = 2;
const WORKER_IDLE_TTL_MS = 30_000;
// Matches DEFAULT_NATIVE_COMMAND_TIMEOUT_MS in runNativeCommand.ts (15 minutes).
const DEFAULT_SEARCH_WORKER_TIMEOUT_MS = 15 * 60 * 1_000;
// Maximum delay supported by Node.js setTimeout (32-bit signed integer ms).
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface IRunPdfSearchWorkerOptions {
    /**
     * Execution deadline in milliseconds once dispatched to a search worker thread
     * (defaults to 15 minutes; `0` disables the deadline). Does not apply to the
     * unbuilt Vitest inline fallback.
     */
    timeoutMs?: number;
}

interface IWorkerReply {
    id: number;
    ok: boolean;
    data?: unknown;
    error?: string;
    nativeErrorCode?: TNativeErrorCode;
}

interface IWarmSearchWorker {
    worker: Worker;
    busy: boolean;
    closed: boolean;
    slotReleased: boolean;
    idleTimer: NodeJS.Timeout | null;
    exitConfirmed: Promise<void>;
    resolveExitConfirmed: () => void;
    terminationStarted: boolean;
    cancelActiveTask: ((reason: unknown) => void) | null;
    lastIndexPath: string | null;
}

interface IQueuedTask {
    command: TPdfSearchWorkerCommand;
    workerPath: string;
    signal: AbortSignal | undefined;
    timeoutMs: number | undefined;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    onAbort?: (() => void) | undefined;
}

function getAbortReason(signal: AbortSignal) {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function validateTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) {
        return DEFAULT_SEARCH_WORKER_TIMEOUT_MS;
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`Invalid search worker timeoutMs: ${String(timeoutMs)}`);
    }
    return timeoutMs;
}

function decodeWorkerError(reply: IWorkerReply) {
    const message = typeof reply.error === 'string' && reply.error.length > 0 ? reply.error : 'evb-pdf-search worker failed';
    if (typeof reply.nativeErrorCode === 'string' && (NATIVE_ERROR_CODES as readonly string[]).includes(reply.nativeErrorCode)) {
        return new PdfSearchNativeError(reply.nativeErrorCode, message);
    }
    return new Error(message);
}

function createSearchWorkerPool() {
    const workers = new Set<IWarmSearchWorker>();
    const pendingTeardowns = new Set<Promise<void>>();
    const pendingStagedIndexPaths = new Set<string>();
    let startingWorkers = 0;
    const activeStartupCancels = new Set<(reason: unknown) => void>();
    const queue: IQueuedTask[] = [];
    let nextRequestId = 0;
    let inlineRunnerPromise: Promise<ReturnType<typeof createPdfSearchWasmRunner>> | null = null;
    const inlineIndexCache = createPdfSearchWorkerIndexCache();
    let exitHookRegistered = false;

    const cleanupPendingStagedPathsOnProcessExit = () => {
        if (pendingStagedIndexPaths.size === 0) {
            exitHookRegistered = false;
            return;
        }
        try {
            const {rmSync} = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
            for (const stagedPath of pendingStagedIndexPaths) {
                try {
                    rmSync(stagedPath, {force: true});
                } catch {
                    // Best-effort synchronous cleanup during process exit.
                }
            }
        } catch {
            // Best-effort synchronous cleanup during process exit.
        }
        pendingStagedIndexPaths.clear();
        exitHookRegistered = false;
    };

    function trackPendingStagedPath(stagedPath: string) {
        pendingStagedIndexPaths.add(stagedPath);
        if (!exitHookRegistered) {
            exitHookRegistered = true;
            process.once('exit', cleanupPendingStagedPathsOnProcessExit);
        }
    }

    function untrackPendingStagedPath(stagedPath: string) {
        pendingStagedIndexPaths.delete(stagedPath);
        if (pendingStagedIndexPaths.size === 0 && exitHookRegistered) {
            exitHookRegistered = false;
            process.off('exit', cleanupPendingStagedPathsOnProcessExit);
        }
    }

    function trackTeardown(promise: Promise<void>): Promise<void> {
        pendingTeardowns.add(promise);
        void promise.finally(() => {
            pendingTeardowns.delete(promise);
        });
        return promise;
    }

    // Defined outside dispatchToWorker so the cleanup continuation captures only
    // the staging path string and never retains the dispatched command buffers.
    function scheduleStagedIndexCleanup(exitConfirmed: Promise<void>, stagedPath: string): Promise<void> {
        return trackTeardown(
            exitConfirmed
                .then(() => rm(stagedPath, {force: true}).catch(() => undefined))
                .finally(() => {
                    untrackPendingStagedPath(stagedPath);
                }),
        );
    }

    function resolveWorkerScriptPath() {
        const fileName = WORKER_BUNDLES_BY_ID['pdf-search'].fileName;
        const primary = resolveUnpackedWorkerPath(__dirname, fileName);
        if (existsSync(primary) || __dirname.includes('app.asar')) {
            return primary;
        }
        const devBundle = join(process.cwd(), 'dist-electron', fileName);
        return existsSync(devBundle) ? devBundle : primary;
    }

    function clearIdleTimer(entry: IWarmSearchWorker) {
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    function releaseWorkerSlotOnConfirmedExit(entry: IWarmSearchWorker) {
        if (entry.slotReleased) {
            return;
        }
        entry.slotReleased = true;
        entry.closed = true;
        entry.busy = true;
        clearIdleTimer(entry);
        workers.delete(entry);
        entry.resolveExitConfirmed();
        pumpQueue();
    }

    function destroyWorker(entry: IWarmSearchWorker, alreadyExited = false): Promise<void> {
        entry.closed = true;
        entry.busy = true;
        clearIdleTimer(entry);
        if (alreadyExited) {
            releaseWorkerSlotOnConfirmedExit(entry);
            return entry.exitConfirmed;
        }
        if (!entry.terminationStarted) {
            entry.terminationStarted = true;
            trackTeardown(entry.exitConfirmed);
            // Keep the entry in `workers` until exit is confirmed (either `terminate()`
            // resolving with an exit code or the worker emitting `exit`). If `terminate()`
            // rejects, keep the slot reserved until `exit` actually fires.
            void Promise.resolve()
                .then(() => entry.worker.terminate())
                .then(
                    () => {
                        releaseWorkerSlotOnConfirmedExit(entry);
                    },
                    () => undefined,
                );
        }
        return entry.exitConfirmed;
    }

    function scheduleIdleEviction(entry: IWarmSearchWorker) {
        clearIdleTimer(entry);
        if (entry.closed || entry.busy) {
            return;
        }
        entry.idleTimer = setTimeout(() => {
            if (!entry.busy) {
                void destroyWorker(entry);
            }
        }, WORKER_IDLE_TTL_MS);
        entry.idleTimer.unref();
    }

    function commandIndexPath(command: TPdfSearchWorkerCommand): string | undefined {
        return command.op === 'index' || command.op === 'stat' || command.op === 'search' ? command.indexPath : undefined;
    }

    function sendEvictControlToWorkers(indexPath: string | undefined, exclude?: IWarmSearchWorker) {
        const message = indexPath === undefined ? {control: 'evict' as const} : {control: 'evict' as const, indexPath};
        for (const entry of workers) {
            if (entry === exclude || entry.closed) {
                continue;
            }
            if (indexPath === undefined || entry.lastIndexPath === indexPath) {
                entry.lastIndexPath = null;
            }
            try {
                entry.worker.postMessage(message);
            } catch {
                // Ignore post failures on a closing worker.
            }
        }
    }

    function selectIdleWorker(indexPath: string | undefined) {
        const idleWorkers = [...workers].filter((entry) => !entry.busy && !entry.closed);
        if (idleWorkers.length === 0) {
            return undefined;
        }
        if (indexPath !== undefined) {
            const affine = idleWorkers.find((entry) => entry.lastIndexPath === indexPath);
            if (affine) {
                return affine;
            }
        }
        return idleWorkers[0];
    }

    function pumpQueue() {
        while (queue.length > 0) {
            const candidate = queue[0]!;
            const idle = selectIdleWorker(commandIndexPath(candidate.command));
            if (!idle && workers.size + startingWorkers >= MAX_WARM_WORKERS) {
                return;
            }
            const next = queue.shift()!;
            if (next.onAbort) {
                next.signal?.removeEventListener('abort', next.onAbort);
                next.onAbort = undefined;
            }
            if (next.signal?.aborted) {
                next.reject(getAbortReason(next.signal));
                continue;
            }
            if (idle) {
                dispatchToWorker(idle, next);
                continue;
            }
            // Reserve the slot synchronously before awaiting WASM compilation so a
            // burst of cold-start calls never exceeds MAX_WARM_WORKERS.
            startingWorkers += 1;
            startWorkerAndDispatch(next);
        }
    }

    function startWorkerAndDispatch(initialTask: IQueuedTask) {
        // Hold the pending task in a single clearable cell (not an async frame)
        // so canceling during WASM load releases large command buffers immediately for GC.
        let pendingTask: IQueuedTask | null = initialTask;
        let slotReleased = false;

        const releaseStartupSlot = () => {
            if (!slotReleased) {
                slotReleased = true;
                startingWorkers = Math.max(0, startingWorkers - 1);
            }
        };

        const cleanupStartupCancel = (task: IQueuedTask) => {
            activeStartupCancels.delete(cancelDuringStartup);
            task.signal?.removeEventListener('abort', onStartupAbort);
        };

        const cancelDuringStartup = (reason: unknown) => {
            const task = pendingTask;
            if (!task) {
                return;
            }
            pendingTask = null;
            cleanupStartupCancel(task);
            releaseStartupSlot();
            task.reject(reason);
            pumpQueue();
        };

        const onStartupAbort = () => {
            const task = pendingTask;
            if (!task?.signal) {
                return;
            }
            cancelDuringStartup(getAbortReason(task.signal));
        };

        activeStartupCancels.add(cancelDuringStartup);
        if (pendingTask.signal) {
            if (pendingTask.signal.aborted) {
                onStartupAbort();
                return;
            }
            pendingTask.signal.addEventListener('abort', onStartupAbort, {once: true});
        }

        let loadPromise: Promise<WebAssembly.Module>;
        try {
            loadPromise = loadPdfSearchWasmModule();
        } catch (error) {
            cancelDuringStartup(error);
            return;
        }

        void loadPromise.then(
            (wasmModule) => {
                const task = pendingTask;
                if (!task) {
                    return;
                }
                if (task.signal?.aborted) {
                    cancelDuringStartup(getAbortReason(task.signal));
                    return;
                }
                let createdEntry: IWarmSearchWorker | null = null;
                try {
                    const worker = new Worker(task.workerPath, {workerData: {wasmModule}});
                    const exitDeferred = Promise.withResolvers<void>();
                    createdEntry = {
                        worker,
                        busy: true,
                        closed: false,
                        slotReleased: false,
                        idleTimer: null,
                        exitConfirmed: exitDeferred.promise,
                        resolveExitConfirmed: exitDeferred.resolve,
                        terminationStarted: false,
                        cancelActiveTask: null,
                        lastIndexPath: null,
                    };
                    const entry = createdEntry;
                    worker.on('error', () => {
                        if (!entry.busy && !entry.closed) {
                            void destroyWorker(entry);
                        }
                    });
                    worker.once('exit', () => {
                        if (!entry.busy || entry.closed) {
                            releaseWorkerSlotOnConfirmedExit(entry);
                        }
                    });
                    pendingTask = null;
                    cleanupStartupCancel(task);
                    workers.add(entry);
                    releaseStartupSlot();
                    dispatchToWorker(entry, task);
                } catch (error) {
                    pendingTask = null;
                    cleanupStartupCancel(task);
                    releaseStartupSlot();
                    if (createdEntry) {
                        void destroyWorker(createdEntry);
                    }
                    task.reject(error);
                    pumpQueue();
                }
            },
            (error: unknown) => {
                cancelDuringStartup(error);
            },
        );
    }

    function dispatchToWorker(entry: IWarmSearchWorker, task: IQueuedTask) {
        entry.busy = true;
        clearIdleTimer(entry);
        const targetIndexPath = commandIndexPath(task.command);
        if (targetIndexPath !== undefined) {
            entry.lastIndexPath = targetIndexPath;
        }
        if (task.command.op === 'index') {
            sendEvictControlToWorkers(task.command.indexPath, entry);
        }
        const requestId = ++nextRequestId;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        const {signal, timeoutMs, resolve, reject} = task;
        const stagedIndexPath = task.command.op === 'index' ? `${task.command.indexPath}.tmp-${process.pid}-${randomUUID()}` : null;
        if (stagedIndexPath !== null) {
            trackPendingStagedPath(stagedIndexPath);
        }
        const dispatchPayload: TPdfSearchWorkerCommand | (Extract<TPdfSearchWorkerCommand, {op: 'index'}> & {stagedIndexPath: string}) =
            task.command.op === 'index'
                ? {
                      ...task.command,
                      stagedIndexPath: stagedIndexPath!,
                  }
                : task.command;

        const cleanup = () => {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            entry.cancelActiveTask = null;
            entry.worker.off('message', onMessage);
            entry.worker.off('error', onError);
            entry.worker.off('exit', onExit);
            signal?.removeEventListener('abort', onAbort);
        };

        const finishSuccess = (data: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (stagedIndexPath !== null) {
                untrackPendingStagedPath(stagedIndexPath);
            }
            entry.busy = false;
            resolve(data);
            if (queue.length > 0) {
                pumpQueue();
            } else {
                scheduleIdleEviction(entry);
            }
        };

        const finishError = (error: unknown, terminateWorker: boolean, alreadyExited = false) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (terminateWorker) {
                // Reject the caller promptly at the deadline/abort/shutdown while
                // keeping the pool slot reserved until worker exit is confirmed.
                const exitConfirmed = destroyWorker(entry, alreadyExited);
                if (stagedIndexPath !== null) {
                    void scheduleStagedIndexCleanup(exitConfirmed, stagedIndexPath);
                }
                reject(error);
                return;
            }
            if (stagedIndexPath !== null) {
                untrackPendingStagedPath(stagedIndexPath);
            }
            entry.busy = false;
            scheduleIdleEviction(entry);
            reject(error);
            pumpQueue();
        };

        const onMessage = (reply: IWorkerReply) => {
            if (!reply || typeof reply !== 'object' || reply.id !== requestId) {
                return;
            }
            if (reply.ok) {
                finishSuccess(reply.data);
            } else {
                finishError(decodeWorkerError(reply), false);
            }
        };

        const onError = (error: Error) => {
            finishError(error, true);
        };

        const onExit = (code: number) => {
            finishError(new Error(`evb-pdf-search worker exited unexpectedly with code ${code}`), true, true);
        };

        const onAbort = () => {
            // Terminating the busy worker interrupts synchronous WASM execution immediately.
            finishError(getAbortReason(signal!), true);
        };

        entry.cancelActiveTask = (reason: unknown) => {
            finishError(reason, true);
        };
        entry.worker.on('message', onMessage);
        entry.worker.on('error', onError);
        entry.worker.on('exit', onExit);
        if (signal) {
            if (signal.aborted) {
                finishError(getAbortReason(signal), false);
                return;
            }
            signal.addEventListener('abort', onAbort, {once: true});
        }
        const effectiveTimeoutMs = timeoutMs ?? DEFAULT_SEARCH_WORKER_TIMEOUT_MS;
        if (effectiveTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                finishError(new Error(`evb-pdf-search timed out after ${effectiveTimeoutMs}ms`), true);
            }, effectiveTimeoutMs);
            timeoutHandle.unref();
        }

        const transferList: ArrayBuffer[] = [];
        if (
            commandHasBuffer(dispatchPayload) &&
            dispatchPayload.pagesBuffer.buffer instanceof ArrayBuffer &&
            dispatchPayload.pagesBuffer.byteOffset === 0 &&
            dispatchPayload.pagesBuffer.byteLength === dispatchPayload.pagesBuffer.buffer.byteLength
        ) {
            transferList.push(dispatchPayload.pagesBuffer.buffer);
        }
        try {
            entry.worker.postMessage(
                {
                    id: requestId,
                    command: dispatchPayload,
                },
                transferList,
            );
        } catch (error) {
            finishError(error, true);
        }
    }

    function commandHasBuffer(command: TPdfSearchWorkerCommand): command is Extract<TPdfSearchWorkerCommand, {pagesBuffer: Uint8Array}> {
        return command.op === 'index' || command.op === 'searchPages';
    }

    async function runInlineFallback(command: TPdfSearchWorkerCommand, signal: AbortSignal | undefined) {
        signal?.throwIfAborted();
        if (!inlineRunnerPromise) {
            const pending = loadPdfSearchWasmModule()
                .then((wasmModule) => createPdfSearchWasmRunner(wasmModule))
                .catch((error: unknown) => {
                    if (inlineRunnerPromise === pending) {
                        inlineRunnerPromise = null;
                    }
                    throw error;
                });
            inlineRunnerPromise = pending;
        }
        const runner = await inlineRunnerPromise;
        signal?.throwIfAborted();
        const result = await executePdfSearchWorkerCommand(runner, command, {indexCache: inlineIndexCache});
        signal?.throwIfAborted();
        return result;
    }

    function run(command: TPdfSearchWorkerCommand, signal?: AbortSignal, options: IRunPdfSearchWorkerOptions = {}): Promise<unknown> {
        if (signal?.aborted) {
            return Promise.reject(getAbortReason(signal));
        }
        let validatedTimeoutMs: number;
        try {
            validatedTimeoutMs = validateTimeoutMs(options.timeoutMs);
        } catch (error) {
            return Promise.reject(error);
        }
        const workerPath = resolveWorkerScriptPath();
        // Unbuilt Vitest unit runs execute the exact same WASM module inline when
        // dist-electron/pdf-search-worker.js has not been bundled yet.
        if (!existsSync(workerPath)) {
            if (__dirname.includes('app.asar')) {
                return Promise.reject(new Error(`evb-pdf-search worker is missing: ${workerPath}`));
            }
            return runInlineFallback(command, signal);
        }
        return new Promise((resolve, reject) => {
            const task: IQueuedTask = {
                command,
                workerPath,
                signal,
                timeoutMs: validatedTimeoutMs,
                resolve,
                reject,
            };
            if (signal) {
                task.onAbort = () => {
                    const index = queue.indexOf(task);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        reject(getAbortReason(signal));
                    }
                };
                signal.addEventListener('abort', task.onAbort, {once: true});
            }
            queue.push(task);
            pumpQueue();
        });
    }

    function shutdown(): Promise<void> {
        const shutdownError = new Error('Search worker pool shut down');
        for (const task of queue.splice(0)) {
            if (task.onAbort) {
                task.signal?.removeEventListener('abort', task.onAbort);
            }
            task.reject(shutdownError);
        }
        for (const cancelStartup of [...activeStartupCancels]) {
            cancelStartup(shutdownError);
        }
        for (const entry of [...workers]) {
            if (entry.cancelActiveTask) {
                entry.cancelActiveTask(shutdownError);
            } else {
                void destroyWorker(entry);
            }
        }
        if (inlineRunnerPromise) {
            void inlineRunnerPromise.then((runner) => runner.dispose()).catch(() => undefined);
            inlineRunnerPromise = null;
        }
        inlineIndexCache.evict();
        return Promise.allSettled([...pendingTeardowns]).then(() => undefined);
    }

    function evictCache(indexPath?: string) {
        inlineIndexCache.evict(indexPath);
        sendEvictControlToWorkers(indexPath);
    }

    return {
        run,
        shutdown,
        evictCache,
    };
}

const searchWorkerPool = createSearchWorkerPool();

export function runPdfSearchWorkerCommand(
    command: TPdfSearchWorkerCommand,
    signal?: AbortSignal,
    options: IRunPdfSearchWorkerOptions = {},
) {
    return searchWorkerPool.run(command, signal, options);
}

export function evictPdfSearchWorkerIndexCache(indexPath?: string) {
    searchWorkerPool.evictCache(indexPath);
}

export function shutdownPdfSearchWorkers(): Promise<void> {
    return searchWorkerPool.shutdown();
}
