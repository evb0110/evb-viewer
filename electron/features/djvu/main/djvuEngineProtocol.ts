import type { IDjvuPageSize } from '@contracts/electronApiDjvu';
import type {
    IDjvuDocInfo,
    IDjvuOutlineRawItem,
    IDjvuPageInfo,
    IDjvuPageStructure,
    IDjvuPageTextRaw,
    TDjvuRenderMode,
} from '@djvu-core/djvuLibreTypes';

export interface IDjvuEngineWorkerData {
    engineDir: string;
}

export type TDjvuNetpbmFormat = 'pbm' | 'pgm' | 'ppm';

export interface IDjvuEngineRenderToFileOptions {
    format: TDjvuNetpbmFormat;
    mode?: TDjvuRenderMode;
    subsample?: number;
    targetWidthPx?: number;
    targetHeightPx?: number;
}

export interface IDjvuEngineRenderToFileResult {
    width: number;
    height: number;
    present: boolean;
}

export interface IDjvuEngineDocInfoResult extends IDjvuDocInfo {
    sourceDpi: number;
}

export interface IDjvuEngineOutlineResult {
    raw: IDjvuOutlineRawItem[];
    pageComponents: Record<string, number>;
    pageCount: number;
}

export type TDjvuEngineWorkerRequest =
    | {
        id: number;
        type: 'getDocInfo';
        djvuPath: string;
    }
    | {
        id: number;
        type: 'getPageInfo';
        djvuPath: string;
        pageNumber: number;
    }
    | {
        id: number;
        type: 'getPageSizes';
        djvuPath: string;
        pageNumbers?: readonly number[];
    }
    | {
        id: number;
        type: 'getPageStructures';
        djvuPath: string;
        pageNumbers?: readonly number[];
    }
    | {
        id: number;
        type: 'getOutline';
        djvuPath: string;
    }
    | {
        id: number;
        type: 'getMetadata';
        djvuPath: string;
    }
    | {
        id: number;
        type: 'hasText';
        djvuPath: string;
    }
    | {
        id: number;
        type: 'getPageText';
        djvuPath: string;
        pageNumber: number;
        includeZones: boolean;
    }
    | {
        id: number;
        type: 'renderPageToFile';
        djvuPath: string;
        pageNumber: number;
        outputPath: string;
        options: IDjvuEngineRenderToFileOptions;
    };

export type TDjvuEngineWorkerReply =
    | {
        id: number;
        ok: true;
        heapBytes: number;
        result: unknown;
    }
    | {
        id: number;
        ok: false;
        heapBytes: number;
        error: string;
        errorName?: string;
    };

export type TDjvuEngineResultMap = {
    getDocInfo: IDjvuEngineDocInfoResult;
    getPageInfo: IDjvuPageInfo;
    getPageSizes: IDjvuPageSize[];
    getPageStructures: IDjvuPageStructure[];
    getOutline: IDjvuEngineOutlineResult;
    getMetadata: Record<string, string>;
    hasText: boolean;
    getPageText: IDjvuPageTextRaw;
    renderPageToFile: IDjvuEngineRenderToFileResult;
};
