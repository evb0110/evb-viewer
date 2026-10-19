import {
    BROWSER_OCR_ENGINE_RESULT_SCHEMA,
    type IBrowserOcrEngineResult,
    type TBrowserOcrEngineRequest,
} from '@app/platform/browser-api/browserOcrEngine.types';
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
// Desktop stops a Tesseract pass after three minutes.
const PASS_TIMEOUT_MS = 3 * 60 * 1000;

type TPendingEngineRequest = ITypedPendingBrowserWorkerRequest<'recognize', unknown>;

/**
 * Pages recognized at once. Each lane is a worker holding one engine and its
 * models (a few hundred MB while a page runs), so a lane needs a core and the
 * memory to match; devices that report 4 GB or less get one.
 */
export function getBrowserOcrLaneCount() {
    const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
    const memoryGb = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    if (memoryGb !== undefined && memoryGb <= 4) return 1;
    return Math.min(4, Math.max(1, Math.floor(cores / 2)));
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
 * Runs one page's Tesseract passes in a free lane. Canceling stops the
 * engine: a lane busy in Tesseract cannot read messages, so its worker ends.
 */
export function runBrowserOcrEngine(
    payload: TBrowserOcrEngineRequest['payload'],
    signal: AbortSignal,
): Promise<IBrowserOcrEngineResult> {
    signal.throwIfAborted();
    const engines = getOwner();
    const requestId = engines.createRequestId();
    const onAbort = () => engines.cancel(
        requestId,
        signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, {once: true});
    return engines.run(requestId, (client, isAdmitted) => new Promise<IBrowserOcrEngineResult>((resolve, reject) => {
        if (!isAdmitted()) {
            reject(new DOMException('OCR was canceled', 'AbortError'));
            return;
        }
        const worker = client.getWorker();
        client.registerPendingRequest(requestId, {
            requestType: 'recognize',
            reject,
            resolveData: (data) => {
                const parsed = v.safeParse(BROWSER_OCR_ENGINE_RESULT_SCHEMA, data, {abortEarly: true});
                if (!parsed.success || parsed.output.passes.length !== payload.passes.length) return false;
                resolve(parsed.output);
                return true;
            },
        }, () => new Error('Tesseract did not finish within its time limit'), PASS_TIMEOUT_MS * payload.passes.length);
        const request: TBrowserOcrEngineRequest = {
            id: requestId,
            type: 'recognize',
            payload,
        };
        worker.postMessage(request, [payload.image.buffer]);
    })).finally(() => signal.removeEventListener('abort', onAbort));
}
