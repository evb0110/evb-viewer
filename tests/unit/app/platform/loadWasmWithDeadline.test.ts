import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createHash} from 'node:crypto';
import {
    loadWasmWithDeadline,
    readLoadedWasmDigest,
    wasmMemoryHighWaterBytes,
} from '@app/platform/browser/loadWasmWithDeadline';
import {FILE_REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import {WASM_REQUEST_ALLOCATION_ABI_VERSION} from '@contracts/getCheckedWasmMemoryView';

const WASM_HEADER = Uint8Array.of(0, 97, 115, 109);

function controlledBody() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(streamController) {
        controller = streamController;
    }});
    return {
        body,
        controller,
    };
}

function stubFetch(response: Response) {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function stubWebAssembly() {
    const compiled = {
        instance: {},
        module: {},
    };
    const instantiateStreaming = vi.fn(async (source: Response) => {
        await source.arrayBuffer();
        return compiled;
    });
    const instantiate = vi.fn(async (_bytes: ArrayBuffer) => compiled);
    vi.stubGlobal('WebAssembly', {
        instantiate,
        instantiateStreaming,
    });
    return {
        compiled,
        instantiate,
        instantiateStreaming,
    };
}

describe('loadWasmWithDeadline', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('compiles the response stream when the server labels it as WASM', async () => {
        const {
            compiled,
            instantiate,
            instantiateStreaming,
        } = stubWebAssembly();
        const response = new Response(WASM_HEADER, {headers: {'content-type': 'application/wasm'}});
        stubFetch(response);

        await expect(loadWasmWithDeadline('/streamed.wasm')).resolves.toBe(compiled);
        expect(instantiateStreaming).toHaveBeenCalledWith(response, {});
        expect(instantiate).not.toHaveBeenCalled();
    });

    it('names the bytes each path compiled by their SHA-256', async () => {
        stubWebAssembly();
        const expected = createHash('sha256').update(WASM_HEADER).digest('hex');
        stubFetch(new Response(WASM_HEADER, {headers: {'content-type': 'application/wasm'}}));
        await loadWasmWithDeadline('/digest-streamed.wasm');
        stubFetch(new Response(WASM_HEADER, {headers: {'content-type': 'application/octet-stream'}}));
        await loadWasmWithDeadline('/digest-buffered.wasm');

        await expect(readLoadedWasmDigest('/digest-streamed.wasm')).resolves.toBe(expected);
        await expect(readLoadedWasmDigest('/digest-buffered.wasm')).resolves.toBe(expected);
        expect(readLoadedWasmDigest('/never-loaded.wasm')).toBeNull();
    });

    it('falls back to the buffered path when the content type is not WASM', async () => {
        const {
            compiled,
            instantiate,
            instantiateStreaming,
        } = stubWebAssembly();
        stubFetch(new Response(WASM_HEADER, {headers: {'content-type': 'application/octet-stream'}}));

        await expect(loadWasmWithDeadline('/mislabelled.wasm')).resolves.toBe(compiled);
        expect(instantiateStreaming).not.toHaveBeenCalled();
        expect(new Uint8Array(instantiate.mock.calls[0]![0])).toEqual(WASM_HEADER);
    });

    it('falls back to the buffered path when streaming instantiation is unavailable', async () => {
        const compiled = {
            instance: {},
            module: {},
        };
        const instantiate = vi.fn(async () => compiled);
        vi.stubGlobal('WebAssembly', {instantiate});
        stubFetch(new Response(WASM_HEADER, {headers: {'content-type': 'application/wasm'}}));

        await expect(loadWasmWithDeadline('/unsupported.wasm')).resolves.toBe(compiled);
        expect(instantiate).toHaveBeenCalled();
    });

    it('does not re-read a consumed body when a labelled WASM stream fails to compile', async () => {
        const compileError = new Error('compile failed');
        const instantiate = vi.fn();
        vi.stubGlobal('WebAssembly', {
            instantiate,
            instantiateStreaming: vi.fn(async () => {
                throw compileError;
            }),
        });
        stubFetch(new Response(WASM_HEADER, {headers: {'content-type': 'application/wasm; charset=binary'}}));

        await expect(loadWasmWithDeadline('/corrupt.wasm')).rejects.toBe(compileError);
        expect(instantiate).not.toHaveBeenCalled();
    });

    it('finishes a slow download that keeps sending bytes past the stall window', async () => {
        vi.useFakeTimers();
        const {compiled} = stubWebAssembly();
        const {
            body,
            controller,
        } = controlledBody();
        const fetchMock = stubFetch(new Response(body, {headers: {'content-type': 'application/wasm'}}));

        const load = loadWasmWithDeadline('/slow.wasm', {}, 50);
        // Ten chunks 40ms apart take 400ms in all, eight times the stall window.
        for (let index = 0; index < 10; index += 1) {
            await vi.advanceTimersByTimeAsync(40);
            controller.enqueue(Uint8Array.of(index));
        }
        controller.close();

        await expect(load).resolves.toBe(compiled);
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts a download that stops sending bytes', async () => {
        vi.useFakeTimers();
        stubWebAssembly();
        const {
            body,
            controller,
        } = controlledBody();
        const fetchMock = stubFetch(new Response(body, {headers: {'content-type': 'application/wasm'}}));

        const load = loadWasmWithDeadline('/stopped.wasm', {}, 50);
        const rejection = load.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(40);
        controller.enqueue(WASM_HEADER);
        await vi.advanceTimersByTimeAsync(50);

        await expect(rejection).resolves.toMatchObject({
            name: 'TimeoutError',
            message: 'The WASM module download stalled: no data arrived for 50ms',
        });
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it('aborts a request whose response never starts', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        }));
        vi.stubGlobal('fetch', fetchMock);

        const rejection = loadWasmWithDeadline('/silent.wasm', {}, 25).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(25);

        await expect(rejection).resolves.toMatchObject({name: 'TimeoutError'});
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });
});

