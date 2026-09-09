import { getErrorMessage } from '@electron/utils/error';
import type {
    BrowserWindow,
    IpcMainInvokeEvent,
} from 'electron';
import {stat} from 'node:fs/promises';
import type { IPdfSearchResponse } from '@contracts/search';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type { ISearchMatchOptions } from '@pdf-core';
import type { IAgentTabSnapshot } from '@contracts/agent';
import {createRequestId} from '@contracts/shared';
import { requirePageNumber } from '@contracts/pageNumbers';
import { createLogger } from '@electron/utils/createLogger';
import {
    buildExcerpt,
    classifyXlargeSearchPath,
    extractTextFromPdf,
    iteratePageMatches,
    loadCompactSearchIndex,
    loadPdfjsTextExtractor,
    loadSearchIndex,
    parseOptionalSearchPageCount,
    resolveSearchablePdfPath,
    resolveSearchWorkerPath,
    SearchWorkerService,
    validateSearchQuery,
} from '@electron/features/search/public';
import type {
    ICompactSearchIndex,
    IPageText,
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

const logger = createLogger('agent-document-text');
const agentSearchWorkerService = new SearchWorkerService(
    resolveSearchWorkerPath,
    SearchWorkerService.resolveCurrentHostResourcePolicy,
);
const DEFAULT_SEARCH_RESULT_LIMIT = 25;
const MAX_SEARCH_RESULT_LIMIT = 100;
const DEFAULT_PAGE_TEXT_CHARS = 6000;
const MAX_PAGE_TEXT_CHARS = 30000;
const MAX_MISSING_PAGE_SAMPLE = 80;

type TAgentPageTextSource =
    | 'search-index'
    | 'direct-pdfjs'
    | 'direct-pdftotext';

type TAgentTextStatus =
    | ReturnType<typeof buildTextStatus>
    | ReturnType<typeof buildXlargeTextStatus>;

function createSearchEvent(window: BrowserWindow) {
    return {sender: window.webContents} as IpcMainInvokeEvent;
}

function abortErrorFromSignal(signal: AbortSignal) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error('Agent document-text request was aborted.');
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function dispatchAgentSearchRequest(
    window: BrowserWindow,
    payload: Parameters<SearchWorkerService['dispatchSearchRequest']>[1],
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const requestId = createRequestId(payload.requestIdPrefix);
    const request = agentSearchWorkerService.dispatchSearchRequest(
        createSearchEvent(window),
        {
            ...payload,
            requestId,
        },
    );
    if (!signal) {
        return request;
    }

    return new Promise<Awaited<typeof request>>((resolve, reject) => {
        const handleAbort = () => {
            signal.removeEventListener('abort', handleAbort);
            agentSearchWorkerService.cancel({
                sender: window.webContents,
                senderId: window.webContents.id,
            }, requestId);
            reject(abortErrorFromSignal(signal));
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        if (signal.aborted) {
            handleAbort();
        }
        void request.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', handleAbort);
        });
    });
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(1, Math.trunc(value)));
}

