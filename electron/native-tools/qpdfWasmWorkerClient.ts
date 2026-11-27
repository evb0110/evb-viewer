import {existsSync, renameSync} from 'node:fs';
import {unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {NATIVE_ERROR_CODES, type TNativeErrorCode} from '@contracts/nativeErrors';
import {createTempSiblingPath, PdfPageOpsNativeError} from '@node-runtime/pdfPageOpsWasmRunner';
import {
    executeDesktopQpdfCommand,
    inspectDesktopQpdfWriteTarget,
    loadQpdfModuleFactory,
    loadQpdfWasmModule,
    resolveDesktopQpdfMjsPath,
    resolveDesktopQpdfWasmPath,
    type IExecuteDesktopQpdfOptions,
} from '@node-runtime/qpdfWasmRunner';
import type {IProcessResult} from '@electron/native-tools/processResult';
import {createAbortError} from '@electron/utils/abort';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_WARM_WORKERS = 2;
const WORKER_IDLE_TTL_MS = 30_000;
const DEFAULT_QPDF_TIMEOUT_MS = 15 * 60 * 1_000;

interface IWorkerReply {
    id: number;
    ok: boolean;
    data?: IProcessResult;
    error?: string;
    nativeErrorCode?: TNativeErrorCode;
    exitCode?: number;
}

interface IWarmQpdfWorker {
    wasmPath: string;
    worker: Worker;
    busy: boolean;
    closed: boolean;
    idleTimer: NodeJS.Timeout | null;
}

export interface IRunDesktopQpdfWasmOptions {
    wasmPath?: string;
    allowedExitCodes?: readonly number[];
    cwd?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    cancelGroup?: string;
    commandLabel?: string;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    onTerminationProof?: (proof: Promise<boolean>) => void;
}

interface IQueuedQpdfTask {
    wasmPath: string;
    args: string[];
    options: IRunDesktopQpdfWasmOptions;
    deadlineMs: number | null;
    effectiveTimeoutMs: number;
    deadlineTimer: NodeJS.Timeout | null;
    timedOut: boolean;
    cancelActive: ((reason: unknown) => Promise<boolean>) | null;
    resolve: (value: IProcessResult) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
    onCancelGroup?: () => Promise<boolean>;
}

function getAbortReason(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : createAbortError(typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted');
}

function decodeWorkerError(reply: IWorkerReply) {
    const message = typeof reply.error === 'string' && reply.error.length > 0 ? reply.error : 'evb-qpdf.wasm worker failed';
    if (typeof reply.nativeErrorCode === 'string' && (NATIVE_ERROR_CODES as readonly string[]).includes(reply.nativeErrorCode)) {
        return new PdfPageOpsNativeError(reply.nativeErrorCode, message);
    }
    const error = new Error(message) as Error & {
        exitCode?: number;
        code?: number;
    };
    if (typeof reply.exitCode === 'number') {
        error.exitCode = reply.exitCode;
        error.code = reply.exitCode;
    }
    return error;
}

async function cleanupStagedOutput(stagedOutputPath: string | undefined) {
    if (!stagedOutputPath) {
        return;
    }
    try {
        await unlink(stagedOutputPath);
    } catch {
        // Staging file may not have been created or already renamed.
    }
}

function buildWorkerExecuteOptions(
    options: IRunDesktopQpdfWasmOptions,
    stagedOutputPath: string | undefined,
    deferPublish: boolean,
): IExecuteDesktopQpdfOptions {
    return {
        ...(options.allowedExitCodes === undefined ? {} : {allowedExitCodes: [...options.allowedExitCodes]}),
        ...(options.commandLabel === undefined ? {} : {commandLabel: options.commandLabel}),
        ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
        ...(deferPublish ? {deferPublish: true} : {}),
        ...(options.maxStdoutBytes === undefined ? {} : {maxStdoutBytes: options.maxStdoutBytes}),
        ...(options.maxStderrBytes === undefined ? {} : {maxStderrBytes: options.maxStderrBytes}),
        ...(options.rejectOnStdoutTruncation === undefined ? {} : {rejectOnStdoutTruncation: options.rejectOnStdoutTruncation}),
        ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
    };
}

function createQpdfWorkerPool() {
    const workers = new Set<IWarmQpdfWorker>();
    let startingWorkers = 0;
    let shuttingDown = false;
    let suspendPumpDepth = 0;
    const activeStartupCancels = new Set<(reason: unknown) => Promise<boolean>>();
    const activeDispatchCancels = new Set<(reason: unknown) => Promise<boolean>>();
    const pendingGroupProofs = new Map<string, Set<Promise<boolean>>>();
    const pendingCleanupPromises = new Set<Promise<unknown>>();
    const queue: IQueuedQpdfTask[] = [];
    const activeCancelHandlers = new Map<string, Set<() => Promise<boolean>>>();
    let nextRequestId = 0;

    function trackPendingCleanup<T>(promise: Promise<T>): Promise<T> {
        pendingCleanupPromises.add(promise);
        void promise.finally(() => {
            pendingCleanupPromises.delete(promise);
        });
        return promise;
    }

    function clearTaskDeadline(task: IQueuedQpdfTask) {
        if (task.deadlineTimer !== null) {
            clearTimeout(task.deadlineTimer);
            task.deadlineTimer = null;
        }
    }

    function trackPendingGroupProof(cancelGroup: string | undefined, proof: Promise<boolean>) {
        if (!cancelGroup) {
            return;
        }
        let proofs = pendingGroupProofs.get(cancelGroup);
        if (!proofs) {
            proofs = new Set();
            pendingGroupProofs.set(cancelGroup, proofs);
        }
        proofs.add(proof);
        void proof.finally(() => {
            const current = pendingGroupProofs.get(cancelGroup);
            if (!current) {
                return;
            }
            current.delete(proof);
            if (current.size === 0) {
                pendingGroupProofs.delete(cancelGroup);
            }
        });
    }

    function registerCancel(cancelGroup: string | undefined, handler: () => Promise<boolean>) {
        if (!cancelGroup) {
            return;
        }
        let handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers) {
            handlers = new Set();
            activeCancelHandlers.set(cancelGroup, handlers);
        }
        handlers.add(handler);
    }

    function unregisterCancel(cancelGroup: string | undefined, handler: () => Promise<boolean>) {
        if (!cancelGroup) {
            return;
        }
        const handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers) {
            return;
        }
        handlers.delete(handler);
        if (handlers.size === 0) {
            activeCancelHandlers.delete(cancelGroup);
        }
    }

    function resolveWorkerScriptPath() {
        const fileName = WORKER_BUNDLES_BY_ID['pdf-page-ops'].fileName;
        const primary = resolveUnpackedWorkerPath(__dirname, fileName);
        if (existsSync(primary) || __dirname.includes('app.asar')) {
            return primary;
        }
        const devBundle = join(process.cwd(), 'dist-electron', fileName);
        return existsSync(devBundle) ? devBundle : primary;
    }

    function clearIdleTimer(entry: IWarmQpdfWorker) {
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    function destroyWorker(entry: IWarmQpdfWorker): Promise<boolean> {
        if (entry.closed) {
            return Promise.resolve(true);
        }
        entry.closed = true;
        clearIdleTimer(entry);
        workers.delete(entry);
        return trackPendingCleanup(
            entry.worker.terminate().then(
                () => true,
                () => false,
            ),
        );
    }

    function scheduleIdleEviction(entry: IWarmQpdfWorker) {
        clearIdleTimer(entry);
        if (entry.closed || entry.busy) {
            return;
        }
        entry.worker.unref();
        entry.idleTimer = setTimeout(() => {
            if (!entry.busy) {
                void destroyWorker(entry);
            }
        }, WORKER_IDLE_TTL_MS);
        entry.idleTimer.unref();
    }

    function pumpQueue() {
        if (shuttingDown || suspendPumpDepth > 0) {
            return;
        }
        while (!shuttingDown && suspendPumpDepth === 0 && queue.length > 0) {
            const next = queue[0]!;
            const idleSamePath = [...workers].find((entry) => !entry.busy && !entry.closed && entry.wasmPath === next.wasmPath);
            const idleAny = idleSamePath ?? [...workers].find((entry) => !entry.busy && !entry.closed);
            const activeSlots = workers.size + startingWorkers;
            if (!idleSamePath && activeSlots >= MAX_WARM_WORKERS) {
                if (idleAny) {
                    void destroyWorker(idleAny);
                } else {
                    return;
                }
            }
            queue.shift();
            next.cancelActive = null;
            if (next.onAbort) {
                next.options.signal?.removeEventListener('abort', next.onAbort);
            }
            if (next.onCancelGroup) {
                unregisterCancel(next.options.cancelGroup, next.onCancelGroup);
            }
            if (next.timedOut) {
                continue;
            }
            if (next.options.signal?.aborted) {
                clearTaskDeadline(next);
                next.reject(getAbortReason(next.options.signal));
                continue;
            }
            if (idleSamePath) {
                dispatchToWorker(idleSamePath, next);
                continue;
            }
            startingWorkers += 1;
            void startWorkerAndDispatch(next);
        }
    }

    async function startWorkerAndDispatch(task: IQueuedQpdfTask) {
        const workerPath = resolveWorkerScriptPath();
        let entry: IWarmQpdfWorker | null = null;
        let slotReleased = false;
        let startupSettled = false;

        const releaseStartupSlot = () => {
            if (!slotReleased) {
                slotReleased = true;
                startingWorkers = Math.max(0, startingWorkers - 1);
            }
        };

        const cleanupStartupCancel = () => {
            activeStartupCancels.delete(cancelDuringStartup);
            if (task.cancelActive === cancelDuringStartup) {
                task.cancelActive = null;
            }
            task.options.signal?.removeEventListener('abort', onStartupAbort);
            unregisterCancel(task.options.cancelGroup, onStartupCancelGroup);
        };

        const cancelDuringStartup = (reason: unknown): Promise<boolean> => {
            if (startupSettled) {
                return Promise.resolve(true);
            }
            startupSettled = true;
            clearTaskDeadline(task);
            cleanupStartupCancel();
            releaseStartupSlot();
            const proof = Promise.resolve(true);
            task.options.onTerminationProof?.(proof);
            task.reject(reason);
            pumpQueue();
            return proof;
        };

        const onStartupAbort = () => {
            void cancelDuringStartup(getAbortReason(task.options.signal!));
        };

        const onStartupCancelGroup = () => cancelDuringStartup(createAbortError('Operation canceled'));

        task.cancelActive = cancelDuringStartup;
        activeStartupCancels.add(cancelDuringStartup);
        registerCancel(task.options.cancelGroup, onStartupCancelGroup);
        if (task.timedOut || shuttingDown) {
            void cancelDuringStartup(
                task.timedOut
                    ? new Error(`${task.options.commandLabel ?? 'qpdf'} timed out after ${task.effectiveTimeoutMs}ms`)
                    : new Error('qpdf WASM worker pool shut down'),
            );
            return;
        }
        if (task.options.signal) {
            if (task.options.signal.aborted) {
                onStartupAbort();
                return;
            }
            task.options.signal.addEventListener('abort', onStartupAbort, {once: true});
        }

        try {
            const wasmModule = await loadQpdfWasmModule(task.wasmPath);
            if (startupSettled || shuttingDown || task.timedOut) {
                if (!startupSettled) {
                    void cancelDuringStartup(
                        task.timedOut
                            ? new Error(`${task.options.commandLabel ?? 'qpdf'} timed out after ${task.effectiveTimeoutMs}ms`)
                            : new Error('qpdf WASM worker pool shut down'),
                    );
                }
                return;
            }
            if (task.options.signal?.aborted) {
                onStartupAbort();
                return;
            }
            const worker = new Worker(workerPath, {
                workerData: {
                    kind: 'qpdf',
                    wasmModule,
                    mjsPath: resolveDesktopQpdfMjsPath(task.wasmPath),
                },
            });
            // Keep a worker-lifetime error listener so late errors emitted while
            // terminating after cleanup() never become uncaught host exceptions.
            worker.on('error', () => undefined);
            entry = {
                wasmPath: task.wasmPath,
                worker,
                busy: true,
                closed: false,
                idleTimer: null,
            };
            startupSettled = true;
            cleanupStartupCancel();
            workers.add(entry);
            releaseStartupSlot();
            dispatchToWorker(entry, task);
        } catch (error) {
            if (startupSettled) {
                if (entry) {
                    void destroyWorker(entry);
                }
                return;
            }
            startupSettled = true;
            clearTaskDeadline(task);
            cleanupStartupCancel();
            releaseStartupSlot();
            if (entry) {
                void destroyWorker(entry);
            }
            task.reject(error);
            pumpQueue();
        }
    }

    function dispatchToWorker(entry: IWarmQpdfWorker, task: IQueuedQpdfTask) {
        entry.busy = true;
        entry.worker.ref();
        clearIdleTimer(entry);
        const requestId = ++nextRequestId;
        const writeTarget = inspectDesktopQpdfWriteTarget(task.args, task.options.cwd);
        const stagedOutputPath = writeTarget ? createTempSiblingPath(writeTarget.outputPath) : undefined;
        let settled = false;
        let terminationProofPromise: Promise<boolean> | null = null;

        const cleanup = () => {
            clearTaskDeadline(task);
            activeDispatchCancels.delete(cancelDispatched);
            if (task.cancelActive === cancelDispatched) {
                task.cancelActive = null;
            }
            entry.worker.off('message', onMessage);
            entry.worker.off('error', onError);
            entry.worker.off('exit', onExit);
            task.options.signal?.removeEventListener('abort', onAbort);
            unregisterCancel(task.options.cancelGroup, onCancelGroup);
        };

        const finishSuccess = (data: IProcessResult) => {
            if (settled) {
                void trackPendingCleanup(cleanupStagedOutput(stagedOutputPath));
                return;
            }
            if (task.options.signal?.aborted) {
                void finishError(getAbortReason(task.options.signal), false);
                return;
            }
            if (shuttingDown) {
                void finishError(new Error('qpdf WASM worker pool shut down'), true);
                return;
            }
            if (writeTarget && stagedOutputPath) {
                try {
                    renameSync(stagedOutputPath, writeTarget.outputPath);
                } catch (error) {
                    void finishError(error, false);
                    return;
                }
            }
            settled = true;
            cleanup();
            entry.busy = false;
            task.resolve(data);
            if (queue.length > 0 && !shuttingDown) {
                pumpQueue();
            } else {
                scheduleIdleEviction(entry);
            }
        };

        const finishError = (error: unknown, terminateWorker: boolean): Promise<boolean> => {
            if (settled) {
                return terminationProofPromise ?? Promise.resolve(true);
            }
            settled = true;
            cleanup();
            if (terminateWorker) {
                const proof = trackPendingCleanup(
                    destroyWorker(entry).then(async (terminated) => {
                        if (terminated) {
                            await cleanupStagedOutput(stagedOutputPath);
                        }
                        return terminated;
                    }),
                );
                terminationProofPromise = proof;
                trackPendingGroupProof(task.options.cancelGroup, proof);
                task.options.onTerminationProof?.(proof);
                void proof.finally(() => {
                    task.reject(error);
                    pumpQueue();
                });
                return proof;
            }
            const proof = trackPendingCleanup(cleanupStagedOutput(stagedOutputPath).then(() => true));
            terminationProofPromise = proof;
            entry.busy = false;
            scheduleIdleEviction(entry);
            void proof.finally(() => {
                task.reject(error);
                pumpQueue();
            });
            return proof;
        };

        const cancelDispatched = (reason: unknown) => finishError(reason, true);

        const onMessage = (reply: IWorkerReply) => {
            if (!reply || typeof reply !== 'object' || reply.id !== requestId) {
                return;
            }
            if (reply.ok && reply.data) {
                finishSuccess(reply.data);
            } else {
                void finishError(decodeWorkerError(reply), false);
            }
        };

        const onError = (error: Error) => {
            void finishError(error, true);
        };

        const onExit = (code: number) => {
            void finishError(new Error(`evb-qpdf.wasm worker exited unexpectedly with code ${code}`), true);
        };

        const onAbort = () => {
            void finishError(getAbortReason(task.options.signal!), true);
        };

        const onCancelGroup = () => finishError(createAbortError('Operation canceled'), true);

        task.cancelActive = cancelDispatched;
        activeDispatchCancels.add(cancelDispatched);
        entry.worker.on('message', onMessage);
        entry.worker.on('error', onError);
        entry.worker.on('exit', onExit);
        registerCancel(task.options.cancelGroup, onCancelGroup);
        if (task.timedOut || shuttingDown) {
            void finishError(
                task.timedOut
                    ? new Error(`${task.options.commandLabel ?? 'qpdf'} timed out after ${task.effectiveTimeoutMs}ms`)
                    : new Error('qpdf WASM worker pool shut down'),
                true,
            );
            return;
        }
        if (task.options.signal) {
            if (task.options.signal.aborted) {
                onAbort();
                return;
            }
            task.options.signal.addEventListener('abort', onAbort, {once: true});
        }

        try {
            entry.worker.postMessage({
                id: requestId,
                args: task.args,
                options: buildWorkerExecuteOptions(task.options, stagedOutputPath, stagedOutputPath !== undefined),
            });
        } catch (error) {
            void finishError(error, true);
        }
    }

    async function runInlineFallback(wasmPath: string, args: string[], options: IRunDesktopQpdfWasmOptions): Promise<IProcessResult> {
        options.signal?.throwIfAborted();
        const [wasmModule, factory] = await Promise.all([
            loadQpdfWasmModule(wasmPath),
            loadQpdfModuleFactory(resolveDesktopQpdfMjsPath(wasmPath)),
        ]);
        options.signal?.throwIfAborted();
        const result = await executeDesktopQpdfCommand(wasmModule, factory, args, buildWorkerExecuteOptions(options, undefined, false));
        options.signal?.throwIfAborted();
        return result;
    }

    function run(args: string[], options: IRunDesktopQpdfWasmOptions = {}): Promise<IProcessResult> {
        if (shuttingDown) {
            return Promise.reject(new Error('qpdf WASM worker pool shut down'));
        }
        if (options.signal?.aborted) {
            return Promise.reject(getAbortReason(options.signal));
        }
        const wasmPath =
            options.wasmPath ??
            resolveDesktopQpdfWasmPath({
                currentDir: __dirname,
                isPackaged: __dirname.includes('app.asar'),
            });
        if (!wasmPath) {
            return Promise.reject(new PdfPageOpsNativeError('native-failure', 'evb-qpdf.wasm was not found'));
        }
        const workerPath = resolveWorkerScriptPath();
        if (!existsSync(workerPath)) {
            if (process.env.VITEST === 'true' && !__dirname.includes('app.asar')) {
                return runInlineFallback(wasmPath, args, options);
            }
            return Promise.reject(new Error(`evb-qpdf.wasm worker is missing: ${workerPath}`));
        }
        const effectiveTimeoutMs = options.timeoutMs === undefined ? DEFAULT_QPDF_TIMEOUT_MS : options.timeoutMs;
        const deadlineMs = effectiveTimeoutMs > 0 ? Date.now() + effectiveTimeoutMs : null;
        return new Promise((resolve, reject) => {
            const task: IQueuedQpdfTask = {
                wasmPath,
                args: [...args],
                options,
                deadlineMs,
                effectiveTimeoutMs,
                deadlineTimer: null,
                timedOut: false,
                cancelActive: null,
                resolve,
                reject,
            };
            const removeFromQueue = (reason: unknown): Promise<boolean> => {
                const index = queue.indexOf(task);
                if (index >= 0) {
                    queue.splice(index, 1);
                    clearTaskDeadline(task);
                    task.cancelActive = null;
                    if (task.onAbort) {
                        task.options.signal?.removeEventListener('abort', task.onAbort);
                    }
                    if (task.onCancelGroup) {
                        unregisterCancel(task.options.cancelGroup, task.onCancelGroup);
                    }
                    const proof = Promise.resolve(true);
                    task.options.onTerminationProof?.(proof);
                    reject(reason);
                    return proof;
                }
                return Promise.resolve(true);
            };
            task.cancelActive = removeFromQueue;
            if (deadlineMs !== null) {
                task.deadlineTimer = setTimeout(() => {
                    task.timedOut = true;
                    task.deadlineTimer = null;
                    const timeoutError = new Error(`${options.commandLabel ?? 'qpdf'} timed out after ${effectiveTimeoutMs}ms`);
                    void task.cancelActive?.(timeoutError);
                }, effectiveTimeoutMs);
                task.deadlineTimer.unref();
            }
            if (options.signal) {
                task.onAbort = () => {
                    void removeFromQueue(getAbortReason(options.signal!));
                };
                options.signal.addEventListener('abort', task.onAbort, {once: true});
            }
            if (options.cancelGroup) {
                task.onCancelGroup = () => removeFromQueue(createAbortError('Operation canceled'));
                registerCancel(options.cancelGroup, task.onCancelGroup);
            }
            queue.push(task);
            pumpQueue();
        });
    }

    function cancelGroup(cancelGroup: string) {
        const handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers || handlers.size === 0) {
            return false;
        }
        suspendPumpDepth += 1;
        try {
            for (const handler of [...handlers]) {
                void handler();
            }
        } finally {
            suspendPumpDepth -= 1;
            if (suspendPumpDepth === 0) {
                pumpQueue();
            }
        }
        return true;
    }

    async function cancelGroupAndWait(cancelGroup: string): Promise<boolean | null> {
        const handlers = activeCancelHandlers.get(cancelGroup);
        const existingProofs = pendingGroupProofs.get(cancelGroup);
        if ((!handlers || handlers.size === 0) && (!existingProofs || existingProofs.size === 0)) {
            return null;
        }
        const proofs: Array<Promise<boolean>> = [];
        if (existingProofs) {
            proofs.push(...existingProofs);
        }
        if (handlers) {
            suspendPumpDepth += 1;
            try {
                for (const handler of [...handlers]) {
                    proofs.push(handler());
                }
            } finally {
                suspendPumpDepth -= 1;
                if (suspendPumpDepth === 0) {
                    pumpQueue();
                }
            }
        }
        const results = await Promise.all(proofs);
        return results.every(Boolean);
    }

    async function shutdown(): Promise<void> {
        shuttingDown = true;
        const shutdownError = new Error('qpdf WASM worker pool shut down');
        const cleanupPromises: Array<Promise<unknown>> = [];
        // Drain queued tasks before canceling in-flight work so no queued task
        // can be promoted during shutdown.
        for (const task of queue.splice(0)) {
            clearTaskDeadline(task);
            task.cancelActive = null;
            if (task.onAbort) {
                task.options.signal?.removeEventListener('abort', task.onAbort);
            }
            if (task.onCancelGroup) {
                unregisterCancel(task.options.cancelGroup, task.onCancelGroup);
            }
            const proof = Promise.resolve(true);
            task.options.onTerminationProof?.(proof);
            task.reject(shutdownError);
        }
        for (const cancelStartup of [...activeStartupCancels]) {
            cleanupPromises.push(cancelStartup(shutdownError));
        }
        for (const cancelDispatched of [...activeDispatchCancels]) {
            cleanupPromises.push(cancelDispatched(shutdownError));
        }
        for (const entry of [...workers]) {
            cleanupPromises.push(destroyWorker(entry));
        }
        while (cleanupPromises.length > 0 || pendingCleanupPromises.size > 0) {
            const batch = [...cleanupPromises.splice(0), ...pendingCleanupPromises];
            await Promise.allSettled(batch);
        }
        shuttingDown = false;
    }

    return {
        run,
        cancelGroup,
        cancelGroupAndWait,
        shutdown,
    };
}

const qpdfWorkerPool = createQpdfWorkerPool();

export function resolveDesktopQpdfPath() {
    const wasmPath = resolveDesktopQpdfWasmPath({
        currentDir: __dirname,
        isPackaged: __dirname.includes('app.asar'),
    });
    if (!wasmPath) {
        throw new PdfPageOpsNativeError('native-failure', 'evb-qpdf.wasm was not found');
    }
    return wasmPath;
}

/**
 * Single desktop entry point for executing qpdf commands through the pooled
 * worker-backed `evb-qpdf.wasm` runner with virtual paths only.
 */
export function runDesktopQpdfWasm(args: string[], options: IRunDesktopQpdfWasmOptions = {}) {
    return qpdfWorkerPool.run(args, options);
}

export function cancelDesktopQpdfWasmGroup(cancelGroup: string) {
    return qpdfWorkerPool.cancelGroup(cancelGroup);
}

export function cancelDesktopQpdfWasmGroupAndWait(cancelGroup: string): Promise<boolean | null> {
    return qpdfWorkerPool.cancelGroupAndWait(cancelGroup);
}

export function shutdownQpdfWasmWorkers(): Promise<void> {
    return qpdfWorkerPool.shutdown();
}
