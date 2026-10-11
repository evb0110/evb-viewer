import * as v from 'valibot';
import {
    parsePageIndex, type TPageIndex,
} from '@contracts/pageNumbers';

export interface IPdfBookmarkEntry {
    readonly title: string;
    readonly pageIndex: TPageIndex | null;
    readonly pageYRatio?: number | null;
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
    namedDest: v.nullable(v.string()),
    bold: v.boolean(),
    italic: v.boolean(),
    color: v.nullable(v.string()),
    items: v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA),
}));
