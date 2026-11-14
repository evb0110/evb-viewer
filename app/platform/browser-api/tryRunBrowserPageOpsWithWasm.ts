import {
    BROWSER_PAGE_OPS_MAX_REQUEST_BYTES, BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES,
} from '@contracts/browserPageOpsLimits';
import { getErrorMessage } from '@app/utils/error';
import {
    BYTES_HEADER,
    MUTATION_HEADER,
    INSTRUCTED_REQUEST_HEADER,
    REPORTED_HEADER,
    TEXT_BOX_APPEARANCE_HEADER,
    RESPONSE_TEXT_BOX_APPEARANCE,
    OPERATION_CODES,
    REQUEST_HEADER,
    REQUEST_VERSION,
    REQUEST_VERSION_INSTRUCTED,
    RESPONSE_ANNOTATION_PARSE,
    RESPONSE_JSON,
    RESPONSE_MUTATION,
    RESPONSE_REPORTED_INCREMENT,
    RESPONSE_REPORTED_PDF,
    RESPONSE_REPORTED_RASTER,
    U32_BYTES,
} from '@contracts/browserPageOpsWasm.generated';
import {
    type IBrowserPageOpsWorkerRequestMap,
    type IBrowserPageOpsWorkerResultMap,
    type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {
    BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS,
    isBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {decodeBrowserPdfCatalog} from '@contracts/browserPdfCatalog';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import type {ICropMargins} from '@contracts/shared';
import {
    blobSource,
    copyWasmBytes,
    createWasmFailure,
    createWasmLoadFailure,
    discardPdfPageOpsWasm,
    loadPdfPageOpsWasm,
    readWasmFailure,
    runFileRequest,
    toWasmU32,
    withOpenFiles,
    writeMagic,
    writeU32,
    type IPageStructureFiles,
    type IPdfPageOpsWasmExports,
} from '@app/platform/browser/pdfPageEngine';
import {getCheckedWasmMemoryView} from '@contracts/getCheckedWasmMemoryView';
import * as v from 'valibot';
export {
    isBrowserPageOpsWasmFailure, type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';





// Page-structure edits read and write files through the engine's host imports, not a request buffer.
type IBrowserPageOpsWasmRequestMap = Omit<IBrowserPageOpsWorkerRequestMap, 'pageStructure'>;

const wasmBytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const wasmMutationResultSchema = v.object({
    data: wasmBytesSchema,
    pageCount: v.number(),
});
const wasmCatalogResultSchema = v.pipe(
    v.unknown(),
    // The shared decoder enforces recursive bookmark depth and aggregate item budgets.
    v.transform(value => decodeBrowserPdfCatalog(value)),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);

type IBrowserPageOpsWasmResultMap = {
    [K in keyof IBrowserPageOpsWasmRequestMap]: Exclude<IBrowserPageOpsWorkerResultMap[K], IBrowserPageOpsWasmFailure>;
};

type TBrowserPageOpsWasmRequestType = keyof IBrowserPageOpsWasmRequestMap;

/** Reads that take their document as a Blob, through file framing. */
type TFileReadType = 'parseAnnotations' | 'readCatalog' | 'conformance' | 'ocrTextVisibility';
/** Requests that carry their document in the request buffer. */
type TByteRequestType = Exclude<TBrowserPageOpsWasmRequestType, TFileReadType>;

type TBrowserPageOpsWasmRequest = {
    [K in TByteRequestType]: {
        type: K;
        payload: IBrowserPageOpsWasmRequestMap[K];
    };
}[TByteRequestType];

function toWasmF64(value: number) {
    if (!Number.isFinite(value)) {
        throw new Error('Invalid page-op WASM number field');
    }

    return value;
}


function getRequestPages(request: TBrowserPageOpsWasmRequest): number[] {
    switch (request.type) {
        case 'rotate':
        case 'crop':
        case 'removeCrop':
            return request.payload.pages;
        case 'printLayout':
            return request.payload.pageNumbers;
        case 'inspectScanCleanupPdf':
            return request.payload.pages;
        case 'splitPages':
        case 'renderScanCleanupRaster':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
        case 'getPageGeometry':
        case 'decrypt':
        case 'textBoxAppearance':
            return [];
    }
}

function getRequestData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    switch (request.type) {
        case 'rotate':
        case 'crop':
        case 'removeCrop':
        case 'getPageGeometry':
        case 'decrypt':
        case 'printLayout':
        case 'inspectScanCleanupPdf':
        case 'splitPages':
        case 'renderScanCleanupRaster':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
            return request.payload.data;
        case 'textBoxAppearance':
            return new Uint8Array();
    }
}

function getInsertionData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    if (request.type === 'textBoxAppearance') {
        return new TextEncoder().encode(JSON.stringify(request.payload));
    }
    if (request.type === 'printLayout') {
        return new TextEncoder().encode(`${request.payload.viewMode} ${request.payload.orientation}`);
    }
    return new Uint8Array();
}

function getPassword(request: TBrowserPageOpsWasmRequest) {
    return request.type === 'decrypt'
        ? new TextEncoder().encode(request.payload.password)
        : new Uint8Array();
}

function getPageNumber(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'getPageGeometry'
        ? request.payload.pageNumber
        : 0;
}

function getAngle(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'rotate'
        ? request.payload.angle
        : Number(request.type === 'crop' && request.payload.margins.physical === true);
}

function getMargins(request: TBrowserPageOpsWasmRequest): ICropMargins {
    if (request.type !== 'crop') {
        return {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        };
    }

    return request.payload.margins;
}

interface IInstructedWasmRequest {
    data: Uint8Array;
    instructions: unknown;
    attachments: Uint8Array[];
}

/** The writers whose desktop commands read a JSON instructions file. */
function getInstructedRequest(request: TBrowserPageOpsWasmRequest): IInstructedWasmRequest | null {
    switch (request.type) {
        case 'splitPages':
        case 'recompressImages':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: [],
            };
        case 'renderScanCleanupRaster':
            return {
                data: request.payload.data,
                instructions: request.payload.request,
                attachments: [],
            };
        case 'overlayText':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: [request.payload.sourceData],
            };
        case 'replacePageImages':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: request.payload.replacementPdfs,
            };
        case 'textBoxAppearance':
        case 'rotate':
        case 'crop':
        case 'removeCrop':
        case 'getPageGeometry':
        case 'decrypt':
        case 'printLayout':
        case 'inspectScanCleanupPdf':
            return null;
    }
}

