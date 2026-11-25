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
import {
    runWithScanCleanupEngineFailover,
    scanCleanupEngineWorkerName,
} from '@app/platform/browser-api/scanCleanupEngineVariant';
import * as v from 'valibot';

// A lane keeps its Tesseract engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// Reclaim a preprocessing worker's scan-cleanup WASM heap promptly once idle.
const PREPROCESS_IDLE_TTL_MS = 15_000;
// Desktop stops a Tesseract pass after three minutes. Cleanup gets the same
// bound: desktop's 30 seconds assume its multithreaded engine, while this
// single-threaded one took up to 14 s on a 300 DPI letter page and would pass
// 30 s on large pages desktop cleans.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;
const PREPROCESS_BASE_WASM_BYTES = 32 * 1024 * 1024;

type TPendingEngineRequest = ITypedPendingBrowserWorkerRequest<TBrowserOcrEngineRequest['type'], unknown>;

/**
 * The cleanup engine's WebAssembly memory per page pixel. It runs in
 * preprocessing workers separate from the Tesseract workers, so its heap is
 * paid once per preprocessing worker rather than once per recognition lane.
 */
const CLEANUP_BYTES_PER_PIXEL: Record<TOcrScanCleanupMode, number> = {
    'clean': 40,
    'polarity-only': 16,
};

/**
 * The part of a page's engine time spent in preprocessing, measured on a
 * 300 DPI text page: cleaning takes about as long as recognizing, a polarity
 * check about a quarter as long. A job needs this share of its lanes as
 * preprocessing workers for none of its Tesseract lanes to wait on one.
 */
const PREPROCESS_TIME_SHARE: Record<TOcrScanCleanupMode, number> = {
    'clean': 0.5,
    'polarity-only': 0.25,
};

export interface IBrowserOcrLanes {
    /** Pages in flight, each rendering, preprocessing or being recognized. */
    lanes: number;
    /** Pages preprocessed at once; zero for a job that does not preprocess. */
    preprocessLanes: number;
}

/**
 * Reserve a core for interaction, a second when pages are preprocessed, and at
 * most half of reported memory for OCR. A lane holds its Tesseract engine, models and raster scratch; each
 * preprocessing worker holds a cleanup heap. Of the splits that fit, the one
 * recognizing the most pages at once wins, counting a preprocessing worker
 * for as many lanes as it can feed.
 * Browsers omit or round deviceMemory; an unknown device gets a 4 GiB budget.
 */
export function resolveBrowserOcrLanes(pagePixels = 0, modelBytes = 0, cleanup?: TOcrScanCleanupMode): IBrowserOcrLanes {
    const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
    const memoryGb = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    const single = {
        lanes: 1,
        preprocessLanes: cleanup ? 1 : 0,
    };
    if (memoryGb !== undefined && memoryGb <= 4) return single;
    const totalBudget = (memoryGb ?? 4) * 1024 ** 3 / 2;
    const perLane = 192 * 1024 * 1024 + pagePixels * 12 + modelBytes * 3;
    if (!cleanup) {
        return {
            lanes: Math.max(1, Math.min(cores - 1, Math.floor(totalBudget / perLane))),
            preprocessLanes: 0,
        };
    }
    const perPreprocess = PREPROCESS_BASE_WASM_BYTES + pagePixels * CLEANUP_BYTES_PER_PIXEL[cleanup];
    const share = PREPROCESS_TIME_SHARE[cleanup];
    let best = single;
    let bestFedLanes = 0;
    for (let lanes = cores > 2 ? cores - 2 : 1; lanes >= 1; lanes -= 1) {
        const affordable = Math.min(lanes, Math.floor((totalBudget - lanes * perLane) / perPreprocess));
        const fedLanes = Math.min(lanes, affordable / share);
        if (affordable < 1 || fedLanes <= bestFedLanes) continue;
        bestFedLanes = fedLanes;
        best = {
            lanes,
            preprocessLanes: Math.min(affordable, Math.ceil(lanes * share)),
        };
    }
    return best;
}

export class BrowserOcrEngineUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserOcrEngineUnavailableError';
    }
}

