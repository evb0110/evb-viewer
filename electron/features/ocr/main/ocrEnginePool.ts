import {
    dirname,
    join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as electron from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import type {IOcrEngineResult} from '@ocr-core/tesseractEngine';
import {
    createOcrEngineHost,
    type IOcrEngineLane,
} from '@electron/features/ocr/main/ocrEngineHostClient';
import {getRuntimeTessdataDir} from '@electron/features/ocr/languageModels';
import {
    createOcrModelBytesReader,
    getOcrRuntimePolicy,
    resolveOcrLaneResources,
    sumOcrModelBytes,
} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {createAbortError} from '@contracts/isAbortError';
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import type {
    IOcrEngineLaneReply,
    TDesktopOcrEngineRequest,
} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import {
    mainJobBroker,
    type IJobBrokerLease,
    type IJobBrokerRequest,
    type JobBroker,
} from '@electron/resources/jobBroker';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A worker keeps its engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// One Tesseract pass may run three minutes, as in the browser.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;

interface IEngineWorker {
    worker: IOcrEngineLane | null;
    busy: boolean;
    /** Termination was requested or the worker exited; it takes no more passes. */
    ending: boolean;
    exited: boolean;
    idleTimer?: NodeJS.Timeout;
    /**
     * The most memory a pass on this worker has needed. WebAssembly memory
     * never shrinks and loaded models stay, so the worker holds it until it
     * exits, idle or not.
     */
    residentBytes: number;
    /** Memory-only leases charging `residentBytes`, released once the worker has exited. */
    memoryLeases: IJobBrokerLease[];
    /** The installed bytes of every model the worker's engine has read and keeps. */
    cachedModels: Map<TOcrModelCode, number>;
    /**
     * The pass request this worker waits on. While the broker still queues it
     * the worker runs nothing, so work short of memory may end it like an idle
     * one; once granted, even before the pass's code continues, it may not.
     */
    admission: {
        controller: AbortController;
        request: IJobBrokerRequest;
    } | null;
}

// Ends a pass's wait for the broker when its worker exited meanwhile.
const WORKER_EXITED = new Error('OCR worker exited while its pass waited');
// Ends a pass's wait for the broker when its worker was asked to stop
// meanwhile, to free memory, after an error or because the pool shut down.
const WORKER_ENDED = new Error('OCR worker was ended while its pass waited');

export interface IOcrEnginePoolOptions {
    size: () => number;
    /** Where the installed models are, to charge each pass for the ones it loads. */
    tessdataDir: string;
    /** Starts a worker: an engine lane in the OCR utility process. */
    startLane: () => IOcrEngineLane;
    /** The broker charged for each worker: a core while it runs a pass, its memory until it exits. */
    broker: JobBroker;
}

/**
 * Engine lanes running the shared engine, one warm engine each, never in the
 * main process; on desktop they are worker threads in the OCR utility process.
 * Canceling or a pass past its time limit ends the busy worker, since a
 * worker inside Tesseract cannot read messages. The pool owns
 * each worker's broker charge: a pass holds a core and any memory it adds,
 * the worker keeps its memory charged while idle, and the charge ends when
 * the worker has exited. A pass needs what its own models and page need plus
 * the other models its engine still keeps. Queued work short of memory ends
 * idle workers and warm workers waiting for more memory; a pass whose worker
 * was ended that way starts again on a fresh one.
 */
export function createOcrEnginePool(options: IOcrEnginePoolOptions) {
    const {broker} = options;
    const workers = new Set<IEngineWorker>();
    const waiters: Array<() => void> = [];
    const readModelBytes = createOcrModelBytesReader(options.tessdataDir);
    let nextId = 0;
    // A shut-down pool starts no workers, so a pass retrying after its worker
    // ended fails instead of leaving an orphan.
    let closed = false;

    const wakeWaiter = () => {
        waiters.shift()?.();
    };

    const releaseMemory = (entry: IEngineWorker) => {
        for (const lease of entry.memoryLeases.splice(0)) lease.release();
    };

    const exited = (entry: IEngineWorker) => {
        entry.ending = true;
        entry.exited = true;
        clearTimeout(entry.idleTimer);
        workers.delete(entry);
        releaseMemory(entry);
        // A message to an exited worker is dropped silently, so its queued
        // pass must not be granted to it; it starts again on a fresh one.
        entry.admission?.controller.abort(WORKER_EXITED);
        wakeWaiter();
    };

    // Asks the worker to stop; its memory stays charged until it has. A pass
    // still queued for it leaves the broker now rather than when the thread
    // exits, which a worker wedged in its engine may never do.
    const end = (entry: IEngineWorker) => {
        if (entry.ending) return;
        entry.ending = true;
        clearTimeout(entry.idleTimer);
        workers.delete(entry);
        entry.admission?.controller.abort(WORKER_ENDED);
        if (entry.worker) {
            void entry.worker.terminate().then(() => exited(entry), () => undefined);
        } else {
            exited(entry);
        }
        wakeWaiter();
    };

    const park = (entry: IEngineWorker) => {
        if (entry.ending || !entry.worker) {
            if (!entry.ending) end(entry);
            else wakeWaiter();
            return;
        }
        entry.busy = false;
        entry.idleTimer = setTimeout(() => end(entry), ENGINE_IDLE_TTL_MS);
        entry.idleTimer.unref();
        wakeWaiter();
    };

    const reclaimIdleWorkers = () => {
        for (const entry of Array.from(workers)) {
            if (!entry.busy) {
                end(entry);
            } else if (
                entry.admission !== null
                && entry.residentBytes > 0
                && broker.isQueued(entry.admission.request)
            ) {
                // Two warm workers each waiting for memory the other holds
                // would otherwise wait for good. Ending it moves its pass to
                // a fresh worker.
                end(entry);
            }
        }
    };
    const unregisterReclaimer = broker.registerMemoryReclaimer(reclaimIdleWorkers);

    const acquire = async (signal: AbortSignal): Promise<IEngineWorker> => {
        for (;;) {
            signal.throwIfAborted();
            if (closed) throw new Error('The OCR engine pool was shut down');
            const idle = [...workers].find(entry => !entry.busy);
            if (idle) {
                clearTimeout(idle.idleTimer);
                idle.busy = true;
                return idle;
            }
            if (workers.size < Math.max(1, options.size())) {
                const entry: IEngineWorker = {
                    worker: null,
                    busy: true,
                    ending: false,
                    exited: false,
                    residentBytes: 0,
                    memoryLeases: [],
                    cachedModels: new Map(),
                    admission: null,
                };
                workers.add(entry);
                return entry;
            }
            await new Promise<void>((resolve) => {
                const wake = () => {
                    signal.removeEventListener('abort', wake);
                    const index = waiters.indexOf(wake);
                    if (index >= 0) waiters.splice(index, 1);
                    resolve();
                };
                waiters.push(wake);
                signal.addEventListener('abort', wake, {once: true});
            });
        }
    };

    // What a pass on this worker needs: its own models and page, and the
    // other models its engine still keeps.
    const resolvePassBytes = (
        entry: IEngineWorker,
        modelSizes: ReadonlyMap<TOcrModelCode, number>,
        workingBytes: number,
    ) => {
        let otherCachedBytes = 0;
        for (const [code, bytes] of entry.cachedModels) {
            if (!modelSizes.has(code)) otherCachedBytes += bytes;
        }
        return Math.min(broker.getSnapshot().capacity.estimatedResidentBytes, workingBytes + otherCachedBytes);
    };

    // A worker and the lease for the core and memory a pass adds to it.
    const admitPass = async (
        signal: AbortSignal,
        ownerId: string,
        modelSizes: ReadonlyMap<TOcrModelCode, number>,
        workingBytes: number,
    ) => {
        for (;;) {
            const entry = await acquire(signal);
            const growth = Math.max(0, resolvePassBytes(entry, modelSizes, workingBytes) - entry.residentBytes);
            const admission = new AbortController();
            const request: IJobBrokerRequest = {
                ownerId,
                kind: 'ocr-engine-pass',
                priority: 'user',
                resources: {
                    cpuTokens: Math.min(1, broker.getSnapshot().capacity.cpuTokens),
                    estimatedResidentBytes: growth,
                    nativeProcesses: 0,
                    ioWeight: 0,
                },
                signal: AbortSignal.any([
                    signal,
                    admission.signal,
                ]),
            };
            entry.admission = {
                controller: admission,
                request,
            };
            let passLease: Awaited<ReturnType<typeof broker.acquire>>;
            try {
                passLease = await broker.acquire(request);
            } catch (error) {
                if (admission.signal.aborted && !signal.aborted) continue;
                park(entry);
                // Its pass left the queue while it was not idle; work that has
                // waited for memory since may now end it.
                broker.recheck();
                throw error;
            } finally {
                entry.admission = null;
            }
            // The grant and caller cancellation can land in one turn before this
            // code resumes; release the lease without spawning a fresh worker.
            if (signal.aborted) {
                passLease.release();
                park(entry);
                broker.recheck();
                signal.throwIfAborted();
                throw createAbortError('OCR pass aborted');
            }
            // The grant and the worker's end can land in one turn, before
            // this code resumes; a pass posted to that worker never runs.
            if (entry.ending || entry.exited) {
                passLease.release();
                continue;
            }
            if (!entry.worker) {
                try {
                    const worker = options.startLane();
                    // An idle worker that fails must not throw into the main process.
                    worker.on('error', () => end(entry));
                    worker.on('exit', () => exited(entry));
                    entry.worker = worker;
                } catch (error) {
                    passLease.release();
                    end(entry);
                    throw error;
                }
            }
            return {
                entry,
                growth,
                passLease,
            };
        }
    };

    return {
        async run(request: TDesktopOcrEngineRequest, signal: AbortSignal, ownerId = 'ocr-engine'): Promise<IOcrEngineResult> {
            const {capacity} = broker.getSnapshot();
            const modelSizes = await readModelBytes(request.models);
            const workingBytes = resolveOcrLaneResources(
                sumOcrModelBytes(modelSizes),
                request.image,
                capacity,
            ).estimatedResidentBytes;
            const {
                entry,
                growth,
                passLease,
            } = await admitPass(signal, ownerId, modelSizes, workingBytes);
            entry.residentBytes += growth;
            // The worker keeps what the pass added and the models it read; the
            // core goes back. It is idle before its charge changes, so work
            // already short of memory may end it at once.
            const keepWorker = () => {
                for (const [code, bytes] of modelSizes) entry.cachedModels.set(code, bytes);
                if (growth > 0) entry.memoryLeases.push(passLease);
                park(entry);
                if (growth > 0) {
                    passLease.shrink({
                        cpuTokens: 0,
                        estimatedResidentBytes: growth,
                        nativeProcesses: 0,
                        ioWeight: 0,
                    });
                } else {
                    passLease.release();
                }
            };
            const discardWorker = () => {
                entry.memoryLeases.push(passLease);
                if (entry.exited) releaseMemory(entry);
                else end(entry);
            };
            const id = nextId++;
            const worker = entry.worker!;
            return new Promise<IOcrEngineResult>((resolve, reject) => {
                const settle = (error: Error | null, result?: IOcrEngineResult) => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    worker.off('message', onMessage);
                    worker.off('error', onError);
                    worker.off('exit', onExit);
                    if (error) reject(error);
                    else resolve(result!);
                };
                const onMessage = (message: IOcrEngineLaneReply) => {
                    if (message.id !== id) return;
                    keepWorker();
                    settle(message.ok ? null : new Error(message.error), message.result);
                };
                const onError = (error: Error) => {
                    discardWorker();
                    settle(new Error(`The OCR engine stopped: ${error.message}`, {cause: error}));
                };
                const onExit = (code: number) => {
                    discardWorker();
                    settle(new Error(`The OCR engine exited with code ${code}`));
                };
                const onAbort = () => {
                    discardWorker();
                    settle(signal.reason instanceof Error ? signal.reason : createAbortError('OCR was canceled'));
                };
                const timer = setTimeout(() => {
                    discardWorker();
                    settle(new Error('Tesseract did not finish within its time limit'));
                }, PASS_TIMEOUT_MS * request.passes.length);
                worker.on('message', onMessage);
                worker.on('error', onError);
                worker.on('exit', onExit);
                signal.addEventListener('abort', onAbort, {once: true});
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                const transfer = request.image instanceof Uint8Array && request.image.buffer instanceof ArrayBuffer
                    ? [request.image.buffer]
                    : [];
                worker.postMessage({
                    id,
                    request,
                }, transfer);
            });
        },
        terminate() {
            closed = true;
            unregisterReclaimer();
            for (const entry of Array.from(workers)) end(entry);
            for (const wake of waiters.splice(0)) wake();
        },
    };
}

