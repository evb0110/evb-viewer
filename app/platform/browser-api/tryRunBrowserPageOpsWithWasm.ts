import type {
    IBrowserPdfCombineCatalog,
    IBrowserPdfConformanceFacts,
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeMutationSet,
} from '@contracts/electronApiDocuments';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import type { ICropMargins } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import {
    isNativeErrorEnvelope,
    type INativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';

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

interface IBrowserPageOpsWasmDecryptRequest {
    data: Uint8Array;
    password: string;
}

interface IBrowserPageOpsWasmSaveMutationsRequest {
    data: Uint8Array;
    mutations: IPdfNativeMutationSet;
    modifiedAt: string;
}

interface IBrowserPageOpsWasmRequestMap extends IBrowserPageOpsWorkerRequestMap {
    decrypt: IBrowserPageOpsWasmDecryptRequest;
    saveMutations: IBrowserPageOpsWasmSaveMutationsRequest;
}

interface IBrowserPageOpsWasmDecryptResult {
    data: Uint8Array;
    pageCount: number;
}

interface IBrowserPageOpsWasmSaveMutationsResult {
    data: Uint8Array;
    pageCount: number;
    identityBindings: IPdfNativeAnnotationIdentityBinding[];
    nativeMutationPostconditionsVerified: true;
}

interface IBrowserPageOpsWasmResultMap extends IBrowserPageOpsWorkerResultMap {
    decrypt: IBrowserPageOpsWasmDecryptResult;
    saveMutations: IBrowserPageOpsWasmSaveMutationsResult;
}

type TBrowserPageOpsWasmRequestType = keyof IBrowserPageOpsWasmRequestMap;

type TBrowserPageOpsWasmRequest = {
    [K in TBrowserPageOpsWasmRequestType]: {
        type: K;
        payload: IBrowserPageOpsWasmRequestMap[K];
    };
}[TBrowserPageOpsWasmRequestType];

const REQUEST_MAGIC = 'EPPO';
// Version 2 appends a trailing u32 password length (and password bytes) after
// the insertion-data length. No existing operation carries a password; the
// decrypt operation (OP_DECRYPT = 9 on the Rust side) is wired by the browser
// decrypt host.
const REQUEST_VERSION = 2;
const REQUEST_VERSION_DOCUMENT_LIST = 3;
const WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';
const REQUEST_HEADER_BYTES = 4 + (8 * 4) + (4 * 8) + 4;
const DOCUMENT_LIST_HEADER_BYTES = 4 + (3 * 4);

const OP_DELETE_PAGES = 1;
const OP_EXTRACT_PAGES = 2;
const OP_REORDER_PAGES = 3;
const OP_INSERT_PAGES = 4;
const OP_ROTATE = 5;
const OP_CROP = 6;
const OP_REMOVE_CROP = 7;
const OP_GET_PAGE_GEOMETRY = 8;
const OP_DECRYPT = 9;
const OP_PARSE_ANNOTATIONS = 10;
const OP_SAVE_MUTATIONS = 11;
const OP_READ_CATALOG = 12;
const OP_CONFORMANCE = 13;
const OP_MERGE_PAGES = 14;

const RESPONSE_MUTATION = 1;
const RESPONSE_GEOMETRY = 2;
const RESPONSE_ANNOTATION_PARSE = 3;
const RESPONSE_SAVE_MUTATIONS = 4;
const RESPONSE_JSON = 5;
const MAX_U32 = 0xffff_ffff;
const MAX_DOCUMENTS = 500;
const MAX_BOOKMARK_DEPTH = 256;
const MAX_BOOKMARK_ITEMS = 100_000;

let wasmExportsPromise: Promise<IPdfPageOpsWasmExports | null> | null = null;

export interface IBrowserPageOpsWasmFailure {
    status: 'failed';
    error: INativeErrorEnvelope;
}

export function isBrowserPageOpsWasmFailure(value: unknown): value is IBrowserPageOpsWasmFailure {
    return typeof value === 'object'
        && value !== null
        && 'status' in value
        && value.status === 'failed'
        && 'error' in value
        && isNativeErrorEnvelope(value.error);
}

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
    const location = globalThis.location;
    if (!location) {
        return WASM_PATH;
    }

    return new URL(WASM_PATH, location.href).toString();
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
    return offset + REQUEST_MAGIC.length;
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
    return offset + 4;
}

function writeF64(view: DataView, offset: number, value: number) {
    view.setFloat64(offset, value, true);
    return offset + 8;
}

