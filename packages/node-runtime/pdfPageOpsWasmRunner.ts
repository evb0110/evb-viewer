import {randomUUID} from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    copyFileSync,
    existsSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    openSync,
    readSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {totalmem} from 'node:os';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    BYTES_HEADER,
    FILE_REQUEST_HEADER,
    MAX_BUFFER_BYTES,
    OPERATION_CODES,
    REQUEST_HEADER,
    REQUEST_MAGIC,
    REQUEST_VERSION,
    REQUEST_VERSION_FILES,
    RESPONSE_JSON,
    RESPONSE_TEXT_BOX_APPEARANCE,
    RESPONSE_WRITTEN,
    TEXT_BOX_APPEARANCE_HEADER,
    U32_BYTES,
    WRITTEN_HEADER,
} from '@contracts/browserPageOpsWasm.generated';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type INativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';

export interface IPageOpsProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 * 1024;
const FOUR_GIB = 4 * 1024 * MIB;
const COPY_CHUNK_BYTES = 4 * MIB;
const MAX_COLLECTION_ITEMS = 100_000;
const MAX_PATH_INPUT_PDF_PAGES = 1_000_000;
const MAX_SIDECAR_BYTES = 256 * MIB;
const MAX_PASSWORD_FILE_BYTES = 16 * 1024;
const MAX_OPEN_EXTRA_SOURCE_FDS = 16;
const MAX_U32 = 0xffff_ffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const requestMagicBytes = textEncoder.encode(REQUEST_MAGIC);

export const PDF_PAGE_OPS_WASM_FILE_NAME = 'evb-pdf-page-ops.wasm';

export function isPdfPageOpsWasmPath(command: string) {
    return basename(command).toLowerCase() === PDF_PAGE_OPS_WASM_FILE_NAME;
}

export function defaultDesktopPageOpsWasmHighWaterBytes() {
    return totalmem() > FOUR_GIB ? 256 * MIB : 128 * MIB;
}

export class PdfPageOpsNativeError extends Error {
    readonly code: TNativeErrorCode;

    constructor(code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'PdfPageOpsNativeError';
        this.code = code;
    }
}

interface IPdfPageOpsWasmExports {
    memory: WebAssembly.Memory;
    alloc(byteLength: number): number;
    free(pointer: number, byteLength: number): void;
    run(pointer: number, byteLength: number): number;
    outputPtr(): number;
    outputLen(): number;
    errorPtr(): number;
    errorLen(): number;
}

interface IHostSourceEntry {
    fd: number | null;
    len: number | null;
    path: string;
}

interface IHostSinkState {
    fd: number | null;
    path: string;
    inPlace: boolean;
    originalLen: number;
    baseSourceLen: number;
    baseCopied: boolean;
    writtenAny: boolean;
    maxLen: number;
}

interface IHostIoContext {
    sources: IHostSourceEntry[];
    extraOpenOrder: number[];
    sink: IHostSinkState | null;
    memory: WebAssembly.Memory | null;
}

interface IFileWitness {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    dev: number;
    ino: number;
}

function isWasmFn(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

function readExports(exports: WebAssembly.Exports): IPdfPageOpsWasmExports {
    const memory = exports.memory;
    const abiVersion = exports.evb_wasm_request_allocation_abi_version;
    const alloc = exports.evb_pdf_page_ops_alloc;
    const free = exports.evb_pdf_page_ops_free;
    const run = exports.evb_pdf_page_ops_run;
    const outputPtr = exports.evb_pdf_page_ops_output_ptr;
    const outputLen = exports.evb_pdf_page_ops_output_len;
    const errorPtr = exports.evb_pdf_page_ops_error_ptr;
    const errorLen = exports.evb_pdf_page_ops_error_len;
    if (
        !(memory instanceof WebAssembly.Memory)
        || !isWasmFn(abiVersion)
        || abiVersion() !== WASM_REQUEST_ALLOCATION_ABI_VERSION
        || !isWasmFn(alloc)
        || !isWasmFn(free)
        || !isWasmFn(run)
        || !isWasmFn(outputPtr)
        || !isWasmFn(outputLen)
        || !isWasmFn(errorPtr)
        || !isWasmFn(errorLen)
    ) {
        throw new PdfPageOpsNativeError(
            'native-failure',
            'evb-pdf-page-ops.wasm does not match this version of the app',
        );
    }
    return {
        memory,
        alloc,
        free,
        run,
        outputPtr,
        outputLen,
        errorPtr,
        errorLen,
    };
}

function readErrorEnvelope(tool: IPdfPageOpsWasmExports, resultCode: number): INativeErrorEnvelope {
    const length = tool.errorLen();
    const encoded = length === 0
        ? null
        : textDecoder.decode(
            getCheckedWasmMemoryView(tool.memory, tool.errorPtr(), length, 'evb-pdf-page-ops').slice(),
        );
    return decodeSerializableErrorEnvelope(encoded, NATIVE_ERROR_ENVELOPE_SCHEMA, {allowBareJsonString: true}) ?? {
        code: 'native-failure',
        message: encoded ?? `evb-pdf-page-ops failed with result code ${resultCode}`,
    };
}

function readExactSync(fd: number, target: Uint8Array, offset: number): boolean {
    let total = 0;
    while (total < target.byteLength) {
        const read = readSync(fd, target, total, target.byteLength - total, offset + total);
        if (read <= 0) {
            return false;
        }
        total += read;
    }
    return true;
}

function writeExactSync(fd: number, source: Uint8Array, offset: number): boolean {
    let total = 0;
    while (total < source.byteLength) {
        const written = writeSync(fd, source, total, source.byteLength - total, offset + total);
        if (written <= 0) {
            return false;
        }
        total += written;
    }
    return true;
}

function isAllZero(chunk: Uint8Array): boolean {
    const wordCount = Math.floor(chunk.byteLength / 4);
    if (wordCount > 0) {
        const words = new Uint32Array(chunk.buffer, chunk.byteOffset, wordCount);
        for (let i = 0; i < words.length; i += 1) {
            if (words[i] !== 0) {
                return false;
            }
        }
    }
    for (let i = wordCount * 4; i < chunk.byteLength; i += 1) {
        if (chunk[i] !== 0) {
            return false;
        }
    }
    return true;
}

function streamCopyFdRangeSync(
    srcFd: number,
    srcOffset: number,
    length: number,
    dstFd: number,
    dstOffset: number,
    scratch: Uint8Array,
    preserveHoles = false,
): boolean {
    let remaining = length;
    let readPos = srcOffset;
    let writePos = dstOffset;
    let skippedTrailingZero = false;
    while (remaining > 0) {
        const chunkLen = Math.min(remaining, scratch.byteLength);
        const chunk = chunkLen === scratch.byteLength ? scratch : scratch.subarray(0, chunkLen);
        if (!readExactSync(srcFd, chunk, readPos)) {
            return false;
        }
        if (preserveHoles && isAllZero(chunk)) {
            skippedTrailingZero = true;
        } else {
            if (!writeExactSync(dstFd, chunk, writePos)) {
                return false;
            }
            skippedTrailingZero = false;
        }
        readPos += chunkLen;
        writePos += chunkLen;
        remaining -= chunkLen;
    }
    if (preserveHoles && skippedTrailingZero) {
        ftruncateSync(dstFd, dstOffset + length);
    }
    return true;
}

/**
 * Copies `source0` into a fresh staging file while preserving sparse holes:
 * tries a copy-on-write reflink (`COPYFILE_FICLONE`) first, then falls back
 * to zero-skipping chunked copy so multi-GiB sparse PDFs never exhaust space.
 */
function copyBasePreservingSparseSync(
    srcPath: string,
    srcFd: number,
    srcLen: number,
    dstPath: string,
    scratch: Uint8Array,
): number {
    try {
        copyFileSync(srcPath, dstPath, fsConstants.COPYFILE_FICLONE_FORCE);
        const fd = openSync(dstPath, 'r+');
        const st = fstatSync(fd);
        if (st.size === srcLen) {
            return fd;
        }
        closeSync(fd);
        unlinkSync(dstPath);
    } catch {
        // Reflink unavailable on this filesystem or OS; fall through to sparse-preserving copy.
        try {
            unlinkSync(dstPath);
        } catch {
            // Destination may not have been created.
        }
    }
    const fd = openSync(dstPath, 'w+');
    try {
        if (!streamCopyFdRangeSync(srcFd, 0, srcLen, fd, 0, scratch, true)) {
            throw new Error('Failed to stream source prefix into staging file');
        }
        return fd;
    } catch (error) {
        try {
            closeSync(fd);
        } catch {
            // Ignore close error during copy failure.
        }
        try {
            unlinkSync(dstPath);
        } catch {
            // Ignore unlink error during copy failure.
        }
        throw error;
    }
}

function canonicalPathForAliasCheck(filePath: string): string {
    try {
        return realpathSync(filePath);
    } catch {
        const resolved = resolve(filePath);
        try {
            return join(realpathSync(dirname(resolved)), basename(resolved));
        } catch {
            return resolved;
        }
    }
}

function sameFileSync(pathA: string, pathB: string): boolean {
    if (pathA === pathB) {
        return true;
    }
    try {
        const statA = statSync(pathA);
        const statB = statSync(pathB);
        if (statA.dev !== 0 && statA.ino !== 0 && statA.dev === statB.dev && statA.ino === statB.ino) {
            return true;
        }
    } catch {
        // One path may not exist yet; fall through to canonical path comparison.
    }
    const canonA = canonicalPathForAliasCheck(pathA);
    const canonB = canonicalPathForAliasCheck(pathB);
    return process.platform === 'win32'
        ? canonA.toLowerCase() === canonB.toLowerCase()
        : canonA === canonB;
}

function captureFileWitness(filePath: string): IFileWitness | null {
    try {
        const st = statSync(filePath);
        if (!st.isFile()) {
            return null;
        }
        return {
            size: st.size,
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            dev: st.dev,
            ino: st.ino,
        };
    } catch {
        return null;
    }
}

function assertFileWitnessUnchanged(filePath: string, expected: IFileWitness, label: string) {
    const current = captureFileWitness(filePath);
    if (
        !current
        || current.size !== expected.size
        || current.mtimeMs !== expected.mtimeMs
        || current.ctimeMs !== expected.ctimeMs
        || (expected.ino !== 0 && (current.dev !== expected.dev || current.ino !== expected.ino))
    ) {
        throw new PdfPageOpsNativeError(
            'io',
            `${label} changed on disk while evb-pdf-page-ops was running: ${filePath}`,
        );
    }
}

export function createTempSiblingPath(targetPath: string) {
    return join(
        dirname(targetPath),
        `.${basename(targetPath)}.evb-wasm-${process.pid}-${randomUUID()}.tmp`,
    );
}

export type TDesktopPageOpsWriteTarget =
    | {
        kind: 'in-place';
        path: string;
    }
    | {
        kind: 'staged';
        outputPath: string;
    };

/**
 * Inspects a CLI argument vector to identify the file-write target so the
 * main-thread worker owner can deterministically roll back or remove staging
 * files if a worker is forcibly terminated.
 */
export function inspectDesktopPageOpsWriteTarget(args: readonly string[]): TDesktopPageOpsWriteTarget | null {
    const command = args[0];
    if (!command) {
        return null;
    }
    let inputPath: string | undefined;
    let outputPath: string | undefined;
    let append = false;
    let appendInPlace = false;
    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]!;
        if (arg === '--input' && i + 1 < args.length) {
            inputPath = args[i + 1];
            i += 1;
        } else if (arg === '--output' && i + 1 < args.length) {
            outputPath = args[i + 1];
            i += 1;
        } else if (arg === '--append') {
            append = true;
        } else if (arg === '--append-in-place') {
            appendInPlace = true;
        }
    }
    if (command === 'save-mutations' && append && appendInPlace && inputPath && outputPath && inputPath === outputPath) {
        return {
            kind: 'in-place',
            path: inputPath,
        };
    }
    if (outputPath && command !== 'text-box-appearance') {
        return {
            kind: 'staged',
            outputPath,
        };
    }
    return null;
}

