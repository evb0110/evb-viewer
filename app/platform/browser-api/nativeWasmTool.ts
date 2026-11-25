import { getErrorMessage } from '@app/utils/error';
import {
    exceedsWasmMemoryHighWater,
    loadWasmWithDeadline,
    readLoadedWasmDigest,
} from '@app/platform/browser/loadWasmWithDeadline';
import {
    createNativeWasmThreadedInstances,
    NativeWasmThreadStartError,
    type INativeWasmThreadsDescriptor,
} from '@app/platform/browser-api/nativeWasmThreadedTool';
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
    /** Ends what the instance runs besides itself, such as its threads. */
    dispose?: () => void;
    /** Why one of its threads died, after a run returned the engine fault. */
    readFault?: () => Promise<string | null>;
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
    /**
     * Runs the tool's threaded build instead of the module at `path`. Its
     * imports are the threads host's, not `imports`.
     */
    threads?: INativeWasmThreadsDescriptor;
}

/**
 * `run`'s result when a thread of a threaded build trapped. The instance may
 * hold locks no thread will release: drop it without calling into it again,
 * not even to free the request.
 */
export const NATIVE_WASM_ENGINE_FAULT = -2;

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
    // TextDecoder rejects a view of shared memory, which a threaded build runs on; decode a copy.
    const encoded = length === 0
        ? null
        : new TextDecoder().decode(getCheckedWasmMemoryView(tool.memory, tool.errorPtr(), length, label).slice());
    return decodeSerializableErrorEnvelope(encoded, NATIVE_ERROR_ENVELOPE_SCHEMA, {allowBareJsonString: true}) ?? {
        code: 'native-failure',
        message: encoded ?? `${label} failed with result code ${resultCode}`,
    };
}

/**
 * Copies one request into the tool's live allocation, runs it and copies the
 * result out. Every pointer and length the module returns is checked against
 * its current linear memory before it is read. A trap propagates: the
 * instance's state is then unknown, and the caller must discard it. The
 * request is freed only after a run that returned normally; an engine fault
 * returns 'panic', and the caller must discard that instance too.
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
    getCheckedWasmMemoryView(tool.memory, pointer, byteLength, `${label} allocation`).set(request);
    const resultCode = tool.run(pointer, byteLength);
    if (resultCode === NATIVE_WASM_ENGINE_FAULT) {
        return failure('panic', `${label} stopped: one of its threads failed`);
    }
    const result = readResult(tool, descriptor, resultCode);
    tool.free(pointer, byteLength);
    return result;
}

function readResult(
    tool: INativeWasmTool,
    {
        label, maxOutputBytes,
    }: Pick<INativeWasmToolDescriptor, 'label' | 'maxOutputBytes'>,
    resultCode: number,
): TNativeWasmCallResult {
    if (resultCode !== 0) {
        return {
            status: 'failed',
            error: readError(tool, label, resultCode),
        };
    }
    const outputLength = tool.outputLen();
    if (outputLength === 0 || outputLength > maxOutputBytes) {
        return failure(
            outputLength > maxOutputBytes ? 'too-large' : 'invalid-request',
            `${label} returned an invalid output envelope`,
        );
    }
    return {
        status: 'succeeded',
        output: toTransferableUint8Array(
            getCheckedWasmMemoryView(tool.memory, tool.outputPtr(), outputLength, label).slice(),
        ),
    };
}

/**
 * Loads a native WASM tool once per thread. A failed load is forgotten so the
 * next call loads again, `discard` drops an instance that trapped or faulted,
 * and a call that leaves its instance's memory past the high-water mark drops
 * it too. A descriptor with `threads` runs the threaded build: its module is
 * compiled once and kept, and each instance starts its own threads.
 */
export function createNativeWasmToolLoader(descriptor: INativeWasmToolDescriptor) {
    let pending: Promise<INativeWasmTool> | null = null;
    let loaded: INativeWasmTool | null = null;
    const threaded = descriptor.threads === undefined
        ? null
        : createNativeWasmThreadedInstances({
            prefix: descriptor.prefix,
            label: descriptor.label,
            threads: descriptor.threads,
        });
    const modulePath = descriptor.threads?.path ?? descriptor.path;

    async function instantiate(): Promise<INativeWasmTool> {
        if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') {
            throw new Error('This browser cannot run WebAssembly');
        }
        if (threaded !== null) {
            const instance = await threaded.instantiate();
            const tool = readNativeWasmTool(instance.exports, descriptor);
            if (!tool) {
                instance.dispose();
                throw new Error(`The ${descriptor.label} does not match this version of the app`);
            }
            return {
                ...tool,
                dispose: instance.dispose,
                readFault: instance.readFault,
            };
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
    }

    function load() {
        const current = pending ??= instantiate();
        // Registered before any caller awaits the load, so the instance is known as this thread's before its first call.
        current.then(tool => {
            if (pending === current) loaded = tool;
            else tool.dispose?.();
        }, () => {
            if (pending === current) pending = null;
        });
        return current;
    }

    function discard() {
        const tool = loaded;
        pending = null;
        loaded = null;
        tool?.dispose?.();
    }

    /** Loads the tool if needed and runs one request through it. */
    async function call(request: Uint8Array): Promise<TNativeWasmCallResult> {
        let tool: INativeWasmTool;
        try {
            tool = await load();
        } catch (error) {
            // The page decides what runs instead of a threaded build that cannot start.
            if (error instanceof NativeWasmThreadStartError) throw error;
            return failure(
                error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'io',
                `The ${descriptor.label} could not be loaded: ${getErrorMessage(error)}`,
            );
        }
        try {
            let result = callNativeWasmTool(tool, descriptor, request);
            if (result.status === 'failed' && result.error.code === 'panic' && tool.readFault) {
                const reason = await tool.readFault();
                if (reason !== null) result = failure('panic', `${result.error.message}: ${reason}`);
            }
            // The call has ended; whoever still holds the instance finishes on it.
            // A threaded instance is kept past the high-water mark: its memory
            // is reserved in full when created, so a new one would only add a
            // reservation until the old is collected. It ends with its worker.
            if (loaded === tool && (
                (result.status === 'failed' && result.error.code === 'panic')
                || (threaded === null && exceedsWasmMemoryHighWater(tool.memory))
            )) discard();
            return result;
        } catch (error) {
            // A trap leaves the instance's allocator and result slots unknown.
            if (loaded === tool) discard();
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
        /** The SHA-256 of the module this thread compiled for the tool, once it has. */
        readDigest: () => readLoadedWasmDigest(modulePath),
    };
}
