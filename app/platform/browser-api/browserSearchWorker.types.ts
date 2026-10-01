import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import {SEARCH_RESULT_LIMIT} from '@contracts/search';
import * as v from 'valibot';

export const BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST = SEARCH_RESULT_LIMIT + 1;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const finiteNumberSchema = v.pipe(v.number(), v.finite());

const matchOptionsSchema = v.object({
    matchCase: v.boolean(),
    wholeWord: v.boolean(),
    useRegex: v.boolean(),
});

const searchRangeSchema = v.pipe(
    v.object({
        startOffset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        endOffset: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    }),
    v.check(value => value.endOffset > value.startOffset),
);

const resultSchemas = {matchPageText: v.object({
    matches: v.pipe(v.array(searchRangeSchema), v.maxLength(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST)),
    truncated: v.boolean(),
})};

const requestPayloadSchemas = {matchPageText: v.object({
    text: v.string(),
    query: v.string(),
    options: matchOptionsSchema,
    maxMatches: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST),
    ),
    deadlineAtMs: v.optional(finiteNumberSchema),
})};

const requestSchema = v.object({
    id: requestIdSchema,
    type: v.literal('matchPageText'),
    payload: requestPayloadSchemas.matchPageText,
});

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

/** What the worker posts back for one request. */
type TBrowserSearchWorkerResponse =
    | {
        id: number;
        type: 'matchPageText';
        ok: true;
        data: IBrowserSearchWorkerResultMap['matchPageText'];
    }
    | {
        id: number;
        ok: false;
        error: string;
        errorCode?: 'SEARCH_REGEX_LIMIT';
    };

export function getBrowserSearchWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserSearchWorkerRequest(value: unknown): TBrowserSearchWorkerRequest | null {
    const result = v.safeParse(requestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export {
    errorResponseSchema as BROWSER_SEARCH_WORKER_ERROR_RESPONSE_SCHEMA,
    responseStatusSchema as BROWSER_SEARCH_WORKER_RESPONSE_STATUS_SCHEMA,
    resultSchemas as BROWSER_SEARCH_WORKER_RESULT_SCHEMAS,
    successResponseSchema as BROWSER_SEARCH_WORKER_SUCCESS_RESPONSE_SCHEMA,
};

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
};
