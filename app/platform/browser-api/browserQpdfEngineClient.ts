import {
    BROWSER_QPDF_ENGINE_ERROR_CODES,
    BROWSER_QPDF_NORMALIZE_RESULT_SCHEMA,
    BROWSER_QPDF_RUN_RESULT_SCHEMA,
    type IBrowserQpdfNormalizeResult,
    type IBrowserQpdfRunResult,
    type TBrowserQpdfCommand,
    type TBrowserQpdfEngineRequest,
} from '@contracts/browserQpdfEngine';
import {SerializableError} from '@contracts/serializableError';
import {
    BrowserWorkerClient,
    BrowserWorkerRequestOwner,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import {
    settleBrowserWorkerResult,
    type ITypedPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/settleBrowserWorkerResult';
import {toTransferableUint8Array} from '@app/platform/browser-api/toTransferableUint8Array';
import * as v from 'valibot';
import {QPDF_LOSSLESS_REWRITE_TIMEOUT_MS} from '@pdf-core/qpdfCommands';

// A job holds whole documents in Wasm memory and the file system, and the
// document's own open needs that memory next, so the worker ends as soon as it
// is idle. The browser keeps the compiled engine cached between workers.
const ENGINE_IDLE_TTL_MS = 0;
// Desktop bounds a whole-file qpdf rewrite by ten minutes.
const DEFAULT_TIMEOUT_MS = QPDF_LOSSLESS_REWRITE_TIMEOUT_MS;

type TRequestType = TBrowserQpdfEngineRequest['type'];
type TPendingEngineRequest = ITypedPendingBrowserWorkerRequest<TRequestType, unknown>;

export interface IBrowserQpdfRequestOptions {
    signal?: AbortSignal;
    /** Ends the engine when the command takes longer; defaults to desktop's rewrite bound. */
    timeoutMs?: number;
}

export class BrowserQpdfEngineTimeoutError extends Error {
    public constructor(public readonly timeoutMs: number) {
        super(`qpdf did not finish within ${timeoutMs}ms`);
        this.name = 'BrowserQpdfEngineTimeoutError';
    }
}

export class BrowserQpdfEngineUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserQpdfEngineUnavailableError';
    }
}

/** The engine could not be downloaded or started, so nothing judged the PDF. */
export function isBrowserQpdfEngineUnavailableError(error: unknown) {
    return error instanceof BrowserQpdfEngineUnavailableError
        || (error instanceof SerializableError && error.code === BROWSER_QPDF_ENGINE_ERROR_CODES.unavailable);
}

function createEngineClient() {
    return new BrowserWorkerClient<TPendingEngineRequest>({
        idleTtlMs: ENGINE_IDLE_TTL_MS,
        createWorker: () => new Worker(
            new URL('./browserQpdfEngine.worker.ts', import.meta.url),
            {type: 'module'},
        ),
        createError: event => new BrowserQpdfEngineUnavailableError(
            event.error instanceof Error ? event.error.message : event.message || 'The qpdf engine stopped',
        ),
        handleMessage: settleBrowserWorkerResult,
    });
}

let owner: BrowserWorkerRequestOwner<TPendingEngineRequest> | null = null;

/** One engine at a time: each holds whole documents in memory. */
function getOwner() {
    owner ??= new BrowserWorkerRequestOwner(createEngineClient, 1);
    return owner;
}

function requestEngine<TSchema extends v.GenericSchema>(
    type: TRequestType,
    payload: Record<string, unknown> & {input: Uint8Array},
    schema: TSchema,
    options: IBrowserQpdfRequestOptions,
): Promise<v.InferOutput<TSchema>> {
    type TResult = v.InferOutput<TSchema>;
    const {signal} = options;
    signal?.throwIfAborted();
    if (!canUseBrowserWorker()) {
        return Promise.reject(new BrowserQpdfEngineUnavailableError('This browser cannot run the qpdf engine worker'));
    }
    const input = toTransferableUint8Array(payload.input);
    const engines = getOwner();
    const requestId = engines.createRequestId();
    const createAbortError = () => signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('qpdf was canceled', 'AbortError');
    const onAbort = () => engines.cancel(requestId, createAbortError());
    signal?.addEventListener('abort', onAbort, {once: true});
    return engines.run(requestId, (client, isAdmitted) => new Promise<TResult>((resolve, reject) => {
        if (!isAdmitted()) {
            reject(createAbortError());
            return;
        }
        const worker = client.getWorker();
        client.registerPendingRequest(requestId, {
            requestType: type,
            reject,
            resolveData: (data) => {
                const parsed = v.safeParse(schema, data, {abortEarly: true});
                if (!parsed.success) return false;
                resolve(parsed.output);
                return true;
            },
        }, () => new BrowserQpdfEngineTimeoutError(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        worker.postMessage({
            id: requestId,
            type,
            payload: {
                ...payload,
                input,
            },
        }, [input.buffer]);
    })).finally(() => signal?.removeEventListener('abort', onAbort));
}

/**
 * Runs one of desktop's qpdf commands (`@pdf-core/qpdfCommands`) on a PDF.
 * The engine takes `input` over. The caller applies desktop's exit policy:
 * `isQpdfSuccessExitCode`, with warnings from `extractQpdfWarnings`.
 * Canceling or a timeout ends the engine mid-command.
 */
export function runBrowserQpdfCommand(
    command: TBrowserQpdfCommand,
    input: Uint8Array,
    options: IBrowserQpdfRequestOptions = {},
): Promise<IBrowserQpdfRunResult> {
    return requestEngine('run', {
        command,
        input,
    }, BROWSER_QPDF_RUN_RESULT_SCHEMA, options);
}

/**
 * Desktop's open-time append admission and repair: returns the qpdf rewrite
 * of a PDF whose cross-reference chain an edit cannot extend, or null output
 * when the PDF stands. The engine takes `input` over.
 */
export function normalizeBrowserPdfAppendBase(
    input: Uint8Array,
    options: IBrowserQpdfRequestOptions = {},
): Promise<IBrowserQpdfNormalizeResult> {
    return requestEngine('normalize-append-base', {input}, BROWSER_QPDF_NORMALIZE_RESULT_SCHEMA, options);
}
