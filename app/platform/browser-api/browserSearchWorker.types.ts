import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import type {
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
} from '@contracts/search';
import {SEARCH_RESULT_LIMIT} from '@contracts/search';
import {BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT} from '@app/platform/browser-api/browserSearchLegacyArrayPageLimit';
import * as v from 'valibot';

export const BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST = SEARCH_RESULT_LIMIT + 1;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const pathSchema = v.pipe(v.string(), v.check(value => value.trim().length > 0));
const pageNumberSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const pageCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
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

const pageRecordSchema = v.pipe(
    v.object({
        pageNumber: pageNumberSchema,
        pageCount: pageCountSchema,
        text: v.string(),
    }),
    v.check(value => value.pageCount >= value.pageNumber),
);

const resultSchemas = {
    extractDocumentText: v.pipe(
        v.object({
            pageCount: v.pipe(pageCountSchema, v.maxValue(BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT)),
            pageTexts: v.pipe(
                v.array(v.string()),
                v.maxLength(BROWSER_SEARCH_LEGACY_ARRAY_PAGE_LIMIT),
            ),
        }),
        v.check(value => value.pageTexts.length <= value.pageCount),
    ),
    streamDocumentText: v.object({pageCount: pageCountSchema}),
    matchPageText: v.object({
        matches: v.pipe(v.array(searchRangeSchema), v.maxLength(BROWSER_SEARCH_MAX_MATCHES_PER_REQUEST)),
        truncated: v.boolean(),
    }),
    cancel: v.object({canceled: v.boolean()}),
    acknowledgePage: v.object({acknowledged: v.literal(true)}),
};

const requestPayloadSchemas = {
    extractDocumentText: v.object({pdfPath: pathSchema}),
    streamDocumentText: v.object({pdfPath: pathSchema}),
    matchPageText: v.object({
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
    }),
    cancel: v.object({requestId: requestIdSchema}),
    acknowledgePage: v.object({requestId: requestIdSchema}),
};

const requestSchema = v.union([
    v.object({
        id: requestIdSchema,
        type: v.literal('extractDocumentText'),
        payload: requestPayloadSchemas.extractDocumentText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('streamDocumentText'),
        payload: requestPayloadSchemas.streamDocumentText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('matchPageText'),
        payload: requestPayloadSchemas.matchPageText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('cancel'),
        payload: requestPayloadSchemas.cancel,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('acknowledgePage'),
        payload: requestPayloadSchemas.acknowledgePage,
    }),
]);

const workerResponseSchema = v.union([
    v.object({
        id: requestIdSchema,
        type: v.picklist([
            'extractDocumentText',
            'streamDocumentText',
            'matchPageText',
            'cancel',
            'acknowledgePage',
        ]),
        ok: v.literal(true),
        progress: v.object({
            processed: finiteNumberSchema,
            total: finiteNumberSchema,
        }),
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('extractDocumentText'),
        ok: v.literal(true),
        data: resultSchemas.extractDocumentText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('streamDocumentText'),
        ok: v.literal(true),
        data: resultSchemas.streamDocumentText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('matchPageText'),
        ok: v.literal(true),
        data: resultSchemas.matchPageText,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('cancel'),
        ok: v.literal(true),
        data: resultSchemas.cancel,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('acknowledgePage'),
        ok: v.literal(true),
        data: resultSchemas.acknowledgePage,
    }),
    v.object({
        id: requestIdSchema,
        type: v.literal('streamDocumentText'),
        ok: v.literal(true),
        page: pageRecordSchema,
    }),
    v.object({
        id: requestIdSchema,
        ok: v.literal(false),
        error: v.string(),
        errorCode: v.optional(v.literal('SEARCH_REGEX_LIMIT')),
    }),
]);

const progressResponseSchema = v.object({
    id: v.number(),
    type: v.string(),
    ok: v.literal(true),
    progress: v.object({
        processed: finiteNumberSchema,
        total: finiteNumberSchema,
    }),
});

const pageResponseSchema = v.object({
    id: v.number(),
    type: v.string(),
    ok: v.literal(true),
    page: pageRecordSchema,
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

type TBrowserSearchWorkerResponse = v.InferOutput<typeof workerResponseSchema>;

type IBrowserSearchWorkerProgress = v.InferOutput<typeof progressResponseSchema>['progress'];
type IBrowserSearchWorkerPageRecord = v.InferOutput<typeof pageRecordSchema>;
type IBrowserSearchWorkerPageResponse = v.InferOutput<typeof pageResponseSchema>;
type TBrowserSearchWorkerSuccessResponse = v.InferOutput<typeof successResponseSchema>;
type IBrowserSearchWorkerErrorResponse = v.InferOutput<typeof errorResponseSchema>;

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
    pageResponseSchema as BROWSER_SEARCH_WORKER_PAGE_RESPONSE_SCHEMA,
    progressResponseSchema as BROWSER_SEARCH_WORKER_PROGRESS_RESPONSE_SCHEMA,
    responseStatusSchema as BROWSER_SEARCH_WORKER_RESPONSE_STATUS_SCHEMA,
    resultSchemas as BROWSER_SEARCH_WORKER_RESULT_SCHEMAS,
    successResponseSchema as BROWSER_SEARCH_WORKER_SUCCESS_RESPONSE_SCHEMA,
    workerResponseSchema as BROWSER_SEARCH_WORKER_RESPONSE_SCHEMA,
};

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    IBrowserSearchWorkerProgress,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
    IBrowserSearchWorkerPageRecord,
    IBrowserSearchWorkerPageResponse,
    TBrowserSearchWorkerSuccessResponse,
    IBrowserSearchWorkerErrorResponse,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
};
