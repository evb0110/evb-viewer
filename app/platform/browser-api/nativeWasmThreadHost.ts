/**
 * The host side of a threaded EVB native WASM engine, built for
 * `wasm32-wasip1-threads` (today the threaded scan cleanup engine). Every
 * instance, the main one and one per host thread, runs on one shared memory
 * and takes the WASI imports below.
 *
 * The main instance's owner calls `_initialize` once, then the engine's
 * thread start export. Each thread the engine asks for through
 * `wasi.thread-spawn` is a new host thread (a Web Worker, or a Node worker
 * thread) that instantiates the same module on the same memory and enters
 * through `runNativeWasmThread`, never `_initialize`.
 *
 * This file imports nothing and uses only what a Web Worker and Node both
 * provide, so the browser and the Node tests run the same host code.
 */

/**
 * The shared memory's initial size in 64 KiB pages, 2 MiB. The engine is
 * linked with exactly this initial size (`--initial-memory`), so a host can
 * create its memory without reading the module; a mismatch fails instantiation.
 */
export const NATIVE_WASM_THREADS_INITIAL_MEMORY_PAGES = 32;

/** The shared memory's maximum in 64 KiB pages, 4 GiB: the wasm32 limit the engine is linked for. */
export const NATIVE_WASM_THREADS_MAXIMUM_MEMORY_PAGES = 65536;

/**
 * The shared memory every instance of one engine runs on. A smaller maximum
 * caps how far the engine can grow; an allocation past it traps the thread
 * that made it.
 */
export function createNativeWasmThreadMemory(maximumPages = NATIVE_WASM_THREADS_MAXIMUM_MEMORY_PAGES) {
    return new WebAssembly.Memory({
        initial: NATIVE_WASM_THREADS_INITIAL_MEMORY_PAGES,
        maximum: maximumPages,
        shared: true,
    });
}

export interface INativeWasmThreadImportsOptions {
    memory: WebAssembly.Memory;
    /**
     * Starts a host thread that instantiates the module on `memory` and calls
     * `runNativeWasmThread` with a new thread id and `startArg`. It must not
     * wait for the thread to run. Returns that thread id, unique among the
     * engine's live threads and in 1..=0x1FFFFFFF, or a negative number when
     * no thread can be started.
     */
    spawnThread: (startArg: number) => number;
    /** Receives text the engine writes to stdout or stderr, such as a panic message. */
    writeOutput: (text: string) => void;
}

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_EINVAL = 28;
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
/** `crypto.getRandomValues` fills at most this many bytes per call. */
const RANDOM_CHUNK_BYTES = 65536;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Milliseconds since the epoch as integer nanoseconds. `timeOrigin + now()`
 * also serves as the monotonic clock: it never goes back within a thread, and
 * unlike `now()` alone it shares one origin across the engine's threads, so a
 * duration measured from one thread's start to another thread's end holds.
 */
function nowNanoseconds() {
    const milliseconds = performance.timeOrigin + performance.now();
    const whole = Math.floor(milliseconds);
    return BigInt(whole) * NANOSECONDS_PER_MILLISECOND + BigInt(Math.round((milliseconds - whole) * 1e6));
}

/**
 * The imports one instance of a threaded engine takes: its shared memory, the
 * WASI calls Rust's standard library makes on this target, and the thread
 * spawn call. Make one set per instance.
 */
