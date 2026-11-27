import {
    BROWSER_QPDF_ENGINE_ERROR_CODES,
    BROWSER_QPDF_ENGINE_REVISION,
    BROWSER_QPDF_MAX_INPUT_BYTES,
    BROWSER_QPDF_RUN_RESULT_SCHEMA,
    type IBrowserQpdfNormalizeResult,
    type IBrowserQpdfRunResult,
    type TBrowserQpdfCommand,
    type TBrowserQpdfEngineRequest,
} from '@contracts/browserQpdfEngine';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import {SerializableError} from '@contracts/serializableError';
import {
    BrowserPageOpsWorkerUnavailableError,
    runBrowserPageOpsWorkerRequest,
} from '@app/platform/browser-api/browserPageOpsWorkerClient';
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
import {getErrorMessage} from '@app/utils/error';
import * as v from 'valibot';
import {QPDF_LOSSLESS_REWRITE_TIMEOUT_MS} from '@pdf-core/qpdfCommands';

// Each command instantiates and drops its Emscripten FS/WASM memory when done,
// keeping only the compiled module; a 15 s idle TTL avoids cold-booting the
// worker and re-importing the module on sequential qpdf commands.
const ENGINE_IDLE_TTL_MS = 15_000;
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
        preloadWasmPaths: () => [`/wasm/evb-qpdf.wasm?revision=${BROWSER_QPDF_ENGINE_REVISION}`],
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
    payload: Record<string, unknown> & {input: Uint8Array | Blob},
    schema: TSchema,
    options: IBrowserQpdfRequestOptions,
): Promise<v.InferOutput<TSchema>> {
    type TResult = v.InferOutput<TSchema>;
    const {signal} = options;
    signal?.throwIfAborted();
    if (!canUseBrowserWorker()) {
        return Promise.reject(new BrowserQpdfEngineUnavailableError('This browser cannot run the qpdf engine worker'));
    }
    // Bytes are transferred to the engine; a Blob is posted by reference and read there by range.
    const input = payload.input instanceof Blob ? payload.input : toTransferableUint8Array(payload.input);
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
                if (!parsed.success) {return false;}
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
        }, input instanceof Blob ? [] : [input.buffer]);
    })).finally(() => signal?.removeEventListener('abort', onAbort));
}

/**
 * Runs one of desktop's qpdf commands (`@pdf-core/qpdfCommands`) on a PDF.
 * The engine takes bytes over; a Blob, such as a store document's
 * `readableBlob`, stays the caller's and is read by range. The caller applies desktop's exit policy:
 * `isQpdfSuccessExitCode`, with warnings from `extractQpdfWarnings`.
 * Canceling or a timeout ends the engine mid-command.
 */
export function runBrowserQpdfCommand(
    command: TBrowserQpdfCommand,
    input: Uint8Array | Blob,
    options: IBrowserQpdfRequestOptions = {},
): Promise<IBrowserQpdfRunResult> {
    return requestEngine('run', {
        command,
        input,
    }, BROWSER_QPDF_RUN_RESULT_SCHEMA, options);
}

async function readAppendAdmissionVerdict(
    input: Uint8Array | Blob,
    options: IBrowserQpdfRequestOptions,
) {
    const source = input instanceof Blob ? input : new Blob([input as Uint8Array<ArrayBuffer>]);
    if (source.size === 0 || source.size > BROWSER_QPDF_MAX_INPUT_BYTES) {
        throw new SerializableError({
            code: BROWSER_QPDF_ENGINE_ERROR_CODES.failed,
            message: 'Invalid browser qpdf engine request',
        });
    }
    let result;
    try {
        result = await runBrowserPageOpsWorkerRequest('appendAdmission', {source}, {
            requireWorker: true,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
        });
    } catch (error) {
        if (options.signal?.aborted) {throw error;}
        if (error instanceof BrowserPageOpsWorkerUnavailableError) {
            throw new BrowserQpdfEngineUnavailableError(error.message);
        }
        throw new BrowserQpdfEngineUnavailableError(getErrorMessage(error));
    }
    if (isBrowserPageOpsWasmFailure(result)) {
        if (result.error.code === 'io' || result.error.code === 'timeout') {
            throw new BrowserQpdfEngineUnavailableError(result.error.message);
        }
        throw new SerializableError({
            code: BROWSER_QPDF_ENGINE_ERROR_CODES.failed,
            message: result.error.message,
        });
    }
    return result.verdict;
}

/**
 * Desktop's open-time append admission and repair: judges the PDF in the shared
 * page-ops worker (eliminating a duplicate `evb-pdf-page-ops.wasm` instance
 * inside the qpdf worker), and spawns qpdf only when the verdict is `repairable`.
 */
export async function normalizeBrowserPdfAppendBase(
    input: Uint8Array | Blob,
    options: IBrowserQpdfRequestOptions = {},
): Promise<IBrowserQpdfNormalizeResult> {
    options.signal?.throwIfAborted();
    if (!canUseBrowserWorker()) {
        throw new BrowserQpdfEngineUnavailableError('This browser cannot run the qpdf engine worker');
    }
    const verdict = await readAppendAdmissionVerdict(input, options);
    if (verdict !== 'repairable') {
        return {
            verdict,
            output: null,
            stderr: '',
        };
    }
    const rewrite = await runBrowserQpdfCommand('rewrite', input, options);
    if (rewrite.output === null) {
        throw new SerializableError({
            code: BROWSER_QPDF_ENGINE_ERROR_CODES.rewriteFailed,
            message: `qpdf exited with code ${rewrite.exitCode}: ${rewrite.stderr.trim()}`,
        });
    }
    if (await readAppendAdmissionVerdict(rewrite.output, options) === 'repairable') {
        throw new SerializableError({
            code: BROWSER_QPDF_ENGINE_ERROR_CODES.rewriteFailed,
            message: 'The rewritten PDF still cannot take an edit',
        });
    }
    return {
        verdict,
        output: rewrite.output,
        stderr: rewrite.stderr,
    };
}