function createWorkerClient(
    createWorker: (name: string | undefined) => Worker,
    idleTtlMs: number,
    fallbackMessage: string,
    defaultWorkerKey?: () => string,
) {
    return new BrowserWorkerClient<TPendingEngineRequest>({
        idleTtlMs,
        createWorker,
        ...(defaultWorkerKey === undefined ? {} : {defaultWorkerKey}),
        createError: event => new BrowserOcrEngineUnavailableError(
            event.error instanceof Error ? event.error.message : event.message || fallbackMessage,
        ),
        handleMessage: settleBrowserWorkerResult,
    });
}

let recognizeOwner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;
let preprocessOwner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;

function getRecognizeOwner() {
    recognizeOwner ??= new BrowserWorkerRequestOwner(
        () => createWorkerClient(
            () => new Worker(new URL('./browserOcrEngine.worker.ts', import.meta.url), {type: 'module'}),
            ENGINE_IDLE_TTL_MS,
            'The OCR engine stopped',
        ),
        resolveBrowserOcrLanes().lanes,
    );
    return recognizeOwner;
}

function getPreprocessOwner() {
    preprocessOwner ??= new BrowserWorkerRequestOwner(
        () => createWorkerClient(
            // The worker's name tells it which cleanup engine to run, on how many threads.
            name => new Worker(new URL('./browserOcrPreprocess.worker.ts', import.meta.url), {
                type: 'module',
                name: name ?? '',
            }),
            PREPROCESS_IDLE_TTL_MS,
            'The OCR preprocessing engine stopped',
            () => scanCleanupEngineWorkerName(undefined),
        ),
        // A job preprocesses on as many of these as its own page size affords.
        resolveBrowserOcrLanes().lanes,
    );
    return preprocessOwner;
}

/**
 * Runs one request in a free lane of `pool`. Canceling stops the worker: a lane
 * busy in Tesseract or the cleanup engine cannot read messages, so its worker ends.
 */
function runWorkerRequest<TResult>(
    pool: BrowserWorkerRequestOwner<TPendingEngineRequest>,
    request: Omit<TBrowserOcrEngineRequest, 'id'>,
    signal: AbortSignal,
    readResult: (data: unknown) => TResult | null,
    timeout: {
        ms: number;
        message: string
    },
    workerKey?: string,
): Promise<TResult> {
    const {payload} = request;
    const closeTiles = () => {
        if (!(payload.image instanceof Uint8Array)) payload.image.tiles.forEach(tile => tile.close());
    };
    // A page that waited for a worker may arrive after its job was canceled.
    if (signal.aborted) closeTiles();
    signal.throwIfAborted();
    const requestId = pool.createRequestId();
    const onAbort = () => pool.cancel(
        requestId,
        signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, {once: true});
    return pool.run(requestId, (client, isAdmitted) => new Promise<TResult>((resolve, reject) => {
        if (!isAdmitted()) {
            reject(new DOMException('OCR was canceled', 'AbortError'));
            return;
        }
        const worker = client.getWorker(workerKey);
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
    }), workerKey).finally(() => {
        signal.removeEventListener('abort', onAbort);
        closeTiles();
    });
}

/** Runs one page's Tesseract passes on the dedicated Tesseract worker pool. */
export function runBrowserOcrEngine(
    payload: TBrowserOcrRecognizeRequest['payload'],
    signal: AbortSignal,
): Promise<IBrowserOcrEngineResult> {
    return runWorkerRequest(getRecognizeOwner(), {
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
 * Cleans one rendered page for recognition in a preprocessing worker separate
 * from the Tesseract workers. Rejects when the engine stopped or ran past
 * its time limit; the caller then recognizes the rendered page, as desktop does.
 * `concurrency` is how many pages the job keeps in its engines at once, which
 * sets the cleanup engine's threads on a page that runs the threaded engine.
 */
export function preprocessBrowserOcrRaster(
    payload: TBrowserOcrPreprocessRequest['payload'],
    signal: AbortSignal,
    concurrency?: number,
): Promise<IBrowserOcrPreprocessResult> {
    return runWithScanCleanupEngineFailover(payload, attempt => runWorkerRequest(getPreprocessOwner(), {
        type: 'preprocess',
        payload: attempt,
    }, signal, (data) => {
        const parsed = v.safeParse(BROWSER_OCR_PREPROCESS_RESULT_SCHEMA, data, {abortEarly: true});
        return parsed.success ? parsed.output : null;
    }, {
        ms: PASS_TIMEOUT_MS,
        message: 'OCR preprocessing did not finish within its time limit',
    }, scanCleanupEngineWorkerName(concurrency)), () => getPreprocessOwner().resetIdleWorkers());
}
