const DEFAULT_WASM_STALL_TIMEOUT_MS = 30_000;
const WASM_CONTENT_TYPE = 'application/wasm';

function servesWasmContentType(response: Response) {
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.split(';', 1)[0]?.trim().toLowerCase() === WASM_CONTENT_TYPE;
}

function createWasmStallError(timeoutMs: number) {
    const error = new Error(`The WASM module download stalled: no data arrived for ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
}

/**
 * Fetches and instantiates a WASM module. The load is abandoned only when the
 * server sends nothing for `stallTimeoutMs`. A slow connection that keeps
 * delivering bytes finishes however long the whole download takes; compiling
 * after the last byte has no deadline.
 */
export async function loadWasmWithDeadline(
    url: string,
    imports: WebAssembly.Imports = {},
    stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS,
) {
    const abortController = new AbortController();
    const watch: {
        settled: boolean;
        timer: ReturnType<typeof setTimeout> | null;
        reader: ReadableStreamDefaultReader<Uint8Array> | null;
    } = {
        settled: false,
        timer: null,
        reader: null,
    };
    let rejectStalled: (error: Error) => void = () => undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
        rejectStalled = reject;
    });
    const disarm = () => {
        if (watch.timer !== null) clearTimeout(watch.timer);
        watch.timer = null;
    };
    const arm = () => {
        disarm();
        if (watch.settled) return;
        watch.timer = setTimeout(() => {
            const error = createWasmStallError(stallTimeoutMs);
            abortController.abort(error);
            rejectStalled(error);
        }, stallTimeoutMs);
    };

    arm();
    try {
        return await Promise.race([
            (async () => {
                const response = await fetch(url, {signal: abortController.signal});
                if (!response.ok) {
                    throw new Error(`WASM module request failed with status ${response.status}`);
                }
                // A clone observes the download, so the original response keeps
                // its URL for streaming compilation and the browser's code cache.
                const reader = response.clone().body?.getReader() ?? null;
                watch.reader = reader;
                if (reader) {
                    void (async () => {
                        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                            arm();
                        }
                        disarm();
                    })().catch(() => undefined);
                } else {
                    disarm();
                }
                // Streaming compilation requires the wasm MIME type anyway, so branching
                // on it up front avoids a doomed streaming attempt whose failure could
                // otherwise leave the body consumed before the buffered fallback reads it.
                if (typeof WebAssembly.instantiateStreaming === 'function' && servesWasmContentType(response)) {
                    return WebAssembly.instantiateStreaming(response, imports);
                }
                const bytes = await response.arrayBuffer();
                return WebAssembly.instantiate(bytes, imports);
            })(),
            stalled,
        ]);
    } finally {
        watch.settled = true;
        disarm();
        // Release the observing branch; a failed load leaves it unread.
        void watch.reader?.cancel().catch(() => undefined);
    }
}
