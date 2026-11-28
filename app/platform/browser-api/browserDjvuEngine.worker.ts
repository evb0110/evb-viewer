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
import {buildDjvuPageComponentMap, resolveDjvuOutlineUrlToPageIndex} from '@djvu-core/djvuOutline';
import {compileWasmWithDeadline, handlePrecompiledWasmModuleMessage} from '@app/platform/browser/loadWasmWithDeadline';
import {getErrorMessage} from '@app/utils/error';

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

let cachedFactoryPromise: Promise<TDjvuLibreModuleFactory> | null = null;
let cachedModulePromise: Promise<WebAssembly.Module> | null = null;

function loadDjvuFactory(): Promise<TDjvuLibreModuleFactory> {
    if (!cachedFactoryPromise) {
        const moduleUrl = new URL('/wasm/evb-djvulibre.mjs', self.location.href).href;
        const pending = (import(/* @vite-ignore */ moduleUrl) as Promise<{default: TDjvuLibreModuleFactory}>).then(
            (imported) => imported.default,
        );
        pending.catch(() => {
            if (cachedFactoryPromise === pending) {
                cachedFactoryPromise = null;
            }
        });
        cachedFactoryPromise = pending;
    }
    return cachedFactoryPromise;
}

function loadDjvuWasmModule(): Promise<WebAssembly.Module> {
    if (!cachedModulePromise) {
        const wasmUrl = new URL(`/wasm/evb-djvulibre.wasm?revision=${DJVU_WASM_REVISION}`, self.location.href).href;
        const pending = compileWasmWithDeadline(wasmUrl, DJVU_FETCH_STALL_TIMEOUT_MS);
        pending.catch(() => {
            if (cachedModulePromise === pending) {
                cachedModulePromise = null;
            }
        });
        cachedModulePromise = pending;
    }
    return cachedModulePromise;
}

const engine = createDjvuLibreEngine({
    loadEngine: async () => {
        const [factory, module] = await Promise.all([loadDjvuFactory(), loadDjvuWasmModule()]);
        return {
            factory,
            module,
        };
    },
});

let activeDoc: IDjvuLibreDocument | null = null;
let activeOpenState: {initBytes: Uint8Array; hasComponents: boolean} | null = null;
let cachedDocInfo: IDjvuDocInfo | null = null;
let cachedPageComponentMap: Map<string, number> | null = null;
let componentPort: MessagePort | null = null;
let nextComponentRequestId = 1;
const pendingComponents = new Map<
    number,
    {
        resolve: (bytes: Uint8Array) => void;
        reject: (error: Error) => void;
    }
>();

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
    port.onmessage = (
        event: MessageEvent<{
            id: number;
            ok: boolean;
            buffer?: ArrayBuffer;
            error?: string;
        }>,
    ) => {
        const payload = event.data;
        const pending = pendingComponents.get(payload.id);
        if (!pending) {
            return;
        }
        pendingComponents.delete(payload.id);
        if (payload.ok && payload.buffer instanceof ArrayBuffer) {
            pending.resolve(new Uint8Array(payload.buffer));
        } else {
            pending.reject(new Error(payload.error || 'Failed to read DjVu component'));
        }
    };
}

async function ensureActiveDoc(): Promise<IDjvuLibreDocument> {
    if (!activeDoc) {
        if (!activeOpenState) {
            throw new Error('No DjVu document is open in this worker');
        }
        activeDoc = await engine.openDocument({
            initBytes: activeOpenState.initBytes,
            ...(activeOpenState.hasComponents ? {readComponentAsync: requestComponentFromHost} : {}),
        });
    }
    return activeDoc;
}

