import {
    isBrowserScanCleanupWorkerResult,
    type IBrowserScanCleanupWorkerRequestMap,
    type IBrowserScanCleanupWorkerResultMap,
    type TBrowserScanCleanupWorkerRequestType,
} from '@contracts/scan-cleanup/browserScanCleanupWorker';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
    canUseBrowserWorker,
    resolveBrowserPageLanes,
} from '@app/platform/browser-api/browserWorkerClient';
import {
    settleBrowserWorkerResult,
    type IPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    observeScanCleanupEngineReply,
    registerScanCleanupEnginePool,
    runWithScanCleanupEngineFailover,
    scanCleanupEngineAdmission,
    scanCleanupEngineWorkerName,
    threadedScanCleanupEngineBudget,
} from '@app/platform/browser-api/scanCleanupEngineVariant';
import {getErrorMessage} from '@app/utils/error';

// A cleanup operation runs its engine calls back to back; keep the engine and
// its compiled module between them, and release both once the workspace idles.
const BROWSER_SCAN_CLEANUP_WORKER_IDLE_TTL_MS = 30_000;
// Far past the slowest page seen: an 80 MP final render took 30 s on six
// threads. It ends a request whose engine thread died without a trace, which
// would otherwise wait for it forever.
const BROWSER_SCAN_CLEANUP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class BrowserScanCleanupWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserScanCleanupWorkerUnavailableError';
    }
}

/** The cleanup engine is synchronous WASM: it runs only where a worker can hold it. */
export function canUseBrowserScanCleanupWorker() {
    return typeof WebAssembly !== 'undefined'
        && canUseBrowserWorker()
        && typeof OffscreenCanvas !== 'undefined'
        && typeof createImageBitmap === 'function';
}

function createClient() {
    return new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
        idleTtlMs: BROWSER_SCAN_CLEANUP_WORKER_IDLE_TTL_MS,
        requestTimeoutMs: BROWSER_SCAN_CLEANUP_REQUEST_TIMEOUT_MS,
        // The worker's name tells it which engine to run, on how many threads.
        defaultWorkerKey: () => scanCleanupEngineWorkerName(undefined),
        budget: threadedScanCleanupEngineBudget,
        createWorker: (name) => {
            try {
                return new Worker(new URL('./browserScanCleanup.worker.ts', import.meta.url), {
                    type: 'module',
                    name: name ?? '',
                });
            } catch (error) {
                throw new BrowserScanCleanupWorkerUnavailableError(getErrorMessage(error));
            }
        },
        createError: event => new BrowserScanCleanupWorkerUnavailableError(
            event.error instanceof Error ? getErrorMessage(event.error) : event.message,
        ),
        handleMessage: (pendingRequests, response, onSettled) => {
            observeScanCleanupEngineReply(response);
            settleBrowserWorkerResult(pendingRequests, response, onSettled);
        },
    });
}

const ENGINE_BASE_WASM_BYTES = 32 * 1024 * 1024;

/**
 * The memory one page of `pixels` takes in its lane: the engine's linear
 * memory at its high-water mark and the worker's own copies of the request.
 * Measured on 300 dpi pages, an analysis takes 34 bytes a pixel, a color
 * render 29 and a bilevel or grayscale render 20; each class is padded by
 * half. Every analysis decodes color.
 */
export function estimateBrowserScanCleanupEngineBytes(pixels: number, decodesColor: boolean) {
    return ENGINE_BASE_WASM_BYTES + Math.ceil(pixels) * (decodesColor ? 50 : 30);
}

let owner: BrowserWorkerRequestOwner<IPendingBrowserWorkerRequest> | null = null;

/**
 * A worker and engine instance per page lane, and one more so a preview never
 * waits behind a document's pages. Each worker starts when a request first
 * needs it.
 */
function getOwner() {
    if (owner === null) {
        const pageLanes = resolveBrowserPageLanes().producerConcurrency;
        const engines = new BrowserWorkerRequestOwner(createClient, pageLanes === 1 ? 1 : pageLanes + 1, threadedScanCleanupEngineBudget);
        registerScanCleanupEnginePool(() => engines.resetIdleWorkers());
        owner = engines;
    }
    return owner;
}

/** The buffers and bitmaps a request owns; the worker takes them over. */
function transferablesOf(value: unknown, found = new Set<Transferable>()): Set<Transferable> {
    if (value instanceof Uint8Array) {
        if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    } else if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) {
        found.add(value);
    } else if (Array.isArray(value)) {
        for (const entry of value) transferablesOf(entry, found);
    } else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) transferablesOf(entry, found);
    }
    return found;
}

function abortError(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Scan cleanup was canceled.', 'AbortError');
}

/** Requests that only move pixels; they run on any cleanup worker, whatever its engine. */
const ENGINELESS_REQUESTS: ReadonlySet<TBrowserScanCleanupWorkerRequestType> = new Set([
    'assemble-raster',
    'encode-png',
]);

/**
 * Runs one request on the cleanup worker. Every buffer and bitmap in the
 * payload is transferred, so a caller that still needs a raster afterwards
 * passes a copy. Aborting terminates the worker, which is the only way to stop
 * a synchronous engine call; the next request starts a fresh engine.
 *
 * `concurrency` is how many such requests the caller runs at once: an
 * interactive request runs alone and says 1, a batch says its page lanes. On a
 * page that runs the threaded engine it sets the request's threads; a request
 * that says nothing gets one thread.
 */
export function runBrowserScanCleanupWorkerRequest<K extends TBrowserScanCleanupWorkerRequestType>(
    type: K,
    payload: IBrowserScanCleanupWorkerRequestMap[K],
    signal: AbortSignal,
    onEngineIdentity?: (sha256: string) => void,
    concurrency?: number,
): Promise<IBrowserScanCleanupWorkerResultMap[K]> {
    return runWithScanCleanupEngineFailover(
        payload,
        attempt => runOnWorker(type, attempt, signal, onEngineIdentity, concurrency),
    );
}

function runOnWorker<K extends TBrowserScanCleanupWorkerRequestType>(
    type: K,
    payload: IBrowserScanCleanupWorkerRequestMap[K],
    signal: AbortSignal,
    onEngineIdentity: ((sha256: string) => void) | undefined,
    concurrency: number | undefined,
): Promise<IBrowserScanCleanupWorkerResultMap[K]> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    const engines = getOwner();
    const id = engines.createRequestId();
    const abort = () => engines.cancel(id, abortError(signal));
    signal.addEventListener('abort', abort, {once: true});
    return engines.run(id, (client, _isAdmitted, workerName) => new Promise<IBrowserScanCleanupWorkerResultMap[K]>((resolve, reject) => {
        const worker = client.getWorker(workerName);
        client.registerPendingRequest(id, {
            requestType: type,
            onEngineIdentity,
            resolveData: data => {
                if (!isBrowserScanCleanupWorkerResult(type, data)) return false;
                resolve(data);
                return true;
            },
            reject,
        }, () => new BrowserScanCleanupWorkerUnavailableError('Scan cleanup worker request timed out'));
        try {
            worker.postMessage({
                id,
                type,
                payload,
            }, [...transferablesOf(payload)]);
        } catch (error) {
            client.cancelPendingRequest(id, error instanceof Error ? error : new Error(String(error)));
        }
    }), ENGINELESS_REQUESTS.has(type) ? {} : scanCleanupEngineAdmission(concurrency)).finally(() => signal.removeEventListener('abort', abort));
}
