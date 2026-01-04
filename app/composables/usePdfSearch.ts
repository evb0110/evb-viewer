import {
    computed,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDebounceFn } from '@vueuse/core';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TSearchDirection,
} from '../types/pdf';

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
    let searchRunId = 0;

    const totalMatches = computed(() => results.value.length);
    const currentMatch = computed(() => results.value.length > 0 ? currentResultIndex.value + 1 : 0);
    const currentResult = computed(() => {
        if (currentResultIndex.value >= 0 && currentResultIndex.value < results.value.length) {
            return results.value[currentResultIndex.value];
        }
        return null;
    });

    async function performSearch(query: string, pdfDocument: PDFDocumentProxy) {
        const runId = ++searchRunId;

        if (!query.trim()) {
            if (runId === searchRunId) {
                isSearching.value = false;
            }
            results.value = [];
            pageMatches.value = new Map();
            currentResultIndex.value = -1;
            return;
        }

        isSearching.value = true;
        const searchResults: IPdfSearchMatch[] = [];
        const newPageMatches = new Map<number, IPdfPageMatches>();
        const lowerQuery = query.toLowerCase();

        try {
            const numPages = pdfDocument.numPages;

            for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
                if (runId !== searchRunId) {
                    return;
                }

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

                const lowerPageText = pageText.toLowerCase();
                let matchIndex = 0;
                let position = 0;
                const matchesOnPage: Array<{
                    start: number;
                    end: number 
                }> = [];

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    const startOffset = position;
                    const endOffset = position + query.length;

                    searchResults.push({
                        pageIndex,
                        matchIndex,
                        startOffset,
                        endOffset,
                    });

                    matchesOnPage.push({
                        start: startOffset,
                        end: endOffset,
                    });

                    matchIndex++;
                    position += lowerQuery.length;
                }

                if (matchesOnPage.length > 0) {
                    newPageMatches.set(pageIndex, {
                        pageIndex,
                        matches: matchesOnPage,
                    });
                }
            }

            if (runId !== searchRunId) {
                return;
            }

            results.value = searchResults;
            pageMatches.value = newPageMatches;
            currentResultIndex.value = searchResults.length > 0 ? 0 : -1;
        } finally {
            if (runId === searchRunId) {
                isSearching.value = false;
            }
        }
    }

    const debouncedSearch = useDebounceFn(performSearch, 300);

    async function search(query: string, pdfDocument: PDFDocumentProxy) {
        searchQuery.value = query;
        if (!query.trim()) {
            clearSearch();
            return;
        }
        await debouncedSearch(query, pdfDocument);
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
        debouncedSearch.cancel();
        isSearching.value = false;
        searchQuery.value = '';
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;
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
        search,
        goToResult,
        setResultIndex,
        clearSearch,
        getMatchesForPage,
    };
};
