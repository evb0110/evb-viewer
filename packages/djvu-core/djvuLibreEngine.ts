import {
    DJVU_COMPACT_FOREGROUND_SUBSAMPLE,
    DJVU_COMPACT_REAL_MASK_MIN_BYTES,
} from '@contracts/djvuConversionPolicy';
import { DJVU_SEARCH_MAX_PAGE_ZONES } from '@contracts/djvuResourceLimits';
import type {
    IDjvuComponentDirectory,
    IDjvuDocInfo,
    IDjvuLibreEmscriptenModule,
    IDjvuOutlineRawItem,
    IDjvuPageInfo,
    IDjvuPageLayerSummary,
    IDjvuPageStructure,
    IDjvuPageTextRaw,
    IDjvuRenderedPage,
    IDjvuRenderPageOptions,
    TDjvuLibreModuleFactory,
    TDjvuPixelFormat,
    TDjvuRenderMode,
} from '@djvu-core/djvuLibreTypes';

export type {
    IDjvuPageLayerSummary,
    TDjvuLibreModuleFactory,
};
import { DJVU_OUTLINE_MAX_BYTES } from '@djvu-core/djvuOutline';
import {
    DJVU_MAX_COMPONENT_BYTES,
    DJVU_MAX_LEGACY_BUNDLED_BYTES,
} from '@djvu-core/djvuSourceLayout';
import {
    analyzeForegroundColorRaster,
    encodePbmP4,
    encodePpmP6,
} from '@djvu-core/djvuPnm';

const EVB_DJVU_OK = 0;
const EVB_DJVU_NEED_COMPONENT = 1;
const EVB_DJVU_ERR_OOM = -2;

const RENDER_MODE_CODES: Record<TDjvuRenderMode, number> = {
    color: 0,
    black: 1,
    mask: 2,
    background: 3,
    foreground: 4,
};

const PIXEL_FORMAT_CODES: Record<TDjvuPixelFormat, number> = {
    rgba: 0,
    rgb: 1,
    pbm: 2,
};

const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_COMPONENT_FETCH_RETRIES = 64;
const DIRM_TYPE_FLAGS: Record<IDjvuDocInfo['files'][number]['type'], number> = {
    include: 0,
    page: 1,
    thumbnail: 2,
    'shared-anno': 3,
};

const utf8Decoder = new TextDecoder();

/** How a host supplies the compiled DjVuLibre Emscripten engine to a worker. */
export interface IDjvuLibreEngineSource {
    loadEngine: () => Promise<{
        factory: TDjvuLibreModuleFactory;
        module: WebAssembly.Module;
    }>;
}

export interface IDjvuOpenDocumentOptions {
    /** Index bytes (for indirect/rewritten bundled FORM:DJVM) or single-page FORM:DJVU bytes. */
    initBytes: Uint8Array;
    /** Optional synchronous component reader (Node fs.readSync or Worker FileReaderSync). */
    readComponentSync?: (name: string) => Uint8Array | null | false;
    /** Optional async component reader (browser MessagePort fallback). */
    readComponentAsync?: (name: string) => Promise<Uint8Array>;
    /** Decoded-file cache budget in bytes inside libdjvu (clamped 4..64 MiB). */
    cacheBytes?: number;
}

export interface IDjvuLibreDocument {
    getDocInfo(): Promise<IDjvuDocInfo>;
    getComponentDirectory(): Promise<IDjvuComponentDirectory | null>;
    getPageInfo(pageNumber: number): Promise<IDjvuPageInfo>;
    getPageStructure(pageNumber: number): Promise<IDjvuPageStructure>;
    getPageLayerSummary(pageNumber: number, defaultForegroundSubsample?: number): Promise<IDjvuPageLayerSummary>;
    renderPage(pageNumber: number, options?: IDjvuRenderPageOptions): Promise<IDjvuRenderedPage>;
    renderMaskPbm(pageNumber: number): Promise<Uint8Array | null>;
    renderBackgroundRgb(pageNumber: number): Promise<{
        width: number;
        height: number;
        rgb: Uint8Array;
    } | null>;
    renderPagePpm(pageNumber: number, options?: Omit<IDjvuRenderPageOptions, 'pixelFormat'>): Promise<{
        width: number;
        height: number;
        ppm: Uint8Array;
    } | null>;
    getOutline(): Promise<IDjvuOutlineRawItem[]>;
    getPageText(pageNumber: number, options?: {
        includeZones?: boolean;
        maxZones?: number;
    }): Promise<IDjvuPageTextRaw>;
    pageHasText(pageNumber: number): Promise<boolean>;
    hasText(maxPages?: number): Promise<boolean>;
    getMetadata(): Promise<Record<string, string>>;
    clearCache(): void;
    close(): void;
}

