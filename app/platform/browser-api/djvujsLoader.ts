import type { IDjvuPageSize } from '@contracts/electronApiDjvu';

const DJVU_SCRIPT_PATH = '/vendor/djvujs/djvu.js';
// The script download is abandoned only when no bytes arrive for this long,
// the same no-progress policy the WASM loaders use. A slow connection that
// keeps delivering bytes is never cut off.
export const DJVU_SCRIPT_STALL_TIMEOUT_MS = 30_000;
/** The base URL DjVu.js prefixes to component names; the worker resolves it. */
export const DJVU_COMPONENT_BASE_URL = 'evbcomponent://source/';

export type { IDjvuPageSize } from '@contracts/electronApiDjvu';

interface IDjvuWorkerTask<T> { run(): Promise<T>; }

interface IDjvuPageTask {
    createPngObjectUrl(): IDjvuWorkerTask<IDjvuPngObjectData>;
    getImageData(rotate?: boolean): IDjvuWorkerTask<ImageData>;
    getText(): IDjvuWorkerTask<string>;
    getNormalizedTextZones(): IDjvuWorkerTask<IDjvuNormalizedTextZone[] | null>;
}

export interface IDjvuNormalizedTextZone {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
}

export interface IDjvuContentsItem {
    description: string;
    url: string;
    children?: IDjvuContentsItem[];
}

interface IDjvuPngObjectData {
    url: string;
    byteLength: number;
    width: number;
    height: number;
    dpi: number;
}

/** The DIRM directory of a multi-page document, in component order. */
export interface IDjvuComponentDirectory {
    names: string[];
    flags: number[];
}

export interface IDjvuWorker {
    readonly doc: {
        getPagesSizes(): IDjvuWorkerTask<IDjvuPageSize[]>;
        getPagesQuantity?(): IDjvuWorkerTask<number>;
        getContents(): IDjvuWorkerTask<IDjvuContentsItem[] | null>;
        getPageNumberByUrl(url: string): IDjvuWorkerTask<number | null>;
        getPage(pageNumber: number): IDjvuPageTask;
        evbGetComponentDirectory(): IDjvuWorkerTask<IDjvuComponentDirectory | null>;
    };
    /** The DOM worker DjVu.js drives. */
    readonly worker?: Worker;
    createDocument(
        buffer: ArrayBuffer,
        options?: Record<string, unknown>,
    ): Promise<void>;
    terminate(): void;
    revokeObjectURL(url: string): void;
}

interface IDjvuGlobal {
    Worker: new (path?: string) => IDjvuWorker;
    DjVuScript?: () => unknown;
}

type TDjvuWindow = Window & { DjVu?: IDjvuGlobal };

export interface IDjvuComponentRequest {
    /** Position of the component in the DIRM directory. */
    index: number;
    /** File name the DIRM gives the component. */
    name: string;
}

/** Reads a component the decoder asked for by name, as a standalone `AT&T` file. */
export type TDjvuComponentReader = (name: string) => Promise<Uint8Array>;

interface IDjvuComponentPortRequest {
    id: number;
    name: string;
}

let djvuLoadPromise: Promise<IDjvuGlobal> | null = null;
const workerScriptUrls = new WeakMap<IDjvuGlobal, string>();

function getLoadedDjvuGlobal() {
    if (typeof window === 'undefined') {
        return null;
    }

    return (window as TDjvuWindow).DjVu ?? null;
}