/** The document, its JSON instructions, then each attached PDF with its length. */
function buildInstructedWasmRequest(operation: number, payload: IInstructedWasmRequest) {
    const instructions = new TextEncoder().encode(JSON.stringify(payload.instructions));
    const attachmentLengths = payload.attachments.map(attachment => toWasmU32(attachment.byteLength));
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(attachmentLengths.reduce(
        (total, length) => total + U32_BYTES + length,
        INSTRUCTED_REQUEST_HEADER.bytes + payload.data.byteLength + instructions.byteLength,
    ));
    const view = new DataView(output.buffer);
    writeMagic(output, INSTRUCTED_REQUEST_HEADER.magic);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.version, REQUEST_VERSION_INSTRUCTED);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.operation, operation);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.dataLength, toWasmU32(payload.data.byteLength));
    writeU32(view, INSTRUCTED_REQUEST_HEADER.instructionsLength, toWasmU32(instructions.byteLength));
    writeU32(view, INSTRUCTED_REQUEST_HEADER.attachmentCount, toWasmU32(payload.attachments.length));
    let offset: number = INSTRUCTED_REQUEST_HEADER.bytes;
    output.set(payload.data, offset);
    offset += payload.data.byteLength;
    output.set(instructions, offset);
    offset += instructions.byteLength;
    for (const [
        index,
        attachment,
    ] of payload.attachments.entries()) {
        offset = writeU32(view, offset, attachmentLengths[index]!);
        output.set(attachment, offset);
        offset += attachment.byteLength;
    }
    return {
        data: output,
        passwordOffset: 0,
        passwordLength: 0,
    };
}

