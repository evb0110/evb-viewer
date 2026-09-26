import type {
    TPageNumber,
    IPageMoveRangeSegment,
} from '@contracts/pageNumbers';

import type {
    IPageIdentityDelta,
    IPageOpsCancelActiveResult,
    IPageOpsExtractResult,
    IPageOpsInsertResult,
    IPageOpsMetadataSnapshot,
    IPageOpsMutationOptions,
    IPageOpsResult,
    TPageOpsPageSelection,
    TPageIdentityDeltaPage,
    TPageIdentityRangeOperation,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import {requirePageIndex} from '@contracts/pageNumbers';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
import {decodePageGeometry as decodeSharedPageGeometry} from '@contracts/decodePageGeometry';
import { parseDocumentRef } from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    normalizeCropMargins,
    parseRequestId,
} from '@contracts/shared';
import type {
    ICropMargins,
    IPageGeometry,
    TRequestId,
} from '@contracts/shared';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureInvokeMap,
    type TInferSchema,
} from '@contracts/platformFeature';
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
const PAGE_IDENTITY_TOUCH_REASONS = [
    'rotate',
    'crop',
    'remove-crop',
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

function requireArgumentCount(value: unknown, count: number): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length !== count) {
        throw new Error(`expected ${count} arguments, received ${Array.isArray(value) ? value.length : 0}`);
    }
}

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