const WASM_PAGE_BYTES = 64 * 1024;
const TOOL_POINTER = 16;

/**
 * Exports of a tool built on the request ABI (`evb_native_support::wasm_request_allocation`) over real linear
 * memory: `run` answers its request back, first growing the memory past the high-water mark when asked to.
 */
function memoryGrowingExports(prefix: string, growOn: (memory: WebAssembly.Memory, pointer: number) => boolean) {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 65_536});
    let outputLength = 0;
    return {
        memory,
        evb_wasm_request_allocation_abi_version: () => WASM_REQUEST_ALLOCATION_ABI_VERSION,
        [`${prefix}_alloc`]: () => TOOL_POINTER,
        [`${prefix}_free`]: () => undefined,
        [`${prefix}_run`]: (pointer: number, length: number) => {
            if (growOn(memory, pointer)) {
                memory.grow(Math.ceil((wasmMemoryHighWaterBytes() + 1 - memory.buffer.byteLength) / WASM_PAGE_BYTES));
            }
            outputLength = length;
            return 0;
        },
        [`${prefix}_output_ptr`]: () => TOOL_POINTER,
        [`${prefix}_output_len`]: () => outputLength,
        [`${prefix}_error_ptr`]: () => 0,
        [`${prefix}_error_len`]: () => 0,
    };
}

/** Instantiation of the module the loaders fetch, one fresh instance of `create`'s exports each time. */
function stubInstances(create: () => WebAssembly.Exports) {
    const instances: WebAssembly.Exports[] = [];
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async () => {
        const exports = create();
        instances.push(exports);
        return {instance: {exports}, module: {}};
    }) as unknown as typeof WebAssembly.instantiate);
    return instances;
}