function ensureSourceLenSync(io: IHostIoContext, index: number): number {
    const entry = io.sources[index];
    if (!entry) {
        return -1;
    }
    if (entry.len !== null) {
        return entry.len;
    }
    try {
        const st = statSync(entry.path);
        if (!st.isFile()) {
            return -1;
        }
        entry.len = st.size;
        return entry.len;
    } catch {
        return -1;
    }
}

function ensureSourceFdSync(io: IHostIoContext, index: number): number {
    const entry = io.sources[index];
    if (!entry) {
        return -1;
    }
    if (entry.fd !== null) {
        if (index > 0) {
            const pos = io.extraOpenOrder.indexOf(index);
            if (pos >= 0) {
                io.extraOpenOrder.splice(pos, 1);
                io.extraOpenOrder.push(index);
            }
        }
        return entry.fd;
    }
    if (index > 0) {
        while (io.extraOpenOrder.length >= MAX_OPEN_EXTRA_SOURCE_FDS) {
            const evictIndex = io.extraOpenOrder.shift();
            if (evictIndex !== undefined) {
                const evicted = io.sources[evictIndex];
                if (evicted && evicted.fd !== null) {
                    try {
                        closeSync(evicted.fd);
                    } catch {
                        // Ignore close error on LRU eviction.
                    }
                    evicted.fd = null;
                }
            }
        }
    }
    const fd = openSync(entry.path, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) {
        closeSync(fd);
        return -1;
    }
    entry.fd = fd;
    entry.len = st.size;
    if (index > 0) {
        io.extraOpenOrder.push(index);
    }
    return fd;
}

function atomicWriteFileSync(targetPath: string, data: Uint8Array | string) {
    const tempPath = createTempSiblingPath(targetPath);
    try {
        writeFileSync(tempPath, data);
        const fd = openSync(tempPath, 'r+');
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameWithRetrySync(tempPath, targetPath);
    } catch (error) {
        try {
            unlinkSync(tempPath);
        } catch {
            // Best-effort cleanup of temp sibling.
        }
        throw error;
    }
}

function renameWithRetrySync(sourcePath: string, targetPath: string) {
    const maxAttempts = process.platform === 'win32' ? 5 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            renameSync(sourcePath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (
                attempt + 1 >= maxAttempts
                || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
            ) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        }
    }
    throw lastError;
}

export interface IPdfPageOpsWasmRunner {
    runFileRequest(request: Uint8Array, io: IHostIoContext): Uint8Array<ArrayBuffer>;
    runRawRequest(request: Uint8Array): Uint8Array<ArrayBuffer>;
    maybeRecycle(): void;
    dispose(): void;
    memoryBytes(): number;
}

/**
 * Reusable single-threaded runner over one compiled `evb-pdf-page-ops.wasm`
 * module with synchronous positional Node `fs` host imports (`evb_host`).
 */