function buildWasmRequest(request: TBrowserPageOpsWasmRequest) {
    const instructed = getInstructedRequest(request);
    if (instructed !== null) {
        return buildInstructedWasmRequest(OPERATION_CODES[request.type], instructed);
    }
    const data = getRequestData(request);
    const insertionData = getInsertionData(request);
    const password = getPassword(request);
    const headerBytes = REQUEST_HEADER.bytes;
    const pages = getRequestPages(request).map(toWasmU32);
    const pageNumber = toWasmU32(getPageNumber(request));
    const angle = toWasmU32(getAngle(request));
    const dataLength = toWasmU32(data.byteLength);
    const insertionDataLength = toWasmU32(insertionData.byteLength);
    const passwordLength = toWasmU32(password.byteLength);
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(
        headerBytes
        + (pages.length * U32_BYTES)
        + dataLength
        + insertionDataLength
        + passwordLength,
    );
    const view = new DataView(output.buffer);
    const margins = getMargins(request);
    writeMagic(output, REQUEST_HEADER.magic);
    writeU32(view, REQUEST_HEADER.version, REQUEST_VERSION);
    writeU32(view, REQUEST_HEADER.operation, OPERATION_CODES[request.type]);
    writeU32(view, REQUEST_HEADER.pageCount, pages.length);
    writeU32(view, REQUEST_HEADER.pageNumber, pageNumber);
    writeU32(view, REQUEST_HEADER.angle, angle);
    view.setFloat64(REQUEST_HEADER.top, toWasmF64(margins.top), true);
    view.setFloat64(REQUEST_HEADER.bottom, toWasmF64(margins.bottom), true);
    view.setFloat64(REQUEST_HEADER.left, toWasmF64(margins.left), true);
    view.setFloat64(REQUEST_HEADER.right, toWasmF64(margins.right), true);
    writeU32(view, REQUEST_HEADER.dataLength, dataLength);
    writeU32(view, REQUEST_HEADER.insertionDataLength, insertionDataLength);
    writeU32(view, REQUEST_HEADER.passwordLength, passwordLength);
    let offset: number = headerBytes;

    for (const page of pages) {
        offset = writeU32(view, offset, page);
    }

    output.set(data, offset);
    offset += dataLength;
    output.set(insertionData, offset);
    offset += insertionDataLength;
    output.set(password, offset);
    const passwordOffset = offset;
    password.fill(0);

    return {
        data: output,
        passwordOffset,
        passwordLength,
    };
}

function readMutationResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const pageCount = view.getUint32(MUTATION_HEADER.pageCount, true);
    const dataLength = view.getUint32(MUTATION_HEADER.dataLength, true);
    const offset = MUTATION_HEADER.bytes;
    if (offset + dataLength !== output.byteLength) {
        return null;
    }

    return {
        data: toTransferableUint8Array(output.slice(offset, offset + dataLength)),
        pageCount,
    };
}

