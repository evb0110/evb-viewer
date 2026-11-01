import {
    BROWSER_OCR_ENGINE_RESULT_SCHEMA,
    BROWSER_OCR_PREPROCESS_RESULT_SCHEMA,
    type IBrowserOcrEngineResult,
    type IBrowserOcrPreprocessResult,
    type TBrowserOcrEngineRequest,
    type TBrowserOcrPreprocessRequest,
    type TBrowserOcrRecognizeRequest,
} from '@contracts/browserOcrEngine';
import type {TOcrScanCleanupMode} from '@contracts/scan-cleanup/ocrPreprocessing';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
} from '@app/platform/browser-api/browserWorkerClient';
import {
    settleBrowserWorkerResult,
    type ITypedPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/settleBrowserWorkerResult';
import * as v from 'valibot';

// A lane keeps its engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// Desktop stops a Tesseract pass after three minutes. Cleanup gets the same
// bound: desktop's 30 seconds assume its multithreaded engine, while this
// single-threaded one took up to 14 s on a 300 DPI letter page and would pass
// 30 s on large pages desktop cleans.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;

type TPendingEngineRequest = ITypedPendingBrowserWorkerRequest<TBrowserOcrEngineRequest['type'], unknown>;

/**
 * The cleanup engine's WebAssembly memory per page pixel. WASM memory never
 * shrinks, so a lane that cleaned a page keeps this beside Tesseract's. On
 * 300 DPI letter pages it peaked at 15.2 B/pixel for polarity and 20.5–38.2
 * for clean, matching desktop's estimates for its native engine.
 */
const CLEANUP_BYTES_PER_PIXEL: Record<TOcrScanCleanupMode, number> = {
    'clean': 40,
    'polarity-only': 16,
};

/**
 * Reserve a core for interaction and at most half of reported memory for
 * OCR. Account for model copies/weights, raster scratch and the cleanup
 * engine, not just CPU count.
 * Browsers omit or round deviceMemory; an unknown device gets a 4 GiB budget.
 */
export function getBrowserOcrLaneCount(pagePixels = 0, modelBytes = 0, cleanup?: TOcrScanCleanupMode) {
    const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
    const memoryGb = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    if (memoryGb !== undefined && memoryGb <= 4) return 1;
    const perLane = 192 * 1024 * 1024 + pagePixels * (12 + (cleanup ? CLEANUP_BYTES_PER_PIXEL[cleanup] : 0)) + modelBytes * 3;
    const memoryLanes = Math.floor((memoryGb ?? 4) * 1024 ** 3 / 2 / perLane);
    return Math.max(1, Math.min(8, cores - 1, memoryLanes));
}

export class BrowserOcrEngineUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserOcrEngineUnavailableError';
    }
}

function createEngineClient() {
    return new BrowserWorkerClient<TPendingEngineRequest>({
        idleTtlMs: ENGINE_IDLE_TTL_MS,
        createWorker: () => new Worker(
            new URL('./browserOcrEngine.worker.ts', import.meta.url),
            {type: 'module'},
        ),
        createError: event => new BrowserOcrEngineUnavailableError(
            event.error instanceof Error ? event.error.message : event.message || 'The OCR engine stopped',
        ),
        handleMessage: settleBrowserWorkerResult,
    });
}

let owner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;

function getOwner() {
    owner ??= new BrowserWorkerRequestOwner(createEngineClient, getBrowserOcrLaneCount());
    return owner;
}

/**
 * Runs one engine request in a free lane. Canceling stops the engine: a lane
 * busy in Tesseract or the cleanup engine cannot read messages, so its worker ends.
 */
function runEngineRequest<TResult>(
    request: Omit<TBrowserOcrEngineRequest, 'id'>,
    signal: AbortSignal,
    readResult: (data: unknown) => TResult | null,
    timeout: {
        ms: number;
        message: string
    },
): Promise<TResult> {
    signal.throwIfAborted();
    const {payload} = request;
    const engines = getOwner();
    const requestId = engines.createRequestId();
    const onAbort = () => engines.cancel(
        requestId,
        signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, {once: true});
    return engines.run(requestId, (client, isAdmitted) => new Promise<TResult>((resolve, reject) => {
        if (!isAdmitted()) {
            reject(new DOMException('OCR was canceled', 'AbortError'));
            return;
        }
        const worker = client.getWorker();
        client.registerPendingRequest(requestId, {
            requestType: request.type,
            reject,
            resolveData: (data) => {
                const result = readResult(data);
                if (result === null) return false;
                resolve(result);
                return true;
            },
        }, () => new Error(timeout.message), timeout.ms);
        worker.postMessage({
            ...request,
            id: requestId,
        }, payload.image instanceof Uint8Array ? [payload.image.buffer] : payload.image.tiles);
    })).finally(() => {
        signal.removeEventListener('abort', onAbort);
        if (!(payload.image instanceof Uint8Array)) payload.image.tiles.forEach(tile => tile.close());
    });
}

/** Runs one page's Tesseract passes. */
export function runBrowserOcrEngine(
    payload: TBrowserOcrRecognizeRequest['payload'],
    signal: AbortSignal,
): Promise<IBrowserOcrEngineResult> {
    return runEngineRequest({
        type: 'recognize',
        payload,
    }, signal, (data) => {
        const parsed = v.safeParse(BROWSER_OCR_ENGINE_RESULT_SCHEMA, data, {abortEarly: true});
        return parsed.success && parsed.output.passes.length === payload.passes.length ? parsed.output : null;
    }, {
        ms: PASS_TIMEOUT_MS * payload.passes.length,
        message: 'Tesseract did not finish within its time limit',
    });
}

/**
 * Cleans one rendered page for recognition, as desktop OCR preprocessing
 * does. Rejects when the engine stopped or ran past its time limit; the
 * caller then recognizes the rendered page, as desktop does.
 */
export function preprocessBrowserOcrRaster(
    payload: TBrowserOcrPreprocessRequest['payload'],
    signal: AbortSignal,
): Promise<IBrowserOcrPreprocessResult> {
    return runEngineRequest({
        type: 'preprocess',
        payload,
    }, signal, (data) => {
        const parsed = v.safeParse(BROWSER_OCR_PREPROCESS_RESULT_SCHEMA, data, {abortEarly: true});
        return parsed.success ? parsed.output : null;
    }, {
        ms: PASS_TIMEOUT_MS,
        message: 'OCR preprocessing did not finish within its time limit',
    });
}