function getValidatedSearchPageCount(tab: IAgentTabSnapshot) {
    if (typeof tab.totalPages !== 'number' || tab.totalPages < 1) {
        return undefined;
    }
    return parseOptionalSearchPageCount(tab.totalPages);
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

async function resolveAgentSearchPath(window: BrowserWindow, tab: IAgentTabSnapshot) {
    const requestedPath = getAgentTabPdfPath(tab);
    const resolvedPdfPath = await resolveSearchablePdfPath(requestedPath, window.webContents.id);
    if (!resolvedPdfPath) {
        throw new Error('The PDF is not available to the EVB search index yet.');
    }
    const documentRevision = (await getWorkingCopyRevision(resolvedPdfPath, window.webContents.id)).token;

    return {
        requestedPath,
        resolvedPdfPath,
        documentRevision,
    };
}

/**
 * Agent calls can arrive without a live renderer page count. A known high page
 * count still selects the bounded route when the scalar stat is unavailable.
 * This keeps the routing decision independent of document-text loading.
 */
async function classifyAgentSearchPath(
    pdfPath: string,
    pageCount: number | undefined,
) {
    try {
        const fileStat = await stat(pdfPath);
        const pathSizeBytes = typeof fileStat.size === 'number' && Number.isFinite(fileStat.size)
            ? fileStat.size
            : undefined;
        return classifyXlargeSearchPath({
            ...(pageCount === undefined ? {} : {pageCount}),
            ...(pathSizeBytes === undefined ? {} : {pathSizeBytes}),
        });
    } catch {
        return classifyXlargeSearchPath(
            pageCount === undefined ? {} : {pageCount},
        );
    }
}

async function loadXlargeSearchMetadata(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount: number | undefined,
    signal?: AbortSignal,
) {
    return loadCompactSearchIndex(pdfPath, {
        documentRevision,
        ...(pageCount === undefined ? {} : {expectedPageCount: pageCount}),
        metadataOnly: true,
        ...(signal === undefined ? {} : {signal}),
    });
}

async function warmAgentSearchIndex(
    window: BrowserWindow,
    tab: IAgentTabSnapshot,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const {
        requestedPath,
        resolvedPdfPath,
        documentRevision,
    } = await resolveAgentSearchPath(window, tab);
    const pageCount = getValidatedSearchPageCount(tab);
    const classification = await classifyAgentSearchPath(resolvedPdfPath, pageCount);
    await dispatchAgentSearchRequest(
        window,
        {
            resolvedPdfPath,
            documentRevision,
            query: '',
            warmup: true,
            requestIdPrefix: 'agent-warm',
            ...(pageCount === undefined ? {} : { pageCount }),
        },
        signal,
    );

    throwIfAborted(signal);
    if (classification.isXlarge) {
        const xlargeMetadata = await loadXlargeSearchMetadata(
            resolvedPdfPath,
            documentRevision,
            pageCount,
            signal,
        );
        throwIfAborted(signal);
        return {
            requestedPath,
            resolvedPdfPath,
            index: null,
            xlargeMetadata,
            isXlarge: true as const,
        };
    }

    const index = await loadSearchIndex(resolvedPdfPath, documentRevision);
    throwIfAborted(signal);
    return {
        requestedPath,
        resolvedPdfPath,
        index,
        xlargeMetadata: null,
        isXlarge: false as const,
    };
}

function resolvePageCount(tab: IAgentTabSnapshot, indexPageCount: number | undefined, indexedPages: number) {
    if (typeof tab.totalPages === 'number' && tab.totalPages > 0) {
        return Math.trunc(tab.totalPages);
    }
    if (typeof indexPageCount === 'number' && indexPageCount > 0) {
        return Math.trunc(indexPageCount);
    }
    return indexedPages;
}

function buildXlargeTextStatus(
    tab: IAgentTabSnapshot,
    index: ICompactSearchIndex | null,
) {
    const pageCount = resolvePageCount(tab, index?.pageCount, 0);
    const coverage = index?.coverage;
    if (!index || !coverage || pageCount <= 0) {
        return {
            status: 'unknown' as const,
            pageCount,
            textPageCount: 0,
            missingTextPages: [],
            missingTextPageSample: [],
            missingTextPageCount: pageCount,
            coverage: 0,
            coverageScope: 'document' as const,
            globalCoverageKnown: false,
        };
    }

    const textPageCount = Math.min(pageCount, Math.max(0, coverage.pagesWritten));
    const missingTextPageCount = Math.max(0, pageCount - textPageCount);
    const scanComplete = coverage.complete
        && !coverage.partialCoverage
        && !coverage.truncatedCoverage
        && coverage.pagesScanned >= pageCount;
    const status = scanComplete
        ? 'complete' as const
        : textPageCount === 0
            ? 'none' as const
            : 'partial' as const;

    return {
        status,
        pageCount,
        textPageCount,
        // Never materialize one entry per missing page for xlarge documents.
        missingTextPages: [],
        missingTextPageSample: [],
        missingTextPageCount,
        missingTextPagesTruncated: missingTextPageCount > 0,
        scanComplete,
        pagesScanned: coverage.pagesScanned,
        coverage: pageCount > 0 ? textPageCount / pageCount : 0,
        coverageScope: 'document' as const,
        globalCoverageKnown: true,
    };
}

function buildTextStatus(tab: IAgentTabSnapshot, index: Awaited<ReturnType<typeof loadSearchIndex>>) {
    if (!index) {
        return {
            status: 'unknown' as const,
            pageCount: tab.totalPages ?? 0,
            textPageCount: 0,
            missingTextPages: [],
            missingTextPageSample: [],
            coverage: 0,
        };
    }

    const pageCount = resolvePageCount(tab, index.pageCount, index.pages.length);
    const textPages = new Set(
        index.pages
            .filter(page => page.pageNumber >= 1 && page.pageNumber <= pageCount && page.text.trim().length > 0)
            .map(page => page.pageNumber),
    );
    const missingTextPages: number[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
        if (!textPages.has(page)) {
            missingTextPages.push(page);
        }
    }

    const textPageCount = textPages.size;
    const coverage = pageCount > 0 ? textPageCount / pageCount : 0;
    const status = pageCount <= 0
        ? 'unknown'
        : textPageCount === pageCount
            ? 'complete'
            : textPageCount === 0
                ? 'none'
                : 'partial';

    return {
        status,
        pageCount,
        textPageCount,
        missingTextPages,
        missingTextPageSample: missingTextPages.slice(0, MAX_MISSING_PAGE_SAMPLE),
        coverage,
    };
}

function createTextRecommendations(textStatus: TAgentTextStatus) {
    if (textStatus.status === 'complete' || textStatus.status === 'unknown') {
        return [];
    }

    if (textStatus.status === 'partial' || textStatus.status === 'none') {
        return [{
            id: 'ocr_all_pages',
            title: 'OCR all pages',
            reason: textStatus.status === 'none'
                ? 'No searchable page text was found, so document search and page reading will be unreliable until OCR is run.'
                : 'Some pages lack searchable text; OCRing all pages gives agents consistent page text.',
            toolName: 'ocr.start',
        }];
    }

    return [];
}

export async function inspectAgentDocumentText(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<Record<never, never>>,
    signal?: AbortSignal,
) {
    const {
        requestedPath,
        resolvedPdfPath,
        index,
        xlargeMetadata,
        isXlarge,
    } = await warmAgentSearchIndex(window, input.tab, signal);
    const textStatus = isXlarge
        ? buildXlargeTextStatus(input.tab, xlargeMetadata)
        : buildTextStatus(input.tab, index);

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
    throwIfAborted(signal);
    const query = input.options.query.trim();
    if (!query) {
        throw new Error('query is required.');
    }
    validateSearchQuery(query, {
        matchCase: input.options.matchCase,
        wholeWord: input.options.wholeWord,
        useRegex: input.options.useRegex,
    });
    const maxResults = normalizePositiveInteger(
        input.options.maxResults,
        DEFAULT_SEARCH_RESULT_LIMIT,
        MAX_SEARCH_RESULT_LIMIT,
    );
    if (input.options.pages && input.options.pages.length > 0) {
        const pageRead = await readAgentDocumentPages(window, {
            tab: input.tab,
            options: {
                pages: input.options.pages,
                maxCharsPerPage: MAX_PAGE_TEXT_CHARS,
            },
        }, signal);
        const boundedSearch = searchBoundedPageTexts(query, pageRead.pages, input.options, maxResults);
        return {
            tabId: input.tab.tabId,
            fileName: input.tab.fileName,
            originalPath: input.tab.originalPath,
            requestedPath: pageRead.requestedPath,
            resolvedPdfPath: pageRead.resolvedPdfPath,
            query,
            options: {
                matchCase: Boolean(input.options.matchCase),
                wholeWord: Boolean(input.options.wholeWord),
                useRegex: Boolean(input.options.useRegex),
                pages: input.options.pages,
            },
            results: boundedSearch.results,
            returnedResults: boundedSearch.results.length,
            totalAvailableResults: boundedSearch.totalAvailableResults,
            truncated: boundedSearch.truncated,
            searchTruncated: false,
            toolTruncated: boundedSearch.truncated,
            bounded: true,
            textStatus: pageRead.textStatus,
            pageRead,
        };
    }

    const {
        requestedPath,
        resolvedPdfPath,
        documentRevision,
    } = await resolveAgentSearchPath(window, input.tab);
    const pageCount = getValidatedSearchPageCount(input.tab);
    const classification = await classifyAgentSearchPath(resolvedPdfPath, pageCount);
    const response: IPdfSearchResponse = await dispatchAgentSearchRequest(
        window,
        {
            resolvedPdfPath,
            documentRevision,
            query,
            requestIdPrefix: 'agent-search',
            ...(pageCount === undefined ? {} : { pageCount }),
            ...(input.options.matchCase === undefined ? {} : { matchCase: input.options.matchCase }),
            ...(input.options.wholeWord === undefined ? {} : { wholeWord: input.options.wholeWord }),
            ...(input.options.useRegex === undefined ? {} : { useRegex: input.options.useRegex }),
        },
        signal,
    );
    const results = response.results.slice(0, maxResults);
    const xlargeMetadata = classification.isXlarge
        ? await loadXlargeSearchMetadata(resolvedPdfPath, documentRevision, pageCount, signal)
        : null;
    const index = classification.isXlarge
        ? null
        : await loadSearchIndex(resolvedPdfPath, documentRevision).catch((error) => {
            logger.debug(`Failed to load search index after agent search: ${getErrorMessage(error)}`);
            return null;
        });

    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        query,
        options: {
            matchCase: Boolean(input.options.matchCase),
            wholeWord: Boolean(input.options.wholeWord),
            useRegex: Boolean(input.options.useRegex),
        },
        results,
        returnedResults: results.length,
        totalAvailableResults: response.results.length,
        truncated: response.truncated || response.results.length > results.length,
        searchTruncated: response.truncated,
        toolTruncated: response.results.length > results.length,
        textStatus: classification.isXlarge
            ? buildXlargeTextStatus(input.tab, xlargeMetadata)
            : buildTextStatus(input.tab, index),
    };
}

