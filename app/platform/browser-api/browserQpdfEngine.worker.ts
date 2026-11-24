/// <reference lib="webworker" />

import {
    BROWSER_APPEND_ADMISSION_VERDICTS,
    BROWSER_QPDF_ENGINE_ERROR_CODES,
    BROWSER_QPDF_ENGINE_REVISION,
    BROWSER_QPDF_MAX_DIAGNOSTIC_CHARACTERS,
    BROWSER_QPDF_MAX_INPUT_BYTES,
    parseBrowserQpdfEngineRequest,
    type IBrowserQpdfNormalizeResult,
    type IBrowserQpdfRunResult,
    type TBrowserQpdfCommand,
} from '@contracts/browserQpdfEngine';
import {
    getBrowserPageOpsWorkerRequestId,
    isBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {
    BYTES_HEADER,
    OPERATION_CODES,
    RESPONSE_JSON,
} from '@contracts/browserPageOpsWasm.generated';
import {WASM_REQUEST_ALLOCATION_ABI_VERSION} from '@contracts/getCheckedWasmMemoryView';
import {
    blobSource,
    createPageOpsHostImports,
    runFileRequest,
    withOpenFiles,
    type IPdfPageOpsWasmExports,
} from '@app/platform/browser/pdfPageEngine';
import {
    getQpdfCheckArgs,
    getQpdfLosslessRewriteArgs,
    getQpdfPageCountArgs,
    getQpdfRewriteArgs,
    isQpdfSuccessExitCode,
} from '@pdf-core/qpdfCommands';
import {getErrorMessage} from '@app/utils/error';

declare const self: DedicatedWorkerGlobalScope;

/** The part of the Emscripten module a command uses (`scripts/build-qpdf-wasm.sh`). */
interface IQpdfFsNode {
    id: number;
    mode: number;
    node_ops: object;
    stream_ops: object;
}

interface IQpdfFileStream {
    path: string;
    position: number;
}

interface IQpdfModule {
    callMain(args: string[]): number;
    FS: {
        mkdirTree(path: string): void;
        writeFile(path: string, data: Uint8Array, options?: {canOwn: boolean}): void;
        readFile(path: string): Uint8Array;
        write(stream: IQpdfFileStream, buffer: Uint8Array, offset: number, length: number, position?: number, canOwn?: boolean): number;
        symlink(target: string, path: string): void;
        createNode(parent: IQpdfFsNode | null, name: string, mode: number, rdev: number): IQpdfFsNode;
        mount(type: {mount(): IQpdfFsNode}, options: object, mountpoint: string): void;
        unmount(mountpoint: string): void;
        ErrnoError: new (errno: number) => Error;
    };
}

/** An output larger than the engine accepts as input; it could not be opened or edited next. */
class OutputBudgetError extends Error {}

type TQpdfModuleFactory = (options: {
    instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
    thisProgram: string;
    print: (line: string) => void;
    printErr: (line: string) => void;
}) => Promise<IQpdfModule>;

interface IAppendAdmissionExports {
    memory: WebAssembly.Memory;
    evb_pdf_page_ops_alloc(len: number): number;
    evb_pdf_page_ops_free(pointer: number, len: number): void;
    evb_pdf_page_ops_append_admission(pointer: number, len: number): number;
}

function hasAppendAdmissionExports(exports: WebAssembly.Exports): exports is WebAssembly.Exports & IAppendAdmissionExports {
    return exports.memory instanceof WebAssembly.Memory
        && typeof exports.evb_pdf_page_ops_alloc === 'function'
        && typeof exports.evb_pdf_page_ops_free === 'function'
        && typeof exports.evb_pdf_page_ops_append_admission === 'function';
}

function hasPageOpsRunExports(exports: WebAssembly.Exports): exports is WebAssembly.Exports & IPdfPageOpsWasmExports {
    return exports.memory instanceof WebAssembly.Memory
        && typeof exports.evb_wasm_request_allocation_abi_version === 'function'
        && exports.evb_wasm_request_allocation_abi_version() === WASM_REQUEST_ALLOCATION_ABI_VERSION
        && typeof exports.evb_pdf_page_ops_alloc === 'function'
        && typeof exports.evb_pdf_page_ops_free === 'function'
        && typeof exports.evb_pdf_page_ops_run === 'function'
        && typeof exports.evb_pdf_page_ops_output_ptr === 'function'
        && typeof exports.evb_pdf_page_ops_output_len === 'function'
        && typeof exports.evb_pdf_page_ops_error_ptr === 'function'
        && typeof exports.evb_pdf_page_ops_error_len === 'function';
}

const INPUT_PATH = '/work/input.pdf';
const OUTPUT_PATH = '/work/output.pdf';
// A Blob input is mounted read-only here, and `INPUT_PATH` links to it, so commands and their messages name one path.
const BLOB_MOUNT = '/blob';
const BLOB_NAME = 'input.pdf';
// qpdf seeks back to objects it has passed: a few cached blocks keep a rewrite to about two reads of its input.
const BLOB_BLOCK_BYTES = 256 * 1024;
const BLOB_CACHED_BLOCKS = 8;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const ERRNO_EPERM = 63;
const ERRNO_ENOENT = 44;
const ERRNO_EINVAL = 28;

const COMMAND_ARGS: Record<TBrowserQpdfCommand, () => string[]> = {
    'check': () => getQpdfCheckArgs(INPUT_PATH),
    'page-count': () => getQpdfPageCountArgs(INPUT_PATH),
    'rewrite': () => getQpdfRewriteArgs(INPUT_PATH, OUTPUT_PATH),
    'lossless-rewrite': () => getQpdfLosslessRewriteArgs(INPUT_PATH, OUTPUT_PATH),
};
const WRITING_COMMANDS: ReadonlySet<TBrowserQpdfCommand> = new Set([
    'rewrite',
    'lossless-rewrite',
]);

class EngineUnavailableError extends Error {}
class RewriteFailedError extends Error {}

function cached<T>(load: () => Promise<T>) {
    let pending: Promise<T> | null = null;
    return () => {
        pending ??= load().catch((error: unknown) => {
            // A failed download must not disable the engine for this worker's life.
            pending = null;
            throw new EngineUnavailableError(getErrorMessage(error));
        });
        return pending;
    };
}

const loadQpdf = cached(async () => {
    const [
        imported,
        module,
    ] = await Promise.all([
        import(/* @vite-ignore */ new URL('/wasm/evb-qpdf.mjs', self.location.href).href) as Promise<{default: TQpdfModuleFactory}>,
        WebAssembly.compileStreaming(fetch(new URL(`/wasm/evb-qpdf.wasm?revision=${BROWSER_QPDF_ENGINE_REVISION}`, self.location.href))),
    ]);
    return {
        factory: imported.default,
        module,
    };
});

const loadAppendAdmission = cached(() =>
    WebAssembly.compileStreaming(fetch(new URL('/wasm/evb-pdf-page-ops.wasm', self.location.href))));

function appendBounded(text: string, line: string) {
    return text.length < BROWSER_QPDF_MAX_DIAGNOSTIC_CHARACTERS
        ? `${text}${line}\n`.slice(0, BROWSER_QPDF_MAX_DIAGNOSTIC_CHARACTERS)
        : text;
}

/**
 * Mounts `blob` read-only at `BLOB_MOUNT` as `BLOB_NAME`. This build has no `WORKERFS`, so the mount is the same
 * idea in a few node and stream operations: reads are synchronous `FileReaderSync` slices of the Blob, through a
 * small block cache, and nothing writes. The Blob's bytes never enter the file system's memory as a whole.
 */
function mountBlob(fs: IQpdfModule['FS'], blob: Blob) {
    const reader = new FileReaderSync();
    const blocks = new Map<number, Uint8Array>();
    const block = (index: number) => {
        let bytes = blocks.get(index);
        if (bytes) {
            blocks.delete(index);
        } else {
            bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(index * BLOB_BLOCK_BYTES, (index + 1) * BLOB_BLOCK_BYTES)));
            if (blocks.size >= BLOB_CACHED_BLOCKS) blocks.delete(blocks.keys().next().value!);
        }
        blocks.set(index, bytes);
        return bytes;
    };
    const refuse = (errno: number) => () => {
        throw new fs.ErrnoError(errno);
    };
    const nodes = new Map<string, IQpdfFsNode>();
    const node_ops = {
        getattr(node: IQpdfFsNode) {
            const size = node.mode & S_IFREG ? blob.size : 4096;
            const time = blob instanceof File ? blob.lastModified : 0;
            return {
                dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size,
                atime: new Date(time), mtime: new Date(time), ctime: new Date(time), atimeMs: time, mtimeMs: time, ctimeMs: time,
                blksize: 4096, blocks: Math.ceil(size / 4096),
            };
        },
        setattr: refuse(ERRNO_EPERM),
        lookup: refuse(ERRNO_ENOENT),
        mknod: refuse(ERRNO_EPERM),
        rename: refuse(ERRNO_EPERM),
        unlink: refuse(ERRNO_EPERM),
        rmdir: refuse(ERRNO_EPERM),
        symlink: refuse(ERRNO_EPERM),
        readdir: () => ['.', '..', ...nodes.keys()],
    };
    const stream_ops = {
        read(_stream: IQpdfFileStream, buffer: Uint8Array, offset: number, length: number, position: number) {
            let done = 0;
            while (done < length && position + done < blob.size) {
                const at = position + done;
                const bytes = block(Math.floor(at / BLOB_BLOCK_BYTES));
                const from = at % BLOB_BLOCK_BYTES;
                const count = Math.min(length - done, bytes.byteLength - from);
                if (count <= 0) break;
                buffer.set(bytes.subarray(from, from + count), offset + done);
                done += count;
            }
            return done;
        },
        write: refuse(ERRNO_EPERM),
        llseek(stream: IQpdfFileStream, offset: number, whence: number) {
            const position = offset + (whence === 1 ? stream.position : whence === 2 ? blob.size : 0);
            if (position < 0) throw new fs.ErrnoError(ERRNO_EINVAL);
            return position;
        },
    };
    fs.mkdirTree(BLOB_MOUNT);
    fs.mount({
        mount() {
            const root = Object.assign(fs.createNode(null, '/', S_IFDIR | 0o555, 0), {node_ops, stream_ops: {}});
            nodes.set(BLOB_NAME, Object.assign(fs.createNode(root, BLOB_NAME, S_IFREG | 0o444, 0), {node_ops, stream_ops}));
            return root;
        },
    }, {}, BLOB_MOUNT);
}

