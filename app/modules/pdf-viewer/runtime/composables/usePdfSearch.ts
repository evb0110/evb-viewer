import { getErrorMessage } from '@app/utils/error';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';
import type { TPageIndex } from '@contracts/pageNumbers';

import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
} from '@app/types/pdfUi';
import {
    mapPdfSearchResultToUiMatch,
    mapPdfSearchResultToUiPageMatchEntry,
} from '@app/types/pdfUi';
import type {
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchResult,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
} from '@contracts/search';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import type { MaybeRefOrGetter } from 'vue';
import {
    findSearchErrorEnvelope,
    PDF_SEARCH_MIN_QUERY_LENGTH,
} from '@contracts/search';
import { tryOnScopeDispose } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSearchCapability } from '@app/utils/getSearchCapability';

interface IUsePdfSearchOptions { documentRevisionToken?: MaybeRefOrGetter<TDocumentRevisionToken | null | undefined>; }

interface IScheduledPdfSearch {
    runId: number;
    query: string;
    pdfPath: string;
    documentRevisionToken: TDocumentRevisionToken | null;
    pageCount?: number;
    options: IResolvedSearchMatchOptions;
}

/**
 * Unquoted UI queries retain the established trim behavior. Double quotes are an
 * explicit affordance for matching intentional leading or trailing whitespace.
 */