function decodeRevision(value: unknown): IDocumentRevisionInfo | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isDocumentRevisionInfo(value)) {
        throw new Error('documentRevision must be valid');
    }
    return {
        version: value.version,
        token: value.token,
        documentRef: value.documentRef,
        authority: value.authority,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

function decodeOptionalBoolean(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
}

function decodePageIdentityDelta(value: unknown): IPageIdentityDelta | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('pageIdentityDelta must be an object');
    }
    const previousPageCount = decodeSafeInteger(
        [value.previousPageCount],
        0,
        'pageIdentityDelta.previousPageCount',
    );
    const pages = value.pages === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.pages) || value.pages.length > MAX_COLLECTION_ITEMS) {
                throw new Error('pageIdentityDelta.pages must be a bounded array');
            }
            return value.pages.map((page): TPageIdentityDeltaPage => {
                if (isRecord(page) && typeof page.insertedId === 'string' && page.insertedId.length > 0) {
                    return {insertedId: page.insertedId};
                }
                if (
                    isRecord(page)
                    && typeof page.fromPageNumber === 'number'
                    && Number.isSafeInteger(page.fromPageNumber)
                    && page.fromPageNumber >= 1
                ) {
                    return {fromPageNumber: page.fromPageNumber};
                }
                throw new Error('pageIdentityDelta.pages entries must carry fromPageNumber or insertedId');
            });
        })();
    const nextPageCount = value.nextPageCount === undefined
        ? undefined
        : decodeSafeInteger(
            [value.nextPageCount],
            0,
            'pageIdentityDelta.nextPageCount',
        );
    const ranges = value.ranges === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.ranges) || value.ranges.length > MAX_COLLECTION_ITEMS) {
                throw new Error('pageIdentityDelta.ranges must be a bounded array');
            }
            return value.ranges.map((range): TPageIdentityRangeOperation => {
                if (!isRecord(range) || typeof range.kind !== 'string') {
                    throw new Error('pageIdentityDelta.ranges entries must be valid range operations');
                }
                const count = typeof range.count === 'number'
                    && Number.isSafeInteger(range.count)
                    && range.count > 0
                    ? range.count
                    : null;
                if (count === null) {
                    throw new Error('pageIdentityDelta.ranges count must be a positive safe integer');
                }
                if (range.kind === 'retain' || range.kind === 'move') {
                    if (
                        typeof range.fromPageNumber !== 'number'
                        || !Number.isSafeInteger(range.fromPageNumber)
                        || range.fromPageNumber < 1
                        || typeof range.toPageNumber !== 'number'
                        || !Number.isSafeInteger(range.toPageNumber)
                        || range.toPageNumber < 1
                    ) {
                        throw new Error('pageIdentityDelta.ranges mappings must contain positive page numbers');
                    }
                    return {
                        kind: range.kind,
                        fromPageNumber: range.fromPageNumber,
                        toPageNumber: range.toPageNumber,
                        count,
                    };
                }
                if (range.kind === 'insert') {
                    if (
                        typeof range.toPageNumber !== 'number'
                        || !Number.isSafeInteger(range.toPageNumber)
                        || range.toPageNumber < 1
                        || typeof range.identitySeed !== 'string'
                        || range.identitySeed.length === 0
                    ) {
                        throw new Error('pageIdentityDelta.ranges insert must contain a destination and identity seed');
                    }
                    let insertedIds: string[] | undefined;
                    const rawInsertedIds: unknown = range.insertedIds;
                    if (rawInsertedIds !== undefined) {
                        if (
                            !Array.isArray(rawInsertedIds)
                            || rawInsertedIds.length !== count
                            || rawInsertedIds.length > MAX_COLLECTION_ITEMS
                            || !rawInsertedIds.every(id => typeof id === 'string' && id.length > 0)
                        ) {
                            throw new Error('pageIdentityDelta.ranges insertedIds must match the range count');
                        }
                        insertedIds = rawInsertedIds.filter(
                            (id): id is string => typeof id === 'string',
                        );
                    }
                    return {
                        kind: 'insert',
                        toPageNumber: range.toPageNumber,
                        count,
                        identitySeed: range.identitySeed,
                        ...(insertedIds === undefined ? {} : {insertedIds}),
                    };
                }
                if (range.kind === 'delete') {
                    if (
                        typeof range.fromPageNumber !== 'number'
                        || !Number.isSafeInteger(range.fromPageNumber)
                        || range.fromPageNumber < 1
                    ) {
                        throw new Error('pageIdentityDelta.ranges delete must contain a positive source page');
                    }
                    return {
                        kind: 'delete',
                        fromPageNumber: range.fromPageNumber,
                        count,
                    };
                }
                if (range.kind === 'touch') {
                    const reason = PAGE_IDENTITY_TOUCH_REASONS.find(candidate => candidate === range.reason);
                    if (
                        typeof range.toPageNumber !== 'number'
                        || !Number.isSafeInteger(range.toPageNumber)
                        || range.toPageNumber < 1
                        || reason === undefined
                    ) {
                        throw new Error('pageIdentityDelta.ranges touch must contain a destination and reason');
                    }
                    return {
                        kind: 'touch',
                        toPageNumber: range.toPageNumber,
                        count,
                        reason,
                    };
                }
                throw new Error('pageIdentityDelta.ranges entries must be valid range operations');
            });
        })();
    if (pages === undefined && ranges === undefined) {
        throw new Error('pageIdentityDelta must contain pages or ranges');
    }
    return {
        previousPageCount,
        ...(pages === undefined ? {} : {pages}),
        ...(nextPageCount === undefined ? {} : {nextPageCount}),
        ...(ranges === undefined ? {} : {ranges}),
    };
}

function decodePageOpsResult(value: unknown): IPageOpsResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page operation result must include success');
    }
    const pageCount = value.pageCount === undefined
        ? undefined
        : decodeSafeInteger([value.pageCount], 0, 'pageCount');
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    const documentRevision = decodeRevision(value.documentRevision);
    const pageIdentityDelta = decodePageIdentityDelta(value.pageIdentityDelta);
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
        ...(pageIdentityDelta === undefined ? {} : {pageIdentityDelta}),
    };
}

function decodeCancelActiveResult(value: unknown): IPageOpsCancelActiveResult {
    if (!isRecord(value)) {
        throw new Error('page operation cancel result must be an object');
    }
    return {
        canceled: decodeSafeInteger([value.canceled], 0, 'canceled'),
        committing: decodeSafeInteger([value.committing], 0, 'committing'),
    };
}