function getOperationCode(type: TBrowserPageOpsWasmRequestType) {
    switch (type) {
        case 'deletePages':
            return OP_DELETE_PAGES;
        case 'extractPages':
            return OP_EXTRACT_PAGES;
        case 'reorderPages':
            return OP_REORDER_PAGES;
        case 'insertPages':
            return OP_INSERT_PAGES;
        case 'rotate':
            return OP_ROTATE;
        case 'crop':
            return OP_CROP;
        case 'removeCrop':
            return OP_REMOVE_CROP;
        case 'getPageGeometry':
            return OP_GET_PAGE_GEOMETRY;
        case 'decrypt':
            return OP_DECRYPT;
        case 'parseAnnotations':
            return OP_PARSE_ANNOTATIONS;
        case 'saveMutations':
            return OP_SAVE_MUTATIONS;
        case 'readCatalog':
            return OP_READ_CATALOG;
        case 'conformance':
            return OP_CONFORMANCE;
        case 'mergePages':
            return OP_MERGE_PAGES;
    }
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
        case 'mergePages':
            return new Uint8Array();
        default:
            return request.payload.data;
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
        default:
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
        (total, length) => total + 4 + length,
        DOCUMENT_LIST_HEADER_BYTES,
    );
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(payloadLength);
    const view = new DataView(output.buffer);
    let offset = 0;
    offset = writeMagic(output, offset);
    offset = writeU32(view, offset, REQUEST_VERSION_DOCUMENT_LIST);
    offset = writeU32(view, offset, getOperationCode(request.type));
    offset = writeU32(view, offset, documents.length);
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
        REQUEST_HEADER_BYTES
        + (pages.length * 4)
        + dataLength
        + insertionDataLength
        + passwordLength,
    );
    const view = new DataView(output.buffer);
    const margins = getMargins(request);
    let offset = 0;

    offset = writeMagic(output, offset);
    offset = writeU32(view, offset, REQUEST_VERSION);
    offset = writeU32(view, offset, getOperationCode(request.type));
    offset = writeU32(view, offset, pages.length);
    offset = writeU32(view, offset, pageNumber);
    offset = writeU32(view, offset, afterPage);
    offset = writeU32(view, offset, angle);
    offset = writeF64(view, offset, toWasmF64(margins.top));
    offset = writeF64(view, offset, toWasmF64(margins.bottom));
    offset = writeF64(view, offset, toWasmF64(margins.left));
    offset = writeF64(view, offset, toWasmF64(margins.right));
    offset = writeU32(view, offset, dataLength);
    offset = writeU32(view, offset, insertionDataLength);
    offset = writeU32(view, offset, passwordLength);

    for (const page of pages) {
        offset = writeU32(view, offset, page);
    }

    output.set(data, offset);
    offset += dataLength;
    output.set(insertionData, offset);
    offset += insertionDataLength;
    output.set(password, offset);

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
        isNativeErrorEnvelope,
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
    let offset = 4;
    const pageCount = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
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
        box: {
            x: view.getFloat64(offset, true),
            y: view.getFloat64(offset + 8, true),
            width: view.getFloat64(offset + 16, true),
            height: view.getFloat64(offset + 24, true),
        },
        offset: offset + 32,
    };
}

function readGeometryResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    let offset = 4;
    const rotation = view.getUint32(offset, true);
    offset += 4;
    const media = readBox(view, offset);
    offset = media.offset;
    const hasCropBox = view.getUint32(offset, true) === 1;
    offset += 4;
    const crop = readBox(view, offset);
    offset = crop.offset;
    if (offset !== output.byteLength) {
        return null;
    }

    return {
        mediaBox: media.box,
        cropBox: hasCropBox ? crop.box : null,
        rotation,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isOptionalNonNegativeInteger(value: unknown) {
    return value === undefined
        || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isCatalogBookmark(
    value: unknown,
    depth: number,
    state: {count: number},
): value is IBrowserPdfCombineCatalog['bookmarks'][number] {
    if (!isRecord(value) || depth >= MAX_BOOKMARK_DEPTH || state.count >= MAX_BOOKMARK_ITEMS) {
        return false;
    }
    if (
        typeof value.title !== 'string'
        || (value.pageIndex !== null && !isOptionalNonNegativeInteger(value.pageIndex))
        || (value.namedDest !== null && typeof value.namedDest !== 'string')
        || typeof value.bold !== 'boolean'
        || typeof value.italic !== 'boolean'
        || (value.color !== null && typeof value.color !== 'string')
        || (value.pageYRatio !== undefined
            && value.pageYRatio !== null
            && (typeof value.pageYRatio !== 'number' || !Number.isFinite(value.pageYRatio)))
        || !Array.isArray(value.items)
        || value.items.length > MAX_BOOKMARK_ITEMS
    ) {
        return false;
    }
    state.count += 1;
    return value.items.every(item => isCatalogBookmark(item, depth + 1, state));
}

function isPdfCombineCatalog(value: unknown): value is IBrowserPdfCombineCatalog {
    if (!isRecord(value) || !Array.isArray(value.bookmarks) || !Array.isArray(value.pageLabels)) {
        return false;
    }
    if (value.bookmarks.length > MAX_BOOKMARK_ITEMS || value.pageLabels.length > 2048) {
        return false;
    }
    const state = {count: 0};
    if (!value.bookmarks.every(bookmark => isCatalogBookmark(bookmark, 0, state))) {
        return false;
    }
    return value.pageLabels.every(range => {
        if (!isRecord(range)) {
            return false;
        }
        return isOptionalNonNegativeInteger(range.pageIndex)
            && typeof range.pageIndex === 'number'
            && (range.style === undefined || typeof range.style === 'string')
            && (range.prefix === undefined || typeof range.prefix === 'string')
            && (range.start === undefined || (typeof range.start === 'number' && Number.isSafeInteger(range.start) && range.start >= 0));
    });
}

function isPdfConformanceFacts(value: unknown): value is IBrowserPdfConformanceFacts {
    return isRecord(value)
        && typeof value.isSigned === 'boolean'
        && typeof value.isEncrypted === 'boolean'
        && typeof value.isTagged === 'boolean'
        && typeof value.hasAcroForm === 'boolean'
        && typeof value.hasXfa === 'boolean';
}

function readJsonResult(output: Uint8Array) {
    if (output.byteLength < 8) {
        return null;
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const dataLength = view.getUint32(4, true);
    if (dataLength !== output.byteLength - 8) {
        return null;
    }
    try {
        return JSON.parse(new TextDecoder().decode(output.slice(8))) as unknown;
    } catch {
        return null;
    }
}

function parseWasmOutput<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    output: Uint8Array,
): IBrowserPageOpsWasmResultMap[K] | null {
    if (output.byteLength < 4) {
        return null;
    }

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const kind = view.getUint32(0, true);
    if (type === 'getPageGeometry') {
        return kind === RESPONSE_GEOMETRY
            ? readGeometryResult(output) as IBrowserPageOpsWasmResultMap[K] | null
            : null;
    }

    if (type === 'parseAnnotations') {
        if (kind !== RESPONSE_ANNOTATION_PARSE || output.byteLength < 8) {
            return null;
        }
        const dataLength = view.getUint32(4, true);
        if (dataLength !== output.byteLength - 8) {
            return null;
        }
        return {data: toTransferableUint8Array(output.slice(8))} as IBrowserPageOpsWasmResultMap[K];
    }

    if (type === 'saveMutations') {
        if (kind !== RESPONSE_SAVE_MUTATIONS || output.byteLength < 20) {
            return null;
        }
        const dataLength = view.getUint32(8, true);
        const identityBindingsLength = view.getUint32(12, true);
        if (
            view.getUint32(16, true) !== 1
            || dataLength + identityBindingsLength + 20 !== output.byteLength
        ) {
            return null;
        }
        let identityBindings: unknown;
        try {
            identityBindings = JSON.parse(new TextDecoder().decode(
                output.slice(20 + dataLength),
            )) as unknown;
        } catch {
            return null;
        }
        if (!Array.isArray(identityBindings) || !identityBindings.every(binding => (
            isRecord(binding)
            && typeof binding.annotationId === 'string'
            && typeof binding.pdfRef === 'string'
        ))) {
            return null;
        }
        return {
            data: toTransferableUint8Array(output.slice(20, 20 + dataLength)),
            pageCount: view.getUint32(4, true),
            identityBindings: identityBindings as IPdfNativeAnnotationIdentityBinding[],
            nativeMutationPostconditionsVerified: true,
        } as IBrowserPageOpsWasmResultMap[K];
    }

    if (type === 'readCatalog' || type === 'conformance') {
        if (kind !== RESPONSE_JSON) {
            return null;
        }
        const value: unknown = readJsonResult(output);
        if (type === 'readCatalog') {
            return isPdfCombineCatalog(value)
                ? value as IBrowserPageOpsWasmResultMap[K]
                : null;
        }
        return isPdfConformanceFacts(value)
            ? value as IBrowserPageOpsWasmResultMap[K]
            : null;
    }

    return kind === RESPONSE_MUTATION
        ? readMutationResult(output) as IBrowserPageOpsWasmResultMap[K] | null
        : null;
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
            error instanceof Error ? error.message : 'Page operation WASM request failed',
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
