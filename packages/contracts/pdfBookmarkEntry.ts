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
export const PDF_BOOKMARK_SOURCE_REFERENCE_SCHEMA = v.strictObject({
    num: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(4_294_967_295)),
    gen: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_535)),
});

/** The source destination survives passive resolution and unrelated edits. */
export const PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA = v.pipe(v.strictObject({
    kind: v.picklist(Object.keys(destinationCoordinateCounts) as Array<keyof typeof destinationCoordinateCounts>),
    sourceTarget: v.union([
        sourcePageIndexSchema,
        PDF_BOOKMARK_SOURCE_REFERENCE_SCHEMA,
    ]),
    coordinates: v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 4, 'bookmark destination must have at most four coordinates'),
        v.array(v.nullable(v.pipe(v.number(), v.finite(), v.check(value => Number.isFinite(Math.fround(value))))))),
}), v.check(value => value.coordinates.length === destinationCoordinateCounts[value.kind], 'bookmark destination coordinate count must match its kind'));
export type TPdfBookmarkOriginalDestination = v.InferOutput<typeof PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA>;

/**
 * An outline item's own action other than GoTo (GoToR, Launch, URI, ...), as
 * the native catalog reader keeps it: without object references, dictionary
 * keys in order, and string bytes with their literal or hex form, so Save
 * writes an untouched action back unchanged. Matches evb-native-support's
 * BookmarkActionValue.
 */
// The renderer passes the action through untouched, so nested values stay
// `unknown` here: a recursive type would send Vue's deep ref unwrapping into
// unbounded instantiation. The schema below validates the whole value.
export type TPdfBookmarkActionValue =
    | null
    | boolean
    | number
    | {readonly real: number}
    | {readonly name: string}
    | {readonly literal: readonly number[]}
    | {readonly hex: readonly number[]}
    | {readonly dict: ReadonlyArray<readonly [string, unknown]>}
    | readonly unknown[];
export interface IPdfBookmarkAction {readonly dict: ReadonlyArray<readonly [string, TPdfBookmarkActionValue]>}

// The native reader keeps an action of at most 16,384 values and string bytes,
// nested at most 16 levels. This JSON walk counts every wrapper too, so its
// ceilings are a few times larger: what the reader keeps always decodes, and
// a deep or huge value is refused before the recursive schema sees it.
const BOOKMARK_ACTION_MAX_SIZE = 65_536;
const BOOKMARK_ACTION_MAX_DEPTH = 64;

function isWithinBookmarkActionCeilings(value: unknown) {
    let size = 0;
    const pending: Array<[unknown, number]> = [[
        value,
        0,
    ]];
    for (let entry = pending.pop(); entry; entry = pending.pop()) {
        const [
            current,
            depth,
        ] = entry;
        size += 1 + (typeof current === 'string' ? current.length : 0);
        if (size > BOOKMARK_ACTION_MAX_SIZE || depth > BOOKMARK_ACTION_MAX_DEPTH) return false;
        if (Array.isArray(current)) for (const item of current) pending.push([
            item,
            depth + 1,
        ]);
        else if (typeof current === 'object' && current !== null) for (const item of Object.values(current)) pending.push([
            item,
            depth,
        ]);
    }
    return true;
}

const bookmarkActionBytesSchema = v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)));
const BOOKMARK_ACTION_DICT_SCHEMA: v.GenericSchema<unknown, IPdfBookmarkAction> = v.lazy(() => v.strictObject({dict: v.array(v.strictTuple([
    v.string(),
    BOOKMARK_ACTION_VALUE_SCHEMA,
]))}));
const BOOKMARK_ACTION_VALUE_SCHEMA: v.GenericSchema<unknown, TPdfBookmarkActionValue> = v.lazy(() => v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.safeInteger()),
    v.strictObject({real: v.pipe(v.number(), v.check(value => Number.isFinite(Math.fround(value))))}),
    v.strictObject({name: v.string()}),
    v.strictObject({literal: bookmarkActionBytesSchema}),
    v.strictObject({hex: bookmarkActionBytesSchema}),
    BOOKMARK_ACTION_DICT_SCHEMA,
    v.array(BOOKMARK_ACTION_VALUE_SCHEMA),
]));
export const PDF_BOOKMARK_ACTION_SCHEMA = v.pipe(
    v.unknown(),
    v.check(isWithinBookmarkActionCeilings, 'bookmark action exceeds its size or nesting ceiling'),
    BOOKMARK_ACTION_DICT_SCHEMA,
);

const BOOKMARK_SOURCE_INTENT_SCHEMA = v.object({
    originalDestination: v.exactOptional(PDF_BOOKMARK_ORIGINAL_DESTINATION_SCHEMA),
    originalAction: v.exactOptional(PDF_BOOKMARK_ACTION_SCHEMA),
    originalNamedDest: v.exactOptional(v.pipe(v.unknown(), v.check(isWithinBookmarkActionCeilings, 'bookmark name exceeds its size ceiling'), BOOKMARK_ACTION_VALUE_SCHEMA)),
});
export const decodeBookmarkSourceIntent = (value: Record<string, unknown>) => v.parse(BOOKMARK_SOURCE_INTENT_SCHEMA, value);

export interface IPdfBookmarkEntry {
    readonly title: string;
    readonly pageIndex: TPageIndex | null;
    readonly pageYRatio?: number | null;
    readonly originalDestination?: TPdfBookmarkOriginalDestination;
    /** Written only when the entry has no destination of its own. */
    readonly originalAction?: IPdfBookmarkAction;
    readonly namedDest: string | null;
    /** The name's source form, kept only when Save would write the name differently. */
    readonly originalNamedDest?: TPdfBookmarkActionValue;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly color: string | null;
    readonly items: readonly IPdfBookmarkEntry[];
}

export const PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA: v.GenericSchema<unknown, IPdfBookmarkEntry> = v.lazy(() => v.object({
    title: v.string(),
    pageIndex: v.nullable(v.pipe(v.number(), v.check(value => parsePageIndex(value) !== null), v.transform(value => parsePageIndex(value)!))),
    pageYRatio: v.exactOptional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)))),
    ...BOOKMARK_SOURCE_INTENT_SCHEMA.entries,
    namedDest: v.nullable(v.string()),
    bold: v.boolean(),
    italic: v.boolean(),
    color: v.nullable(v.string()),
    items: v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA),
}));