function buildPageTextResponse(
    pageNumber: number,
    text: string,
    maxCharsPerPage: number,
    source?: TAgentPageTextSource,
) {
    const normalizedText = text.replace(/\r\n?/g, '\n').trim();
    const truncated = normalizedText.length > maxCharsPerPage;
    return {
        page: pageNumber,
        hasText: normalizedText.length > 0,
        textLength: normalizedText.length,
        truncated,
        ...(source === undefined ? {} : {source}),
        text: truncated ? normalizedText.slice(0, maxCharsPerPage) : normalizedText,
    };
}

function normalizeRequestedReadPages(pages: readonly number[], pageCount?: number) {
    return Array.from(new Set(
        pages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && (pageCount === undefined || page <= pageCount)),
    )).sort((left, right) => left - right);
}

function completeRequestedPageTexts(pageTexts: readonly IPageText[], pages: readonly number[]) {
    const pageTextByNumber = new Map(pageTexts.map(page => [
        page.pageNumber,
        page.text,
    ]));
    return pages.map(pageNumber => ({
        pageNumber,
        text: pageTextByNumber.get(pageNumber) ?? '',
    }));
}

function searchBoundedPageTexts(
    query: string,
    pageTexts: ReadonlyArray<ReturnType<typeof buildPageTextResponse>>,
    options: IAgentDocumentSearchOptions,
    maxResults: number,
) {
    const results: Array<IPdfSearchResponse['results'][number]> = [];
    let matchIndex = 0;
    let totalAvailableResults = 0;
    for (const page of pageTexts) {
        let pageMatchIndex = 0;
        for (const match of iteratePageMatches(page.text, query, {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
            useRegex: Boolean(options.useRegex),
        })) {
            totalAvailableResults += 1;
            if (results.length < maxResults) {
                results.push({
                    pageNumber: requirePageNumber(page.page),
                    pageMatchIndex,
                    matchIndex,
                    startOffset: match.startOffset,
                    endOffset: match.endOffset,
                    excerpt: buildExcerpt(page.text, match.startOffset, match.endOffset),
                });
            }
            matchIndex += 1;
            pageMatchIndex += 1;
        }
    }

    return {
        results,
        totalAvailableResults,
        truncated: totalAvailableResults > results.length,
    };
}

