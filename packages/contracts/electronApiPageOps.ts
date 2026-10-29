import {decodeBookmarkSourceIntent} from '@contracts/pdfBookmarkEntry';
import {
    isFiniteNumber,isRecord,
} from '@contracts/runtimeGuards';
import {parseDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import type {
    IPageMoveRangeSegment, TPageNumber,
} from '@contracts/pageNumbers';
import {
    requirePageIndex, requirePageNumber,
} from '@contracts/pageNumbers';
import {parseEpochMs} from '@contracts/timestamps';
import * as v from 'valibot';

const MAX_COLLECTION_ITEMS = 100_000;

function safeInteger(min: number, message: string) {
    return v.pipe(
        v.number(message),
        v.safeInteger(message),
        v.minValue(min, message),
    );
}

const positivePageNumberSchema = safeInteger(1, 'page number must be a positive safe integer');
const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'destPath must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value)!),
);
const revisionTokenSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'document revision token must be valid'),
    v.transform(value => parseDocumentRevisionToken(value)!),
);
const revisionDocumentRefSchema = v.pipe(
    documentRefSchema,
    v.check(value => value.length <= 32_768, 'documentRevision.documentRef exceeds maximum length (32768)'),
);
const revisionInfoSchema = v.object({
    version: v.literal(1),
    token: revisionTokenSchema,
    documentRef: revisionDocumentRefSchema,
    authority: v.picklist([
        'electron-working-copy',
        'browser-document-store',
    ]),
    contentRevision: safeInteger(0, 'documentRevision.contentRevision must be a non-negative safe integer'),
    mintedAt: v.pipe(
        safeInteger(1, 'documentRevision.mintedAt must be a positive safe integer timestamp'),
        v.transform(value => parseEpochMs(value)!),
    ),
});
const identityDeltaPageSchema = v.union([
    v.object({insertedId: v.pipe(v.string(), v.minLength(1))}),
    v.object({fromPageNumber: positivePageNumberSchema}),
], 'pageIdentityDelta.pages entries must carry fromPageNumber or insertedId');
const pageIdentityRangeSchema = v.variant('kind', [
    v.object({
        kind: v.literal('retain'),
        fromPageNumber: positivePageNumberSchema,
        toPageNumber: positivePageNumberSchema,
        count: safeInteger(1, 'pageIdentityDelta.ranges count must be a positive safe integer'),
    }),
    v.object({
        kind: v.literal('move'),
        fromPageNumber: positivePageNumberSchema,
        toPageNumber: positivePageNumberSchema,
        count: safeInteger(1, 'pageIdentityDelta.ranges count must be a positive safe integer'),
    }),
    v.object({
        kind: v.literal('insert'),
        toPageNumber: positivePageNumberSchema,
        count: safeInteger(1, 'pageIdentityDelta.ranges count must be a positive safe integer'),
        identitySeed: v.pipe(v.string(), v.minLength(1)),
        insertedIds: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
    }),
    v.object({
        kind: v.literal('delete'),
        fromPageNumber: positivePageNumberSchema,
        count: safeInteger(1, 'pageIdentityDelta.ranges count must be a positive safe integer'),
    }),
    v.object({
        kind: v.literal('touch'),
        toPageNumber: positivePageNumberSchema,
        count: safeInteger(1, 'pageIdentityDelta.ranges count must be a positive safe integer'),
        reason: v.picklist([
            'rotate',
            'crop',
            'remove-crop',
        ]),
    }),
]);
const identityDeltaLimits = v.check(value => {
    if (!isRecord(value)) return true;
    return (!Array.isArray(value.pages) || value.pages.length <= MAX_COLLECTION_ITEMS)
        && (!Array.isArray(value.ranges) || value.ranges.length <= MAX_COLLECTION_ITEMS)
        && (!Array.isArray(value.ranges) || value.ranges.every(range => (
            !isRecord(range)
            || !Array.isArray(range.insertedIds)
            || range.insertedIds.length <= MAX_COLLECTION_ITEMS
        )));
}, 'pageIdentityDelta exceeds the item limit');