export function createPdfPageOpsWasmRunner(
    wasmModule: WebAssembly.Module,
    options: {highWaterBytes?: number} = {},
): IPdfPageOpsWasmRunner {
    const highWaterBytes = options.highWaterBytes ?? defaultDesktopPageOpsWasmHighWaterBytes();
    const copyBuffer = new Uint8Array(COPY_CHUNK_BYTES);
    let tool: IPdfPageOpsWasmExports | null = null;
    let activeIo: IHostIoContext | null = null;

    function ensureSinkOpen(io: IHostIoContext): IHostSinkState | null {
        const sink = io.sink;
        if (!sink) {
            return null;
        }
        if (sink.fd === null) {
            sink.fd = openSync(sink.path, sink.inPlace ? 'r+' : 'w+');
        }
        return sink;
    }

    const hostImports: WebAssembly.Imports = {
        evb_host: {
            evb_host_source_len(index: number): number {
                if (!activeIo) return -1;
                return ensureSourceLenSync(activeIo, index);
            },
            evb_host_source_read(index: number, offset: number, pointer: number, len: number): number {
                if (!activeIo || !activeIo.memory) return -1;
                if (!Number.isFinite(offset) || offset < 0 || len < 0) return -1;
                if (len === 0) return 0;
                try {
                    const fd = ensureSourceFdSync(activeIo, index);
                    if (fd < 0) return -1;
                    const view = getCheckedWasmMemoryView(activeIo.memory, pointer, len, 'evb_host_source_read');
                    return readExactSync(fd, view, offset) ? 0 : -1;
                } catch {
                    return -1;
                }
            },
            evb_host_source_copy(index: number, offset: number, len: number, at: number): number {
                if (!activeIo) return -1;
                if (!Number.isFinite(offset) || !Number.isFinite(len) || !Number.isFinite(at)) {
                    return -1;
                }
                if (offset < 0 || len < 0 || at < 0) return -1;
                try {
                    const srcFd = ensureSourceFdSync(activeIo, index);
                    if (srcFd < 0) return -1;
                    const sink = ensureSinkOpen(activeIo);
                    if (!sink || sink.fd === null) return -1;
                    if (len > 0 && !streamCopyFdRangeSync(srcFd, offset, len, sink.fd, at, copyBuffer)) {
                        return -1;
                    }
                    sink.writtenAny = true;
                    sink.maxLen = Math.max(sink.maxLen, at + len);
                    return 0;
                } catch {
                    return -1;
                }
            },
            evb_host_sink_write(at: number, pointer: number, len: number): number {
                if (!activeIo || !activeIo.memory) return -1;
                if (!Number.isFinite(at) || at < 0 || len < 0) return -1;
                try {
                    const sink = activeIo.sink;
                    if (!sink) return -1;
                    // Lazy copy-on-first-append: when an incremental op targets a separate output
                    // file and its VERY FIRST write begins at `source0Len`, clone or sparse-copy
                    // source 0's prefix first so no-op runs copy 0 bytes and full rewrites that
                    // start at offset 0 and grow past `source0Len` never clobber their own prefix.
                    if (
                        !sink.inPlace
                        && !sink.baseCopied
                        && !sink.writtenAny
                        && sink.baseSourceLen > 0
                        && at >= sink.baseSourceLen
                    ) {
                        const source0 = activeIo.sources[0];
                        const source0Fd = source0 ? ensureSourceFdSync(activeIo, 0) : -1;
                        if (!source0 || source0Fd < 0) return -1;
                        if (sink.fd !== null) {
                            closeSync(sink.fd);
                            sink.fd = null;
                        }
                        sink.fd = copyBasePreservingSparseSync(
                            source0.path,
                            source0Fd,
                            sink.baseSourceLen,
                            sink.path,
                            copyBuffer,
                        );
                        sink.baseCopied = true;
                        sink.maxLen = Math.max(sink.maxLen, sink.baseSourceLen);
                    } else if (sink.fd === null) {
                        ensureSinkOpen(activeIo);
                    }
                    if (sink.fd === null) return -1;
                    if (len > 0) {
                        const view = getCheckedWasmMemoryView(activeIo.memory, pointer, len, 'evb_host_sink_write');
                        if (!writeExactSync(sink.fd, view, at)) {
                            return -1;
                        }
                    }
                    sink.writtenAny = true;
                    sink.maxLen = Math.max(sink.maxLen, at + len);
                    return 0;
                } catch {
                    return -1;
                }
            },
            evb_host_sink_read(offset: number, pointer: number, len: number): number {
                if (!activeIo || !activeIo.memory) return -1;
                const sink = activeIo.sink;
                if (!sink || sink.fd === null || !Number.isFinite(offset) || offset < 0 || len < 0) {
                    return -1;
                }
                if (len === 0) return 0;
                try {
                    const view = getCheckedWasmMemoryView(activeIo.memory, pointer, len, 'evb_host_sink_read');
                    return readExactSync(sink.fd, view, offset) ? 0 : -1;
                } catch {
                    return -1;
                }
            },
        },
    };

    function getTool() {
        tool ??= readExports(new WebAssembly.Instance(wasmModule, hostImports).exports);
        return tool;
    }

    function dispose() {
        tool = null;
    }

    function maybeRecycle() {
        if (tool && tool.memory.buffer.byteLength > highWaterBytes) {
            dispose();
        }
    }

    function runInternal(request: Uint8Array, io: IHostIoContext | null): Uint8Array<ArrayBuffer> {
        const byteLength = request.byteLength;
        if (byteLength === 0 || byteLength > MAX_BUFFER_BYTES) {
            throw new PdfPageOpsNativeError(
                'too-large',
                'evb-pdf-page-ops request exceeds the admission ceiling',
            );
        }
        const active = getTool();
        const pointer = active.alloc(byteLength);
        if (pointer === 0) {
            dispose();
            throw new PdfPageOpsNativeError(
                'too-large',
                'evb-pdf-page-ops could not allocate request memory',
            );
        }
        if (io) {
            io.memory = active.memory;
        }
        activeIo = io;
        let resultCode: number;
        try {
            getCheckedWasmMemoryView(active.memory, pointer, byteLength, 'evb-pdf-page-ops allocation').set(request);
            resultCode = active.run(pointer, byteLength);
        } catch (error) {
            dispose();
            throw new PdfPageOpsNativeError(
                error instanceof WebAssembly.RuntimeError ? 'panic' : 'native-failure',
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            activeIo = null;
        }

        let output: Uint8Array<ArrayBuffer> | null = null;
        let envelope: INativeErrorEnvelope | null = null;
        try {
            if (resultCode !== 0) {
                envelope = readErrorEnvelope(active, resultCode);
            } else {
                const outputLength = active.outputLen();
                if (outputLength === 0 || outputLength > MAX_BUFFER_BYTES) {
                    envelope = {
                        code: outputLength > MAX_BUFFER_BYTES ? 'too-large' : 'invalid-request',
                        message: 'evb-pdf-page-ops returned an invalid output envelope',
                    };
                } else {
                    const slice = getCheckedWasmMemoryView(active.memory, active.outputPtr(), outputLength, 'evb-pdf-page-ops');
                    const copy = new Uint8Array(new ArrayBuffer(outputLength));
                    copy.set(slice);
                    output = copy;
                }
            }
        } finally {
            try {
                active.free(pointer, byteLength);
            } catch {
                dispose();
            }
        }

        if (envelope !== null) {
            if (envelope.code === 'panic') {
                dispose();
            }
            throw new PdfPageOpsNativeError(envelope.code, envelope.message);
        }
        return output!;
    }

    return {
        runFileRequest: (request, io) => runInternal(request, io),
        runRawRequest: request => runInternal(request, null),
        maybeRecycle,
        dispose,
        memoryBytes: () => tool?.memory.buffer.byteLength ?? 0,
    };
}

function encodeFileRequest(options: {
    operation: number;
    sourceCount: number;
    afterPage?: number;
    pages?: readonly number[];
    tail?: Uint8Array;
}): Uint8Array {
    const pages = options.pages ?? [];
    const tail = options.tail ?? new Uint8Array(0);
    const totalBytes = FILE_REQUEST_HEADER.bytes + pages.length * U32_BYTES + tail.byteLength;
    const buffer = new Uint8Array(totalBytes);
    const view = new DataView(buffer.buffer);
    buffer.set(requestMagicBytes, FILE_REQUEST_HEADER.magic);
    view.setUint32(FILE_REQUEST_HEADER.version, REQUEST_VERSION_FILES, true);
    view.setUint32(FILE_REQUEST_HEADER.operation, options.operation, true);
    view.setUint32(FILE_REQUEST_HEADER.sourceCount, options.sourceCount, true);
    view.setUint32(FILE_REQUEST_HEADER.afterPage, options.afterPage ?? 0, true);
    view.setUint32(FILE_REQUEST_HEADER.pageCount, pages.length, true);
    let offset = FILE_REQUEST_HEADER.bytes;
    for (const page of pages) {
        view.setUint32(offset, page, true);
        offset += U32_BYTES;
    }
    if (tail.byteLength > 0) {
        buffer.set(tail, offset);
    }
    return buffer;
}

function encodeStandardRequest(options: {
    operation: number;
    insertionData?: Uint8Array;
}): Uint8Array {
    const insertionData = options.insertionData ?? new Uint8Array(0);
    const buffer = new Uint8Array(REQUEST_HEADER.bytes + insertionData.byteLength);
    const view = new DataView(buffer.buffer);
    buffer.set(requestMagicBytes, REQUEST_HEADER.magic);
    view.setUint32(REQUEST_HEADER.version, REQUEST_VERSION, true);
    view.setUint32(REQUEST_HEADER.operation, options.operation, true);
    view.setUint32(REQUEST_HEADER.insertionDataLength, insertionData.byteLength, true);
    if (insertionData.byteLength > 0) {
        buffer.set(insertionData, REQUEST_HEADER.bytes);
    }
    return buffer;
}

function decodeJsonResponse(bytes: Uint8Array): string {
    if (bytes.byteLength < BYTES_HEADER.bytes) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned a truncated JSON response');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = view.getUint32(BYTES_HEADER.kind, true);
    const dataLength = view.getUint32(BYTES_HEADER.dataLength, true);
    if (kind !== RESPONSE_JSON || BYTES_HEADER.bytes + dataLength !== bytes.byteLength) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned an unexpected response kind');
    }
    return textDecoder.decode(bytes.subarray(BYTES_HEADER.bytes, BYTES_HEADER.bytes + dataLength));
}

