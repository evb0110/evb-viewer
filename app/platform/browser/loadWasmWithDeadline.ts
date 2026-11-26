const DEFAULT_WASM_STALL_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;

/**
 * The linear memory above which a thread lets go of its cached instance of a WASM tool once a request on it
 * ends. WebAssembly memory never shrinks, so without this one large document's heap growth stays held for the
 * rest of the session. 256 MiB on a device that reports more than 4 GiB, 128 MiB otherwise: the performance
 * profile treats an unreported device as a low-memory one too.
 */
export function wasmMemoryHighWaterBytes(deviceMemory = (globalThis.navigator as (Navigator & {deviceMemory?: number}) | undefined)?.deviceMemory) {
    return (deviceMemory ?? 4) > 4 ? 256 * MIB : 128 * MIB;
}

/** Whether an instance's memory grew past `wasmMemoryHighWaterBytes`, so its thread should load a fresh one. */
export const exceedsWasmMemoryHighWater = (memory: WebAssembly.Memory) => memory.buffer.byteLength > wasmMemoryHighWaterBytes();

// The SHA-256 of each module this context compiled, by URL path, so
// provenance can name the bytes that actually run rather than a later download.
const loadedWasmDigests = new Map<string, Promise<string>>();

// Compiled modules cached per thread (or received via structured clone from
// the main thread) so worker pools and post-high-water reloads instantiate
// without re-fetching or recompiling.
const precompiledWasmModules = new Map<string, WebAssembly.Module>();
const sharedCompiledWasmPromises = new Map<string, Promise<{
    module: WebAssembly.Module;
    digest: string | null;
}>>();

export const PRECOMPILED_WASM_MODULE_MESSAGE_TYPE = 'evb:precompiled-wasm-module';

export interface IPrecompiledWasmModuleMessage {
    type: typeof PRECOMPILED_WASM_MODULE_MESSAGE_TYPE;
    path: string;
    module: WebAssembly.Module;
    digest: string | null;
}

function isRealWasmModule(value: unknown): value is WebAssembly.Module {
    return typeof WebAssembly !== 'undefined'
        && typeof WebAssembly.Module === 'function'
        && value instanceof WebAssembly.Module;
}

/** Registers a precompiled `WebAssembly.Module` for `path` in this thread. */
export function registerPrecompiledWasmModule(
    path: string,
    module: WebAssembly.Module,
    digest?: string | null,
) {
    const key = wasmPath(path);
    precompiledWasmModules.set(key, module);
    if (typeof digest === 'string' && digest.length > 0) {
        loadedWasmDigests.set(key, Promise.resolve(digest));
    }
}

/**
 * Handles a main-thread preload message carrying a compiled `WebAssembly.Module`.
 * Returns true when `data` was a preload message and has been consumed.
 */
export function handlePrecompiledWasmModuleMessage(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const record = data as Record<string, unknown>;
    if (record.type !== PRECOMPILED_WASM_MODULE_MESSAGE_TYPE) return false;
    if (typeof record.path === 'string' && isRealWasmModule(record.module)) {
        registerPrecompiledWasmModule(
            record.path,
            record.module,
            typeof record.digest === 'string' ? record.digest : null,
        );
    }
    return true;
}

export function resolveWasmUrl(path: string) {
    const baseHref = globalThis.location?.href
        ?? (globalThis as {self?: {location?: {href?: string}}}).self?.location?.href;
    return baseHref ? new URL(path, baseHref).toString() : path;
}

/**
 * Compiles `path` once in this context and caches the resulting `WebAssembly.Module`
 * and SHA-256 digest for sharing across worker pool clones. A failed compile is
 * evicted so the next caller retries.
 */
export function compileWasmModuleOnce(
    path: string,
    stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS,
) {
    const key = wasmPath(path);
    const existing = sharedCompiledWasmPromises.get(key);
    if (existing) return existing;
    const pending = (async () => {
        const url = resolveWasmUrl(path);
        const module = await compileWasmWithDeadline(url, stallTimeoutMs);
        const digest = await readLoadedWasmDigest(url)?.catch(() => null) ?? null;
        if (isRealWasmModule(module)) {
            registerPrecompiledWasmModule(key, module, digest);
        }
        return {
            module,
            digest,
        };
    })();
    sharedCompiledWasmPromises.set(key, pending);
    pending.catch(() => {
        if (sharedCompiledWasmPromises.get(key) === pending) {
            sharedCompiledWasmPromises.delete(key);
        }
    });
    return pending;
}

