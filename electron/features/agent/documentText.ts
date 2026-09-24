import type { BrowserWindow } from 'electron';
import type { ISearchMatchOptions } from '@pdf-core';
import { validateSearchQuery } from '@pdf-core';
import type { IAgentTabSnapshot } from '@contracts/agent';
import { normalizeOptionalSearchPageCount } from '@contracts/search';
import {
    ensureSearchIndex,
    pdfSearchDocument,
    readPdfPageTexts,
    resolveSearchablePdfPath,
    searchIndexedDocument,
    type ISearchIndexCoverage,
    type IPageText,
} from '@electron/features/search/public';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';

export interface IAgentDocumentSearchOptions extends ISearchMatchOptions {
    query: string;
    maxResults?: number;
    pages?: number[];
}

export interface IAgentDocumentPageReadOptions {
    pages: number[];
    maxCharsPerPage?: number;
}

export interface IAgentDocumentTextOperationInput<TOptions> {
    tab: IAgentTabSnapshot;
    options: TOptions;
}

const DEFAULT_SEARCH_RESULT_LIMIT = 25;
const MAX_SEARCH_RESULT_LIMIT = 100;
const DEFAULT_PAGE_TEXT_CHARS = 6000;
const MAX_PAGE_TEXT_CHARS = 30000;
const MAX_MISSING_PAGE_SAMPLE = 80;

function normalizePositiveInteger(value: number | null | undefined, fallback: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.trunc(value)));
}

function getTabPageCount(tab: IAgentTabSnapshot) {
    return typeof tab.totalPages === 'number' && tab.totalPages > 0
        ? normalizeOptionalSearchPageCount(tab.totalPages)
        : undefined;
}

function getAgentTabPdfPath(tab: IAgentTabSnapshot) {
    if (tab.kind !== 'pdf') {
        throw new Error(`Tab ${tab.tabId} is a ${tab.kind} document. Convert it to PDF before text search.`);
    }
    const path = tab.originalPath?.trim();
    if (!path) {
        throw new Error(`Tab ${tab.tabId} does not expose a readable PDF path.`);
    }
    return path;
}

async function resolveAgentDocument(window: BrowserWindow, tab: IAgentTabSnapshot) {
    const requestedPath = getAgentTabPdfPath(tab);
    const resolvedPdfPath = await resolveSearchablePdfPath(requestedPath, window.webContents.id);
    if (!resolvedPdfPath) {
        throw new Error('The PDF is not available to the EVB search index yet.');
    }
    const documentRevision = (await getWorkingCopyRevision(resolvedPdfPath, window.webContents.id)).token;
    return {
        requestedPath,
        resolvedPdfPath,
        document: pdfSearchDocument(resolvedPdfPath, documentRevision),
    };
}

function buildTextStatus(coverage: ISearchIndexCoverage) {
    const {pageCount} = coverage;
    const textPageCount = Math.min(pageCount, coverage.pagesWritten);
    const scanComplete = !coverage.truncated && coverage.pagesScanned >= pageCount;
    return {
        status: pageCount === 0
            ? 'unknown' as const
            : textPageCount === pageCount
                ? 'complete' as const
                : textPageCount === 0 ? 'none' as const : 'partial' as const,
        pageCount,
        textPageCount,
        missingTextPageCount: pageCount - textPageCount,
        missingTextPageSample: coverage.missingTextPageSample,
        scanComplete,
        pagesScanned: coverage.pagesScanned,
        coverage: pageCount > 0 ? textPageCount / pageCount : 0,
        coverageScope: 'document' as const,
    };
}

function createTextRecommendations(textStatus: ReturnType<typeof buildTextStatus>) {
    if (textStatus.status !== 'partial' && textStatus.status !== 'none') {
        return [];
    }
    return [{
        id: 'ocr_all_pages',
        title: 'OCR all pages',
        reason: textStatus.status === 'none'
            ? 'No searchable page text was found, so document search and page reading will be unreliable until OCR is run.'
            : 'Some pages lack searchable text; OCRing all pages gives agents consistent page text.',
        toolName: 'ocr.start',
    }];
}

export async function inspectAgentDocumentText(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<Record<never, never>>,
    signal?: AbortSignal,
) {
    const {
        requestedPath,
        resolvedPdfPath,
        document,
    } = await resolveAgentDocument(window, input.tab);
    const textStatus = buildTextStatus(await ensureSearchIndex(document, signal === undefined ? {} : {signal}));
    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        textStatus,
        recommendations: createTextRecommendations(textStatus),
    };
}