function decodeWrittenResponse(bytes: Uint8Array): {
    pageCount: number;
    length: number;
    trailing: Uint8Array;
} {
    if (bytes.byteLength < WRITTEN_HEADER.bytes) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned a truncated written response');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = view.getUint32(WRITTEN_HEADER.kind, true);
    if (kind !== RESPONSE_WRITTEN) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned an unexpected written response kind');
    }
    return {
        pageCount: view.getUint32(WRITTEN_HEADER.pageCount, true),
        length: view.getFloat64(WRITTEN_HEADER.length, true),
        trailing: bytes.subarray(WRITTEN_HEADER.bytes),
    };
}

function decodeTextBoxAppearanceResponse(bytes: Uint8Array): {
    pdfBytes: Uint8Array;
    metadataBytes: Uint8Array;
} {
    if (bytes.byteLength < TEXT_BOX_APPEARANCE_HEADER.bytes) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned a truncated text-box appearance response');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.kind, true);
    const dataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.dataLength, true);
    const metadataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.metadataLength, true);
    if (
        kind !== RESPONSE_TEXT_BOX_APPEARANCE
        || TEXT_BOX_APPEARANCE_HEADER.bytes + dataLength + metadataLength !== bytes.byteLength
    ) {
        throw new PdfPageOpsNativeError('invalid-request', 'evb-pdf-page-ops returned an invalid text-box appearance envelope');
    }
    const pdfStart = TEXT_BOX_APPEARANCE_HEADER.bytes;
    const metadataStart = pdfStart + dataLength;
    return {
        pdfBytes: bytes.subarray(pdfStart, metadataStart),
        metadataBytes: bytes.subarray(metadataStart, metadataStart + metadataLength),
    };
}

