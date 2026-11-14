const DEFAULT_WASM_STALL_TIMEOUT_MS = 30_000;

// The SHA-256 of each module this context compiled, by URL path, so
// provenance can name the bytes that actually run rather than a later download.
const loadedWasmDigests = new Map<string, Promise<string>>();

async function sha256Hex(chunks: readonly Uint8Array[]) {
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

const wasmPath = (url: string) => new URL(url, globalThis.location?.href ?? 'file:///').pathname;

/** The SHA-256 of the module last compiled from `url` in this context, if any. */
export function readLoadedWasmDigest(url: string) {
    return loadedWasmDigests.get(wasmPath(url)) ?? null;
}
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
                let observed: Promise<string> | null = null;
                if (reader) {
                    observed = (async () => {
                        const chunks: Uint8Array[] = [];
                        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                            chunks.push(chunk.value);
                            arm();
                        }
                        disarm();
                        return sha256Hex(chunks);
                    })();
                    observed.catch(() => undefined);
                } else {
                    disarm();
                }
                // Streaming compilation requires the wasm MIME type anyway, so branching
                // on it up front avoids a doomed streaming attempt whose failure could
                // otherwise leave the body consumed before the buffered fallback reads it.
                if (typeof WebAssembly.instantiateStreaming === 'function' && servesWasmContentType(response)) {
                    const instantiated = await WebAssembly.instantiateStreaming(response, imports);
                    if (observed !== null) loadedWasmDigests.set(wasmPath(url), observed);
                    return instantiated;
                }
                const bytes = await response.arrayBuffer();
                const instantiated = await WebAssembly.instantiate(bytes, imports);
                loadedWasmDigests.set(wasmPath(url), sha256Hex([new Uint8Array(bytes)]));
                return instantiated;
            })(),
            stalled,
        ]);
    } catch (error) {
        // Release the observing branch; a failed load leaves it unread. A
        // successful load lets it finish, as it is the module's digest.
        void watch.reader?.cancel().catch(() => undefined);
        throw error;
    } finally {
        watch.settled = true;
        disarm();
    }
}
