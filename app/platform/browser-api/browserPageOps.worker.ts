import {
    cropPdfBytes,
    deletePdfPages,
    extractPdfPages,
    getPageGeometryFromPdfBytes,
    parsePdfAnnotations,
    insertPdfPages,
    removeCropPdfBytes,
    reorderPdfPages,
    rotatePdfBytes,
    readPdfCatalog,
    readPdfConformance,
    mergePdfPages,
} from '@app/platform/browser-api/browserPageOpsCore';
import type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerResponse,
} from '@contracts/browserPageOpsWorker';
import {
    getBrowserPageOpsWorkerRequestId,
    parseBrowserPageOpsWorkerRequest,
} from '@contracts/browserPageOpsWorker';
import {
    tryRunBrowserPageOpsWithWasm, isBrowserPageOpsWasmFailure,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {readLoadedWasmDigest} from '@app/platform/browser-api/loadWasmWithDeadline';
import { getErrorMessage } from '@app/utils/error';
function toTransferableUint8Array(data: Uint8Array) {
    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }

    return data.slice();
}

async function handleDeleteRequest(
    request: IBrowserPageOpsWorkerRequest<'deletePages'>,
) {
    return deletePdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleExtractRequest(
    request: IBrowserPageOpsWorkerRequest<'extractPages'>,
) {
    return extractPdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleReorderRequest(
    request: IBrowserPageOpsWorkerRequest<'reorderPages'>,
) {
    return reorderPdfPages(
        request.payload.data,
        request.payload.newOrder,
    );
}

async function handleInsertRequest(
    request: IBrowserPageOpsWorkerRequest<'insertPages'>,
) {
    return insertPdfPages(
        request.payload.data,
        request.payload.insertionData,
        request.payload.afterPage,
    );
}

async function handleRotateRequest(
    request: IBrowserPageOpsWorkerRequest<'rotate'>,
) {
    return rotatePdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.angle,
    );
}

async function handleCropRequest(
    request: IBrowserPageOpsWorkerRequest<'crop'>,
) {
    return cropPdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.margins,
    );
}

async function handleRemoveCropRequest(
    request: IBrowserPageOpsWorkerRequest<'removeCrop'>,
) {
    return removeCropPdfBytes(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleGetPageGeometryRequest(
    request: IBrowserPageOpsWorkerRequest<'getPageGeometry'>,
) {
    return getPageGeometryFromPdfBytes(
        request.payload.data,
        request.payload.pageNumber,
    );
}

async function handleParseAnnotationsRequest(
    request: IBrowserPageOpsWorkerRequest<'parseAnnotations'>,
) {
    return parsePdfAnnotations(request.payload.data);
}

async function handleReadCatalogRequest(
    request: IBrowserPageOpsWorkerRequest<'readCatalog'>,
) {
    return readPdfCatalog(request.payload.data);
}

async function handleConformanceRequest(
    request: IBrowserPageOpsWorkerRequest<'conformance'>,
) {
    return readPdfConformance(request.payload.data);
}

async function handleMergePagesRequest(
    request: IBrowserPageOpsWorkerRequest<'mergePages'>,
) {
    return mergePdfPages(request.payload.documents);
}

const WASM_WRITER_REQUEST_TYPES = [
    'textBoxAppearance',
    'saveMutations',
    'decrypt',
    'printLayout',
    'ocrTextLayer',
    'splitPages',
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
        case 'saveMutations':
        case 'decrypt':
        case 'printLayout':
        case 'ocrTextLayer':
        case 'ocrTextVisibility':
        case 'inspectScanCleanupPdf':
        case 'splitPages':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
            return tryRunBrowserPageOpsWithWasm(request.type, request.payload);
        case 'deletePages':
            return handleDeleteRequest(request);
        case 'extractPages':
            return handleExtractRequest(request);
        case 'reorderPages':
            return handleReorderRequest(request);
        case 'insertPages':
            return handleInsertRequest(request);
        case 'rotate':
            return handleRotateRequest(request);
        case 'crop':
            return handleCropRequest(request);
        case 'removeCrop':
            return handleRemoveCropRequest(request);
        case 'getPageGeometry':
            return handleGetPageGeometryRequest(request);
        case 'parseAnnotations':
            return handleParseAnnotationsRequest(request);
        case 'readCatalog':
            return handleReadCatalogRequest(request);
        case 'conformance':
            return handleConformanceRequest(request);
        case 'mergePages':
            return handleMergePagesRequest(request);
    }
}

/** Posts a response; a success names the engine module that produced it. */
async function postResponse(message: Record<string, unknown> & {ok: boolean}, transfer: Transferable[] = []) {
    const engineSha256 = message.ok ? await readLoadedWasmDigest('/wasm/evb-pdf-page-ops.wasm')?.catch(() => null) : null;
    self.postMessage(typeof engineSha256 === 'string' ? {
        ...message,
        engineSha256,
    } : message, transfer);
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
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
        if (request.type === 'ocrTextVisibility' || request.type === 'inspectScanCleanupPdf') {
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

        if (request.type === 'conformance') {
            const response = {
                id: request.id,
                type: 'conformance',
                ok: true,
                data: data as IBrowserPageOpsWorkerResultMap['conformance'],
            } satisfies TBrowserPageOpsWorkerResponse;
            await postResponse(response);
            return;
        }

        const mutationResult = data as IBrowserPageOpsWorkerResultMap['rotate'];
        const transferableData = toTransferableUint8Array(mutationResult.data);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data: {
                ...mutationResult,
                data: transferableData,
            },
        } satisfies TBrowserPageOpsWorkerResponse;
        await postResponse(response, [transferableData.buffer]);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TBrowserPageOpsWorkerResponse;
        await postResponse(response);
    } finally {
        if (request.type === 'decrypt') {
            request.payload.password = '';
        }
    }
});