function readBoundedSidecarBytes(filePath: string, label: string, maxBytes = MAX_SIDECAR_BYTES): Uint8Array {
    let fd: number;
    try {
        fd = openSync(filePath, 'r');
    } catch (error) {
        throw new PdfPageOpsNativeError(
            'invalid-request',
            `Failed to read ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
            throw new PdfPageOpsNativeError('invalid-request', `${label} is not a regular file`);
        }
        if (st.size > maxBytes) {
            throw new PdfPageOpsNativeError('too-large', `${label} exceeds the byte admission ceiling`);
        }
        const expected = st.size;
        const output = new Uint8Array(expected);
        let offset = 0;
        while (offset < expected) {
            const read = readSync(fd, output, offset, expected - offset, offset);
            if (read <= 0) {
                return output.subarray(0, offset);
            }
            offset += read;
        }
        // Guard against concurrent growth beyond maxBytes.
        const probe = new Uint8Array(1);
        const extra = readSync(fd, probe, 0, 1, offset);
        if (extra > 0 && offset >= maxBytes) {
            throw new PdfPageOpsNativeError('too-large', `${label} exceeds the byte admission ceiling`);
        }
        if (extra > 0) {
            const chunks: Uint8Array[] = [
                output,
                probe,
            ];
            let total = offset + 1;
            const scratch = new Uint8Array(64 * 1024);
            while (true) {
                const want = Math.min(scratch.byteLength, maxBytes - total + 1);
                const read = readSync(fd, scratch, 0, want, total);
                if (read <= 0) {
                    break;
                }
                total += read;
                if (total > maxBytes) {
                    throw new PdfPageOpsNativeError('too-large', `${label} exceeds the byte admission ceiling`);
                }
                chunks.push(scratch.slice(0, read));
            }
            const combined = new Uint8Array(total);
            let cursor = 0;
            for (const chunk of chunks) {
                combined.set(chunk, cursor);
                cursor += chunk.byteLength;
            }
            return combined;
        }
        return output;
    } finally {
        try {
            closeSync(fd);
        } catch {
            // Ignore close error on read-only sidecar.
        }
    }
}

function readPagesFile(filePath: string, maxItems: number): number[] {
    const raw = readBoundedSidecarBytes(filePath, 'page selection file');
    const text = textDecoder.decode(raw);
    const pages: number[] = [];
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index]!.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const dashIndex = trimmed.indexOf('-');
        const firstText = dashIndex >= 0 ? trimmed.slice(0, dashIndex).trim() : trimmed;
        const lastText = dashIndex >= 0 ? trimmed.slice(dashIndex + 1).trim() : trimmed;
        if (!/^\d+$/u.test(firstText) || !/^\d+$/u.test(lastText)) {
            throw new PdfPageOpsNativeError('invalid-request', `Invalid page number on line ${index + 1}`);
        }
        const first = Number(firstText);
        const last = Number(lastText);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first <= 0 || last < first || last > 0xffff_ffff) {
            throw new PdfPageOpsNativeError('invalid-request', `Invalid page number on line ${index + 1}`);
        }
        for (let page = first; page <= last; page += 1) {
            if (pages.length >= maxItems) {
                throw new PdfPageOpsNativeError('too-large', `Page selection exceeds the ${maxItems}-item admission ceiling`);
            }
            pages.push(page);
        }
    }
    if (pages.length === 0) {
        throw new PdfPageOpsNativeError('invalid-request', 'At least one page must be selected');
    }
    return pages;
}

function readPasswordFileBytes(filePath: string): Uint8Array {
    const raw = readBoundedSidecarBytes(filePath, 'PDF password', MAX_PASSWORD_FILE_BYTES);
    let text = textDecoder.decode(raw);
    if (text.endsWith('\n')) {
        text = text.slice(0, -1);
        if (text.endsWith('\r')) {
            text = text.slice(0, -1);
        }
    }
    return textEncoder.encode(text);
}

interface IParsedCliArgs {
    command: string;
    inputPath: string;
    outputPath?: string;
    sources: string[];
    afterPage?: number;
    pagesFile?: string;
    mutationsFile?: string;
    identityBindingsFile?: string;
    passwordFile?: string;
    metadataFile?: string;
    instructionsFile?: string;
    modifiedAt?: string;
    pageNumber?: number;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    physical: boolean;
    append: boolean;
    appendInPlace: boolean;
    metadataOnly: boolean;
    withEvbOcrText: boolean;
    viewMode?: string;
    orientation?: string;
}

function parseNonNegativeFloatFlag(flag: string, raw: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new PdfPageOpsNativeError('invalid-request', `Invalid ${flag} value: ${raw}`);
    }
    return value;
}

function parseDesktopPageOpsCliArgs(args: readonly string[]): IParsedCliArgs {
    if (args.length === 0) {
        throw new PdfPageOpsNativeError('invalid-request', 'Missing command');
    }
    const command = args[0]!;
    let inputPath: string | undefined;
    let outputPath: string | undefined;
    const sources: string[] = [];
    let afterPage: number | undefined;
    let pagesFile: string | undefined;
    let mutationsFile: string | undefined;
    let identityBindingsFile: string | undefined;
    let passwordFile: string | undefined;
    let metadataFile: string | undefined;
    let instructionsFile: string | undefined;
    let modifiedAt: string | undefined;
    let pageNumber: number | undefined;
    let top: number | undefined;
    let bottom: number | undefined;
    let left: number | undefined;
    let right: number | undefined;
    let physical = false;
    let append = false;
    let appendInPlace = false;
    let metadataOnly = false;
    let withEvbOcrText = false;
    let viewMode: string | undefined;
    let orientation: string | undefined;

    const nextValue = (flag: string, index: number) => {
        if (index + 1 >= args.length) {
            throw new PdfPageOpsNativeError('invalid-request', `Missing ${flag} value`);
        }
        return args[index + 1]!;
    };

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]!;
        switch (arg) {
            case '--input':
                inputPath = nextValue(arg, i);
                i += 1;
                break;
            case '--output':
                outputPath = nextValue(arg, i);
                i += 1;
                break;
            case '--source':
                sources.push(nextValue(arg, i));
                i += 1;
                break;
            case '--after-page': {
                const raw = nextValue(arg, i);
                const parsedValue = Number(raw);
                if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsedValue) || parsedValue < 0 || parsedValue > MAX_U32) {
                    throw new PdfPageOpsNativeError('invalid-request', `Invalid --after-page value: ${raw}`);
                }
                afterPage = parsedValue;
                i += 1;
                break;
            }
            case '--pages-file':
                pagesFile = nextValue(arg, i);
                i += 1;
                break;
            case '--mutations-file':
                mutationsFile = nextValue(arg, i);
                i += 1;
                break;
            case '--identity-bindings-file':
                identityBindingsFile = nextValue(arg, i);
                i += 1;
                break;
            case '--password-file':
                if (command !== 'decrypt') {
                    throw new PdfPageOpsNativeError('invalid-request', '--password-file is only valid for decrypt');
                }
                passwordFile = nextValue(arg, i);
                i += 1;
                break;
            case '--metadata-file':
                metadataFile = nextValue(arg, i);
                i += 1;
                break;
            case '--instructions-file':
                instructionsFile = nextValue(arg, i);
                i += 1;
                break;
            case '--modified-at':
                modifiedAt = nextValue(arg, i);
                i += 1;
                break;
            case '--page':
            case '--page-number': {
                const raw = nextValue(arg, i);
                const parsedValue = Number(raw);
                if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsedValue) || parsedValue <= 0 || parsedValue > MAX_U32) {
                    throw new PdfPageOpsNativeError('invalid-request', 'Page number must be a positive 32-bit integer');
                }
                pageNumber = parsedValue;
                i += 1;
                break;
            }
            case '--top':
                top = parseNonNegativeFloatFlag(arg, nextValue(arg, i));
                i += 1;
                break;
            case '--bottom':
                bottom = parseNonNegativeFloatFlag(arg, nextValue(arg, i));
                i += 1;
                break;
            case '--left':
                left = parseNonNegativeFloatFlag(arg, nextValue(arg, i));
                i += 1;
                break;
            case '--right':
                right = parseNonNegativeFloatFlag(arg, nextValue(arg, i));
                i += 1;
                break;
            case '--physical':
                physical = true;
                break;
            case '--annotation-ownership-cache':
                if (command !== 'save-mutations') {
                    throw new PdfPageOpsNativeError('invalid-request', `Unknown argument: ${arg}`);
                }
                nextValue(arg, i);
                i += 1;
                break;
            case '--qpdf':
            case '--qpdf-path':
                // Accepted for CLI compatibility; WASM does not invoke native qpdf.
                nextValue(arg, i);
                i += 1;
                break;
            case '--with-evb-ocr-text':
                withEvbOcrText = true;
                break;
            case '--append':
                append = true;
                break;
            case '--append-in-place':
                appendInPlace = true;
                break;
            case '--metadata-only':
                metadataOnly = true;
                break;
            case '--view-mode':
                viewMode = nextValue(arg, i);
                i += 1;
                break;
            case '--orientation':
                orientation = nextValue(arg, i);
                i += 1;
                break;
            default:
                throw new PdfPageOpsNativeError('invalid-request', `Unknown argument: ${arg}`);
        }
    }

    if (metadataOnly && command !== 'page-sizes') {
        throw new PdfPageOpsNativeError('invalid-request', '--metadata-only is only valid for page-sizes');
    }
    if (appendInPlace && (!append || command !== 'save-mutations')) {
        throw new PdfPageOpsNativeError('invalid-request', '--append-in-place requires --append on save-mutations');
    }
    if (sources.length > 1 && command !== 'merge-pages') {
        throw new PdfPageOpsNativeError('invalid-request', '--source is repeatable only for merge-pages');
    }
    if (identityBindingsFile !== undefined && command !== 'save-mutations') {
        throw new PdfPageOpsNativeError('invalid-request', '--identity-bindings-file is only valid for save-mutations');
    }
    if (!inputPath) {
        throw new PdfPageOpsNativeError('invalid-request', 'Missing --input value');
    }

    return {
        command,
        inputPath,
        ...(outputPath === undefined ? {} : {outputPath}),
        sources,
        ...(afterPage === undefined ? {} : {afterPage}),
        ...(pagesFile === undefined ? {} : {pagesFile}),
        ...(mutationsFile === undefined ? {} : {mutationsFile}),
        ...(identityBindingsFile === undefined ? {} : {identityBindingsFile}),
        ...(passwordFile === undefined ? {} : {passwordFile}),
        ...(metadataFile === undefined ? {} : {metadataFile}),
        ...(instructionsFile === undefined ? {} : {instructionsFile}),
        ...(modifiedAt === undefined ? {} : {modifiedAt}),
        ...(pageNumber === undefined ? {} : {pageNumber}),
        ...(top === undefined ? {} : {top}),
        ...(bottom === undefined ? {} : {bottom}),
        ...(left === undefined ? {} : {left}),
        ...(right === undefined ? {} : {right}),
        physical,
        append,
        appendInPlace,
        metadataOnly,
        withEvbOcrText,
        ...(viewMode === undefined ? {} : {viewMode}),
        ...(orientation === undefined ? {} : {orientation}),
    };
}

function requireOutputPath(parsed: IParsedCliArgs): string {
    if (!parsed.outputPath) {
        throw new PdfPageOpsNativeError('invalid-request', 'Missing --output value');
    }
    return parsed.outputPath;
}

function requireFlag(value: string | undefined, flag: string): string {
    if (value === undefined) {
        throw new PdfPageOpsNativeError('invalid-request', `Missing ${flag} value`);
    }
    return value;
}

function withHostFiles<T>(options: {
    sourcePaths: readonly string[];
    outputPath?: string;
    stagedOutputPath?: string;
    inPlace?: boolean;
    lazyAppendBase?: boolean;
    forbidOutputAliasingInput?: boolean;
    verifyWitness?: boolean;
}, work: (io: IHostIoContext) => {
    result: T;
    commitOutput: boolean;
}): T {
    const sources: IHostSourceEntry[] = [];
    const extraOpenOrder: number[] = [];
    let sink: IHostSinkState | null = null;
    let committed = false;
    try {
        if (options.forbidOutputAliasingInput && options.outputPath !== undefined && options.sourcePaths[0]) {
            if (sameFileSync(options.sourcePaths[0], options.outputPath)) {
                throw new PdfPageOpsNativeError(
                    'invalid-request',
                    'Output path must not overwrite the input PDF',
                );
            }
        }
        const source0Path = options.sourcePaths[0];
        const source0Witness = options.verifyWitness && source0Path
            ? captureFileWitness(source0Path)
            : null;
        const outputWitness = options.verifyWitness
            && options.outputPath !== undefined
            && !options.inPlace
            && (!source0Path || !sameFileSync(source0Path, options.outputPath))
            ? captureFileWitness(options.outputPath)
            : null;

        for (let i = 0; i < options.sourcePaths.length; i += 1) {
            const sourcePath = options.sourcePaths[i]!;
            if (i === 0) {
                let fd: number;
                try {
                    fd = openSync(sourcePath, 'r');
                } catch (error) {
                    throw new PdfPageOpsNativeError(
                        'io',
                        `Failed to open PDF source "${sourcePath}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
                try {
                    const st = fstatSync(fd);
                    if (!st.isFile()) {
                        throw new PdfPageOpsNativeError('invalid-request', `PDF source is not a regular file: ${sourcePath}`);
                    }
                    sources.push({
                        fd,
                        len: st.size,
                        path: sourcePath,
                    });
                } catch (error) {
                    if (!sources.some(entry => entry.fd === fd)) {
                        try {
                            closeSync(fd);
                        } catch {
                            // Ignore close error on failed stat.
                        }
                    }
                    throw error;
                }
            } else {
                // Extra sources (e.g. hundreds of OCR page PDFs or placed image
                // sidecars) open lazily through the bounded LRU cache so FD usage
                // stays O(1) regardless of page count.
                sources.push({
                    fd: null,
                    len: null,
                    path: sourcePath,
                });
            }
        }

        if (options.outputPath !== undefined) {
            const inPlace = options.inPlace === true;
            const targetPath = inPlace
                ? options.outputPath
                : (options.stagedOutputPath ?? createTempSiblingPath(options.outputPath));
            const source0Len = sources[0]?.len ?? 0;
            sink = {
                fd: inPlace ? openSync(targetPath, 'r+') : null,
                path: targetPath,
                inPlace,
                originalLen: inPlace ? source0Len : 0,
                baseSourceLen: options.lazyAppendBase ? source0Len : 0,
                baseCopied: inPlace,
                writtenAny: false,
                maxLen: inPlace ? source0Len : 0,
            };
        }

        const io: IHostIoContext = {
            sources,
            extraOpenOrder,
            sink,
            memory: null,
        };
        const {
            result,
            commitOutput,
        } = work(io);

        if (sink && sink.fd !== null) {
            if (commitOutput && sink.writtenAny) {
                fsyncSync(sink.fd);
            } else if (sink.inPlace) {
                ftruncateSync(sink.fd, sink.originalLen);
            }
            closeSync(sink.fd);
            sink.fd = null;
        }

        // Close all open source descriptors BEFORE renaming so Windows permits
        // replacing an output path that aliases one of the inputs.
        for (const entry of sources.splice(0)) {
            if (entry.fd !== null) {
                closeSync(entry.fd);
            }
        }
        extraOpenOrder.length = 0;

        if (sink && !sink.inPlace) {
            if (commitOutput && sink.writtenAny && options.outputPath !== undefined) {
                if (source0Witness && source0Path) {
                    assertFileWitnessUnchanged(source0Path, source0Witness, 'Input PDF');
                }
                if (outputWitness) {
                    assertFileWitnessUnchanged(options.outputPath, outputWitness, 'Output PDF');
                }
                renameWithRetrySync(sink.path, options.outputPath);
                committed = true;
            } else {
                try {
                    unlinkSync(sink.path);
                } catch {
                    // Temp file may never have been created if nothing was written.
                }
            }
        } else {
            committed = true;
        }
        return result;
    } catch (error) {
        if (sink && sink.fd !== null) {
            if (sink.inPlace) {
                try {
                    ftruncateSync(sink.fd, sink.originalLen);
                } catch {
                    // Best-effort rollback of in-place append.
                }
            }
            try {
                closeSync(sink.fd);
            } catch {
                // Ignore close error during rollback.
            }
            sink.fd = null;
        }
        for (const entry of sources.splice(0)) {
            if (entry.fd !== null) {
                try {
                    closeSync(entry.fd);
                } catch {
                    // Ignore close error during rollback.
                }
            }
        }
        extraOpenOrder.length = 0;
        if (sink && !sink.inPlace && !committed) {
            try {
                unlinkSync(sink.path);
            } catch {
                // Ignore unlink error if temp file was never opened.
            }
        }
        throw error;
    }
}

