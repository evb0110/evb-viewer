import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import type {
    IBrowserPdfCombineBookmarkEntry,
    IBrowserPdfCombineCatalog,
    IBrowserPdfCombinePageLabelRange,
} from '@app/platform/browser-api/browserPageOpsWorker.types';

interface IBrowserPdfCombineInput {
    fileName: string;
    data: Uint8Array;
}

interface IBrowserPdfCombinePageSize {
    widthPoints: number;
    heightPoints: number;
}

type TBrowserPdfCombineWasmPageKind = 'image' | 'mask' | 'layered' | 'layered-color';
type TBrowserPdfCombineRgb = [number, number, number];

interface IBrowserPdfCombineWasmPageSpec {
    kind: TBrowserPdfCombineWasmPageKind;
    pageSize: IBrowserPdfCombinePageSize;
    jpegQuality?: number;
    ppiCap?: number;
    rotationDegrees?: 0 | 90 | 180 | 270;
    foregroundColor?: TBrowserPdfCombineRgb;
    image?: IBrowserPdfCombineInput;
    background?: IBrowserPdfCombineInput;
    mask?: IBrowserPdfCombineInput;
}

interface IBrowserPdfCombineWasmImagePreprocessing {
    jpegQuality?: number;
    ppiCap?: number;
    pageSizes?: IBrowserPdfCombinePageSize[];
    pageSpecs?: IBrowserPdfCombineWasmPageSpec[];
    catalog?: IBrowserPdfCombineCatalog;
}

interface IBrowserPdfCombinePayload {
    inputs: IBrowserPdfCombineInput[];
    wasmImagePreprocessing?: IBrowserPdfCombineWasmImagePreprocessing;
}

interface IBrowserPdfCombineWorkerRequestMap {combinePdfs: IBrowserPdfCombinePayload;}

interface IBrowserPdfCombineWorkerResultMap {combinePdfs: {data: Uint8Array;};}

type TBrowserPdfCombineWorkerRequestType = keyof IBrowserPdfCombineWorkerRequestMap;

interface IBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType = TBrowserPdfCombineWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserPdfCombineWorkerRequestMap[K];
}

type TBrowserPdfCombineWorkerRequest = {
    [K in TBrowserPdfCombineWorkerRequestType]: IBrowserPdfCombineWorkerRequest<K>;
}[TBrowserPdfCombineWorkerRequestType];

type TBrowserPdfCombineWorkerResponse =
    | {
        [K in TBrowserPdfCombineWorkerRequestType]: {
            id: number;
            type: K;
            ok: true;
            data: IBrowserPdfCombineWorkerResultMap[K];
        };
    }[TBrowserPdfCombineWorkerRequestType]
    | {
        id: number;
        ok: false;
        error: string;
        errorEnvelope?: INativeErrorEnvelope;
    };


function parseBrowserPdfCombineInput(value: unknown): IBrowserPdfCombineInput | null {
    if (
        !isRecord(value)
        || typeof value.fileName !== 'string'
        || value.fileName.trim().length === 0
        || !(value.data instanceof Uint8Array)
    ) {
        return null;
    }
    return {
        fileName: value.fileName,
        data: value.data,
    };
}

function parsePositiveFiniteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

function parseOptionalBoundedInteger(
    value: unknown,
    minValue: number,
    maxValue: number,
): number | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < minValue
        || value > maxValue
    ) {
        return null;
    }
    return value;
}

function parseBrowserPdfCombinePageSize(value: unknown): IBrowserPdfCombinePageSize | null {
    if (!isRecord(value)) {
        return null;
    }
    const widthPoints = parsePositiveFiniteNumber(value.widthPoints);
    const heightPoints = parsePositiveFiniteNumber(value.heightPoints);
    if (widthPoints === null || heightPoints === null) {
        return null;
    }
    return {
        widthPoints,
        heightPoints,
    };
}

function parseBrowserPdfCombineWasmPageKind(value: unknown): TBrowserPdfCombineWasmPageKind | null {
    return value === 'image'
        || value === 'mask'
        || value === 'layered'
        || value === 'layered-color'
        ? value
        : null;
}

function parseOptionalWasmInput(value: unknown): IBrowserPdfCombineInput | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return parseBrowserPdfCombineInput(value);
}

function parseOptionalRgb(value: unknown): TBrowserPdfCombineRgb | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length !== 3) {
        return null;
    }
    const red = parseOptionalBoundedInteger(value[0], 0, 255);
    const green = parseOptionalBoundedInteger(value[1], 0, 255);
    const blue = parseOptionalBoundedInteger(value[2], 0, 255);
    if (
        typeof red !== 'number'
        || typeof green !== 'number'
        || typeof blue !== 'number'
    ) {
        return null;
    }
    return [
        red,
        green,
        blue,
    ];
}

