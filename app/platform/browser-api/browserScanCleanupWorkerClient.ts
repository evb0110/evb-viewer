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
} from '@app/platform/browser-api/browserWorkerClient';
import {
    settleBrowserWorkerResult,
    type IPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/settleBrowserWorkerResult';
import {getErrorMessage} from '@app/utils/error';

// A cleanup operation runs its engine calls back to back; keep the engine and
// its compiled module between them, and release both once the workspace idles.
const BROWSER_SCAN_CLEANUP_WORKER_IDLE_TTL_MS = 30_000;

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
        createWorker: () => {
            try {
                return new Worker(new URL('./browserScanCleanup.worker.ts', import.meta.url), {type: 'module'});
            } catch (error) {
                throw new BrowserScanCleanupWorkerUnavailableError(getErrorMessage(error));
            }
        },
        createError: event => new BrowserScanCleanupWorkerUnavailableError(
            event.error instanceof Error ? getErrorMessage(event.error) : event.message,
        ),
        handleMessage: (pendingRequests, response, onSettled) => settleBrowserWorkerResult(
            pendingRequests,
            response,
            onSettled,
        ),
    });
}

// One slot: a cleanup operation's engine calls are serial, and an engine that
// holds a page's planes leaves no address space for a second one.
const owner = new BrowserWorkerRequestOwner(createClient, 1);

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

/**
 * Runs one request on the cleanup worker. Every buffer and bitmap in the
 * payload is transferred, so a caller that still needs a raster afterwards
 * passes a copy. Aborting terminates the worker, which is the only way to stop
 * a synchronous engine call; the next request starts a fresh engine.
 */
export function runBrowserScanCleanupWorkerRequest<K extends TBrowserScanCleanupWorkerRequestType>(
    type: K,
    payload: IBrowserScanCleanupWorkerRequestMap[K],
    signal: AbortSignal,
    onEngineIdentity?: (sha256: string) => void,
): Promise<IBrowserScanCleanupWorkerResultMap[K]> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    const id = owner.createRequestId();
    const abort = () => owner.cancel(id, abortError(signal));
    signal.addEventListener('abort', abort, {once: true});
    return owner.run(id, client => new Promise<IBrowserScanCleanupWorkerResultMap[K]>((resolve, reject) => {
        const worker = client.getWorker();
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
    })).finally(() => signal.removeEventListener('abort', abort));
}
