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
