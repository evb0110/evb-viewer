import {createNativeWasmThreadMemory} from '@app/platform/browser-api/nativeWasmThreadHost';
import {
    encodeScanCleanupEngineWorkerName,
    MAX_SCAN_CLEANUP_ENGINE_THREADS,
    SCAN_CLEANUP_ENGINE_MAXIMUM_MEMORY_PAGES,
    SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
} from '@app/platform/browser-api/scanCleanupEngineWorkerName';
import {SerializableError} from '@contracts/serializableError';
import {getPerformanceProfile} from '@app/utils/performanceProfile';

/**
 * Which scan cleanup engine a page runs, and on how many threads.
 *
 * A cross-origin isolated page runs the threaded engine
 * (`evb-scan-cleanup-threads.wasm`) in every cleanup and OCR preprocessing
 * worker, even one that runs a single thread: a cleanup job names the module
 * it ran and fails when it sees two. Any other page runs today's
 * single-threaded engine. The page decides once; a worker that cannot bring
 * the threaded engine up switches it off for the rest of the page's life.
 */

const hardwareCores = () => (typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency) || 2;

/**
 * The threads one engine request runs on: the cores but one, shared by the
 * requests its caller runs at the same time, at most six. On 11 cores a lone
 * preview gets 6, a 4-page job 2 a page, an 8-lane batch 1 a page. A request
 * that declares no concurrency gets one thread, so a forgotten hint never
 * oversubscribes the device.
 */
export function resolveScanCleanupEngineThreads(concurrency: number | undefined, cores = hardwareCores()) {
    if (concurrency === undefined || !Number.isFinite(concurrency)) return 1;
    const siblings = Math.max(1, Math.floor(concurrency));
    return Math.max(1, Math.min(MAX_SCAN_CLEANUP_ENGINE_THREADS, Math.floor((cores - 1) / siblings)));
}

export interface IThreadedScanCleanupEngineEnvironment {
    crossOriginIsolated: boolean;
    hasSharedArrayBuffer: boolean;
    lowMemory: boolean;
    cores: number;
    /** Creates and drops one engine memory; throws when the browser refuses it. */
    probeMemory: () => void;
}

/** Whether a page in `environment` can run the threaded engine. */
export function canRunThreadedScanCleanupEngine(environment: IThreadedScanCleanupEngineEnvironment) {
    if (!environment.crossOriginIsolated || !environment.hasSharedArrayBuffer) return false;
    if (environment.lowMemory || environment.cores < 2) return false;
    try {
        environment.probeMemory();
        return true;
    } catch {
        return false;
    }
}

function readPageEnvironment(): IThreadedScanCleanupEngineEnvironment {
    return {
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function',
        lowMemory: getPerformanceProfile().lowMemory,
        cores: hardwareCores(),
        probeMemory: () => {
            // Dropped at once: the reservation is released when it is collected.
            createNativeWasmThreadMemory(SCAN_CLEANUP_ENGINE_MAXIMUM_MEMORY_PAGES);
        },
    };
}

let threadedEngine: boolean | null = null;

/** Whether this page runs the threaded engine. Decided on first use, then fixed. */
export function usesThreadedScanCleanupEngine() {
    threadedEngine ??= canRunThreadedScanCleanupEngine(readPageEnvironment());
    return threadedEngine;
}

/** Runs today's engine for the rest of the page's life. */
export function switchOffThreadedScanCleanupEngine() {
    threadedEngine = false;
}

/**
 * The name, and pool key, of a worker that runs the engine for a request of
 * `concurrency` siblings on this page.
 */
export function scanCleanupEngineWorkerName(concurrency: number | undefined) {
    return encodeScanCleanupEngineWorkerName(usesThreadedScanCleanupEngine() ? resolveScanCleanupEngineThreads(concurrency) : null);
}

/**
 * Runs one engine request. When the worker could not bring the threaded
 * engine up, the page runs today's engine from then on: `resetIdleWorkers`
 * ends the pool's idle threaded workers, and the request runs once more with
 * the payload the worker handed back. A job that already saw the threaded
 * engine's digest then ends with its "engine changed" error.
 */
export async function runWithScanCleanupEngineFailover<TPayload, TResult>(
    payload: TPayload,
    attempt: (payload: TPayload) => Promise<TResult>,
    resetIdleWorkers: () => void,
): Promise<TResult> {
    try {
        return await attempt(payload);
    } catch (error) {
        if (!(error instanceof SerializableError) || error.code !== SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE) throw error;
        const returned: unknown = Reflect.get(Object(error.errorEnvelope.details), 'payload');
        if (returned === undefined) throw error;
        console.warn('The threaded scan cleanup engine could not start; this page runs the single-threaded engine from now on.', error.message);
        switchOffThreadedScanCleanupEngine();
        resetIdleWorkers();
        return attempt(returned as TPayload);
    }
}