function buildSaveMutationsPayloadBytes(
    mutationsFilePath: string,
    modifiedAt: string,
    firstImageSourceIndex: number,
): {
    payloadBytes: Uint8Array;
    placedImageSources: string[];
} {
    const raw = readBoundedSidecarBytes(mutationsFilePath, 'native mutations');
    let parsed: unknown;
    try {
        parsed = JSON.parse(textDecoder.decode(raw));
    } catch (error) {
        throw new PdfPageOpsNativeError(
            'invalid-request',
            `Invalid native mutations JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PdfPageOpsNativeError('invalid-request', 'Native mutations payload must be a JSON object');
    }
    const payload = {...(parsed as Record<string, unknown>)};
    const placedImageSources: string[] = [];
    if (Array.isArray(payload.placedImages)) {
        payload.placedImages = payload.placedImages.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return entry;
            }
            const record = {...(entry as Record<string, unknown>)};
            if (typeof record.bytesPath === 'string' && record.bytesPath.length > 0 && record.bytesBase64 === undefined) {
                // Pass placed-image sidecars as out-of-band host sources so raw
                // bytes bypass base64 inflation and the 256 MiB JSON ceiling;
                // Rust checks per-image and aggregate limits before reading.
                const sourceIndex = firstImageSourceIndex + placedImageSources.length;
                placedImageSources.push(record.bytesPath);
                record.bytesSourceIndex = sourceIndex;
                delete record.bytesPath;
            }
            return record;
        });
    }
    payload.modifiedAt = modifiedAt;
    return {
        payloadBytes: textEncoder.encode(JSON.stringify(payload)),
        placedImageSources,
    };
}

function rewriteIndexedSourceInstructions(
    instructionsFilePath: string,
    label: string,
    pagePathField: 'source' | 'replacement',
): {
    extraSources: string[];
    payloadBytes: Uint8Array;
} {
    const raw = readBoundedSidecarBytes(instructionsFilePath, label);
    let parsed: unknown;
    try {
        parsed = JSON.parse(textDecoder.decode(raw));
    } catch (error) {
        throw new PdfPageOpsNativeError(
            'invalid-request',
            `Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PdfPageOpsNativeError('invalid-request', `${label} must be a JSON object`);
    }
    const obj = {...(parsed as Record<string, unknown>)};
    const extraSources: string[] = [];
    const pathToIndex = new Map<string, number>();
    if (Array.isArray(obj.pages)) {
        obj.pages = obj.pages.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return entry;
            }
            const record = {...(entry as Record<string, unknown>)};
            const filePath = record[pagePathField];
            if (typeof filePath === 'string') {
                let index = pathToIndex.get(filePath);
                if (index === undefined) {
                    index = extraSources.length;
                    pathToIndex.set(filePath, index);
                    extraSources.push(filePath);
                }
                record[pagePathField] = index;
            }
            return record;
        });
    }
    return {
        extraSources,
        payloadBytes: textEncoder.encode(JSON.stringify(obj)),
    };
}

function okResult(stdout = ''): IPageOpsProcessResult {
    return {
        stdout,
        stderr: '',
        exitCode: 0,
    };
}

export interface IExecuteDesktopPageOpsOptions {
    stagedOutputPath?: string;
}

/**
 * Executes one `evb-pdf-page-ops` CLI invocation directly against the compiled
 * WASM module using host-file streaming.
 */
