import {BrowserWorkerBudget} from '@app/platform/browser-api/browserWorkerClient';
import {
    encodeScanCleanupEngineWorkerName,
    MAX_SCAN_CLEANUP_ENGINE_THREADS,
    readScanCleanupEngineWorkerThreads,
    SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE,
} from '@app/platform/browser-api/scanCleanupEngineWorkerName';
import {
    isSerializableErrorEnvelope,
    SerializableError,
} from '@contracts/serializableError';
import {getPerformanceProfile} from '@app/utils/performanceProfile';

/**
 * Which scan cleanup engine a page runs, and on how many threads.
 *
 * A cross-origin isolated page runs the threaded engine
 * (`evb-scan-cleanup-threads.wasm`) in every cleanup and OCR preprocessing
 * worker, even one that runs a single thread: a cleanup job names the module
 * it ran and fails when it sees two. Any other page runs today's
 * single-threaded engine. The page decides once; a worker that cannot bring
 * the threaded engine up switches it off for the rest of the page's life, in
 * every pool, before any waiting request is admitted.
 */

const hardwareCores = () => (typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency) || 2;

/**
 * Threaded engines live at once in the page, across the cleanup and the OCR
 * preprocessing pools. Each holds a 3 GiB shared memory the browser reserves
 * in full. WebKit 26.6 granted 18 such memories on an idle page and 9 beside
 * 8 ordinary WASM memories, which an OCR job's Tesseract lanes add, so the
 * page keeps a third below that. A batch leaves one place for an interactive
 * request, such as the preview.
 */
export const MAX_LIVE_THREADED_SCAN_CLEANUP_ENGINES = 6;

/**
 * The threads one engine request runs on: the cores but one, shared by the
 * requests its caller runs at the same time, at most six. A batch runs at
 * most as many pages at once as it has places for threaded engines. On 11
 * cores a lone preview gets 6, a 4-page job 2 a page, an 8-lane batch 2 a page
 * on its 5 places. A request that declares no concurrency gets one thread, so
 * a forgotten hint never oversubscribes the device.
 */
export function resolveScanCleanupEngineThreads(concurrency: number | undefined, cores = hardwareCores()) {
    if (concurrency === undefined || !Number.isFinite(concurrency)) return 1;
    const siblings = Math.max(1, Math.min(Math.floor(concurrency), MAX_LIVE_THREADED_SCAN_CLEANUP_ENGINES - 1));
    return Math.max(1, Math.min(MAX_SCAN_CLEANUP_ENGINE_THREADS, Math.floor((cores - 1) / siblings)));
}

export interface IThreadedScanCleanupEngineEnvironment {
    crossOriginIsolated: boolean;
    hasSharedArrayBuffer: boolean;
    lowMemory: boolean;
    cores: number;
}

/**
 * Whether a page in `environment` can run the threaded engine. No memory is
 * created to find out: WebKit counts every shared memory against its budget,
 * however small. A first engine whose memory is refused switches the page
 * off before any job has run on the threaded engine.
 */
export function canRunThreadedScanCleanupEngine(environment: IThreadedScanCleanupEngineEnvironment) {
    return environment.crossOriginIsolated
        && environment.hasSharedArrayBuffer
        && !environment.lowMemory
        && environment.cores >= 2;
}

function readPageEnvironment(): IThreadedScanCleanupEngineEnvironment {
    return {
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
        hasSharedArrayBuffer: typeof SharedArrayBuffer === 'function',
        lowMemory: getPerformanceProfile().lowMemory,
        cores: hardwareCores(),
    };
}

export interface IBrowserArchitecture {
    userAgent: string;
    /** Chromium's high-entropy `bitness`: undefined where the browser has no client hints, null where it would not tell. */
    bitness?: string | null;
    /** Chromium's `wow64`: a 32-bit browser on 64-bit Windows, which reports the platform's bitness. */
    wow64?: boolean;
}

/**
 * Whether the browser is a 64-bit build. The threaded engine relies on guard
 * pages to bounds-check plain loads and stores, which only 64-bit engines use.
 * Chromium freezes its user agent (Linux always reads x86_64), so its client
 * hint decides; elsewhere the platform token does: every macOS browser is
 * 64-bit, and Windows and Linux name the build. Anything unclear is not.
 */
export function isSixtyFourBitBrowser({userAgent, bitness, wow64}: IBrowserArchitecture) {
    if (bitness !== undefined) return bitness === '64' && wow64 !== true;
    if (/WOW64|\bi[3-6]86\b|armv7|armv8l/u.test(userAgent)) return false;
    return /Macintosh|\bWin64\b|\bx86_64\b|\baarch64\b|\barm64\b/u.test(userAgent);
}

