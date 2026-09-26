import type {
    IOcrProgress,
    IOcrSearchablePdfOptions,
    IOcrSearchablePdfPage,
    IOcrSearchablePdfPageRange,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';
import {
    OCR_CANCEL_RESULT_SCHEMA,
    OCR_COMPLETE_EVENT_CHANNEL,
    OCR_COMPLETE_RESULT_SCHEMA,
    OCR_JOB_START_RESULT_SCHEMA,
    OCR_PROGRESS_EVENT_CHANNEL,
    OCR_PROGRESS_SCHEMA,
    OCR_RESULT_FILE_ACK_RESULT_SCHEMA,
    OCR_SEARCHABLE_PDF_OPTIONS_SCHEMA,
} from '@contracts/electronApiOcr';
import {
    decodeDocumentOcrAvailability,
    decodeDocumentOcrPageSnapshot,
    decodeDocumentTextCatalogWindow,
    decodeDocumentTextSnapshot,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    type IDocumentOcrAvailability,
    type IDocumentOcrPageSnapshot,
    type IDocumentTextCatalogWindow,
    type IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {isLikelyAbsolutePath} from '@contracts/ipcAssertions';
import {decodeOcrLanguages} from '@contracts/ocrLanguages';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
    type TPlatformFeatureSchema,
} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';
import {
    parseRequestId,
    type IOcrLanguage,
    type TRequestId,
} from '@contracts/shared';
import * as v from 'valibot';

const MAX_COLLECTION_ITEMS = 100_000;
const OCR_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1_000;
const OCR_REQUEST_ID_MAX_LENGTH = 128;
const OMITTED_BROWSER_METHOD = {
    unsupported: 'omitted',
    reason: 'not-implemented',
} as const;

function decodeSafeIntegerArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    min = 0,
) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(fieldName + ' must be a safe integer >= ' + min);
    }
    return value;
}

function decodeStringArrayArg(args: readonly unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(fieldName + ' must be an array of strings');
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function decodeBoundedArray(value: unknown, fieldName: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(fieldName + ' must be an array');
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(fieldName + ' exceeds maximum item count (' + MAX_COLLECTION_ITEMS + ')');
    }
    return value.map((item: unknown): unknown => item);
}

function decodeSearchablePdfPages(value: unknown): TOcrSearchablePdfPages {
    if (Array.isArray(value)) {
        return decodeBoundedArray(value, 'OCR searchable PDF pages').map((page) => {
            if (!isRecord(page)) {
                throw new Error('OCR searchable PDF page must be an object');
            }
            return {
                pageNumber: requirePageNumber(decodeSafeIntegerArg([page.pageNumber], 0, 'pageNumber', 1)),
                languages: decodeStringArrayArg([page.languages], 0, 'languages'),
            };
        }) satisfies IOcrSearchablePdfPage[];
    }
    if (!isRecord(value)) {
        throw new Error('OCR searchable PDF pages must be an array or scalar selection');
    }

    const selection = value.selection;
    if (selection !== undefined) {
        return decodeSearchablePdfPages(selection);
    }
    const kind = value.kind ?? value.mode ?? value.type;
    if (kind === 'pages') {
        return decodeSearchablePdfPages(value.pages);
    }
    if (kind !== 'all' && kind !== 'range' && kind !== 'ranges') {
        throw new Error('OCR searchable PDF selection kind must be all, range, ranges, or pages');
    }
    const languages = decodeStringArrayArg([value.languages], 0, 'languages');
    const decodePageNumber = (candidate: unknown, fieldName: string, min = 1) =>
        decodeSafeIntegerArg([candidate], 0, fieldName, min);
    if (kind === 'all') {
        return {
            kind: 'all',
            pageCount: decodePageNumber(value.pageCount, 'pageCount'),
            languages,
        };
    }
    if (kind === 'range') {
        const firstPage = decodePageNumber(value.firstPage, 'firstPage');
        const lastPage = decodePageNumber(value.lastPage, 'lastPage', firstPage);
        if (lastPage < firstPage) {
            throw new Error('lastPage must be greater than or equal to firstPage');
        }
        return {
            kind: 'range',
            firstPage,
            lastPage,
            languages,
        };
    }

    const ranges = decodeBoundedArray(value.ranges, 'OCR searchable PDF ranges').map((range, index) => {
        if (!isRecord(range)) {
            throw new Error('OCR searchable PDF range ' + index + ' must be an object');
        }
        const firstPage = decodePageNumber(range.firstPage, 'ranges[' + index + '].firstPage');
        const lastPage = decodePageNumber(range.lastPage, 'ranges[' + index + '].lastPage', firstPage);
        if (lastPage < firstPage) {
            throw new Error('ranges[' + index + '].lastPage must be greater than or equal to firstPage');
        }
        return {
            firstPage,
            lastPage,
        } satisfies IOcrSearchablePdfPageRange;
    });
    if (ranges.length === 0) {
        throw new Error('OCR searchable PDF ranges must be non-empty');
    }
    return {
        kind: 'ranges',
        ranges,
        languages,
    };
}

