import {
    decodeBookmarkSourceIntent,
    type IPdfBookmarkAction,
    type TPdfBookmarkActionValue,
    type TPdfBookmarkOriginalDestination,
} from '@contracts/pdfBookmarkEntry';
import {isRecord} from '@contracts/runtimeGuards';
import {MAX_CATALOG_ENTRIES} from '@contracts/browserPageOpsWasm.generated';

export interface IBrowserPdfCatalogBookmark {
    title: string;
    pageIndex: number | null;
    pageYRatio?: number | null;
    originalDestination?: TPdfBookmarkOriginalDestination;
    originalAction?: IPdfBookmarkAction;
    namedDest: string | null;
    originalNamedDest?: TPdfBookmarkActionValue;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IBrowserPdfCatalogBookmark[];
}

export interface IBrowserPdfCatalogPageLabelRange {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

/**
 * The outline and the page labels are read on their own: a part that could
 * not be read carries its reason instead, and fails only the reader that asks
 * for it.
 */
export interface IBrowserPdfCatalog {
    bookmarks?: IBrowserPdfCatalogBookmark[];
    bookmarksError?: string;
    pageLabels?: IBrowserPdfCatalogPageLabelRange[];
    pageLabelsError?: string;
}

export function readBrowserPdfCatalogPart<K extends 'bookmarks' | 'pageLabels'>(
    catalog: IBrowserPdfCatalog,
    part: K,
): NonNullable<IBrowserPdfCatalog[K]> {
    const value = catalog[part];
    if (value === undefined) {
        throw new Error(catalog[`${part}Error`] ?? `PDF ${part} could not be read`);
    }
    return value;
}

function isCatalogPart(part: unknown, error: unknown, maxItems: number) {
    return Array.isArray(part)
        ? part.length <= maxItems && error === undefined
        : part === undefined && typeof error === 'string';
}

// The native catalog reader returns at most this many bookmarks or label
// ranges (catalog.rs), on desktop and in the browser alike.
export const BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS = MAX_CATALOG_ENTRIES;
export const BROWSER_PDF_CATALOG_MAX_PAGE_LABELS = MAX_CATALOG_ENTRIES;
export const BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH = 256;

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeBookmark(
    value: unknown,
    depth: number,
    state: {count: number},
): IBrowserPdfCatalogBookmark | null {
    if (
        !isRecord(value)
        || depth >= BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH
        || state.count >= BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS
        || typeof value.title !== 'string'
        || (value.pageIndex !== null && !isNonNegativeInteger(value.pageIndex))
        || (value.namedDest !== null && typeof value.namedDest !== 'string')
        || typeof value.bold !== 'boolean'
        || typeof value.italic !== 'boolean'
        || (value.color !== null && typeof value.color !== 'string')
        || (value.pageYRatio !== undefined && value.pageYRatio !== null
            && (typeof value.pageYRatio !== 'number' || !Number.isFinite(value.pageYRatio)))
        || !Array.isArray(value.items)
    ) {
        return null;
    }
    let sourceIntent: ReturnType<typeof decodeBookmarkSourceIntent>;
    try {
        sourceIntent = decodeBookmarkSourceIntent(value);
    } catch { return null; }
    state.count += 1;
    const items: IBrowserPdfCatalogBookmark[] = [];
    for (const item of value.items) {
        const decoded = decodeBookmark(item, depth + 1, state);
        if (decoded === null) {
            return null;
        }
        items.push(decoded);
    }
    return {
        title: value.title,
        pageIndex: value.pageIndex,
        ...(value.pageYRatio === undefined ? {} : {pageYRatio: value.pageYRatio}),
        ...sourceIntent,
        namedDest: value.namedDest,
        bold: value.bold,
        italic: value.italic,
        color: value.color,
        items,
    };
}

export function decodeBrowserPdfCatalog(value: unknown): IBrowserPdfCatalog | null {
    if (
        !isRecord(value)
        || !isCatalogPart(value.bookmarks, value.bookmarksError, BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS)
        || !isCatalogPart(value.pageLabels, value.pageLabelsError, BROWSER_PDF_CATALOG_MAX_PAGE_LABELS)
    ) {
        return null;
    }
    const state = {count: 0};
    const bookmarks: IBrowserPdfCatalogBookmark[] = [];
    for (const bookmark of Array.isArray(value.bookmarks) ? value.bookmarks : []) {
        const decoded = decodeBookmark(bookmark, 0, state);
        if (decoded === null) {
            return null;
        }
        bookmarks.push(decoded);
    }
    const pageLabels: IBrowserPdfCatalogPageLabelRange[] = [];
    for (const range of Array.isArray(value.pageLabels) ? value.pageLabels : []) {
        if (
            !isRecord(range)
            || !isNonNegativeInteger(range.pageIndex)
            || (range.style !== undefined && typeof range.style !== 'string')
            || (range.prefix !== undefined && typeof range.prefix !== 'string')
            || (range.start !== undefined && !isNonNegativeInteger(range.start))
        ) {
            return null;
        }
        pageLabels.push({
            pageIndex: range.pageIndex,
            ...(range.style === undefined ? {} : {style: range.style}),
            ...(range.prefix === undefined ? {} : {prefix: range.prefix}),
            ...(range.start === undefined ? {} : {start: range.start}),
        });
    }
    return {
        ...(typeof value.bookmarksError === 'string' ? {bookmarksError: value.bookmarksError} : {bookmarks}),
        ...(typeof value.pageLabelsError === 'string' ? {pageLabelsError: value.pageLabelsError} : {pageLabels}),
    };
}