export const PAGE_IDENTITY_DELTA_SCHEMA = v.pipe(
    v.unknown(),
    identityDeltaLimits,
    v.object({
        previousPageCount: safeInteger(0, 'pageIdentityDelta.previousPageCount must be a non-negative safe integer'),
        pages: v.optional(v.pipe(v.array(identityDeltaPageSchema), v.maxLength(MAX_COLLECTION_ITEMS))),
        nextPageCount: v.optional(safeInteger(0, 'pageIdentityDelta.nextPageCount must be a non-negative safe integer')),
        ranges: v.optional(v.pipe(v.array(pageIdentityRangeSchema), v.maxLength(MAX_COLLECTION_ITEMS))),
    }),
    v.check(delta => delta.pages !== undefined || delta.ranges !== undefined,
        'pageIdentityDelta must contain pages or ranges'),
    v.check(delta => delta.ranges === undefined || delta.ranges.every(range => (
        range.kind !== 'insert'
        || range.insertedIds === undefined
        || range.insertedIds.length === range.count
    )), 'pageIdentityDelta.ranges insertedIds must match the range count'),
);

export const PAGE_OPS_RESULT_SCHEMA = v.object({
    success: v.boolean('page operation result must include success'),
    canceled: v.optional(v.boolean()),
    pageCount: v.optional(safeInteger(0, 'pageCount must be a safe integer >= 0')),
    documentRevision: v.optional(revisionInfoSchema),
    pageIdentityDelta: v.optional(PAGE_IDENTITY_DELTA_SCHEMA),
});
export const PAGE_OPS_CANCEL_ACTIVE_RESULT_SCHEMA = v.object({
    canceled: safeInteger(0, 'canceled must be a safe integer >= 0'),
    committing: safeInteger(0, 'committing must be a safe integer >= 0'),
});
export const PAGE_OPS_EXTRACT_RESULT_SCHEMA = v.object({
    success: v.boolean('page extraction result must include success'),
    canceled: v.optional(v.boolean()),
    destPath: v.optional(documentRefSchema),
});
export const PAGE_OPS_INSERT_RESULT_SCHEMA = v.object({
    success: v.boolean('page insertion result must include success'),
    canceled: v.optional(v.boolean()),
    documentRevision: v.optional(revisionInfoSchema),
    pageIdentityDelta: v.optional(PAGE_IDENTITY_DELTA_SCHEMA),
});

const PAGE_OPS_ROTATION_ANGLES = [
    90,
    180,
    270,
] as const;
export const PAGE_OPS_ROTATION_ANGLE_SCHEMA = v.picklist(PAGE_OPS_ROTATION_ANGLES);
export type TPageOpsRotationAngle = v.InferOutput<typeof PAGE_OPS_ROTATION_ANGLE_SCHEMA>;

export interface IPageOpsCompactSelection {
    pageCount: number;
    ranges: IPageMoveRangeSegment[];
}

export type TPageOpsPageSelection = number[] | IPageOpsCompactSelection;

export interface IPageOpsMetadataSnapshot {
    /** Omitted until the viewer has read the document's page labels. */
    readonly pageLabels?: readonly string[] | null;
    /** Compact page-label source of truth, including when pageLabels is null. */
    readonly pageLabelRanges?: readonly IPdfPageLabelRange[];
    /** Omitted until the viewer has read the document's outline tree. */
    readonly bookmarks?: readonly IPdfBookmarkEntry[];
    readonly untitledBookmarkLabel: string;
}

export interface IPageOpsMutationOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
}

export type TPageIdentityDeltaPage = v.InferOutput<typeof identityDeltaPageSchema>;
export type TPageIdentityRangeOperation = v.InferOutput<typeof pageIdentityRangeSchema>;
export type IPageIdentityRangeMapping = Extract<TPageIdentityRangeOperation, {kind: 'retain' | 'move'}>;
export type IPageIdentityRangeInsert = Extract<TPageIdentityRangeOperation, {kind: 'insert'}>;
export type IPageIdentityRangeDelete = Extract<TPageIdentityRangeOperation, {kind: 'delete'}>;
export type IPageIdentityRangeTouch = Extract<TPageIdentityRangeOperation, {kind: 'touch'}>;
export type IPageIdentityDelta = v.InferOutput<typeof PAGE_IDENTITY_DELTA_SCHEMA>;
export type IPageOpsResult = v.InferOutput<typeof PAGE_OPS_RESULT_SCHEMA>;
export type IPageOpsCancelActiveResult = v.InferOutput<typeof PAGE_OPS_CANCEL_ACTIVE_RESULT_SCHEMA>;
export type IPageOpsExtractResult = v.InferOutput<typeof PAGE_OPS_EXTRACT_RESULT_SCHEMA>;
export type IPageOpsInsertResult = v.InferOutput<typeof PAGE_OPS_INSERT_RESULT_SCHEMA>;

