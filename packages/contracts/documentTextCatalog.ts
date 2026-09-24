import type { TPageNumber } from '@contracts/pageNumbers';
import { parsePageNumber } from '@contracts/pageNumbers';

import type { IOcrWord } from '@contracts/shared';
import { isOcrWord } from '@contracts/shared';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';

export type TDocumentTextSource = 'pdf-native' | 'foreign-ocr' | 'evb-ocr';

export interface IDocumentTextCatalogPage {
    readonly pageNumber: TPageNumber;
    readonly text: string;
    readonly source: TDocumentTextSource;
    readonly words?: readonly IOcrWord[];
    readonly generation?: string;
    readonly render?: {
        readonly dpi: number;
        readonly imagePx: {
            readonly w: number;
            readonly h: number
        };
    };
    readonly languages?: readonly string[];
    readonly contentDigest: string;
}

export interface IDocumentTextSnapshot {
    readonly documentRevision: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly pages: readonly IDocumentTextCatalogPage[];
    readonly contentDigest: string;
}

/** A bounded page window used by streaming exports. The range is at most 64 pages. */
export interface IDocumentTextCatalogWindow {
    readonly documentRevision: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly firstPage: number;
    readonly lastPage: number;
    readonly pages: readonly IDocumentTextCatalogPage[];
    readonly contentDigest: string;
}

export interface IDocumentOcrPageRange {
    readonly firstPage: number;
    readonly lastPage: number;
}

export interface IDocumentOcrAvailability {
    readonly documentRevision: TDocumentRevisionToken;
    readonly pageCount: number;
    /** Number of mapped pages, independent of how many ranges are returned. */
    readonly mappedPageCount?: number;
    /** Sorted, disjoint mapped-page ranges. */
    readonly pageRanges?: readonly IDocumentOcrPageRange[];
    /** False when the range list was capped and page probing is required. */
    readonly rangesComplete?: boolean;
    /** v3 wire compatibility. New producers must return pageRanges instead. */
    readonly pageNumbers?: readonly TPageNumber[];
}

export interface IDocumentOcrPageSnapshot {
    readonly documentRevision: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly page: IDocumentTextCatalogPage | null;
}

export const MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS = 100_000;
export const MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH = 16 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH = 8 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES = 64;
export const MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH = 64 * 1024 * 1024;
export const MAX_DOCUMENT_OCR_AVAILABILITY_RANGES = 4_096;

const DOCUMENT_TEXT_SOURCES = [
    'pdf-native',
    'foreign-ocr',
    'evb-ocr',
] as const satisfies readonly TDocumentTextSource[];

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function decodeDocumentTextCatalogPage(
    candidate: unknown,
    pageCount: number,
    pageNumbers?: Set<TPageNumber>,
): IDocumentTextCatalogPage | null {
    if (!isRecord(candidate)) {
        return null;
    }
    const pageNumber = typeof candidate.pageNumber === 'number'
        ? parsePageNumber(candidate.pageNumber, pageCount)
        : null;
    if (
        pageNumber === null
        || pageNumbers?.has(pageNumber) === true
        || typeof candidate.text !== 'string'
        || candidate.text.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH
        || !isOneOf(DOCUMENT_TEXT_SOURCES, candidate.source)
        || typeof candidate.contentDigest !== 'string'
        || (candidate.generation !== undefined && typeof candidate.generation !== 'string')
        || (candidate.words !== undefined && (
            !Array.isArray(candidate.words)
            || candidate.words.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS
            || !candidate.words.every(isOcrWord)
        ))
        || (candidate.languages !== undefined && (
            !isStringArray(candidate.languages)
            || candidate.languages.some(language => language.length === 0)
        ))
    ) {
        return null;
    }
    let render: IDocumentTextCatalogPage['render'];
    if (candidate.render !== undefined) {
        if (
            !isRecord(candidate.render)
            || !isPositiveFinite(candidate.render.dpi)
            || !isRecord(candidate.render.imagePx)
            || !isPositiveFinite(candidate.render.imagePx.w)
            || !isPositiveFinite(candidate.render.imagePx.h)
        ) {
            return null;
        }
        render = {
            dpi: candidate.render.dpi,
            imagePx: {
                w: candidate.render.imagePx.w,
                h: candidate.render.imagePx.h,
            },
        };
    }
    pageNumbers?.add(pageNumber);
    return {
        pageNumber,
        text: candidate.text,
        source: candidate.source,
        contentDigest: candidate.contentDigest,
        ...(candidate.words === undefined ? {} : {words: candidate.words}),
        ...(candidate.generation === undefined ? {} : {generation: candidate.generation}),
        ...(candidate.languages === undefined ? {} : {languages: [...candidate.languages]}),
        ...(render === undefined ? {} : {render}),
    };
}

