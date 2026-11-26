import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {totalmem} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type INativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {
    PDF_SEARCH_WASM_EXPORT_PREFIX,
    PDF_SEARCH_WASM_MAX_OUTPUT_BYTES,
    PDF_SEARCH_WASM_MAX_REQUEST_BYTES,
} from '@contracts/searchIndexWire';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 * 1024;
const FOUR_GIB = 4 * 1024 * MIB;
const textDecoder = new TextDecoder();

export function defaultDesktopWasmHighWaterBytes() {
    return totalmem() > FOUR_GIB ? 256 * MIB : 128 * MIB;
}

export class PdfSearchNativeError extends Error {
    readonly code: TNativeErrorCode;

    constructor(code: TNativeErrorCode, message: string) {
        super(message);
        this.name = 'PdfSearchNativeError';
        this.code = code;
    }
}

interface IPdfSearchWasmExports {
    memory: WebAssembly.Memory;
    alloc(byteLength: number): number;
    free(pointer: number, byteLength: number): void;
    run(pointer: number, byteLength: number): number;
    outputPtr(): number;
    outputLen(): number;
    errorPtr(): number;
    errorLen(): number;
}

function isWasmFn(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

function readExports(exports: WebAssembly.Exports): IPdfSearchWasmExports {
    const prefix = PDF_SEARCH_WASM_EXPORT_PREFIX;
    const memory = exports.memory;
    const abiVersion = exports.evb_wasm_request_allocation_abi_version;
    const alloc = exports[`${prefix}_alloc`];
    const free = exports[`${prefix}_free`];
    const run = exports[`${prefix}_run`];
    const outputPtr = exports[`${prefix}_output_ptr`];
    const outputLen = exports[`${prefix}_output_len`];
    const errorPtr = exports[`${prefix}_error_ptr`];
    const errorLen = exports[`${prefix}_error_len`];
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
        throw new PdfSearchNativeError(
            'native-failure',
            'evb-pdf-search.wasm does not match this version of the app',
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

function readErrorEnvelope(tool: IPdfSearchWasmExports, resultCode: number): INativeErrorEnvelope {
    const length = tool.errorLen();
    const encoded = length === 0
        ? null
        : textDecoder.decode(
            getCheckedWasmMemoryView(tool.memory, tool.errorPtr(), length, 'evb-pdf-search').slice(),
        );
    return decodeSerializableErrorEnvelope(encoded, NATIVE_ERROR_ENVELOPE_SCHEMA, {allowBareJsonString: true}) ?? {
        code: 'native-failure',
        message: encoded ?? `evb-pdf-search failed with result code ${resultCode}`,
    };
}

/**
 * Reusable single-threaded runner over one compiled `evb-pdf-search.wasm`
 * module. Drops its instance whenever linear memory grows past the high-water
 * mark or after a trap/panic so V8 can reclaim linear memory.
 */
export function createPdfSearchWasmRunner(
    wasmModule: WebAssembly.Module,
    options: {highWaterBytes?: number} = {},
) {
    const highWaterBytes = options.highWaterBytes ?? defaultDesktopWasmHighWaterBytes();
    let tool: IPdfSearchWasmExports | null = null;

    function getTool() {
        tool ??= readExports(new WebAssembly.Instance(wasmModule).exports);
        return tool;
    }

    function dispose() {
        tool = null;
    }

    function run(request: Uint8Array): Uint8Array<ArrayBuffer> {
        const byteLength = request.byteLength;
        if (byteLength === 0 || byteLength > PDF_SEARCH_WASM_MAX_REQUEST_BYTES) {
            throw new PdfSearchNativeError(
                'too-large',
                'evb-pdf-search request exceeds the admission ceiling',
            );
        }
        const active = getTool();
        const pointer = active.alloc(byteLength);
        if (pointer === 0) {
            dispose();
            throw new PdfSearchNativeError(
                'too-large',
                'evb-pdf-search could not allocate request memory',
            );
        }
        let resultCode: number;
        try {
            getCheckedWasmMemoryView(active.memory, pointer, byteLength, 'evb-pdf-search allocation').set(request);
            resultCode = active.run(pointer, byteLength);
        } catch (error) {
            dispose();
            throw new PdfSearchNativeError(
                error instanceof WebAssembly.RuntimeError ? 'panic' : 'native-failure',
                error instanceof Error ? error.message : String(error),
            );
        }

        let output: Uint8Array<ArrayBuffer> | null = null;
        let envelope: INativeErrorEnvelope | null = null;
        try {
            if (resultCode !== 0) {
                envelope = readErrorEnvelope(active, resultCode);
            } else {
                const outputLength = active.outputLen();
                if (outputLength === 0 || outputLength > PDF_SEARCH_WASM_MAX_OUTPUT_BYTES) {
                    envelope = {
                        code: outputLength > PDF_SEARCH_WASM_MAX_OUTPUT_BYTES ? 'too-large' : 'invalid-request',
                        message: 'evb-pdf-search returned an invalid output envelope',
                    };
                } else {
                    const slice = getCheckedWasmMemoryView(active.memory, active.outputPtr(), outputLength, 'evb-pdf-search');
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

        if (
            (envelope !== null && envelope.code === 'panic')
            || active.memory.buffer.byteLength > highWaterBytes
        ) {
            dispose();
        }
        if (envelope !== null) {
            throw new PdfSearchNativeError(envelope.code, envelope.message);
        }
        return output!;
    }

    return {
        run,
        dispose,
        memoryBytes: () => tool?.memory.buffer.byteLength ?? 0,
    };
}

let cachedModulePromise: Promise<WebAssembly.Module> | null = null;

export function resolvePdfSearchWasmPath(options: {
    currentDir?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
} = {}) {
    const currentDir = options.currentDir ?? __dirname;
    const isPackaged = options.isPackaged ?? currentDir.includes('app.asar');
    if (isPackaged) {
        const resourcesPath = options.resourcesPath ?? process.resourcesPath;
        const asarPath = join(resourcesPath, 'app.asar', 'nuxt-output', 'public', 'wasm', 'evb-pdf-search.wasm');
        if (existsSync(asarPath)) {
            return asarPath;
        }
        return join(currentDir, '..', 'nuxt-output', 'public', 'wasm', 'evb-pdf-search.wasm');
    }
    const candidates = [
        join(currentDir, '..', 'public', 'wasm', 'evb-pdf-search.wasm'),
        join(currentDir, '..', '..', '..', 'public', 'wasm', 'evb-pdf-search.wasm'),
        join(process.cwd(), 'public', 'wasm', 'evb-pdf-search.wasm'),
    ];
    return candidates.find(candidate => existsSync(candidate)) ?? candidates.at(-1)!;
}

export function loadPdfSearchWasmModule(wasmPath?: string): Promise<WebAssembly.Module> {
    if (wasmPath !== undefined) {
        return readFile(wasmPath).then(bytes => WebAssembly.compile(bytes));
    }
    const pending = cachedModulePromise ??= readFile(resolvePdfSearchWasmPath())
        .then(bytes => WebAssembly.compile(bytes))
        .catch((error: unknown) => {
            if (cachedModulePromise === pending) {
                cachedModulePromise = null;
            }
            throw error;
        });
    return pending;
}