export async function searchAgentDocument(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>,
    signal?: AbortSignal,
) {
    const query = input.options.query.trim();
    if (!query) {
        throw new Error('query is required.');
    }
    const options = {
        matchCase: Boolean(input.options.matchCase),
        wholeWord: Boolean(input.options.wholeWord),
        useRegex: Boolean(input.options.useRegex),
    };
    validateSearchQuery(query, options);
    const maxResults = normalizePositiveInteger(
        input.options.maxResults,
        DEFAULT_SEARCH_RESULT_LIMIT,
        MAX_SEARCH_RESULT_LIMIT,
    );
    const pages = input.options.pages?.filter(page => Number.isSafeInteger(page) && page > 0);
    const {
        requestedPath,
        resolvedPdfPath,
        document,
    } = await resolveAgentDocument(window, input.tab);
    const response = await searchIndexedDocument(
        document,
        query,
        {
            ...options,
            ...(pages && pages.length > 0 ? {pages} : {}),
        },
        signal === undefined ? {} : {signal},
    );
    const results = response.results.slice(0, maxResults);
    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        query,
        options: {
            ...options,
            ...(pages && pages.length > 0 ? {pages} : {}),
        },
        results,
        returnedResults: results.length,
        totalAvailableResults: response.results.length,
        truncated: response.truncated || response.results.length > results.length,
        searchTruncated: response.truncated,
        toolTruncated: response.results.length > results.length,
        textStatus: buildTextStatus(response.coverage),
    };
}

function buildPageTextResponse(page: IPageText, maxCharsPerPage: number) {
    const normalizedText = page.text.replace(/\r\n?/g, '\n').trim();
    const truncated = normalizedText.length > maxCharsPerPage;
    return {
        page: page.pageNumber,
        hasText: normalizedText.length > 0,
        textLength: normalizedText.length,
        truncated,
        source: 'direct-pdftotext' as const,
        text: truncated ? normalizedText.slice(0, maxCharsPerPage) : normalizedText,
    };
}

export async function readAgentDocumentPages(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
    signal?: AbortSignal,
) {
    const {
        requestedPath,
        resolvedPdfPath,
    } = await resolveAgentDocument(window, input.tab);
    const pageCount = getTabPageCount(input.tab);
    const maxCharsPerPage = normalizePositiveInteger(
        input.options.maxCharsPerPage,
        DEFAULT_PAGE_TEXT_CHARS,
        MAX_PAGE_TEXT_CHARS,
    );
    const requestedPages = Array.from(new Set(input.options.pages.map(page => Math.trunc(page))))
        .filter(page => page >= 1 && (pageCount === undefined || page <= pageCount))
        .sort((left, right) => left - right);
    if (requestedPages.length === 0) {
        throw new Error(pageCount === undefined
            ? 'No requested pages were positive integers.'
            : `No requested pages are within the document's 1-${pageCount} page range.`);
    }
    const texts = new Map((await readPdfPageTexts(resolvedPdfPath, requestedPages, signal))
        .map(page => [
            page.pageNumber,
            page.text,
        ]));
    const pageTexts = requestedPages.map(pageNumber => ({
        pageNumber,
        text: texts.get(pageNumber) ?? '',
    }));
    const missingTextPages = pageTexts.filter(page => page.text.trim().length === 0).map(page => page.pageNumber);
    const textPageCount = pageTexts.length - missingTextPages.length;
    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        pageCount: pageCount ?? requestedPages.at(-1) ?? 0,
        source: 'direct-pdftotext' as const,
        pages: pageTexts.map(page => buildPageTextResponse(page, maxCharsPerPage)),
        textStatus: {
            status: textPageCount === pageTexts.length
                ? 'complete' as const
                : textPageCount === 0 ? 'none' as const : 'partial' as const,
            textPageCount,
            missingTextPages,
            missingTextPageSample: missingTextPages.slice(0, MAX_MISSING_PAGE_SAMPLE),
            coverage: textPageCount / pageTexts.length,
            coverageScope: 'requested-pages' as const,
            inspectedPages: requestedPages,
            recommendation: 'This is a bounded page probe. Treat it as local evidence, not full-document OCR coverage.',
        },
    };
}
