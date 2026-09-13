import {
    parsePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    isOcrWord,
    type IOcrWord,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';
import {
    findSerializableErrorEnvelope,
    type ISerializableErrorEnvelope,
} from '@contracts/serializableError';
import {
    isEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

/** Shared user-visible search limits. Keep every runtime on these values. */
export const SEARCH_RESULT_LIMIT = 500;
export const SEARCH_EXCERPT_CONTEXT_CHARS = 56;
export const SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Minimum query lengths every search surface must honor, backend and UI alike.
 * PDF search answers from a prepared index, so a single character is cheap and
 * is the only way to search ideographic scripts. Document-source search scans
 * page text on demand, where a one-character query is too broad to be useful.
 */
export const PDF_SEARCH_MIN_QUERY_LENGTH = 1;
export const DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH = 2;

export interface IPdfSearchExcerpt {
    readonly prefix: boolean;
    readonly suffix: boolean;
    readonly before: string;
    readonly match: string;
    readonly after: string;
}

export type TPdfSearchUtf16Offset = number;

export interface IPdfSearchUtf16Range {
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IPdfSearchResult {
    readonly pageNumber: TPageNumber;
    readonly pageMatchIndex: number;
    readonly matchIndex: number;
    readonly startOffset: TPdfSearchUtf16Offset;
    readonly endOffset: TPdfSearchUtf16Offset;
    readonly excerpt: IPdfSearchExcerpt;
    readonly words?: readonly IOcrWord[];
    readonly pageWidth?: number;
    readonly pageHeight?: number;
    readonly rotation?: TOcrIndexRotation;
}

export interface IPdfSearchResponse {
    readonly results: readonly IPdfSearchResult[];
    readonly truncated: boolean;
    readonly canceled?: boolean;
}

function decodeSearchExcerpt(value: unknown): IPdfSearchExcerpt | null {
    if (
        !isRecord(value)
        || typeof value.prefix !== 'boolean'
        || typeof value.suffix !== 'boolean'
        || typeof value.before !== 'string'
        || typeof value.match !== 'string'
        || typeof value.after !== 'string'
    ) {
        return null;
    }
    return {
        prefix: value.prefix,
        suffix: value.suffix,
        before: value.before,
        match: value.match,
        after: value.after,
    };
}

function decodeSearchResult(value: unknown, pageCount?: number): IPdfSearchResult | null {
    if (!isRecord(value)) {
        return null;
    }
    const pageNumber = typeof value.pageNumber === 'number'
        ? parsePageNumber(value.pageNumber, pageCount)
        : null;
    const excerpt = decodeSearchExcerpt(value.excerpt);
    const isNonNegativeInteger = (candidate: unknown): candidate is number => (
        typeof candidate === 'number'
        && Number.isSafeInteger(candidate)
        && candidate >= 0
    );
    if (
        pageNumber === null
        || !isNonNegativeInteger(value.pageMatchIndex)
        || !isNonNegativeInteger(value.matchIndex)
        || !isNonNegativeInteger(value.startOffset)
        || !isNonNegativeInteger(value.endOffset)
        || value.endOffset < value.startOffset
        || excerpt === null
        || (value.words !== undefined && (!Array.isArray(value.words) || !value.words.every(isOcrWord)))
        || (value.pageWidth !== undefined && (typeof value.pageWidth !== 'number' || !Number.isFinite(value.pageWidth) || value.pageWidth <= 0))
        || (value.pageHeight !== undefined && (typeof value.pageHeight !== 'number' || !Number.isFinite(value.pageHeight) || value.pageHeight <= 0))
        || (value.rotation !== undefined && value.rotation !== 0 && value.rotation !== 90 && value.rotation !== 180 && value.rotation !== 270)
    ) {
        return null;
    }
    return {
        pageNumber,
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt,
        ...(value.words === undefined ? {} : {words: value.words}),
        ...(value.pageWidth === undefined ? {} : {pageWidth: value.pageWidth}),
        ...(value.pageHeight === undefined ? {} : {pageHeight: value.pageHeight}),
        ...(value.rotation === undefined ? {} : {rotation: value.rotation}),
    };
}

function decodeSearchResponse(value: unknown, pageCount?: number): IPdfSearchResponse | null {
    if (
        !isRecord(value)
        || !Array.isArray(value.results)
        || value.results.length > SEARCH_RESULT_LIMIT
        || typeof value.truncated !== 'boolean'
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
    ) {
        return null;
    }
    const results: IPdfSearchResult[] = [];
    for (const result of value.results) {
        const decoded = decodeSearchResult(result, pageCount);
        if (decoded === null) {
            return null;
        }
        results.push(decoded);
    }
    return {
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    };
}

/** The sole runtime decoder for search results crossing worker, IPC, or native boundaries. */
export const SEARCH_WIRE_CODEC = {
    decodeExcerpt: decodeSearchExcerpt,
    decodeResult: decodeSearchResult,
    decodeResponse: decodeSearchResponse,
} as const;

export interface IPdfSearchProgress {
    readonly requestId: TRequestId;
    readonly processed: number;
    readonly total: number;
    readonly results?: readonly IPdfSearchResult[];
    readonly resultsStartIndex?: number;
    readonly truncated?: boolean;
    readonly canceled?: boolean;
    readonly status?: 'running' | 'success' | 'canceled' | 'failed';
    readonly error?: string;
}

export type TSearchErrorCode =
    | 'SEARCH_INVALID_PAYLOAD'
    | 'SEARCH_PATH_DENIED'
    | 'SEARCH_WORKER_LIMIT'
    | 'SEARCH_WORKER_PROTOCOL'
    | 'SEARCH_TIMEOUT'
    | 'SEARCH_WORKER_ERROR'
    | 'SEARCH_INTERNAL';

export interface ISearchErrorEnvelope extends ISerializableErrorEnvelope<TSearchErrorCode> {
    readonly retryable: boolean;
    readonly timestamp: TEpochMs;
    readonly details?: string;
}

export interface ISearchErrorEnvelopeCarrier {readonly errorEnvelope?: ISearchErrorEnvelope;}

export function isSearchErrorEnvelope(value: unknown): value is ISearchErrorEnvelope {
    return isRecord(value)
        && typeof value.code === 'string'
        && [
            'SEARCH_INVALID_PAYLOAD',
            'SEARCH_PATH_DENIED',
            'SEARCH_WORKER_LIMIT',
            'SEARCH_WORKER_PROTOCOL',
            'SEARCH_TIMEOUT',
            'SEARCH_WORKER_ERROR',
            'SEARCH_INTERNAL',
        ].includes(value.code)
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean'
        && isEpochMs(value.timestamp)
        && (value.details === undefined || typeof value.details === 'string');
}

export function findSearchErrorEnvelope(value: unknown): ISearchErrorEnvelope | null {
    return findSerializableErrorEnvelope(value, isSearchErrorEnvelope);
}

export interface ISearchMatchOptions {
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    deadlineAtMs?: number;
}

export interface IResolvedSearchMatchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
    deadlineAtMs?: number;
}

/** Exhaustive option semantics; consumers must not invent additional combinations. */
export const SEARCH_OPTION_SEMANTICS = [
    {
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-exact-boundary',
    },
    {
        matchCase: false,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-exact-boundary',
    },
] as const;

export interface IPdfSearchRequestOptions extends ISearchMatchOptions {
    requestId?: TRequestId;
    pageCount?: number;
    documentRevision?: TDocumentRevisionToken;
}

export const SEARCH_REQUEST_ID_MAX_LENGTH = 128;
export const SEARCH_PDF_PATH_MAX_LENGTH = 4_096;
export const SEARCH_QUERY_MAX_LENGTH = 2_048;
export const SEARCH_REGEX_QUERY_MAX_LENGTH = 512;
export const SEARCH_REGEX_MAX_EXECUTION_MS = 250;
export const SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 8_192;

export type TSearchablePageTextSeparator = 'none' | 'space' | 'line';

function validateSearchQueryLength(query: string, useRegex: boolean) {
    const maxLength = useRegex ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > maxLength) {
        throw new Error(`Invalid search query: maximum length is ${maxLength} characters`);
    }
}

export interface ISearchablePageTextItem {
    text: string;
    separatorAfter?: TSearchablePageTextSeparator;
}

export interface ISearchablePageTextItemOffset {
    itemIndex: number;
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IAssembledSearchablePageText {
    text: string;
    itemOffsets: ISearchablePageTextItemOffset[];
    sourceOffsets: IPdfSearchUtf16Range[];
}

export function normalizeOptionalSearchRequestId(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new Error('requestId must be a string');
    }
    const requestId = raw.trim();
    if (!requestId) {
        return undefined;
    }
    if (requestId.length > SEARCH_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`requestId exceeds maximum length (${SEARCH_REQUEST_ID_MAX_LENGTH})`);
    }
    return requireRequestId(requestId);
}

