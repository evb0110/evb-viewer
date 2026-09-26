import {parsePageNumber} from '@contracts/pageNumbers';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseRequestId,
    requireRequestId,
    type IOcrWord,
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
import * as v from 'valibot';

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

export type TPdfSearchUtf16Offset = number;

export interface IPdfSearchUtf16Range {
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

const SEARCH_RESPONSE_ERROR = 'invalid search response';

const safeNonNegativeInteger = v.pipe(
    v.number(SEARCH_RESPONSE_ERROR),
    v.check(value => Number.isSafeInteger(value) && value >= 0, SEARCH_RESPONSE_ERROR),
);

const searchPageNumberSchema = v.pipe(
    v.number(SEARCH_RESPONSE_ERROR),
    v.check(value => parsePageNumber(value) !== null, SEARCH_RESPONSE_ERROR),
    v.transform(value => parsePageNumber(value)!),
);

const searchExcerptSchema = v.object({
    prefix: v.boolean(SEARCH_RESPONSE_ERROR),
    suffix: v.boolean(SEARCH_RESPONSE_ERROR),
    before: v.string(SEARCH_RESPONSE_ERROR),
    match: v.string(SEARCH_RESPONSE_ERROR),
    after: v.string(SEARCH_RESPONSE_ERROR),
}, SEARCH_RESPONSE_ERROR);
export type IPdfSearchExcerpt = v.InferOutput<typeof searchExcerptSchema>;

const searchWordSchema = v.pipe(
    v.looseObject({
        text: v.string(SEARCH_RESPONSE_ERROR),
        x: v.pipe(v.number(SEARCH_RESPONSE_ERROR), v.finite(SEARCH_RESPONSE_ERROR)),
        y: v.pipe(v.number(SEARCH_RESPONSE_ERROR), v.finite(SEARCH_RESPONSE_ERROR)),
        width: v.pipe(v.number(SEARCH_RESPONSE_ERROR), v.finite(SEARCH_RESPONSE_ERROR)),
        height: v.pipe(v.number(SEARCH_RESPONSE_ERROR), v.finite(SEARCH_RESPONSE_ERROR)),
    }, SEARCH_RESPONSE_ERROR),
    v.transform(word => word as IOcrWord),
);

const positiveFiniteNumber = v.pipe(
    v.number(SEARCH_RESPONSE_ERROR),
    v.finite(SEARCH_RESPONSE_ERROR),
    v.check(value => value > 0, SEARCH_RESPONSE_ERROR),
);

export const pdfSearchResultSchema = v.pipe(
    v.object({
        pageNumber: searchPageNumberSchema,
        pageMatchIndex: safeNonNegativeInteger,
        matchIndex: safeNonNegativeInteger,
        startOffset: safeNonNegativeInteger,
        endOffset: safeNonNegativeInteger,
        excerpt: searchExcerptSchema,
        words: v.optional(v.array(searchWordSchema, SEARCH_RESPONSE_ERROR)),
        pageWidth: v.optional(positiveFiniteNumber),
        pageHeight: v.optional(positiveFiniteNumber),
        rotation: v.optional(v.picklist([
            0,
            90,
            180,
            270,
        ], SEARCH_RESPONSE_ERROR)),
    }, SEARCH_RESPONSE_ERROR),
    v.check(value => value.endOffset >= value.startOffset, SEARCH_RESPONSE_ERROR),
    v.transform(value => ({
        pageNumber: value.pageNumber,
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt: value.excerpt,
        ...(value.words === undefined ? {} : {words: value.words}),
        ...(value.pageWidth === undefined ? {} : {pageWidth: value.pageWidth}),
        ...(value.pageHeight === undefined ? {} : {pageHeight: value.pageHeight}),
        ...(value.rotation === undefined ? {} : {rotation: value.rotation}),
    })),
);
export type IPdfSearchResult = v.InferOutput<typeof pdfSearchResultSchema>;

export const pdfSearchResponseSchema = v.pipe(
    v.object({
        results: v.pipe(
            v.array(pdfSearchResultSchema, SEARCH_RESPONSE_ERROR),
            v.maxLength(SEARCH_RESULT_LIMIT, SEARCH_RESPONSE_ERROR),
        ),
        truncated: v.boolean(SEARCH_RESPONSE_ERROR),
        canceled: v.optional(v.boolean(SEARCH_RESPONSE_ERROR)),
    }, SEARCH_RESPONSE_ERROR),
    v.transform(value => ({
        results: value.results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    })),
);
export type IPdfSearchResponse = v.InferOutput<typeof pdfSearchResponseSchema>;

function decodeExcerpt(value: unknown): IPdfSearchExcerpt | null {
    const result = v.safeParse(searchExcerptSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

function decodeResult(value: unknown, pageCount?: number): IPdfSearchResult | null {
    const result = v.safeParse(pdfSearchResultSchema, value, {abortEarly: true});
    return result.success && parsePageNumber(result.output.pageNumber, pageCount) !== null
        ? result.output
        : null;
}

function decodeResponse(value: unknown, pageCount?: number): IPdfSearchResponse | null {
    const result = v.safeParse(pdfSearchResponseSchema, value, {abortEarly: true});
    return result.success
        && result.output.results.every(item => parsePageNumber(item.pageNumber, pageCount) !== null)
        ? result.output
        : null;
}

/** The shared search result shape used at worker and native-process boundaries. */
export const SEARCH_WIRE_CODEC = {
    decodeExcerpt,
    decodeResult,
    decodeResponse,
    decodeProgress,
} as const;

const searchRequestIdSchema = v.pipe(
    v.string('invalid search progress'),
    v.check(value => parseRequestId(value) !== null, 'invalid search progress'),
    v.transform(value => parseRequestId(value)!),
);
const finiteNumber = v.pipe(v.number('invalid search progress'), v.finite('invalid search progress'));
const searchProgressInputSchema = v.pipe(v.object({
    requestId: searchRequestIdSchema,
    processed: finiteNumber,
    total: finiteNumber,
    results: v.optional(v.array(pdfSearchResultSchema, 'invalid search progress')),
    resultsStartIndex: v.optional(v.unknown()),
    truncated: v.optional(v.boolean('invalid search progress')),
    canceled: v.optional(v.boolean('invalid search progress')),
    status: v.optional(v.picklist([
        'running',
        'success',
        'canceled',
        'failed',
    ], 'invalid search progress')),
    error: v.optional(v.string('invalid search progress')),
}, 'invalid search progress'), v.check(progress => (
    progress.results === undefined
    || progress.resultsStartIndex === undefined
    || typeof progress.resultsStartIndex === 'number'
        && Number.isSafeInteger(progress.resultsStartIndex)
        && progress.resultsStartIndex >= 0
), 'invalid search progress'));
export const pdfSearchProgressSchema = v.pipe(
    searchProgressInputSchema,
    v.transform(progress => ({
        requestId: progress.requestId,
        processed: progress.processed,
        total: progress.total,
        ...(progress.results === undefined ? {} : {results: progress.results}),
        ...(progress.results === undefined || typeof progress.resultsStartIndex !== 'number'
            ? {}
            : {resultsStartIndex: progress.resultsStartIndex}),
        ...(progress.truncated === undefined ? {} : {truncated: progress.truncated}),
        ...(progress.canceled === undefined ? {} : {canceled: progress.canceled}),
        ...(progress.status === undefined ? {} : {status: progress.status}),
        ...(progress.error === undefined ? {} : {error: progress.error}),
    })),
);
export type IPdfSearchProgress = v.InferOutput<typeof pdfSearchProgressSchema>;

function decodeProgress(value: unknown): IPdfSearchProgress | null {
    const result = v.safeParse(pdfSearchProgressSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
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

function normalizePdfSearchRequest(raw: unknown) {
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

function normalizePdfSearchWarmIndexRequest(raw: unknown) {
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

const searchRequestInputSchema = v.object({
    pdfPath: v.unknown(),
    query: v.unknown(),
    requestId: v.optional(v.unknown()),
    pageCount: v.optional(v.unknown()),
    documentRevision: v.optional(v.unknown()),
    matchCase: v.optional(v.unknown()),
    wholeWord: v.optional(v.unknown()),
    useRegex: v.optional(v.unknown()),
}, 'Invalid search request payload');
export const pdfSearchRequestSchema = v.pipe(
    searchRequestInputSchema,
    v.transform(value => normalizePdfSearchRequest(value)),
);
export const pdfSearchWarmIndexRequestSchema = v.pipe(
    v.object({
        pdfPath: v.unknown(),
        requestId: v.optional(v.unknown()),
        pageCount: v.optional(v.unknown()),
        documentRevision: v.optional(v.unknown()),
    }, 'Invalid warm-index payload'),
    v.transform(value => normalizePdfSearchWarmIndexRequest(value)),
);

export type INormalizedPdfSearchRequest = v.InferOutput<typeof pdfSearchRequestSchema>;
export type INormalizedPdfSearchWarmIndexRequest = v.InferOutput<typeof pdfSearchWarmIndexRequestSchema>;

export function normalizePdfSearchRequestPayload(raw: unknown): INormalizedPdfSearchRequest {
    return v.parse(pdfSearchRequestSchema, raw, {abortEarly: true});
}

export function normalizePdfSearchWarmIndexPayload(raw: unknown): INormalizedPdfSearchWarmIndexRequest {
    return v.parse(pdfSearchWarmIndexRequestSchema, raw, {abortEarly: true});
}
