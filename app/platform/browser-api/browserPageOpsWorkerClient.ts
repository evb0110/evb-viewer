import type {
    IBrowserPdfCombineBookmarkEntry,
    IBrowserPdfCombineCatalog,
    IBrowserPdfCombinePageLabelRange,
    IBrowserPdfConformanceFacts,
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import {decodePageGeometry} from '@contracts/decodePageGeometry';
import {isRecord} from '@contracts/runtimeGuards';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import {browserAnnotationParseIsolation} from '@app/platform/browser-api/browserAnnotationParseIsolation';
import {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';
import { getErrorMessage } from '@app/utils/error';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    detectRendererDiagnosticsHost,
    getRendererFailureReporter,
    initializeRendererFailureReporter,
} from '@app/utils/failureReporter';

const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS = 90_000;

export {BrowserPageOpsWorkerUnavailableError} from '@app/platform/browser-api/browserPageOpsWorkerUnavailableError';

interface IBrowserPageOpsWorkerFailure extends Error {failure?: FailureReceipt;}

function getWorkerFailureReceipt(error: unknown) {
    if (!(error instanceof Error)) {
        return undefined;
    }
    return (error as IBrowserPageOpsWorkerFailure).failure;
}

function reportWorkerFailure(error: Error) {
    const existingReceipt = getWorkerFailureReceipt(error);
    if (existingReceipt) {
        return error;
    }

    const reporter = getRendererFailureReporter() ?? initializeRendererFailureReporter({host: detectRendererDiagnosticsHost()});
    const receipt = reporter.capture({
        code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
        context: {},
        local: {
            source: 'browser-page-ops-worker-parent',
            message: error.message,
            cause: error,
        },
    }, {runtime: 'browser-worker-parent'});
    if (receipt) {
        Object.defineProperty(error, 'failure', {
            configurable: true,
            value: receipt,
        });
    }
    return error;
}

interface IBuildWorkerRequestWithTransfersOptions {preserveInputOwnership?: boolean;}

function buildWorkerRequestWithTransfers(
    request: TBrowserPageOpsWorkerRequest,
    options: IBuildWorkerRequestWithTransfersOptions = {},
) {
    const toTransferableRequestData = (data: Uint8Array) => options.preserveInputOwnership
        ? toTransferableUint8Array(data.slice())
        : toTransferableUint8Array(data);
    const transfer: Transferable[] = [];
    if (request.type === 'insertPages') {
        const transferableData = toTransferableRequestData(request.payload.data);
        const transferableInsertionData = toTransferableRequestData(request.payload.insertionData);
        return {
            request: {
                ...request,
                payload: {
                    ...request.payload,
                    data: transferableData,
                    insertionData: transferableInsertionData,
                },
            },
            transfer: [
                transferableData.buffer,
                transferableInsertionData.buffer,
            ] satisfies Transferable[],
        };
    }

    if (request.type === 'mergePages') {
        const transferredBuffers = new Set<ArrayBuffer>();
        const documents = request.payload.documents.map((document) => {
            let data = toTransferableRequestData(document);
            if (transferredBuffers.has(data.buffer)) {
                data = data.slice();
            }
            transferredBuffers.add(data.buffer);
            transfer.push(data.buffer);
            return data;
        });
        return {
            request: {
                ...request,
                payload: {documents},
            },
            transfer,
        };
    }

    const transferableData = toTransferableRequestData(request.payload.data);
    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                data: transferableData,
            },
        },
        transfer: [transferableData.buffer] satisfies Transferable[],
    };
}


function decodePageMutationWorkerResult(data: unknown): IPageMutationWorkerResult | null {
    if (
        !isRecord(data)
        || !(data.data instanceof Uint8Array)
        || typeof data.pageCount !== 'number'
        || !Number.isInteger(data.pageCount)
        || data.pageCount < 1
    ) {
        return null;
    }

    return {
        data: data.data,
        pageCount: data.pageCount,
    };
}

function decodeAnnotationParseWorkerResult(data: unknown) {
    return isRecord(data) && data.data instanceof Uint8Array
        ? {data: data.data}
        : null;
}