function decodeExtractResult(value: unknown): IPageOpsExtractResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page extraction result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    const destPath = value.destPath === undefined
        ? undefined
        : parseDocumentRef(value.destPath);
    if (destPath === null) {
        throw new Error('destPath must be an absolute document reference');
    }
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(destPath === undefined ? {} : {destPath}),
    };
}

function decodeInsertResult(value: unknown): IPageOpsInsertResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page insertion result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    const documentRevision = decodeRevision(value.documentRevision);
    const pageIdentityDelta = decodePageIdentityDelta(value.pageIdentityDelta);
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
        ...(pageIdentityDelta === undefined ? {} : {pageIdentityDelta}),
    };
}

function decodePageGeometry(value: unknown): IPageGeometry {
    if (!isRecord(value) || !isFiniteNumber(value.rotation)) {
        throw new Error('page geometry must contain a finite rotation');
    }
    const geometry = decodeSharedPageGeometry(value);
    if (geometry === null) {
        throw new Error('page geometry box must contain finite coordinates');
    }
    return geometry;
}

const fixtureOptions = {
    expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:fixture'),
    metadataSnapshot: {
        pageLabels: ['1'],
        bookmarks: [],
        untitledBookmarkLabel: 'Untitled',
    },
} satisfies IPageOpsMutationOptions;
const pageOpsResult = s.fromParser(decodePageOpsResult, () => ({
    success: true,
    pageCount: 1,
}));
const extractResult = s.fromParser(decodeExtractResult, () => ({
    success: true,
    destPath: parseDocumentRef('/tmp/extract.pdf') ?? (() => {
        throw new Error('invalid fixture document reference');
    })(),
}));
const insertResult = s.fromParser(decodeInsertResult, () => ({success: true}));
const cancelActiveResult = s.fromParser(decodeCancelActiveResult, () => ({
    canceled: 1,
    committing: 0,
}));
const pageGeometry = s.fromParser(decodePageGeometry, () => ({
    mediaBox: {
        x: 0,
        y: 0,
        width: 612,
        height: 792,
    },
    cropBox: null,
    rotation: 0,
}));
function args<T extends unknown[]>(
    count: number,
    decode: (value: unknown[]) => T,
    example: () => T,
) {
    return s.fromParser((value: unknown) => {
        requireArgumentCount(value, count);
        return decode(value);
    }, example);
}

function method<
    const TName extends string,
    const TChannel extends string,
    TArgs extends IRuntimeSchema<unknown[]>,
    TResult extends IRuntimeSchema<unknown>,
    TMapArgs extends (...args: never[]) => TInferSchema<TArgs>,
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                fixtureOptions,
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
            }, () => [
                '/tmp/fixture.pdf',
                [{
                    startPage: 1,
                    endPage: 1,
                }],
                2,
                fixtureOptions,
            ]),
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                fixtureOptions,
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
            ], () => [
                '/tmp/fixture.pdf',
                1,
                1,
                0,
                1,
                fixtureOptions,
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
            }, () => [
                '/tmp/fixture.pdf',
                [{
                    startPage: 1,
                    endPage: 1,
                }],
                0,
                1,
                fixtureOptions,
            ]),
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
            ], () => [
                '/tmp/fixture.pdf',
                1,
                1,
                fixtureOptions,
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
            ], () => [
                '/tmp/fixture.pdf',
                1,
                1,
                ['/tmp/source.pdf'],
                parseRequestId('page-ops-fixture') ?? (() => {
                    throw new Error('invalid fixture request ID');
                })(),
                fixtureOptions,
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                90,
                fixtureOptions,
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                {
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
                },
                fixtureOptions,
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
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                fixtureOptions,
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
                args<TCancelActiveArgs>(1, value => [decodeString(value, 0, 'workingCopyPath')], () => ['/tmp/fixture.pdf']),
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
            ], () => [
                '/tmp/fixture.pdf',
                1,
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