let appPool: ReturnType<typeof createOcrEnginePool> | null = null;
let appHost: ReturnType<typeof createOcrEngineHost> | null = null;

/** The engine bundled with the renderer: unpacked beside the app archive, or the repository's public files. */
function resolveOcrEngineDir() {
    return (electron as {app?: {isPackaged?: boolean}}).app?.isPackaged === true
        ? join(process.resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm')
        : join(__dirname, '..', 'public', 'wasm');
}

/**
 * Runs one page's passes on the app's engine pool, sized like desktop's OCR
 * page slots, whose lanes are worker threads in the OCR utility process.
 */
export function runOcrEngine(request: TDesktopOcrEngineRequest, signal: AbortSignal, ownerId?: string) {
    if (!appPool) {
        const tessdataDir = getRuntimeTessdataDir();
        const host = createOcrEngineHost({
            hostPath: resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID['ocr-engine-host'].fileName),
            workerPath: resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID['ocr-engine'].fileName),
            workerData: {
                engineDir: resolveOcrEngineDir(),
                tessdataDir,
            },
        });
        appHost = host;
        appPool = createOcrEnginePool({
            broker: mainJobBroker,
            size: () => getOcrRuntimePolicy().globalPageSlots,
            tessdataDir,
            startLane: () => host.startLane(),
        });
    }
    return appPool.run(request, signal, ownerId);
}

/** Ends every engine lane and asks the OCR utility process to exit now. */
export function shutdownOcrEnginePool() {
    appPool?.terminate();
    appPool = null;
    appHost?.shutdown();
    appHost = null;
}
