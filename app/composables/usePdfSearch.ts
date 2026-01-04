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

    async function performSearch(runId: number, query: string, pdfDocument: PDFDocumentProxy) {
        if (!query.trim()) {
            return;
        }

        if (runId !== searchRunId) {
            return;
        }

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
                        excerpt: buildExcerpt(pageText, startOffset, endOffset),
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

    async function search(query: string, pdfDocument: PDFDocumentProxy): Promise<boolean> {
        searchQuery.value = query;
        if (!query.trim()) {
            clearSearch();
            return false;
        }

        cancelScheduledSearch();
        const runId = ++searchRunId;
        isSearching.value = true;

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