/**
 * Runs one qpdf command in a fresh instance. Wasm memory never shrinks and
 * the file system holds whole files, so nothing outlives the command but the
 * compiled module. An input buffer is handed to the file system, not copied;
 * a Blob is mounted read-only and read by range, and the mount ends with the
 * instance, whether the command succeeded or not.
 */
async function runQpdf(command: TBrowserQpdfCommand, input: Uint8Array | Blob): Promise<IBrowserQpdfRunResult> {
    const engine = await loadQpdf();
    const log = {
        stdout: '',
        stderr: '',
    };
    let instance: IQpdfModule;
    try {
        instance = await engine.factory({
            instantiateWasm(imports, receive) {
                void WebAssembly.instantiate(engine.module, imports).then(created => receive(created, engine.module));
                return {};
            },
            thisProgram: 'qpdf',
            print: (line) => {
                log.stdout = appendBounded(log.stdout, line);
            },
            printErr: (line) => {
                log.stderr = appendBounded(log.stderr, line);
            },
        });
    } catch (error) {
        throw new EngineUnavailableError(getErrorMessage(error));
    }
    instance.FS.mkdirTree('/work');
    if (input instanceof Blob) {
        mountBlob(instance.FS, input);
        instance.FS.symlink(`${BLOB_MOUNT}/${BLOB_NAME}`, INPUT_PATH);
    } else {
        instance.FS.writeFile(INPUT_PATH, input, {canOwn: true});
    }
    // The file system grows JavaScript buffers outside Wasm memory, so the
    // output is bounded as it is written, before it can be allocated.
    const write = instance.FS.write.bind(instance.FS);
    instance.FS.write = (stream, buffer, offset, length, position, canOwn) => {
        if (stream.path === OUTPUT_PATH && (position ?? stream.position) + length > BROWSER_QPDF_MAX_INPUT_BYTES) {
            throw new OutputBudgetError(`qpdf output exceeds ${BROWSER_QPDF_MAX_INPUT_BYTES} bytes`);
        }
        return write(stream, buffer, offset, length, position, canOwn);
    };
    let exitCode: number;
    try {
        exitCode = instance.callMain(COMMAND_ARGS[command]());
    } catch (error) {
        if (!(error instanceof OutputBudgetError)) throw error;
        // Reported as qpdf's own failure exit, so callers refuse the rewrite.
        return {
            exitCode: 2,
            stdout: log.stdout,
            stderr: appendBounded(log.stderr, error.message),
            output: null,
        };
    } finally {
        if (input instanceof Blob) instance.FS.unmount(BLOB_MOUNT);
    }
    const output = WRITING_COMMANDS.has(command) && isQpdfSuccessExitCode(exitCode)
        ? instance.FS.readFile(OUTPUT_PATH)
        : null;
    return {
        exitCode,
        stdout: log.stdout,
        stderr: log.stderr,
        output,
    };
}

