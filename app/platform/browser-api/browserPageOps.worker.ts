import {
    getPageGeometryFromPdfBytes,
    parsePdfAnnotations,
    readPdfCatalog,
    readPdfConformance,
} from '@app/platform/browser-api/browserPageOpsCore';
import type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerResponse,
} from '@contracts/browserPageOpsWorker';
import {
    EVICT_BROWSER_PAGE_OPS_DOCUMENT_MESSAGE_TYPE,
    getBrowserPageOpsWorkerRequestId,
    parseBrowserPageOpsWorkerRequest,
} from '@contracts/browserPageOpsWorker';
import {
    evictCachedBrowserPageOpsDocument,
    tryRunBrowserPageOpsWithWasm,
    isBrowserPageOpsWasmFailure,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {
    createSyncBlobSource,
    PDF_PAGE_OPS_WASM_PATH,
    runPageStructureEdit,
    type IPageStructureFiles,
} from '@app/platform/browser/pdfPageEngine';
import {opfsFileHandle} from '@app/platform/browser/opfsFileHandle';
import {
    handlePrecompiledWasmModuleMessage,
    readLoadedWasmDigest,
} from '@app/platform/browser/loadWasmWithDeadline';
import {toTransferableUint8Array} from '@app/platform/browser/toTransferableUint8Array';
import { getErrorMessage } from '@app/utils/error';

const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

type TPageStructureSink = IPageStructureFiles['sink'] & {
    /** Makes the output durable; returns its bytes when it has no file. */
    finish(length: number): Uint8Array | undefined;
    close(): void;
};

/**
 * The new revision file at the store path `output`. No other context opens it before the edit is committed,
 * so this worker is its one writer; a file left by an edit that was stopped is overwritten from its start.
 */
async function openStoreSink(output: string): Promise<TPageStructureSink> {
    const handle = await (await opfsFileHandle(output, true)).createSyncAccessHandle();
    handle.truncate(0);
    return {
        write(bytes, at) {
            // Chromium throws QuotaExceededError when the store is full; Firefox stores fewer bytes.
            if (handle.write(bytes, {at}) !== bytes.byteLength) {
                throw new DOMException('The browser\'s storage is full', 'QuotaExceededError');
            }
        },
        read(into, at) {
            if (handle.read(into, {at}) !== into.byteLength) throw new Error('The written file ended early');
        },
        finish() {
            handle.flush();
            return undefined;
        },
        close: () => handle.close(),
    };
}

/** The output of a document the browser keeps in memory, returned as bytes. */
function createMemorySink(): TPageStructureSink {
    let buffer = new Uint8Array(1 << 20);
    let length = 0;
    return {
        write(bytes, at) {
            const end = at + bytes.byteLength;
            if (end > buffer.byteLength) {
                const grown = new Uint8Array(Math.max(end, buffer.byteLength * 2));
                grown.set(buffer.subarray(0, length));
                buffer = grown;
            }
            buffer.set(bytes, at);
            length = Math.max(length, end);
        },
        read(into, at) {
            if (at + into.byteLength > length) throw new Error('The written output ended early');
            into.set(buffer.subarray(at, at + into.byteLength));
        },
        finish: written => buffer.slice(0, written),
        close: () => undefined,
    };
}

async function handlePageStructureRequest(
    request: IBrowserPageOpsWorkerRequest<'pageStructure'>,
): Promise<IBrowserPageOpsWorkerResultMap['pageStructure']> {
    const {edit, sources, output} = request.payload;
    const sink = output === null ? createMemorySink() : await openStoreSink(output);
    try {
        const reader = new FileReaderSync();
        const result = await runPageStructureEdit(edit, {
            sources: sources.map(blob => createSyncBlobSource(blob, reader)),
            sink,
            // Read asynchronously: each read ends a task, which releases its buffer.
            async copy(copies) {
                for (const {source, from, length, at} of copies) {
                    for (let done = 0; done < length; done += COPY_CHUNK_BYTES) {
                        const end = from + Math.min(length, done + COPY_CHUNK_BYTES);
                        const bytes = new Uint8Array(await sources[source]!.slice(from + done, end).arrayBuffer());
                        if (bytes.byteLength !== end - from - done) throw new Error('The document ended before its cross-reference said');
                        sink.write(bytes, at + done);
                    }
                }
            },
        });
        if (isBrowserPageOpsWasmFailure(result)) return result;
        const data = sink.finish(result.length);
        return {
            status: 'written',
            ...result,
            ...(data ? {data} : {}),
        };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'QuotaExceededError') return {status: 'storage-full'};
        throw error;
    } finally {
        sink.close();
    }
}

async function handleGetPageGeometryRequest(
    request: IBrowserPageOpsWorkerRequest<'getPageGeometry'>,
) {
    return getPageGeometryFromPdfBytes(
        request.payload.source,
        request.payload.pageNumber,
    );
}

async function handleParseAnnotationsRequest(
    request: IBrowserPageOpsWorkerRequest<'parseAnnotations'>,
) {
    return parsePdfAnnotations(request.payload.source);
}

async function handleReadCatalogRequest(
    request: IBrowserPageOpsWorkerRequest<'readCatalog'>,
) {
    return readPdfCatalog(request.payload.source);
}

async function handleConformanceRequest(
    request: IBrowserPageOpsWorkerRequest<'conformance'>,
) {
    return readPdfConformance(request.payload.source);
}

const WASM_WRITER_REQUEST_TYPES = [
    'textBoxAppearance',
    'decrypt',
    'printLayout',
    'splitPages',
    'renderScanCleanupRaster',
    'overlayText',
    'recompressImages',
    'replacePageImages',
] as const;
type TWasmWriterRequestType = typeof WASM_WRITER_REQUEST_TYPES[number];

