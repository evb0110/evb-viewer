import * as v from 'valibot';
import {
    parsePageIndex, type TPageIndex,
} from '@contracts/pageNumbers';

const destinationCoordinateCounts = {
    XYZ: 3,
    Fit: 0,
    FitH: 1,
    FitV: 1,
    FitR: 4,
    FitB: 0,
    FitBH: 1,
    FitBV: 1,
} as const;
const sourcePageIndexSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(4_294_967_295));
const sourcePageRefSchema = v.strictObject({
    num: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(4_294_967_295)),
    gen: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_535)),
});

/** The source destination survives passive resolution and unrelated edits. */
export const PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA = v.pipe(v.strictObject({
    kind: v.picklist([
        'XYZ',
        'Fit',
        'FitH',
        'FitV',
        'FitR',
        'FitB',
        'FitBH',
        'FitBV',
    ]),
    sourceTarget: v.union([
        sourcePageIndexSchema,
        sourcePageRefSchema,
    ]),
    coordinates: v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 4, 'bookmark destination must have at most four coordinates'),
        v.array(v.nullable(v.pipe(v.number(), v.finite(), v.check(value => Number.isFinite(Math.fround(value))))))),
}), v.check(value => value.coordinates.length === destinationCoordinateCounts[value.kind], 'bookmark destination coordinate count must match its kind'));
export type TPdfBookmarkOriginalDestination = v.InferOutput<typeof PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA>;

export function decodeBookmarkOriginalDestination(value: unknown) {
    return v.parse(PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA, value);
}

export interface IPdfBookmarkEntry {
    readonly title: string;
    readonly pageIndex: TPageIndex | null;
    readonly pageYRatio?: number | null;
    readonly originalDestination?: TPdfBookmarkOriginalDestination;
    readonly namedDest: string | null;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly color: string | null;
    readonly items: readonly IPdfBookmarkEntry[];
}

export const PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA: v.GenericSchema<unknown, IPdfBookmarkEntry> = v.lazy(() => v.object({
    title: v.string(),
    pageIndex: v.nullable(v.pipe(v.number(), v.check(value => parsePageIndex(value) !== null), v.transform(value => parsePageIndex(value)!))),
    pageYRatio: v.exactOptional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)))),
    originalDestination: v.exactOptional(PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA),
    namedDest: v.nullable(v.string()),
    bold: v.boolean(),
    italic: v.boolean(),
    color: v.nullable(v.string()),
    items: v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA),
}));