function decodePdfCombineBookmark(value: unknown, depth: number, count: {value: number}): IBrowserPdfCombineBookmarkEntry | null {
    if (
        !isRecord(value)
        || depth >= 256
        || count.value >= 100_000
        || typeof value.title !== 'string'
        || (value.pageIndex !== null && (typeof value.pageIndex !== 'number' || !Number.isSafeInteger(value.pageIndex) || value.pageIndex < 0))
        || (value.namedDest !== null && typeof value.namedDest !== 'string')
        || typeof value.bold !== 'boolean'
        || typeof value.italic !== 'boolean'
        || (value.color !== null && typeof value.color !== 'string')
        || !Array.isArray(value.items)
    ) {
        return null;
    }
    count.value += 1;
    const items: IBrowserPdfCombineBookmarkEntry[] = [];
    for (const item of value.items) {
        const decoded = decodePdfCombineBookmark(item, depth + 1, count);
        if (decoded === null) {
            return null;
        }
        items.push(decoded);
    }
    return {
        title: value.title,
        pageIndex: value.pageIndex,
        ...(value.pageYRatio === undefined ? {} : {pageYRatio: value.pageYRatio as number | null}),
        namedDest: value.namedDest,
        bold: value.bold,
        italic: value.italic,
        color: value.color,
        items,
    };
}

function decodePdfCombineCatalog(data: unknown): IBrowserPdfCombineCatalog | null {
    if (!isRecord(data) || !Array.isArray(data.bookmarks) || !Array.isArray(data.pageLabels)) {
        return null;
    }
    if (data.bookmarks.length > 100_000 || data.pageLabels.length > 100_000) {
        return null;
    }
    const count = {value: 0};
    const bookmarks: IBrowserPdfCombineBookmarkEntry[] = [];
    for (const bookmark of data.bookmarks) {
        const decoded = decodePdfCombineBookmark(bookmark, 0, count);
        if (decoded === null) {
            return null;
        }
        bookmarks.push(decoded);
    }
    const pageLabels: IBrowserPdfCombinePageLabelRange[] = [];
    for (const value of data.pageLabels) {
        if (
            !isRecord(value)
            || typeof value.pageIndex !== 'number'
            || !Number.isSafeInteger(value.pageIndex)
            || value.pageIndex < 0
            || (value.style !== undefined && typeof value.style !== 'string')
            || (value.prefix !== undefined && typeof value.prefix !== 'string')
            || (value.start !== undefined && (typeof value.start !== 'number' || !Number.isSafeInteger(value.start) || value.start < 0))
        ) {
            return null;
        }
        pageLabels.push({
            pageIndex: value.pageIndex,
            ...(value.style === undefined ? {} : {style: value.style}),
            ...(value.prefix === undefined ? {} : {prefix: value.prefix}),
            ...(value.start === undefined ? {} : {start: value.start}),
        });
    }
    return {
        bookmarks,
        pageLabels,
    };
}

function decodePdfConformanceFacts(data: unknown): IBrowserPdfConformanceFacts | null {
    if (isRecord(data)
        && typeof data.isSigned === 'boolean'
        && typeof data.isEncrypted === 'boolean'
        && typeof data.isTagged === 'boolean'
        && typeof data.hasAcroForm === 'boolean'
        && typeof data.hasXfa === 'boolean') {
        return {
            isSigned: data.isSigned,
            isEncrypted: data.isEncrypted,
            isTagged: data.isTagged,
            hasAcroForm: data.hasAcroForm,
            hasXfa: data.hasXfa,
        };
    }
    return null;
}

function decodePageOpsWorkerResult<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserPageOpsWorkerResultMap[K] | null {
    if (type === 'getPageGeometry') {
        return decodePageGeometry(data) as IBrowserPageOpsWorkerResultMap[K] | null;
    }

    if (type === 'parseAnnotations') {
        return decodeAnnotationParseWorkerResult(data) as IBrowserPageOpsWorkerResultMap[K] | null;
    }

    if (type === 'readCatalog') {
        return decodePdfCombineCatalog(data) as IBrowserPageOpsWorkerResultMap[K] | null;
    }

    if (type === 'conformance') {
        return decodePdfConformanceFacts(data) as IBrowserPageOpsWorkerResultMap[K] | null;
    }

    return decodePageMutationWorkerResult(data) as IBrowserPageOpsWorkerResultMap[K] | null;
}