const searchablePdfPagesSchema = v.pipe(
    v.unknown(),
    v.transform(decodeSearchablePdfPages),
);
const safeIntegerSchema = (fieldName: string, min = 0) => v.message(
    v.pipe(
        v.number(),
        v.finite(),
        v.safeInteger(),
        v.minValue(min),
    ),
    fieldName + ' must be a safe integer >= ' + min,
);
const absolutePathSchema = (fieldName: string) => v.pipe(
    v.string(),
    v.check(value => value.trim().length > 0, fieldName + ' must not be empty'),
    v.maxLength(4_096, fieldName + ' exceeds maximum length (4096)'),
    v.check(value => !value.includes('\0'), fieldName + ' must not contain NUL bytes'),
    v.check(isLikelyAbsolutePath, fieldName + ' must be an absolute path'),
    v.custom<TDocumentRef>(value => parseDocumentRef(value) !== null, fieldName + ' must be a supported document reference'),
);
const optionalAbsolutePathSchema = (fieldName: string) => v.pipe(
    v.nullish(v.union([
        v.literal(''),
        absolutePathSchema(fieldName),
    ])),
    v.transform(value => value === '' || value === null || value === undefined ? undefined : value),
);
const requestIdSchema = (fieldName: string) => v.pipe(
    v.string(),
    v.transform(value => value.trim()),
    v.minLength(1, fieldName + ' must not be empty'),
    v.maxLength(OCR_REQUEST_ID_MAX_LENGTH, fieldName + ' exceeds maximum length (' + OCR_REQUEST_ID_MAX_LENGTH + ')'),
    v.check(value => !value.includes('\0'), fieldName + ' must not contain NUL bytes'),
    v.custom<TRequestId>(value => parseRequestId(value) !== null, fieldName + ' must be a valid request ID'),
);
const documentRevisionSchema = v.pipe(
    v.string(),
    v.transform(value => value.trim()),
    v.custom<TDocumentRevisionToken>(value => parseDocumentRevisionToken(value) !== null, 'documentRevision must be a valid revision token'),
);
const pageCountSchema = safeIntegerSchema('pageCount', 0);
const requestIdArgs = v.strictTuple([requestIdSchema('requestId')]);
const noArgs = v.strictTuple([]);
const acknowledgeResultFileArgs = v.pipe(
    v.strictTuple([
        requestIdSchema('ocrAcknowledgeResultFile.requestId'),
        v.optional(optionalAbsolutePathSchema('ocrAcknowledgeResultFile.pdfPath')),
        v.optional(optionalAbsolutePathSchema('ocrAcknowledgeResultFile.documentRef')),
        v.optional(documentRevisionSchema),
    ]),
    v.check(([
        , , documentRef,
        sourceDocumentRevisionToken,
    ]) =>
        documentRef === undefined || sourceDocumentRevisionToken !== undefined,
    'ocrAcknowledgeResultFile.sourceDocumentRevisionToken is required with documentRef'),
    v.check(([
        , pdfPath,
        documentRef,
    ]) =>
        documentRef === undefined || pdfPath !== undefined,
    'ocrAcknowledgeResultFile.pdfPath is required with documentRef'),
    v.check(([
        , , documentRef,
        sourceDocumentRevisionToken,
    ]) =>
        documentRef !== undefined || sourceDocumentRevisionToken === undefined,
    'ocrAcknowledgeResultFile.documentRef is required with sourceDocumentRevisionToken'),
    v.transform(([
        requestId,
        pdfPath,
        documentRef,
        sourceDocumentRevisionToken,
    ]) => {
        if (documentRef !== undefined && sourceDocumentRevisionToken !== undefined && pdfPath !== undefined) {
            return [
                requestId,
                pdfPath,
                documentRef,
                sourceDocumentRevisionToken,
            ] as [
                TRequestId,
                TDocumentRef,
                TDocumentRef,
                TDocumentRevisionToken,
            ];
        }
        return pdfPath === undefined
            ? [requestId] as [TRequestId]
            : [
                requestId,
                pdfPath,
            ] as [TRequestId, TDocumentRef];
    }),
);
const createSearchablePdfArgs = v.pipe(
    v.strictTuple([
        absolutePathSchema('ocrCreateSearchablePdf.sourcePdfPath'),
        searchablePdfPagesSchema,
        requestIdSchema('ocrCreateSearchablePdf.requestId'),
        v.optional(v.union([
            safeIntegerSchema('renderDpi', 1),
            OCR_SEARCHABLE_PDF_OPTIONS_SCHEMA,
        ])),
    ]),
    v.transform(([
        sourcePdfPath,
        pages,
        requestId,
        renderDpiOrOptions,
    ]) =>
        renderDpiOrOptions === undefined
            ? [
                sourcePdfPath,
                pages,
                requestId,
            ] as [TDocumentRef, TOcrSearchablePdfPages, TRequestId]
            : [
                sourcePdfPath,
                pages,
                requestId,
                renderDpiOrOptions,
            ] as [
                TDocumentRef,
                TOcrSearchablePdfPages,
                TRequestId,
                number | IOcrSearchablePdfOptions,
            ]),
);
const resolveDocumentTextCatalogArgs = v.union([
    v.strictTuple([
        absolutePathSchema('resolveDocumentTextCatalog.workingCopyPath'),
        documentRevisionSchema,
    ]),
    v.strictTuple([
        absolutePathSchema('resolveDocumentTextCatalog.workingCopyPath'),
        documentRevisionSchema,
        pageCountSchema,
    ]),
    v.strictTuple([
        absolutePathSchema('resolveDocumentTextCatalog.workingCopyPath'),
        documentRevisionSchema,
        v.undefined(),
        requestIdSchema('resolveDocumentTextCatalog.requestId'),
    ]),
    v.strictTuple([
        absolutePathSchema('resolveDocumentTextCatalog.workingCopyPath'),
        documentRevisionSchema,
        pageCountSchema,
        requestIdSchema('resolveDocumentTextCatalog.requestId'),
    ]),
]);
const resolveDocumentTextCatalogWindowArgs = v.union([
    v.pipe(
        v.strictTuple([
            absolutePathSchema('resolveDocumentTextCatalogWindow.workingCopyPath'),
            documentRevisionSchema,
            safeIntegerSchema('firstPage', 1),
            safeIntegerSchema('lastPage', 1),
        ]),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage >= firstPage, 'lastPage must be greater than or equal to firstPage'),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage - firstPage + 1 <= MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
        'document text catalog windows may contain at most ' + MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES + ' pages'),
    ),
    v.pipe(
        v.strictTuple([
            absolutePathSchema('resolveDocumentTextCatalogWindow.workingCopyPath'),
            documentRevisionSchema,
            safeIntegerSchema('firstPage', 1),
            safeIntegerSchema('lastPage', 1),
            pageCountSchema,
        ]),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage >= firstPage, 'lastPage must be greater than or equal to firstPage'),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage - firstPage + 1 <= MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
        'document text catalog windows may contain at most ' + MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES + ' pages'),
        v.check(([
            , , , lastPage,
            pageCount,
        ]) => pageCount >= lastPage, 'pageCount must be greater than or equal to lastPage'),
    ),
    v.pipe(
        v.strictTuple([
            absolutePathSchema('resolveDocumentTextCatalogWindow.workingCopyPath'),
            documentRevisionSchema,
            safeIntegerSchema('firstPage', 1),
            safeIntegerSchema('lastPage', 1),
            v.undefined(),
            requestIdSchema('resolveDocumentTextCatalogWindow.requestId'),
        ]),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage >= firstPage, 'lastPage must be greater than or equal to firstPage'),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage - firstPage + 1 <= MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
        'document text catalog windows may contain at most ' + MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES + ' pages'),
    ),
    v.pipe(
        v.strictTuple([
            absolutePathSchema('resolveDocumentTextCatalogWindow.workingCopyPath'),
            documentRevisionSchema,
            safeIntegerSchema('firstPage', 1),
            safeIntegerSchema('lastPage', 1),
            pageCountSchema,
            requestIdSchema('resolveDocumentTextCatalogWindow.requestId'),
        ]),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage >= firstPage, 'lastPage must be greater than or equal to firstPage'),
        v.check(([
            , , firstPage,
            lastPage,
        ]) => lastPage - firstPage + 1 <= MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
        'document text catalog windows may contain at most ' + MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES + ' pages'),
        v.check(([
            , , , lastPage,
            pageCount,
        ]) => pageCount >= lastPage, 'pageCount must be greater than or equal to lastPage'),
    ),
]);
const resolveDocumentOcrAvailabilityArgs = v.strictTuple([
    absolutePathSchema('resolveDocumentOcrAvailability.workingCopyPath'),
    documentRevisionSchema,
]);
const resolveDocumentOcrPageArgs = v.strictTuple([
    absolutePathSchema('resolveDocumentOcrPage.workingCopyPath'),
    documentRevisionSchema,
    safeIntegerSchema('pageNumber', 1),
]);

function defineOcrMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends TPlatformFeatureSchema<unknown[]>,
    const TResult extends TPlatformFeatureSchema,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean;
    optionalWhenImplemented?: boolean;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
            ...(definition.timeout ? {timeoutMs: OCR_NATIVE_IPC_TIMEOUT_MS} : {}),
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: definition.optionalWhenImplemented
            ? OMITTED_BROWSER_METHOD
            : {method: definition.name},
        ...(definition.optionalWhenImplemented
            ? {
                optionalWhenImplemented: true,
                required: {
                    browser: false,
                    electron: false,
                },
            }
            : {}),
        lazy: 'forwarded',
    } as const;
}

const languageResult = v.custom<IOcrLanguage[]>(value => decodeOcrLanguages(value) !== null);
const documentTextCatalogResult = v.custom<IDocumentTextSnapshot>(value => decodeDocumentTextSnapshot(value) !== null);
const documentTextCatalogWindowResult = v.custom<IDocumentTextCatalogWindow>(value => decodeDocumentTextCatalogWindow(value) !== null);
const documentOcrAvailabilityResult = v.custom<IDocumentOcrAvailability>(value => decodeDocumentOcrAvailability(value) !== null);
const documentOcrPageResult = v.custom<IDocumentOcrPageSnapshot>(value => decodeDocumentOcrPageSnapshot(value) !== null);
const progressReplay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IOcrProgress) => payload.requestId,
    terminal: (payload: IOcrProgress) =>
        payload.status === 'success'
        || payload.status === 'canceled'
        || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

