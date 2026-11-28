import {
    BROWSER_OCR_ENGINE_RESULT_SCHEMA,
    BROWSER_OCR_PREPROCESS_RESULT_SCHEMA,
    readBrowserOcrWasmMemoryBytes,
    type IBrowserOcrEngineResult,
    type IBrowserOcrPreprocessResult,
    type TBrowserOcrEngineRequest,
    type TBrowserOcrPreprocessRequest,
    type TBrowserOcrRecognizeRequest,
} from '@contracts/browserOcrEngine';
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import type {TOcrScanCleanupMode} from '@contracts/scan-cleanup/ocrPreprocessing';
import {BrowserWorkerClient, BrowserWorkerRequestOwner} from '@app/platform/browser-api/browserWorkerClient';
import {settleBrowserWorkerResult, type ITypedPendingBrowserWorkerRequest} from '@app/platform/browser-api/settleBrowserWorkerResult';
import {BROWSER_SCAN_CLEANUP_THREADS_WASM_PATH, BROWSER_SCAN_CLEANUP_WASM_PATH} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import {readScanCleanupEngineWorkerThreads} from '@app/platform/browser-api/scanCleanupEngineWorkerName';
import {
    MAX_LIVE_THREADED_SCAN_CLEANUP_ENGINES,
    observeScanCleanupEngineReply,
    registerScanCleanupEnginePool,
    runWithScanCleanupEngineFailover,
    scanCleanupEngineAdmission,
    threadedScanCleanupEngineBudget,
    usesThreadedScanCleanupEngine,
} from '@app/platform/browser-api/scanCleanupEngineVariant';
import type {BrowserWorkerBudget, IBrowserWorkerAdmission} from '@app/platform/browser-api/browserWorkerClient';
import {
    browserHeavyWorkerAdmission,
    runWithBrowserWorkerAdmission,
    type TBrowserHeavyWorkerCategory,
    type TBrowserWorkerCategoryLimit,
} from '@app/platform/browser-api/browserWorkerAdmission';
import {resolveBrowserEstimatedMemoryGiB, resolvePerformanceProfile} from '@app/utils/performanceProfile';
import * as v from 'valibot';

const MIB = 1024 * 1024;
// A lane keeps its Tesseract engine and models loaded between pages for a while.
const ENGINE_IDLE_TTL_MS = 60_000;
// Reclaim a preprocessing worker's scan-cleanup WASM heap promptly once idle.
const PREPROCESS_IDLE_TTL_MS = 15_000;
// Desktop stops a Tesseract pass after three minutes. Cleanup gets the same
// bound: desktop's 30 seconds assume its multithreaded engine, while this
// single-threaded one took up to 14 s on a 300 DPI letter page and would pass
// 30 s on large pages desktop cleans.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;
const PREPROCESS_BASE_WASM_BYTES = 32 * MIB;

/**
 * Retained Tesseract WebAssembly linear-memory high-water caps per device tier.
 * When a completed page grows a worker's WASM heap past this cap (e.g. a large
 * foldout), the worker is cleanly recycled between pages to return the grown
 * linear memory to the browser without interrupting in-flight recognition.
 */
export const BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_MOBILE = 256 * MIB;
export const BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY = 384 * MIB;
export const BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_DEFAULT = 512 * MIB;

export function resolveBrowserOcrWasmHeapRecycleBytes(environment?: {
    mobile?: boolean;
    lowMemory?: boolean;
    deviceMemory?: number | undefined;
}): number {
    const profile = environment ? undefined : resolvePerformanceProfile();
    const mobile = environment?.mobile ?? profile?.mobile ?? false;
    if (mobile) {
        return BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_MOBILE;
    }
    const deviceMemory =
        environment && 'deviceMemory' in environment
            ? environment.deviceMemory
            : typeof navigator === 'undefined'
              ? undefined
              : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    const lowMemory = environment?.lowMemory ?? profile?.lowMemory ?? false;
    if (lowMemory || (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory <= 4)) {
        return BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY;
    }
    return BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_DEFAULT;
}

type TPendingEngineRequest = ITypedPendingBrowserWorkerRequest<TBrowserOcrEngineRequest['type'], unknown>;

/**
 * The cleanup engine's WebAssembly memory per page pixel. It runs in
 * preprocessing workers separate from the Tesseract workers, so its heap is
 * paid once per preprocessing worker rather than once per recognition lane.
 */
const CLEANUP_BYTES_PER_PIXEL: Record<TOcrScanCleanupMode, number> = {
    clean: 40,
    'polarity-only': 16,
};