// WebAssembly memory never shrinks: a thread's cached tool lets go of an instance one large request grew, once that
// request has ended, without ending a request that still holds it.
describe('WASM memory high-water release', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('is 256 MiB on a device that reports more than 4 GiB and 128 MiB otherwise', () => {
        expect(wasmMemoryHighWaterBytes(8)).toBe(256 * 1024 * 1024);
        expect(wasmMemoryHighWaterBytes(4)).toBe(128 * 1024 * 1024);
        expect(wasmMemoryHighWaterBytes(undefined)).toBe(128 * 1024 * 1024);
    });

    it('loads a fresh native tool after a call grows one past the mark, and finishes the call admitted beside it', async () => {
        const instances = stubInstances(() => memoryGrowingExports('evb_test', (memory, pointer) => new Uint8Array(memory.buffer)[pointer] === 1));
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const tool = createNativeWasmToolLoader({
            path: '/wasm/evb-test.wasm',
            prefix: 'evb_test',
            runExport: 'run',
            label: 'test tool',
            maxRequestBytes: 1024,
            maxOutputBytes: 1024,
        });

        // Both requests hold the one instance; the first grows it past the mark.
        const [grown, beside] = await Promise.all([tool.call(Uint8Array.of(1, 7)), tool.call(Uint8Array.of(0, 8))]);
        expect(grown).toEqual({status: 'succeeded', output: Uint8Array.of(1, 7)});
        expect(beside).toEqual({status: 'succeeded', output: Uint8Array.of(0, 8)});
        expect(instances).toHaveLength(1);
        expect((instances[0]!.memory as WebAssembly.Memory).buffer.byteLength).toBeGreaterThan(wasmMemoryHighWaterBytes());

        expect(await tool.call(Uint8Array.of(0, 9))).toEqual({status: 'succeeded', output: Uint8Array.of(0, 9)});
        expect(instances).toHaveLength(2);
        // An instance below the mark stays this thread's.
        await tool.call(Uint8Array.of(0, 10));
        expect(instances).toHaveLength(2);
    });

    it('lets the page engine verify an edit on the engine that wrote it after that engine passed the mark', async () => {
        const GROW = 99;
        const instances = stubInstances(() => memoryGrowingExports('evb_pdf_page_ops', (memory, pointer) => (
            new DataView(memory.buffer).getUint32(pointer + FILE_REQUEST_HEADER.operation, true) === GROW
        )));
        const {loadPdfPageOpsWasm, runFileRequest} = await import('@app/platform/browser/pdfPageEngine');

        const writer = await loadPdfPageOpsWasm();
        expect(runFileRequest(writer, {operation: GROW, sourceCount: 0})).toBeInstanceOf(Uint8Array);
        // The written edit's verification still runs on its engine, which the thread no longer offers.
        expect(runFileRequest(writer, {operation: 1, sourceCount: 0})).toBeInstanceOf(Uint8Array);
        const next = await loadPdfPageOpsWasm();
        expect(next).not.toBe(writer);
        expect(instances).toHaveLength(2);
        runFileRequest(next, {operation: 1, sourceCount: 0});
        expect(await loadPdfPageOpsWasm()).toBe(next);
    });

    it('keeps the page engine that replaced a retired one when a file request still holding the retired one ends, past the mark or trapped', async () => {
        const GROW = 99;
        let trapping = false;
        const instances = stubInstances(() => memoryGrowingExports('evb_pdf_page_ops', (memory, pointer) => {
            if (trapping) throw new WebAssembly.RuntimeError('unreachable');
            return new DataView(memory.buffer).getUint32(pointer + FILE_REQUEST_HEADER.operation, true) === GROW;
        }));
        const {loadPdfPageOpsWasm, runFileRequest} = await import('@app/platform/browser/pdfPageEngine');

        const retired = await loadPdfPageOpsWasm();
        expect(runFileRequest(retired, {operation: GROW, sourceCount: 0})).toBeInstanceOf(Uint8Array);
        const replacement = await loadPdfPageOpsWasm();
        expect(replacement).not.toBe(retired);

        // A request that held the retired engine succeeds on it, which is still past the mark.
        expect(runFileRequest(retired, {operation: 1, sourceCount: 0})).toBeInstanceOf(Uint8Array);
        expect(await loadPdfPageOpsWasm()).toBe(replacement);
        // Another traps on it.
        trapping = true;
        expect(runFileRequest(retired, {operation: 1, sourceCount: 0})).toMatchObject({status: 'failed', error: {code: 'too-large'}});
        trapping = false;
        expect(await loadPdfPageOpsWasm()).toBe(replacement);
        expect(instances).toHaveLength(2);
    });

    it('keeps the page engine that replaced a retired one when a request still holding the retired one traps', async () => {
        const GROW = 99;
        let trapping = false;
        const instances = stubInstances(() => memoryGrowingExports('evb_pdf_page_ops', (memory, pointer) => {
            if (trapping) throw new WebAssembly.RuntimeError('unreachable');
            return new DataView(memory.buffer).getUint32(pointer + FILE_REQUEST_HEADER.operation, true) === GROW;
        }));
        const {loadPdfPageOpsWasm, runFileRequest} = await import('@app/platform/browser/pdfPageEngine');
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');

        let admit!: () => void;
        const admitted = new Promise<void>(resolve => void (admit = resolve));
        let held!: () => void;
        const holding = new Promise<void>(resolve => void (held = resolve));
        // A byte request takes the engine, then waits for its caller before entering it.
        const request = tryRunBrowserPageOpsWithWasm('decrypt', {data: Uint8Array.of(1), password: ''}, async () => {
            held();
            await admitted;
        });
        await holding;
        const retired = await loadPdfPageOpsWasm();
        runFileRequest(retired, {operation: GROW, sourceCount: 0});
        const replacement = await loadPdfPageOpsWasm();
        expect(replacement).not.toBe(retired);

        trapping = true;
        admit();
        expect(await request).toMatchObject({status: 'failed', error: {code: 'too-large'}});
        trapping = false;
        expect(await loadPdfPageOpsWasm()).toBe(replacement);
        expect(instances).toHaveLength(2);
    });
});

