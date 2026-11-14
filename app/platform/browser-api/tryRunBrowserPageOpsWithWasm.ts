import {
    BROWSER_PAGE_OPS_MAX_REQUEST_BYTES, BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES,
} from '@contracts/browserPageOpsLimits';
import { getErrorMessage } from '@app/utils/error';
import {
    BYTES_HEADER,
    FILE_REQUEST_HEADER,
    MAX_U32,
    MUTATION_HEADER,
    INSTRUCTED_REQUEST_HEADER,
    REPORTED_HEADER,
    TEXT_BOX_APPEARANCE_HEADER,
    RESPONSE_TEXT_BOX_APPEARANCE,
    OPERATION_CODES,
    REQUEST_HEADER,
    REQUEST_MAGIC,
    REQUEST_VERSION,
    REQUEST_VERSION_FILES,
    REQUEST_VERSION_INSTRUCTED,
    RESPONSE_ANNOTATION_PARSE,
    RESPONSE_JSON,
    RESPONSE_MUTATION,
    RESPONSE_REPORTED_INCREMENT,
    RESPONSE_REPORTED_PDF,
    RESPONSE_REPORTED_RASTER,
    RESPONSE_WRITTEN,
    U32_BYTES,
    WRITTEN_HEADER,
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
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import type {IPdfNativeMutationSet} from '@contracts/electronApiDocuments';
import type {IOcrTextLayerInstructions} from '@contracts/browserPageOpsWorker';
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



// Page-structure edits read and write files through the engine's host imports, not a request buffer.
type IBrowserPageOpsWasmRequestMap = Omit<IBrowserPageOpsWorkerRequestMap, 'pageStructure'>;

const wasmBytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const wasmMutationResultSchema = v.object({
    data: wasmBytesSchema,
    pageCount: v.number(),
});
const wasmIdentityBindingsSchema = v.array(v.object({
    annotationId: v.string(),
    pdfRef: v.string(),
}));
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

const WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';

let wasmExportsPromise: Promise<IPdfPageOpsWasmExports> | null = null;

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

function getPdfPageOpsWasmExports(exports: WebAssembly.Exports): IPdfPageOpsWasmExports {
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
        throw new Error('The page tool does not match this version of the app');
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

function resolveWasmUrl() {
    return new URL(WASM_PATH, globalThis.location.href).toString();
}

/** Stream data the engine leaves to the host: `length` bytes of source `source` at `from`, to the sink at `at`. */
export interface IPageStructureCopy {
    source: number;
    from: number;
    length: number;
    at: number;
}

/** The files of the page-structure edit running now, which the engine reaches through its host imports. */
export interface IPageStructureFiles {
    /** `read` fills `into` from `at` or throws. */
    sources: readonly {size: number; read(into: Uint8Array, at: number): void}[];
    /** The output file; `write` stores all of `bytes` or throws. */
    sink: {write(bytes: Uint8Array, at: number): void; read(into: Uint8Array, at: number): void};
    /** Makes the copies the engine asked for, between its write and its verification. */
    copy(copies: readonly IPageStructureCopy[]): Promise<void>;
}

let openFiles: {files: IPageStructureFiles; copies: IPageStructureCopy[]; error: unknown} | null = null;

/** The engine's `evb_host` imports over `openFiles`. A host failure answers -1 and is kept for the caller. */
export function createPageOpsHostImports(memory: () => WebAssembly.Memory) {
    const view = (pointer: number, len: number) => new Uint8Array(memory().buffer, pointer >>> 0, len >>> 0);
    const call = (run: (open: NonNullable<typeof openFiles>) => void) => {
        const open = openFiles;
        if (!open) return -1;
        try {
            run(open);
            return 0;
        } catch (error) {
            open.error ??= error;
            return -1;
        }
    };
    return {evb_host: {
        evb_host_source_len: (source: number) => openFiles?.files.sources[source]?.size ?? -1,
        evb_host_source_read: (source: number, at: number, pointer: number, len: number) => call(({files}) => files.sources[source]!.read(view(pointer, len), at)),
        evb_host_source_copy: (source: number, from: number, length: number, at: number) => call(({copies}) => copies.push({source, from, length, at})),
        evb_host_sink_write: (at: number, pointer: number, len: number) => call(({files}) => files.sink.write(view(pointer, len), at)),
        evb_host_sink_read: (at: number, pointer: number, len: number) => call(({files}) => files.sink.read(view(pointer, len), at)),
    }};
}

function loadPdfPageOpsWasm() {
    const pending = wasmExportsPromise ??= (async () => {
        if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') {
            throw new Error('This browser cannot run WebAssembly');
        }
        let memory: WebAssembly.Memory | null = null;
        const instantiated = await loadWasmWithDeadline(resolveWasmUrl(), createPageOpsHostImports(() => memory!));
        const instance = 'instance' in instantiated
            ? instantiated.instance
            : instantiated;
        const exports = getPdfPageOpsWasmExports(instance.exports);
        memory = exports.memory;
        return exports;
    })();
    // A failed load must not disable the page tool for the rest of the
    // session: the next operation loads it again.
    pending.catch(() => {
        if (wasmExportsPromise === pending) wasmExportsPromise = null;
    });
    return pending;
}

function createWasmLoadFailure(error: unknown) {
    return createWasmFailure(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'io',
        `The browser page tool could not be loaded: ${getErrorMessage(error)}`,
    );
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
            wasmExportsPromise = null;
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

export type TPageStructureEdit = IBrowserPageOpsWorkerRequestMap['pageStructure']['edit'];

const PAGE_STRUCTURE_OPERATIONS = {
    delete: OPERATION_CODES.deletePages,
    extract: OPERATION_CODES.extractPages,
    reorder: OPERATION_CODES.reorderPages,
    insert: OPERATION_CODES.insertPages,
    merge: OPERATION_CODES.mergePages,
    verify: OPERATION_CODES.verifyWritten,
} as const;

/** The engine keeps one written edit until it is verified, so edits in one thread run one at a time. */
let pageStructureTail: Promise<unknown> = Promise.resolve();

/** Runs `task` over `files` after the file requests before it in this thread. */
async function withOpenFiles<T>(files: IPageStructureFiles, task: (open: NonNullable<typeof openFiles>) => Promise<T>) {
    const previous = pageStructureTail;
    let done = () => {};
    pageStructureTail = new Promise<void>(resolve => {
        done = resolve;
    });
    await previous;
    const open = {files, copies: [] as IPageStructureCopy[], error: undefined as unknown};
    openFiles = open;
    try {
        return await task(open);
    } finally {
        openFiles = null;
        done();
    }
}

interface IFileRequest {
    operation: number;
    sourceCount: number;
    afterPage?: number;
    pages?: readonly number[];
    /** What follows the page list: a save's JSON mutations, OCR instructions or a visibility flag. */
    payload?: Uint8Array;
}

function runFileRequest(exports: IPdfPageOpsWasmExports, file: IFileRequest) {
    const pages = file.pages ?? [];
    const payload = file.payload ?? new Uint8Array();
    const request = new Uint8Array(FILE_REQUEST_HEADER.bytes + pages.length * U32_BYTES + payload.byteLength);
    const view = new DataView(request.buffer);
    writeMagic(request, FILE_REQUEST_HEADER.magic);
    writeU32(view, FILE_REQUEST_HEADER.version, REQUEST_VERSION_FILES);
    writeU32(view, FILE_REQUEST_HEADER.operation, file.operation);
    writeU32(view, FILE_REQUEST_HEADER.sourceCount, file.sourceCount);
    writeU32(view, FILE_REQUEST_HEADER.afterPage, toWasmU32(file.afterPage ?? 0));
    let offset = writeU32(view, FILE_REQUEST_HEADER.pageCount, pages.length);
    for (const page of pages) offset = writeU32(view, offset, toWasmU32(page));
    request.set(payload, offset);
    const pointer = exports.evb_pdf_page_ops_alloc(request.byteLength);
    if (pointer === 0) return createWasmFailure('too-large', 'Page operation WASM could not allocate request memory');
    let trapped = false;
    try {
        getCheckedWasmMemoryView(exports.memory, pointer, request.byteLength, 'Page operation WASM allocation').set(request);
        const resultCode = exports.evb_pdf_page_ops_run(pointer, request.byteLength);
        if (openFiles?.error !== undefined) throw openFiles.error;
        if (resultCode !== 0) return readWasmFailure(resultCode, exports);
        return copyWasmBytes(exports, exports.evb_pdf_page_ops_output_ptr(), exports.evb_pdf_page_ops_output_len());
    } catch (error) {
        if (!(error instanceof Error && error.name === 'RuntimeError')) throw error;
        // As in `runWasmRequest`: a trap leaves the engine unusable, so the next request loads a fresh one.
        trapped = true;
        wasmExportsPromise = null;
        return createWasmFailure('too-large', `The browser page tool ran out of memory: ${getErrorMessage(error)}`);
    } finally {
        if (!trapped) exports.evb_pdf_page_ops_free(pointer, request.byteLength);
    }
}

/** A WRITTEN_HEADER answer: what the engine wrote, and a save's identity bindings as JSON after it. */
function readWritten(output: Uint8Array | IBrowserPageOpsWasmFailure) {
    if (isBrowserPageOpsWasmFailure(output)) return output;
    const written = new DataView(output.buffer, output.byteOffset, output.byteLength);
    if (output.byteLength < WRITTEN_HEADER.bytes || written.getUint32(WRITTEN_HEADER.kind, true) !== RESPONSE_WRITTEN) {
        return createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
    }
    return {
        pageCount: written.getUint32(WRITTEN_HEADER.pageCount, true),
        length: written.getFloat64(WRITTEN_HEADER.length, true),
        tail: output.subarray(WRITTEN_HEADER.bytes),
    };
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
 * Runs a page-structure edit over `files` in this thread's engine. The engine reads its sources' objects by
 * range and writes the output, leaving stream data for `files.copy` to copy; then it verifies what was
 * written. Its memory holds the documents' objects and never their bytes. A host failure, such as a full
 * store, is thrown as itself.
 */
export async function runPageStructureEdit(
    edit: TPageStructureEdit,
    files: IPageStructureFiles,
): Promise<{pageCount: number; length: number} | IBrowserPageOpsWasmFailure> {
    let exports: IPdfPageOpsWasmExports;
    try {
        exports = await loadPdfPageOpsWasm();
    } catch (error) {
        return createWasmLoadFailure(error);
    }
    return withOpenFiles(files, async open => {
        const written = readWritten(runFileRequest(exports, {
            operation: PAGE_STRUCTURE_OPERATIONS[edit.kind],
            sourceCount: files.sources.length,
            ...(edit.kind === 'insert' ? {afterPage: edit.afterPage} : {}),
            ...('pages' in edit ? {pages: edit.pages} : {}),
        }));
        if (isBrowserPageOpsWasmFailure(written)) return written;
        await files.copy(open.copies);
        const verified = readWritten(runFileRequest(exports, {operation: PAGE_STRUCTURE_OPERATIONS.verify, sourceCount: 0}));
        return isBrowserPageOpsWasmFailure(verified) ? verified : {pageCount: verified.pageCount, length: verified.length};
    });
}

/** A file the engine reads and appends to synchronously: a store file's access handle, or bytes in memory. */
export interface IPdfAppendFile {
    /** Fills `into` from `at` or throws. */
    read(into: Uint8Array, at: number): void;
    /** Stores all of `bytes` at `at` or throws. */
    write(bytes: Uint8Array, at: number): void;
}

/** Native edits to append as revisions. */
export interface IPdfAppendRequest {
    mutations: IPdfNativeMutationSet;
    modifiedAt: string;
    /** The bytes of `mutations.originalAppearanceSource`, whose original appearances its text boxes restore. */
    appearanceSource?: Blob;
}

/** A searchable text layer to append, from the Tesseract page PDFs its instructions name by index. */
export interface IOcrTextLayerAppendRequest {
    instructions: IOcrTextLayerInstructions;
    pagePdfs: Uint8Array[];
}

export interface IPdfAppendResult {
    pageCount: number;
    /** The file's length with the appended revisions. */
    length: number;
    identityBindings: v.InferOutput<typeof wasmIdentityBindingsSchema>;
    /** SHA-256 of the appended bytes. */
    sha256: string;
}

/** A Blob read by range: synchronous slices in a worker, its bytes in a window, which has no synchronous reader. */
async function blobSource(blob: Blob) {
    const {FileReaderSync} = globalThis as {FileReaderSync?: new () => {readAsArrayBuffer(blob: Blob): ArrayBuffer}};
    if (!FileReaderSync) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {size: bytes.byteLength, read: (into: Uint8Array, at: number) => into.set(bytes.subarray(at, at + into.byteLength))};
    }
    const reader = new FileReaderSync();
    return {
        size: blob.size,
        read(into: Uint8Array, at: number) {
            const bytes = reader.readAsArrayBuffer(blob.slice(at, at + into.byteLength));
            if (bytes.byteLength !== into.byteLength) throw new Error('The document ended before its cross-reference said');
            into.set(new Uint8Array(bytes));
        },
    };
}

/** Bytes in hand read as a source. */
function bytesSource(bytes: Uint8Array) {
    return {size: bytes.byteLength, read: (into: Uint8Array, at: number) => into.set(bytes.subarray(at, at + into.byteLength))};
}

/**
 * Appends the revisions `request` makes to the PDF of `base` bytes at the start of `file`, writing only past
 * them: one revision per bounded chunk of a mutation set, each read over the one before, or one searchable
 * text layer. The engine reads the document's objects by range and holds no copy of it. The caller owns what
 * lies past `base` afterwards, on success and failure alike.
 */
export async function appendPdfMutations(
    file: IPdfAppendFile,
    base: number,
    request: IPdfAppendRequest | IOcrTextLayerAppendRequest,
): Promise<IPdfAppendResult | IBrowserPageOpsWasmFailure> {
    let exports: IPdfPageOpsWasmExports;
    try {
        exports = await loadPdfPageOpsWasm();
    } catch (error) {
        return createWasmLoadFailure(error);
    }
    const document = {size: base, read: (into: Uint8Array, at: number) => file.read(into, at)};
    const identityBindings: IPdfAppendResult['identityBindings'] = [];
    let pageCount = 0;
    const append = (sources: IPageStructureFiles['sources'], operation: number, payload: unknown) => withOpenFiles({
        sources: [document, ...sources],
        sink: file,
        copy: () => Promise.reject(new Error('An appended revision copies no stream')),
    }, async () => readWritten(runFileRequest(exports, {
        operation,
        sourceCount: sources.length + 1,
        payload: new TextEncoder().encode(JSON.stringify(payload)),
    })));
    if ('instructions' in request) {
        const written = await append(request.pagePdfs.map(bytesSource), OPERATION_CODES.ocrTextLayer, request.instructions);
        if (isBrowserPageOpsWasmFailure(written)) return written;
        if (written.length <= base) return createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
        pageCount = written.pageCount;
        document.size = written.length;
    } else {
        const appearanceSource = request.appearanceSource ? await blobSource(request.appearanceSource) : null;
        for (const {originalAppearanceSource, ...mutations} of splitPdfNativeMutationSetIntoBoundedChunks(request.mutations)) {
            // Only a chunk that restores original appearances reads their document.
            if (originalAppearanceSource !== undefined && !appearanceSource) {
                return createWasmFailure('invalid-request', 'Original appearance restore requires its document');
            }
            const written = await append(
                originalAppearanceSource !== undefined && appearanceSource ? [appearanceSource] : [],
                OPERATION_CODES.saveMutations,
                {mutations, modifiedAt: request.modifiedAt},
            );
            if (isBrowserPageOpsWasmFailure(written)) return written;
            let bindings: unknown;
            try {
                bindings = JSON.parse(new TextDecoder().decode(written.tail));
            } catch {
                bindings = null;
            }
            const parsed = v.safeParse(wasmIdentityBindingsSchema, bindings, {abortEarly: true});
            if (!parsed.success || written.length <= document.size) {
                return createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
            }
            identityBindings.push(...parsed.output);
            pageCount = written.pageCount;
            document.size = written.length;
        }
    }
    const appended = new Uint8Array(document.size - base);
    file.read(appended, base);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', appended));
    return {
        pageCount,
        length: document.size,
        identityBindings,
        sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
    };
}

/** `data` with the revisions `request` appends, for a PDF already in memory. */
export async function appendPdfMutationsToBytes(data: Uint8Array, request: IPdfAppendRequest) {
    let buffer = data.slice();
    let length = data.byteLength;
    const result = await appendPdfMutations({
        read(into, at) {
            if (at + into.byteLength > length) throw new Error('The document ended before its cross-reference said');
            into.set(buffer.subarray(at, at + into.byteLength));
        },
        write(bytes, at) {
            if (at < data.byteLength) throw new Error('An append cannot write over its document');
            if (at + bytes.byteLength > buffer.byteLength) {
                const grown = new Uint8Array(Math.max(at + bytes.byteLength, buffer.byteLength * 2));
                grown.set(buffer.subarray(0, length));
                buffer = grown;
            }
            buffer.set(bytes, at);
            length = Math.max(length, at + bytes.byteLength);
        },
    }, data.byteLength, request);
    return isBrowserPageOpsWasmFailure(result) ? result : {...result, data: buffer.slice(0, result.length)};
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