/**
 * The part of a page's engine time spent in preprocessing, measured on a
 * 300 DPI text page: cleaning takes about as long as recognizing, a polarity
 * check about a quarter as long. A job needs this share of its lanes as
 * preprocessing workers for none of its Tesseract lanes to wait on one.
 */
const PREPROCESS_TIME_SHARE: Record<TOcrScanCleanupMode, number> = {
    clean: 0.5,
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
    const memoryGb = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    const single = {
        lanes: 1,
        preprocessLanes: cleanup ? 1 : 0,
    };
    if (memoryGb !== undefined && memoryGb <= 4) {
        return single;
    }
    const effectiveMemoryGb = memoryGb ?? resolveBrowserEstimatedMemoryGiB();
    const totalBudget = (effectiveMemoryGb * 1024 ** 3) / 2;
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
        if (affordable < 1 || fedLanes <= bestFedLanes) {
            continue;
        }
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
    engine?: {
        budget?: BrowserWorkerBudget;
        preloadWasmPaths?: (key: string | undefined) => readonly string[];
        wasmHeapRecycleCap?: () => number;
    },
) {
    let retainedWasmBytes = 0;
    const client = new BrowserWorkerClient<TPendingEngineRequest>({
        idleTtlMs,
        createWorker: (name) => {
            retainedWasmBytes = 0;
            return createWorker(name);
        },
        ...(engine?.budget ? {budget: engine.budget} : {}),
        ...(engine?.preloadWasmPaths ? {preloadWasmPaths: engine.preloadWasmPaths} : {}),
        createError: (event) =>
            new BrowserOcrEngineUnavailableError(event.error instanceof Error ? event.error.message : event.message || fallbackMessage),
        handleMessage: (pendingRequests, response, onSettled) => {
            if (engine?.budget) {
                observeScanCleanupEngineReply(response);
            }
            const responseId = getBrowserPageOpsWorkerRequestId(response);
            const hadPending = responseId !== null && pendingRequests.has(responseId);
            const reportedWasmBytes = hadPending && engine?.wasmHeapRecycleCap ? readBrowserOcrWasmMemoryBytes(response) : null;
            settleBrowserWorkerResult(pendingRequests, response, onSettled);
            if (!hadPending || pendingRequests.has(responseId!)) {
                return;
            }
            if (reportedWasmBytes !== null) {
                retainedWasmBytes = Math.max(retainedWasmBytes, reportedWasmBytes);
            }
            // Recycle cleanly between pages once the worker's retained WASM linear
            // memory exceeds the tier cap so foldouts never permanently pin huge heaps.
            if (engine?.wasmHeapRecycleCap && pendingRequests.size === 0 && retainedWasmBytes > engine.wasmHeapRecycleCap()) {
                retainedWasmBytes = 0;
                client.resetWorker();
            }
        },
    });
    return client;
}

let recognizeOwner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;
let preprocessOwner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;

function getRecognizeOwner() {
    recognizeOwner ??= new BrowserWorkerRequestOwner(
        () =>
            createWorkerClient(
                () => new Worker(new URL('./browserOcrEngine.worker.ts', import.meta.url), {type: 'module'}),
                ENGINE_IDLE_TTL_MS,
                'The OCR engine stopped',
                {
                    wasmHeapRecycleCap: resolveBrowserOcrWasmHeapRecycleBytes,
                },
            ),
        resolveBrowserOcrLanes().lanes,
    );
    return recognizeOwner;
}

