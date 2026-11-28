import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import * as electron from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';
import {getHostResourceProfileSnapshot} from '@electron/resources/hostResourceProfile';
import {
    getActiveJobBrokerLease,
    getConfiguredMainJobBroker,
    mergeTerminationProofSinks,
    type IJobBrokerRunContext,
    type IJobResourceVector,
    type TTerminationProofSink,
} from '@electron/resources/jobBroker';
import {abortErrorFromSignal} from '@electron/utils/abort';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import type {
    IDjvuEngineWorkerData,
    TDjvuEngineResultMap,
    TDjvuEngineWorkerReply,
    TDjvuEngineWorkerRequest,
} from '@electron/features/djvu/main/djvuEngineProtocol';

const logger = createLogger('djvu-engine-pool');
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_IDLE_TTL_MS = 60_000;
const ENGINE_TASK_TIMEOUT_MS = 3 * 60 * 1000;
const ENGINE_HIGH_WATER_HEAP_BYTES = 256 * 1024 * 1024;
const WORKER_RESOURCE_LIMITS = {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 64,
    stackSizeMb: 4,
};
const DJVU_ENGINE_LEAF_RESOURCES: Readonly<IJobResourceVector> = {
    cpuTokens: 1,
    estimatedResidentBytes: 128 * 1024 * 1024,
    nativeProcesses: 1,
    ioWeight: 1,
};

type TDjvuEngineRequestPayloadMap = {
    [TRequest in TDjvuEngineWorkerRequest as TRequest['type']]: Omit<TRequest, 'id'>;
};

export interface IRunDjvuEngineOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    /**
     * Owning broker run context (`broker`, `lease`, `onTerminationProof`).
     * While `broker.isRunningLease(lease)` holds, the engine runs under that
     * lease instead of taking a fresh `leaf` lease, and forwards worker
     * termination proofs to `brokerRun.onTerminationProof`.
     */
    brokerRun?: IJobBrokerRunContext;
    /** Receives worker termination proof before a canceled/errored request rejects. */
    onTerminationProof?: TTerminationProofSink;
}

interface IDjvuPoolWorker {
    worker: Worker;
    busy: boolean;
    ending: boolean;
    exited: boolean;
    /** Resolves `true` only once the worker has actually exited (used for broker lease accounting). */
    exitProof: Promise<boolean>;
    resolveExitProof: () => void;
    /** Resolves `true` if exit was confirmed during `terminate()`, or `false` if `terminate()` rejected while still alive. */
    terminationAttempt?: Promise<boolean>;
    heapBytes: number;
    idleTimer?: NodeJS.Timeout;
}

/** The DjVuLibre WASM engine bundled beside the renderer (unpacked from ASAR in packaged builds). */
export function resolveDjvuEngineDir() {
    if ((electron as {app?: {isPackaged?: boolean}}).app?.isPackaged === true) {
        return join(process.resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm');
    }
    const candidates = [
        join(__dirname, '..', 'public', 'wasm'),
        join(process.cwd(), 'public', 'wasm'),
        join(__dirname, '..', '..', '..', '..', 'public', 'wasm'),
    ];
    return candidates.find((dir) => existsSync(join(dir, 'evb-djvulibre.wasm'))) ?? candidates[0]!;
}

function resolveDjvuEngineWorkerPath() {
    const primary = resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID['djvu-engine'].fileName);
    if (existsSync(primary) || (electron as {app?: {isPackaged?: boolean}}).app?.isPackaged === true) {
        return primary;
    }
    const fallback = join(process.cwd(), 'dist-electron', WORKER_BUNDLES_BY_ID['djvu-engine'].fileName);
    return existsSync(fallback) ? fallback : primary;
}

function getPoolSize() {
    return getHostResourceProfileSnapshot().tier === 'low' ? 1 : 2;
}

function createWorkerError(message: string, name?: string) {
    if (name === 'RangeError') {
        return new RangeError(message);
    }
    if (name === 'AbortError') {
        return new DOMException(message, 'AbortError');
    }
    const error = new Error(message);
    if (name) {
        error.name = name;
    }
    return error;
}

class DjvuEnginePool {
    private readonly workers = new Set<IDjvuPoolWorker>();
    private readonly waiters: Array<() => void> = [];
    private nextId = 1;
    private closed = false;

    private wakeWaiter() {
        this.waiters.shift()?.();
    }