export function executeDesktopPageOpsCommand(
    runner: IPdfPageOpsWasmRunner,
    args: readonly string[],
    hostOptions: IExecuteDesktopPageOpsOptions = {},
): IPageOpsProcessResult {
    try {
        const parsed = parseDesktopPageOpsCliArgs(args);
        const stagedOutputPath = hostOptions.stagedOutputPath;
        switch (parsed.command) {
            case 'delete-pages':
            case 'extract-pages':
            case 'reorder-pages':
            case 'insert-pages':
            case 'merge-pages': {
                const outputPath = requireOutputPath(parsed);
                const pages = parsed.command === 'delete-pages'
                    || parsed.command === 'extract-pages'
                    || parsed.command === 'reorder-pages'
                    ? readPagesFile(requireFlag(parsed.pagesFile, '--pages-file'), MAX_PATH_INPUT_PDF_PAGES)
                    : [];
                const afterPage = parsed.command === 'insert-pages'
                    ? (() => {
                        if (parsed.afterPage === undefined) {
                            throw new PdfPageOpsNativeError('invalid-request', 'Missing --after-page value');
                        }
                        return parsed.afterPage;
                    })()
                    : 0;
                const operation = parsed.command === 'delete-pages' ? OPERATION_CODES.deletePages
                    : parsed.command === 'extract-pages' ? OPERATION_CODES.extractPages
                        : parsed.command === 'reorder-pages' ? OPERATION_CODES.reorderPages
                            : parsed.command === 'insert-pages' ? OPERATION_CODES.insertPages
                                : OPERATION_CODES.mergePages;
                const sourcePaths = [
                    parsed.inputPath,
                    ...parsed.sources,
                ];
                return withHostFiles({
                    sourcePaths,
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                }, io => {
                    const editRequest = encodeFileRequest({
                        operation,
                        sourceCount: sourcePaths.length,
                        afterPage,
                        pages,
                    });
                    decodeWrittenResponse(runner.runFileRequest(editRequest, io));
                    // Verify the staged output immediately on the same WASM instance.
                    const verifyRequest = encodeFileRequest({
                        operation: OPERATION_CODES.verifyWritten,
                        sourceCount: 0,
                    });
                    decodeWrittenResponse(runner.runFileRequest(verifyRequest, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'save-mutations': {
                const outputPath = requireOutputPath(parsed);
                if (parsed.appendInPlace && parsed.inputPath !== outputPath) {
                    throw new PdfPageOpsNativeError(
                        'invalid-request',
                        'In-place native mutation append requires identical input and output paths',
                    );
                }
                const mutationsFile = requireFlag(parsed.mutationsFile, '--mutations-file');
                const modifiedAt = requireFlag(parsed.modifiedAt, '--modified-at');
                const hasAppearanceSource = parsed.sources.length > 0;
                const firstImageSourceIndex = hasAppearanceSource ? 2 : 1;
                const {
                    payloadBytes: tail,
                    placedImageSources,
                } = buildSaveMutationsPayloadBytes(mutationsFile, modifiedAt, firstImageSourceIndex);
                const sourcePaths = [
                    parsed.inputPath,
                    ...parsed.sources,
                    ...placedImageSources,
                ];
                const inPlace = parsed.appendInPlace;
                const reportText = withHostFiles({
                    sourcePaths,
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    inPlace,
                    lazyAppendBase: !inPlace,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.saveMutationsReported,
                        sourceCount: sourcePaths.length,
                        afterPage: hasAppearanceSource ? 1 : 0,
                        tail,
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: textDecoder.decode(written.trailing),
                        commitOutput: true,
                    };
                });
                if (parsed.identityBindingsFile !== undefined) {
                    atomicWriteFileSync(parsed.identityBindingsFile, reportText);
                }
                return okResult();
            }

            case 'parse-annotations': {
                const outputPath = requireOutputPath(parsed);
                const modifiedAt = requireFlag(parsed.modifiedAt, '--modified-at');
                const pages = parsed.pagesFile === undefined
                    ? []
                    : readPagesFile(parsed.pagesFile, MAX_COLLECTION_ITEMS);
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    forbidOutputAliasingInput: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.parseAnnotationsToSink,
                        sourceCount: 1,
                        pages,
                        tail: textEncoder.encode(modifiedAt),
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'annotation-index':
            case 'annotation-name-index': {
                const outputPath = requireOutputPath(parsed);
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    forbidOutputAliasingInput: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.annotationNameIndex,
                        sourceCount: 1,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'embedded-shape-index':
            case 'shape-index': {
                const outputPath = requireOutputPath(parsed);
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    forbidOutputAliasingInput: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.embeddedShapeIndex,
                        sourceCount: 1,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'page-sizes': {
                const outputPath = requireOutputPath(parsed);
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    forbidOutputAliasingInput: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.readPageSizesSidecar,
                        sourceCount: 1,
                        afterPage: parsed.metadataOnly ? 1 : 0,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'crop': {
                const outputPath = requireOutputPath(parsed);
                const pages = readPagesFile(requireFlag(parsed.pagesFile, '--pages-file'), MAX_PATH_INPUT_PDF_PAGES);
                if (
                    parsed.top === undefined
                    || parsed.bottom === undefined
                    || parsed.left === undefined
                    || parsed.right === undefined
                ) {
                    throw new PdfPageOpsNativeError('invalid-request', 'crop requires --top, --bottom, --left, and --right');
                }
                const tail = textEncoder.encode(JSON.stringify({
                    top: parsed.top,
                    bottom: parsed.bottom,
                    left: parsed.left,
                    right: parsed.right,
                }));
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.cropFile,
                        sourceCount: 1,
                        afterPage: parsed.physical ? 1 : 0,
                        pages,
                        tail,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'remove-crop': {
                const outputPath = requireOutputPath(parsed);
                const pages = readPagesFile(requireFlag(parsed.pagesFile, '--pages-file'), MAX_PATH_INPUT_PDF_PAGES);
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.removeCropFile,
                        sourceCount: 1,
                        pages,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'page-geometry':
            case 'get-page-geometry': {
                if (parsed.outputPath !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', `${parsed.command} prints its result on stdout and takes no --output`);
                }
                if (parsed.pageNumber === undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', 'Missing --page value');
                }
                return withHostFiles({sourcePaths: [parsed.inputPath]}, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.getPageGeometry,
                        sourceCount: 1,
                        pages: [parsed.pageNumber!],
                    });
                    return {
                        result: okResult(decodeJsonResponse(runner.runFileRequest(request, io))),
                        commitOutput: false,
                    };
                });
            }

            case 'read-document-catalog': {
                if (parsed.outputPath !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', 'read-document-catalog prints its result on stdout and takes no --output');
                }
                const tail = parsed.mutationsFile === undefined
                    ? undefined
                    : readBoundedSidecarBytes(parsed.mutationsFile, 'native mutations');
                return withHostFiles({sourcePaths: [parsed.inputPath]}, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.readCatalog,
                        sourceCount: 1,
                        ...(tail === undefined ? {} : {tail}),
                    });
                    return {
                        result: okResult(decodeJsonResponse(runner.runFileRequest(request, io))),
                        commitOutput: false,
                    };
                });
            }

            case 'pdf-conformance':
            case 'conformance': {
                if (parsed.outputPath !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', `${parsed.command} prints its result on stdout and takes no --output`);
                }
                return withHostFiles({sourcePaths: [parsed.inputPath]}, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.conformance,
                        sourceCount: 1,
                    });
                    return {
                        result: okResult(decodeJsonResponse(runner.runFileRequest(request, io))),
                        commitOutput: false,
                    };
                });
            }

            case 'append-admission': {
                if (parsed.outputPath !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', 'append-admission prints its result on stdout and takes no --output');
                }
                return withHostFiles({sourcePaths: [parsed.inputPath]}, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.appendAdmission,
                        sourceCount: 1,
                        // `afterPage: 1` selects desktop append-admission policy (with `reason`).
                        afterPage: 1,
                    });
                    return {
                        result: okResult(decodeJsonResponse(runner.runFileRequest(request, io))),
                        commitOutput: false,
                    };
                });
            }

            case 'decrypt': {
                const outputPath = requireOutputPath(parsed);
                const tail = parsed.passwordFile === undefined
                    ? undefined
                    : readPasswordFileBytes(parsed.passwordFile);
                const {
                    reportJson,
                    rewritten,
                } = withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.decryptFile,
                        sourceCount: 1,
                        ...(tail === undefined ? {} : {tail}),
                    });
                    const json = decodeJsonResponse(runner.runFileRequest(request, io));
                    const parsedReport = JSON.parse(json) as {outcome?: unknown};
                    const isRewritten = parsedReport.outcome === 'rewritten';
                    return {
                        result: {
                            reportJson: json,
                            rewritten: isRewritten,
                        },
                        commitOutput: isRewritten,
                    };
                });
                try {
                    atomicWriteFileSync(`${outputPath}.decrypt.json`, reportJson);
                } catch (error) {
                    // The plaintext PDF and its receipt form one result; do not leave a
                    // published plaintext working copy behind when writing its receipt fails.
                    if (rewritten) {
                        try {
                            unlinkSync(outputPath);
                        } catch {
                            // Best-effort cleanup of orphaned plaintext output.
                        }
                    }
                    throw error;
                }
                return okResult();
            }

            case 'ocr-text-visibility': {
                if (parsed.outputPath !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', 'ocr-text-visibility prints its result on stdout and takes no --output');
                }
                const pages = readPagesFile(requireFlag(parsed.pagesFile, '--pages-file'), MAX_COLLECTION_ITEMS);
                return withHostFiles({sourcePaths: [parsed.inputPath]}, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.ocrTextVisibility,
                        sourceCount: 1,
                        pages,
                        ...(parsed.withEvbOcrText ? {tail: textEncoder.encode('with-evb-ocr-text')} : {}),
                    });
                    return {
                        result: okResult(decodeJsonResponse(runner.runFileRequest(request, io))),
                        commitOutput: false,
                    };
                });
            }

            case 'ocr-text-layer': {
                const outputPath = requireOutputPath(parsed);
                const instructionsFile = requireFlag(parsed.instructionsFile, '--instructions-file');
                const {
                    extraSources,
                    payloadBytes,
                } = rewriteIndexedSourceInstructions(instructionsFile, 'ocr-text-layer instructions', 'source');
                const sourcePaths = [
                    parsed.inputPath,
                    ...extraSources,
                ];
                return withHostFiles({
                    sourcePaths,
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.ocrTextLayer,
                        sourceCount: sourcePaths.length,
                        // `afterPage: 1` selects desktop 64-page batched streaming onto HostSink.
                        afterPage: 1,
                        tail: payloadBytes,
                    });
                    decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: true,
                    };
                });
            }

            case 'recompress-images': {
                const outputPath = requireOutputPath(parsed);
                const instructionsFile = requireFlag(parsed.instructionsFile, '--instructions-file');
                const tail = readBoundedSidecarBytes(instructionsFile, 'recompress-images instructions');
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.recompressImagesFile,
                        sourceCount: 1,
                        tail,
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(textDecoder.decode(written.trailing)),
                        commitOutput: io.sink?.writtenAny === true,
                    };
                });
            }

            case 'replace-page-images': {
                const outputPath = requireOutputPath(parsed);
                const instructionsFile = requireFlag(parsed.instructionsFile, '--instructions-file');
                const {
                    extraSources,
                    payloadBytes,
                } = rewriteIndexedSourceInstructions(instructionsFile, 'replace-page-images instructions', 'replacement');
                const sourcePaths = [
                    parsed.inputPath,
                    ...extraSources,
                ];
                return withHostFiles({
                    sourcePaths,
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.replacePageImagesFile,
                        sourceCount: sourcePaths.length,
                        tail: payloadBytes,
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(textDecoder.decode(written.trailing)),
                        commitOutput: io.sink?.writtenAny === true,
                    };
                });
            }

            case 'split-pages': {
                const outputPath = requireOutputPath(parsed);
                const instructionsFile = requireFlag(parsed.instructionsFile, '--instructions-file');
                const tail = readBoundedSidecarBytes(instructionsFile, 'split-pages instructions');
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.splitPagesFile,
                        sourceCount: 1,
                        tail,
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(textDecoder.decode(written.trailing)),
                        commitOutput: true,
                    };
                });
            }

            case 'overlay-text': {
                const outputPath = requireOutputPath(parsed);
                const instructionsFile = requireFlag(parsed.instructionsFile, '--instructions-file');
                const sourcePath = parsed.sources[0];
                if (!sourcePath) {
                    throw new PdfPageOpsNativeError('invalid-request', 'Missing --source value');
                }
                const tail = readBoundedSidecarBytes(instructionsFile, 'overlay-text instructions');
                return withHostFiles({
                    sourcePaths: [
                        parsed.inputPath,
                        sourcePath,
                    ],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                    verifyWitness: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.overlayTextFile,
                        sourceCount: 2,
                        tail,
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(textDecoder.decode(written.trailing)),
                        commitOutput: true,
                    };
                });
            }

            case 'print-layout': {
                const outputPath = requireOutputPath(parsed);
                if (parsed.pagesFile !== undefined) {
                    throw new PdfPageOpsNativeError('invalid-request', '--pages-file is not valid for print-layout');
                }
                const viewMode = requireFlag(parsed.viewMode, '--view-mode');
                const orientation = requireFlag(parsed.orientation, '--orientation');
                return withHostFiles({
                    sourcePaths: [parsed.inputPath],
                    outputPath,
                    ...(stagedOutputPath === undefined ? {} : {stagedOutputPath}),
                    lazyAppendBase: true,
                }, io => {
                    const request = encodeFileRequest({
                        operation: OPERATION_CODES.printLayoutFile,
                        sourceCount: 1,
                        tail: textEncoder.encode(`${viewMode} ${orientation}`),
                    });
                    const written = decodeWrittenResponse(runner.runFileRequest(request, io));
                    return {
                        result: okResult(),
                        commitOutput: written.length > 0 && io.sink?.writtenAny === true,
                    };
                });
            }

            case 'text-box-appearance': {
                const outputPath = requireOutputPath(parsed);
                const metadataFile = requireFlag(parsed.metadataFile, '--metadata-file');
                const requestBytes = readBoundedSidecarBytes(parsed.inputPath, 'text box appearance request');
                const encoded = encodeStandardRequest({
                    operation: OPERATION_CODES.textBoxAppearance,
                    insertionData: requestBytes,
                });
                const {
                    pdfBytes,
                    metadataBytes,
                } = decodeTextBoxAppearanceResponse(runner.runRawRequest(encoded));
                atomicWriteFileSync(metadataFile, metadataBytes);
                atomicWriteFileSync(outputPath, pdfBytes);
                return okResult();
            }

            default:
                throw new PdfPageOpsNativeError('invalid-request', `Unknown command: ${parsed.command}`);
        }
    } finally {
        runner.maybeRecycle();
    }
}