const ERROR_POINTER = 64;

/**
 * Exports of a threaded build's main instance over a shared memory: `run`
 * answers with `code`, writing `envelope` as the error first when given.
 */
function sharedMemoryExports(prefix: string, code: number, envelope?: string) {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 16, shared: true});
    const encoded = new TextEncoder().encode(envelope ?? '');
    const free = vi.fn();
    return {
        free,
        exports: {
            memory,
            evb_wasm_request_allocation_abi_version: () => WASM_REQUEST_ALLOCATION_ABI_VERSION,
            [`${prefix}_alloc`]: () => TOOL_POINTER,
            [`${prefix}_free`]: free,
            [`${prefix}_run`]: () => {
                new Uint8Array(memory.buffer, ERROR_POINTER, encoded.byteLength).set(encoded);
                return code;
            },
            [`${prefix}_output_ptr`]: () => 0,
            [`${prefix}_output_len`]: () => 0,
            [`${prefix}_error_ptr`]: () => ERROR_POINTER,
            [`${prefix}_error_len`]: () => encoded.byteLength,
        },
    };
}

/** Browsers' TextDecoder refuses a view of shared memory; Node's does not. */
class BrowserTextDecoder extends TextDecoder {
    public override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
        const buffer = input && 'buffer' in input ? input.buffer : input;
        if (buffer instanceof SharedArrayBuffer) throw new TypeError('The provided ArrayBufferView value must not be shared.');
        return super.decode(input, options);
    }
}

const TEST_TOOL = {
    path: '/wasm/evb-test.wasm',
    prefix: 'evb_test',
    runExport: 'run',
    label: 'test tool',
    maxRequestBytes: 1024,
    maxOutputBytes: 1024,
};

// A threaded build runs on shared memory, and one of its threads can die.
describe('a native tool on a threaded build', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('reports a dead thread as a panic, frees nothing in the faulted instance and loads a fresh one', async () => {
        const made: Array<ReturnType<typeof sharedMemoryExports>> = [];
        const instances = stubInstances(() => {
            const tool = sharedMemoryExports('evb_test', made.length === 0 ? -2 : -1, '{"code":"invalid-request","message":"bad page"}');
            made.push(tool);
            return tool.exports;
        });
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const tool = createNativeWasmToolLoader(TEST_TOOL);

        expect(await tool.call(Uint8Array.of(1))).toMatchObject({status: 'failed', error: {code: 'panic'}});
        // The instance may hold the allocator's lock: freeing could wait forever.
        expect(made[0]!.free).not.toHaveBeenCalled();
        expect(await tool.call(Uint8Array.of(2))).toMatchObject({status: 'failed', error: {code: 'invalid-request', message: 'bad page'}});
        expect(instances).toHaveLength(2);
        expect(made[1]!.free).toHaveBeenCalledOnce();
    });

    it('reads an error envelope out of shared memory as a browser can', async () => {
        vi.stubGlobal('TextDecoder', BrowserTextDecoder);
        stubInstances(() => sharedMemoryExports('evb_test', -1, '{"code":"too-large","message":"The page is too large"}').exports);
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');

        expect(await createNativeWasmToolLoader(TEST_TOOL).call(Uint8Array.of(1))).toEqual({
            status: 'failed',
            error: {code: 'too-large', message: 'The page is too large'},
        });
    });
});

/**
 * A threaded build's host side with fake thread workers: each answers the
 * load and start messages as `nativeWasmThread.worker.ts` does, or reports
 * that its thread could not be instantiated.
 */