export function getPageIdentityDeltaNextPageCount(delta: IPageIdentityDelta) {
    return delta.nextPageCount ?? delta.pages?.length;
}

export function mapPageNumberThroughPageIdentityDelta(
    delta: IPageIdentityDelta,
    pageNumber: TPageNumber,
) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return null;
    }
    if (delta.pages !== undefined) {
        const nextPageIndex = delta.pages.findIndex(page => (
            'fromPageNumber' in page && page.fromPageNumber === pageNumber
        ));
        return nextPageIndex < 0 ? null : requirePageNumber(nextPageIndex + 1);
    }
    for (const range of delta.ranges ?? []) {
        if (
            (range.kind === 'retain' || range.kind === 'move')
            && pageNumber >= range.fromPageNumber
            && pageNumber < range.fromPageNumber + range.count
        ) {
            return requirePageNumber(range.toPageNumber + pageNumber - range.fromPageNumber);
        }
    }
    return null;
}

/**
 * Maps pages through `delta` after resolving it once: an index of its pages,
 * or its retain and move ranges sorted for binary search. Mapping each of
 * thousands of bookmarks page by page through a fragmented delta was
 * quadratic. Overlapping source ranges, which no page operation produces,
 * keep the first match by scanning as the single-page mapping does.
 */
export function createPageIdentityDeltaPageMapper(
    delta: IPageIdentityDelta,
): (pageNumber: TPageNumber) => TPageNumber | null {
    const isPageNumber = (pageNumber: number) => Number.isSafeInteger(pageNumber) && pageNumber >= 1;
    if (delta.pages !== undefined) {
        const nextPageNumbers = new Map<number, number>();
        delta.pages.forEach((page, index) => {
            if ('fromPageNumber' in page && !nextPageNumbers.has(page.fromPageNumber)) {
                nextPageNumbers.set(page.fromPageNumber, index + 1);
            }
        });
        return (pageNumber) => {
            const nextPageNumber = isPageNumber(pageNumber) ? nextPageNumbers.get(pageNumber) : undefined;
            return nextPageNumber === undefined ? null : requirePageNumber(nextPageNumber);
        };
    }
    const mappings = (delta.ranges ?? [])
        .filter((range): range is IPageIdentityRangeMapping => range.kind === 'retain' || range.kind === 'move')
        .sort((left, right) => left.fromPageNumber - right.fromPageNumber);
    const overlapping = mappings.some((range, index) => {
        const previous = mappings[index - 1];
        return previous !== undefined && range.fromPageNumber < previous.fromPageNumber + previous.count;
    });
    if (overlapping) {
        return pageNumber => mapPageNumberThroughPageIdentityDelta(delta, pageNumber);
    }
    return (pageNumber) => {
        if (!isPageNumber(pageNumber)) {
            return null;
        }
        let low = 0;
        let high = mappings.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if ((mappings[middle]?.fromPageNumber ?? Infinity) <= pageNumber) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const range = mappings[low - 1];
        return range && pageNumber < range.fromPageNumber + range.count
            ? requirePageNumber(range.toPageNumber + pageNumber - range.fromPageNumber)
            : null;
    };
}

const PAGE_LABEL_STYLES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;

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
        if (pageYRatio !== undefined && pageYRatio !== null
            && (!isFiniteNumber(pageYRatio) || pageYRatio < 0 || pageYRatio > 1)) {
            throw new Error('bookmark.pageYRatio must be a finite number from 0 to 1 or null');
        }
        return {
            title: raw.title,
            pageIndex: pageIndex === null ? null : requirePageIndex(pageIndex),
            ...(pageYRatio === undefined ? {} : {pageYRatio}),
            ...decodeBookmarkSourceIntent(raw),
            namedDest: raw.namedDest,
            bold: raw.bold,
            italic: raw.italic,
            color: raw.color,
            items: decodeBookmarkEntries(raw.items, depth + 1, counter),
        };
    });
}

export function decodeMetadataSnapshot(value: unknown): IPageOpsMetadataSnapshot {
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