const cachedModules = new Map<string, Promise<WebAssembly.Module>>();

export function resolvePdfPageOpsWasmPath(options: {
    currentDir?: string;
    envOverridePath?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
} = {}): string | null {
    const override = options.envOverridePath?.trim();
    if (override) {
        const resolved = resolve(override);
        if (existsSync(resolved)) {
            return resolved;
        }
    }
    const currentDir = options.currentDir ?? __dirname;
    const isPackaged = options.isPackaged ?? currentDir.includes('app.asar');
    if (isPackaged) {
        const resourcesPath = options.resourcesPath
            ?? (process as NodeJS.Process & {resourcesPath?: string}).resourcesPath;
        const candidates = [
            ...(resourcesPath
                ? [
                    join(resourcesPath, 'app.asar.unpacked', 'nuxt-output', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
                    join(resourcesPath, 'app.asar', 'nuxt-output', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
                ]
                : []),
            join(currentDir, '..', 'nuxt-output', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
        ];
        return candidates.find(candidate => existsSync(candidate)) ?? null;
    }
    const candidates = [
        join(currentDir, '..', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
        join(currentDir, '..', '..', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
        join(currentDir, '..', '..', '..', 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
        join(process.cwd(), 'public', 'wasm', PDF_PAGE_OPS_WASM_FILE_NAME),
    ];
    return candidates.find(candidate => existsSync(candidate)) ?? null;
}

export function loadPdfPageOpsWasmModule(wasmPath?: string): Promise<WebAssembly.Module> {
    const resolvedPath = wasmPath ?? resolvePdfPageOpsWasmPath();
    if (!resolvedPath) {
        return Promise.reject(
            new PdfPageOpsNativeError('native-failure', `${PDF_PAGE_OPS_WASM_FILE_NAME} was not found`),
        );
    }
    const existing = cachedModules.get(resolvedPath);
    if (existing) {
        return existing;
    }
    const pending = readFile(resolvedPath)
        .then(bytes => WebAssembly.compile(bytes))
        .catch((error: unknown) => {
            if (cachedModules.get(resolvedPath) === pending) {
                cachedModules.delete(resolvedPath);
            }
            throw error;
        });
    cachedModules.set(resolvedPath, pending);
    return pending;
}
