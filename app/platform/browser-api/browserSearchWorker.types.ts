import {isRecord, isSafeWorkerRequestId} from '@contracts/runtimeGuards';
import {SEARCH_EXCERPT_CONTEXT_CHARS, SEARCH_RESULT_LIMIT, searchResultOffsetSchema} from '@contracts/search';
import {
    PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA,
    SEARCH_INDEX_COVERAGE_SCHEMA,
    SEARCH_INDEX_RESPONSE_SCHEMA,
} from '@contracts/searchIndexWire';
import * as v from 'valibot';

export const BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST = SEARCH_RESULT_LIMIT + 1;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const durationMsSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const positiveSafeInt = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const uint8ArraySchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected Uint8Array');

const matchOptionsSchema = v.object({
    matchCase: v.boolean(),
    wholeWord: v.boolean(),
    useRegex: v.boolean(),
});

const staleResponseSchema = v.object({stale: v.literal(true)});
const cacheMissResponseSchema = v.object({cacheMiss: v.literal(true)});
const nonNegativeSafeInt = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const pageMatchesSchema = v.pipe(
    PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA.entries.matches,
    v.maxLength(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST),
);

const resultSchemas = {
    index: v.object({
        coverage: SEARCH_INDEX_COVERAGE_SCHEMA,
        indexBytes: uint8ArraySchema,
    }),
    search: v.union([staleResponseSchema, cacheMissResponseSchema, SEARCH_INDEX_RESPONSE_SCHEMA]),
    matchPageText: v.object({
        matches: pageMatchesSchema,
        truncated: v.boolean(),
        matchingMs: durationMsSchema,
        matchCount: nonNegativeSafeInt,
    }),
    matchPageBatch: v.object({
        pages: v.array(
            v.object({
                pageNumber: positiveSafeInt,
                matches: pageMatchesSchema,
                truncated: v.boolean(),
                matchCount: nonNegativeSafeInt,
            }),
        ),
        matchingMs: durationMsSchema,
    }),
};

const requestPayloadSchemas = {
    index: v.object({
        documentKey: v.optional(v.pipe(v.string(), v.minLength(1))),
        documentRevision: v.pipe(v.string(), v.minLength(1)),
        pageCount: positiveSafeInt,
        pagesBuffer: uint8ArraySchema,
        maxPageTextBytes: v.optional(positiveSafeInt),
        maxTotalTextBytes: v.optional(positiveSafeInt),
    }),
    search: v.object({
        documentKey: v.optional(v.pipe(v.string(), v.minLength(1))),
        indexBytes: v.optional(uint8ArraySchema),
        documentRevision: v.pipe(v.string(), v.minLength(1)),
        query: v.string(),
        options: matchOptionsSchema,
        limit: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(SEARCH_RESULT_LIMIT)),
        contextChars: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(SEARCH_EXCERPT_CONTEXT_CHARS)),
        resultOffset: v.optional(searchResultOffsetSchema),
    }),
    matchPageText: v.object({
        text: v.string(),
        resultOffset: v.optional(searchResultOffsetSchema),
        query: v.string(),
        options: matchOptionsSchema,
        maxMatches: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST)),
        budgetMs: v.optional(durationMsSchema),
    }),
    matchPageBatch: v.object({
        pages: v.pipe(
            v.array(
                v.object({
                    pageNumber: positiveSafeInt,
                    text: v.string(),
                }),
            ),
            v.minLength(1),
            v.maxLength(64),
        ),
        resultOffset: v.optional(searchResultOffsetSchema),
        query: v.string(),
        options: matchOptionsSchema,
        maxMatches: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST)),
        budgetMs: v.optional(durationMsSchema),
    }),
};

const requestSchema = v.variant('type', [
    v.object({
        id: requestIdSchema,
        type: v.literal('index'),
        payload: requestPayloadSchemas.index,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('search'),
        payload: requestPayloadSchemas.search,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('matchPageText'),
        payload: requestPayloadSchemas.matchPageText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('matchPageBatch'),
        payload: requestPayloadSchemas.matchPageBatch,
    }),
]);

const successResponseSchema = v.object({
    id: v.number(),
    type: v.string(),
    ok: v.literal(true),
    data: v.unknown(),
});

const errorResponseSchema = v.object({
    id: v.number(),
    ok: v.literal(false),
    error: v.optional(v.unknown()),
    errorCode: v.optional(v.unknown()),
});

const startedResponseSchema = v.object({
    id: v.number(),
    started: v.literal(true),
});

const responseStatusSchema = v.object({ok: v.boolean()});

type IBrowserSearchWorkerRequestMap = {
    [K in keyof typeof requestPayloadSchemas]: v.InferOutput<(typeof requestPayloadSchemas)[K]>;
};

type IBrowserSearchWorkerResultMap = {
    [K in keyof typeof resultSchemas]: v.InferOutput<(typeof resultSchemas)[K]>;
};

type TBrowserSearchWorkerRequestType = keyof IBrowserSearchWorkerRequestMap;

type TBrowserSearchWorkerRequest = v.InferOutput<typeof requestSchema>;
type IBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType = TBrowserSearchWorkerRequestType> = Extract<
    TBrowserSearchWorkerRequest,
    {type: K}
>;

/** What the worker posts back for one request: optional `started`, then the outcome. */
type TBrowserSearchWorkerResponse =
    | {
          id: number;
          started: true;
      }
    | {
          [K in TBrowserSearchWorkerRequestType]: {
              id: number;
              type: K;
              ok: true;
              data: IBrowserSearchWorkerResultMap[K];
          };
      }[TBrowserSearchWorkerRequestType]
    | {
          id: number;
          ok: false;
          error: string;
          errorCode?: 'SEARCH_REGEX_LIMIT';
      };

export function isCacheMissSearchIndexAnswer(value: unknown): value is {cacheMiss: true} {
    return isRecord(value) && value.cacheMiss === true;
}

export function getBrowserSearchWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id) ? value.id : null;
}

export function parseBrowserSearchWorkerRequest(value: unknown): TBrowserSearchWorkerRequest | null {
    const result = v.safeParse(requestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export {
    errorResponseSchema as BROWSER_SEARCH_WORKER_ERROR_RESPONSE_SCHEMA,
    responseStatusSchema as BROWSER_SEARCH_WORKER_RESPONSE_STATUS_SCHEMA,
    resultSchemas as BROWSER_SEARCH_WORKER_RESULT_SCHEMAS,
    startedResponseSchema as BROWSER_SEARCH_WORKER_STARTED_RESPONSE_SCHEMA,
    successResponseSchema as BROWSER_SEARCH_WORKER_SUCCESS_RESPONSE_SCHEMA,
};

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
};
