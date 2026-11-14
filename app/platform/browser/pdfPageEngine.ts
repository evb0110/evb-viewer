// The page engine as a host runs it: one WebAssembly instance per thread, and the files it lends the engine
// through its host imports. The storage worker runs it on the store files it holds; browser-api runs it for
// page-structure edits and reads, and adds the requests that carry their document in a buffer.
import { getErrorMessage } from '@app/utils/error';
import {
    FILE_REQUEST_HEADER,
    MAX_U32,
    OPERATION_CODES,
    REQUEST_MAGIC,
    REQUEST_VERSION_FILES,
    RESPONSE_WRITTEN,
    U32_BYTES,
    WRITTEN_HEADER,
} from '@contracts/browserPageOpsWasm.generated';
import {
    isBrowserPageOpsWasmFailure,
    type IBrowserPageOpsWasmFailure,
    type IBrowserPageOpsWorkerRequestMap,
    type IOcrTextLayerInstructions,
} from '@contracts/browserPageOpsWorker';
import { loadWasmWithDeadline } from '@app/platform/browser/loadWasmWithDeadline';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import type {IPdfNativeMutationSet} from '@contracts/electronApiDocuments';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import * as v from 'valibot';

export interface IPdfPageOpsWasmExports {
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

const wasmIdentityBindingsSchema = v.array(v.object({
    annotationId: v.string(),
    pdfRef: v.string(),
}));
const WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';

let wasmExportsPromise: Promise<IPdfPageOpsWasmExports> | null = null;

export function createWasmFailure(
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

/** Lets the next request load a fresh engine: a trap leaves this one unusable. */
export function discardPdfPageOpsWasm() {
    wasmExportsPromise = null;
}

export function loadPdfPageOpsWasm() {
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

export function createWasmLoadFailure(error: unknown) {
    return createWasmFailure(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'io',
        `The browser page tool could not be loaded: ${getErrorMessage(error)}`,
    );
}

export function writeMagic(request: Uint8Array, offset: number) {
    request.set(new TextEncoder().encode(REQUEST_MAGIC), offset);
}

export function toWasmU32(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
        throw new Error('Invalid page-op WASM integer field');
    }

    return value;
}

export function writeU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + U32_BYTES;
}

export function copyWasmBytes(
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

export function readWasmFailure(
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
export async function withOpenFiles<T>(files: IPageStructureFiles, task: (open: NonNullable<typeof openFiles>) => Promise<T>) {
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

export interface IFileRequest {
    operation: number;
    sourceCount: number;
    afterPage?: number;
    pages?: readonly number[];
    /** What follows the page list: a save's JSON mutations, OCR instructions or a visibility flag. */
    payload?: Uint8Array;
}

export function runFileRequest(exports: IPdfPageOpsWasmExports, file: IFileRequest) {
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
export async function blobSource(blob: Blob) {
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