    private endWorker(entry: IDjvuPoolWorker): {terminationAttempt: Promise<boolean>; exitProof: Promise<boolean>} {
        if (entry.terminationAttempt) {
            return {
                terminationAttempt: entry.terminationAttempt,
                exitProof: entry.exitProof,
            };
        }
        entry.ending = true;
        entry.busy = true;
        clearTimeout(entry.idleTimer);
        if (entry.exited) {
            entry.resolveExitProof();
            this.workers.delete(entry);
            this.wakeWaiter();
            entry.terminationAttempt = Promise.resolve(true);
            return {
                terminationAttempt: entry.terminationAttempt,
                exitProof: entry.exitProof,
            };
        }
        entry.terminationAttempt = new Promise<boolean>((resolveAttempt) => {
            let done = false;
            const settle = (proven: boolean) => {
                if (done) {
                    return;
                }
                done = true;
                entry.worker.off('exit', onWorkerExit);
                if (proven) {
                    entry.exited = true;
                    entry.resolveExitProof();
                    if (this.workers.delete(entry)) {
                        this.wakeWaiter();
                    }
                }
                resolveAttempt(proven);
            };
            const onWorkerExit = () => settle(true);
            entry.worker.once('exit', onWorkerExit);
            if (entry.exited) {
                settle(true);
                return;
            }
            Promise.resolve()
                .then(() => entry.worker.terminate())
                .then(
                    () => settle(true),
                    (error) => {
                        logger.warn('DjVu engine worker termination failed', {
                            error: getErrorMessage(error),
                        });
                        settle(entry.exited);
                    },
                );
        });
        return {
            terminationAttempt: entry.terminationAttempt,
            exitProof: entry.exitProof,
        };
    }

    private parkWorker(entry: IDjvuPoolWorker) {
        if (entry.ending || this.closed || entry.heapBytes > ENGINE_HIGH_WATER_HEAP_BYTES) {
            void this.endWorker(entry);
            return;
        }
        entry.busy = false;
        entry.idleTimer = setTimeout(() => {
            void this.endWorker(entry);
        }, ENGINE_IDLE_TTL_MS);
        entry.idleTimer.unref();
        this.wakeWaiter();
    }

    private spawnWorker(): IDjvuPoolWorker {
        const workerPath = resolveDjvuEngineWorkerPath();
        const worker = new Worker(workerPath, {
            workerData: {engineDir: resolveDjvuEngineDir()} satisfies IDjvuEngineWorkerData,
            resourceLimits: WORKER_RESOURCE_LIMITS,
        });
        const exitDeferred = Promise.withResolvers<boolean>();
        const entry: IDjvuPoolWorker = {
            worker,
            busy: true,
            ending: false,
            exited: false,
            exitProof: exitDeferred.promise,
            resolveExitProof: () => exitDeferred.resolve(true),
            heapBytes: 0,
        };
        worker.on('error', () => {
            void this.endWorker(entry);
        });
        worker.on('exit', () => {
            entry.exited = true;
            entry.resolveExitProof();
            if (entry.ending) {
                if (this.workers.delete(entry)) {
                    this.wakeWaiter();
                }
            } else {
                void this.endWorker(entry);
            }
        });
        this.workers.add(entry);
        return entry;
    }

    private async acquire(signal?: AbortSignal): Promise<IDjvuPoolWorker> {
        for (;;) {
            if (signal?.aborted) {
                throw abortErrorFromSignal(signal);
            }
            if (this.closed) {
                throw new Error('The DjVu engine pool was shut down');
            }
            const idle = [...this.workers].find((entry) => !entry.busy && !entry.ending);
            if (idle) {
                clearTimeout(idle.idleTimer);
                idle.busy = true;
                return idle;
            }
            if (this.workers.size < getPoolSize()) {
                return this.spawnWorker();
            }
            await new Promise<void>((resolveWaiter) => {
                const wake = () => {
                    signal?.removeEventListener('abort', wake);
                    const idx = this.waiters.indexOf(wake);
                    if (idx >= 0) {
                        this.waiters.splice(idx, 1);
                    }
                    resolveWaiter();
                };
                this.waiters.push(wake);
                signal?.addEventListener('abort', wake, {once: true});
            });
        }
    }