function parseBrowserPdfCombineWasmPageSpec(value: unknown): IBrowserPdfCombineWasmPageSpec | null {
    if (!isRecord(value)) {
        return null;
    }
    const kind = parseBrowserPdfCombineWasmPageKind(value.kind);
    const pageSize = parseBrowserPdfCombinePageSize(value.pageSize);
    const jpegQuality = parseOptionalBoundedInteger(value.jpegQuality, 1, 100);
    const ppiCap = parseOptionalBoundedInteger(value.ppiCap, 0, 1200);
    const rotationDegrees = value.rotationDegrees === undefined
        ? undefined
        : value.rotationDegrees === 0
            || value.rotationDegrees === 90
            || value.rotationDegrees === 180
            || value.rotationDegrees === 270
            ? value.rotationDegrees
            : null;
    const foregroundColor = parseOptionalRgb(value.foregroundColor);
    const image = parseOptionalWasmInput(value.image);
    const background = parseOptionalWasmInput(value.background);
    const mask = parseOptionalWasmInput(value.mask);
    if (
        kind === null
        || pageSize === null
        || jpegQuality === null
        || ppiCap === null
        || rotationDegrees === null
        || foregroundColor === null
        || image === null
        || background === null
        || mask === null
    ) {
        return null;
    }

    if (
        (kind === 'image' && image === undefined)
        || (kind === 'mask' && mask === undefined)
        || (kind === 'layered' && (background === undefined || mask === undefined))
        || (kind === 'layered-color' && (background === undefined || mask === undefined || foregroundColor === undefined))
    ) {
        return null;
    }

    const parsed: IBrowserPdfCombineWasmPageSpec = {
        kind,
        pageSize,
    };
    if (jpegQuality !== undefined) {
        parsed.jpegQuality = jpegQuality;
    }
    if (ppiCap !== undefined) {
        parsed.ppiCap = ppiCap;
    }
    if (rotationDegrees !== undefined) {
        parsed.rotationDegrees = rotationDegrees;
    }
    if (foregroundColor !== undefined) {
        parsed.foregroundColor = foregroundColor;
    }
    if (image !== undefined) {
        parsed.image = image;
    }
    if (background !== undefined) {
        parsed.background = background;
    }
    if (mask !== undefined) {
        parsed.mask = mask;
    }
    return parsed;
}

function parseCatalogBookmark(
    value: unknown,
    depth: number,
    state: {count: number},
): IBrowserPdfCombineBookmarkEntry | null {
    if (!isRecord(value) || depth >= 64 || state.count >= 5_000 || !Array.isArray(value.items)) {
        return null;
    }
    if (
        typeof value.title !== 'string'
        || (value.pageIndex !== null && (typeof value.pageIndex !== 'number' || !Number.isSafeInteger(value.pageIndex) || value.pageIndex < 0))
        || (value.pageYRatio !== undefined
            && value.pageYRatio !== null
            && (typeof value.pageYRatio !== 'number' || !Number.isFinite(value.pageYRatio)))
        || (value.namedDest !== null && typeof value.namedDest !== 'string')
        || typeof value.bold !== 'boolean'
        || typeof value.italic !== 'boolean'
        || (value.color !== null && typeof value.color !== 'string')
        || value.items.length > 5_000
    ) {
        return null;
    }
    state.count += 1;
    const items: IBrowserPdfCombineBookmarkEntry[] = [];
    for (const item of value.items) {
        const parsed = parseCatalogBookmark(item, depth + 1, state);
        if (parsed === null) {
            return null;
        }
        items.push(parsed);
    }
    return {
        title: value.title,
        pageIndex: value.pageIndex,
        ...(value.pageYRatio === undefined ? {} : {pageYRatio: value.pageYRatio}),
        namedDest: value.namedDest,
        bold: value.bold,
        italic: value.italic,
        color: value.color,
        items,
    };
}

