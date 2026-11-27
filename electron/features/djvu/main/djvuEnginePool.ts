import { existsSync } from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as electron from 'electron';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';
import { abortErrorFromSignal } from '@electron/utils/abort';
import type {
    IDjvuEngineWorkerData,
    TDjvuEngineResultMap,
    TDjvuEngineWorkerReply,
    TDjvuEngineWorkerRequest,
} from '@electron/features/djvu/main/djvuEngineProtocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_IDLE_TTL_MS = 60_000;
const ENGINE_TASK_TIMEOUT_MS = 3 * 60 * 1000;
const ENGINE_HIGH_WATER_HEAP_BYTES = 256 * 1024 * 1024;
const WORKER_RESOURCE_LIMITS = {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 64,
    stackSizeMb: 4,
};

type TDjvuEngineRequestPayloadMap = {
    [TRequest in TDjvuEngineWorkerRequest as TRequest['type']]: Omit<TRequest, 'id'>;
};

interface IDjvuPoolWorker {
    worker: Worker;
    busy: boolean;
    ending: boolean;
    heapBytes: number;
    idleTimer?: NodeJS.Timeout;
}

/** The DjVuLibre WASM engine bundled beside the renderer (unpacked from ASAR in packaged builds). */
export function resolveDjvuEngineDir() {
    if ((electron as { app?: { isPackaged?: boolean } }).app?.isPackaged === true) {
        return join(process.resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm');
    }
    const candidates = [
        join(__dirname, '..', 'public', 'wasm'),
        join(process.cwd(), 'public', 'wasm'),
        join(__dirname, '..', '..', '..', '..', 'public', 'wasm'),
    ];
    return candidates.find(dir => existsSync(join(dir, 'evb-djvulibre.wasm'))) ?? candidates[0]!;
}

function resolveDjvuEngineWorkerPath() {
    const primary = resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID['djvu-engine'].fileName);
    if (existsSync(primary) || (electron as { app?: { isPackaged?: boolean } }).app?.isPackaged === true) {
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

    private endWorker(entry: IDjvuPoolWorker) {
        if (entry.ending) {return;}
        entry.ending = true;
        entry.busy = true;
        clearTimeout(entry.idleTimer);
        void entry.worker.terminate().catch(() => undefined).finally(() => {
            this.workers.delete(entry);
            this.wakeWaiter();
        });
    }

    private parkWorker(entry: IDjvuPoolWorker) {
        if (entry.ending || this.closed || entry.heapBytes > ENGINE_HIGH_WATER_HEAP_BYTES) {
            this.endWorker(entry);
            return;
        }
        entry.busy = false;
        entry.idleTimer = setTimeout(() => this.endWorker(entry), ENGINE_IDLE_TTL_MS);
        entry.idleTimer.unref();
        this.wakeWaiter();
    }

    private spawnWorker(): IDjvuPoolWorker {
        const workerPath = resolveDjvuEngineWorkerPath();
        const worker = new Worker(workerPath, {
            workerData: { engineDir: resolveDjvuEngineDir() } satisfies IDjvuEngineWorkerData,
            resourceLimits: WORKER_RESOURCE_LIMITS,
        });
        const entry: IDjvuPoolWorker = {
            worker,
            busy: true,
            ending: false,
            heapBytes: 0,
        };
        worker.on('error', () => this.endWorker(entry));
        worker.on('exit', () => this.endWorker(entry));
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
            const idle = [...this.workers].find(entry => !entry.busy && !entry.ending);
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
                    if (idx >= 0) {this.waiters.splice(idx, 1);}
                    resolveWaiter();
                };
                this.waiters.push(wake);
                signal?.addEventListener('abort', wake, { once: true });
            });
        }
    }

    public async request<TType extends TDjvuEngineWorkerRequest['type']>(
        payload: TDjvuEngineRequestPayloadMap[TType] & { type: TType },
        options: {
            signal?: AbortSignal;
            timeoutMs?: number;
        } = {},
    ): Promise<TDjvuEngineResultMap[TType]> {
        const {
            signal,
            timeoutMs = ENGINE_TASK_TIMEOUT_MS,
        } = options;
        const entry = await this.acquire(signal);
        const id = this.nextId++;
        const { worker } = entry;

        return new Promise<TDjvuEngineResultMap[TType]>((resolvePromise, rejectPromise) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                worker.off('message', onMessage);
                worker.off('error', onError);
                worker.off('exit', onExit);
            };
            const finish = (error: Error | null, result?: TDjvuEngineResultMap[TType]) => {
                if (settled) {return;}
                settled = true;
                cleanup();
                if (error) {rejectPromise(error);}
                else {resolvePromise(result as TDjvuEngineResultMap[TType]);}
            };
            const onMessage = (reply: TDjvuEngineWorkerReply) => {
                if (!reply || reply.id !== id) {return;}
                entry.heapBytes = reply.heapBytes;
                this.parkWorker(entry);
                if (reply.ok) {
                    finish(null, reply.result as TDjvuEngineResultMap[TType]);
                } else {
                    finish(createWorkerError(reply.error, reply.errorName));
                }
            };
            const onError = (error: Error) => {
                this.endWorker(entry);
                finish(new Error(`DjVu engine worker failed: ${error.message}`, { cause: error }));
            };
            const onExit = (code: number) => {
                this.endWorker(entry);
                finish(new Error(`DjVu engine worker exited with code ${code}`));
            };
            const onAbort = () => {
                this.endWorker(entry);
                finish(signal ? abortErrorFromSignal(signal) : new DOMException('DjVu operation canceled', 'AbortError'));
            };
            const timer = setTimeout(() => {
                this.endWorker(entry);
                finish(new Error('DjVuLibre engine timed out'));
            }, timeoutMs);
            timer.unref();

            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.on('exit', onExit);
            signal?.addEventListener('abort', onAbort, { once: true });

            if (signal?.aborted) {
                onAbort();
                return;
            }
            worker.postMessage({
                ...payload,
                id,
            });
        });
    }

    public shutdown() {
        this.closed = true;
        for (const entry of [...this.workers]) {
            this.endWorker(entry);
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

export function runDjvuEngine<TType extends TDjvuEngineWorkerRequest['type']>(
    payload: TDjvuEngineRequestPayloadMap[TType] & { type: TType },
    options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    },
): Promise<TDjvuEngineResultMap[TType]> {
    return getPool().request<TType>(payload, options);
}

export function shutdownDjvuEnginePool() {
    sharedPool?.shutdown();
    sharedPool = null;
}
