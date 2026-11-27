// The page engine as a host runs it: one WebAssembly instance per thread, and the files it lends the engine
// through its host imports. The storage worker runs it on the store files it holds; browser-api runs it for
// page-structure edits and reads, and adds the requests that carry their document in a buffer.
import {getErrorMessage} from '@app/utils/error';
import {BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES, BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
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
import {createNativeWasmToolLoader, type INativeWasmTool} from '@app/platform/browser/nativeWasmTool';
import type {TNativeErrorCode} from '@contracts/nativeErrors';
import {splitPdfNativeMutationSetIntoBoundedChunks} from '@pdf-core/nativePdfMutationPolicy';
import type {IPdfNativeMutationSet} from '@contracts/electronApiDocuments';
import * as v from 'valibot';

export type IPdfPageOpsWasmExports = INativeWasmTool;

const wasmIdentityBindingsSchema = v.array(
    v.object({
        annotationId: v.string(),
        pdfRef: v.string(),
    }),
);
export const PDF_PAGE_OPS_WASM_PATH = '/wasm/evb-pdf-page-ops.wasm';

export function createWasmFailure(code: TNativeErrorCode, message: string): IBrowserPageOpsWasmFailure {
    return {
        status: 'failed',
        error: {
            code,
            message,
        },
    };
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
        if (!open) {
            return -1;
        }
        try {
            run(open);
            return 0;
        } catch (error) {
            open.error ??= error;
            return -1;
        }
    };
    return {
        evb_host: {
            evb_host_source_len: (source: number) => openFiles?.files.sources[source]?.size ?? -1,
            evb_host_source_read: (source: number, at: number, pointer: number, len: number) =>
                call(({files}) => files.sources[source]!.read(view(pointer, len), at)),
            evb_host_source_copy: (source: number, from: number, length: number, at: number) =>
                call(({copies}) => copies.push({source, from, length, at})),
            evb_host_sink_write: (at: number, pointer: number, len: number) => call(({files}) => files.sink.write(view(pointer, len), at)),
            evb_host_sink_read: (at: number, pointer: number, len: number) => call(({files}) => files.sink.read(view(pointer, len), at)),
        },
    };
}

const pageOpsWasm = createNativeWasmToolLoader({
    path: PDF_PAGE_OPS_WASM_PATH,
    prefix: 'evb_pdf_page_ops',
    runExport: 'run',
    label: 'browser page tool',
    maxRequestBytes: BROWSER_PAGE_OPS_MAX_REQUEST_BYTES,
    maxOutputBytes: BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES,
    imports: (getMemory) => createPageOpsHostImports(getMemory),
    trapErrorCode: 'too-large',
});

/**
 * Lets the next request load a fresh engine: a trap leaves `tool` unusable. An engine that already stopped
 * being this thread's, such as one a request held past its retirement, leaves its replacement alone.
 */
export function discardPdfPageOpsWasm(tool: IPdfPageOpsWasmExports) {
    pageOpsWasm.discard(tool);
}

/**
 * Called when a request on `tool` has ended: an engine whose memory grew past the high-water mark stops being
 * this thread's engine, so its memory goes once nothing holds it. A request still holding it, such as a
 * page-structure edit between its write and its verification, finishes on it; the next request loads a fresh one.
 */
export function releasePdfPageOpsWasmAboveHighWater(tool: IPdfPageOpsWasmExports) {
    pageOpsWasm.releaseIfAboveHighWater(tool);
}

export function loadPdfPageOpsWasm() {
    return pageOpsWasm.load();
}

export const callPdfPageOpsWasm = pageOpsWasm.callLoaded;

