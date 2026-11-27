import type { IDjvuCompactForegroundColor } from '@contracts/djvuConversionPolicy';

/** Emscripten module surface exported by `scripts/build-djvulibre-wasm.sh`. */
export interface IDjvuLibreEmscriptenModule {
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    UTF8ToString(ptr: number, maxBytesToRead?: number): string;
    stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): void;
    lengthBytesUTF8(str: string): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _evb_djvu_open(docId: number, initPtr: number, initLen: number, cacheBytes: number): number;
    _evb_djvu_close(handle: number): void;
    _evb_djvu_clear_cache(handle: number): void;
    _evb_djvu_unpin_components(handle: number): void;
    _evb_djvu_provide_component(
        handle: number,
        namePtr: number,
        nameLen: number,
        dataPtr: number,
        dataLen: number,
    ): number;
    _evb_djvu_get_doc_info(handle: number): number;
    _evb_djvu_get_page_info(handle: number, pageIndex0: number): number;
    _evb_djvu_get_page_structure(handle: number, pageIndex0: number): number;
    _evb_djvu_render_page(
        handle: number,
        pageIndex0: number,
        mode: number,
        pixelFormat: number,
        fullW: number,
        fullH: number,
        rectX: number,
        rectY: number,
        rectW: number,
        rectH: number,
    ): number;
    _evb_djvu_get_outline(handle: number): number;
    _evb_djvu_get_page_text(
        handle: number,
        pageIndex0: number,
        includeZones: number,
        maxZones: number,
    ): number;
    _evb_djvu_page_has_text(handle: number, pageIndex0: number): number;
    _evb_djvu_get_metadata(handle: number): number;
    _evb_djvu_output_ptr(): number;
    _evb_djvu_output_len(): number;
    _evb_djvu_release_output(): void;
    _evb_djvu_error_ptr(): number;
    _evb_djvu_error_len(): number;
    _evb_djvu_missing_component_ptr(): number;
    _evb_djvu_missing_component_len(): number;
    _evb_djvu_render_width(): number;
    _evb_djvu_render_height(): number;
    _evb_djvu_render_present(): number;
    evbReadComponentSync?: ((docId: number, name: string) => Uint8Array | null | false) | null;
}

export type TDjvuLibreModuleFactory = (options: {
    instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => object;
    print?: (line: string) => void;
    printErr?: (line: string) => void;
}) => Promise<IDjvuLibreEmscriptenModule>;

export type TDjvuRenderMode = 'color' | 'black' | 'mask' | 'background' | 'foreground';

export type TDjvuPixelFormat = 'rgba' | 'rgb' | 'pbm';

export type TDjvuRotationDegrees = 0 | 90 | 180 | 270;

export interface IDjvuDocFileEntry {
    id: string;
    name: string;
    title: string;
    type: 'page' | 'include' | 'thumbnail' | 'shared-anno';
    pageNumber: number | null;
    size: number;
}

export interface IDjvuDocInfo {
    pageCount: number;
    docType: 'single' | 'bundled' | 'indirect' | 'old-bundled' | 'old-indexed' | 'unknown';
    hasOutline: boolean;
    files: IDjvuDocFileEntry[];
}

export interface IDjvuPageInfo {
    width: number;
    height: number;
    rawWidth: number;
    rawHeight: number;
    dpi: number;
    rotation: TDjvuRotationDegrees;
    pageType: 'bitonal' | 'photo' | 'compound' | 'unknown';
}

export interface IDjvuPageLayerChunk {
    present: boolean;
    kind: string;
    bytes: number;
    width: number | null;
    height: number | null;
}

export interface IDjvuPageStructure {
    pageNumber: number;
    pageBytes: number;
    rotation: TDjvuRotationDegrees;
    info: {
        width: number;
        height: number;
        dpi: number;
    } | null;
    hasMask: boolean;
    maskBytes: number | null;
    background: IDjvuPageLayerChunk | null;
    foreground: IDjvuPageLayerChunk | null;
}

export interface IDjvuPageLayerSummary {
    width: number;
    height: number;
    dpi: number;
    rotation: TDjvuRotationDegrees;
    maskChunkBytes: number | null;
    hasBackground: boolean;
    backgroundWidth: number | null;
    backgroundHeight: number | null;
    foreground: IDjvuCompactForegroundColor | null;
}

export interface IDjvuRenderRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IDjvuRenderPageOptions {
    mode?: TDjvuRenderMode;
    pixelFormat?: TDjvuPixelFormat;
    targetWidth?: number;
    targetHeight?: number;
    rect?: IDjvuRenderRect;
}

export interface IDjvuRenderedPage {
    width: number;
    height: number;
    present: boolean;
    format: TDjvuPixelFormat;
    bytes: Uint8Array;
}

export interface IDjvuOutlineRawItem {
    title: string;
    url: string;
    children: IDjvuOutlineRawItem[];
}

export interface IDjvuTextRawZone {
    type: string;
    lineId: number;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
    text: string;
}

export interface IDjvuPageTextRaw {
    text: string;
    pageWidth: number;
    pageHeight: number;
    zones: IDjvuTextRawZone[];
}

export interface IDjvuComponentDirectory {
    names: string[];
    flags: number[];
}

export interface IDjvuComponentRequest {
    index: number;
    name: string;
}
