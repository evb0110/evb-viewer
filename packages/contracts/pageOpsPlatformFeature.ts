import type {
    TPageNumber,
    IPageMoveRangeSegment,
} from '@contracts/pageNumbers';

import type {
    IPageOpsMetadataSnapshot,
    IPageOpsMutationOptions,
    TPageOpsPageSelection,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import {
    PAGE_OPS_CANCEL_ACTIVE_RESULT_SCHEMA,
    PAGE_OPS_EXTRACT_RESULT_SCHEMA,
    PAGE_OPS_INSERT_RESULT_SCHEMA,
    PAGE_OPS_RESULT_SCHEMA,
} from '@contracts/electronApiPageOps';
import {requirePageIndex} from '@contracts/pageNumbers';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
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
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

const MAX_COLLECTION_ITEMS = 100_000;
const MAX_PAGE_SELECTION_ITEMS = 1_000_000;
const METHOD_TIMEOUT_MS = 30 * 60 * 1_000;
const PAGE_LABEL_STYLES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;
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

function decodeBookmarkEntries(
    value: unknown,
    depth = 0,
    counter = {value: 0},
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value) || depth > 64) {
        throw new Error('options.metadataSnapshot.bookmarks must be a bounded bookmark array');
    }
    return value.map((raw): IPdfBookmarkEntry => {
        counter.value += 1;
        if (counter.value > MAX_COLLECTION_ITEMS) {
            throw new Error(`options.metadataSnapshot.bookmarks exceeds the item limit (${MAX_COLLECTION_ITEMS})`);
        }
        if (!isRecord(raw)) {
            throw new Error('options.metadataSnapshot.bookmarks contains an invalid bookmark');
        }
        const pageIndex = raw.pageIndex;
        const pageYRatio = raw.pageYRatio;
        if (
            pageIndex !== null
            && (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0)
        ) {
            throw new Error('bookmark.pageIndex must be a non-negative integer or null');
        }
        if (
            typeof raw.title !== 'string'
            || raw.title.length > 4_096
            || (raw.namedDest !== null && typeof raw.namedDest !== 'string')
            || typeof raw.bold !== 'boolean'
            || typeof raw.italic !== 'boolean'
            || (raw.color !== null && typeof raw.color !== 'string')
        ) {
            throw new Error('options.metadataSnapshot.bookmarks contains invalid fields');
        }
        if (pageYRatio !== undefined && pageYRatio !== null && !isFiniteNumber(pageYRatio)) {
            throw new Error('bookmark.pageYRatio must be finite or null');
        }
        return {
            title: raw.title,
            pageIndex: pageIndex === null ? null : requirePageIndex(pageIndex),
            ...(pageYRatio === undefined ? {} : {pageYRatio}),
            namedDest: raw.namedDest,
            bold: raw.bold,
            italic: raw.italic,
            color: raw.color,
            items: decodeBookmarkEntries(raw.items, depth + 1, counter),
        };
    });
}

function decodeMetadataSnapshot(value: unknown): IPageOpsMetadataSnapshot {
    if (!isRecord(value)) {
        throw new Error('options.metadataSnapshot must be an object');
    }
    const pageLabels = value.pageLabels;
    if (
        pageLabels !== undefined
        && pageLabels !== null
        && (
            !Array.isArray(pageLabels)
            || pageLabels.length > 1_000_000
            || !pageLabels.every(label => typeof label === 'string' && label.length <= 4_096)
        )
    ) {
        throw new Error('options.metadataSnapshot.pageLabels must be a string array, null, or omitted');
    }
    const rawPageLabelRanges = value.pageLabelRanges;
    let pageLabelRanges: IPdfPageLabelRange[] | undefined;
    if (rawPageLabelRanges !== undefined) {
        if (!Array.isArray(rawPageLabelRanges) || rawPageLabelRanges.length > 100_000) {
            throw new Error('options.metadataSnapshot.pageLabelRanges must be a compact page-label range array or omitted');
        }
        let previousStartPage = 0;
        pageLabelRanges = rawPageLabelRanges.map((rawRange, index) => {
            if (!isRecord(rawRange)) {
                throw new Error('options.metadataSnapshot.pageLabelRanges must be a compact page-label range array or omitted');
            }
            const startPage = rawRange.startPage;
            const style = rawRange.style;
            const prefix = rawRange.prefix;
            const startNumber = rawRange.startNumber;
            if (
                typeof startPage !== 'number'
                || !Number.isSafeInteger(startPage)
                || startPage < 1
                || index > 0 && startPage <= previousStartPage
                || style !== null && !PAGE_LABEL_STYLES.some(candidate => candidate === style)
                || typeof prefix !== 'string'
                || prefix.length > 4_096
                || typeof startNumber !== 'number'
                || !Number.isSafeInteger(startNumber)
                || startNumber < 1
            ) {
                throw new Error('options.metadataSnapshot.pageLabelRanges must be a compact page-label range array or omitted');
            }
            const normalizedStyle = style === null
                ? null
                : PAGE_LABEL_STYLES.find(candidate => candidate === style);
            if (normalizedStyle === undefined) {
                throw new Error('options.metadataSnapshot.pageLabelRanges must be a compact page-label range array or omitted');
            }
            previousStartPage = startPage;
            return {
                startPage,
                style: normalizedStyle,
                prefix,
                startNumber,
            };
        });
    }
    if (typeof value.untitledBookmarkLabel !== 'string') {
        throw new Error('options.metadataSnapshot.untitledBookmarkLabel must be a string');
    }
    return {
        ...(pageLabels === undefined ? {} : {pageLabels}),
        ...(pageLabelRanges === undefined ? {} : {pageLabelRanges}),
        ...(value.bookmarks === undefined ? {} : {bookmarks: decodeBookmarkEntries(value.bookmarks)}),
        untitledBookmarkLabel: value.untitledBookmarkLabel,
    };
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
    },
    events: {},
});

export type IPageOpsCapability = TFeatureCapability<typeof PAGE_OPS_PLATFORM_FEATURE>;
export type IPageOpsInvokeMap = TFeatureInvokeMap<typeof PAGE_OPS_PLATFORM_FEATURE>;
