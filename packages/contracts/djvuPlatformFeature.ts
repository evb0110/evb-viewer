import type {TPageNumber} from '@contracts/pageNumbers';
import {
    djvuCanceledResultSchema,
    djvuConvertOptionsSchema,
    djvuConvertResultSchema,
    djvuInfoSchema,
    djvuJobStartHandleSchema,
    djvuJobStateSchema,
    djvuOpenResultSchema,
    djvuOutlineSchema,
    djvuPagePreviewOptionsSchema,
    djvuPagePreviewSchema,
    djvuPageSizeSchema,
    djvuPageSourceInfoSchema,
    djvuPageTextSchema,
    djvuPrintOptionsSchema,
    djvuPrintResultSchema,
    djvuProgressSchema,
    djvuSizeEstimateSchema,
    djvuTextSearchOptionsSchema,
    type IDjvuConvertOptions,
    type IDjvuPagePreviewOptions,
    type IDjvuPrintOptions,
    type IDjvuProgress,
    type IDjvuTextSearchOptions,
} from '@contracts/electronApiDjvu';
import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import {pdfSearchResponseSchema} from '@contracts/search';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    parseJobId, parseRequestId, type TRequestId,
} from '@contracts/shared';
import * as v from 'valibot';

const IPC_REQUEST_ID_MAX_LENGTH = 128;
const DJVU_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1_000;
const error = 'invalid DjVu IPC payload';
const nonEmptyString = v.pipe(v.string('query must be a non-empty string'), v.check(value => value.trim().length > 0, 'query must be a non-empty string'));
const safeIntegerAtLeast = (minimum: number, message: string) => v.pipe(v.number(message), v.check(value => Number.isSafeInteger(value), message), v.minValue(minimum, message));
const requestIdSchema = (fieldName: string) => v.pipe(
    v.string(`${fieldName} must be a string`),
    v.transform(value => value.trim()),
    v.maxLength(IPC_REQUEST_ID_MAX_LENGTH, `${fieldName} exceeds maximum length (${IPC_REQUEST_ID_MAX_LENGTH})`),
    v.check(value => parseRequestId(value) !== null, `${fieldName} must be a valid request ID`),
    v.transform(value => parseRequestId(value)!),
);
const documentRefSchema = v.pipe(v.string(), v.check(value => parseDocumentRef(value) !== null, 'must be an absolute document reference'), v.transform(value => parseDocumentRef(value)!));
const jobIdSchema = v.pipe(v.string(), v.check(value => parseJobId(value) !== null, 'jobId must be a valid job ID'), v.transform(value => parseJobId(value)!));
const documentArgs = v.strictTuple([documentRefSchema]);
const jobArgs = v.strictTuple([jobIdSchema]);
const pageSourceInfoArgs = v.strictTuple([
    documentRefSchema,
    safeIntegerAtLeast(1, 'pageNumber must be a safe integer >= 1'),
]);
const pagePreviewArgs = v.strictTuple([
    documentRefSchema,
    safeIntegerAtLeast(1, 'pageNumber must be a safe integer >= 1'),
    v.optional(djvuPagePreviewOptionsSchema),
]);
const startOpenArgs = v.strictTuple([
    documentRefSchema,
    requestIdSchema('startOpenForViewing.requestId'),
]);
const cancelPreviewArgs = v.strictTuple([requestIdSchema('cancelPagePreview.requestId')]);
const cancelTextSearchArgs = v.strictTuple([requestIdSchema('cancelTextSearch.requestId')]);
const startConvertArgs = v.strictTuple([
    documentRefSchema,
    documentRefSchema,
    v.pipe(djvuConvertOptionsSchema, v.check(options => options.requestId !== undefined, 'startConvertToPdf.options.requestId is required')),
]);
const printArgs = v.strictTuple([
    documentRefSchema,
    v.pipe(
        djvuPrintOptionsSchema,
        v.check(options => options.pageNumbers === undefined || options.pageNumbers.length > 0, 'pageNumbers must be a non-empty array'),
    ),
]);
const searchTextArgs = v.strictTuple([
    documentRefSchema,
    nonEmptyString,
    v.pipe(
        djvuTextSearchOptionsSchema,
        v.transform(options => ({
            ...options,
            matchCase: options.matchCase ?? false,
            wholeWord: options.wholeWord ?? false,
            useRegex: options.useRegex ?? false,
        })),
    ),
]);

