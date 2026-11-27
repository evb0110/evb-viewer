import { getErrorMessage } from '@app/utils/error';
import {
    exceedsWasmMemoryHighWater,
    loadWasmWithDeadline,
    readLoadedWasmDigest,
    resolveWasmUrl,
} from '@app/platform/browser/loadWasmWithDeadline';
import {
    createNativeWasmThreadedInstances,
    NativeWasmThreadStartError,
    type INativeWasmThreadsDescriptor,
} from '@app/platform/browser/nativeWasmThreadedTool';
import { toTransferableUint8Array } from '@app/platform/browser/toTransferableUint8Array';
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
    /** Builds host imports; `getMemory` resolves to the instantiated tool's linear memory once loaded. */
    imports?: (getMemory: () => WebAssembly.Memory) => WebAssembly.Imports;
    /** Error code surfaced when a WebAssembly RuntimeError traps inside `run`. Defaults to `'panic'`. */
    trapErrorCode?: INativeErrorEnvelope['code'];
    /**
     * Runs the tool's threaded build instead of the module at `path`. Its
     * imports are the threads host's, not `imports`.
     */
    threads?: INativeWasmThreadsDescriptor;
}

export interface ICallNativeWasmToolOptions {
    /** Invoked right after `tool.run` returns normally, before reading output/error (e.g. rethrow host import error). */
    afterRun?: () => void;
    /** Byte slice in the request buffer (and its WASM copy) to zero out before freeing. */
    scrubRange?: {
        offset: number;
        length: number;
    };
    /** Propagate non-RuntimeError throws (such as host QuotaExceededError from `afterRun`) instead of wrapping as invalid-request. */
    rethrowNonTrapErrors?: boolean;
    /** Keep the instance cached even past the high-water mark (e.g. while a cached Document is open; caller releases on close). */
    skipHighWaterRelease?: boolean;
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

function isWasmRuntimeError(error: unknown): boolean {
    return (typeof WebAssembly !== 'undefined' && typeof WebAssembly.RuntimeError === 'function' && error instanceof WebAssembly.RuntimeError)
        || (error instanceof Error && error.name === 'RuntimeError');
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
    options?: ICallNativeWasmToolOptions,
): TNativeWasmCallResult {
    const {label} = descriptor;
    const byteLength = request.byteLength;
    const scrub = options?.scrubRange;
    const scrubRequest = () => {
        if (scrub && scrub.length > 0) {
            request.fill(0, scrub.offset, scrub.offset + scrub.length);
        }
    };
    if (byteLength === 0 || byteLength > descriptor.maxRequestBytes) {
        scrubRequest();
        return failure('too-large', `${label} request exceeds the admission ceiling`);
    }
    const pointer = tool.alloc(byteLength);
    if (pointer === 0) {
        scrubRequest();
        return failure('too-large', `${label} could not allocate request memory`);
    }
    let trapped = false;
    let engineFault = false;
    try {
        getCheckedWasmMemoryView(tool.memory, pointer, byteLength, `${label} allocation`).set(request);
        const resultCode = tool.run(pointer, byteLength);
        options?.afterRun?.();
        if (resultCode === NATIVE_WASM_ENGINE_FAULT) {
            engineFault = true;
            return failure('panic', `${label} stopped: one of its threads failed`);
        }
        return readResult(tool, descriptor, resultCode);
    } catch (error) {
        trapped = isWasmRuntimeError(error);
        throw error;
    } finally {
        scrubRequest();
        try {
            if (scrub && scrub.length > 0 && !engineFault) {
                getCheckedWasmMemoryView(tool.memory, pointer, byteLength, `${label} allocation`)
                    .fill(0, scrub.offset, scrub.offset + scrub.length);
            }
        } finally {
            if (!trapped && !engineFault) {
                tool.free(pointer, byteLength);
            }
        }
    }
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
        let memory: WebAssembly.Memory | null = null;
        const instantiated = await loadWasmWithDeadline(
            resolveWasmUrl(descriptor.path),
            descriptor.imports?.(() => memory!) ?? {},
        );
        const instance = 'instance' in instantiated ? instantiated.instance : instantiated;
        const tool = readNativeWasmTool(instance.exports, descriptor);
        if (!tool) {
            throw new Error(`The ${descriptor.label} does not match this version of the app`);
        }
        memory = tool.memory;
        return tool;
    }

