import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';

interface IPageMutationWorkerResult {
    data: Uint8Array;
    pageCount: number;
}

interface IBrowserPdfCombineBookmarkEntry {
    title: string;
    pageIndex: number | null;
    pageYRatio?: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IBrowserPdfCombineBookmarkEntry[];
}

interface IBrowserPdfCombinePageLabelRange {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

interface IBrowserPdfCombineCatalog {
    bookmarks: IBrowserPdfCombineBookmarkEntry[];
    pageLabels: IBrowserPdfCombinePageLabelRange[];
}

interface IBrowserPdfConformanceFacts {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    hasAcroForm: boolean;
    hasXfa: boolean;
}

interface IBrowserPageOpsWorkerRequestMap {
    deletePages: {
        data: Uint8Array;
        pages: number[];
    };
    extractPages: {
        data: Uint8Array;
        pages: number[];
    };
    reorderPages: {
        data: Uint8Array;
        newOrder: number[];
    };
    insertPages: {
        data: Uint8Array;
        insertionData: Uint8Array;
        afterPage: number;
    };
    rotate: {
        data: Uint8Array;
        pages: number[];
        angle: 90 | 180 | 270;
    };
    crop: {
        data: Uint8Array;
        pages: number[];
        margins: ICropMargins;
    };
    removeCrop: {
        data: Uint8Array;
        pages: number[];
    };
    getPageGeometry: {
        data: Uint8Array;
        pageNumber: number;
    };
    parseAnnotations: {data: Uint8Array;};
    readCatalog: {data: Uint8Array;};
    conformance: {data: Uint8Array;};
    mergePages: {documents: Uint8Array[];};
}

interface IBrowserPageOpsWorkerResultMap {
    deletePages: IPageMutationWorkerResult;
    extractPages: IPageMutationWorkerResult;
    reorderPages: IPageMutationWorkerResult;
    insertPages: IPageMutationWorkerResult;
    rotate: IPageMutationWorkerResult;
    crop: IPageMutationWorkerResult;
    removeCrop: IPageMutationWorkerResult;
    getPageGeometry: IPageGeometry;
    parseAnnotations: {data: Uint8Array;};
    readCatalog: IBrowserPdfCombineCatalog;
    conformance: IBrowserPdfConformanceFacts;
    mergePages: IPageMutationWorkerResult;
}

type TBrowserPageOpsWorkerRequestType = keyof IBrowserPageOpsWorkerRequestMap;

interface IBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType = TBrowserPageOpsWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserPageOpsWorkerRequestMap[K];
}

type TBrowserPageOpsWorkerRequest = {
    [K in TBrowserPageOpsWorkerRequestType]: IBrowserPageOpsWorkerRequest<K>;
}[TBrowserPageOpsWorkerRequestType];

type TBrowserPageOpsWorkerResponse =
    | {
        [K in TBrowserPageOpsWorkerRequestType]: {
            id: number;
            type: K;
            ok: true;
            data: IBrowserPageOpsWorkerResultMap[K];
        };
    }[TBrowserPageOpsWorkerRequestType]
    | {
        id: number;
        ok: false;
        error: string;
    };


function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isPositiveIntegerArray(value: unknown): value is number[] {
    return Array.isArray(value)
        && value.every(isPositiveInteger);
}

function isCropMargins(value: unknown): value is ICropMargins {
    try {
        normalizeCropMargins(value);
        return true;
    } catch {
        return false;
    }
}

function getPdfData(value: Record<string, unknown>) {
    return value.data instanceof Uint8Array
        ? value.data
        : null;
}

function getPdfDocuments(value: Record<string, unknown>) {
    if (
        !Array.isArray(value.documents)
        || value.documents.length === 0
        || value.documents.length > 500
        || !value.documents.every(document => document instanceof Uint8Array)
    ) {
        return null;
    }
    return value.documents;
}

export function getBrowserPageOpsWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPageOpsWorkerRequest(value: unknown): TBrowserPageOpsWorkerRequest | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.id) || typeof value.type !== 'string' || !isRecord(value.payload)) {
        return null;
    }
    switch (value.type) {
        case 'deletePages':
        case 'extractPages':
        case 'removeCrop':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return isPositiveIntegerArray(value.payload.pages)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                    },
                }
                : null;
        }
        case 'reorderPages':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return isPositiveIntegerArray(value.payload.newOrder)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        newOrder: value.payload.newOrder,
                    },
                }
                : null;
        }
        case 'insertPages':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return value.payload.insertionData instanceof Uint8Array && isNonNegativeInteger(value.payload.afterPage)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        insertionData: value.payload.insertionData,
                        afterPage: value.payload.afterPage,
                    },
                }
                : null;
        }
        case 'rotate':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return isPositiveIntegerArray(value.payload.pages)
                && (
                    value.payload.angle === 90
                    || value.payload.angle === 180
                    || value.payload.angle === 270
                )
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                        angle: value.payload.angle,
                    },
                }
                : null;
        }
        case 'crop':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return isPositiveIntegerArray(value.payload.pages) && isCropMargins(value.payload.margins)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                        margins: value.payload.margins,
                    },
                }
                : null;
        }
        case 'getPageGeometry':
        {
            const data = getPdfData(value.payload);
            if (data === null) {
                return null;
            }
            return isPositiveInteger(value.payload.pageNumber)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pageNumber: value.payload.pageNumber,
                    },
                }
                : null;
        }
        case 'parseAnnotations':
        case 'readCatalog':
        case 'conformance':
        {
            const data = getPdfData(value.payload);
            return data === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload: {data},
                };
        }
        case 'mergePages':
        {
            const documents = getPdfDocuments(value.payload);
            return documents === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload: {documents},
                };
        }
        default:
            return null;
    }
}

export type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    IBrowserPdfCombineBookmarkEntry,
    IBrowserPdfCombinePageLabelRange,
    IBrowserPdfCombineCatalog,
    IBrowserPdfConformanceFacts,
    IBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
};