/** Desktop's append-admission verdict, from the page tool's own Rust function. */
async function readAppendAdmission(bytes: Uint8Array) {
    const module = await loadAppendAdmission();
    // The page tool's file imports serve page-structure edits, which the admission never reaches.
    const fileImports = WebAssembly.Module.imports(module).map(({name}) => [name, () => -1]);
    const {exports} = await WebAssembly.instantiate(module, {evb_host: Object.fromEntries(fileImports)}).catch((error: unknown) => {
        throw new EngineUnavailableError(getErrorMessage(error));
    });
    if (!hasAppendAdmissionExports(exports)) {
        throw new EngineUnavailableError('The page tool has no append admission');
    }
    const pointer = exports.evb_pdf_page_ops_alloc(bytes.byteLength);
    if (pointer === 0) {
        throw new Error('The append admission could not hold the PDF');
    }
    try {
        new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
        const verdict = BROWSER_APPEND_ADMISSION_VERDICTS[exports.evb_pdf_page_ops_append_admission(pointer, bytes.byteLength)];
        if (verdict === undefined) {
            throw new Error('The append admission could not judge the PDF');
        }
        return verdict;
    } finally {
        exports.evb_pdf_page_ops_free(pointer, bytes.byteLength);
    }
}

const NO_ADMISSION_SINK = {
    write: () => {
        throw new Error('Append admission writes nothing');
    },
    read: () => {
        throw new Error('Append admission reads no sink');
    },
};