function readJsonResult(output: Uint8Array) {
    if (output.byteLength < BYTES_HEADER.bytes) {
        return null;
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const dataLength = view.getUint32(BYTES_HEADER.dataLength, true);
    if (dataLength !== output.byteLength - BYTES_HEADER.bytes) {
        return null;
    }
    try {
        return JSON.parse(new TextDecoder().decode(output.slice(BYTES_HEADER.bytes))) as unknown;
    } catch {
        return null;
    }
}

/** A REPORTED_HEADER frame: its bytes and the JSON report after them. */
function readReportedResult(output: Uint8Array, expectedKind: number) {
    if (output.byteLength < REPORTED_HEADER.bytes) {
        return null;
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const dataLength = view.getUint32(REPORTED_HEADER.dataLength, true);
    const reportLength = view.getUint32(REPORTED_HEADER.reportLength, true);
    const reportOffset = REPORTED_HEADER.bytes + dataLength;
    if (
        view.getUint32(REPORTED_HEADER.kind, true) !== expectedKind
        || reportOffset + reportLength !== output.byteLength
    ) {
        return null;
    }
    try {
        return {
            data: toTransferableUint8Array(output.slice(REPORTED_HEADER.bytes, reportOffset)),
            pageCount: view.getUint32(REPORTED_HEADER.pageCount, true),
            report: JSON.parse(new TextDecoder().decode(output.subarray(reportOffset))) as unknown,
        };
    } catch {
        return null;
    }
}

const REPORTED_RESPONSE_KINDS = {
    splitPages: RESPONSE_REPORTED_PDF,
    overlayText: RESPONSE_REPORTED_PDF,
    recompressImages: RESPONSE_REPORTED_INCREMENT,
    replacePageImages: RESPONSE_REPORTED_INCREMENT,
    renderScanCleanupRaster: RESPONSE_REPORTED_RASTER,
} as const;
type TReportedWriterType = keyof typeof REPORTED_RESPONSE_KINDS;

function isReportedWriterType(type: TBrowserPageOpsWasmRequestType): type is TReportedWriterType {
    return Object.hasOwn(REPORTED_RESPONSE_KINDS, type);
}

function parseReportedOutput(type: TReportedWriterType, output: Uint8Array) {
    const parsed = v.safeParse(
        BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS[type],
        readReportedResult(output, REPORTED_RESPONSE_KINDS[type]),
        {abortEarly: true},
    );
    return parsed.success && !isBrowserPageOpsWasmFailure(parsed.output) ? parsed.output : null;
}

function parseWasmOutput<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    output: Uint8Array,
): IBrowserPageOpsWasmResultMap[K] | null {
    if (output.byteLength < U32_BYTES) {
        return null;
    }

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const kind = view.getUint32(MUTATION_HEADER.kind, true);
    if (type === 'textBoxAppearance') {
        if (kind !== RESPONSE_TEXT_BOX_APPEARANCE || output.byteLength < TEXT_BOX_APPEARANCE_HEADER.bytes) return null;
        const dataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.dataLength, true);
        const metadataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.metadataLength, true);
        const offset = TEXT_BOX_APPEARANCE_HEADER.bytes;
        if (offset + dataLength + metadataLength !== output.byteLength) return null;
        try {
            const parsed = v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.textBoxAppearance, {
                ...JSON.parse(new TextDecoder().decode(output.subarray(offset + dataLength))),
                data: toTransferableUint8Array(output.slice(offset, offset + dataLength)),
            }, {abortEarly: true});
            return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
        } catch { return null; }
    }
    if (type === 'parseAnnotations') {
        if (kind !== RESPONSE_ANNOTATION_PARSE || output.byteLength < BYTES_HEADER.bytes) {
            return null;
        }
        const dataLength = view.getUint32(BYTES_HEADER.dataLength, true);
        if (dataLength !== output.byteLength - BYTES_HEADER.bytes) {
            return null;
        }
        const parsed = v.safeParse(
            BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.parseAnnotations,
            {data: toTransferableUint8Array(output.slice(BYTES_HEADER.bytes))},
            {abortEarly: true},
        );
        return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
    }

    if (type === 'getPageGeometry' || type === 'ocrTextVisibility' || type === 'inspectScanCleanupPdf') {
        const parsed = kind === RESPONSE_JSON
            ? v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS[type], readJsonResult(output), {abortEarly: true})
            : null;
        return parsed?.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
    }

    if (isReportedWriterType(type)) {
        return parseReportedOutput(type, output) as IBrowserPageOpsWasmResultMap[K] | null;
    }

    if (type === 'readCatalog' || type === 'conformance') {
        if (kind !== RESPONSE_JSON) {
            return null;
        }
        const value: unknown = readJsonResult(output);
        if (type === 'readCatalog') {
            const parsed = v.safeParse(wasmCatalogResultSchema, value, {abortEarly: true});
            return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
        }
        const parsed = v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.conformance, value, {abortEarly: true});
        return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
    }

    const parsed = kind === RESPONSE_MUTATION
        ? v.safeParse(wasmMutationResultSchema, readMutationResult(output), {abortEarly: true})
        : null;
    return parsed?.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
}