export const OCR_PLATFORM_FEATURE = definePlatformFeature({
    path: ['ocr'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        cancel: defineOcrMethod({
            name: 'cancel',
            channel: 'ocr:cancel',
            args: requestIdArgs,
            result: OCR_CANCEL_RESULT_SCHEMA,
        }),
        getLanguages: defineOcrMethod({
            name: 'getLanguages',
            channel: 'ocr:getLanguages',
            args: noArgs,
            result: languageResult,
        }),
        resolveDocumentTextCatalog: defineOcrMethod({
            name: 'resolveDocumentTextCatalog',
            channel: 'ocr:resolveDocumentTextCatalog',
            args: resolveDocumentTextCatalogArgs,
            result: documentTextCatalogResult,
            timeout: true,
        }),
        resolveDocumentTextCatalogWindow: defineOcrMethod({
            name: 'resolveDocumentTextCatalogWindow',
            channel: 'ocr:resolveDocumentTextCatalogWindow',
            args: resolveDocumentTextCatalogWindowArgs,
            result: documentTextCatalogWindowResult,
            timeout: true,
        }),
        resolveDocumentOcrAvailability: defineOcrMethod({
            name: 'resolveDocumentOcrAvailability',
            channel: 'ocr:resolveDocumentOcrAvailability',
            args: resolveDocumentOcrAvailabilityArgs,
            result: documentOcrAvailabilityResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        resolveDocumentOcrPage: defineOcrMethod({
            name: 'resolveDocumentOcrPage',
            channel: 'ocr:resolveDocumentOcrPage',
            args: resolveDocumentOcrPageArgs,
            result: documentOcrPageResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        acknowledgeResultFile: defineOcrMethod({
            name: 'acknowledgeResultFile',
            channel: 'ocr:ackResultFile',
            args: acknowledgeResultFileArgs,
            result: OCR_RESULT_FILE_ACK_RESULT_SCHEMA,
        }),
        createSearchablePdf: defineOcrMethod({
            name: 'createSearchablePdf',
            channel: 'ocr:createSearchablePdf',
            args: createSearchablePdfArgs,
            result: OCR_JOB_START_RESULT_SCHEMA,
            timeout: true,
        }),
    },
    events: {
        onProgress: {
            kind: 'event',
            channel: OCR_PROGRESS_EVENT_CHANNEL,
            payload: OCR_PROGRESS_SCHEMA,
            subscription: {
                channel: 'ocr:progress:subscribe',
                request: 'once-per-preload-event-channel',
                main: {
                    method: 'subscribeProgress',
                    context: 'sender',
                },
                replay: progressReplay,
            },
            browser: {method: 'onProgress'},
            lazy: 'forwarded',
        },
        onComplete: {
            kind: 'event',
            channel: OCR_COMPLETE_EVENT_CHANNEL,
            payload: OCR_COMPLETE_RESULT_SCHEMA,
            browser: {method: 'onComplete'},
            lazy: 'forwarded',
        },
    },
});

type TOcrFeatureCapability = TFeatureCapability<typeof OCR_PLATFORM_FEATURE>;
type TOcrHotReloadMethod = 'resolveDocumentOcrAvailability' | 'resolveDocumentOcrPage';

export type IOcrCapability =
    Omit<TOcrFeatureCapability, TOcrHotReloadMethod>
    & Partial<Pick<TOcrFeatureCapability, TOcrHotReloadMethod>>;
export type IOcrInvokeMap = TFeatureInvokeMap<typeof OCR_PLATFORM_FEATURE>;
export type IOcrEventMap = TFeatureEventMap<typeof OCR_PLATFORM_FEATURE>;
