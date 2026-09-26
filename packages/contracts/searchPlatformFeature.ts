import {
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    pdfSearchProgressSchema,
    pdfSearchRequestSchema,
    pdfSearchResponseSchema,
    pdfSearchWarmIndexRequestSchema,
    type IPdfSearchProgress,
    type IPdfSearchRequestOptions,
} from '@contracts/search';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import type {TRequestId} from '@contracts/shared';
import * as v from 'valibot';

const noArgs = v.strictTuple([]);
const booleanResult = v.boolean();
const cancelArgs = v.pipe(
    v.unknown(),
    v.transform((value) => {
        if (!Array.isArray(value) || value.length > 1) {
            const length = Array.isArray(value) ? value.length : 0;
            throw new Error(`expected 0-1 arguments, received ${length}`);
        }
        const requestId = normalizeOptionalSearchRequestId(value[0]);
        return requestId === undefined ? [] : [requestId];
    }),
);
const cancelResult = v.object({canceled: v.boolean('invalid search cancellation result')}, 'invalid search cancellation result');

export const SEARCH_PLATFORM_FEATURE = definePlatformFeature({
    path: ['search'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: {
            kind: 'async',
            channel: 'pdf:search',
            ipc: {
                args: v.strictTuple([pdfSearchRequestSchema]),
                result: pdfSearchResponseSchema,
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                pdfPath: string, query: string, options?: IPdfSearchRequestOptions,
            ) => [normalizePdfSearchRequestPayload({
                pdfPath,
                query,
                ...options,
            })]},
            main: {
                method: 'run',
                context: 'sender',
            },
            browser: {method: 'run'},
            lazy: 'forwarded',
        },
        warmIndex: {
            kind: 'async',
            channel: 'pdf:search:warmIndex',
            ipc: {
                args: v.strictTuple([pdfSearchWarmIndexRequestSchema]),
                result: booleanResult,
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                pdfPath: string, options?: IPdfSearchRequestOptions,
            ) => [normalizePdfSearchWarmIndexPayload({
                pdfPath,
                ...options,
            })]},
            main: {
                method: 'warmIndex',
                context: 'sender',
            },
            browser: {method: 'warmIndex'},
            lazy: 'forwarded',
        },
        cancel: {
            kind: 'async',
            channel: 'pdf:search:cancel',
            ipc: {
                args: cancelArgs,
                result: cancelResult,
            },
            client: {mapArgs: (requestId?: TRequestId) => [normalizeOptionalSearchRequestId(requestId)]},
            main: {
                method: 'cancel',
                context: 'sender',
            },
            browser: {method: 'cancel'},
            lazy: 'forwarded',
        },
        resetCache: {
            kind: 'async',
            channel: 'pdf:search:resetCache',
            ipc: {
                args: noArgs,
                result: booleanResult,
            },
            main: {
                method: 'resetCache',
                context: 'none',
            },
            browser: {method: 'resetCache'},
            lazy: 'forwarded',
        },
    },
    events: {onProgress: {
        kind: 'event',
        channel: 'pdf:search:progress',
        payload: pdfSearchProgressSchema,
        subscription: {
            channel: 'pdf:search:progress:subscribe',
            request: 'once-per-preload-event-channel',
            main: {
                method: 'subscribeProgress',
                context: 'sender',
            },
            replay: {
                owner: 'ipc-progress-pump',
                mode: 'latest-per-key',
                key: (progress: IPdfSearchProgress) => progress.requestId,
                terminal: (progress: IPdfSearchProgress) => progress.status === 'success'
                        || progress.status === 'canceled'
                        || progress.status === 'failed'
                        || progress.canceled === true
                        || progress.processed >= progress.total,
                intervalMs: 50,
                terminalRetentionMs: 30_000,
            },
        },
        browser: {method: 'onProgress'},
        lazy: 'forwarded',
    }},
});
export type ISearchCapability = TFeatureCapability<typeof SEARCH_PLATFORM_FEATURE>;
export type ISearchInvokeMap = TFeatureInvokeMap<typeof SEARCH_PLATFORM_FEATURE>;
export type ISearchEventMap = TFeatureEventMap<typeof SEARCH_PLATFORM_FEATURE>;
