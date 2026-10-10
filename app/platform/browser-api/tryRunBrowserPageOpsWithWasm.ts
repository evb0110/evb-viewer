import { getErrorMessage } from '@app/utils/error';
import {
    BOX_LAYOUT,
    BYTES_HEADER,
    DOCUMENT_LIST_HEADER,
    GEOMETRY_HEADER,
    MAX_DOCUMENTS,
    MAX_U32,
    MUTATION_HEADER,
    NATIVE_MUTATION_HEADER,
    NATIVE_MUTATION_POSTCONDITIONS_VERIFIED,
    OPERATION_CODES,
    REQUEST_HEADER,
    REQUEST_MAGIC,
    REQUEST_VERSION,
    REQUEST_VERSION_DOCUMENT_LIST,
    RESPONSE_ANNOTATION_PARSE,
    RESPONSE_GEOMETRY,
    RESPONSE_JSON,
    RESPONSE_MUTATION,
    RESPONSE_NATIVE_MUTATIONS,
    U32_BYTES,
} from '@contracts/browserPageOpsWasm.generated';
import {
    BROWSER_PAGE_OPS_SAVE_MUTATIONS_RESULT_SCHEMA,
    type IBrowserPageOpsWorkerRequestMap,
    type IBrowserPageOpsWorkerResultMap,
    type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS} from '@contracts/browserPageOpsWorker';
import {
    BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS,
    decodeBrowserPdfCatalog,
} from '@contracts/browserPdfCatalog';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import type {ICropMargins} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import * as v from 'valibot';
export {
    isBrowserPageOpsWasmFailure, type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';

interface IPdfPageOpsWasmExports {
    memory: WebAssembly.Memory;
    evb_wasm_request_allocation_abi_version(): number;
    evb_pdf_page_ops_alloc(len: number): number;
    evb_pdf_page_ops_free(pointer: number, byteLength: number): void;
    evb_pdf_page_ops_run(requestPointer: number, requestLen: number): number;
    evb_pdf_page_ops_output_ptr(): number;
    evb_pdf_page_ops_output_len(): number;
    evb_pdf_page_ops_error_ptr(): number;
    evb_pdf_page_ops_error_len(): number;
}

const PDF_PAGE_OPS_WASM_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

type IBrowserPageOpsWasmRequestMap = IBrowserPageOpsWorkerRequestMap;

const wasmBytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const wasmMutationResultSchema = v.object({
    data: wasmBytesSchema,
    pageCount: v.number(),
});
const wasmIdentityBindingsSchema = BROWSER_PAGE_OPS_SAVE_MUTATIONS_RESULT_SCHEMA.entries.identityBindings;
const wasmCatalogResultSchema = v.pipe(
    v.unknown(),
    // The shared decoder enforces recursive bookmark depth and aggregate item budgets.
    v.transform(value => decodeBrowserPdfCatalog(value, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS})),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);

type IBrowserPageOpsWasmResultMap = {
    [K in keyof IBrowserPageOpsWorkerResultMap]: Exclude<IBrowserPageOpsWorkerResultMap[K], IBrowserPageOpsWasmFailure | null>;
};

type TBrowserPageOpsWasmRequestType = keyof IBrowserPageOpsWasmRequestMap;

type TBrowserPageOpsWasmRequest = {
    [K in TBrowserPageOpsWasmRequestType]: {
        type: K;
        payload: IBrowserPageOpsWasmRequestMap[K];
    };
}[TBrowserPageOpsWasmRequestType];

const WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';

let wasmExportsPromise: Promise<IPdfPageOpsWasmExports | null> | null = null;

function createWasmFailure(
    code: TNativeErrorCode,
    message: string,
): IBrowserPageOpsWasmFailure {
    return {
        status: 'failed',
        error: {
            code,
            message,
        },
    };
}

