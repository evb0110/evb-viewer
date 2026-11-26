import {existsSync} from 'node:fs';
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
    createPdfSearchWasmRunner,
    loadPdfSearchWasmModule,
    PdfSearchNativeError,
} from '@electron/features/search/pdfSearchWasmRunner';
import {
    executePdfSearchWorkerCommand,
    type TPdfSearchWorkerCommand,
} from '@electron/features/search/pdfSearchWorkerOps';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_WARM_WORKERS = 2;
const WORKER_IDLE_TTL_MS = 30_000;

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
    idleTimer: NodeJS.Timeout | null;
}

interface IQueuedTask {
    command: TPdfSearchWorkerCommand;
    signal: AbortSignal | undefined;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
}

function getAbortReason(signal: AbortSignal) {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function decodeWorkerError(reply: IWorkerReply) {
    const message = typeof reply.error === 'string' && reply.error.length > 0
        ? reply.error
        : 'evb-pdf-search worker failed';
    if (
        typeof reply.nativeErrorCode === 'string'
        && (NATIVE_ERROR_CODES as readonly string[]).includes(reply.nativeErrorCode)
    ) {
        return new PdfSearchNativeError(reply.nativeErrorCode, message);
    }
    return new Error(message);
}

function createSearchWorkerPool() {
    const workers = new Set<IWarmSearchWorker>();
    const queue: IQueuedTask[] = [];
    let nextRequestId = 0;
    let inlineRunnerPromise: Promise<ReturnType<typeof createPdfSearchWasmRunner>> | null = null;

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

    function destroyWorker(entry: IWarmSearchWorker) {
        if (entry.closed) {
            return;
        }
        entry.closed = true;
        clearIdleTimer(entry);
        workers.delete(entry);
        void entry.worker.terminate().catch(() => undefined);
    }

    function scheduleIdleEviction(entry: IWarmSearchWorker) {
        clearIdleTimer(entry);
        if (entry.closed || entry.busy) {
            return;
        }
        entry.idleTimer = setTimeout(() => {
            if (!entry.busy) {
                destroyWorker(entry);
            }
        }, WORKER_IDLE_TTL_MS);
        entry.idleTimer.unref();
    }

    function pumpQueue() {
        while (queue.length > 0) {
            const idle = [...workers].find(entry => !entry.busy && !entry.closed);
            if (!idle && workers.size >= MAX_WARM_WORKERS) {
                return;
            }
            const next = queue.shift()!;
            if (next.onAbort) {
                next.signal?.removeEventListener('abort', next.onAbort);
            }
            if (next.signal?.aborted) {
                next.reject(getAbortReason(next.signal));
                continue;
            }
            if (idle) {
                dispatchToWorker(idle, next);
                continue;
            }
            // Reserve a worker slot immediately so concurrent callers do not exceed MAX_WARM_WORKERS.
            void startWorkerAndDispatch(next);
        }
    }

    async function startWorkerAndDispatch(task: IQueuedTask) {
        const workerPath = resolveWorkerScriptPath();
        let entry: IWarmSearchWorker | null = null;
        try {
            const wasmModule = await loadPdfSearchWasmModule();
            if (task.signal?.aborted) {
                task.reject(getAbortReason(task.signal));
                pumpQueue();
                return;
            }
            const worker = new Worker(workerPath, {workerData: {wasmModule}});
            entry = {
                worker,
                busy: true,
                closed: false,
                idleTimer: null,
            };
            workers.add(entry);
            dispatchToWorker(entry, task);
        } catch (error) {
            if (entry) {
                destroyWorker(entry);
            }
            task.reject(error);
            pumpQueue();
        }
    }

    function dispatchToWorker(entry: IWarmSearchWorker, task: IQueuedTask) {
        entry.busy = true;
        clearIdleTimer(entry);
        const requestId = ++nextRequestId;
        let settled = false;

        const cleanup = () => {
            entry.worker.off('message', onMessage);
            entry.worker.off('error', onError);
            entry.worker.off('exit', onExit);
            task.signal?.removeEventListener('abort', onAbort);
        };

        const finishSuccess = (data: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            entry.busy = false;
            task.resolve(data);
            if (queue.length > 0) {
                pumpQueue();
            } else {
                scheduleIdleEviction(entry);
            }
        };

        const finishError = (error: unknown, terminateWorker: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (terminateWorker) {
                destroyWorker(entry);
            } else {
                entry.busy = false;
                scheduleIdleEviction(entry);
            }
            task.reject(error);
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
            finishError(new Error(`evb-pdf-search worker exited unexpectedly with code ${code}`), true);
        };

        const onAbort = () => {
            // Terminating the busy worker interrupts synchronous WASM execution immediately.
            finishError(getAbortReason(task.signal!), true);
        };

        entry.worker.on('message', onMessage);
        entry.worker.on('error', onError);
        entry.worker.on('exit', onExit);
        if (task.signal) {
            if (task.signal.aborted) {
                onAbort();
                return;
            }
            task.signal.addEventListener('abort', onAbort, {once: true});
        }

        const transferList: ArrayBuffer[] = [];
        if (
            (commandHasBuffer(task.command))
            && task.command.pagesBuffer.buffer instanceof ArrayBuffer
            && task.command.pagesBuffer.byteOffset === 0
            && task.command.pagesBuffer.byteLength === task.command.pagesBuffer.buffer.byteLength
        ) {
            transferList.push(task.command.pagesBuffer.buffer);
        }
        try {
            entry.worker.postMessage({
                id: requestId,
                command: task.command,
            }, transferList);
        } catch (error) {
            finishError(error, true);
        }
    }

    function commandHasBuffer(command: TPdfSearchWorkerCommand): command is Extract<TPdfSearchWorkerCommand, {pagesBuffer: Uint8Array}> {
        return command.op === 'index' || command.op === 'searchPages';
    }

    async function runInlineFallback(command: TPdfSearchWorkerCommand, signal: AbortSignal | undefined) {
        signal?.throwIfAborted();
        const runner = await (inlineRunnerPromise ??= loadPdfSearchWasmModule().then(wasmModule => createPdfSearchWasmRunner(wasmModule)));
        signal?.throwIfAborted();
        const result = await executePdfSearchWorkerCommand(runner, command);
        signal?.throwIfAborted();
        return result;
    }

    function run(command: TPdfSearchWorkerCommand, signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) {
            return Promise.reject(getAbortReason(signal));
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
                signal,
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

    function shutdown() {
        for (const task of queue.splice(0)) {
            if (task.onAbort) {
                task.signal?.removeEventListener('abort', task.onAbort);
            }
            task.reject(new Error('Search worker pool shut down'));
        }
        for (const entry of [...workers]) {
            destroyWorker(entry);
        }
        if (inlineRunnerPromise) {
            void inlineRunnerPromise.then(runner => runner.dispose()).catch(() => undefined);
            inlineRunnerPromise = null;
        }
    }

    return {
        run,
        shutdown,
    };
}

const searchWorkerPool = createSearchWorkerPool();

export function runPdfSearchWorkerCommand(
    command: TPdfSearchWorkerCommand,
    signal?: AbortSignal,
) {
    return searchWorkerPool.run(command, signal);
}

export function shutdownPdfSearchWorkers() {
    searchWorkerPool.shutdown();
}