/**
 * Validate a declared document page count without imposing a product cap.
 * Consumers must keep work and messages bounded independently of this scalar.
 */
export function normalizeOptionalSearchPageCount(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }

    if (
        typeof raw !== 'number'
        || !Number.isSafeInteger(raw)
        || raw < 1
    ) {
        throw new Error('Invalid pageCount: must be a positive safe integer');
    }

    return raw;
}

function normalizeSearchPdfPath(raw: unknown): TDocumentRef {
    const pdfPath = typeof raw === 'string' ? raw.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }
    if (pdfPath.length > SEARCH_PDF_PATH_MAX_LENGTH) {
        throw new Error(`Invalid PDF path: maximum length is ${SEARCH_PDF_PATH_MAX_LENGTH} characters`);
    }
    const documentRef = parseDocumentRef(pdfPath);
    if (documentRef === null) {
        throw new Error('Invalid PDF path');
    }
    return documentRef;
}

function normalizeSearchBooleanOption(raw: unknown) {
    return typeof raw === 'boolean' ? raw : undefined;
}

function normalizeOptionalSearchDocumentRevision(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length === 0) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length > SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH) {
        throw new Error(`documentRevision exceeds maximum length (${SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH})`);
    }
    const documentRevision = parseDocumentRevisionToken(raw);
    if (documentRevision === null) {
        throw new Error('documentRevision must be a valid document revision token');
    }
    return documentRevision;
}

export interface INormalizedPdfSearchRequest extends IPdfSearchRequestOptions {
    pdfPath: TDocumentRef;
    query: string;
}

export interface INormalizedPdfSearchWarmIndexRequest extends IPdfSearchRequestOptions {pdfPath: TDocumentRef;}

export function normalizePdfSearchRequestPayload(
    raw: unknown,
): INormalizedPdfSearchRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid search request payload');
    }
    if (typeof raw.query !== 'string') {
        throw new Error('Invalid search query');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);
    const matchCase = normalizeSearchBooleanOption(raw.matchCase);
    const wholeWord = normalizeSearchBooleanOption(raw.wholeWord);
    const useRegex = normalizeSearchBooleanOption(raw.useRegex);
    validateSearchQueryLength(raw.query, useRegex === true);

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        query: raw.query,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

export function normalizePdfSearchWarmIndexPayload(
    raw: unknown,
): INormalizedPdfSearchWarmIndexRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid warm-index payload');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}