function isWasmNumberFunction(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

function getPdfPageOpsWasmExports(exports: WebAssembly.Exports): IPdfPageOpsWasmExports | null {
    const {
        memory,
        evb_wasm_request_allocation_abi_version: allocationAbiVersion,
        evb_pdf_page_ops_alloc: alloc,
        evb_pdf_page_ops_free: free,
        evb_pdf_page_ops_run: run,
        evb_pdf_page_ops_output_ptr: outputPtr,
        evb_pdf_page_ops_output_len: outputLen,
        evb_pdf_page_ops_error_ptr: errorPtr,
        evb_pdf_page_ops_error_len: errorLen,
    } = exports;

    if (
        !(memory instanceof WebAssembly.Memory)
        || !isWasmNumberFunction(allocationAbiVersion)
        || allocationAbiVersion() !== WASM_REQUEST_ALLOCATION_ABI_VERSION
        || !isWasmNumberFunction(alloc)
        || !isWasmNumberFunction(free)
        || !isWasmNumberFunction(run)
        || !isWasmNumberFunction(outputPtr)
        || !isWasmNumberFunction(outputLen)
        || !isWasmNumberFunction(errorPtr)
        || !isWasmNumberFunction(errorLen)
    ) {
        return null;
    }

    return {
        memory,
        evb_wasm_request_allocation_abi_version: allocationAbiVersion,
        evb_pdf_page_ops_alloc: alloc,
        evb_pdf_page_ops_free: free,
        evb_pdf_page_ops_run: run,
        evb_pdf_page_ops_output_ptr: outputPtr,
        evb_pdf_page_ops_output_len: outputLen,
        evb_pdf_page_ops_error_ptr: errorPtr,
        evb_pdf_page_ops_error_len: errorLen,
    };
}

function canUsePdfPageOpsWasm() {
    return typeof WebAssembly !== 'undefined'
        && typeof fetch === 'function';
}

function resolveWasmUrl() {
    return new URL(WASM_PATH, globalThis.location.href).toString();
}

async function loadPdfPageOpsWasm() {
    const pending = wasmExportsPromise ??= (async () => {
        try {
            const instantiated = await loadWasmWithDeadline(resolveWasmUrl());
            const instance = 'instance' in instantiated
                ? instantiated.instance
                : instantiated;
            return getPdfPageOpsWasmExports(instance.exports);
        } catch {
            // A transient fetch/instantiate failure must not disable WASM for the
            // rest of the session. Clear the memo so a later op re-attempts the
            // load. A module that loads but exports the wrong shape returns null
            // without throwing and stays cached, since that failure is permanent.
            wasmExportsPromise = null;
            return null;
        }
    })();

    return pending;
}

function writeMagic(request: Uint8Array, offset: number) {
    request.set(new TextEncoder().encode(REQUEST_MAGIC), offset);
}

function toWasmU32(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
        throw new Error('Invalid page-op WASM integer field');
    }

    return value;
}

function toWasmF64(value: number) {
    if (!Number.isFinite(value)) {
        throw new Error('Invalid page-op WASM number field');
    }

    return value;
}

function writeU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + U32_BYTES;
}

function getRequestPages(request: TBrowserPageOpsWasmRequest): number[] {
    switch (request.type) {
        case 'deletePages':
        case 'extractPages':
        case 'rotate':
        case 'crop':
        case 'removeCrop':
            return request.payload.pages;
        case 'reorderPages':
            return request.payload.newOrder;
        case 'printLayout':
            return request.payload.pageNumbers;
        case 'insertPages':
        case 'getPageGeometry':
        case 'decrypt':
        case 'parseAnnotations':
        case 'readCatalog':
        case 'conformance':
        case 'mergePages':
            return [];
        case 'saveMutations':
            return [];
    }
}

function getRequestData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    switch (request.type) {
        case 'deletePages':
        case 'extractPages':
        case 'reorderPages':
        case 'insertPages':
        case 'rotate':
        case 'crop':
        case 'removeCrop':
        case 'getPageGeometry':
        case 'decrypt':
        case 'parseAnnotations':
        case 'readCatalog':
        case 'conformance':
        case 'saveMutations':
        case 'printLayout':
            return request.payload.data;
        case 'mergePages':
            return new Uint8Array();
    }
}