function getPreprocessOwner() {
    if (preprocessOwner === null) {
        const pool = new BrowserWorkerRequestOwner(
            () =>
                createWorkerClient(
                    // The worker's name tells it which cleanup engine to run, on how many threads.
                    (name) =>
                        new Worker(new URL('./browserOcrPreprocess.worker.ts', import.meta.url), {
                            type: 'module',
                            name: name ?? '',
                        }),
                    PREPROCESS_IDLE_TTL_MS,
                    'The OCR preprocessing engine stopped',
                    {
                        budget: threadedScanCleanupEngineBudget,
                        preloadWasmPaths: (name) => [
                            readScanCleanupEngineWorkerThreads(name) !== null
                                ? BROWSER_SCAN_CLEANUP_THREADS_WASM_PATH
                                : BROWSER_SCAN_CLEANUP_WASM_PATH,
                        ],
                    },
                ),
            // A job preprocesses on as many of these as its own page size affords.
            resolveBrowserOcrLanes().lanes,
            threadedScanCleanupEngineBudget,
        );
        registerScanCleanupEnginePool(() => {
            pool.resetIdleWorkers();
            browserHeavyWorkerAdmission.wake();
        });
        threadedScanCleanupEngineBudget.onRelease(() => browserHeavyWorkerAdmission.wake());
        preprocessOwner = pool;
    }
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
        message: string;
    },
    admission: IBrowserWorkerAdmission = {},
    category: TBrowserHeavyWorkerCategory = 'ocr',
    categoryLimit?: TBrowserWorkerCategoryLimit,
): Promise<TResult> {
    const {payload} = request;
    const closeTiles = () => {
        if (!(payload.image instanceof Uint8Array)) {
            payload.image.tiles.forEach((tile) => tile.close());
        }
    };
    // A page that waited for a worker may arrive after its job was canceled.
    if (signal.aborted) {
        closeTiles();
    }
    signal.throwIfAborted();
    const createAbortError = () => (signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'));
    return runWithBrowserWorkerAdmission(
        {
            category,
            priority: 'batch',
            ...(categoryLimit === undefined ? {} : {categoryLimit}),
            signal,
            createAbortError,
        },
        () => {
            const requestId = pool.createRequestId();
            const onAbort = () => pool.cancel(requestId, createAbortError());
            signal.addEventListener('abort', onAbort, {once: true});
            return pool
                .run(
                    requestId,
                    (client, _isAdmitted, workerKey) =>
                        new Promise<TResult>((resolve, reject) => {
                            const worker = client.getWorker(workerKey);
                            client.registerPendingRequest(
                                requestId,
                                {
                                    requestType: request.type,
                                    reject,
                                    resolveData: (data) => {
                                        const result = readResult(data);
                                        if (result === null) {
                                            return false;
                                        }
                                        resolve(result);
                                        return true;
                                    },
                                },
                                () => new Error(timeout.message),
                                timeout.ms,
                            );
                            worker.postMessage(
                                {
                                    ...request,
                                    id: requestId,
                                },
                                payload.image instanceof Uint8Array ? [payload.image.buffer] : payload.image.tiles,
                            );
                        }),
                    admission,
                )
                .finally(() => {
                    signal.removeEventListener('abort', onAbort);
                });
        },
    ).finally(() => {
        closeTiles();
    });
}

/** Runs one page's Tesseract passes on the dedicated Tesseract worker pool. */
export function runBrowserOcrEngine(
    payload: TBrowserOcrRecognizeRequest['payload'],
    signal: AbortSignal,
): Promise<IBrowserOcrEngineResult> {
    return runWorkerRequest(
        getRecognizeOwner(),
        {
            type: 'recognize',
            payload,
        },
        signal,
        (data) => {
            const parsed = v.safeParse(BROWSER_OCR_ENGINE_RESULT_SCHEMA, data, {abortEarly: true});
            return parsed.success && parsed.output.passes.length === payload.passes.length ? parsed.output : null;
        },
        {
            ms: PASS_TIMEOUT_MS * payload.passes.length,
            message: 'Tesseract did not finish within its time limit',
        },
    );
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
    const threadedKeepFree = (concurrency ?? 1) > 1 ? 1 : 0;
    const categoryLimit: TBrowserWorkerCategoryLimit = () => {
        if (!usesThreadedScanCleanupEngine()) {
            return undefined;
        }
        const threadedLimit = MAX_LIVE_THREADED_SCAN_CLEANUP_ENGINES - threadedKeepFree;
        const {activeByCategory} = browserHeavyWorkerAdmission.snapshot();
        const threadedGranted = activeByCategory['scan-cleanup'] + activeByCategory['ocr-preprocess'];
        if (!threadedScanCleanupEngineBudget.admits(threadedKeepFree) || threadedGranted >= threadedLimit) {
            return 0;
        }
        return threadedLimit;
    };
    return runWithScanCleanupEngineFailover(payload, (attempt) =>
        runWorkerRequest(
            getPreprocessOwner(),
            {
                type: 'preprocess',
                payload: attempt,
            },
            signal,
            (data) => {
                const parsed = v.safeParse(BROWSER_OCR_PREPROCESS_RESULT_SCHEMA, data, {abortEarly: true});
                return parsed.success ? parsed.output : null;
            },
            {
                ms: PASS_TIMEOUT_MS,
                message: 'OCR preprocessing did not finish within its time limit',
            },
            scanCleanupEngineAdmission(concurrency),
            'ocr-preprocess',
            categoryLimit,
        ),
    );
}