/** Writers whose result carries bytes or a typed failure from the engine. */
function isWasmWriterRequest(request: TBrowserPageOpsWorkerRequest): request is Extract<TBrowserPageOpsWorkerRequest, {type: TWasmWriterRequestType}> {
    return (WASM_WRITER_REQUEST_TYPES as readonly string[]).includes(request.type);
}

async function handleRequest(
    request: TBrowserPageOpsWorkerRequest,
) {
    switch (request.type) {
        case 'textBoxAppearance':
        case 'decrypt':
        case 'printLayout':
        case 'readPageSizes':
        case 'appendAdmission':
        case 'ocrTextVisibility':
        case 'inspectScanCleanupPdf':
        case 'splitPages':
        case 'renderScanCleanupRaster':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
            return tryRunBrowserPageOpsWithWasm(request.type, request.payload);
        case 'pageStructure':
            return handlePageStructureRequest(request);
        case 'getPageGeometry':
            return handleGetPageGeometryRequest(request);
        case 'parseAnnotations':
            return handleParseAnnotationsRequest(request);
        case 'readCatalog':
            return handleReadCatalogRequest(request);
        case 'conformance':
            return handleConformanceRequest(request);
    }
}

/** Posts a response; a success names the engine module that produced it. */
async function postResponse(message: Record<string, unknown> & {ok: boolean}, transfer: Transferable[] = []) {
    const engineSha256 = message.ok ? await readLoadedWasmDigest(PDF_PAGE_OPS_WASM_PATH)?.catch(() => null) : null;
    self.postMessage(typeof engineSha256 === 'string' ? {
        ...message,
        engineSha256,
    } : message, transfer);
}

function handleEvictDocumentMessage(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const record = data as Record<string, unknown>;
    if (record.type !== EVICT_BROWSER_PAGE_OPS_DOCUMENT_MESSAGE_TYPE) return false;
    evictCachedBrowserPageOpsDocument(typeof record.keyPrefix === 'string' ? record.keyPrefix : undefined);
    return true;
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) return;
    if (handleEvictDocumentMessage(event.data)) return;
    const request = parseBrowserPageOpsWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserPageOpsWorkerRequestId(event.data);
        if (id !== null) {
            await postResponse({
                id,
                ok: false,
                error: 'Invalid browser page operation worker request',
            } satisfies TBrowserPageOpsWorkerResponse);
        }
        return;
    }

    try {
        const data = await handleRequest(request);
        if (
            request.type === 'readPageSizes'
            || request.type === 'appendAdmission'
            || request.type === 'ocrTextVisibility'
            || request.type === 'inspectScanCleanupPdf'
        ) {
            await postResponse({
                id: request.id,
                type: request.type,
                ok: true,
                data,
            });
            return;
        }
        if (isWasmWriterRequest(request)) {
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            } as TBrowserPageOpsWorkerResponse;
            if (isBrowserPageOpsWasmFailure(data)) {
                await postResponse(response);
            } else {
                const result = data as Exclude<IBrowserPageOpsWorkerResultMap[TWasmWriterRequestType], {status: 'failed'}>;
                const transferableData = toTransferableUint8Array(result.data);
                await postResponse({
                    ...response,
                    data: {
                        ...result,
                        data: transferableData,
                    },
                }, [transferableData.buffer]);
            }
            return;
        }
        if (request.type === 'pageStructure') {
            const result = data as IBrowserPageOpsWorkerResultMap['pageStructure'];
            const bytes = result.status === 'written' && result.data ? toTransferableUint8Array(result.data) : null;
            await postResponse({
                id: request.id,
                type: request.type,
                ok: true,
                data: bytes ? {...result, data: bytes} : result,
            }, bytes ? [bytes.buffer] : []);
            return;
        }
        if (request.type === 'getPageGeometry') {
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data: data as IBrowserPageOpsWorkerResultMap['getPageGeometry'],
            } satisfies TBrowserPageOpsWorkerResponse;
            await postResponse(response);
            return;
        }

        if (request.type === 'parseAnnotations') {
            const parseResult = data as IBrowserPageOpsWorkerResultMap['parseAnnotations'];
            const transferableData = toTransferableUint8Array(parseResult.data);
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data: {data: transferableData},
            } satisfies TBrowserPageOpsWorkerResponse;
            await postResponse(response, [transferableData.buffer]);
            return;
        }

        if (request.type === 'readCatalog') {
            const response = {
                id: request.id,
                type: 'readCatalog',
                ok: true,
                data: data as IBrowserPageOpsWorkerResultMap['readCatalog'],
            } satisfies TBrowserPageOpsWorkerResponse;
            await postResponse(response);
            return;
        }

        const response = {
            id: request.id,
            type: 'conformance',
            ok: true,
            data: data as IBrowserPageOpsWorkerResultMap['conformance'],
        } satisfies TBrowserPageOpsWorkerResponse;
        await postResponse(response);
    } catch (error) {
        const errorName = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'name') === 'string'
            ? Reflect.get(error, 'name') as string
            : undefined;
        const errorCode = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
            ? Reflect.get(error, 'code') as string
            : undefined;
        const envelopeCode = errorCode && errorCode.length > 0
            ? errorCode
            : errorName && errorName !== 'Error' && errorName.length > 0
                ? errorName
                : undefined;
        const message = getErrorMessage(error);
        await postResponse({
            id: request.id,
            ok: false,
            error: message,
            ...(envelopeCode
                ? {errorEnvelope: {
                    code: envelopeCode,
                    message,
                    ...(errorName && errorName !== 'Error' ? {details: {name: errorName}} : {}),
                }}
                : {}),
        });
    } finally {
        if (request.type === 'decrypt') {
            request.payload.password = '';
        }
    }
});