    public async request<TType extends TDjvuEngineWorkerRequest['type']>(
        payload: TDjvuEngineRequestPayloadMap[TType] & {type: TType},
        options: {
            signal?: AbortSignal;
            timeoutMs?: number;
            onTerminationProof?: TTerminationProofSink;
        } = {},
    ): Promise<TDjvuEngineResultMap[TType]> {
        const {signal, timeoutMs = ENGINE_TASK_TIMEOUT_MS, onTerminationProof} = options;
        const entry = await this.acquire(signal);
        const id = this.nextId++;
        const {worker} = entry;

        return new Promise<TDjvuEngineResultMap[TType]>((resolvePromise, rejectPromise) => {
            let settled = false;
            let terminating = false;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                worker.off('message', onMessage);
                worker.off('error', onError);
                worker.off('exit', onExit);
            };
            const finish = (error: Error | null, result?: TDjvuEngineResultMap[TType]) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    rejectPromise(error);
                } else {
                    resolvePromise(result as TDjvuEngineResultMap[TType]);
                }
            };
            const failAfterExit = (baseError: Error) => {
                if (settled || terminating) {
                    return;
                }
                terminating = true;
                cleanup();
                const {terminationAttempt, exitProof} = this.endWorker(entry);
                // Keep the broker lease charged until the worker actually exits (even after a late exit
                // following a rejected terminate()), while settling the caller once the termination attempt completes.
                onTerminationProof?.(exitProof);
                void terminationAttempt.then((proven) => {
                    const finalError = proven
                        ? baseError
                        : markUnprovenNativeTermination(baseError, 'DjVu engine worker termination could not be confirmed');
                    finish(finalError);
                });
            };
            const onMessage = (reply: TDjvuEngineWorkerReply) => {
                if (!reply || reply.id !== id) {
                    return;
                }
                entry.heapBytes = reply.heapBytes;
                this.parkWorker(entry);
                if (reply.ok) {
                    finish(null, reply.result as TDjvuEngineResultMap[TType]);
                } else {
                    finish(createWorkerError(reply.error, reply.errorName));
                }
            };
            const onError = (error: Error) => {
                failAfterExit(new Error(`DjVu engine worker failed: ${error.message}`, {cause: error}));
            };
            const onExit = (code: number) => {
                entry.exited = true;
                failAfterExit(new Error(`DjVu engine worker exited with code ${code}`));
            };
            const onAbort = () => {
                failAfterExit(signal ? abortErrorFromSignal(signal) : new DOMException('DjVu operation canceled', 'AbortError'));
            };
            const timer = setTimeout(() => {
                failAfterExit(new Error('DjVuLibre engine timed out'));
            }, timeoutMs);
            timer.unref();

            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.on('exit', onExit);
            signal?.addEventListener('abort', onAbort, {once: true});

            if (signal?.aborted) {
                this.parkWorker(entry);
                finish(abortErrorFromSignal(signal));
                return;
            }
            try {
                worker.postMessage({
                    ...payload,
                    id,
                });
            } catch (error) {
                failAfterExit(error instanceof Error ? error : new Error(getErrorMessage(error)));
            }
        });
    }

    public shutdown() {
        this.closed = true;
        for (const entry of [...this.workers]) {
            void this.endWorker(entry);
        }
        for (const wake of this.waiters.splice(0)) {
            wake();
        }
    }
}

let sharedPool: DjvuEnginePool | null = null;

function getPool() {
    sharedPool ??= new DjvuEnginePool();
    return sharedPool;
}

export async function runDjvuEngine<TType extends TDjvuEngineWorkerRequest['type']>(
    payload: TDjvuEngineRequestPayloadMap[TType] & {type: TType},
    options?: IRunDjvuEngineOptions,
): Promise<TDjvuEngineResultMap[TType]> {
    const signal = options?.signal;
    const timeoutMs = options?.timeoutMs;
    const configuredBroker = getConfiguredMainJobBroker();
    const heldLease = getActiveJobBrokerLease(options?.brokerRun, configuredBroker ?? undefined);
    const callerTerminationProof =
        heldLease === undefined
            ? options?.onTerminationProof
            : mergeTerminationProofSinks(options?.brokerRun?.onTerminationProof, options?.onTerminationProof);

    if (heldLease !== undefined || configuredBroker === null) {
        return getPool().request<TType>(payload, {
            ...(signal === undefined ? {} : {signal}),
            ...(timeoutMs === undefined ? {} : {timeoutMs}),
            ...(callerTerminationProof === undefined ? {} : {onTerminationProof: callerTerminationProof}),
        });
    }

    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    let admitted = false;
    try {
        return await configuredBroker.run(
            {
                ownerId: 'djvu-engine',
                kind: 'djvu-engine',
                priority: 'user',
                admissionClass: 'leaf',
                resources: DJVU_ENGINE_LEAF_RESOURCES,
                ...(signal === undefined ? {} : {signal}),
            },
            ({onTerminationProof}) => {
                admitted = true;
                const mergedProof = mergeTerminationProofSinks(onTerminationProof, options?.onTerminationProof);
                return getPool().request<TType>(payload, {
                    ...(signal === undefined ? {} : {signal}),
                    ...(timeoutMs === undefined ? {} : {timeoutMs}),
                    ...(mergedProof === undefined ? {} : {onTerminationProof: mergedProof}),
                });
            },
        );
    } catch (error) {
        throw !admitted && signal?.aborted ? abortErrorFromSignal(signal) : error;
    }
}

export function shutdownDjvuEnginePool() {
    sharedPool?.shutdown();
    sharedPool = null;
}
