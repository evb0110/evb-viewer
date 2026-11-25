/**
 * The `name` a scan cleanup engine worker is started with, and the only place
 * that writes or reads it. It names the engine variant and the thread count
 * the worker's engine keeps for life, so it is also the worker's key in its
 * pool. The worker reads its own name once.
 */

/** More threads than this stopped paying off on an 11-core Mac: 5.9 s at 4, 5.6 s at 6. */
export const MAX_SCAN_CLEANUP_ENGINE_THREADS = 6;

/**
 * The maximum each threaded engine's shared memory may grow to: 3 GiB in
 * 64 KiB pages. A shared memory reserves its maximum when it is created, and
 * WebKit grants only so much: on an otherwise idle page 14 memories of 4 GiB,
 * 18 of 3 GiB, and fewer while the page holds other WASM memories (9 of 3 GiB
 * beside 8 ordinary ones). Chromium and Firefox took 40 of 4 GiB. The largest
 * page the browser accepts, 80 MP, peaked at 1.96 GiB in a mixed final render
 * on 6 threads. A memory the browser refuses switches the page to the
 * single-threaded engine.
 */
export const SCAN_CLEANUP_ENGINE_MAXIMUM_MEMORY_PAGES = 49_152;

/**
 * The code a worker's error reply carries when it could not start the
 * threaded engine, with the request's payload handed back untouched under
 * `details.payload` so the page can run the request again on today's engine.
 */
export const SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE = 'scan-cleanup-threaded-engine-unavailable';

const PREFIX = 'evb-scan-cleanup-engine:';
const SINGLE_THREADED = 'single';

/** A worker name for the threaded engine on `threads` threads, or for today's engine when null. */
export function encodeScanCleanupEngineWorkerName(threads: number | null) {
    return `${PREFIX}${threads ?? SINGLE_THREADED}`;
}

/** The threads of the engine a worker named `name` runs, or null for today's single-threaded engine. */
export function readScanCleanupEngineWorkerThreads(name: string | undefined) {
    if (!name?.startsWith(PREFIX)) return null;
    const threads = Number(name.slice(PREFIX.length));
    return Number.isInteger(threads) && threads >= 1 && threads <= MAX_SCAN_CLEANUP_ENGINE_THREADS ? threads : null;
}
