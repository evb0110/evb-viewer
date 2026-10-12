import {
    decodeBookmarkAction,
    decodeBookmarkOriginalDestination,
    type IPdfBookmarkAction,
    type TPdfBookmarkOriginalDestination,
} from '@contracts/pdfBookmarkEntry';
import {isRecord} from '@contracts/runtimeGuards';

export interface IBrowserPdfCatalogBookmark {
    title: string;
    pageIndex: number | null;
    pageYRatio?: number | null;
    originalDestination?: TPdfBookmarkOriginalDestination;
    originalAction?: IPdfBookmarkAction;
    namedDest: string | null;
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

export interface IBrowserPdfCatalogDecodeOptions {
    maxPageLabels: number;
    maxBookmarkItems?: number;
    maxBookmarkDepth?: number;
}

export const BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS = 100_000;
export const BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH = 256;
export const BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS = 2_048;
export const BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS = 100_000;

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeBookmark(
    value: unknown,
    depth: number,
    state: {count: number},
    options: Required<IBrowserPdfCatalogDecodeOptions>,
): IBrowserPdfCatalogBookmark | null {
    if (
        !isRecord(value)
        || depth >= options.maxBookmarkDepth
        || state.count >= options.maxBookmarkItems
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
    let originalDestination: TPdfBookmarkOriginalDestination | undefined;
    let originalAction: IPdfBookmarkAction | undefined;
    try {
        if (value.originalDestination !== undefined) originalDestination = decodeBookmarkOriginalDestination(value.originalDestination);
        if (value.originalAction !== undefined) originalAction = decodeBookmarkAction(value.originalAction);
    } catch { return null; }
    state.count += 1;
    const items: IBrowserPdfCatalogBookmark[] = [];
    for (const item of value.items) {
        const decoded = decodeBookmark(item, depth + 1, state, options);
        if (decoded === null) {
            return null;
        }
        items.push(decoded);
    }
    return {
        title: value.title,
        pageIndex: value.pageIndex,
        ...(value.pageYRatio === undefined ? {} : {pageYRatio: value.pageYRatio}),
        ...(originalDestination === undefined ? {} : {originalDestination}),
        ...(originalAction === undefined ? {} : {originalAction}),
        namedDest: value.namedDest,
        bold: value.bold,
        italic: value.italic,
        color: value.color,
        items,
    };
}

export function decodeBrowserPdfCatalog(
    value: unknown,
    options: IBrowserPdfCatalogDecodeOptions,
): IBrowserPdfCatalog | null {
    const limits: Required<IBrowserPdfCatalogDecodeOptions> = {
        maxBookmarkDepth: options.maxBookmarkDepth ?? BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH,
        maxBookmarkItems: options.maxBookmarkItems ?? BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS,
        maxPageLabels: options.maxPageLabels,
    };
    if (
        !isRecord(value)
        || !isCatalogPart(value.bookmarks, value.bookmarksError, limits.maxBookmarkItems)
        || !isCatalogPart(value.pageLabels, value.pageLabelsError, limits.maxPageLabels)
    ) {
        return null;
    }
    const state = {count: 0};
    const bookmarks: IBrowserPdfCatalogBookmark[] = [];
    for (const bookmark of Array.isArray(value.bookmarks) ? value.bookmarks : []) {
        const decoded = decodeBookmark(bookmark, 0, state, limits);
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