async function extractSelectedPdfPageTextWithFallback(
    pdfPath: string,
    pages: readonly number[],
    pageCount: number | undefined,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    try {
        const {extractTextWithPdfjs} = await loadPdfjsTextExtractor();
        return {
            source: 'direct-pdfjs' as const,
            pages: completeRequestedPageTexts(await extractTextWithPdfjs(pdfPath, {
                pages,
                ...(pageCount === undefined ? {} : {pageCount}),
                ...(signal === undefined ? {} : {signal}),
            }), pages),
        };
    } catch (pdfjsError) {
        throwIfAborted(signal);
        logger.debug(`Direct PDF.js page text probe failed; falling back to pdftotext: ${getErrorMessage(pdfjsError)}`);
        return {
            source: 'direct-pdftotext' as const,
            pages: completeRequestedPageTexts(await extractTextFromPdf(pdfPath, {
                ...(pageCount === undefined ? {} : {pageCount}),
                pages,
                ...(signal === undefined ? {} : {signal}),
            }), pages),
        };
    }
}

function buildRequestedPagesTextStatus(
    tab: IAgentTabSnapshot,
    pageCount: number,
    pages: readonly IPageText[],
) {
    const textPageCount = pages.filter(page => page.text.trim().length > 0).length;
    const missingTextPages = pages
        .filter(page => page.text.trim().length === 0)
        .map(page => page.pageNumber);
    const status = pages.length === 0
        ? 'unknown' as const
        : textPageCount === pages.length
            ? 'complete' as const
            : textPageCount === 0
                ? 'none' as const
                : 'partial' as const;

    return {
        status,
        pageCount,
        textPageCount,
        missingTextPages,
        missingTextPageSample: missingTextPages.slice(0, MAX_MISSING_PAGE_SAMPLE),
        coverage: pages.length > 0 ? textPageCount / pages.length : 0,
        coverageScope: 'requested-pages',
        inspectedPages: pages.map(page => page.pageNumber),
        globalCoverageKnown: false,
        recommendation: 'This is a bounded page probe. Treat it as local evidence, not full-document OCR coverage.',
        tabTotalPages: tab.totalPages ?? null,
    };
}