const textSearchProgressInputSchema = v.pipe(v.object({
    requestId: v.pipe(v.string(), v.check(value => parseRequestId(value) !== null, error), v.transform(value => parseRequestId(value)!)),
    processed: safeIntegerAtLeast(0, error),
    total: safeIntegerAtLeast(0, error),
    results: v.optional(v.array(v.unknown())),
    resultsStartIndex: v.optional(v.unknown()),
    truncated: v.optional(v.boolean()),
    canceled: v.optional(v.boolean()),
    status: v.optional(v.picklist([
        'running',
        'success',
        'canceled',
        'failed',
    ])),
    error: v.optional(v.string()),
}, error), v.check(progress => progress.resultsStartIndex === undefined || typeof progress.resultsStartIndex === 'number' && Number.isSafeInteger(progress.resultsStartIndex) && progress.resultsStartIndex >= 0, error));
const textSearchProgressSchema = v.pipe(textSearchProgressInputSchema, v.transform(progress => {
    let results: v.InferOutput<typeof pdfSearchResponseSchema>['results'] | undefined;
    if (progress.results !== undefined) {
        const parsed = v.safeParse(pdfSearchResponseSchema, {
            results: progress.results,
            truncated: Boolean(progress.truncated),
        }, {abortEarly: true});
        if (!parsed.success) throw new Error(error);
        results = parsed.output.results;
    }
    return {
        requestId: progress.requestId,
        processed: progress.processed,
        total: progress.total,
        ...(results === undefined ? {} : {results}),
        ...(results === undefined || typeof progress.resultsStartIndex !== 'number' ? {} : {resultsStartIndex: progress.resultsStartIndex}),
        ...(progress.truncated === undefined ? {} : {truncated: progress.truncated}),
        ...(progress.canceled === undefined ? {} : {canceled: progress.canceled}),
        ...(progress.status === undefined ? {} : {status: progress.status}),
        ...(progress.error === undefined ? {} : {error: progress.error}),
    };
}));

function defineDjvuMethod<const TName extends string, const TChannel extends string, const TArgs extends v.GenericSchema<unknown, unknown[]>, const TResult extends v.GenericSchema<unknown, unknown>>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
            ...(definition.timeout ? {timeoutMs: DJVU_NATIVE_IPC_TIMEOUT_MS} : {}),
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}
function defineDjvuClientMethod<const TName extends string, const TChannel extends string, const TArgs extends v.GenericSchema<unknown, unknown[]>, const TResult extends v.GenericSchema<unknown, unknown>, const TMapArgs extends (...args: never[]) => unknown>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    mapArgs: TMapArgs;
    timeout?: boolean
}) {
    return {
        ...defineDjvuMethod(definition),
        client: {mapArgs: definition.mapArgs},
    } as const;
}
function defineOptionalNativeDjvuMethod<const TName extends string, const TChannel extends string, const TArgs extends v.GenericSchema<unknown, unknown[]>, const TResult extends v.GenericSchema<unknown, unknown>>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean
}) {
    return {
        ...defineDjvuMethod(definition),
        browser: {
            unsupported: 'omitted',
            reason: 'requires-native-backend',
        },
        optionalWhenImplemented: true,
        required: {
            browser: false,
            electron: false,
        },
    } as const;
}

