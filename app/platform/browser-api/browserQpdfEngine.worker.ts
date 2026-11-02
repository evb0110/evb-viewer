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
import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
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

const INPUT_PATH = '/work/input.pdf';
const OUTPUT_PATH = '/work/output.pdf';

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
 * Runs one qpdf command in a fresh instance. Wasm memory never shrinks and
 * the file system holds whole files, so nothing outlives the command but the
 * compiled module; the input buffer is handed to the file system, not copied.
 */
async function runQpdf(command: TBrowserQpdfCommand, input: Uint8Array): Promise<IBrowserQpdfRunResult> {
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
    instance.FS.writeFile(INPUT_PATH, input, {canOwn: true});
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
    const {exports} = await WebAssembly.instantiate(module, {}).catch((error: unknown) => {
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

/**
 * Desktop's `normalizePdfAppendBase` for bytes: a base whose cross-reference
 * chain an append cannot extend is rewritten through qpdf, and the rewrite
 * must take an append.
 */
async function normalizeAppendBase(input: Uint8Array): Promise<IBrowserQpdfNormalizeResult> {
    const verdict = await readAppendAdmission(input);
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
