import {
    PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA,
    PDF_BOOKMARK_SOURCE_REFERENCE_SCHEMA,
} from '@contracts/pdfBookmarkEntry';
import type {
    TPageNumber,
    IPageMoveRangeSegment,
} from '@contracts/pageNumbers';

import type {
    IPageOpsMutationOptions,
    TPageOpsPageSelection,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import {
    decodeMetadataSnapshot,
    PAGE_OPS_CANCEL_ACTIVE_RESULT_SCHEMA,
    PAGE_OPS_EXTRACT_RESULT_SCHEMA,
    PAGE_OPS_INSERT_RESULT_SCHEMA,
    PAGE_OPS_RESULT_SCHEMA,
} from '@contracts/electronApiPageOps';
import {PAGE_GEOMETRY_SCHEMA} from '@contracts/decodePageGeometry';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {
    normalizeCropMargins,
    parseRequestId,
} from '@contracts/shared';
import type {
    ICropMargins,
    TRequestId,
} from '@contracts/shared';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import * as v from 'valibot';
import {isRecord} from '@contracts/runtimeGuards';
import type {IPdfNativeTextBoxAppearanceRequest} from '@contracts/electronApiDocuments';
import {
    normalizePdfNativeTextBoxAppearanceRequest,
    normalizePdfNativeTextBoxAppearanceMetadata,
    PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS,
} from '@contracts/nativePdfMutations';

const MAX_COLLECTION_ITEMS = 100_000;
const MAX_PAGE_SELECTION_ITEMS = 1_000_000;
/** qpdf's page listing is read before it can rewrite source object identities. */
export function decodePageSourceReferences(value: unknown) {
    const page = v.pipe(v.object({object: v.pipe(v.string(), v.regex(/^[1-9]\d* \d+ R$/u))}), v.transform(({object}) => {
        const [
            num,
            gen,
        ] = object.split(' ').map(Number);
        return v.parse(PDF_BOOKMARK_SOURCE_REFERENCE_SCHEMA, {
            num,
            gen,
        });
    }));
    return v.parse(v.object({pages: v.pipe(v.array(page), v.maxLength(MAX_PAGE_SELECTION_ITEMS))}), value).pages;
}

const METHOD_TIMEOUT_MS = 30 * 60 * 1_000;

type TDeleteArgs = [string, TPageOpsPageSelection, number, IPageOpsMutationOptions | undefined];
type TDeleteRangesArgs = [string, IPageMoveRangeSegment[], number, IPageOpsMutationOptions | undefined];
type TExtractArgs = [string, TPageOpsPageSelection];
type TCancelActiveArgs = [string];
type TReorderArgs = [string, number[], IPageOpsMutationOptions | undefined];
type TMoveArgs = [string, number, number, number, number, IPageOpsMutationOptions | undefined];
type TMoveRangesArgs = [string, IPageMoveRangeSegment[], number, number, IPageOpsMutationOptions | undefined];
type TInsertArgs = [string, number, number, IPageOpsMutationOptions | undefined];
type TInsertFileArgs = [
    string,
    number,
    number,
    string[],
    TRequestId | undefined,
    IPageOpsMutationOptions | undefined,
];
type TRotateArgs = [string, TPageOpsPageSelection, number, TPageOpsRotationAngle, IPageOpsMutationOptions | undefined];
type TCropArgs = [string, TPageOpsPageSelection, number, ICropMargins, IPageOpsMutationOptions | undefined];
type TRemoveCropArgs = [string, TPageOpsPageSelection, number, IPageOpsMutationOptions | undefined];
type TGetPageGeometryArgs = [string, number];
type TReadOutlineArgs = [string];

function decodeString(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value;
}

function decodeOptionalString(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    return value;
}

function decodeOptionalRequestId(args: unknown[], index: number, fieldName: string) {
    const value = decodeOptionalString(args, index, fieldName);
    if (value === undefined) {
        return undefined;
    }
    const parsed = parseRequestId(value);
    if (parsed === null) {
        throw new Error(`${fieldName} must be a valid request ID`);
    }
    return parsed;
}

function decodeSafeInteger(args: unknown[], index: number, fieldName: string, min = 0) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodePositiveIntegerArray(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty array`);
    }
    if (value.length > MAX_PAGE_SELECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_PAGE_SELECTION_ITEMS})`);
    }
    if (value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) {
        throw new Error(`${fieldName} must contain positive safe integers`);
    }
    return value.filter((item): item is number => typeof item === 'number');
}

