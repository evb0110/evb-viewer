/// <reference lib="webworker" />

import {
    createDjvuLibreEngine,
    type IDjvuLibreDocument,
    type IDjvuPageLayerSummary,
    type TDjvuLibreModuleFactory,
} from '@djvu-core/djvuLibreEngine';
import type {
    IDjvuComponentDirectory,
    IDjvuDocInfo,
    IDjvuOutlineRawItem,
    IDjvuPageInfo,
    IDjvuPageTextRaw,
    IDjvuRenderedPage,
    IDjvuRenderPageOptions,
} from '@djvu-core/djvuLibreTypes';
import {
    buildDjvuPageComponentMap,
    resolveDjvuOutlineUrlToPageIndex,
} from '@djvu-core/djvuOutline';
import { getErrorMessage } from '@app/utils/error';

declare const self: DedicatedWorkerGlobalScope;

const DJVU_WASM_REVISION = '3.5.30-r1';
const DJVU_FETCH_STALL_TIMEOUT_MS = 30_000;
const DJVU_WORKER_HIGH_WATER_HEAP_BYTES = 256 * 1024 * 1024;

export type TBrowserDjvuWorkerRequest =
    | {
        id: number;
        type: 'open';
        initBytes: ArrayBuffer;
        hasComponents: boolean;
    }
    | {
        id: number;
        type: 'getComponentDirectory';
    }
    | {
        id: number;
        type: 'getDocInfo';
    }
    | {
        id: number;
        type: 'getPageInfo';
        pageNumber: number;
    }
    | {
        id: number;
        type: 'getPageLayerSummary';
        pageNumber: number;
        defaultForegroundSubsample?: number;
    }
    | {
        id: number;
        type: 'renderPage';
        pageNumber: number;
        options?: IDjvuRenderPageOptions;
    }
    | {
        id: number;
        type: 'renderMaskPbm';
        pageNumber: number;
    }
    | {
        id: number;
        type: 'renderBackgroundRgb';
        pageNumber: number;
    }
    | {
        id: number;
        type: 'renderPagePpm';
        pageNumber: number;
        options?: Omit<IDjvuRenderPageOptions, 'pixelFormat'>;
    }
    | {
        id: number;
        type: 'getOutline';
    }
    | {
        id: number;
        type: 'getPageNumberByUrl';
        url: string;
    }
    | {
        id: number;
        type: 'getPageText';
        pageNumber: number;
        includeZones?: boolean;
    }
    | {
        id: number;
        type: 'pageHasText';
        pageNumber: number;
    }
    | {
        id: number;
        type: 'getMetadata';
    }
    | {
        id: number;
        type: 'clearCache';
    };

export type TBrowserDjvuWorkerResponse =
    | {
        id: number;
        ok: true;
        data: unknown;
    }
    | {
        id: number;
        ok: false;
        error: string;
        errorName?: string;
    };

async function fetchBytesWithStallTimeout(url: URL, timeoutMs: number): Promise<Uint8Array> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            const error = new Error(`DjVuLibre WASM download stalled: no data arrived for ${timeoutMs}ms`);
            error.name = 'TimeoutError';
            controller.abort(error);
        }, timeoutMs);
    };
    arm();
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Failed to load DjVuLibre WASM from ${url.pathname}: HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
            return new Uint8Array(await response.arrayBuffer());
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (let step = await reader.read(); !step.done; step = await reader.read()) {
            arm();
            chunks.push(step.value);
            total += step.value.byteLength;
        }
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return combined;
    } catch (error) {
        throw controller.signal.aborted && controller.signal.reason instanceof Error
            ? controller.signal.reason
            : error;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

const engine = createDjvuLibreEngine({
    loadEngine: async () => {
        const moduleUrl = new URL('/wasm/evb-djvulibre.mjs', self.location.href).href;
        const wasmUrl = new URL(`/wasm/evb-djvulibre.wasm?revision=${DJVU_WASM_REVISION}`, self.location.href);
        const [
            imported,
            wasmBytes,
        ] = await Promise.all([
            import(/* @vite-ignore */ moduleUrl) as Promise<{ default: TDjvuLibreModuleFactory }>,
            fetchBytesWithStallTimeout(wasmUrl, DJVU_FETCH_STALL_TIMEOUT_MS),
        ]);
        const module = await WebAssembly.compile(wasmBytes as BufferSource);
        return {
            factory: imported.default,
            module,
        };
    },
});

let activeDoc: IDjvuLibreDocument | null = null;
let cachedDocInfo: IDjvuDocInfo | null = null;
let cachedPageComponentMap: Map<string, number> | null = null;
let componentPort: MessagePort | null = null;
let nextComponentRequestId = 1;
const pendingComponents = new Map<number, {
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
}>();

function closeComponentPort() {
    if (componentPort) {
        componentPort.onmessage = null;
        componentPort.close();
        componentPort = null;
    }
    for (const pending of pendingComponents.values()) {
        pending.reject(new DOMException('DjVu component channel closed', 'AbortError'));
    }
    pendingComponents.clear();
}

function requestComponentFromHost(name: string): Promise<Uint8Array> {
    if (!componentPort) {
        return Promise.reject(new Error(`DjVu component ${name} requested without a component channel`));
    }
    const id = nextComponentRequestId++;
    return new Promise<Uint8Array>((resolve, reject) => {
        pendingComponents.set(id, {
            resolve,
            reject,
        });
        componentPort!.postMessage({
            id,
            name,
        });
    });
}

function attachComponentPort(port: MessagePort) {
    closeComponentPort();
    componentPort = port;
    port.onmessage = (event: MessageEvent<{
        id: number;
        ok: boolean;
        buffer?: ArrayBuffer;
        error?: string;
    }>) => {
        const payload = event.data;
        const pending = pendingComponents.get(payload.id);
        if (!pending) return;
        pendingComponents.delete(payload.id);
        if (payload.ok && payload.buffer instanceof ArrayBuffer) {
            pending.resolve(new Uint8Array(payload.buffer));
        } else {
            pending.reject(new Error(payload.error || 'Failed to read DjVu component'));
        }
    };
}

function requireDoc(): IDjvuLibreDocument {
    if (!activeDoc) {
        throw new Error('No DjVu document is open in this worker');
    }
    return activeDoc;
}

async function ensureDocInfo(doc: IDjvuLibreDocument): Promise<IDjvuDocInfo> {
    if (!cachedDocInfo) {
        cachedDocInfo = await doc.getDocInfo();
        cachedPageComponentMap = buildDjvuPageComponentMap(cachedDocInfo.files);
    }
    return cachedDocInfo;
}

function toTransferable(bytes: Uint8Array): Transferable[] {
    if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return [bytes.buffer];
    }
    return [];
}

