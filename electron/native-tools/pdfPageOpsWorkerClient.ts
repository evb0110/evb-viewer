import {
    existsSync,
    statSync,
} from 'node:fs';
import {
    truncate,
    unlink,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {
    NATIVE_ERROR_CODES,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {
    createPdfPageOpsWasmRunner,
    createTempSiblingPath,
    executeDesktopPageOpsCommand,
    inspectDesktopPageOpsWriteTarget,
    loadPdfPageOpsWasmModule,
    PdfPageOpsNativeError,
    type IPdfPageOpsWasmRunner,
} from '@node-runtime/pdfPageOpsWasmRunner';
import type {IProcessResult} from '@electron/native-tools/processResult';
import {createAbortError} from '@electron/utils/abort';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_WARM_WORKERS = 2;
const WORKER_IDLE_TTL_MS = 30_000;
// Matches DEFAULT_NATIVE_COMMAND_TIMEOUT_MS in runNativeCommand.ts (15 minutes).
const DEFAULT_PAGE_OPS_TIMEOUT_MS = 15 * 60 * 1_000;

interface IAbortedWriteRollback {
    stagedOutputPath?: string;
    inPlaceTarget?: {
        path: string;
        originalLen: number;
    };
}

interface IWorkerReply {
    id: number;
    ok: boolean;
    data?: IProcessResult;
    error?: string;
    nativeErrorCode?: TNativeErrorCode;
}

interface IWarmPageOpsWorker {
    wasmPath: string;
    worker: Worker;
    busy: boolean;
    closed: boolean;
    idleTimer: NodeJS.Timeout | null;
    visibilitySessions: Set<number>;
}

interface IQueuedTask {
    wasmPath: string;
    args: string[];
    visibilitySessionId: number | undefined;
    closeVisibilitySessionId: number | undefined;
    targetWorker?: IWarmPageOpsWorker;
    signal: AbortSignal | undefined;
    timeoutMs: number | undefined;
    cancelGroup: string | undefined;
    commandLabel: string | undefined;
    maxStdoutBytes: number | undefined;
    rejectOnStdoutTruncation: boolean | undefined;
    onTerminationProof: ((proof: Promise<boolean>) => void) | undefined;
    resolve: (value: IProcessResult) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
    onCancelGroup?: () => Promise<boolean>;
}

function parseVisibilitySessionArgs(args: readonly string[]): {
    visibilitySessionId: number | undefined;
    closeVisibilitySessionId: number | undefined;
} {
    if (args[0] !== 'ocr-text-visibility') {
        return {
            visibilitySessionId: undefined,
            closeVisibilitySessionId: undefined,
        };
    }
    let visibilitySessionId: number | undefined;
    let closeVisibilitySessionId: number | undefined;
    for (let i = 1; i + 1 < args.length; i += 1) {
        if (args[i] === '--session-id') {
            const parsed = Number(args[i + 1]);
            if (Number.isSafeInteger(parsed) && parsed > 0) visibilitySessionId = parsed;
            i += 1;
        } else if (args[i] === '--close-session') {
            const parsed = Number(args[i + 1]);
            if (Number.isSafeInteger(parsed) && parsed > 0) closeVisibilitySessionId = parsed;
            i += 1;
        }
    }
    return {
        visibilitySessionId,
        closeVisibilitySessionId,
    };
}

export interface IRunDesktopPageOpsWasmOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    cancelGroup?: string;
    commandLabel?: string;
    maxStdoutBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    onTerminationProof?: (proof: Promise<boolean>) => void;
}

function getAbortReason(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : createAbortError(typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted');
}

function decodeWorkerError(reply: IWorkerReply) {
    const message = typeof reply.error === 'string' && reply.error.length > 0
        ? reply.error
        : 'evb-pdf-page-ops worker failed';
    if (
        typeof reply.nativeErrorCode === 'string'
        && (NATIVE_ERROR_CODES as readonly string[]).includes(reply.nativeErrorCode)
    ) {
        return new PdfPageOpsNativeError(reply.nativeErrorCode, message);
    }
    return new Error(message);
}

function applyStdoutLimit(
    result: IProcessResult,
    maxStdoutBytes: number | undefined,
    rejectOnStdoutTruncation: boolean | undefined,
    commandLabel: string | undefined,
): IProcessResult {
    if (maxStdoutBytes === undefined) {
        return result;
    }
    const byteLength = Buffer.byteLength(result.stdout, 'utf8');
    if (byteLength <= maxStdoutBytes) {
        return result;
    }
    if (rejectOnStdoutTruncation) {
        throw new Error(`${commandLabel ?? 'evb-pdf-page-ops'} stdout exceeded ${maxStdoutBytes} bytes`);
    }
    return {
        ...result,
        stdout: Buffer.from(result.stdout, 'utf8').subarray(0, maxStdoutBytes).toString('utf8'),
    };
}

function prepareAbortedWriteRollback(args: readonly string[]): IAbortedWriteRollback {
    const target = inspectDesktopPageOpsWriteTarget(args);
    if (!target) {
        return {};
    }
    if (target.kind === 'in-place') {
        try {
            const st = statSync(target.path);
            if (st.isFile()) {
                return {
                    inPlaceTarget: {
                        path: target.path,
                        originalLen: st.size,
                    },
                };
            }
        } catch {
            // File may not exist or be unreadable; worker will fail cleanly.
        }
        return {};
    }
    return {stagedOutputPath: createTempSiblingPath(target.outputPath)};
}

async function rollbackAbortedWrite(rollback: IAbortedWriteRollback) {
    if (rollback.inPlaceTarget) {
        try {
            await truncate(rollback.inPlaceTarget.path, rollback.inPlaceTarget.originalLen);
        } catch {
            // Best-effort rollback of interrupted in-place append.
        }
    }
    if (rollback.stagedOutputPath) {
        try {
            await unlink(rollback.stagedOutputPath);
        } catch {
            // Staging file may not have been created or already renamed.
        }
    }
}

function createPageOpsWorkerPool() {
    const workers = new Set<IWarmPageOpsWorker>();
    let startingWorkers = 0;
    const activeStartupCancels = new Set<(reason: unknown) => Promise<boolean>>();
    const pendingGroupProofs = new Map<string, Set<Promise<boolean>>>();
    const queue: IQueuedTask[] = [];
    const activeCancelHandlers = new Map<string, Set<() => Promise<boolean>>>();
    const inlineRunners = new Map<string, Promise<IPdfPageOpsWasmRunner>>();
    let nextRequestId = 0;

    function trackPendingGroupProof(cancelGroup: string | undefined, proof: Promise<boolean>) {
        if (!cancelGroup) return;
        let proofs = pendingGroupProofs.get(cancelGroup);
        if (!proofs) {
            proofs = new Set();
            pendingGroupProofs.set(cancelGroup, proofs);
        }
        proofs.add(proof);
        void proof.finally(() => {
            const current = pendingGroupProofs.get(cancelGroup);
            if (!current) return;
            current.delete(proof);
            if (current.size === 0) {
                pendingGroupProofs.delete(cancelGroup);
            }
        });
    }

    function registerCancel(cancelGroup: string | undefined, handler: () => Promise<boolean>) {
        if (!cancelGroup) return;
        let handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers) {
            handlers = new Set();
            activeCancelHandlers.set(cancelGroup, handlers);
        }
        handlers.add(handler);
    }

    function unregisterCancel(cancelGroup: string | undefined, handler: () => Promise<boolean>) {
        if (!cancelGroup) return;
        const handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers) return;
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

    function clearIdleTimer(entry: IWarmPageOpsWorker) {
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
    }

    function destroyWorker(entry: IWarmPageOpsWorker): Promise<boolean> {
        if (entry.closed) {
            return Promise.resolve(true);
        }
        entry.closed = true;
        entry.visibilitySessions.clear();
        clearIdleTimer(entry);
        workers.delete(entry);
        return entry.worker.terminate().then(() => true, () => false);
    }

    function scheduleIdleEviction(entry: IWarmPageOpsWorker) {
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

    function pumpQueue() {
        let index = 0;
        while (index < queue.length) {
            const next = queue[index]!;
            if (next.targetWorker !== undefined) {
                const target = next.targetWorker;
                if (target.closed || !workers.has(target)) {
                    queue.splice(index, 1);
                    if (next.onAbort) {
                        next.signal?.removeEventListener('abort', next.onAbort);
                    }
                    if (next.onCancelGroup) {
                        unregisterCancel(next.cancelGroup, next.onCancelGroup);
                    }
                    next.resolve({
                        stdout: '{}',
                        stderr: '',
                        exitCode: 0,
                    });
                    continue;
                }
                if (target.busy) {
                    index += 1;
                    continue;
                }
                queue.splice(index, 1);
                if (next.onAbort) {
                    next.signal?.removeEventListener('abort', next.onAbort);
                }
                if (next.onCancelGroup) {
                    unregisterCancel(next.cancelGroup, next.onCancelGroup);
                }
                if (next.signal?.aborted) {
                    next.reject(getAbortReason(next.signal));
                    continue;
                }
                dispatchToWorker(target, next);
                continue;
            }
            const targetSessionId = next.visibilitySessionId ?? next.closeVisibilitySessionId;
            const idleSameSession = targetSessionId === undefined
                ? undefined
                : [...workers].find(
                    entry => !entry.busy && !entry.closed && entry.wasmPath === next.wasmPath
                        && entry.visibilitySessions.has(targetSessionId),
                );
            const idleSamePath = idleSameSession ?? [...workers].find(
                entry => !entry.busy && !entry.closed && entry.wasmPath === next.wasmPath,
            );
            const idleAny = idleSamePath ?? [...workers].find(entry => !entry.busy && !entry.closed);
            const activeSlots = workers.size + startingWorkers;
            if (!idleSamePath && activeSlots >= MAX_WARM_WORKERS) {
                if (idleAny) {
                    void destroyWorker(idleAny);
                } else {
                    index += 1;
                    continue;
                }
            }
            queue.splice(index, 1);
            if (next.onAbort) {
                next.signal?.removeEventListener('abort', next.onAbort);
            }
            if (next.onCancelGroup) {
                unregisterCancel(next.cancelGroup, next.onCancelGroup);
            }
            if (next.signal?.aborted) {
                next.reject(getAbortReason(next.signal));
                continue;
            }
            if (idleSamePath) {
                dispatchToWorker(idleSamePath, next);
                continue;
            }
            // Reserve the slot synchronously before awaiting WASM compilation so a
            // burst of cold-start calls never exceeds MAX_WARM_WORKERS.
            startingWorkers += 1;
            void startWorkerAndDispatch(next);
        }
    }

    async function startWorkerAndDispatch(task: IQueuedTask) {
        const workerPath = resolveWorkerScriptPath();
        let entry: IWarmPageOpsWorker | null = null;
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
            task.signal?.removeEventListener('abort', onStartupAbort);
            unregisterCancel(task.cancelGroup, onStartupCancelGroup);
        };

        const cancelDuringStartup = (reason: unknown): Promise<boolean> => {
            if (startupSettled) {
                return Promise.resolve(true);
            }
            startupSettled = true;
            cleanupStartupCancel();
            releaseStartupSlot();
            const proof = Promise.resolve(true);
            task.onTerminationProof?.(proof);
            task.reject(reason);
            pumpQueue();
            return proof;
        };

        const onStartupAbort = () => {
            void cancelDuringStartup(getAbortReason(task.signal!));
        };

        const onStartupCancelGroup = () => cancelDuringStartup(createAbortError('Operation canceled'));

        activeStartupCancels.add(cancelDuringStartup);
        registerCancel(task.cancelGroup, onStartupCancelGroup);
        if (task.signal) {
            if (task.signal.aborted) {
                onStartupAbort();
                return;
            }
            task.signal.addEventListener('abort', onStartupAbort, {once: true});
        }

        try {
            const wasmModule = await loadPdfPageOpsWasmModule(task.wasmPath);
            if (startupSettled) {
                return;
            }
            if (task.signal?.aborted) {
                onStartupAbort();
                return;
            }
            const worker = new Worker(workerPath, {workerData: {wasmModule}});
            entry = {
                wasmPath: task.wasmPath,
                worker,
                busy: true,
                closed: false,
                idleTimer: null,
                visibilitySessions: new Set(),
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
            cleanupStartupCancel();
            releaseStartupSlot();
            if (entry) {
                void destroyWorker(entry);
            }
            task.reject(error);
            pumpQueue();
        }
    }

    function dispatchToWorker(entry: IWarmPageOpsWorker, task: IQueuedTask) {
        entry.busy = true;
        clearIdleTimer(entry);
        if (task.visibilitySessionId !== undefined) {
            entry.visibilitySessions.add(task.visibilitySessionId);
        }
        const requestId = ++nextRequestId;
        const rollback = prepareAbortedWriteRollback(task.args);
        let settled = false;
        let terminationProofPromise: Promise<boolean> | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const cleanup = () => {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            entry.worker.off('message', onMessage);
            entry.worker.off('error', onError);
            entry.worker.off('exit', onExit);
            task.signal?.removeEventListener('abort', onAbort);
            unregisterCancel(task.cancelGroup, onCancelGroup);
        };

        const finishSuccess = (data: IProcessResult) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (task.closeVisibilitySessionId !== undefined) {
                entry.visibilitySessions.delete(task.closeVisibilitySessionId);
            }
            entry.busy = false;
            try {
                const checked = applyStdoutLimit(
                    data,
                    task.maxStdoutBytes,
                    task.rejectOnStdoutTruncation,
                    task.commandLabel,
                );
                task.resolve(checked);
            } catch (error) {
                task.reject(error);
            }
            if (queue.length > 0) {
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
                // Keep termination and rollback under this main-thread owner:
                // wait for the worker to actually stop writing before rolling
                // back any in-place append or staging sibling and rejecting.
                const proof = destroyWorker(entry).then(async terminated => {
                    if (terminated) {
                        await rollbackAbortedWrite(rollback);
                    }
                    return terminated;
                });
                terminationProofPromise = proof;
                trackPendingGroupProof(task.cancelGroup, proof);
                task.onTerminationProof?.(proof);
                void proof.finally(() => {
                    task.reject(error);
                    pumpQueue();
                });
                return proof;
            }
            entry.busy = false;
            scheduleIdleEviction(entry);
            task.reject(error);
            pumpQueue();
            return Promise.resolve(true);
        };

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
            void finishError(new Error(`evb-pdf-page-ops worker exited unexpectedly with code ${code}`), true);
        };

        const onAbort = () => {
            void finishError(getAbortReason(task.signal!), true);
        };

        const onCancelGroup = () => finishError(createAbortError('Operation canceled'), true);

        entry.worker.on('message', onMessage);
        entry.worker.on('error', onError);
        entry.worker.on('exit', onExit);
        registerCancel(task.cancelGroup, onCancelGroup);
        if (task.signal) {
            if (task.signal.aborted) {
                onAbort();
                return;
            }
            task.signal.addEventListener('abort', onAbort, {once: true});
        }
        const effectiveTimeoutMs = task.timeoutMs === undefined
            ? DEFAULT_PAGE_OPS_TIMEOUT_MS
            : task.timeoutMs;
        if (effectiveTimeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                void finishError(
                    new Error(`${task.commandLabel ?? 'evb-pdf-page-ops'} timed out after ${effectiveTimeoutMs}ms`),
                    true,
                );
            }, effectiveTimeoutMs);
            timeoutHandle.unref();
        }

        try {
            entry.worker.postMessage({
                id: requestId,
                args: task.args,
                ...(rollback.stagedOutputPath === undefined ? {} : {stagedOutputPath: rollback.stagedOutputPath}),
            });
        } catch (error) {
            void finishError(error, true);
        }
    }

    async function runInlineFallback(
        wasmPath: string,
        args: string[],
        options: IRunDesktopPageOpsWasmOptions,
    ): Promise<IProcessResult> {
        options.signal?.throwIfAborted();
        let runnerPromise = inlineRunners.get(wasmPath);
        if (!runnerPromise) {
            runnerPromise = loadPdfPageOpsWasmModule(wasmPath)
                .then(mod => createPdfPageOpsWasmRunner(mod))
                .catch((error: unknown) => {
                    if (inlineRunners.get(wasmPath) === runnerPromise) {
                        inlineRunners.delete(wasmPath);
                    }
                    throw error;
                });
            inlineRunners.set(wasmPath, runnerPromise);
        }
        const runner = await runnerPromise;
        options.signal?.throwIfAborted();
        const result = executeDesktopPageOpsCommand(runner, args);
        options.signal?.throwIfAborted();
        return applyStdoutLimit(
            result,
            options.maxStdoutBytes,
            options.rejectOnStdoutTruncation,
            options.commandLabel,
        );
    }

    function run(
        wasmPath: string,
        args: string[],
        options: IRunDesktopPageOpsWasmOptions = {},
    ): Promise<IProcessResult> {
        if (options.signal?.aborted) {
            return Promise.reject(getAbortReason(options.signal));
        }
        const workerPath = resolveWorkerScriptPath();
        // Unbuilt Vitest unit runs execute the exact same WASM module inline when
        // dist-electron/pdf-page-ops-worker.js has not been bundled yet.
        if (!existsSync(workerPath)) {
            if (__dirname.includes('app.asar')) {
                return Promise.reject(new Error(`evb-pdf-page-ops worker is missing: ${workerPath}`));
            }
            return runInlineFallback(wasmPath, args, options);
        }
        const {
            visibilitySessionId,
            closeVisibilitySessionId,
        } = parseVisibilitySessionArgs(args);
        const enqueueTask = (targetWorker?: IWarmPageOpsWorker) => new Promise<IProcessResult>((resolve, reject) => {
            const task: IQueuedTask = {
                wasmPath,
                args: [...args],
                visibilitySessionId,
                closeVisibilitySessionId,
                ...(targetWorker === undefined ? {} : {targetWorker}),
                signal: options.signal,
                timeoutMs: options.timeoutMs,
                cancelGroup: options.cancelGroup,
                commandLabel: options.commandLabel,
                maxStdoutBytes: options.maxStdoutBytes,
                rejectOnStdoutTruncation: options.rejectOnStdoutTruncation,
                onTerminationProof: options.onTerminationProof,
                resolve,
                reject,
            };
            const removeFromQueue = (reason: unknown): Promise<boolean> => {
                const index = queue.indexOf(task);
                if (index >= 0) {
                    queue.splice(index, 1);
                    if (task.onAbort) {
                        task.signal?.removeEventListener('abort', task.onAbort);
                    }
                    if (task.onCancelGroup) {
                        unregisterCancel(task.cancelGroup, task.onCancelGroup);
                    }
                    const proof = Promise.resolve(true);
                    task.onTerminationProof?.(proof);
                    reject(reason);
                    return proof;
                }
                return Promise.resolve(true);
            };
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

        if (closeVisibilitySessionId !== undefined) {
            const holders = [...workers].filter(
                entry => !entry.closed && entry.wasmPath === wasmPath && entry.visibilitySessions.has(closeVisibilitySessionId),
            );
            if (holders.length === 0) {
                return Promise.resolve({
                    stdout: '{}',
                    stderr: '',
                    exitCode: 0,
                });
            }
            return Promise.all(holders.map(holder => enqueueTask(holder))).then(() => ({
                stdout: '{}',
                stderr: '',
                exitCode: 0,
            }));
        }
        return enqueueTask();
    }

    function cancelGroup(cancelGroup: string) {
        const handlers = activeCancelHandlers.get(cancelGroup);
        if (!handlers || handlers.size === 0) {
            return false;
        }
        for (const handler of [...handlers]) {
            void handler();
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
            for (const handler of [...handlers]) {
                proofs.push(handler());
            }
        }
        const results = await Promise.all(proofs);
        return results.every(Boolean);
    }

    function shutdown() {
        const shutdownError = new Error('PDF page-ops worker pool shut down');
        for (const cancelStartup of [...activeStartupCancels]) {
            void cancelStartup(shutdownError);
        }
        for (const task of queue.splice(0)) {
            if (task.onAbort) {
                task.signal?.removeEventListener('abort', task.onAbort);
            }
            if (task.onCancelGroup) {
                unregisterCancel(task.cancelGroup, task.onCancelGroup);
            }
            task.reject(shutdownError);
        }
        for (const entry of [...workers]) {
            void destroyWorker(entry);
        }
        for (const runnerPromise of inlineRunners.values()) {
            void runnerPromise.then(runner => runner.dispose()).catch(() => undefined);
        }
        inlineRunners.clear();
    }

    return {
        run,
        cancelGroup,
        cancelGroupAndWait,
        shutdown,
    };
}

const pageOpsWorkerPool = createPageOpsWorkerPool();

export function runDesktopPageOpsWasm(
    wasmPath: string,
    args: string[],
    options: IRunDesktopPageOpsWasmOptions = {},
) {
    return pageOpsWorkerPool.run(wasmPath, args, options);
}

export function cancelDesktopPageOpsWasmGroup(cancelGroup: string) {
    return pageOpsWorkerPool.cancelGroup(cancelGroup);
}

export function cancelDesktopPageOpsWasmGroupAndWait(cancelGroup: string): Promise<boolean | null> {
    return pageOpsWorkerPool.cancelGroupAndWait(cancelGroup);
}

export function shutdownPdfPageOpsWorkers() {
    pageOpsWorkerPool.shutdown();
}
