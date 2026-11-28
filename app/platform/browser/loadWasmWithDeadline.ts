import {
    detectBrowserEngine,
    isMobileBrowserUserAgent,
    readNavigatorBrowserMemoryEnvironment,
    type IBrowserMemoryEnvironment,
} from '@app/utils/performanceProfile';
import {HOST_TIER_LOW_CPU_MAX} from '@contracts/hostResourceProfile';
import {
    isRealWasmModule,
    parsePrecompiledWasmModuleMessage,
    PRECOMPILED_WASM_MODULE_MESSAGE_TYPE,
    type IPrecompiledWasmModuleMessage,
} from '@contracts/precompiledWasmModule';
export {PRECOMPILED_WASM_MODULE_MESSAGE_TYPE, type IPrecompiledWasmModuleMessage} from '@contracts/precompiledWasmModule';

const DEFAULT_WASM_STALL_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;
export const WASM_MEMORY_HIGH_WATER_LOW_BYTES = 128 * MIB;
export const WASM_MEMORY_HIGH_WATER_WEBKIT_BYTES = 192 * MIB;
export const WASM_MEMORY_HIGH_WATER_HIGH_BYTES = 256 * MIB;

/**
 * The linear memory above which a thread lets go of its cached instance of a WASM tool once a request on it
 * ends. WebAssembly memory never shrinks, so without this one large document's heap growth stays held for the
 * rest of the session.
 *
 * Differentiates explicit low memory (`deviceMemory <= 4`, mobile, or `<= 2` cores -> 128 MiB) from
 * `deviceMemory === undefined` (Safari/Firefox intentionally omit `navigator.deviceMemory`): desktop Firefox
 * uses 256 MiB like Chromium `> 4 GiB`, while desktop WebKit (and unknown desktop browsers omitting
 * `deviceMemory`) uses 192 MiB to avoid constant WASM churn on 16+ GiB Macs while respecting WebKit's
 * tighter per-tab WASM linear-memory ceiling.
 */
export function wasmMemoryHighWaterBytes(deviceMemory?: number, environment?: Omit<IBrowserMemoryEnvironment, 'deviceMemory'>) {
    const nav = environment ? undefined : readNavigatorBrowserMemoryEnvironment();
    const resolvedDeviceMemory = deviceMemory !== undefined ? deviceMemory : nav?.deviceMemory;
    const userAgent = environment?.userAgent ?? nav?.userAgent;
    const resolvedMaxTouchPoints = environment?.maxTouchPoints ?? nav?.maxTouchPoints;
    const maxTouchPoints = resolvedMaxTouchPoints ?? 0;
    const explicitMobile = environment?.mobile ?? nav?.mobile;
    const mobile = explicitMobile ?? (environment?.userAgent !== undefined ? isMobileBrowserUserAgent(userAgent, maxTouchPoints) : false);
    if (mobile) {
        return WASM_MEMORY_HIGH_WATER_LOW_BYTES;
    }
    const hardwareConcurrency = environment?.hardwareConcurrency ?? nav?.hardwareConcurrency;
    if (
        typeof hardwareConcurrency === 'number' &&
        Number.isFinite(hardwareConcurrency) &&
        hardwareConcurrency > 0 &&
        hardwareConcurrency <= HOST_TIER_LOW_CPU_MAX
    ) {
        return WASM_MEMORY_HIGH_WATER_LOW_BYTES;
    }
    if (typeof resolvedDeviceMemory === 'number' && Number.isFinite(resolvedDeviceMemory) && resolvedDeviceMemory > 0) {
        return resolvedDeviceMemory > 4 ? WASM_MEMORY_HIGH_WATER_HIGH_BYTES : WASM_MEMORY_HIGH_WATER_LOW_BYTES;
    }
    const engine = detectBrowserEngine(userAgent);
    if (engine === 'firefox') {
        return WASM_MEMORY_HIGH_WATER_HIGH_BYTES;
    }
    // WebKit WorkerNavigator omits `maxTouchPoints`, so a Macintosh user agent in a
    // worker cannot distinguish macOS Safari from desktop-UA iPadOS Safari; keep the
    // conservative 128 MiB floor unless desktop WebKit is confirmed.
    if (
        engine === 'webkit' &&
        userAgent !== undefined &&
        /Macintosh/u.test(userAgent) &&
        explicitMobile !== false &&
        typeof resolvedMaxTouchPoints !== 'number'
    ) {
        return WASM_MEMORY_HIGH_WATER_LOW_BYTES;
    }
    return WASM_MEMORY_HIGH_WATER_WEBKIT_BYTES;
}