function createStallError(timeoutMs: number) {
    const error = new Error(`The DjVu.js download stalled: no data arrived for ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
}

/**
 * Downloads the decoder once with a no-progress deadline, so the script
 * element that follows is served from the HTTP cache and a dead connection
 * is reported instead of leaving the open waiting.
 */
async function downloadDjvuScript(url: string) {
    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => abortController.abort(createStallError(DJVU_SCRIPT_STALL_TIMEOUT_MS)), DJVU_SCRIPT_STALL_TIMEOUT_MS);
    };
    arm();
    try {
        const response = await fetch(url, {signal: abortController.signal});
        if (!response.ok) {
            throw new Error(`Failed to load DjVu.js from ${url}: HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
            await response.arrayBuffer();
            return;
        }
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            arm();
        }
    } catch (error) {
        throw abortController.signal.aborted && abortController.signal.reason instanceof Error
            ? abortController.signal.reason
            : error;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

function appendDjvuScript() {
    return new Promise<IDjvuGlobal>((resolve, reject) => {
        let script = document.querySelector<HTMLScriptElement>(
            `script[data-djvujs-src="${DJVU_SCRIPT_PATH}"]`,
        );

        if (script?.dataset.djvujsState === 'failed'
            || script?.dataset.djvujsState === 'ready') {
            script.remove();
            script = null;
        }

        if (!script) {
            script = document.createElement('script');
            script.src = DJVU_SCRIPT_PATH;
            script.async = true;
            script.dataset.djvujsSrc = DJVU_SCRIPT_PATH;
            script.dataset.djvujsState = 'loading';
        }

        const targetScript = script;
        const cleanup = () => {
            targetScript.removeEventListener('load', handleLoad);
            targetScript.removeEventListener('error', handleError);
        };
        const fail = (error: Error) => {
            cleanup();
            targetScript.dataset.djvujsState = 'failed';
            targetScript.remove();
            reject(error);
        };
        function handleLoad() {
            const nextGlobal = getLoadedDjvuGlobal();
            if (!nextGlobal) {
                fail(new Error('DjVu.js loaded without exposing window.DjVu'));
                return;
            }
            cleanup();
            targetScript.dataset.djvujsState = 'ready';
            resolve(nextGlobal);
        }
        function handleError() {
            fail(new Error(`Failed to load DjVu.js from ${DJVU_SCRIPT_PATH}`));
        }

        targetScript.addEventListener('load', handleLoad);
        targetScript.addEventListener('error', handleError);
        if (!targetScript.isConnected) {
            document.head.append(targetScript);
        }
    });
}

export async function loadDjvuJs() {
    const loadedGlobal = getLoadedDjvuGlobal();
    if (loadedGlobal) {
        return loadedGlobal;
    }

    if (typeof document === 'undefined') {
        throw new Error('DjVu.js can only be loaded in a browser runtime');
    }

    if (!djvuLoadPromise) {
        const retryableLoad = (async () => {
            await downloadDjvuScript(DJVU_SCRIPT_PATH);
            return appendDjvuScript();
        })().catch((error: unknown) => {
            if (djvuLoadPromise === retryableLoad) {
                djvuLoadPromise = null;
            }
            throw error;
        });
        djvuLoadPromise = retryableLoad;
    }

    return djvuLoadPromise;
}

interface IBootstrapDocument {
    dirm?: {
        names: ArrayLike<string>;
        flags: ArrayLike<number>;
    };
    _initMultiPageDocument(): void;
}

interface IBootstrapPage {
    info: {
        width: number;
        height: number
    } | null;
    init(): unknown;
}

interface IBootstrapLibrary { Document: {prototype: IBootstrapDocument & Record<string, unknown>}; }


/**
 * Runs inside the DjVu.js worker after the library, and must stay
 * self-contained: it is sent to the worker as source text.
 *
 * DjVu.js loads components by URL through XMLHttpRequest. Requests under the
 * component base URL go to the page that created the worker over a
 * MessagePort, which reads them from the stored file or the granted folder.
 */
function evbDjvuWorkerBootstrap(lib: IBootstrapLibrary, baseUrl: string) {
    let port: MessagePort | null = null;
    let nextRequestId = 1;
    const pending = new Map<number, {
        resolve: (buffer: ArrayBuffer) => void;
        reject: (error: Error) => void;
    }>();

    const documentPrototype = lib.Document.prototype;
    // DjVu.js reads INFO width and height as signed 16-bit values, so a page
    // edge above 32,767 pixels comes out negative and breaks compositing. The
    // format defines them unsigned; the page class is patched once, from the
    // first page DjVu.js hands out, to read them that way.
    let pageInitPatched = false;
    function patchPageInit(page: IBootstrapPage) {
        if (pageInitPatched) return;
        pageInitPatched = true;
        const pagePrototype = Object.getPrototypeOf(page) as IBootstrapPage;
        const initPage = pagePrototype.init;
        pagePrototype.init = function (this: IBootstrapPage) {
            const initialized = initPage.call(this);
            const info = this.info;
            if (info && info.width < 0) info.width += 0x10000;
            if (info && info.height < 0) info.height += 0x10000;
            return initialized;
        };
    }
    const getPage = documentPrototype.getPage as (this: IBootstrapDocument, pageNumber: number) => Promise<IBootstrapPage | null>;
    documentPrototype.getPage = async function (this: IBootstrapDocument, pageNumber: number) {
        const page = await getPage.call(this, pageNumber);
        if (page) patchPageInit(page);
        return page;
    };
    documentPrototype.evbGetComponentDirectory = function (this: IBootstrapDocument) {
        return this.dirm
            ? {
                names: Array.from(this.dirm.names),
                flags: Array.from(this.dirm.flags),
            }
            : null;
    };

    function requestComponent(name: string) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            if (!port) {
                reject(new Error(`DjVu component ${name} has no source`));
                return;
            }
            const id = nextRequestId;
            nextRequestId += 1;
            pending.set(id, {
                resolve,
                reject,
            });
            port.postMessage({
                id,
                name,
            });
        });
    }

    // DjVu.js fetches components through XMLHttpRequest by URL; every URL
    // it builds here starts with the component base URL. Declared fields
    // emit nothing, so the class stays valid as source text.
    class ComponentRequest {
        declare onload: ((event: unknown) => void) | null;
        declare onerror: ((event: unknown) => void) | null;
        declare responseType: string;
        declare response: ArrayBuffer | null;
        declare status: number;
        declare url: string;

        constructor() {
            this.onload = null;
            this.onerror = null;
            this.responseType = '';
            this.response = null;
            this.status = 0;
            this.url = '';
        }

        open(_method: string, url: string) {
            this.url = url;
        }

        send() {
            if (!this.url.startsWith(baseUrl)) {
                this.onerror?.({});
                return;
            }
            requestComponent(this.url.slice(baseUrl.length)).then((buffer) => {
                this.status = 200;
                this.response = buffer;
                this.onload?.({});
            }, () => {
                this.onerror?.({});
            });
        }
    }
    Reflect.set(self, 'XMLHttpRequest', ComponentRequest);

    const handleLibraryMessage = self.onmessage;
    self.onmessage = (event: MessageEvent) => {
        const data = event.data as {evbComponentPort?: MessagePort} | null;
        if (data && data.evbComponentPort) {
            port = data.evbComponentPort;
            port.onmessage = (reply: MessageEvent) => {
                const message = reply.data as {
                    id: number;
                    buffer?: ArrayBuffer;
                    error?: string;
                };
                const waiter = pending.get(message.id);
                if (!waiter) return;
                pending.delete(message.id);
                if (message.buffer) waiter.resolve(message.buffer);
                else waiter.reject(new Error(message.error ?? 'DjVu component read failed'));
            };
            return;
        }
        handleLibraryMessage?.call(self, event);
    };
}