    function load() {
        const current = pending ??= instantiate();
        // Registered before any caller awaits the load, so the instance is known as this thread's before its first call.
        current.then(tool => {
            if (pending === current) {loaded = tool;}
            else {tool.dispose?.();}
        }, () => {
            if (pending === current) {pending = null;}
        });
        return current;
    }

    /**
     * Drops the thread's cached instance. When `target` is given, only drops
     * if `target` is still this thread's current instance so a retired instance
     * finishing late leaves its replacement untouched.
     */
    function discard(target?: INativeWasmTool) {
        if (target !== undefined && loaded !== target) {return;}
        const tool = loaded;
        pending = null;
        loaded = null;
        tool?.dispose?.();
    }

    function releaseIfAboveHighWater(tool: INativeWasmTool) {
        if (loaded === tool && threaded === null && exceedsWasmMemoryHighWater(tool.memory)) {
            discard(tool);
        }
    }

    /** Runs one request synchronously on an already-loaded `tool` instance. */
    function callLoaded(
        tool: INativeWasmTool,
        request: Uint8Array,
        options?: ICallNativeWasmToolOptions,
    ): TNativeWasmCallResult {
        try {
            const result = callNativeWasmTool(tool, descriptor, request, options);
            // The call has ended; whoever still holds the instance finishes on it.
            // A threaded instance is kept past the high-water mark: its memory
            // is reserved in full when created, so a new one would only add a
            // reservation until the old is collected. It ends with its worker.
            if (result.status === 'failed' && result.error.code === 'panic') {
                discard(tool);
            } else if (!options?.skipHighWaterRelease) {
                releaseIfAboveHighWater(tool);
            }
            return result;
        } catch (error) {
            if (isWasmRuntimeError(error)) {
                // A trap leaves the instance's allocator and result slots unknown.
                discard(tool);
                const trapCode = descriptor.trapErrorCode ?? 'panic';
                return failure(
                    trapCode,
                    trapCode === 'too-large'
                        ? `The ${descriptor.label} ran out of memory: ${getErrorMessage(error)}`
                        : `The ${descriptor.label} failed: ${getErrorMessage(error)}`,
                );
            }
            releaseIfAboveHighWater(tool);
            if (options?.rethrowNonTrapErrors) {
                throw error;
            }
            discard(tool);
            return failure(
                'invalid-request',
                `The ${descriptor.label} failed: ${getErrorMessage(error)}`,
            );
        }
    }

    /** Loads the tool if needed and runs one request through it. */
    async function call(
        request: Uint8Array,
        options?: ICallNativeWasmToolOptions,
    ): Promise<TNativeWasmCallResult> {
        let tool: INativeWasmTool;
        try {
            tool = await load();
        } catch (error) {
            // The page decides what runs instead of a threaded build that cannot start.
            if (error instanceof NativeWasmThreadStartError) {throw error;}
            return failure(
                error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'io',
                `The ${descriptor.label} could not be loaded: ${getErrorMessage(error)}`,
            );
        }
        let result = callLoaded(tool, request, options);
        if (result.status === 'failed' && result.error.code === 'panic' && tool.readFault) {
            const reason = await tool.readFault();
            if (reason !== null) {result = failure('panic', `${result.error.message}: ${reason}`);}
        }
        return result;
    }

    return {
        call,
        callLoaded,
        discard,
        load,
        releaseIfAboveHighWater,
        /** The SHA-256 of the module this thread compiled for the tool, once it has. */
        readDigest: () => readLoadedWasmDigest(modulePath),
    };
}