function decodePageSelection(args: unknown[], index: number, fieldName: string): TPageOpsPageSelection {
    const value = args[index];
    if (Array.isArray(value)) {
        return decodePositiveIntegerArray(args, index, fieldName);
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be a page array or compact selection`);
    }
    const pageCount = value.pageCount;
    if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error(`${fieldName}.pageCount must be a positive safe integer`);
    }
    const ranges = decodePageMoveRangeSegments([value.ranges], 0, `${fieldName}.ranges`);
    let previousEnd = 0;
    for (const range of ranges) {
        if (range.startPage <= previousEnd || range.endPage > pageCount) {
            throw new Error(`${fieldName}.ranges must be sorted, disjoint, and within the document`);
        }
        previousEnd = range.endPage;
    }
    return {
        pageCount,
        ranges,
    };
}

function decodePageMoveRangeSegments(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    return value.map((item): IPageMoveRangeSegment => {
        if (
            !isRecord(item)
            || typeof item.startPage !== 'number'
            || !Number.isSafeInteger(item.startPage)
            || item.startPage < 1
            || typeof item.endPage !== 'number'
            || !Number.isSafeInteger(item.endPage)
            || item.endPage < item.startPage
        ) {
            throw new Error(`${fieldName} must contain non-empty page ranges`);
        }
        return {
            startPage: item.startPage,
            endPage: item.endPage,
        };
    });
}

function decodePageDeleteRangeSegments(
    args: unknown[],
    index: number,
    fieldName: string,
    totalPages: number,
) {
    const ranges = decodePageMoveRangeSegments(args, index, fieldName);
    let previousEnd = 0;
    for (const range of ranges) {
        if (
            range.endPage > totalPages
            || range.startPage <= previousEnd
        ) {
            throw new Error(`${fieldName} must be sorted, disjoint, and within the document`);
        }
        previousEnd = range.endPage;
    }
    return ranges;
}

function decodeStringArray(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    if (value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function decodeMutationOptions(value: unknown): IPageOpsMutationOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('options must be an object');
    }
    const allowedKeys = new Set([
        'expectedDocumentRevisionToken',
        'metadataSnapshot',
    ]);
    const unsupportedKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unsupportedKey) {
        throw new Error(`options contains unsupported key "${unsupportedKey}"`);
    }
    const metadataSnapshot = value.metadataSnapshot === undefined
        ? undefined
        : decodeMetadataSnapshot(value.metadataSnapshot);
    if (value.expectedDocumentRevisionToken === undefined) {
        return metadataSnapshot === undefined ? {} : {metadataSnapshot};
    }
    if (value.expectedDocumentRevisionToken === null) {
        return {
            expectedDocumentRevisionToken: null,
            ...(metadataSnapshot === undefined ? {} : {metadataSnapshot}),
        };
    }
    const token = parseDocumentRevisionToken(value.expectedDocumentRevisionToken);
    if (token === null) {
        throw new Error('options.expectedDocumentRevisionToken must be a valid document revision token or null');
    }
    return {
        expectedDocumentRevisionToken: token,
        ...(metadataSnapshot === undefined ? {} : {metadataSnapshot}),
    };
}

function decodeRotationAngle(args: unknown[], index: number): TPageOpsRotationAngle {
    const angle = decodeSafeInteger(args, index, 'angle');
    if (angle !== 90 && angle !== 180 && angle !== 270) {
        throw new Error('angle must be 90, 180, or 270');
    }
    return angle;
}

const pageOpsResult = PAGE_OPS_RESULT_SCHEMA;
const extractResult = PAGE_OPS_EXTRACT_RESULT_SCHEMA;
const insertResult = PAGE_OPS_INSERT_RESULT_SCHEMA;
const cancelActiveResult = PAGE_OPS_CANCEL_ACTIVE_RESULT_SCHEMA;
const pageGeometry = PAGE_GEOMETRY_SCHEMA;

function args<T extends unknown[]>(
    count: number,
    decode: (value: unknown[]) => T,
) {
    const tuple = Array.from({length: count}, () => v.unknown()) as [v.GenericSchema, ...v.GenericSchema[]];
    return v.pipe(
        v.unknown(),
        v.check(
            value => Array.isArray(value) && value.length === count,
            issue => `expected ${count} arguments, received ${Array.isArray(issue.input) ? issue.input.length : 0}`,
        ),
        v.strictTuple(tuple),
        v.transform(value => decode(value)),
    ) as v.GenericSchema<unknown, T>;
}

function method<
    const TName extends string,
    const TChannel extends string,
    TArgs extends v.GenericSchema<unknown, unknown[]>,
    TResult extends v.GenericSchema<unknown, unknown>,
    TMapArgs extends (...args: never[]) => v.InferOutput<TArgs>,
>(
    name: TName,
    channel: TChannel,
    methodArgs: TArgs,
    result: TResult,
    mapArgs: TMapArgs,
) {
    return {
        kind: 'async',
        channel,
        ipc: {
            args: methodArgs,
            result,
            timeoutMs: METHOD_TIMEOUT_MS,
        },
        client: {mapArgs},
        main: {
            method: name,
            context: 'sender',
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

export const PAGE_OPS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['pageOps'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        renderTextBoxAppearance: method(
            'renderTextBoxAppearance',
            'page-ops:text-box-appearance',
            v.strictTuple([
                v.nullable(v.string()),
                v.pipe(v.unknown(), v.transform(value => normalizePdfNativeTextBoxAppearanceRequest(value))),
            ]),
            v.pipe(
                v.object({
                    data: v.pipe(v.custom<Uint8Array>(value => value instanceof Uint8Array), v.check(value => value.byteLength > 0
                    && value.byteLength <= PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.outputBytes)),
                    textBoxes: v.unknown(),
                }),
                v.transform(value => ({
                    ...normalizePdfNativeTextBoxAppearanceMetadata(value),
                    data: value.data,
                })),
            ),
            (workingCopyPath: string | null, request: IPdfNativeTextBoxAppearanceRequest, _options?: {signal?: AbortSignal}) => [
                workingCopyPath,
                request,
            ] as [string | null, IPdfNativeTextBoxAppearanceRequest],
        ),
        delete: method(
            'delete',
            'page-ops:delete',
            args<TDeleteArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePageSelection(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeMutationOptions(value[3]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: TPageOpsPageSelection,
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TDeleteArgs => [
                workingCopyPath,
                pages,
                totalPages,
                options,
            ],
        ),
        deleteRanges: method(
            'deleteRanges',
            'page-ops:delete-ranges',
            args<TDeleteRangesArgs>(4, value => {
                const totalPages = decodeSafeInteger(value, 2, 'totalPages', 1);
                return [
                    decodeString(value, 0, 'workingCopyPath'),
                    decodePageDeleteRangeSegments(value, 1, 'ranges', totalPages),
                    totalPages,
                    decodeMutationOptions(value[3]),
                ];
            }),
            pageOpsResult,
            (
                workingCopyPath: string,
                ranges: IPageMoveRangeSegment[],
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TDeleteRangesArgs => [
                workingCopyPath,
                ranges,
                totalPages,
                options,
            ],
        ),
        extract: method(
            'extract',
            'page-ops:extract',
            args<TExtractArgs>(2, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePageSelection(value, 1, 'pages'),
            ]),
            extractResult,
            (workingCopyPath: string, pages: TPageOpsPageSelection): TExtractArgs => [
                workingCopyPath,
                pages,
            ],
        ),
        reorder: method(
            'reorder',
            'page-ops:reorder',
            args<TReorderArgs>(3, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'newOrder'),
                decodeMutationOptions(value[2]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                newOrder: number[],
                options?: IPageOpsMutationOptions,
            ): TReorderArgs => [
                workingCopyPath,
                newOrder,
                options,
            ],
        ),
        move: method(
            'move',
            'page-ops:move',
            args<TMoveArgs>(6, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'startPage', 1),
                decodeSafeInteger(value, 2, 'endPage', 1),
                decodeSafeInteger(value, 3, 'insertAt'),
                decodeSafeInteger(value, 4, 'totalPages', 1),
                decodeMutationOptions(value[5]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                startPage: number,
                endPage: number,
                insertAt: number,
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TMoveArgs => [
                workingCopyPath,
                startPage,
                endPage,
                insertAt,
                totalPages,
                options,
            ],
        ),
        moveRanges: method(
            'moveRanges',
            'page-ops:move-ranges',
            args<TMoveRangesArgs>(5, value => {
                const totalPages = decodeSafeInteger(value, 3, 'totalPages', 1);
                const ranges = decodePageMoveRangeSegments(value, 1, 'ranges');
                const insertAt = decodeSafeInteger(value, 2, 'insertAt');
                if (insertAt < 0 || insertAt > totalPages) {
                    throw new Error(`insertAt must be a safe integer in 0-${totalPages}`);
                }
                return [
                    decodeString(value, 0, 'workingCopyPath'),
                    ranges,
                    insertAt,
                    totalPages,
                    decodeMutationOptions(value[4]),
                ];
            }),
            pageOpsResult,
            (
                workingCopyPath: string,
                ranges: IPageMoveRangeSegment[],
                insertAt: number,
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TMoveRangesArgs => [
                workingCopyPath,
                ranges,
                insertAt,
                totalPages,
                options,
            ],
        ),
        insert: method(
            'insert',
            'page-ops:insert',
            args<TInsertArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'totalPages'),
                decodeSafeInteger(value, 2, 'afterPage'),
                decodeMutationOptions(value[3]),
            ]),
            insertResult,
            (
                workingCopyPath: string,
                totalPages: number,
                afterPage: number,
                options?: IPageOpsMutationOptions,
            ): TInsertArgs => [
                workingCopyPath,
                totalPages,
                afterPage,
                options,
            ],
        ),
        insertFile: method(
            'insertFile',
            'page-ops:insert-file',
            args<TInsertFileArgs>(6, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'totalPages'),
                decodeSafeInteger(value, 2, 'afterPage'),
                decodeStringArray(value, 3, 'sourcePaths'),
                decodeOptionalRequestId(value, 4, 'requestId'),
                decodeMutationOptions(value[5]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                totalPages: number,
                afterPage: number,
                sourcePaths: string[],
                requestId?: TRequestId,
                options?: IPageOpsMutationOptions,
            ): TInsertFileArgs => [
                workingCopyPath,
                totalPages,
                afterPage,
                sourcePaths,
                requestId,
                options,
            ],
        ),
        rotate: method(
            'rotate',
            'page-ops:rotate',
            args<TRotateArgs>(5, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePageSelection(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeRotationAngle(value, 3),
                decodeMutationOptions(value[4]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: TPageOpsPageSelection,
                totalPages: number,
                angle: TPageOpsRotationAngle,
                options?: IPageOpsMutationOptions,
            ): TRotateArgs => [
                workingCopyPath,
                pages,
                totalPages,
                angle,
                options,
            ],
        ),
        crop: method(
            'crop',
            'page-ops:crop',
            args<TCropArgs>(5, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePageSelection(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                normalizeCropMargins(value[3]),
                decodeMutationOptions(value[4]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: TPageOpsPageSelection,
                totalPages: number,
                margins: ICropMargins,
                options?: IPageOpsMutationOptions,
            ): TCropArgs => [
                workingCopyPath,
                pages,
                totalPages,
                margins,
                options,
            ],
        ),
        removeCrop: method(
            'removeCrop',
            'page-ops:remove-crop',
            args<TRemoveCropArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePageSelection(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeMutationOptions(value[3]),
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: TPageOpsPageSelection,
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TRemoveCropArgs => [
                workingCopyPath,
                pages,
                totalPages,
                options,
            ],
        ),
        cancelActive: {
            ...method(
                'cancelActive',
                'page-ops:cancel-active',
                args<TCancelActiveArgs>(1, value => [decodeString(value, 0, 'workingCopyPath')]),
                cancelActiveResult,
                (workingCopyPath: string): TCancelActiveArgs => [workingCopyPath],
            ),
            // Browser page operations run to completion inside WASM, so
            // there is nothing for the user to stop there.
            optionalWhenImplemented: true,
            required: {
                browser: false,
                electron: false,
            },
            browser: {
                unsupported: 'omitted',
                reason: 'requires-native-backend',
            },
        },
        getPageGeometry: method(
            'getPageGeometry',
            'page-ops:get-page-geometry',
            args<TGetPageGeometryArgs>(2, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'pageNumber', 1),
            ]),
            pageGeometry,
            (workingCopyPath: string, pageNumber: TPageNumber): TGetPageGeometryArgs => [
                workingCopyPath,
                pageNumber,
            ],
        ),
        // The document's outline as the native catalog reader keeps it: names
        // and actions other than GoTo stay what the source says.
        readOutline: method(
            'readOutline',
            'page-ops:read-outline',
            args<TReadOutlineArgs>(1, value => [decodeString(value, 0, 'workingCopyPath')]),
            v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA),
            (workingCopyPath: string): TReadOutlineArgs => [workingCopyPath],
        ),
    },
    events: {},
});

export type IPageOpsCapability = TFeatureCapability<typeof PAGE_OPS_PLATFORM_FEATURE>;
export type IPageOpsInvokeMap = TFeatureInvokeMap<typeof PAGE_OPS_PLATFORM_FEATURE>;

export {decodeMetadataSnapshot} from '@contracts/electronApiPageOps';
