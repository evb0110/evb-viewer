import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as electron from 'electron';
import {WORKER_BUNDLES_BY_ID} from '@electron-worker-bundles/electronWorkerBundles.js';
import {resolveTesseractRequestModels, type IOcrEngineResult} from '@ocr-core/tesseractEngine';
import {createOcrEngineHost, type IOcrEngineLane} from '@electron/features/ocr/main/ocrEngineHostClient';
import {getRuntimeTessdataDir} from '@electron/features/ocr/languageModels';
import {
    createOcrModelBytesReader,
    getOcrRuntimePolicy,
    OCR_ENGINE_WASM_HEAP_RECYCLE_BYTES,
    resolveOcrLaneResources,
    sumOcrModelBytes,
} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {createAbortError} from '@contracts/isAbortError';
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import type {IOcrEngineLaneReply, TDesktopOcrEngineRequest} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import {mainJobBroker, type IJobBrokerLease, type IJobBrokerRequest, type JobBroker} from '@electron/resources/jobBroker';
import {getUnprovenNativeTerminationDetail, markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {resolveUnpackedWorkerPath} from '@electron/utils/workerTask';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A worker keeps its engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// One Tesseract pass may run three minutes, as in the browser.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;
// How long a canceled/timed-out/failed pass waits for its lane to confirm exit
// before reporting unproven termination so callers do not unlink open rasters.
const LANE_EXIT_PROOF_TIMEOUT_MS = 5_000;

interface IEngineWorker {
    worker: IOcrEngineLane | null;
    busy: boolean;
    /** Termination was requested or the worker exited; it takes no more passes. */
    ending: boolean;
    exited: boolean;
    exitedDeferred: PromiseWithResolvers<void>;
    exitPromise?: Promise<void>;
    idleTimer?: NodeJS.Timeout;
    underchargedExitTimer?: NodeJS.Timeout | undefined;
    /**
     * The most memory a pass on this worker has needed (or its reported
     * retained WASM heap plus cached models). WebAssembly memory never shrinks
     * and loaded models stay, so the worker holds it until it exits, idle or not.
     */
    residentBytes: number;
    /** Actual retained WASM linear-memory high-water mark reported by the worker thread. */
    retainedWasmBytes: number;
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
// Associates an unproven-termination pass error with its lane's eventual exit
// acknowledgement so callers can defer raster cleanup until the reader exits.
const unprovenLaneExitPromises = new WeakMap<Error, Promise<void>>();

export function getOcrEngineLaneExitPromise(error: unknown): Promise<void> | undefined {
    return error instanceof Error ? unprovenLaneExitPromises.get(error) : undefined;
}

export interface IOcrEnginePoolOptions {
    size: () => number;
    /** Where the installed models are, to charge each pass for the ones it loads. */
    tessdataDir: string;
    /** Starts a worker: an engine lane in the OCR utility process. */
    startLane: () => IOcrEngineLane;
    /** The broker charged for each worker: a core while it runs a pass, its memory until it exits. */
    broker: JobBroker;
    /** Recycle a worker between pages once its retained WASM linear memory exceeds this cap. */
    maxRetainedWasmBytes?: number;
    /** Max wait for lane exit acknowledgement on cancel/timeout/error before marking unproven termination. */
    exitProofTimeoutMs?: number;
    /** Called when an undercharged retiring lane fails to exit within `exitProofTimeoutMs` (e.g. to shut down the host). */
    onStalledUnderchargedLane?: () => void;
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
    const maxRetainedWasmBytes = options.maxRetainedWasmBytes ?? OCR_ENGINE_WASM_HEAP_RECYCLE_BYTES;
    const exitProofTimeoutMs = options.exitProofTimeoutMs ?? LANE_EXIT_PROOF_TIMEOUT_MS;
    const workers = new Set<IEngineWorker>();
    // Undercharged lanes that failed a retained-heap top-up and are exiting;
    // no new OCR pass is admitted into the pool until they exit and free RAM.
    const underchargedExiting = new Set<IEngineWorker>();
    const waiters: Array<() => void> = [];
    const readModelBytes = createOcrModelBytesReader(options.tessdataDir);
    let nextId = 0;
    // A shut-down pool starts no workers, so a pass retrying after its worker
    // ended fails instead of leaving an orphan.
    let closed = false;

    const wakeWaiter = () => {
        waiters.shift()?.();
    };

    const wakeAllWaiters = () => {
        for (const wake of waiters.splice(0)) {
            wake();
        }
    };

    const releaseMemory = (entry: IEngineWorker) => {
        for (const lease of entry.memoryLeases.splice(0)) {
            lease.release();
        }
    };

    const exited = (entry: IEngineWorker) => {
        entry.ending = true;
        entry.exited = true;
        clearTimeout(entry.idleTimer);
        clearTimeout(entry.underchargedExitTimer);
        entry.underchargedExitTimer = undefined;
        workers.delete(entry);
        const clearedUndercharged = underchargedExiting.delete(entry);
        releaseMemory(entry);
        // A message to an exited worker is dropped silently, so its queued
        // pass must not be granted to it; it starts again on a fresh one.
        entry.admission?.controller.abort(WORKER_EXITED);
        entry.exitedDeferred.resolve();
        if (clearedUndercharged && underchargedExiting.size === 0) {
            wakeAllWaiters();
        } else {
            wakeWaiter();
        }
    };

    // Asks the worker to stop; its memory stays charged until it has. A pass
    // still queued for it leaves the broker now rather than when the thread
    // exits, which a worker wedged in its engine may never do. When
    // `keepSlotUntilExit` is set (an undercharged lane recycling after a failed
    // top-up), the pool blocks new admissions until exit (bounded by
    // `exitProofTimeoutMs`, after which `onStalledUnderchargedLane` escalates
    // and the pool gate reopens while the lane's leases stay charged until exit).
    const end = (entry: IEngineWorker, endOptions?: {keepSlotUntilExit?: boolean}): Promise<void> => {
        if (!entry.ending) {
            entry.ending = true;
            clearTimeout(entry.idleTimer);
            const holdGate = Boolean(endOptions?.keepSlotUntilExit);
            if (holdGate) {
                underchargedExiting.add(entry);
            } else {
                workers.delete(entry);
            }
            entry.admission?.controller.abort(WORKER_ENDED);
            if (entry.worker) {
                if (holdGate) {
                    entry.underchargedExitTimer = setTimeout(() => {
                        entry.underchargedExitTimer = undefined;
                        if (entry.exited) {
                            return;
                        }
                        workers.delete(entry);
                        const removed = underchargedExiting.delete(entry);
                        options.onStalledUnderchargedLane?.();
                        if (removed && underchargedExiting.size === 0) {
                            wakeAllWaiters();
                        } else {
                            wakeWaiter();
                        }
                    }, exitProofTimeoutMs);
                    entry.underchargedExitTimer.unref();
                }
                entry.exitPromise = entry.worker.terminate().then(
                    () => exited(entry),
                    () => undefined,
                );
            } else {
                exited(entry);
                entry.exitPromise = Promise.resolve();
            }
            if (!holdGate) {
                wakeWaiter();
            }
        }
        return entry.exitPromise ?? entry.exitedDeferred.promise;
    };

    /**
     * Waits for the terminated lane to acknowledge exit before rejecting a
     * canceled/timed-out/failed pass, so callers never unlink a file-backed
     * raster while the worker thread may still be opening or reading it.
     */
    const waitForLaneExit = async (entry: IEngineWorker): Promise<boolean> => {
        if (entry.exited) {
            return true;
        }
        void end(entry);
        if (entry.exited) {
            return true;
        }
        let proofTimer: NodeJS.Timeout | undefined;
        try {
            const settledBeforeTimeout = await Promise.race([
                entry.exitedDeferred.promise.then(() => true),
                new Promise<boolean>((resolve) => {
                    proofTimer = setTimeout(() => resolve(false), exitProofTimeoutMs);
                    proofTimer.unref();
                }),
            ]);
            return settledBeforeTimeout && entry.exited;
        } finally {
            clearTimeout(proofTimer);
        }
    };

    const park = (entry: IEngineWorker) => {
        if (entry.ending || !entry.worker) {
            if (!entry.ending) {
                end(entry);
            } else {
                wakeWaiter();
            }
            return;
        }
        entry.busy = false;
        entry.idleTimer = setTimeout(() => end(entry), ENGINE_IDLE_TTL_MS);
        entry.idleTimer.unref();
        wakeWaiter();
    };

    const reclaimIdleWorkers = () => {
        for (const entry of Array.from(workers)) {
            if (entry.ending) {
                continue;
            }
            if (!entry.busy) {
                void end(entry);
            } else if (entry.admission !== null && entry.residentBytes > 0 && broker.isQueued(entry.admission.request)) {
                // Two warm workers each waiting for memory the other holds
                // would otherwise wait for good. Ending it moves its pass to
                // a fresh worker.
                void end(entry);
            }
        }
    };
    const unregisterReclaimer = broker.registerMemoryReclaimer(reclaimIdleWorkers);

    const acquire = async (signal: AbortSignal): Promise<IEngineWorker> => {
        for (;;) {
            signal.throwIfAborted();
            if (closed) {
                throw new Error('The OCR engine pool was shut down');
            }
            if (underchargedExiting.size === 0) {
                const idle = [...workers].find((entry) => !entry.busy && !entry.ending);
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
                        exitedDeferred: Promise.withResolvers<void>(),
                        residentBytes: 0,
                        retainedWasmBytes: 0,
                        memoryLeases: [],
                        cachedModels: new Map(),
                        admission: null,
                    };
                    workers.add(entry);
                    return entry;
                }
            }
            await new Promise<void>((resolve) => {
                const wake = () => {
                    signal.removeEventListener('abort', wake);
                    const index = waiters.indexOf(wake);
                    if (index >= 0) {
                        waiters.splice(index, 1);
                    }
                    resolve();
                };
                waiters.push(wake);
                signal.addEventListener('abort', wake, {once: true});
            });
        }
    };

    // What a pass on this worker needs: its own models and page, and the
    // other models its engine still keeps, never below its actual retained WASM
    // linear-memory high-water mark plus cached models.
    const resolvePassBytes = (entry: IEngineWorker, modelSizes: ReadonlyMap<TOcrModelCode, number>, workingBytes: number) => {
        let otherCachedBytes = 0;
        let passModelBytes = 0;
        for (const [code, bytes] of entry.cachedModels) {
            if (!modelSizes.has(code)) {
                otherCachedBytes += bytes;
            }
        }
        for (const bytes of modelSizes.values()) {
            passModelBytes += bytes;
        }
        const retainedBytes = entry.retainedWasmBytes > 0 ? entry.retainedWasmBytes + otherCachedBytes + passModelBytes : 0;
        return Math.min(broker.getSnapshot().capacity.estimatedResidentBytes, Math.max(workingBytes + otherCachedBytes, retainedBytes));
    };

    /**
     * Charges the broker immediately for retained WASM linear-memory growth
     * beyond the pre-pass estimate without waiting in the broker queue. Resolves
     * from the actual `broker.acquire` outcome so a rejected top-up (e.g. full
     * queue) is never misclassified as granted, and every granted lease is
     * either tracked on `entry` or released immediately.
     */
    const tryAcquireRetainedMemory = async (entry: IEngineWorker, ownerId: string, extraBytes: number): Promise<boolean> => {
        if (extraBytes <= 0) {
            return true;
        }
        if (entry.ending || entry.exited) {
            return false;
        }
        const snapshot = broker.getSnapshot();
        const fitsTotal =
            snapshot.used.estimatedResidentBytes + extraBytes <=
            snapshot.capacity.estimatedResidentBytes + snapshot.interactiveReserve.estimatedResidentBytes;
        const fitsBulk = snapshot.usedBulk.estimatedResidentBytes + extraBytes <= snapshot.capacity.estimatedResidentBytes;
        if (!fitsTotal || !fitsBulk) {
            return false;
        }
        const probeAbort = new AbortController();
        const request: IJobBrokerRequest = {
            ownerId,
            kind: 'ocr-engine-retained-heap',
            priority: 'user',
            resources: {
                cpuTokens: 0,
                estimatedResidentBytes: extraBytes,
                nativeProcesses: 0,
                ioWeight: 0,
            },
            signal: probeAbort.signal,
        };
        const leasePromise = broker.acquire(request);
        if (broker.isQueued(request)) {
            probeAbort.abort();
            void leasePromise.then(
                (lease) => lease.release(),
                () => undefined,
            );
            return false;
        }
        try {
            const extraLease = await leasePromise;
            if (entry.exited) {
                extraLease.release();
                return false;
            }
            entry.memoryLeases.push(extraLease);
            entry.residentBytes += extraBytes;
            return true;
        } catch {
            return false;
        }
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
                signal: AbortSignal.any([signal, admission.signal]),
            };
            entry.admission = {
                controller: admission,
                request,
            };
            let passLease: Awaited<ReturnType<typeof broker.acquire>>;
            try {
                passLease = await broker.acquire(request);
            } catch (error) {
                if (admission.signal.aborted && !signal.aborted) {
                    continue;
                }
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
            // Recheck the undercharged-lane gate after broker admission: an
            // undercharged lane may have entered retirement while this request
            // waited in the broker queue.
            if (underchargedExiting.size > 0) {
                passLease.release();
                if (entry.worker) {
                    park(entry);
                } else {
                    workers.delete(entry);
                    wakeWaiter();
                }
                broker.recheck();
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
            const modelSizes = await readModelBytes(resolveTesseractRequestModels(request));
            const workingBytes = resolveOcrLaneResources(sumOcrModelBytes(modelSizes), request.image, capacity).estimatedResidentBytes;
            const {entry, growth, passLease} = await admitPass(signal, ownerId, modelSizes, workingBytes);
            entry.residentBytes += growth;
            // The worker keeps what the pass added and the models it read; the
            // core goes back. Actual retained WASM linear memory is charged to
            // the broker, and a worker whose WASM heap crossed the high-water
            // cap (or cannot be charged) is recycled cleanly between pages.
            const keepWorker = (reportedWasmBytes: number | undefined, onComplete: () => void) => {
                for (const [code, bytes] of modelSizes) {
                    entry.cachedModels.set(code, bytes);
                }
                if (reportedWasmBytes !== undefined) {
                    entry.retainedWasmBytes = Math.max(entry.retainedWasmBytes, reportedWasmBytes);
                }
                // Keep the retained total unclamped so a worker whose real
                // WASM heap + cached models exceed broker capacity cannot hide
                // its deficit behind the capacity clamp and stay warm.
                const retainedTotalBytes =
                    reportedWasmBytes === undefined ? 0 : entry.retainedWasmBytes + sumOcrModelBytes(entry.cachedModels);
                const extraBytes = Math.max(0, retainedTotalBytes - entry.residentBytes);
                const finalizeKeep = (chargedExtra: boolean) => {
                    const topUpFailed = extraBytes > 0 && !chargedExtra;
                    const shouldRecycle =
                        entry.ending ||
                        entry.exited ||
                        (reportedWasmBytes !== undefined && entry.retainedWasmBytes > maxRetainedWasmBytes) ||
                        topUpFailed;
                    if (shouldRecycle) {
                        if (topUpFailed) {
                            // The lane holds more memory than the broker charged; keep its
                            // full pass lease (including CPU) until exit so the broker does
                            // not admit replacement work while the undercharged heap is live.
                            entry.memoryLeases.push(passLease);
                        } else if (growth > 0) {
                            entry.memoryLeases.push(passLease);
                            passLease.shrink({
                                cpuTokens: 0,
                                estimatedResidentBytes: growth,
                                nativeProcesses: 0,
                                ioWeight: 0,
                            });
                        } else {
                            passLease.release();
                        }
                        if (entry.exited) {
                            releaseMemory(entry);
                        } else if (!entry.ending) {
                            void end(entry, {keepSlotUntilExit: topUpFailed});
                        } else {
                            wakeWaiter();
                        }
                        onComplete();
                        return;
                    }
                    if (growth > 0) {
                        entry.memoryLeases.push(passLease);
                    }
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
                    onComplete();
                };
                if (extraBytes <= 0) {
                    finalizeKeep(true);
                } else {
                    void tryAcquireRetainedMemory(entry, ownerId, extraBytes).then(finalizeKeep);
                }
            };
            const discardWorker = () => {
                entry.memoryLeases.push(passLease);
                if (entry.exited) {
                    releaseMemory(entry);
                } else {
                    void end(entry);
                }
            };
            const id = nextId++;
            const worker = entry.worker!;
            return new Promise<IOcrEngineResult>((resolve, reject) => {
                let settling = false;
                const detach = () => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    worker.off('message', onMessage);
                    worker.off('error', onError);
                    worker.off('exit', onExit);
                };
                const settle = (error: Error | null, result?: IOcrEngineResult) => {
                    detach();
                    if (error) {
                        reject(error);
                    } else {
                        resolve(result!);
                    }
                };
                const failAndAwaitLaneExit = (error: Error) => {
                    if (settling) {
                        return;
                    }
                    settling = true;
                    detach();
                    discardWorker();
                    void waitForLaneExit(entry).then((exitedCleanly) => {
                        if (!exitedCleanly) {
                            // Always wrap into a fresh lane-owned error so a shared
                            // AbortSignal.reason is never mutated with one lane's exit proof.
                            const unprovenError = new Error(error.message, {cause: error});
                            markUnprovenNativeTermination(
                                unprovenError,
                                `OCR engine lane did not confirm exit within ${exitProofTimeoutMs}ms; its raster input may still be open`,
                            );
                            unprovenLaneExitPromises.set(unprovenError, entry.exitedDeferred.promise);
                            reject(unprovenError);
                            return;
                        }
                        // If a sibling lane aborted the shared signal with its own
                        // unproven-termination error while THIS lane exited cleanly,
                        // reject with a clean AbortError so this page's raster is
                        // not tied to the sibling's stuck exit promise.
                        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
                            reject(createAbortError('OCR was canceled'));
                            return;
                        }
                        reject(error);
                    });
                };
                const onMessage = (message: IOcrEngineLaneReply) => {
                    if (message.id !== id || settling) {
                        return;
                    }
                    settling = true;
                    detach();
                    keepWorker(message.wasmMemoryBytes, () => {
                        if (message.ok) {
                            resolve(message.result);
                        } else {
                            reject(new Error(message.error));
                        }
                    });
                };
                const onError = (error: Error) => {
                    failAndAwaitLaneExit(new Error(`The OCR engine stopped: ${error.message}`, {cause: error}));
                };
                const onExit = (code: number) => {
                    if (settling) {
                        return;
                    }
                    settling = true;
                    discardWorker();
                    settle(new Error(`The OCR engine exited with code ${code}`));
                };
                const onAbort = () => {
                    failAndAwaitLaneExit(signal.reason instanceof Error ? signal.reason : createAbortError('OCR was canceled'));
                };
                const timer = setTimeout(() => {
                    failAndAwaitLaneExit(new Error('Tesseract did not finish within its time limit'));
                }, PASS_TIMEOUT_MS * request.passes.length);
                worker.on('message', onMessage);
                worker.on('error', onError);
                worker.on('exit', onExit);
                signal.addEventListener('abort', onAbort, {once: true});
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                const transfer =
                    request.image instanceof Uint8Array && request.image.buffer instanceof ArrayBuffer ? [request.image.buffer] : [];
                worker.postMessage(
                    {
                        id,
                        request,
                    },
                    transfer,
                );
            });
        },
        terminate() {
            closed = true;
            unregisterReclaimer();
            for (const entry of Array.from(workers)) {
                end(entry);
            }
            for (const wake of waiters.splice(0)) {
                wake();
            }
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
            onStalledUnderchargedLane: () => host.shutdown(),
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