export async function readAgentDocumentPages(
    window: BrowserWindow,
    input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const {
        requestedPath,
        resolvedPdfPath,
        documentRevision,
    } = await resolveAgentSearchPath(window, input.tab);
    const knownPageCount = getValidatedSearchPageCount(input.tab);
    const classification = await classifyAgentSearchPath(resolvedPdfPath, knownPageCount);
    const maxCharsPerPage = normalizePositiveInteger(
        input.options.maxCharsPerPage,
        DEFAULT_PAGE_TEXT_CHARS,
        MAX_PAGE_TEXT_CHARS,
    );

    if (classification.isXlarge) {
        const uniquePages = normalizeRequestedReadPages(input.options.pages, knownPageCount);
        const pageCount = knownPageCount ?? uniquePages.at(-1) ?? 0;
        if (uniquePages.length === 0) {
            throw new Error(
                knownPageCount === undefined
                    ? 'No requested pages were positive integers.'
                    : `No requested pages are within the document's 1-${pageCount} page range.`,
            );
        }
        const directPageProbe = await extractSelectedPdfPageTextWithFallback(
            resolvedPdfPath,
            uniquePages,
            knownPageCount,
            signal,
        );
        throwIfAborted(signal);
        const pageTexts = uniquePages.map(pageNumber => ({
            pageNumber,
            text: directPageProbe.pages.find(page => page.pageNumber === pageNumber)?.text ?? '',
        }));
        const pages = pageTexts.map(page => buildPageTextResponse(
            page.pageNumber,
            page.text,
            maxCharsPerPage,
            directPageProbe.source,
        ));

        return {
            tabId: input.tab.tabId,
            fileName: input.tab.fileName,
            originalPath: input.tab.originalPath,
            requestedPath,
            resolvedPdfPath,
            pageCount,
            source: directPageProbe.source,
            usedCachedSearchIndex: false,
            pages,
            textStatus: buildRequestedPagesTextStatus(input.tab, pageCount, pageTexts),
        };
    }

    const index = await loadSearchIndex(resolvedPdfPath, documentRevision).catch((error) => {
        logger.debug(`No cached search index available for agent page read; using direct page probe: ${getErrorMessage(error)}`);
        return null;
    });
    throwIfAborted(signal);
    const pageCount = resolvePageCount(input.tab, index?.pageCount, index?.pages.length ?? 0);
    const uniquePages = normalizeRequestedReadPages(input.options.pages, pageCount);
    if (uniquePages.length === 0) {
        throw new Error(`No requested pages are within the document's 1-${pageCount} page range.`);
    }

    const indexedPageTextByNumber = new Map((index?.pages ?? []).map(page => [
        page.pageNumber,
        page.text,
    ]));
    const pagesNeedingDirectProbe = uniquePages.filter((pageNumber) => {
        const cachedText = indexedPageTextByNumber.get(pageNumber);
        return cachedText === undefined || cachedText.trim().length === 0;
    });
    const directPageProbe = pagesNeedingDirectProbe.length > 0
        ? await extractSelectedPdfPageTextWithFallback(
            resolvedPdfPath,
            pagesNeedingDirectProbe,
            pageCount,
            signal,
        )
        : null;
    const directPageTextByNumber = new Map((directPageProbe?.pages ?? []).map(page => [
        page.pageNumber,
        page.text,
    ]));
    const sourceByPageNumber = new Map<number, TAgentPageTextSource>();
    for (const pageNumber of uniquePages) {
        const indexedText = indexedPageTextByNumber.get(pageNumber);
        const directText = directPageTextByNumber.get(pageNumber);
        if (directPageProbe && directText !== undefined && (indexedText === undefined || indexedText.trim().length === 0)) {
            sourceByPageNumber.set(pageNumber, directPageProbe.source);
        } else if (indexedText !== undefined) {
            sourceByPageNumber.set(pageNumber, 'search-index');
        }
    }
    const pageTexts = uniquePages.map(pageNumber => ({
        pageNumber,
        text: directPageTextByNumber.get(pageNumber)?.trim().length
            ? directPageTextByNumber.get(pageNumber) ?? ''
            : indexedPageTextByNumber.get(pageNumber) ?? directPageTextByNumber.get(pageNumber) ?? '',
    }));
    const pages = pageTexts.map(page => buildPageTextResponse(
        page.pageNumber,
        page.text,
        maxCharsPerPage,
        sourceByPageNumber.get(page.pageNumber),
    ));

    return {
        tabId: input.tab.tabId,
        fileName: input.tab.fileName,
        originalPath: input.tab.originalPath,
        requestedPath,
        resolvedPdfPath,
        pageCount,
        source: directPageProbe === null ? 'search-index' : directPageProbe.source,
        usedCachedSearchIndex: index !== null,
        pages,
        textStatus: buildRequestedPagesTextStatus(input.tab, pageCount, pageTexts),
        ...(index === null ? {} : {globalTextStatus: buildTextStatus(input.tab, index)}),
    };
}