export function createNativeWasmThreadImports({
    memory,
    spawnThread,
    writeOutput,
}: INativeWasmThreadImportsOptions): WebAssembly.Imports {
    // The buffer object changes when the memory grows: read it on every call.
    const view = () => new DataView(memory.buffer);
    const decoder = new TextDecoder();
    // WASM passes addresses and lengths as signed 32-bit numbers: one past
    // 2 GiB arrives negative, so each is read back as unsigned.
    const unsigned = (value: number) => value >>> 0;
    return {
        env: {memory},
        wasi_snapshot_preview1: {
            clock_time_get(clockId: number, _precision: bigint, timePointer: number) {
                if (clockId !== WASI_CLOCK_REALTIME && clockId !== WASI_CLOCK_MONOTONIC) return WASI_EINVAL;
                view().setBigUint64(unsigned(timePointer), nowNanoseconds(), true);
                return WASI_ESUCCESS;
            },
            fd_write(fd: number, iovecs: number, iovecCount: number, writtenPointer: number) {
                if (fd !== 1 && fd !== 2) return WASI_EBADF;
                const data = view();
                let written = 0;
                let text = '';
                for (let index = 0; index < unsigned(iovecCount); index += 1) {
                    const pointer = data.getUint32(unsigned(iovecs) + index * 8, true);
                    const length = data.getUint32(unsigned(iovecs) + index * 8 + 4, true);
                    // Decoders reject shared views; decode a private copy.
                    text += decoder.decode(new Uint8Array(memory.buffer, pointer, length).slice(), {stream: true});
                    written += length;
                }
                if (text) writeOutput(text);
                data.setUint32(unsigned(writtenPointer), written, true);
                return WASI_ESUCCESS;
            },
            sched_yield: () => WASI_ESUCCESS,
            random_get(pointer: number, length: number) {
                // getRandomValues rejects shared views; fill a private array and copy.
                for (let offset = 0; offset < unsigned(length); offset += RANDOM_CHUNK_BYTES) {
                    const chunk = crypto.getRandomValues(new Uint8Array(Math.min(RANDOM_CHUNK_BYTES, unsigned(length) - offset)));
                    new Uint8Array(memory.buffer, unsigned(pointer) + offset, chunk.byteLength).set(chunk);
                }
                return WASI_ESUCCESS;
            },
            environ_get: () => WASI_ESUCCESS,
            environ_sizes_get(countPointer: number, sizePointer: number) {
                const data = view();
                data.setUint32(unsigned(countPointer), 0, true);
                data.setUint32(unsigned(sizePointer), 0, true);
                return WASI_ESUCCESS;
            },
            proc_exit(code: number) {
                throw new Error(`The threaded WASM engine exited with code ${code}`);
            },
        },
        wasi: {'thread-spawn': (startArg: number) => spawnThread(startArg)},
    };
}

/**
 * Marks the engine faulted: one of its threads died. The engine reads the
 * cell at `faultPointer` (its thread fault export) while a request waits, and
 * returns its fault code instead of waiting forever.
 */
export function reportNativeWasmThreadFault(memory: WebAssembly.Memory, faultPointer: number) {
    const cells = new Int32Array(memory.buffer);
    Atomics.store(cells, faultPointer >>> 2, 1);
    Atomics.notify(cells, faultPointer >>> 2);
}

export interface INativeWasmThreadStart {
    module: WebAssembly.Module;
    imports: WebAssembly.Imports;
    memory: WebAssembly.Memory;
    /** The engine's thread fault cell, read from the main instance. */
    faultPointer: number;
    threadId: number;
    startArg: number;
    /**
     * Receives what ended the thread, a trap or a failed instantiation, before
     * the engine is marked faulted: the place to record why it died.
     */
    onTrap?: (error: unknown) => void;
}

/**
 * Runs one engine thread on the calling host thread until it returns. A trap
 * or a failed instantiation marks the engine faulted before it is rethrown,
 * so a request waiting on this thread fails instead of hanging.
 */
export function runNativeWasmThread({
    module,
    imports,
    memory,
    faultPointer,
    threadId,
    startArg,
    onTrap,
}: INativeWasmThreadStart) {
    try {
        const instance = new WebAssembly.Instance(module, imports);
        const start = instance.exports.wasi_thread_start;
        if (typeof start !== 'function') throw new Error('The threaded WASM engine has no wasi_thread_start export');
        start(threadId, startArg);
    } catch (error) {
        try {
            onTrap?.(error);
        } catch {
            // A failing observer must not hide why the thread died.
        }
        reportNativeWasmThreadFault(memory, faultPointer);
        throw error;
    }
}