function runWasmRequest<K extends TByteRequestType>(
    exports: IPdfPageOpsWasmExports,
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
): IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure {
    let pointer: number | null = null;
    let requestByteLength = 0;
    let request: Uint8Array<ArrayBuffer> | null = null;
    let passwordOffset = 0;
    let passwordLength = 0;
    let trapped = false;

    try {
        const builtRequest = buildWasmRequest({
            type,
            payload,
        } as TBrowserPageOpsWasmRequest);
        request = builtRequest.data;
        passwordOffset = builtRequest.passwordOffset;
        passwordLength = builtRequest.passwordLength;
        requestByteLength = request.byteLength;
        if (requestByteLength === 0 || requestByteLength > BROWSER_PAGE_OPS_MAX_REQUEST_BYTES) {
            return createWasmFailure('too-large', 'Page operation WASM request exceeds the admission ceiling');
        }
        const allocatedPointer = exports.evb_pdf_page_ops_alloc(requestByteLength);
        if (allocatedPointer === 0) {
            return createWasmFailure('too-large', 'Page operation WASM could not allocate request memory');
        }
        pointer = allocatedPointer;
        const requestMemory = getCheckedWasmMemoryView(
            exports.memory,
            pointer,
            requestByteLength,
            'Page operation WASM allocation',
        );
        requestMemory.set(request);
        const resultCode = exports.evb_pdf_page_ops_run(pointer, request.byteLength);
        if (resultCode !== 0) {
            return readWasmFailure(resultCode, exports);
        }

        const outputPointer = exports.evb_pdf_page_ops_output_ptr();
        const outputLen = exports.evb_pdf_page_ops_output_len();
        if (outputLen === 0 || outputLen > BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES) {
            return createWasmFailure(
                outputLen > BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES ? 'too-large' : 'invalid-request',
                'Page operation WASM returned an invalid output envelope',
            );
        }

        return parseWasmOutput(type, copyWasmBytes(exports, outputPointer, outputLen))
            ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
    } catch (error) {
        if (error instanceof Error && error.name === 'RuntimeError') {
            // Rust panics unwind into an error envelope; a trap is an abort,
            // which on wasm32 is an allocation the 4 GiB address space could
            // not satisfy. The aborted request's memory is never freed, so the
            // next request loads a fresh engine.
            trapped = true;
            discardPdfPageOpsWasm();
            return createWasmFailure('too-large', `The browser page tool ran out of memory: ${getErrorMessage(error)}`);
        }
        return createWasmFailure(
            'invalid-request',
            error instanceof Error ? getErrorMessage(error) : 'Page operation WASM request failed',
        );
    } finally {
        if (request !== null && passwordLength > 0) {
            request.fill(0, passwordOffset, passwordOffset + passwordLength);
        }
        if (pointer !== null) {
            try {
                if (passwordLength > 0) {
                    getCheckedWasmMemoryView(
                        exports.memory,
                        pointer,
                        requestByteLength,
                        'Page operation WASM allocation',
                    ).fill(0, passwordOffset, passwordOffset + passwordLength);
                }
            } finally {
                if (!trapped) exports.evb_pdf_page_ops_free(pointer, requestByteLength);
            }
        }
    }
}

const NO_SINK = {
    write: () => {
        throw new Error('A read writes nothing');
    },
    read: () => {
        throw new Error('A read writes nothing');
    },
};

/** A read of one document the engine takes by range from `payload.source`, answered as the byte request was. */
async function runFileRead<K extends TFileReadType>(
    exports: IPdfPageOpsWasmExports,
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
) {
    const files: IPageStructureFiles = {
        sources: [await blobSource(payload.source)],
        sink: NO_SINK,
        copy: () => Promise.reject(new Error('A read copies nothing')),
    };
    const output = await withOpenFiles(files, async () => runFileRequest(exports, {
        operation: OPERATION_CODES[type],
        sourceCount: 1,
        ...('pages' in payload ? {pages: payload.pages} : {}),
        ...('withEvbOcrText' in payload && payload.withEvbOcrText ? {payload: new TextEncoder().encode('with-evb-ocr-text')} : {}),
    }));
    if (isBrowserPageOpsWasmFailure(output)) return output;
    return parseWasmOutput(type, output) ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
}

/**
 * Runs a page operation in this thread's engine. `beforeRun` is awaited once
 * the module has loaded and before any input enters the engine; a caller
 * whose request has ended throws there, and the engine is not entered.
 */
export async function tryRunBrowserPageOpsWithWasm<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
    beforeRun?: () => Promise<void>,
): Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure> {
    let exports: IPdfPageOpsWasmExports;
    try {
        exports = await loadPdfPageOpsWasm();
    } catch (error) {
        return createWasmLoadFailure(error);
    }
    await beforeRun?.();

    if (type === 'parseAnnotations' || type === 'readCatalog' || type === 'conformance' || type === 'ocrTextVisibility') {
        return runFileRead(exports, type as TFileReadType, payload as IBrowserPageOpsWasmRequestMap[TFileReadType]) as Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure>;
    }
    return runWasmRequest(exports, type as TByteRequestType, payload as IBrowserPageOpsWasmRequestMap[TByteRequestType]) as IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure;
}