async function readBrowserArchitecture(): Promise<IBrowserArchitecture> {
    const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const hints: unknown = typeof navigator === 'undefined' ? undefined : Reflect.get(navigator, 'userAgentData');
    const getHighEntropyValues: unknown = hints === undefined || hints === null ? undefined : Reflect.get(hints, 'getHighEntropyValues');
    if (typeof getHighEntropyValues !== 'function') return {userAgent};
    try {
        const values: unknown = await getHighEntropyValues.call(hints, ['bitness', 'wow64']);
        const read = (name: string): unknown => (typeof values === 'object' && values !== null ? Reflect.get(values, name) : undefined);
        const bitness = read('bitness');
        return {
            userAgent,
            bitness: typeof bitness === 'string' ? bitness : null,
            // Unknown counts as 32-bit: the bitness alone may be the platform's.
            wow64: read('wow64') !== false,
        };
    } catch {
        return {
            userAgent,
            bitness: null,
        };
    }
}

let threadedEngine: boolean | null = null;
let deciding: Promise<boolean> | null = null;
const switchedOff = new Set<() => void>();

/**
 * Decides once whether this page runs the threaded engine. Every engine
 * request awaits it before it is admitted, so no request of a job runs before
 * the decision is fixed.
 */
export function prepareScanCleanupEngine() {
    deciding ??= (async () => {
        const capable = canRunThreadedScanCleanupEngine(readPageEnvironment())
            && isSixtyFourBitBrowser(await readBrowserArchitecture());
        // A start failure may have switched the page off meanwhile.
        threadedEngine ??= capable;
        return threadedEngine;
    })();
    return deciding;
}

/** Whether this page runs the threaded engine; false until `prepareScanCleanupEngine` has decided. */
export function usesThreadedScanCleanupEngine() {
    return threadedEngine === true;
}

/**
 * Runs today's engine for the rest of the page's life, and ends every pool's
 * idle threaded workers. Requests admitted after this read the new worker key.
 */
export function switchOffThreadedScanCleanupEngine() {
    if (threadedEngine === false) return;
    const wasThreaded = threadedEngine === true;
    threadedEngine = false;
    if (!wasThreaded) return;
    for (const reset of switchedOff) reset();
}

/** The places of every pool's threaded engines; a pool that runs them passes it to its owner and clients. */
const isThreadedEngineKey = (key: string | undefined) => (readScanCleanupEngineWorkerThreads(key) ?? 0) > 0;

export const threadedScanCleanupEngineBudget = new BrowserWorkerBudget(
    () => MAX_LIVE_THREADED_SCAN_CLEANUP_ENGINES,
    isThreadedEngineKey,
    // Once the page is off the threaded engine, a threaded worker ends when its request settles.
    key => isThreadedEngineKey(key) && threadedEngine === false,
);

/** Registers a pool of engine workers: `resetIdleWorkers` runs when the page switches the threaded engine off. */
export function registerScanCleanupEnginePool(resetIdleWorkers: () => void) {
    switchedOff.add(resetIdleWorkers);
}

/**
 * How a pool admits an engine request of `concurrency` siblings: the worker
 * key is read at admission, and a batch leaves one threaded place free.
 */
export function scanCleanupEngineAdmission(concurrency: number | undefined) {
    return {
        workerKey: () => scanCleanupEngineWorkerName(concurrency),
        budgetReserve: (concurrency ?? 1) > 1 ? 1 : 0,
    };
}

/**
 * Reads a worker's reply before its request settles. A reply that says the
 * threaded engine could not start switches the page off at once, so the
 * pools admit nothing threaded after it.
 */
export function observeScanCleanupEngineReply(response: unknown) {
    if (typeof response !== 'object' || response === null || Reflect.get(response, 'ok') !== false) return;
    const envelope: unknown = Reflect.get(response, 'errorEnvelope');
    if (isSerializableErrorEnvelope(envelope) && envelope.code === SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE) {
        console.warn('The threaded scan cleanup engine could not start; this page runs the single-threaded engine from now on.', envelope.message);
        switchOffThreadedScanCleanupEngine();
    }
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
 * engine up, the page has switched to today's engine (see
 * `observeScanCleanupEngineReply`), and the request runs once more with the
 * payload the worker handed back.
 */
export async function runWithScanCleanupEngineFailover<TPayload, TResult>(
    payload: TPayload,
    attempt: (payload: TPayload) => Promise<TResult>,
): Promise<TResult> {
    await prepareScanCleanupEngine();
    try {
        return await attempt(payload);
    } catch (error) {
        if (!(error instanceof SerializableError) || error.code !== SCAN_CLEANUP_THREADED_ENGINE_UNAVAILABLE) throw error;
        const returned: unknown = Reflect.get(Object(error.errorEnvelope.details), 'payload');
        if (returned === undefined) throw error;
        switchOffThreadedScanCleanupEngine();
        return attempt(returned as TPayload);
    }
}