/**
 * Desktop's append-admission verdict over a Blob read by bounded ranges, so a
 * large PDF never copies its bytes into JS heap or Wasm memory on open.
 */
async function readAppendAdmissionFromBlob(blob: Blob) {
    const module = await loadAppendAdmission();
    let memory: WebAssembly.Memory | null = null;
    const {exports} = await WebAssembly.instantiate(
        module,
        createPageOpsHostImports(() => memory!),
    ).catch((error: unknown) => {
        throw new EngineUnavailableError(getErrorMessage(error));
    });
    if (!hasPageOpsRunExports(exports)) {
        throw new EngineUnavailableError('The page tool has no range append admission');
    }
    memory = exports.memory;
    const source = await blobSource(blob);
    const output = await withOpenFiles({
        sources: [source],
        sink: NO_ADMISSION_SINK,
        copy: () => Promise.reject(new Error('Append admission copies nothing')),
    }, async () => runFileRequest(exports, {
        operation: OPERATION_CODES.appendAdmission,
        sourceCount: 1,
    }));
    if (isBrowserPageOpsWasmFailure(output)) {
        throw new Error(output.error.message);
    }
    if (output.byteLength < BYTES_HEADER.bytes) {
        throw new Error('The append admission returned malformed output');
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    if (
        view.getUint32(BYTES_HEADER.kind, true) !== RESPONSE_JSON
        || view.getUint32(BYTES_HEADER.dataLength, true) !== output.byteLength - BYTES_HEADER.bytes
    ) {
        throw new Error('The append admission returned malformed output');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(output.subarray(BYTES_HEADER.bytes)));
    } catch {
        throw new Error('The append admission returned invalid JSON');
    }
    const verdict = typeof parsed === 'object' && parsed !== null && 'verdict' in parsed
        ? (parsed as {verdict: unknown}).verdict
        : undefined;
    if (typeof verdict !== 'string' || !(BROWSER_APPEND_ADMISSION_VERDICTS as readonly string[]).includes(verdict)) {
        throw new Error('The append admission could not judge the PDF');
    }
    return verdict as (typeof BROWSER_APPEND_ADMISSION_VERDICTS)[number];
}

