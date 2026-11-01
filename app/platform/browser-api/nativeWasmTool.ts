import { getErrorMessage } from '@app/utils/error';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import {
    NATIVE_ERROR_ENVELOPE_SCHEMA,
    type INativeErrorEnvelope,
} from '@contracts/nativeErrors';
import {decodeSerializableErrorEnvelope} from '@contracts/serializableError';

/**
 * The bounded request ABI an EVB native WASM tool exports under its own
 * prefix: one live request allocation, one run export, and the last result
 * or error envelope. The Rust side is `evb_native_support::wasm_request_allocation`.
 */
export interface INativeWasmTool {
    memory: WebAssembly.Memory;
    alloc(byteLength: number): number;
    free(pointer: number, byteLength: number): void;
    run(pointer: number, byteLength: number): number;
    outputPtr(): number;
    outputLen(): number;
    errorPtr(): number;
    errorLen(): number;
}

export interface INativeWasmToolDescriptor {
    /** Public path of the module, such as `/wasm/evb-scan-cleanup.wasm`. */
    path: string;
    /** Export prefix, such as `evb_scan_cleanup`. */
    prefix: string;
    /** The run export's suffix after the prefix, such as `run`. */
    runExport: string;
    /** Names the tool in failure messages. */
    label: string;
    maxRequestBytes: number;
    maxOutputBytes: number;
    imports?: () => WebAssembly.Imports;
}

export type TNativeWasmCallResult =
    | {
        status: 'succeeded';
        output: Uint8Array<ArrayBuffer>;
    }
    | {
        status: 'failed';
        error: INativeErrorEnvelope;
    };

function isWasmFunction(value: WebAssembly.ExportValue | undefined): value is (...args: number[]) => number {
    return typeof value === 'function';
}

/** The tool's exports, or null when the module is not this tool's ABI. */
export function readNativeWasmTool(
    exports: WebAssembly.Exports,
    descriptor: Pick<INativeWasmToolDescriptor, 'prefix' | 'runExport'>,
): INativeWasmTool | null {
    const {prefix} = descriptor;
    const memory = exports.memory;
    const allocationAbiVersion = exports.evb_wasm_request_allocation_abi_version;
    const functions = [
        exports[`${prefix}_alloc`],
        exports[`${prefix}_free`],
        exports[`${prefix}_${descriptor.runExport}`],
        exports[`${prefix}_output_ptr`],
        exports[`${prefix}_output_len`],
        exports[`${prefix}_error_ptr`],
        exports[`${prefix}_error_len`],
    ];
    if (
        !(memory instanceof WebAssembly.Memory)
        || !isWasmFunction(allocationAbiVersion)
        || allocationAbiVersion() !== WASM_REQUEST_ALLOCATION_ABI_VERSION
        || !functions.every(isWasmFunction)
    ) {
        return null;
    }
    const [
        alloc,
        free,
        run,
        outputPtr,
        outputLen,
        errorPtr,
        errorLen,
    ] = functions as Array<(...args: number[]) => number>;
    return {
        memory,
        alloc: alloc!,
        free: free!,
        run: run!,
        outputPtr: outputPtr!,
        outputLen: outputLen!,
        errorPtr: errorPtr!,
        errorLen: errorLen!,
    };
}

function failure(code: INativeErrorEnvelope['code'], message: string): TNativeWasmCallResult {
    return {
        status: 'failed',
        error: {
            code,
            message,
        },
    };
}

function readError(tool: INativeWasmTool, label: string, resultCode: number): INativeErrorEnvelope {
    const length = tool.errorLen();
    const encoded = length === 0
        ? null
        : new TextDecoder().decode(getCheckedWasmMemoryView(tool.memory, tool.errorPtr(), length, label));
    return decodeSerializableErrorEnvelope(encoded, NATIVE_ERROR_ENVELOPE_SCHEMA, {allowBareJsonString: true}) ?? {
        code: 'native-failure',
        message: encoded ?? `${label} failed with result code ${resultCode}`,
    };
}

/**
 * Copies one request into the tool's live allocation, runs it and copies the
 * result out. Every pointer and length the module returns is checked against
 * its current linear memory before it is read. A trap propagates: the
 * instance's state is then unknown, and the caller must discard it.
 */
export function callNativeWasmTool(
    tool: INativeWasmTool,
    descriptor: Pick<INativeWasmToolDescriptor, 'label' | 'maxRequestBytes' | 'maxOutputBytes'>,
    request: Uint8Array,
): TNativeWasmCallResult {
    const {label} = descriptor;
    const byteLength = request.byteLength;
    if (byteLength === 0 || byteLength > descriptor.maxRequestBytes) {
        return failure('too-large', `${label} request exceeds the admission ceiling`);
    }
    const pointer = tool.alloc(byteLength);
    if (pointer === 0) {
        return failure('too-large', `${label} could not allocate request memory`);
    }
    try {
        getCheckedWasmMemoryView(tool.memory, pointer, byteLength, `${label} allocation`).set(request);
        const resultCode = tool.run(pointer, byteLength);
        if (resultCode !== 0) {
            return {
                status: 'failed',
                error: readError(tool, label, resultCode),
            };
        }
        const outputLength = tool.outputLen();
        if (outputLength === 0 || outputLength > descriptor.maxOutputBytes) {
            return failure(
                outputLength > descriptor.maxOutputBytes ? 'too-large' : 'invalid-request',
                `${label} returned an invalid output envelope`,
            );
        }
        return {
            status: 'succeeded',
            output: toTransferableUint8Array(
                getCheckedWasmMemoryView(tool.memory, tool.outputPtr(), outputLength, label).slice(),
            ),
        };
    } finally {
        tool.free(pointer, byteLength);
    }
}

/**
 * Loads a native WASM tool once per thread. A failed load is forgotten so the
 * next call loads again, and `discard` drops an instance that trapped.
 */
export function createNativeWasmToolLoader(descriptor: INativeWasmToolDescriptor) {
    let pending: Promise<INativeWasmTool> | null = null;

    function load() {
        const current = pending ??= (async () => {
            if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') {
                throw new Error('This browser cannot run WebAssembly');
            }
            const instantiated = await loadWasmWithDeadline(
                new URL(descriptor.path, globalThis.location.href).toString(),
                descriptor.imports?.() ?? {},
            );
            const instance = 'instance' in instantiated ? instantiated.instance : instantiated;
            const tool = readNativeWasmTool(instance.exports, descriptor);
            if (!tool) {
                throw new Error(`The ${descriptor.label} does not match this version of the app`);
            }
            return tool;
        })();
        current.catch(() => {
            if (pending === current) pending = null;
        });
        return current;
    }

    function discard() {
        pending = null;
    }

    /** Loads the tool if needed and runs one request through it. */
    async function call(request: Uint8Array): Promise<TNativeWasmCallResult> {
        let tool: INativeWasmTool;
        try {
            tool = await load();
        } catch (error) {
            return failure(
                error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'io',
                `The ${descriptor.label} could not be loaded: ${getErrorMessage(error)}`,
            );
        }
        try {
            return callNativeWasmTool(tool, descriptor, request);
        } catch (error) {
            // A trap leaves the instance's allocator and result slots unknown.
            discard();
            return failure(
                error instanceof WebAssembly.RuntimeError ? 'panic' : 'invalid-request',
                `The ${descriptor.label} failed: ${getErrorMessage(error)}`,
            );
        }
    }

    return {
        call,
        discard,
        load,
    };
}
