import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { loadWasmWithDeadline } from '@app/platform/browser-api/loadWasmWithDeadline';

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