/** Whether an instance's memory grew past `wasmMemoryHighWaterBytes`, so its thread should load a fresh one. */
export const exceedsWasmMemoryHighWater = (memory: WebAssembly.Memory) => memory.buffer.byteLength > wasmMemoryHighWaterBytes();

// The SHA-256 of each module this context compiled, by URL path, so
// provenance can name the bytes that actually run rather than a later download.
const loadedWasmDigests = new Map<string, Promise<string>>();

// Compiled modules cached per thread (or received via structured clone from
// the main thread) so worker pools and post-high-water reloads instantiate
// without re-fetching or recompiling.
const precompiledWasmModules = new Map<
    string,
    {
        module: WebAssembly.Module;
        digest: string | null;
    }
>();
const sharedCompiledWasmPromises = new Map<
    string,
    Promise<{
        module: WebAssembly.Module;
        digest: string | null;
    }>
>();

/**
 * Registers a precompiled `WebAssembly.Module` for `path` in this thread.
 * Does not overwrite `loadedWasmDigests` eagerly so a late preload message
 * cannot clobber the digest of an instance already compiled locally.
 */
export function registerPrecompiledWasmModule(path: string, module: WebAssembly.Module, digest?: string | null) {
    const key = wasmCacheKey(path);
    precompiledWasmModules.set(key, {
        module,
        digest: typeof digest === 'string' && digest.length > 0 ? digest : null,
    });
}

/**
 * Handles a main-thread preload message carrying a compiled `WebAssembly.Module`.
 * Returns true when `data` was a preload message and has been consumed.
 */
export function handlePrecompiledWasmModuleMessage(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) {
        return false;
    }
    if (Reflect.get(data, 'type') !== PRECOMPILED_WASM_MODULE_MESSAGE_TYPE) {
        return false;
    }
    const parsed = parsePrecompiledWasmModuleMessage(data);
    if (parsed !== null) {
        registerPrecompiledWasmModule(parsed.path, parsed.module, parsed.digest);
    }
    return true;
}

export function resolveWasmUrl(path: string) {
    const baseHref = globalThis.location?.href ?? (globalThis as {self?: {location?: {href?: string}}}).self?.location?.href;
    return baseHref ? new URL(path, baseHref).toString() : path;
}

/**
 * Compiles `path` once in this context and caches the resulting `WebAssembly.Module`
 * and SHA-256 digest for sharing across worker pool clones. A failed compile is
 * evicted so the next caller retries.
 */
