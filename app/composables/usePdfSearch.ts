import {
    computed,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
} from 'app/types/pdf';

export type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
};

export const usePdfSearch = () => {
    const searchQuery = ref('');
    const results = ref<IPdfSearchMatch[]>([]);
    const pageMatches = ref<Map<number, IPdfPageMatches>>(new Map());
    const currentResultIndex = ref(-1);
    const isSearching = ref(false);
    const processedPages = ref(0);
    const totalPagesToSearch = ref(0);
    const pageTextCache = new Map<number, string>();
    const pageTextPromises = new Map<number, Promise<string>>();
    let cachedDocumentId: string | null = null;
    let searchRunId = 0;
    let scheduledTimeout: ReturnType<typeof setTimeout> | null = null;
    let scheduledResolve: ((applied: boolean) => void) | null = null;

    const EXCERPT_CONTEXT_CHARS = 40;
    const EXCERPT_MATCH_START = '\u0000';
    const EXCERPT_MATCH_END = '\u0001';
    const SEARCH_DEBOUNCE_MS = 300;

    const totalMatches = computed(() => results.value.length);
    const currentMatch = computed(() => results.value.length > 0 ? currentResultIndex.value + 1 : 0);
    const currentResult = computed(() => {
        if (currentResultIndex.value >= 0 && currentResultIndex.value < results.value.length) {
            return results.value[currentResultIndex.value];
        }
        return null;
    });
    const searchProgress = computed(() => ({
        processed: processedPages.value,
        total: totalPagesToSearch.value,
    }));

    function resetProgress(total: number) {
        processedPages.value = 0;
        totalPagesToSearch.value = total;
    }

    function getDocumentId(pdfDocument: PDFDocumentProxy) {
        const [fingerprint] = pdfDocument.fingerprints ?? [];
        return fingerprint ?? null;
    }

    function resetCacheForDocument(pdfDocument: PDFDocumentProxy) {
        const documentId = getDocumentId(pdfDocument);
        if (documentId !== cachedDocumentId) {
            cachedDocumentId = documentId;
            pageTextCache.clear();
            pageTextPromises.clear();
        }
    }

    function resetCache() {
        cachedDocumentId = null;
        pageTextCache.clear();
        pageTextPromises.clear();
    }

    async function getPageText(pageIndex: number, pdfDocument: PDFDocumentProxy) {
        const cached = pageTextCache.get(pageIndex);
        if (cached) {
            return cached;
        }

        const pending = pageTextPromises.get(pageIndex);
        if (pending) {
            return pending;
        }

        const promise = (async () => {
            const page = await pdfDocument.getPage(pageIndex + 1);
            const textContent = await page.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });

            let pageText = '';
            for (const item of textContent.items) {
                if ('str' in item) {
                    pageText += item.str;
                }
            }

            pageTextCache.set(pageIndex, pageText);
            return pageText;
        })();

        pageTextPromises.set(pageIndex, promise);
        try {
            return await promise;
        } finally {
            pageTextPromises.delete(pageIndex);
        }
    }

    function buildExcerpt(
        source: string,
        startOffset: number,
        endOffset: number,
    ): IPdfSearchMatch['excerpt'] {
        const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
        const excerptEnd = Math.min(source.length, endOffset + EXCERPT_CONTEXT_CHARS);

        const raw = source.slice(excerptStart, startOffset)
            + EXCERPT_MATCH_START
            + source.slice(startOffset, endOffset)
            + EXCERPT_MATCH_END
            + source.slice(endOffset, excerptEnd);

        const normalized = raw.replace(/\s+/g, ' ').trim();
        const startIndex = normalized.indexOf(EXCERPT_MATCH_START);
        const endIndex = normalized.indexOf(EXCERPT_MATCH_END);

        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
            return {
                prefix: excerptStart > 0,
                suffix: excerptEnd < source.length,
                before: normalized,
                match: '',
                after: '',
            };
        }

        const before = normalized.slice(0, startIndex).trimEnd();
        const match = normalized.slice(startIndex + 1, endIndex);
        const after = normalized.slice(endIndex + 1).trimStart();

        return {
            prefix: excerptStart > 0,
            suffix: excerptEnd < source.length,
            before,
            match,
            after,
        };
    }

    function cancelScheduledSearch() {
        if (scheduledTimeout) {
            clearTimeout(scheduledTimeout);
            scheduledTimeout = null;
        }

        if (scheduledResolve) {
            scheduledResolve(false);
            scheduledResolve = null;
        }
    }

    function applySearchState(
        runId: number,
        pageResults: IPdfSearchMatch[][],
        pageMatchesByPage: Array<IPdfPageMatches | null>,
    ) {
        if (runId !== searchRunId) {
            return;
        }

        const mergedResults: IPdfSearchMatch[] = [];
        const matchesMap = new Map<number, IPdfPageMatches>();

        pageResults.forEach((pageResult) => {
            if (pageResult && pageResult.length > 0) {
                mergedResults.push(...pageResult);
            }
        });

        pageMatchesByPage.forEach((pageMatch) => {
            if (pageMatch && pageMatch.matches.length > 0) {
                matchesMap.set(pageMatch.pageIndex, pageMatch);
            }
        });

        results.value = mergedResults;
        pageMatches.value = matchesMap;

        if (mergedResults.length === 0) {
            currentResultIndex.value = -1;
            return;
        }

        if (currentResultIndex.value < 0) {
            currentResultIndex.value = 0;
        } else if (currentResultIndex.value >= mergedResults.length) {
            currentResultIndex.value = mergedResults.length - 1;
        }
    }

    async function performSearch(runId: number, query: string, pdfDocument: PDFDocumentProxy) {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            return;
        }

        if (runId !== searchRunId) {
            return;
        }

        resetCacheForDocument(pdfDocument);
        const lowerQuery = normalizedQuery.toLowerCase();
        const numPages = pdfDocument.numPages;
        const pageResults: IPdfSearchMatch[][] = Array.from({ length: numPages }, () => []);
        const pageMatchesByPage: Array<IPdfPageMatches | null> = Array.from({ length: numPages }, () => null);

        resetProgress(numPages);

        try {
            for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
                if (runId !== searchRunId) {
                    return;
                }

                const pageText = await getPageText(pageIndex, pdfDocument);
                if (runId !== searchRunId) {
                    return;
                }

                const lowerPageText = pageText.toLowerCase();
                let matchIndex = 0;
                let position = 0;
                const matchesOnPage: IPdfPageMatches['matches'] = [];
                const resultsForPage: IPdfSearchMatch[] = [];

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    const startOffset = position;
                    const endOffset = position + normalizedQuery.length;

                    resultsForPage.push({
                        pageIndex,
                        matchIndex,
                        startOffset,
                        endOffset,
                        excerpt: buildExcerpt(pageText, startOffset, endOffset),
                    });

                    matchesOnPage.push({
                        start: startOffset,
                        end: endOffset,
                    });

                    matchIndex++;
                    position += normalizedQuery.length;
                }

                pageResults[pageIndex] = resultsForPage;
                pageMatchesByPage[pageIndex] = matchesOnPage.length > 0
                    ? {
                        pageIndex,
                        matches: matchesOnPage,
                    }
                    : null;

                processedPages.value = pageIndex + 1;

                applySearchState(runId, pageResults, pageMatchesByPage);
            }
        } finally {
            if (runId === searchRunId) {
                isSearching.value = false;
            }
        }
    }

    async function search(query: string, pdfDocument: PDFDocumentProxy): Promise<boolean> {
        searchQuery.value = query;
        if (!query.trim()) {
            clearSearch();
            return false;
        }

        cancelScheduledSearch();
        const runId = ++searchRunId;
        isSearching.value = true;
        resetProgress(pdfDocument.numPages);
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;

        return new Promise<boolean>((resolve) => {
            scheduledResolve = resolve;
            scheduledTimeout = setTimeout(async () => {
                scheduledTimeout = null;
                scheduledResolve = null;
                try {
                    await performSearch(runId, query, pdfDocument);
                } finally {
                    resolve(runId === searchRunId);
                }
            }, SEARCH_DEBOUNCE_MS);
        });
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
    }

    function setResultIndex(index: number) {
        if (index >= 0 && index < results.value.length) {
            currentResultIndex.value = index;
        }
    }

    function clearSearch() {
        searchRunId++;
        cancelScheduledSearch();
        isSearching.value = false;
        searchQuery.value = '';
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;
        resetProgress(0);
    }

    function getMatchesForPage(pageIndex: number) {
        return pageMatches.value.get(pageIndex) ?? null;
    }

    return {
        searchQuery,
        results,
        pageMatches,
        currentResultIndex,
        currentResult,
        isSearching,
        totalMatches,
        currentMatch,
        searchProgress,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
        getMatchesForPage,
        resetSearchCache: resetCache,
    };
};