export function decodeDocumentTextSnapshot(value: unknown): IDocumentTextSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || !Number.isSafeInteger(value.pageCount)
        || typeof value.pageCount !== 'number'
        || value.pageCount < 0
        || !Array.isArray(value.pages)
        || typeof value.contentDigest !== 'string'
    ) {
        return null;
    }

    const pages: IDocumentTextCatalogPage[] = [];
    const pageNumbers = new Set<TPageNumber>();
    let totalTextLength = 0;
    for (const candidate of value.pages) {
        const page = decodeDocumentTextCatalogPage(candidate, value.pageCount, pageNumbers);
        if (!page) {
            return null;
        }
        totalTextLength += page.text.length;
        if (totalTextLength > MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH) {
            return null;
        }
        pages.push(page);
    }

    return {
        documentRevision,
        pageCount: value.pageCount,
        pages,
        contentDigest: value.contentDigest,
    };
}

export function decodeDocumentTextCatalogWindow(value: unknown): IDocumentTextCatalogWindow | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || typeof value.firstPage !== 'number'
        || !Number.isSafeInteger(value.firstPage)
        || value.firstPage < 1
        || typeof value.lastPage !== 'number'
        || !Number.isSafeInteger(value.lastPage)
        || value.lastPage < value.firstPage
        || value.lastPage > value.pageCount
        || value.lastPage - value.firstPage + 1 > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES
        || !Array.isArray(value.pages)
        || typeof value.contentDigest !== 'string'
    ) {
        return null;
    }

    const pages: IDocumentTextCatalogPage[] = [];
    const pageNumbers = new Set<TPageNumber>();
    let totalTextLength = 0;
    for (const candidate of value.pages) {
        const page = decodeDocumentTextCatalogPage(candidate, value.pageCount, pageNumbers);
        if (!page || page.pageNumber < value.firstPage || page.pageNumber > value.lastPage) {
            return null;
        }
        totalTextLength += page.text.length;
        if (totalTextLength > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH) {
            return null;
        }
        pages.push(page);
    }

    return {
        documentRevision,
        pageCount: value.pageCount,
        firstPage: value.firstPage,
        lastPage: value.lastPage,
        pages,
        contentDigest: value.contentDigest,
    };
}

export function decodeDocumentOcrAvailability(value: unknown): IDocumentOcrAvailability | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
    ) {
        return null;
    }

    /* Keep the old v3 payload shape intact for older callers. */
    if (value.pageRanges === undefined && value.mappedPageCount === undefined && value.rangesComplete === undefined) {
        if (!Array.isArray(value.pageNumbers) || value.pageNumbers.length > value.pageCount) {
            return null;
        }
        const pageNumbers = new Set<TPageNumber>();
        for (const pageNumber of value.pageNumbers) {
            const parsedPageNumber = typeof pageNumber === 'number'
                ? parsePageNumber(pageNumber, value.pageCount)
                : null;
            if (parsedPageNumber === null || pageNumbers.has(parsedPageNumber)) {
                return null;
            }
            pageNumbers.add(parsedPageNumber);
        }
        return {
            documentRevision,
            pageCount: value.pageCount,
            pageNumbers: Array.from(pageNumbers),
        };
    }

    if (
        typeof value.mappedPageCount !== 'number'
        || !Number.isSafeInteger(value.mappedPageCount)
        || value.mappedPageCount < 0
        || value.mappedPageCount > value.pageCount
        || !Array.isArray(value.pageRanges)
        || value.pageRanges.length > MAX_DOCUMENT_OCR_AVAILABILITY_RANGES
        || (value.rangesComplete !== undefined && typeof value.rangesComplete !== 'boolean')
    ) {
        return null;
    }
    const rangesComplete = value.rangesComplete ?? true;
    const pageRanges: IDocumentOcrPageRange[] = [];
    let coveredPageCount = 0;
    let previousLastPage = 0;
    for (const candidate of value.pageRanges) {
        if (
            !isRecord(candidate)
            || typeof candidate.firstPage !== 'number'
            || !Number.isSafeInteger(candidate.firstPage)
            || candidate.firstPage < 1
            || candidate.firstPage > value.pageCount
            || typeof candidate.lastPage !== 'number'
            || !Number.isSafeInteger(candidate.lastPage)
            || candidate.lastPage < candidate.firstPage
            || candidate.lastPage > value.pageCount
            || candidate.firstPage <= previousLastPage
        ) {
            return null;
        }
        coveredPageCount += candidate.lastPage - candidate.firstPage + 1;
        if (coveredPageCount > value.mappedPageCount) {
            return null;
        }
        pageRanges.push({
            firstPage: candidate.firstPage,
            lastPage: candidate.lastPage,
        });
        previousLastPage = candidate.lastPage;
    }
    if (rangesComplete && coveredPageCount !== value.mappedPageCount) {
        return null;
    }
    return {
        documentRevision,
        pageCount: value.pageCount,
        mappedPageCount: value.mappedPageCount,
        pageRanges,
        rangesComplete,
    };
}

export function decodeDocumentOcrPageSnapshot(value: unknown): IDocumentOcrPageSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || (value.page !== null && value.page === undefined)
    ) {
        return null;
    }
    const page = value.page === null
        ? null
        : decodeDocumentTextCatalogPage(value.page, value.pageCount);
    if (value.page !== null && (page === null || page.source !== 'evb-ocr')) {
        return null;
    }
    return {
        documentRevision,
        pageCount: value.pageCount,
        page,
    };
}