function resolvePdfSearchQuery(query: string) {
    const trimmed = query.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function normalizeDocumentRevisionToken(token: TDocumentRevisionToken | null | undefined) {
    return typeof token === 'string' && token.length > 0 ? token : null;
}

function mixSearchSignatureHash(hash: number, value: number) {
    return Math.imul(hash ^ (value >>> 0), 16777619);
}

function mixSearchWordGeometry(
    hash: number,
    words: IPdfSearchMatch['words'],
) {
    let nextHash = mixSearchSignatureHash(hash, words?.length ?? 0);
    words?.forEach((word) => {
        nextHash = mixSearchSignatureHash(nextHash, Math.round(word.x * 100));
        nextHash = mixSearchSignatureHash(nextHash, Math.round(word.y * 100));
        nextHash = mixSearchSignatureHash(nextHash, Math.round(word.width * 100));
        nextHash = mixSearchSignatureHash(nextHash, Math.round(word.height * 100));
    });
    return nextHash;
}

export const usePdfSearch = (hookOptions: IUsePdfSearchOptions = {}) => {
    const { t } = useTypedI18n();
    const searchQuery = ref('');
    const submittedSearchQuery = ref('');
    const searchOptions = ref<IResolvedSearchMatchOptions>({
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    });
    const results = ref<IPdfSearchMatch[]>([]);
    const pageMatches = ref<Map<number, IPdfPageMatches>>(new Map());
    const currentResultIndex = ref(-1);
    const currentResultNavigationId = ref(0);
    const isSearching = ref(false);
    const searchError = ref<string | null>(null);
    const searchProgress = ref<{
        processed: number;
        total: number;
    } | undefined>(undefined);
    const isTruncated = ref(false);
    const wasSearchCanceled = ref(false);
    let searchRunId = 0;
    const scheduledResolvers = new Map<number, (applied: boolean) => void>();
    let progressCleanup: (() => void) | null = null;
    let activeRequestId: TRequestId | null = null;
    let pendingSearchTimer: ReturnType<typeof setTimeout> | null = null;

    const totalMatches = computed(() => results.value.length);
    const hasPartialResults = computed(() => isSearching.value && (results.value.length > 0 || isTruncated.value));
    const currentMatch = computed(() => results.value.length > 0 ? currentResultIndex.value + 1 : 0);
    const currentResult = computed(() => {
        if (currentResultIndex.value >= 0 && currentResultIndex.value < results.value.length) {
            return results.value[currentResultIndex.value] ?? null;
        }
        return null;
    });

    function buildPageMatchSignatureToken(pageMatchData: IPdfPageMatches) {
        let hash = 2166136261;
        const mix = (value: number) => {
            hash = mixSearchSignatureHash(hash, value);
        };

        mix(pageMatchData.pageIndex);
        mix(pageMatchData.searchQuery.length);
        mix(pageMatchData.searchOptions?.matchCase ? 1 : 0);
        mix(pageMatchData.searchOptions?.wholeWord ? 1 : 0);
        mix(pageMatchData.searchOptions?.useRegex ? 1 : 0);
        mix(pageMatchData.matches.length);

        pageMatchData.matches.forEach((match) => {
            mix(match.matchIndex);
            mix(match.start);
            mix(match.end);
            mix(Math.round(match.pageWidth ?? 0));
            mix(Math.round(match.pageHeight ?? 0));
            hash = mixSearchWordGeometry(hash, match.words);
        });

        return `${pageMatchData.pageIndex}:${pageMatchData.matches.length}:${hash >>> 0}`;
    }

    function isSameSearchMatchTarget(
        first: IPdfSearchMatch | null,
        second: IPdfSearchMatch | null,
    ) {
        if (!first || !second) {
            return first === second;
        }

        return first.pageIndex === second.pageIndex
            && first.matchIndex === second.matchIndex
            && first.startOffset === second.startOffset
            && first.endOffset === second.endOffset
            && (first.pageMatchIndex ?? null) === (second.pageMatchIndex ?? null);
    }

    function buildSearchMatchGeometrySignature(match: IPdfSearchMatch | null) {
        if (!match) {
            return 'null';
        }

        let hash = 2166136261;
        hash = mixSearchSignatureHash(hash, Math.round(match.pageWidth ?? 0));
        hash = mixSearchSignatureHash(hash, Math.round(match.pageHeight ?? 0));
        hash = mixSearchWordGeometry(hash, match.words);

        return String(hash >>> 0);
    }

    function isSameSearchMatchGeometry(
        first: IPdfSearchMatch | null,
        second: IPdfSearchMatch | null,
    ) {
        return buildSearchMatchGeometrySignature(first) === buildSearchMatchGeometrySignature(second);
    }

    function findSearchMatchTargetIndex(
        matches: IPdfSearchMatch[],
        target: IPdfSearchMatch | null,
    ) {
        if (!target) {
            return -1;
        }
        return matches.findIndex(match => isSameSearchMatchTarget(match, target));
    }

    function cleanupProgressListener() {
        if (progressCleanup) {
            progressCleanup();
            progressCleanup = null;
        }
        searchProgress.value = undefined;
    }

    function normalizeSearchError(error: unknown) {
        if (error instanceof Error && getErrorMessage(error) === 'ERR_BROWSER_SEARCH_TOO_LARGE') {
            return t('errors.search.browserTooLarge');
        }
        const envelope = findSearchErrorEnvelope(error);
        if (envelope) {
            BrowserLogger.debug('pdf-search', 'Search IPC failed with typed envelope', {
                code: envelope.code,
                retryable: envelope.retryable,
            });
            return envelope.message || t('errors.search.unavailable');
        }
        return t('errors.search.unavailable');
    }

    function getCurrentDocumentRevisionToken() {
        return normalizeDocumentRevisionToken(toValue(hookOptions.documentRevisionToken));
    }

    function isCurrentSearchRun(runId: number, documentRevisionToken: TDocumentRevisionToken | null) {
        return runId === searchRunId
            && getCurrentDocumentRevisionToken() === documentRevisionToken;
    }

    function normalizeSearchResponse(
        response: IPdfSearchResponse,
        query: string,
        options: IResolvedSearchMatchOptions,
        searchId: string,
    ) {
        const resultsWithPageIndex = response.results.map(result => ({
            result,
            pageIndex: mapPdfSearchResultToUiMatch(result).pageIndex,
        }));
        const mergedResults = resultsWithPageIndex.map(({ result }, idx): IPdfSearchMatch => {
            if (idx < 3) {
                BrowserLogger.debug('pdf-search', `Result ${idx}`, {
                    searchId,
                    page: result.pageNumber,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                });
            }

            return mapPdfSearchResultToUiMatch(result);
        });

        const pageResults = new Map<typeof resultsWithPageIndex[number]['pageIndex'], IPdfSearchResult[]>();
        resultsWithPageIndex.forEach((item) => {
            const pageSearchResults = pageResults.get(item.pageIndex) ?? [];
            if (pageSearchResults.length === 0) {
                BrowserLogger.debug('pdf-search', `Created pageMatches for page ${item.result.pageNumber}`, { searchId });
                pageResults.set(item.pageIndex, pageSearchResults);
            }
            pageSearchResults.push(item.result);
        });

        const matchesMap = new Map(Array.from(pageResults.entries()).map(([
            pageIndex,
            pageSearchResults,
        ]) => {
            const pageMatchData: IPdfPageMatches = {
                pageIndex,
                pageText: '',
                searchQuery: query,
                searchOptions: { ...options },
                matches: pageSearchResults.map(result => mapPdfSearchResultToUiPageMatchEntry(result)),
            };

            return [
                pageIndex,
                {
                    ...pageMatchData,
                    signatureToken: buildPageMatchSignatureToken(pageMatchData),
                },
            ];
        }));

        return {
            results: mergedResults,
            pageMatches: matchesMap,
        };
    }

    function applySearchResponse(
        response: IPdfSearchResponse,
        query: string,
        options: IResolvedSearchMatchOptions,
        searchId: string,
    ) {
        const normalizedResponse = normalizeSearchResponse(response, query, options, searchId);
        const previousCurrentResult = currentResult.value;

        results.value = normalizedResponse.results;
        pageMatches.value = normalizedResponse.pageMatches;
        isTruncated.value = response.truncated;

        if (normalizedResponse.results.length === 0) {
            currentResultIndex.value = -1;
            return;
        }

        if (currentResultIndex.value < 0) {
            currentResultIndex.value = 0;
            currentResultNavigationId.value += 1;
            return;
        }

        const preservedCurrentResultIndex = findSearchMatchTargetIndex(
            normalizedResponse.results,
            previousCurrentResult,
        );
        if (preservedCurrentResultIndex >= 0) {
            currentResultIndex.value = preservedCurrentResultIndex;
            if (!isSameSearchMatchGeometry(
                previousCurrentResult,
                normalizedResponse.results[preservedCurrentResultIndex] ?? null,
            )) {
                currentResultNavigationId.value += 1;
            }
        } else if (currentResultIndex.value >= normalizedResponse.results.length) {
            currentResultIndex.value = normalizedResponse.results.length - 1;
            currentResultNavigationId.value += 1;
        } else if (!isSameSearchMatchTarget(
            previousCurrentResult,
            normalizedResponse.results[currentResultIndex.value] ?? null,
        )) {
            currentResultNavigationId.value += 1;
        }
    }

    function applySearchProgressResults(
        currentResults: IPdfSearchResult[],
        incomingResults: readonly IPdfSearchResult[],
        resultsStartIndex: number | undefined,
    ) {
        if (resultsStartIndex === undefined) {
            return [...incomingResults];
        }
        if (resultsStartIndex > currentResults.length) {
            return currentResults;
        }

        const nextResults = currentResults.slice(0, resultsStartIndex);
        nextResults.push(...incomingResults);
        return nextResults;
    }

    async function runScheduledSearch(payload: IScheduledPdfSearch) {
        const resolver = scheduledResolvers.get(payload.runId);
        scheduledResolvers.delete(payload.runId);
        if (!resolver) {
            return;
        }

        try {
            await performSearch(
                payload.runId,
                payload.query,
                payload.pdfPath,
                payload.documentRevisionToken,
                payload.pageCount,
                payload.options,
            );
        } catch (error) {
            if (isCurrentSearchRun(payload.runId, payload.documentRevisionToken)) {
                searchError.value = normalizeSearchError(error);
                results.value = [];
                pageMatches.value = new Map();
                currentResultIndex.value = -1;
                isTruncated.value = false;
            }
            BrowserLogger.warn('pdf-search', 'Search failed', {
                query: payload.query,
                error,
            });
        } finally {
            resolver(isCurrentSearchRun(payload.runId, payload.documentRevisionToken) && !searchError.value);
        }
    }

    /**
     * The debounce timer is owned here rather than by a filter wrapper so that
     * leaving the search tab can actually drop work that has not started yet.
     */
    function scheduleSearch(payload: IScheduledPdfSearch) {
        clearPendingSearchTimer();
        if (SEARCH_DEBOUNCE_MS <= 0) {
            void runScheduledSearch(payload);
            return;
        }
        pendingSearchTimer = setTimeout(() => {
            pendingSearchTimer = null;
            void runScheduledSearch(payload);
        }, SEARCH_DEBOUNCE_MS);
    }

    function clearPendingSearchTimer() {
        if (pendingSearchTimer !== null) {
            clearTimeout(pendingSearchTimer);
            pendingSearchTimer = null;
        }
    }

    function cancelScheduledSearch() {
        clearPendingSearchTimer();
        for (const resolver of scheduledResolvers.values()) {
            resolver(false);
        }
        scheduledResolvers.clear();
    }

    async function cancelActiveSearch() {
        if (!activeRequestId) {
            return;
        }

        const requestIdToCancel = activeRequestId;
        activeRequestId = null;

        try {
            await getSearchCapability().cancel(requestIdToCancel);
        } catch (error) {
            BrowserLogger.debug('pdf-search', 'Failed to cancel active search', {
                requestId: requestIdToCancel,
                error,
            });
        }
    }

    /**
     * Abandons the current run without touching the query, options, or results
     * the user can still see. Leaving the search tab uses this; `clearSearch`
     * stays the explicit "empty the panel" action.
     */
    function cancelSearch() {
        searchRunId += 1;
        cancelScheduledSearch();
        void cancelActiveSearch();
        cleanupProgressListener();
        isSearching.value = false;
    }

    async function performSearch(
        runId: number,
        query: string,
        pdfPath: string,
        documentRevisionToken: TDocumentRevisionToken | null,
        pageCount?: number,
        options: IResolvedSearchMatchOptions = searchOptions.value,
    ) {
        if (query.length === 0) {
            return;
        }

        if (!isCurrentSearchRun(runId, documentRevisionToken)) {
            return;
        }

        const requestId = createRequestId('search');

        try {
            isSearching.value = true;
            isTruncated.value = false;
            wasSearchCanceled.value = false;
            searchError.value = null;
            submittedSearchQuery.value = query;
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            cleanupProgressListener();

            // Call backend search API
            const api = getSearchCapability();
            const searchId = requestId;
            let streamedResults: IPdfSearchResult[] = [];
            activeRequestId = requestId;

            progressCleanup = api.onProgress((progress) => {
                if (!isCurrentSearchRun(runId, documentRevisionToken)) {
                    return;
                }
                if (progress.requestId !== requestId) {
                    return;
                }
                searchProgress.value = {
                    processed: progress.processed,
                    total: progress.total,
                };
                if (progress.canceled) {
                    wasSearchCanceled.value = true;
                    isSearching.value = false;
                    return;
                }
                if (progress.results) {
                    streamedResults = applySearchProgressResults(
                        streamedResults,
                        progress.results,
                        progress.resultsStartIndex,
                    );
                    applySearchResponse({
                        results: streamedResults,
                        truncated: Boolean(progress.truncated),
                    }, query, options, searchId);
                }
            });

            const requestOptions: IPdfSearchRequestOptions = {
                requestId,
                ...options,
            };
            if (documentRevisionToken !== null) {
                requestOptions.documentRevision = documentRevisionToken;
            }
            if (pageCount !== undefined) {
                requestOptions.pageCount = pageCount;
            }

            const response = await api.run(pdfPath, query, requestOptions);

            if (!isCurrentSearchRun(runId, documentRevisionToken)) {
                return;
            }

            BrowserLogger.info('pdf-search', `Processing ${response.results.length} results`, {
                searchId,
                query,
            });
            if (response.canceled) {
                wasSearchCanceled.value = true;
                results.value = [];
                pageMatches.value = new Map();
                currentResultIndex.value = -1;
                isTruncated.value = false;
                return;
            }
            applySearchResponse(response, query, options, searchId);
            isTruncated.value = response.truncated;
        } finally {
            const isActiveRequest = activeRequestId === requestId;
            if (isActiveRequest) {
                activeRequestId = null;
            }
            if (isActiveRequest || isCurrentSearchRun(runId, documentRevisionToken)) {
                isSearching.value = false;
                cleanupProgressListener();
            }
        }
    }

    async function search(
        query: string,
        pdfPath: string,
        pageCount?: number,
        options: ISearchMatchOptions = searchOptions.value,
        documentRevisionToken?: TDocumentRevisionToken | null,
    ) {
        searchQuery.value = query;
        searchOptions.value = {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
            useRegex: Boolean(options.useRegex),
        };
        const resolvedQuery = resolvePdfSearchQuery(query);

        if (!resolvedQuery) {
            clearSearch();
            return false;
        }

        const runId = ++searchRunId;
        const normalizedDocumentRevisionToken = documentRevisionToken === undefined
            ? getCurrentDocumentRevisionToken()
            : normalizeDocumentRevisionToken(documentRevisionToken);
        cancelScheduledSearch();
        await cancelActiveSearch();
        if (!isCurrentSearchRun(runId, normalizedDocumentRevisionToken)) {
            return false;
        }
        cleanupProgressListener();

        if (resolvedQuery.length < PDF_SEARCH_MIN_QUERY_LENGTH) {
            isSearching.value = false;
            isTruncated.value = false;
            searchError.value = null;
            submittedSearchQuery.value = resolvedQuery;
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            return false;
        }

        // Mark as searching immediately so the UI doesn't show "No results found" while we're
        // waiting for the debounce window / backend response.
        isSearching.value = true;
        isTruncated.value = false;
        wasSearchCanceled.value = false;
        searchError.value = null;

        return new Promise<boolean>((resolve) => {
            scheduledResolvers.set(runId, resolve);
            const payload = {
                runId,
                query: resolvedQuery,
                pdfPath,
                documentRevisionToken: normalizedDocumentRevisionToken,
                options: { ...searchOptions.value },
            };
            if (pageCount !== undefined) {
                scheduleSearch({
                    ...payload,
                    pageCount,
                });
                return;
            }
            scheduleSearch(payload);
        });
    }

    function setSearchOption(
        key: keyof typeof searchOptions.value,
        value: boolean,
    ) {
        searchOptions.value = {
            ...searchOptions.value,
            [key]: value,
        };
    }

    function goToResult(direction: TSearchDirection) {
        if (results.value.length === 0) {
            return;
        }

        if (direction === 'next') {
            currentResultIndex.value = (currentResultIndex.value + 1) % results.value.length;
        } else {
            currentResultIndex.value = currentResultIndex.value <= 0
                ? results.value.length - 1
                : currentResultIndex.value - 1;
        }
        currentResultNavigationId.value += 1;
    }

    function setResultIndex(index: number) {
        if (index >= 0 && index < results.value.length) {
            if (currentResultIndex.value !== index) {
                currentResultIndex.value = index;
            }
            currentResultNavigationId.value += 1;
        }
    }

    function clearSearch() {
        searchRunId++;
        cancelScheduledSearch();
        void cancelActiveSearch();
        cleanupProgressListener();
        isSearching.value = false;
        searchQuery.value = '';
        submittedSearchQuery.value = '';
        searchError.value = null;
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;
        isTruncated.value = false;
        wasSearchCanceled.value = false;
    }

    function getMatchesForPage(pageIndex: TPageIndex) {
        return pageMatches.value.get(pageIndex) ?? null;
    }

    function resetSearchCache() {
        clearSearch();
        void Promise.resolve(getSearchCapability().resetCache()).catch((error) => {
            BrowserLogger.debug(
                'pdf-search',
                'Failed to reset search cache',
                error,
            );
        });
    }

    tryOnScopeDispose(cancelSearch);

    return {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
        searchProgress,
        hasPartialResults,
        totalMatches,
        currentMatch,
        isTruncated,
        wasSearchCanceled,
        minQueryLength: PDF_SEARCH_MIN_QUERY_LENGTH,
        search,
        setSearchOption,
        goToResult,
        setResultIndex,
        cancelSearch,
        clearSearch,
        resetSearchCache,
        getMatchesForPage,
    };
};