/**
 * Desktop's `normalizePdfAppendBase` for bytes or a Blob: a base whose
 * cross-reference chain an append cannot extend is rewritten through qpdf, and
 * the rewrite must take an append. Both the admission and qpdf read a Blob by
 * bounded ranges so large PDFs never copy whole into JS heap.
 */
async function normalizeAppendBase(input: Uint8Array | Blob): Promise<IBrowserQpdfNormalizeResult> {
    const verdict = input instanceof Blob
        ? await readAppendAdmissionFromBlob(input)
        : await readAppendAdmission(input);
    if (verdict !== 'repairable') {
        return {
            verdict,
            output: null,
            stderr: '',
        };
    }
    const rewrite = await runQpdf('rewrite', input);
    if (rewrite.output === null) {
        throw new RewriteFailedError(`qpdf exited with code ${rewrite.exitCode}: ${rewrite.stderr.trim()}`);
    }
    if (await readAppendAdmission(rewrite.output) === 'repairable') {
        throw new RewriteFailedError('The rewritten PDF still cannot take an edit');
    }
    return {
        verdict,
        output: rewrite.output,
        stderr: rewrite.stderr,
    };
}

function getErrorCode(error: unknown) {
    if (error instanceof EngineUnavailableError) return BROWSER_QPDF_ENGINE_ERROR_CODES.unavailable;
    if (error instanceof RewriteFailedError) return BROWSER_QPDF_ENGINE_ERROR_CODES.rewriteFailed;
    return BROWSER_QPDF_ENGINE_ERROR_CODES.failed;
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserQpdfEngineRequest(event.data);
    if (request === null) {
        const id = getBrowserPageOpsWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser qpdf engine request',
            });
        }
        return;
    }
    try {
        const data = request.type === 'run'
            ? await runQpdf(request.payload.command, request.payload.input)
            : await normalizeAppendBase(request.payload.input);
        self.postMessage({
            id: request.id,
            ok: true,
            type: request.type,
            data,
        }, data.output ? [data.output.buffer as ArrayBuffer] : []);
    } catch (error) {
        const message = getErrorMessage(error);
        self.postMessage({
            id: request.id,
            ok: false,
            error: message,
            errorEnvelope: {
                code: getErrorCode(error),
                message,
            },
        });
    }
});