/**
 * Compiles each WASM `path` once on the caller's thread and posts the compiled
 * `WebAssembly.Module` to `worker` via structured clone so worker clones never
 * recompile. Failures are ignored so the worker falls back to its own load path.
 */
export function postPrecompiledWasmModules(worker: Worker, paths: readonly string[]) {
    if (
        typeof WebAssembly === 'undefined'
        || typeof WebAssembly.Module !== 'function'
        || typeof fetch !== 'function'
        || typeof globalThis.location?.href !== 'string'
        || !/^https?:/iu.test(globalThis.location.href)
    ) {
        return;
    }
    for (const path of paths) {
        void compileWasmModuleOnce(path).then(({module, digest}) => {
            if (!isRealWasmModule(module)) return;
            try {
                worker.postMessage({
                    type: PRECOMPILED_WASM_MODULE_MESSAGE_TYPE,
                    path,
                    module,
                    digest,
                } satisfies IPrecompiledWasmModuleMessage);
            } catch {
                // Worker may already have terminated; safe to ignore.
            }
        }).catch(() => undefined);
    }
}

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

interface IWasmBuild<TResult> {
    /** Undefined where the browser lacks the streaming call; the build then buffers. */
    streaming: ((response: Response) => Promise<TResult>) | undefined;
    buffered: (bytes: ArrayBuffer) => Promise<TResult>;
}

/**
 * Fetches and instantiates a WASM module. The load is abandoned only when the
 * server sends nothing for `stallTimeoutMs`. A slow connection that keeps
 * delivering bytes finishes however long the whole download takes; compiling
 * after the last byte has no deadline.
 */
export function loadWasmWithDeadline(
    url: string,
    imports: WebAssembly.Imports = {},
    stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS,
) {
    const key = wasmPath(url);
    const precompiled = precompiledWasmModules.get(key);
    if (precompiled) {
        return WebAssembly.instantiate(precompiled, imports).then(instance => ({
            instance,
            module: precompiled,
        }));
    }
    return fetchWasmWithDeadline(url, stallTimeoutMs, {
        streaming: typeof WebAssembly.instantiateStreaming === 'function'
            ? response => WebAssembly.instantiateStreaming(response, imports)
            : undefined,
        buffered: bytes => WebAssembly.instantiate(bytes, imports),
    }).then((result) => {
        if ('module' in result && isRealWasmModule(result.module)) {
            precompiledWasmModules.set(key, result.module);
        }
        return result;
    });
}

/** Fetches and compiles a WASM module under `loadWasmWithDeadline`'s stall deadline, for a host that instantiates it several times. */
export function compileWasmWithDeadline(url: string, stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS) {
    const key = wasmPath(url);
    const precompiled = precompiledWasmModules.get(key);
    if (precompiled) {
        return Promise.resolve(precompiled);
    }
    return fetchWasmWithDeadline(url, stallTimeoutMs, {
        streaming: typeof WebAssembly.compileStreaming === 'function'
            ? response => WebAssembly.compileStreaming(response)
            : undefined,
        buffered: bytes => WebAssembly.compile(bytes),
    }).then((module) => {
        if (isRealWasmModule(module)) {
            precompiledWasmModules.set(key, module);
        }
        return module;
    });
}

async function fetchWasmWithDeadline<TResult>(url: string, stallTimeoutMs: number, build: IWasmBuild<TResult>) {
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
                if (build.streaming && servesWasmContentType(response)) {
                    const built = await build.streaming(response);
                    if (observed !== null) loadedWasmDigests.set(wasmPath(url), observed);
                    return built;
                }
                const bytes = await response.arrayBuffer();
                const built = await build.buffered(bytes);
                loadedWasmDigests.set(wasmPath(url), sha256Hex([new Uint8Array(bytes)]));
                return built;
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