function getDjvuWorkerScriptUrl(djvuGlobal: IDjvuGlobal) {
    const existing = workerScriptUrls.get(djvuGlobal);
    if (existing) {
        return existing;
    }
    if (typeof djvuGlobal.DjVuScript !== 'function') {
        throw new Error('DjVu.js does not expose its worker script');
    }
    const source = [
        `var DjVu = (${String(djvuGlobal.DjVuScript)})();`,
        `(${String(evbDjvuWorkerBootstrap)})(DjVu, ${JSON.stringify(DJVU_COMPONENT_BASE_URL)});`,
    ].join('\n');
    const url = URL.createObjectURL(new Blob([source], {type: 'application/javascript'}));
    workerScriptUrls.set(djvuGlobal, url);
    return url;
}

function toTransferableBuffer(bytes: Uint8Array) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : bytes.slice().buffer;
}

/**
 * Starts a DjVu.js worker. With a component reader, the worker loads every
 * page and shared dictionary of an indirect document through it.
 */
export function createDjvuWorker(djvuGlobal: IDjvuGlobal, readComponent?: TDjvuComponentReader): IDjvuWorker {
    const worker = new djvuGlobal.Worker(getDjvuWorkerScriptUrl(djvuGlobal));
    if (!readComponent) {
        return worker;
    }
    const domWorker = worker.worker;
    if (!domWorker) {
        worker.terminate();
        throw new Error('DjVu.js worker does not expose its message channel');
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<IDjvuComponentPortRequest>) => {
        const {
            id,
            name,
        } = event.data;
        readComponent(name).then((bytes) => {
            const buffer = toTransferableBuffer(bytes);
            channel.port1.postMessage({
                id,
                buffer,
            }, [buffer]);
        }, (error: unknown) => {
            channel.port1.postMessage({
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    };
    domWorker.postMessage({evbComponentPort: channel.port2}, [channel.port2]);
    const terminate = worker.terminate.bind(worker);
    return Object.assign(worker, {terminate() {
        channel.port1.close();
        terminate();
    }});
}