export interface IDjvuLibreEngine {
    openDocument(options: IDjvuOpenDocumentOptions): Promise<IDjvuLibreDocument>;
    getHeapBytes(): number;
    dispose(): void;
}

function deriveLayerSubsample(pageWidth: number, pageHeight: number, layerWidth: number | null, layerHeight: number | null) {
    if (!layerWidth || !layerHeight || layerWidth <= 0 || layerHeight <= 0) {
        return null;
    }
    const sx = Math.max(1, Math.round(pageWidth / layerWidth));
    const sy = Math.max(1, Math.round(pageHeight / layerHeight));
    return Math.min(64, Math.max(1, Math.round((sx + sy) / 2)));
}

/**
 * Shared DjVuLibre 3.5.30 WebAssembly engine host for browser Web Workers
 * and Electron worker_threads. Keeps one warm WASM instance per worker and
 * supports both synchronous range-backed component reads and async fallbacks.
 */
export function createDjvuLibreEngine(source: IDjvuLibreEngineSource): IDjvuLibreEngine {
    let enginePromise: ReturnType<IDjvuLibreEngineSource['loadEngine']> | null = null;
    let instancePromise: Promise<IDjvuLibreEmscriptenModule> | null = null;
    let liveInstance: IDjvuLibreEmscriptenModule | null = null;
    let nextDocId = 1;
    const syncReadersByDocId = new Map<number, (name: string) => Uint8Array | null | false>();

    const loadEngine = () => {
        if (!enginePromise) {
            const loading = source.loadEngine();
            loading.catch(() => {
                enginePromise = null;
            });
            enginePromise = loading;
        }
        return enginePromise;
    };

    const getInstance = () => {
        if (!instancePromise) {
            const creating = loadEngine().then(async (engine) => {
                let rejectInstantiate!: (error: unknown) => void;
                const instantiateFailed = new Promise<never>((_resolve, reject) => {
                    rejectInstantiate = reject;
                });
                const mod = await Promise.race([
                    engine.factory({
                        instantiateWasm(imports, receive) {
                            WebAssembly.instantiate(engine.module, imports).then(
                                created => receive(created, engine.module),
                                error => rejectInstantiate(error),
                            );
                            return {};
                        },
                        print: () => {},
                        printErr: () => {},
                    }),
                    instantiateFailed,
                ]);
                mod.evbReadComponentSync = (docId: number, name: string) => {
                    const reader = syncReadersByDocId.get(docId);
                    return reader ? reader(name) : null;
                };
                liveInstance = mod;
                return mod;
            });
            creating.catch(() => {
                instancePromise = null;
                liveInstance = null;
            });
            instancePromise = creating;
        }
        return instancePromise;
    };

    let callChain: Promise<unknown> = Promise.resolve();
    const withModuleLock = <T>(work: () => Promise<T>): Promise<T> => {
        const next = callChain.catch(() => undefined).then(work);
        callChain = next.catch(() => undefined);
        return next;
    };

    const readError = (mod: IDjvuLibreEmscriptenModule) => {
        const ptr = mod._evb_djvu_error_ptr();
        const len = mod._evb_djvu_error_len();
        return len > 0 ? utf8Decoder.decode(mod.HEAPU8.subarray(ptr, ptr + len)) : 'DjVuLibre operation failed';
    };

    const readMissingComponent = (mod: IDjvuLibreEmscriptenModule) => {
        const ptr = mod._evb_djvu_missing_component_ptr();
        const len = mod._evb_djvu_missing_component_len();
        return len > 0 ? utf8Decoder.decode(mod.HEAPU8.subarray(ptr, ptr + len)) : '';
    };

    const takeOutputBytes = (mod: IDjvuLibreEmscriptenModule) => {
        const ptr = mod._evb_djvu_output_ptr();
        const len = mod._evb_djvu_output_len();
        const bytes = len > 0 ? mod.HEAPU8.slice(ptr, ptr + len) : new Uint8Array(0);
        mod._evb_djvu_release_output();
        return bytes;
    };

    const takeOutputText = (mod: IDjvuLibreEmscriptenModule) => {
        const ptr = mod._evb_djvu_output_ptr();
        const len = mod._evb_djvu_output_len();
        const text = len > 0 ? utf8Decoder.decode(mod.HEAPU8.subarray(ptr, ptr + len)) : '';
        mod._evb_djvu_release_output();
        return text;
    };

    const provideComponent = (mod: IDjvuLibreEmscriptenModule, handle: number, name: string, bytes: Uint8Array) => {
        if (bytes.byteLength > DJVU_MAX_COMPONENT_BYTES) {
            throw new RangeError(
                `DjVu component ${name} (${bytes.byteLength} bytes) exceeds the ${DJVU_MAX_COMPONENT_BYTES}-byte limit`,
            );
        }
        const nameByteLength = mod.lengthBytesUTF8(name);
        const namePtr = mod._malloc(nameByteLength + 1);
        if (!namePtr) {
            throw new Error('Out of memory allocating DjVu component name');
        }
        const dataPtr = mod._malloc(Math.max(1, bytes.byteLength));
        if (!dataPtr) {
            mod._free(namePtr);
            throw new Error('Out of memory allocating DjVu component buffer');
        }
        try {
            mod.stringToUTF8(name, namePtr, nameByteLength + 1);
            if (bytes.byteLength > 0) {
                mod.HEAPU8.set(bytes, dataPtr);
            }
            const status = mod._evb_djvu_provide_component(handle, namePtr, nameByteLength, dataPtr, bytes.byteLength);
            if (status !== EVB_DJVU_OK) {
                const message = readError(mod);
                if (status === EVB_DJVU_ERR_OOM) {
                    throw new RangeError(`Out of memory: ${message}`);
                }
                throw new Error(message);
            }
        } finally {
            mod._free(namePtr);
            mod._free(dataPtr);
        }
    };

    return {
        async openDocument(options: IDjvuOpenDocumentOptions): Promise<IDjvuLibreDocument> {
            if (options.initBytes.byteLength > DJVU_MAX_LEGACY_BUNDLED_BYTES) {
                throw new RangeError(
                    `DjVu document input (${options.initBytes.byteLength} bytes) exceeds the ${DJVU_MAX_LEGACY_BUNDLED_BYTES}-byte limit`,
                );
            }
            const mod = await getInstance();
            const docId = nextDocId++;
            if (options.readComponentSync) {
                syncReadersByDocId.set(docId, options.readComponentSync);
            }
            const initPtr = mod._malloc(Math.max(1, options.initBytes.byteLength));
            if (!initPtr) {
                syncReadersByDocId.delete(docId);
                throw new Error('Out of memory opening DjVu document');
            }
            let handle = 0;
            try {
                if (options.initBytes.byteLength > 0) {
                    mod.HEAPU8.set(options.initBytes, initPtr);
                }
                handle = mod._evb_djvu_open(
                    docId,
                    initPtr,
                    options.initBytes.byteLength,
                    options.cacheBytes ?? DEFAULT_CACHE_BYTES,
                );
            } finally {
                mod._free(initPtr);
            }
            if (!handle) {
                syncReadersByDocId.delete(docId);
                throw new Error(readError(mod));
            }

            let closed = false;
            const assertOpen = () => {
                if (closed) {
                    throw new Error('DjVu document handle has been closed');
                }
            };

            const callWithComponentRetry = async (invoke: () => number): Promise<void> => {
                assertOpen();
                try {
                    for (let attempt = 0; attempt <= MAX_COMPONENT_FETCH_RETRIES; attempt += 1) {
                        const status = invoke();
                        if (status === EVB_DJVU_OK) {
                            return;
                        }
                        if (status === EVB_DJVU_NEED_COMPONENT) {
                            const missingName = readMissingComponent(mod);
                            if (!missingName || !options.readComponentAsync) {
                                throw new Error(`DjVu component is unavailable: ${missingName || '(unknown)'}`);
                            }
                            if (attempt === MAX_COMPONENT_FETCH_RETRIES) {
                                throw new Error(`Exceeded DjVu component fetch limit while loading ${missingName}`);
                            }
                            const componentBytes = await options.readComponentAsync(missingName);
                            assertOpen();
                            provideComponent(mod, handle, missingName, componentBytes);
                            continue;
                        }
                        const errorMessage = readError(mod);
                        if (status === EVB_DJVU_ERR_OOM) {
                            throw new RangeError(`Out of memory: ${errorMessage}`);
                        }
                        throw new Error(errorMessage);
                    }
                } finally {
                    if (!closed) {
                        mod._evb_djvu_unpin_components(handle);
                    }
                }
            };

            const doc: IDjvuLibreDocument = {
                getDocInfo() {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_get_doc_info(handle));
                        return JSON.parse(takeOutputText(mod)) as IDjvuDocInfo;
                    });
                },
                async getComponentDirectory() {
                    const info = await doc.getDocInfo();
                    if (info.files.length === 0) {
                        return null;
                    }
                    return {
                        names: info.files.map(file => file.id || file.name),
                        flags: info.files.map(file => DIRM_TYPE_FLAGS[file.type] ?? 0),
                    };
                },
                getPageInfo(pageNumber) {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_get_page_info(handle, pageNumber - 1));
                        return JSON.parse(takeOutputText(mod)) as IDjvuPageInfo;
                    });
                },
                getPageStructure(pageNumber) {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_get_page_structure(handle, pageNumber - 1));
                        return JSON.parse(takeOutputText(mod)) as IDjvuPageStructure;
                    });
                },
                async getPageLayerSummary(pageNumber, defaultForegroundSubsample = DJVU_COMPACT_FOREGROUND_SUBSAMPLE) {
                    const structure = await doc.getPageStructure(pageNumber);
                    const info = structure.info ?? await doc.getPageInfo(pageNumber);
                    const width = info.width;
                    const height = info.height;
                    const dpi = info.dpi;
                    const rotation = structure.rotation;
                    const maskChunkBytes = structure.hasMask ? structure.maskBytes : null;
                    const hasBackground = Boolean(structure.background?.present);
                    const backgroundWidth = structure.background?.width ?? null;
                    const backgroundHeight = structure.background?.height ?? null;

                    let foreground = null;
                    if (
                        maskChunkBytes !== null
                        && maskChunkBytes >= DJVU_COMPACT_REAL_MASK_MIN_BYTES
                        && structure.foreground?.present
                    ) {
                        const fgSubsample = deriveLayerSubsample(
                            width,
                            height,
                            structure.foreground.width,
                            structure.foreground.height,
                        ) ?? Math.max(1, Math.trunc(defaultForegroundSubsample));
                        const targetWidth = Math.max(1, Math.ceil(width / fgSubsample));
                        const targetHeight = Math.max(1, Math.ceil(height / fgSubsample));
                        const rendered = await doc.renderPage(pageNumber, {
                            mode: 'foreground',
                            pixelFormat: 'rgb',
                            targetWidth,
                            targetHeight,
                        });
                        if (rendered.present && rendered.bytes.byteLength > 0) {
                            foreground = analyzeForegroundColorRaster(
                                rendered.bytes,
                                rendered.width,
                                rendered.height,
                                3,
                            );
                        }
                    }

                    return {
                        width,
                        height,
                        dpi,
                        rotation,
                        maskChunkBytes,
                        hasBackground,
                        backgroundWidth,
                        backgroundHeight,
                        foreground,
                    };
                },
                renderPage(pageNumber, renderOptions = {}) {
                    return withModuleLock(async () => {
                        const mode = renderOptions.mode ?? 'color';
                        const pixelFormat = renderOptions.pixelFormat ?? 'rgba';
                        const fullW = renderOptions.targetWidth ?? 0;
                        const fullH = renderOptions.targetHeight ?? 0;
                        const rect = renderOptions.rect;
                        await callWithComponentRetry(() => mod._evb_djvu_render_page(
                            handle,
                            pageNumber - 1,
                            RENDER_MODE_CODES[mode],
                            PIXEL_FORMAT_CODES[pixelFormat],
                            fullW,
                            fullH,
                            rect?.x ?? 0,
                            rect?.y ?? 0,
                            rect?.width ?? fullW,
                            rect?.height ?? fullH,
                        ));
                        const width = mod._evb_djvu_render_width();
                        const height = mod._evb_djvu_render_height();
                        const present = mod._evb_djvu_render_present() !== 0;
                        const bytes = takeOutputBytes(mod);
                        return {
                            width,
                            height,
                            present,
                            format: pixelFormat,
                            bytes,
                        };
                    });
                },
                async renderMaskPbm(pageNumber) {
                    const rendered = await doc.renderPage(pageNumber, {
                        mode: 'mask',
                        pixelFormat: 'pbm',
                    });
                    if (!rendered.present || rendered.bytes.byteLength === 0) {
                        return null;
                    }
                    return encodePbmP4(rendered.width, rendered.height, rendered.bytes);
                },
                async renderBackgroundRgb(pageNumber) {
                    const structure = await doc.getPageStructure(pageNumber);
                    if (!structure.background?.present) {
                        return null;
                    }
                    const pageInfo = structure.info ?? await doc.getPageInfo(pageNumber);
                    const bgSubsample = deriveLayerSubsample(
                        pageInfo.width,
                        pageInfo.height,
                        structure.background.width,
                        structure.background.height,
                    ) ?? 1;
                    const targetWidth = Math.max(1, Math.ceil(pageInfo.width / bgSubsample));
                    const targetHeight = Math.max(1, Math.ceil(pageInfo.height / bgSubsample));
                    const rendered = await doc.renderPage(pageNumber, {
                        mode: 'background',
                        pixelFormat: 'rgb',
                        targetWidth,
                        targetHeight,
                    });
                    if (!rendered.present || rendered.bytes.byteLength === 0) {
                        return null;
                    }
                    return {
                        width: rendered.width,
                        height: rendered.height,
                        rgb: rendered.bytes,
                    };
                },
                async renderPagePpm(pageNumber, renderOptions = {}) {
                    const rendered = await doc.renderPage(pageNumber, {
                        ...renderOptions,
                        pixelFormat: 'rgb',
                    });
                    if (!rendered.present || rendered.bytes.byteLength === 0) {
                        return null;
                    }
                    return {
                        width: rendered.width,
                        height: rendered.height,
                        ppm: encodePpmP6(rendered.width, rendered.height, rendered.bytes),
                    };
                },
                getOutline() {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_get_outline(handle));
                        const len = mod._evb_djvu_output_len();
                        if (len > DJVU_OUTLINE_MAX_BYTES) {
                            mod._evb_djvu_release_output();
                            throw new Error(`DjVu outline metadata exceeded ${DJVU_OUTLINE_MAX_BYTES} bytes`);
                        }
                        return JSON.parse(takeOutputText(mod)) as IDjvuOutlineRawItem[];
                    });
                },
                getPageText(pageNumber, textOptions = {}) {
                    return withModuleLock(async () => {
                        const includeZones = textOptions.includeZones ?? true;
                        const maxZones = textOptions.maxZones ?? DJVU_SEARCH_MAX_PAGE_ZONES;
                        await callWithComponentRetry(() => mod._evb_djvu_get_page_text(
                            handle,
                            pageNumber - 1,
                            includeZones ? 1 : 0,
                            maxZones,
                        ));
                        return JSON.parse(takeOutputText(mod)) as IDjvuPageTextRaw;
                    });
                },
                pageHasText(pageNumber) {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_page_has_text(handle, pageNumber - 1));
                        return mod._evb_djvu_render_present() !== 0;
                    });
                },
                async hasText(maxPages) {
                    const info = await doc.getDocInfo();
                    const limit = maxPages === undefined ? info.pageCount : Math.min(info.pageCount, maxPages);
                    for (let page = 1; page <= limit; page += 1) {
                        if (await doc.pageHasText(page)) {
                            return true;
                        }
                    }
                    return false;
                },
                getMetadata() {
                    return withModuleLock(async () => {
                        await callWithComponentRetry(() => mod._evb_djvu_get_metadata(handle));
                        return JSON.parse(takeOutputText(mod)) as Record<string, string>;
                    });
                },
                clearCache() {
                    if (!closed) {
                        mod._evb_djvu_clear_cache(handle);
                    }
                },
                close() {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    syncReadersByDocId.delete(docId);
                    mod._evb_djvu_close(handle);
                },
            };

            return doc;
        },
        getHeapBytes() {
            return liveInstance?.HEAPU8.byteLength ?? 0;
        },
        dispose() {
            syncReadersByDocId.clear();
            liveInstance = null;
            instancePromise = null;
        },
    };
}
