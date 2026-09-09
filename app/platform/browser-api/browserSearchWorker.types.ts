import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import type {
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
} from '@contracts/search';
import {SEARCH_RESULT_LIMIT} from '@contracts/search';
import type { IBrowserSearchWorkerPageRecord } from '@app/platform/browser-api/browserSearchLegacyArrayPageLimit';

export const BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST = SEARCH_RESULT_LIMIT + 1;

interface IBrowserSearchWorkerRequestMap {
    extractDocumentText: {pdfPath: string;};
    streamDocumentText: {pdfPath: string;};
    matchPageText: {
        text: string;
        query: string;
        options: IResolvedSearchMatchOptions;
        maxMatches: number;
        deadlineAtMs?: number;
    };
    cancel: {requestId: number;};
    acknowledgePage: {requestId: number;};
}

interface IBrowserSearchWorkerResultMap {
    extractDocumentText: {
        pageCount: number;
        pageTexts: string[];
    };
    streamDocumentText: {pageCount: number;};
    matchPageText: {
        matches: IPdfSearchUtf16Range[];
        truncated: boolean;
    };
    cancel: {canceled: boolean;};
    acknowledgePage: {acknowledged: boolean;};
}

type TBrowserSearchWorkerRequestType = keyof IBrowserSearchWorkerRequestMap;

interface IBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType = TBrowserSearchWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserSearchWorkerRequestMap[K];
}

type TBrowserSearchWorkerRequest = {
    [K in TBrowserSearchWorkerRequestType]: IBrowserSearchWorkerRequest<K>;
}[TBrowserSearchWorkerRequestType];

type TBrowserSearchWorkerProgressResponse = {
    [K in TBrowserSearchWorkerRequestType]: {
        id: number;
        type: K;
        ok: true;
        progress: {
            processed: number;
            total: number;
        };
    };
}[TBrowserSearchWorkerRequestType];

type TBrowserSearchWorkerSuccessResponse = {
    [K in TBrowserSearchWorkerRequestType]: {
        id: number;
        type: K;
        ok: true;
        data: IBrowserSearchWorkerResultMap[K];
    };
}[TBrowserSearchWorkerRequestType];

interface IBrowserSearchWorkerPageResponse {
    id: number;
    type: 'streamDocumentText';
    ok: true;
    page: IBrowserSearchWorkerPageRecord;
}

interface IBrowserSearchWorkerErrorResponse {
    id: number;
    ok: false;
    error: string;
    errorCode?: 'SEARCH_REGEX_LIMIT';
}

type TBrowserSearchWorkerResponse =
    | TBrowserSearchWorkerProgressResponse
    | TBrowserSearchWorkerSuccessResponse
    | IBrowserSearchWorkerPageResponse
    | IBrowserSearchWorkerErrorResponse;


function parseExtractDocumentTextPayload(value: unknown): IBrowserSearchWorkerRequestMap['extractDocumentText'] | null {
    if (!isRecord(value) || typeof value.pdfPath !== 'string' || value.pdfPath.trim().length === 0) {
        return null;
    }
    return {pdfPath: value.pdfPath};
}

function parseStreamDocumentTextPayload(value: unknown): IBrowserSearchWorkerRequestMap['streamDocumentText'] | null {
    if (!isRecord(value) || typeof value.pdfPath !== 'string' || value.pdfPath.trim().length === 0) {
        return null;
    }
    return {pdfPath: value.pdfPath};
}

function parseMatchPageTextPayload(value: unknown): IBrowserSearchWorkerRequestMap['matchPageText'] | null {
    if (
        !isRecord(value)
        || typeof value.text !== 'string'
        || typeof value.query !== 'string'
        || !isRecord(value.options)
        || typeof value.options.matchCase !== 'boolean'
        || typeof value.options.wholeWord !== 'boolean'
        || typeof value.options.useRegex !== 'boolean'
        || typeof value.maxMatches !== 'number'
        || !Number.isSafeInteger(value.maxMatches)
        || value.maxMatches < 1
        || value.maxMatches > BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST
        || (value.deadlineAtMs !== undefined && (
            typeof value.deadlineAtMs !== 'number' || !Number.isFinite(value.deadlineAtMs)
        ))
    ) {
        return null;
    }
    return {
        text: value.text,
        query: value.query,
        options: {
            matchCase: value.options.matchCase,
            wholeWord: value.options.wholeWord,
            useRegex: value.options.useRegex,
        },
        maxMatches: value.maxMatches,
        ...(value.deadlineAtMs === undefined ? {} : {deadlineAtMs: value.deadlineAtMs}),
    };
}

function parseCancelPayload(value: unknown): IBrowserSearchWorkerRequestMap['cancel'] | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.requestId)) {
        return null;
    }
    return {requestId: value.requestId};
}

function parseAcknowledgePagePayload(value: unknown): IBrowserSearchWorkerRequestMap['acknowledgePage'] | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.requestId)) {
        return null;
    }
    return {requestId: value.requestId};
}

export function getBrowserSearchWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserSearchWorkerRequest(value: unknown): TBrowserSearchWorkerRequest | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.id) || typeof value.type !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'extractDocumentText': {
            const payload = parseExtractDocumentTextPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        case 'streamDocumentText': {
            const payload = parseStreamDocumentTextPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        case 'matchPageText': {
            const payload = parseMatchPageTextPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        case 'cancel': {
            const payload = parseCancelPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        case 'acknowledgePage': {
            const payload = parseAcknowledgePagePayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        default:
            return null;
    }
}

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
    IBrowserSearchWorkerPageRecord,
    IBrowserSearchWorkerPageResponse,
};