export function compileWasmModuleOnce(path: string, stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS) {
    const key = wasmCacheKey(path);
    const existing = sharedCompiledWasmPromises.get(key);
    if (existing) {
        return existing;
    }
    const pending = (async () => {
        const url = resolveWasmUrl(path);
        const module = await compileWasmWithDeadline(url, stallTimeoutMs);
        const digest = (await readLoadedWasmDigest(url)?.catch(() => null)) ?? null;
        if (isRealWasmModule(module)) {
            registerPrecompiledWasmModule(url, module, digest);
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
 * Posts already-compiled `WebAssembly.Module` instances for `paths` to `worker`
 * synchronously via structured clone so subsequent worker clones never recompile.
 * Cold modules compile off the main thread inside the first worker and report
 * their compiled module back to the parent thread, keeping the UI thread free
 * of fetch, SHA-256 hashing, and WASM compilation work.
 */
export function postPrecompiledWasmModules(worker: Worker, paths: readonly string[]) {
    if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Module !== 'function') {
        return;
    }
    for (const path of paths) {
        const resolvedUrl = resolveWasmUrl(path);
        const ready = precompiledWasmModules.get(wasmCacheKey(resolvedUrl));
        if (!ready || !isRealWasmModule(ready.module)) {
            continue;
        }
        try {
            worker.postMessage({
                type: PRECOMPILED_WASM_MODULE_MESSAGE_TYPE,
                path: resolvedUrl,
                module: ready.module,
                digest: ready.digest,
            } satisfies IPrecompiledWasmModuleMessage);
        } catch {
            // Worker may already have terminated; safe to ignore.
        }
    }
}

function reportCompiledWasmModuleToParent(url: string, module: WebAssembly.Module, digest: string | null) {
    if (
        typeof window !== 'undefined' ||
        typeof self === 'undefined' ||
        typeof self.postMessage !== 'function' ||
        !isRealWasmModule(module)
    ) {
        return;
    }
    try {
        self.postMessage({
            type: PRECOMPILED_WASM_MODULE_MESSAGE_TYPE,
            path: url,
            module,
            digest,
        } satisfies IPrecompiledWasmModuleMessage);
    } catch {
        // Non-dedicated worker context or structured-clone unavailable; ignore.
    }
}

function cacheAndShareCompiledWasmModule(url: string, key: string, module: WebAssembly.Module) {
    if (!isRealWasmModule(module)) {
        return;
    }
    const resolvedUrl = resolveWasmUrl(url);
    const digestPromise = loadedWasmDigests.get(key);
    if (digestPromise) {
        void digestPromise
            .then((digest) => {
                if (!precompiledWasmModules.has(key)) {
                    precompiledWasmModules.set(key, {module, digest});
                }
                reportCompiledWasmModuleToParent(resolvedUrl, module, digest);
            })
            .catch(() => {
                if (!precompiledWasmModules.has(key)) {
                    precompiledWasmModules.set(key, {module, digest: null});
                }
                reportCompiledWasmModuleToParent(resolvedUrl, module, null);
            });
        return;
    }
    if (!precompiledWasmModules.has(key)) {
        precompiledWasmModules.set(key, {module, digest: null});
    }
    reportCompiledWasmModuleToParent(resolvedUrl, module, null);
}

async function sha256Hex(chunks: readonly Uint8Array[]) {
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const wasmCacheKey = (url: string) => {
    const baseHref =
        globalThis.location?.href ?? (globalThis as {self?: {location?: {href?: string}}}).self?.location?.href ?? 'https://evb.local/';
    try {
        const resolved = new URL(url, baseHref);
        resolved.hash = '';
        return resolved.toString();
    } catch {
        return url;
    }
};

/** The SHA-256 of the module last compiled from `url` in this context, if any. */
export function readLoadedWasmDigest(url: string) {
    return loadedWasmDigests.get(wasmCacheKey(url)) ?? null;
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
export function loadWasmWithDeadline(url: string, imports: WebAssembly.Imports = {}, stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS) {
    const key = wasmCacheKey(url);
    const precompiled = precompiledWasmModules.get(key);
    if (precompiled) {
        return WebAssembly.instantiate(precompiled.module, imports).then((instance) => {
            if (precompiled.digest !== null) {
                loadedWasmDigests.set(key, Promise.resolve(precompiled.digest));
            }
            return {
                instance,
                module: precompiled.module,
            };
        });
    }
    return fetchWasmWithDeadline(url, stallTimeoutMs, {
        streaming:
            typeof WebAssembly.instantiateStreaming === 'function'
                ? (response) => WebAssembly.instantiateStreaming(response, imports)
                : undefined,
        buffered: (bytes) => WebAssembly.instantiate(bytes, imports),
    }).then((result) => {
        if ('module' in result) {
            cacheAndShareCompiledWasmModule(url, key, result.module);
        }
        return result;
    });
}

/** Fetches and compiles a WASM module under `loadWasmWithDeadline`'s stall deadline, for a host that instantiates it several times. */
export function compileWasmWithDeadline(url: string, stallTimeoutMs = DEFAULT_WASM_STALL_TIMEOUT_MS) {
    const key = wasmCacheKey(url);
    const precompiled = precompiledWasmModules.get(key);
    if (precompiled) {
        if (precompiled.digest !== null) {
            loadedWasmDigests.set(key, Promise.resolve(precompiled.digest));
        }
        return Promise.resolve(precompiled.module);
    }
    return fetchWasmWithDeadline(url, stallTimeoutMs, {
        streaming: typeof WebAssembly.compileStreaming === 'function' ? (response) => WebAssembly.compileStreaming(response) : undefined,
        buffered: (bytes) => WebAssembly.compile(bytes),
    }).then((module) => {
        cacheAndShareCompiledWasmModule(url, key, module);
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
        if (watch.timer !== null) {
            clearTimeout(watch.timer);
        }
        watch.timer = null;
    };
    const arm = () => {
        disarm();
        if (watch.settled) {
            return;
        }
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
                    if (observed !== null) {
                        loadedWasmDigests.set(wasmCacheKey(url), observed);
                    }
                    return built;
                }
                const bytes = await response.arrayBuffer();
                const built = await build.buffered(bytes);
                loadedWasmDigests.set(wasmCacheKey(url), sha256Hex([new Uint8Array(bytes)]));
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