function parseBrowserPdfCombineCatalog(value: unknown): IBrowserPdfCombineCatalog | null {
    if (!isRecord(value) || !Array.isArray(value.bookmarks) || !Array.isArray(value.pageLabels)) {
        return null;
    }
    if (value.bookmarks.length > 5_000 || value.pageLabels.length > 2_048) {
        return null;
    }
    const state = {count: 0};
    const bookmarks: IBrowserPdfCombineBookmarkEntry[] = [];
    for (const bookmark of value.bookmarks) {
        const parsed = parseCatalogBookmark(bookmark, 0, state);
        if (parsed === null) {
            return null;
        }
        bookmarks.push(parsed);
    }
    const pageLabels: IBrowserPdfCombinePageLabelRange[] = [];
    for (const range of value.pageLabels) {
        if (
            !isRecord(range)
            || typeof range.pageIndex !== 'number'
            || !Number.isSafeInteger(range.pageIndex)
            || range.pageIndex < 0
            || (range.style !== undefined && typeof range.style !== 'string')
            || (range.prefix !== undefined && typeof range.prefix !== 'string')
            || (range.start !== undefined
                && (typeof range.start !== 'number' || !Number.isSafeInteger(range.start) || range.start < 0))
        ) {
            return null;
        }
        pageLabels.push({
            pageIndex: range.pageIndex,
            ...(range.style === undefined ? {} : {style: range.style}),
            ...(range.prefix === undefined ? {} : {prefix: range.prefix}),
            ...(range.start === undefined ? {} : {start: range.start}),
        });
    }
    return {
        bookmarks,
        pageLabels,
    };
}

function parseBrowserPdfCombineWasmImagePreprocessing(
    value: unknown,
): IBrowserPdfCombineWasmImagePreprocessing | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }
    const jpegQuality = parseOptionalBoundedInteger(value.jpegQuality, 1, 100);
    const ppiCap = parseOptionalBoundedInteger(value.ppiCap, 0, 1200);
    const catalog = parseBrowserPdfCombineCatalog(value.catalog);
    if (
        jpegQuality === null
        || ppiCap === null
        || (value.catalog !== undefined && catalog === null)
    ) {
        return null;
    }

    let pageSizes: IBrowserPdfCombinePageSize[] | undefined;
    if (value.pageSizes !== undefined) {
        if (!Array.isArray(value.pageSizes) || value.pageSizes.length > 500) {
            return null;
        }
        pageSizes = [];
        for (const pageSize of value.pageSizes) {
            const parsedPageSize = parseBrowserPdfCombinePageSize(pageSize);
            if (parsedPageSize === null) {
                return null;
            }
            pageSizes.push(parsedPageSize);
        }
    }

    let pageSpecs: IBrowserPdfCombineWasmPageSpec[] | undefined;
    if (value.pageSpecs !== undefined) {
        if (!Array.isArray(value.pageSpecs) || value.pageSpecs.length === 0 || value.pageSpecs.length > 500) {
            return null;
        }
        pageSpecs = [];
        for (const pageSpec of value.pageSpecs) {
            const parsedPageSpec = parseBrowserPdfCombineWasmPageSpec(pageSpec);
            if (parsedPageSpec === null) {
                return null;
            }
            pageSpecs.push(parsedPageSpec);
        }
    }

    const parsed: IBrowserPdfCombineWasmImagePreprocessing = {};
    if (jpegQuality !== undefined) {
        parsed.jpegQuality = jpegQuality;
    }
    if (ppiCap !== undefined) {
        parsed.ppiCap = ppiCap;
    }
    if (pageSizes !== undefined) {
        parsed.pageSizes = pageSizes;
    }
    if (pageSpecs !== undefined) {
        parsed.pageSpecs = pageSpecs;
    }
    if (catalog !== null && catalog !== undefined) {
        parsed.catalog = catalog;
    }
    return parsed;
}

export function getBrowserPdfCombineWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPdfCombineWorkerRequest(value: unknown): TBrowserPdfCombineWorkerRequest | null {
    if (
        !isRecord(value)
        || !isSafeWorkerRequestId(value.id)
        || value.type !== 'combinePdfs'
        || !isRecord(value.payload)
        || !Array.isArray(value.payload.inputs)
        || value.payload.inputs.length === 0
        || value.payload.inputs.length > 500
    ) {
        return null;
    }
    const inputs: IBrowserPdfCombineInput[] = [];
    for (const input of value.payload.inputs) {
        const parsedInput = parseBrowserPdfCombineInput(input);
        if (parsedInput === null) {
            return null;
        }
        inputs.push(parsedInput);
    }
    const wasmImagePreprocessing = parseBrowserPdfCombineWasmImagePreprocessing(
        value.payload.wasmImagePreprocessing,
    );
    if (wasmImagePreprocessing === null) {
        return null;
    }
    return {
        id: value.id,
        type: value.type,
        payload: {
            inputs,
            ...(wasmImagePreprocessing === undefined ? {} : {wasmImagePreprocessing}),
        },
    };
}

export type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombinePageSize,
    IBrowserPdfCombinePayload,
    IBrowserPdfCombineWasmImagePreprocessing,
    IBrowserPdfCombineWasmPageSpec,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    IBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineRgb,
    TBrowserPdfCombineWasmPageKind,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
};