let requestQueue: Promise<void> = Promise.resolve();

async function handleRequest(request: TBrowserDjvuWorkerRequest, ports: readonly MessagePort[]): Promise<{
    data: unknown;
    transfer?: Transferable[];
}> {
    switch (request.type) {
        case 'open': {
            if (activeDoc) {
                activeDoc.close();
                activeDoc = null;
            }
            cachedDocInfo = null;
            cachedPageComponentMap = null;
            if (ports[0]) {
                attachComponentPort(ports[0]);
            } else {
                closeComponentPort();
            }
            activeDoc = await engine.openDocument({
                initBytes: new Uint8Array(request.initBytes),
                ...(request.hasComponents ? { readComponentAsync: requestComponentFromHost } : {}),
            });
            return { data: null };
        }
        case 'getComponentDirectory': {
            const directory: IDjvuComponentDirectory | null = await requireDoc().getComponentDirectory();
            return { data: directory };
        }
        case 'getDocInfo': {
            const info = await ensureDocInfo(requireDoc());
            return { data: info };
        }
        case 'getPageInfo': {
            const info: IDjvuPageInfo = await requireDoc().getPageInfo(request.pageNumber);
            return { data: info };
        }
        case 'getPageLayerSummary': {
            const summary: IDjvuPageLayerSummary = await requireDoc().getPageLayerSummary(
                request.pageNumber,
                request.defaultForegroundSubsample,
            );
            return { data: summary };
        }
        case 'renderPage': {
            const doc = requireDoc();
            const rendered: IDjvuRenderedPage = await doc.renderPage(request.pageNumber, request.options);
            if (engine.getHeapBytes() > DJVU_WORKER_HIGH_WATER_HEAP_BYTES) {
                doc.clearCache();
            }
            return {
                data: rendered,
                transfer: toTransferable(rendered.bytes),
            };
        }
        case 'renderMaskPbm': {
            const pbm = await requireDoc().renderMaskPbm(request.pageNumber);
            return {
                data: pbm,
                ...(pbm ? { transfer: toTransferable(pbm) } : {}),
            };
        }
        case 'renderBackgroundRgb': {
            const bg = await requireDoc().renderBackgroundRgb(request.pageNumber);
            return {
                data: bg,
                ...(bg ? { transfer: toTransferable(bg.rgb) } : {}),
            };
        }
        case 'renderPagePpm': {
            const doc = requireDoc();
            const result = await doc.renderPagePpm(request.pageNumber, request.options);
            if (engine.getHeapBytes() > DJVU_WORKER_HIGH_WATER_HEAP_BYTES) {
                doc.clearCache();
            }
            return {
                data: result,
                ...(result ? { transfer: toTransferable(result.ppm) } : {}),
            };
        }
        case 'getOutline': {
            const outline: IDjvuOutlineRawItem[] = await requireDoc().getOutline();
            return { data: outline };
        }
        case 'getPageNumberByUrl': {
            const doc = requireDoc();
            const info = await ensureDocInfo(doc);
            const pageIndex = resolveDjvuOutlineUrlToPageIndex(
                request.url,
                cachedPageComponentMap ?? undefined,
                info.pageCount,
            );
            return { data: pageIndex === null ? null : pageIndex + 1 };
        }
        case 'getPageText': {
            const text: IDjvuPageTextRaw = await requireDoc().getPageText(
                request.pageNumber,
                { includeZones: request.includeZones ?? true },
            );
            return { data: text };
        }
        case 'pageHasText': {
            const hasText = await requireDoc().pageHasText(request.pageNumber);
            return { data: hasText };
        }
        case 'getMetadata': {
            const metadata = await requireDoc().getMetadata();
            return { data: metadata };
        }
        case 'clearCache': {
            requireDoc().clearCache();
            return { data: null };
        }
    }
}

self.addEventListener('message', (event: MessageEvent<TBrowserDjvuWorkerRequest>) => {
    const request = event.data;
    if (!request || typeof request !== 'object' || typeof request.id !== 'number') {
        return;
    }
    const ports = event.ports;
    requestQueue = requestQueue.then(async () => {
        try {
            const {
                data,
                transfer,
            } = await handleRequest(request, ports);
            self.postMessage({
                id: request.id,
                ok: true,
                data,
            } satisfies TBrowserDjvuWorkerResponse, transfer ?? []);
        } catch (error) {
            self.postMessage({
                id: request.id,
                ok: false,
                error: getErrorMessage(error),
                ...(error instanceof Error && error.name ? { errorName: error.name } : {}),
            } satisfies TBrowserDjvuWorkerResponse);
        }
    });
});