function stubThreadedBuild({runCode, failThreadStart = false}: {runCode: () => number; failThreadStart?: boolean}) {
    const threadWorkers: Array<{name: string; starts: Array<{threadId: number; faultPointer: number}>; terminated: boolean; fault: (message: string) => void}> = [];
    class ThreadWorker extends EventTarget {
        public readonly record: typeof threadWorkers[number];
        public constructor(_url: URL, options: {name: string}) {
            super();
            this.record = {
                name: options.name,
                starts: [],
                terminated: false,
                fault: message => this.reply({type: 'fault', message}),
            };
            threadWorkers.push(this.record);
        }

        public postMessage(message: {type: string; threadId: number; faultPointer: number}) {
            if (message.type === 'load') this.reply({type: 'ready'});
            if (message.type === 'start') {
                this.record.starts.push({threadId: message.threadId, faultPointer: message.faultPointer});
                this.reply(failThreadStart ? {type: 'failed', message: 'RangeError: too many tables'} : {type: 'started'});
            }
        }

        public terminate() {
            this.record.terminated = true;
        }

        private reply(data: unknown) {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data})));
        }
    }
    vi.stubGlobal('Worker', ThreadWorker);
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    const compile = vi.spyOn(WebAssembly, 'compile').mockImplementation(async () => ({}) as WebAssembly.Module);
    const free = vi.fn();
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (_module: unknown, imports: WebAssembly.Imports) => {
        const memory = (imports.env as {memory: WebAssembly.Memory}).memory;
        const spawn = (imports.wasi as Record<string, (startArg: number) => number>)['thread-spawn']!;
        return {exports: {
            memory,
            _initialize: () => undefined,
            evb_wasm_request_allocation_abi_version: () => WASM_REQUEST_ALLOCATION_ABI_VERSION,
            evb_test_thread_fault_ptr: () => 8,
            evb_test_start_threads: (count: number) => {
                for (let index = 0; index < count; index += 1) spawn(1000 + index);
                return count;
            },
            evb_test_alloc: () => TOOL_POINTER,
            evb_test_free: free,
            evb_test_run: () => runCode(),
            evb_test_output_ptr: () => TOOL_POINTER,
            evb_test_output_len: () => 1,
            evb_test_error_ptr: () => 0,
            evb_test_error_len: () => 0,
        }};
    }) as unknown as typeof WebAssembly.instantiate);
    return {
        threadWorkers,
        compile,
        free,
    };
}

const THREADED_TEST_TOOL = {
    ...TEST_TOOL,
    threads: {
        path: '/wasm/evb-test-threads.wasm',
        count: 3,
        maximumMemoryPages: 64,
    },
};

describe('a native tool on its threaded build', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('starts each thread once with its own id after the threads report ready, and reuses the instance', async () => {
        const build = stubThreadedBuild({runCode: () => 0});
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const tool = createNativeWasmToolLoader(THREADED_TEST_TOOL);

        expect(await tool.call(Uint8Array.of(1))).toMatchObject({status: 'succeeded'});
        expect(await tool.call(Uint8Array.of(2))).toMatchObject({status: 'succeeded'});
        expect(build.threadWorkers.map(worker => worker.name)).toEqual(Array(3).fill('test tool thread'));
        expect(build.threadWorkers.flatMap(worker => worker.starts)).toEqual([1, 2, 3].map(threadId => ({threadId, faultPointer: 8})));
        expect(build.threadWorkers.some(worker => worker.terminated)).toBe(false);
    });

    it('fails the start when a thread cannot be instantiated, ending every thread', async () => {
        const build = stubThreadedBuild({runCode: () => 0, failThreadStart: true});
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const {NativeWasmThreadStartError} = await import('@app/platform/browser-api/nativeWasmThreadedTool');

        const failed = await createNativeWasmToolLoader(THREADED_TEST_TOOL).call(Uint8Array.of(1)).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(NativeWasmThreadStartError);
        expect((failed as Error).message).toContain('too many tables');
        expect(build.threadWorkers.every(worker => worker.terminated)).toBe(true);
    });

    it('reports a dead thread with its own message, ends the faulted instance\'s threads and starts new ones from the same module', async () => {
        let fault = true;
        const build = stubThreadedBuild({runCode: () => {
            if (!fault) return 0;
            build.threadWorkers[1]!.fault('RuntimeError: memory access out of bounds');
            return -2;
        }});
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const tool = createNativeWasmToolLoader(THREADED_TEST_TOOL);

        const result = await tool.call(Uint8Array.of(1));
        expect(result).toMatchObject({status: 'failed', error: {code: 'panic'}});
        expect(result.status === 'failed' && result.error.message).toContain('memory access out of bounds');
        expect(build.free).not.toHaveBeenCalled();
        expect(build.threadWorkers.every(worker => worker.terminated)).toBe(true);

        fault = false;
        expect(await tool.call(Uint8Array.of(2))).toMatchObject({status: 'succeeded'});
        expect(build.threadWorkers).toHaveLength(6);
        expect(build.compile).toHaveBeenCalledOnce();
    });

    it('treats a module this browser cannot compile as a start failure', async () => {
        stubThreadedBuild({runCode: () => 0});
        vi.spyOn(WebAssembly, 'compile').mockRejectedValue(new WebAssembly.CompileError('invalid opcode: atomics'));
        const {createNativeWasmToolLoader} = await import('@app/platform/browser-api/nativeWasmTool');
        const {NativeWasmThreadStartError} = await import('@app/platform/browser-api/nativeWasmThreadedTool');

        await expect(createNativeWasmToolLoader(THREADED_TEST_TOOL).call(Uint8Array.of(1))).rejects.toBeInstanceOf(NativeWasmThreadStartError);
    });
});
