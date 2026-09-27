import type { TPageNumber } from '@contracts/pageNumbers';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import { isRecord } from '@contracts/runtimeGuards';
import {
    parseRequestId,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import * as v from 'valibot';

const MAX_COLLECTION_ITEMS = 100_000;
/** Must match IMAGE_EXPORT_MAX_OUTPUT_PATHS in the main image-export resource limits. */
const IMAGE_EXPORT_MAX_OUTPUT_PATHS = 100_000;
const IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH = 128;

const documentRefSchema = v.pipe(
    v.unknown(),
    v.transform((value): TDocumentRef => {
        const documentRef = parseDocumentRef(value);
        if (documentRef === null) {
            throw new Error('workingCopyPath must be an absolute document reference');
        }
        return documentRef;
    }),
);
const pageNumbersSchema = v.pipe(
    v.unknown(),
    v.transform((value): unknown[] => {
        if (!Array.isArray(value) || value.length === 0) {
            throw new Error('pageNumbers must be a non-empty array');
        }
        if (value.length > MAX_COLLECTION_ITEMS) {
            throw new Error(`pageNumbers exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
        }
        return value;
    }),
    v.check(
        pages => pages.every(page => (
            typeof page === 'number'
            && Number.isSafeInteger(page)
            && page >= 1
        )),
        'pageNumbers must contain positive safe integers',
    ),
    v.check(
        pages => new Set(pages).size === pages.length,
        'pageNumbers must contain unique pages',
    ),
    v.transform(pages => pages.map(page => requirePageNumber(page as number))),
);
const requestIdSchema = v.pipe(
    v.nullish(v.string('requestId must be a string')),
    v.transform((value) => {
        if (value === undefined || value === null) {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length === 0 ? undefined : trimmed;
    }),
    v.check(
        value => value === undefined || value.length <= IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH,
        `requestId exceeds maximum length (${IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH})`,
    ),
    v.transform(value => value === undefined ? undefined : requireRequestId(value)),
);
const sourceKindSchema = v.picklist([
    'pdf',
    'djvu',
], 'sourceKind must be pdf or djvu');
const exportArgs = v.strictTuple([
    documentRefSchema,
    v.optional(pageNumbersSchema),
    v.optional(requestIdSchema),
    v.optional(sourceKindSchema),
]);
type TImageExportArgs = v.InferOutput<typeof exportArgs>;

const outputPathsSchema = v.pipe(
    v.unknown(),
    v.transform((value): unknown[] => {
        if (!Array.isArray(value)) {
            throw new Error('outputPaths must be an array of strings');
        }
        if (value.length > IMAGE_EXPORT_MAX_OUTPUT_PATHS) {
            throw new Error(`outputPaths exceeds maximum item count (${IMAGE_EXPORT_MAX_OUTPUT_PATHS})`);
        }
        return value;
    }),
    v.check(
        paths => paths.every(path => typeof path === 'string'),
        'outputPaths must be an array of strings',
    ),
    v.transform(paths => paths.filter((path): path is string => typeof path === 'string')),
);
const imageExportResultSchema = v.pipe(
    v.object({
        success: v.boolean('invalid image export result'),
        canceled: v.optional(v.boolean('invalid image export result')),
        outputPaths: v.optional(outputPathsSchema),
    }, 'invalid image export result'),
    v.transform(({
        success,
        canceled,
        outputPaths,
    }) => ({
        success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(outputPaths === undefined ? {} : {outputPaths}),
    })),
);
const multiPageTiffResultSchema = v.pipe(
    v.unknown(),
    v.transform((value) => {
        if (!isRecord(value) || (value.outputPath !== undefined && typeof value.outputPath !== 'string')) {
            throw new Error('invalid multi-page TIFF export result');
        }
        return value;
    }),
    v.transform((value) => {
        const result = v.parse(imageExportResultSchema, value, {abortEarly: true});
        return {
            ...result,
            ...(value.outputPath === undefined ? {} : {outputPath: value.outputPath as string}),
        };
    }),
);

const INVALID_PROGRESS = 'invalid image export progress';
const imageExportProgressFormatSchema = v.picklist([
    'images',
    'multipage-tiff',
], INVALID_PROGRESS);
const imageExportProgressPhaseSchema = v.picklist([
    'rendering',
    'combining',
], INVALID_PROGRESS);
const imageExportProgressStatusSchema = v.picklist([
    'running',
    'success',
    'canceled',
    'failed',
], INVALID_PROGRESS);
const imageExportProgressRequestIdSchema = v.pipe(
    v.unknown(),
    v.transform((value): TRequestId => {
        const requestId = parseRequestId(value);
        if (requestId === null) {
            throw new Error(INVALID_PROGRESS);
        }
        return requestId;
    }),
);
const finiteProgressSchema = v.pipe(
    v.number(INVALID_PROGRESS),
    v.finite(INVALID_PROGRESS),
);
const imageExportProgressSchema = v.pipe(
    v.object({
        requestId: imageExportProgressRequestIdSchema,
        format: imageExportProgressFormatSchema,
        phase: imageExportProgressPhaseSchema,
        processed: finiteProgressSchema,
        total: finiteProgressSchema,
        percent: finiteProgressSchema,
        status: v.optional(imageExportProgressStatusSchema),
        error: v.optional(v.string(INVALID_PROGRESS)),
    }, INVALID_PROGRESS),
    v.transform(({
        requestId,
        format,
        phase,
        processed,
        total,
        percent,
        status,
        error,
    }) => ({
        requestId,
        format,
        phase,
        processed,
        total,
        percent,
        ...(status === undefined ? {} : {status}),
        ...(error === undefined ? {} : {error}),
    })),
);

export type TImageExportProgressFormat = v.InferOutput<typeof imageExportProgressFormatSchema>;
export type TImageExportProgressPhase = v.InferOutput<typeof imageExportProgressPhaseSchema>;
export type TImageExportProgressStatus = v.InferOutput<typeof imageExportProgressStatusSchema>;
export type TDocumentImageExportSourceKind = v.InferOutput<typeof sourceKindSchema>;
export type IImageExportProgress = v.InferOutput<typeof imageExportProgressSchema>;

const replay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IImageExportProgress) => payload.requestId,
    terminal: (payload: IImageExportProgress) =>
        payload.status === 'success' || payload.status === 'canceled' || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

export const IMAGE_EXPORT_PLATFORM_FEATURE = definePlatformFeature({
    path: ['imageExport'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        exportPdfToImages: {
            kind: 'async',
            channel: 'pdfExport:images',
            ipc: {
                args: exportArgs,
                result: imageExportResultSchema,
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                workingCopyPath: TDocumentRef,
                pageNumbers?: TPageNumber[],
                requestId?: TRequestId,
                sourceKind?: TDocumentImageExportSourceKind,
            ): TImageExportArgs => [
                workingCopyPath,
                pageNumbers,
                requestId,
                sourceKind,
            ]},
            main: {
                method: 'exportImages',
                context: 'sender',
            },
            browser: {method: 'exportPdfToImages'},
            lazy: 'forwarded',
        },
        exportPdfToMultiPageTiff: {
            kind: 'async',
            channel: 'pdfExport:multipage-tiff',
            ipc: {
                args: exportArgs,
                result: multiPageTiffResultSchema,
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                workingCopyPath: TDocumentRef,
                pageNumbers?: TPageNumber[],
                requestId?: TRequestId,
                sourceKind?: TDocumentImageExportSourceKind,
            ): TImageExportArgs => [
                workingCopyPath,
                pageNumbers,
                requestId,
                sourceKind,
            ]},
            main: {
                method: 'exportMultiPageTiff',
                context: 'sender',
            },
            browser: {method: 'exportPdfToMultiPageTiff'},
            lazy: 'forwarded',
        },
    },
    events: {onProgress: {
        kind: 'event',
        channel: 'pdfExport:progress',
        payload: imageExportProgressSchema,
        subscription: {
            channel: 'pdfExport:progress:subscribe',
            request: 'once-per-preload-event-channel',
            main: {
                method: 'subscribeProgress',
                context: 'sender',
            },
            replay,
        },
        browser: {method: 'onProgress'},
        lazy: 'forwarded',
    }},
});

export type IImageExportCapability = TFeatureCapability<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
export type IImageExportInvokeMap = TFeatureInvokeMap<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
export type IImageExportEventMap = TFeatureEventMap<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