export const DJVU_PLATFORM_FEATURE = definePlatformFeature({
    path: ['djvu'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        startOpenForViewing: defineDjvuClientMethod({
            name: 'startOpenForViewing',
            channel: 'djvu:open:start',
            args: startOpenArgs,
            result: djvuJobStartHandleSchema,
            timeout: true,
            mapArgs: (path: TDocumentRef, requestId: TRequestId): [TDocumentRef, TRequestId] => [
                path,
                requestId,
            ],
        }),
        releaseViewingPath: defineDjvuMethod({
            name: 'releaseViewingPath',
            channel: 'djvu:releaseViewingPath',
            args: documentArgs,
            result: v.pipe(v.undefined('expected an undefined IPC result'), v.transform((): void => undefined)),
        }),
        startConvertToPdf: defineDjvuClientMethod({
            name: 'startConvertToPdf',
            channel: 'djvu:convert:start',
            args: startConvertArgs,
            result: djvuJobStartHandleSchema,
            timeout: true,
            mapArgs: (source: TDocumentRef, output: TDocumentRef, options: IDjvuConvertOptions): [TDocumentRef, TDocumentRef, IDjvuConvertOptions] => [
                source,
                output,
                options,
            ],
        }),
        printDjvuPath: defineDjvuClientMethod({
            name: 'printDjvuPath',
            channel: 'djvu:printDjvuPath',
            args: printArgs,
            result: djvuPrintResultSchema,
            timeout: true,
            mapArgs: (path: TDocumentRef, options: IDjvuPrintOptions): [TDocumentRef, IDjvuPrintOptions] => [
                path,
                options,
            ],
        }),
        cancel: defineDjvuMethod({
            name: 'cancel',
            channel: 'djvu:cancel',
            args: jobArgs,
            result: djvuCanceledResultSchema,
        }),
        getJobState: defineDjvuMethod({
            name: 'getJobState',
            channel: 'djvu:job:getState',
            args: jobArgs,
            result: djvuJobStateSchema,
        }),
        cancelPagePreview: defineDjvuClientMethod({
            name: 'cancelPagePreview',
            channel: 'djvu:cancelPagePreview',
            args: cancelPreviewArgs,
            result: djvuCanceledResultSchema,
            mapArgs: (requestId: TRequestId): [TRequestId] => [requestId],
        }),
        searchText: defineDjvuClientMethod({
            name: 'searchText',
            channel: 'djvu:text:search',
            args: searchTextArgs,
            result: pdfSearchResponseSchema,
            timeout: true,
            mapArgs: (path: TDocumentRef, query: string, options: IDjvuTextSearchOptions): [TDocumentRef, string, IDjvuTextSearchOptions] => [
                path,
                query,
                {
                    ...options,
                    matchCase: options.matchCase ?? false,
                    wholeWord: options.wholeWord ?? false,
                    useRegex: options.useRegex ?? false,
                },
            ],
        }),
        cancelTextSearch: defineDjvuClientMethod({
            name: 'cancelTextSearch',
            channel: 'djvu:text:cancel',
            args: cancelTextSearchArgs,
            result: djvuCanceledResultSchema,
            mapArgs: (requestId: TRequestId): [TRequestId] => [requestId],
        }),
        getInfo: defineDjvuMethod({
            name: 'getInfo',
            channel: 'djvu:getInfo',
            args: documentArgs,
            result: djvuInfoSchema,
            timeout: true,
        }),
        getPageSourceInfo: defineDjvuMethod({
            name: 'getPageSourceInfo',
            channel: 'djvu:getPageSourceInfo',
            args: pageSourceInfoArgs,
            result: djvuPageSourceInfoSchema,
            timeout: true,
        }),
        getPageSizes: defineDjvuMethod({
            name: 'getPageSizes',
            channel: 'djvu:getPageSizes',
            args: documentArgs,
            result: v.array(djvuPageSizeSchema),
            timeout: true,
        }),
        getPageText: defineOptionalNativeDjvuMethod({
            name: 'getPageText',
            channel: 'djvu:getPageText',
            args: pageSourceInfoArgs,
            result: djvuPageTextSchema,
            timeout: true,
        }),
        getOutline: defineOptionalNativeDjvuMethod({
            name: 'getOutline',
            channel: 'djvu:getOutline',
            args: documentArgs,
            result: djvuOutlineSchema,
            timeout: true,
        }),
        renderPagePreview: defineDjvuClientMethod({
            name: 'renderPagePreview',
            channel: 'djvu:renderPagePreview',
            args: pagePreviewArgs,
            result: djvuPagePreviewSchema,
            timeout: true,
            mapArgs: (path: TDocumentRef, page: TPageNumber, options?: IDjvuPagePreviewOptions): [TDocumentRef, number, IDjvuPagePreviewOptions | undefined] => [
                path,
                page,
                options,
            ],
        }),
        estimateSizes: defineDjvuMethod({
            name: 'estimateSizes',
            channel: 'djvu:estimateSizes',
            args: documentArgs,
            result: v.array(djvuSizeEstimateSchema),
            timeout: true,
        }),
        cleanupTemp: defineDjvuMethod({
            name: 'cleanupTemp',
            channel: 'djvu:cleanupTemp',
            args: documentArgs,
            result: v.pipe(v.undefined('expected an undefined IPC result'), v.transform((): void => undefined)),
        }),
    },
    events: {
        onProgress: {
            kind: 'event',
            channel: 'djvu:progress',
            payload: djvuProgressSchema,
            subscription: {
                channel: 'djvu:progress:subscribe',
                request: 'once-per-preload-event-channel',
                main: {
                    method: 'subscribeProgress',
                    context: 'sender',
                },
                replay: {
                    owner: 'ipc-progress-pump',
                    mode: 'latest-per-key',
                    key: (payload: IDjvuProgress) => `${payload.jobId}:${payload.phase}`,
                    terminal: (payload: IDjvuProgress) => payload.status === 'success' || payload.status === 'canceled' || payload.status === 'failed',
                    intervalMs: 50,
                    terminalRetentionMs: 30_000,
                },
            },
            browser: {method: 'onProgress'},
            lazy: 'forwarded',
        },
        onConvertComplete: {
            kind: 'event',
            channel: 'djvu:convert:complete',
            payload: djvuConvertResultSchema,
            browser: {method: 'onConvertComplete'},
            lazy: 'forwarded',
        },
        onOpenComplete: {
            kind: 'event',
            channel: 'djvu:open:complete',
            payload: djvuOpenResultSchema,
            browser: {method: 'onOpenComplete'},
            lazy: 'forwarded',
        },
        onTextSearchProgress: {
            kind: 'event',
            channel: 'djvu:text:progress',
            payload: textSearchProgressSchema,
            browser: {method: 'onTextSearchProgress'},
            lazy: 'forwarded',
        },
        onMenuConvertToPdf: {
            kind: 'event',
            channel: 'menu:convertToPdf',
            payload: v.undefined(),
            browser: {method: 'onMenuConvertToPdf'},
            lazy: 'forwarded',
        },
    },
});

export type IDjvuCapability = TFeatureCapability<typeof DJVU_PLATFORM_FEATURE>;
export type IDjvuInvokeMap = TFeatureInvokeMap<typeof DJVU_PLATFORM_FEATURE>;
export type IDjvuEventMap = TFeatureEventMap<typeof DJVU_PLATFORM_FEATURE>;