export function canUseBrowserPageOpsWorker() {
    return canUseBrowserWorker();
}

function createBrowserPageOpsWorkerClient() {
    return new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
        idleTtlMs: BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS,
        requestTimeoutMs: BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS,
        createWorker: () => {
            try {
                return new Worker(
                    new URL('./browserPageOps.worker.ts', import.meta.url),
                    { type: 'module' },
                );
            } catch (error) {
                throw reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
                    getErrorMessage(error),
                ));
            }
        },
        createError: event => reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
            event.error instanceof Error ? event.error.message : event.message,
        )),
        handleMessage: settleBrowserWorkerResult,
    });
}

const browserPageOpsWorkerClient = createBrowserPageOpsWorkerClient();

interface IRunBrowserPageOpsWorkerRequestOptions {
    signal?: AbortSignal;
    dedicated?: boolean;
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Browser page operation request was aborted');
}

async function runBrowserPageOpsWorkerRequestWithClient<K extends TBrowserPageOpsWorkerRequestType>(
    client: BrowserWorkerClient<IPendingBrowserWorkerRequest>,
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: {
        signal?: AbortSignal;
        preserveInputOwnership?: boolean;
        disposeWorkerOnSettlement?: boolean;
    } = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const request: IBrowserPageOpsWorkerRequest<K> = {
        id: client.createRequestId(),
        type,
        payload,
    };

    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const worker = client.getWorker();

    return new Promise<IBrowserPageOpsWorkerResultMap[K]>((resolve, reject) => {
        let removeAbortListener: () => void = () => undefined;
        let settled = false;
        const finish = () => {
            if (settled) {
                return false;
            }
            settled = true;
            removeAbortListener();
            if (options.disposeWorkerOnSettlement) {
                client.resetWorker();
            }
            return true;
        };
        const rejectRequest = (error: Error) => {
            if (!finish()) {
                return;
            }
            reject(error);
        };
        client.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (value) => {
                if (settled) {
                    return false;
                }
                const decoded = decodePageOpsWorkerResult(type, value);
                if (!decoded) {
                    return false;
                }
                finish();
                resolve(decoded);
                return true;
            },
            reject: error => rejectRequest(reportWorkerFailure(error)),
        }, () => reportWorkerFailure(new BrowserPageOpsWorkerUnavailableError(
            `Browser page operation worker request timed out after ${BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS}ms`,
        )));

        if (options.signal) {
            const handleAbort = () => client.cancelPendingRequest(
                request.id,
                abortErrorFromSignal(options.signal!),
                {resetWorker: true},
            );
            options.signal.addEventListener('abort', handleAbort, {once: true});
            removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
            if (options.signal.aborted) {
                handleAbort();
                return;
            }
        }

        try {
            const workerRequest = buildWorkerRequestWithTransfers(
                request as TBrowserPageOpsWorkerRequest,
                options.preserveInputOwnership === undefined
                    ? {}
                    : {preserveInputOwnership: options.preserveInputOwnership},
            );
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            client.cancelPendingRequest(
                request.id,
                reportWorkerFailure(error instanceof Error ? error : new Error(String(error))),
            );
        }
    });
}

async function runDedicatedBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    signal?: AbortSignal,
) {
    const releaseAdmission = await browserAnnotationParseIsolation.acquire(signal);
    const client = createBrowserPageOpsWorkerClient();
    try {
        return await runBrowserPageOpsWorkerRequestWithClient(client, type, payload, {
            ...(signal ? {signal} : {}),
            preserveInputOwnership: true,
            disposeWorkerOnSettlement: true,
        });
    } finally {
        client.resetWorker();
        releaseAdmission();
    }
}

export async function runBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
    options: IRunBrowserPageOpsWorkerRequestOptions = {},
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    if (options.dedicated) {
        return runDedicatedBrowserPageOpsWorkerRequest(type, payload, options.signal);
    }

    return runBrowserPageOpsWorkerRequestWithClient(
        browserPageOpsWorkerClient,
        type,
        payload,
        options.signal ? {signal: options.signal} : {},
    );
}