export const readPdfPageOpsWasmDigest = () => pageOpsWasm.readDigest();

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
    pageStructureTail = new Promise<void>((resolve) => {
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

export function runFileRequest(tool: IPdfPageOpsWasmExports, file: IFileRequest, options?: {skipHighWaterRelease?: boolean}) {
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
    for (const page of pages) {
        offset = writeU32(view, offset, toWasmU32(page));
    }
    request.set(payload, offset);
    const result = pageOpsWasm.callLoaded(tool, request, {
        afterRun: () => {
            if (openFiles?.error !== undefined) {
                throw openFiles.error;
            }
        },
        rethrowNonTrapErrors: true,
        ...(options?.skipHighWaterRelease ? {skipHighWaterRelease: true} : {}),
    });
    return result.status === 'succeeded' ? result.output : result;
}

/** A WRITTEN_HEADER answer: what the engine wrote, and a save's identity bindings as JSON after it. */
function readWritten(output: Uint8Array | IBrowserPageOpsWasmFailure) {
    if (isBrowserPageOpsWasmFailure(output)) {
        return output;
    }
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
    return withOpenFiles(files, async (open) => {
        const written = readWritten(
            runFileRequest(exports, {
                operation: PAGE_STRUCTURE_OPERATIONS[edit.kind],
                sourceCount: files.sources.length,
                ...(edit.kind === 'insert' ? {afterPage: edit.afterPage} : {}),
                ...('pages' in edit ? {pages: edit.pages} : {}),
            }),
        );
        if (isBrowserPageOpsWasmFailure(written)) {
            return written;
        }
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

const BLOB_SOURCE_BLOCK_BYTES = 64 * 1024;
const BLOB_SOURCE_CACHED_BLOCKS = 16;
const BLOB_SOURCE_UNCACHED_READ_BYTES = 256 * 1024;

interface ISyncBlobReader {
    readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

/**
 * Synchronous range reader over a Blob in a worker, backed by a bounded 1 MiB
 * LRU block cache so repeated small xref and page-tree reads do not issue one
 * slice syscall per parse while never loading large PDFs into JS heap.
 */
export function createSyncBlobSource(blob: Blob, reader: ISyncBlobReader) {
    const blocks = new Map<number, Uint8Array>();
    const readBlock = (index: number) => {
        let bytes = blocks.get(index);
        if (bytes) {
            blocks.delete(index);
        } else {
            const start = index * BLOB_SOURCE_BLOCK_BYTES;
            const end = Math.min(blob.size, start + BLOB_SOURCE_BLOCK_BYTES);
            const raw = reader.readAsArrayBuffer(blob.slice(start, end));
            if (raw.byteLength !== end - start) {
                throw new Error('The document ended before its cross-reference said');
            }
            bytes = new Uint8Array(raw);
            if (blocks.size >= BLOB_SOURCE_CACHED_BLOCKS) {
                blocks.delete(blocks.keys().next().value!);
            }
        }
        blocks.set(index, bytes);
        return bytes;
    };
    return {
        size: blob.size,
        read(into: Uint8Array, at: number) {
            const length = into.byteLength;
            if (length === 0) {
                return;
            }
            if (!Number.isSafeInteger(at) || at < 0 || at + length > blob.size) {
                throw new Error('The document ended before its cross-reference said');
            }
            if (length > BLOB_SOURCE_UNCACHED_READ_BYTES) {
                const raw = reader.readAsArrayBuffer(blob.slice(at, at + length));
                if (raw.byteLength !== length) {
                    throw new Error('The document ended before its cross-reference said');
                }
                into.set(new Uint8Array(raw));
                return;
            }
            let done = 0;
            while (done < length) {
                const offset = at + done;
                const block = readBlock(Math.floor(offset / BLOB_SOURCE_BLOCK_BYTES));
                const from = offset % BLOB_SOURCE_BLOCK_BYTES;
                const count = Math.min(length - done, block.byteLength - from);
                if (count <= 0) {
                    throw new Error('The document ended before its cross-reference said');
                }
                into.set(block.subarray(from, from + count), done);
                done += count;
            }
        },
    };
}

/** A Blob read by range: synchronous slices in a worker, its bytes in a window, which has no synchronous reader. */
export async function blobSource(blob: Blob) {
    const {FileReaderSync} = globalThis as {FileReaderSync?: new () => ISyncBlobReader};
    if (!FileReaderSync) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {size: bytes.byteLength, read: (into: Uint8Array, at: number) => into.set(bytes.subarray(at, at + into.byteLength))};
    }
    return createSyncBlobSource(blob, new FileReaderSync());
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
    const append = (sources: IPageStructureFiles['sources'], operation: number, payload: unknown) =>
        withOpenFiles(
            {
                sources: [document, ...sources],
                sink: file,
                copy: () => Promise.reject(new Error('An appended revision copies no stream')),
            },
            async () =>
                readWritten(
                    runFileRequest(exports, {
                        operation,
                        sourceCount: sources.length + 1,
                        payload: new TextEncoder().encode(JSON.stringify(payload)),
                    }),
                ),
        );
    if ('instructions' in request) {
        const written = await append(request.pagePdfs.map(bytesSource), OPERATION_CODES.ocrTextLayer, request.instructions);
        if (isBrowserPageOpsWasmFailure(written)) {
            return written;
        }
        if (written.length <= base) {
            return createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
        }
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
            if (isBrowserPageOpsWasmFailure(written)) {
                return written;
            }
            let bindings: unknown;
            try {
                bindings = JSON.parse(new TextDecoder().decode(written.tail));
            } catch {
                bindings = null;
            }
            const parsed = v.safeParse(wasmIdentityBindingsSchema, bindings, {abortEarly: true});
            // A chunk that writes no object leaves the document as it was: a successful no-op.
            if (!parsed.success || written.length < document.size) {
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
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
}

/** `data` with the revisions `request` appends, for a PDF already in memory. */
export async function appendPdfMutationsToBytes(data: Uint8Array, request: IPdfAppendRequest) {
    let buffer = data.slice();
    let length = data.byteLength;
    const result = await appendPdfMutations(
        {
            read(into, at) {
                if (at + into.byteLength > length) {
                    throw new Error('The document ended before its cross-reference said');
                }
                into.set(buffer.subarray(at, at + into.byteLength));
            },
            write(bytes, at) {
                if (at < data.byteLength) {
                    throw new Error('An append cannot write over its document');
                }
                if (at + bytes.byteLength > buffer.byteLength) {
                    const grown = new Uint8Array(Math.max(at + bytes.byteLength, buffer.byteLength * 2));
                    grown.set(buffer.subarray(0, length));
                    buffer = grown;
                }
                buffer.set(bytes, at);
                length = Math.max(length, at + bytes.byteLength);
            },
        },
        data.byteLength,
        request,
    );
    return isBrowserPageOpsWasmFailure(result) ? result : {...result, data: buffer.slice(0, result.length)};
}