function recycleEngineIfAboveHighWater(): void {
    if (engine.getHeapBytes() <= DJVU_WORKER_HIGH_WATER_HEAP_BYTES) {
        return;
    }
    if (activeDoc) {
        activeDoc.close();
        activeDoc = null;
    }
    engine.dispose();
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

async function handleRequest(
    request: TBrowserDjvuWorkerRequest,
    ports: readonly MessagePort[],
): Promise<{
    data: unknown;
    transfer?: Transferable[];
}> {
    switch (request.type) {
        case 'open': {
            if (activeDoc) {
                activeDoc.close();
                activeDoc = null;
            }
            activeOpenState = null;
            if (engine.getHeapBytes() > DJVU_WORKER_HIGH_WATER_HEAP_BYTES) {
                engine.dispose();
            }
            cachedDocInfo = null;
            cachedPageComponentMap = null;
            if (ports[0]) {
                attachComponentPort(ports[0]);
            } else {
                closeComponentPort();
            }
            const initBytes = new Uint8Array(request.initBytes);
            activeOpenState = {initBytes, hasComponents: request.hasComponents};
            activeDoc = await engine.openDocument({
                initBytes,
                ...(request.hasComponents ? {readComponentAsync: requestComponentFromHost} : {}),
            });
            return {data: null};
        }
        case 'getComponentDirectory': {
            const directory: IDjvuComponentDirectory | null = await (await ensureActiveDoc()).getComponentDirectory();
            return {data: directory};
        }
        case 'getDocInfo': {
            const info = await ensureDocInfo(await ensureActiveDoc());
            return {data: info};
        }
        case 'getPageInfo': {
            const info: IDjvuPageInfo = await (await ensureActiveDoc()).getPageInfo(request.pageNumber);
            return {data: info};
        }
        case 'getPageLayerSummary': {
            const summary: IDjvuPageLayerSummary = await (
                await ensureActiveDoc()
            ).getPageLayerSummary(request.pageNumber, request.defaultForegroundSubsample);
            return {data: summary};
        }
        case 'renderPage': {
            const doc = await ensureActiveDoc();
            const rendered: IDjvuRenderedPage = await doc.renderPage(request.pageNumber, request.options);
            recycleEngineIfAboveHighWater();
            return {
                data: rendered,
                transfer: toTransferable(rendered.bytes),
            };
        }
        case 'renderMaskPbm': {
            const pbm = await (await ensureActiveDoc()).renderMaskPbm(request.pageNumber);
            recycleEngineIfAboveHighWater();
            return {
                data: pbm,
                ...(pbm ? {transfer: toTransferable(pbm)} : {}),
            };
        }
        case 'renderBackgroundRgb': {
            const bg = await (await ensureActiveDoc()).renderBackgroundRgb(request.pageNumber);
            recycleEngineIfAboveHighWater();
            return {
                data: bg,
                ...(bg ? {transfer: toTransferable(bg.rgb)} : {}),
            };
        }
        case 'renderPagePpm': {
            const doc = await ensureActiveDoc();
            const result = await doc.renderPagePpm(request.pageNumber, request.options);
            recycleEngineIfAboveHighWater();
            return {
                data: result,
                ...(result ? {transfer: toTransferable(result.ppm)} : {}),
            };
        }
        case 'getOutline': {
            const outline: IDjvuOutlineRawItem[] = await (await ensureActiveDoc()).getOutline();
            return {data: outline};
        }
        case 'getPageNumberByUrl': {
            const doc = await ensureActiveDoc();
            const info = await ensureDocInfo(doc);
            const pageIndex = resolveDjvuOutlineUrlToPageIndex(request.url, cachedPageComponentMap ?? undefined, info.pageCount);
            return {data: pageIndex === null ? null : pageIndex + 1};
        }
        case 'getPageText': {
            const text: IDjvuPageTextRaw = await (
                await ensureActiveDoc()
            ).getPageText(request.pageNumber, {
                includeZones: request.includeZones ?? true,
            });
            return {data: text};
        }
        case 'pageHasText': {
            const hasText = await (await ensureActiveDoc()).pageHasText(request.pageNumber);
            return {data: hasText};
        }
        case 'getMetadata': {
            const metadata = await (await ensureActiveDoc()).getMetadata();
            return {data: metadata};
        }
        case 'clearCache': {
            if (activeDoc) {
                activeDoc.clearCache();
            } else if (!activeOpenState) {
                throw new Error('No DjVu document is open in this worker');
            }
            recycleEngineIfAboveHighWater();
            return {data: null};
        }
    }
}

self.addEventListener('message', (event: MessageEvent<TBrowserDjvuWorkerRequest>) => {
    if (handlePrecompiledWasmModuleMessage(event.data)) {
        return;
    }
    const request = event.data;
    if (!request || typeof request !== 'object' || typeof request.id !== 'number') {
        return;
    }
    const ports = event.ports;
    requestQueue = requestQueue.then(async () => {
        try {
            const {data, transfer} = await handleRequest(request, ports);
            self.postMessage(
                {
                    id: request.id,
                    ok: true,
                    data,
                } satisfies TBrowserDjvuWorkerResponse,
                transfer ?? [],
            );
        } catch (error) {
            self.postMessage({
                id: request.id,
                ok: false,
                error: getErrorMessage(error),
                ...(error instanceof Error && error.name ? {errorName: error.name} : {}),
            } satisfies TBrowserDjvuWorkerResponse);
        }
    });
});
