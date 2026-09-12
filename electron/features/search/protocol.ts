import type { TaggedUnion } from 'type-fest';
import type {
    IPdfSearchResponse,
    IPdfSearchResult,
} from '@contracts/search';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TRequestId } from '@contracts/shared';

export type ISearchMatch = IPdfSearchResult;
export type ISearchResponse = IPdfSearchResponse;

export interface ISearchWorkerShutdownResult {
    type: 'shutdown-complete';
    error?: string;
}

export interface ISearchWorkerRequest {
    requestId: TRequestId;
    pdfPath: string;
    documentRevision: TDocumentRevisionToken;
    query: string;
    pageCount?: number;
    warmup?: boolean;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    regexBudgetMs?: number;
}

interface ISearchWorkerInboundByType {
    search: {payload: ISearchWorkerRequest;};
    cancel: {requestId: TRequestId;};
    'reset-cache': Record<never, never>;
    'reset-state': Record<never, never>;
    shutdown: {reason: string;};
}

interface ISearchWorkerOutboundByType {
    progress: {
        requestId: TRequestId;
        processed: number;
        total: number;
        results?: readonly ISearchMatch[];
        resultsStartIndex?: number;
        truncated?: boolean;
        canceled?: boolean;
    };
    complete: {
        requestId: TRequestId;
        response: ISearchResponse;
    };
    cancelled: {requestId: TRequestId;};
    error: {
        requestId: TRequestId;
        error: string;
    };
}

type TSearchWorkerInboundByType = {
    [K in keyof ISearchWorkerInboundByType]: ISearchWorkerInboundByType[K];
};

type TSearchWorkerOutboundByType = {
    [K in keyof ISearchWorkerOutboundByType]: ISearchWorkerOutboundByType[K];
};

export type TSearchWorkerInboundMessage = TaggedUnion<'type', TSearchWorkerInboundByType>;
export type TSearchWorkerOutboundMessage = TaggedUnion<'type', TSearchWorkerOutboundByType>;