function getInsertionData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    if (request.type === 'insertPages') {
        return request.payload.insertionData;
    }
    if (request.type === 'saveMutations') {
        return new TextEncoder().encode(JSON.stringify({
            mutations: request.payload.mutations,
            modifiedAt: request.payload.modifiedAt,
        }));
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

function getAfterPage(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'insertPages'
        ? request.payload.afterPage
        : 0;
}

function getAngle(request: TBrowserPageOpsWasmRequest): number {
    return request.type === 'rotate'
        ? request.payload.angle
        : 0;
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

function getDocumentList(request: TBrowserPageOpsWasmRequest): Uint8Array[] | null {
    switch (request.type) {
        case 'readCatalog':
        case 'conformance':
            return [request.payload.data];
        case 'mergePages':
            return request.payload.documents;
        case 'deletePages':
        case 'extractPages':
        case 'reorderPages':
        case 'insertPages':
        case 'rotate':
        case 'crop':
        case 'removeCrop':
        case 'getPageGeometry':
        case 'decrypt':
        case 'parseAnnotations':
        case 'saveMutations':
        case 'printLayout':
            return null;
    }
}

function buildDocumentListWasmRequest(request: TBrowserPageOpsWasmRequest) {
    const documents = getDocumentList(request);
    if (documents === null || documents.length === 0 || documents.length > MAX_DOCUMENTS) {
        throw new Error('Invalid page-op WASM document list');
    }
    const encodedLengths = documents.map(document => toWasmU32(document.byteLength));
    const payloadLength = encodedLengths.reduce(
        (total, length) => total + U32_BYTES + length,
        DOCUMENT_LIST_HEADER.bytes,
    );
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(payloadLength);
    const view = new DataView(output.buffer);
    writeMagic(output, DOCUMENT_LIST_HEADER.magic);
    writeU32(view, DOCUMENT_LIST_HEADER.version, REQUEST_VERSION_DOCUMENT_LIST);
    writeU32(view, DOCUMENT_LIST_HEADER.operation, OPERATION_CODES[request.type]);
    writeU32(view, DOCUMENT_LIST_HEADER.documentCount, documents.length);
    let offset: number = DOCUMENT_LIST_HEADER.bytes;
    for (const [
        index,
        document,
    ] of documents.entries()) {
        const length = encodedLengths[index]!;
        offset = writeU32(view, offset, length);
        output.set(document, offset);
        offset += length;
    }
    return {
        data: output,
        passwordOffset: 0,
        passwordLength: 0,
    };
}

function buildWasmRequest(request: TBrowserPageOpsWasmRequest) {
    if (
        request.type === 'readCatalog'
        || request.type === 'conformance'
        || request.type === 'mergePages'
    ) {
        return buildDocumentListWasmRequest(request);
    }
    const data = getRequestData(request);
    const insertionData = getInsertionData(request);
    const password = getPassword(request);
    const pages = getRequestPages(request).map(toWasmU32);
    const pageNumber = toWasmU32(getPageNumber(request));
    const afterPage = toWasmU32(getAfterPage(request));
    const angle = toWasmU32(getAngle(request));
    const dataLength = toWasmU32(data.byteLength);
    const insertionDataLength = toWasmU32(insertionData.byteLength);
    const passwordLength = toWasmU32(password.byteLength);
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(
        REQUEST_HEADER.bytes
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
    writeU32(view, REQUEST_HEADER.afterPage, afterPage);
    writeU32(view, REQUEST_HEADER.angle, angle);
    view.setFloat64(REQUEST_HEADER.top, toWasmF64(margins.top), true);
    view.setFloat64(REQUEST_HEADER.bottom, toWasmF64(margins.bottom), true);
    view.setFloat64(REQUEST_HEADER.left, toWasmF64(margins.left), true);
    view.setFloat64(REQUEST_HEADER.right, toWasmF64(margins.right), true);
    writeU32(view, REQUEST_HEADER.dataLength, dataLength);
    writeU32(view, REQUEST_HEADER.insertionDataLength, insertionDataLength);
    writeU32(view, REQUEST_HEADER.passwordLength, passwordLength);
    let offset: number = REQUEST_HEADER.bytes;

    for (const page of pages) {
        offset = writeU32(view, offset, page);
    }

    output.set(data, offset);
    offset += dataLength;
    output.set(insertionData, offset);
    offset += insertionDataLength;
    output.set(password, offset);
    password.fill(0);

    return {
        data: output,
        passwordOffset: output.byteLength - passwordLength,
        passwordLength,
    };
}

function copyWasmBytes(
    exports: IPdfPageOpsWasmExports,
    pointer: number,
    len: number,
) {
    return getCheckedWasmMemoryView(exports.memory, pointer, len, 'Page operation WASM').slice();
}

function readWasmError(exports: IPdfPageOpsWasmExports) {
    const pointer = exports.evb_pdf_page_ops_error_ptr();
    const len = exports.evb_pdf_page_ops_error_len();
    if (len === 0) {
        return null;
    }

    return new TextDecoder().decode(copyWasmBytes(exports, pointer, len));
}

function readWasmFailure(
    type: TBrowserPageOpsWasmRequestType,
    resultCode: number,
    exports: IPdfPageOpsWasmExports,
) {
    const encodedError = readWasmError(exports);
    const error = decodeSerializableErrorEnvelope(
        encodedError,
        NATIVE_ERROR_ENVELOPE_SCHEMA,
        {allowBareJsonString: true},
    ) ?? {
        code: 'native-failure' as const,
        message: encodedError ?? `Page operation WASM failed with result code ${resultCode}`,
    };
    BrowserLogger.warn('browser-wasm', 'PDF page operation WASM failed', {
        error: error.message,
        resultCode,
        type,
    });
    return createWasmFailure(error.code, error.message);
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

function readBox(view: DataView, offset: number) {
    return {
        x: view.getFloat64(offset + BOX_LAYOUT.x, true),
        y: view.getFloat64(offset + BOX_LAYOUT.y, true),
        width: view.getFloat64(offset + BOX_LAYOUT.width, true),
        height: view.getFloat64(offset + BOX_LAYOUT.height, true),
    };
}

function readGeometryResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const rotation = view.getUint32(GEOMETRY_HEADER.rotation, true);
    const mediaBox = readBox(view, GEOMETRY_HEADER.mediaBox);
    const hasCropBox = view.getUint32(GEOMETRY_HEADER.hasCropBox, true) === 1;
    const cropBox = readBox(view, GEOMETRY_HEADER.cropBox);
    if (GEOMETRY_HEADER.bytes !== output.byteLength) {
        return null;
    }

    return {
        mediaBox,
        cropBox: hasCropBox ? cropBox : null,
        rotation,
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

function parseWasmOutput<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    output: Uint8Array,
): IBrowserPageOpsWasmResultMap[K] | null {
    if (output.byteLength < U32_BYTES) {
        return null;
    }

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const kind = view.getUint32(MUTATION_HEADER.kind, true);
    if (type === 'getPageGeometry') {
        const parsed = kind === RESPONSE_GEOMETRY
            ? v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.getPageGeometry, readGeometryResult(output), {abortEarly: true})
            : null;
        return parsed?.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
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

    if (type === 'saveMutations') {
        if (kind !== RESPONSE_NATIVE_MUTATIONS || output.byteLength < NATIVE_MUTATION_HEADER.bytes) {
            return null;
        }
        const dataLength = view.getUint32(NATIVE_MUTATION_HEADER.dataLength, true);
        const identityBindingsLength = view.getUint32(NATIVE_MUTATION_HEADER.identityBindingsLength, true);
        if (
            view.getUint32(NATIVE_MUTATION_HEADER.postconditionsVerified, true) !== NATIVE_MUTATION_POSTCONDITIONS_VERIFIED
            || dataLength + identityBindingsLength + NATIVE_MUTATION_HEADER.bytes !== output.byteLength
        ) {
            return null;
        }
        let identityBindings: unknown;
        try {
            identityBindings = JSON.parse(new TextDecoder().decode(
                output.slice(NATIVE_MUTATION_HEADER.bytes + dataLength),
            )) as unknown;
        } catch {
            return null;
        }
        const parsedBindings = v.safeParse(wasmIdentityBindingsSchema, identityBindings, {abortEarly: true});
        if (!parsedBindings.success) {
            return null;
        }
        const parsed = v.safeParse(BROWSER_PAGE_OPS_SAVE_MUTATIONS_RESULT_SCHEMA, {
            data: toTransferableUint8Array(output.slice(NATIVE_MUTATION_HEADER.bytes, NATIVE_MUTATION_HEADER.bytes + dataLength)),
            pageCount: view.getUint32(NATIVE_MUTATION_HEADER.pageCount, true),
            identityBindings: parsedBindings.output,
            nativeMutationPostconditionsVerified: true,
        }, {abortEarly: true});
        return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
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

export async function tryRunBrowserPageOpsWithWasm<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
): Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure | null> {
    if (!canUsePdfPageOpsWasm()) {
        return null;
    }

    const exports = await loadPdfPageOpsWasm();
    if (!exports) {
        return null;
    }

    let pointer: number | null = null;
    let requestByteLength = 0;
    let request: Uint8Array<ArrayBuffer> | null = null;
    let passwordOffset = 0;
    let passwordLength = 0;

    try {
        const builtRequest = buildWasmRequest({
            type,
            payload,
        } as TBrowserPageOpsWasmRequest);
        request = builtRequest.data;
        passwordOffset = builtRequest.passwordOffset;
        passwordLength = builtRequest.passwordLength;
        requestByteLength = request.byteLength;
        if (requestByteLength === 0 || requestByteLength > PDF_PAGE_OPS_WASM_MAX_REQUEST_BYTES) {
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
            return readWasmFailure(type, resultCode, exports);
        }

        const outputPointer = exports.evb_pdf_page_ops_output_ptr();
        const outputLen = exports.evb_pdf_page_ops_output_len();
        if (outputLen === 0 || outputLen > PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES) {
            return createWasmFailure(
                outputLen > PDF_PAGE_OPS_WASM_MAX_OUTPUT_BYTES ? 'too-large' : 'invalid-request',
                'Page operation WASM returned an invalid output envelope',
            );
        }

        return parseWasmOutput(type, copyWasmBytes(exports, outputPointer, outputLen))
            ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
    } catch (error) {
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
                exports.evb_pdf_page_ops_free(pointer, requestByteLength);
            }
        }
    }
}
