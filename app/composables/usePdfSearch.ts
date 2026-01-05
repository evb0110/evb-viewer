import {
    computed,
    ref,
} from 'vue';
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

interface IBackendSearchResult {
    pageNumber: number;
    matchIndex: number;
    text: string;
    startOffset: number;
    endOffset: number;
    words: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    pageWidth?: number;
    pageHeight?: number;
}

function getElectronAPI() {
    if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Electron API not available');
    }
    return window.electronAPI;
}

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
        text: string,
        startOffset: number,
        endOffset: number,
    ): IPdfSearchMatch['excerpt'] {
        const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
        const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

        const before = text.slice(excerptStart, startOffset).replace(/\s+/g, ' ').trim();
        const match = text.slice(startOffset, endOffset);
        const after = text.slice(endOffset, excerptEnd).replace(/\s+/g, ' ').trim();

        return {
            prefix: excerptStart > 0,
            suffix: excerptEnd < text.length,
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

    async function performSearch(runId: number, query: string, pdfPath: string) {
        if (!query.trim()) {
            return;
        }

        if (runId !== searchRunId) {
            return;
        }

        try {
            // Call backend search API
            const api = getElectronAPI();
            const backendResults = await api.pdfSearch(pdfPath, query) as IBackendSearchResult[];

            if (runId !== searchRunId) {
                return;
            }

            // Transform backend results to frontend format
            const mergedResults: IPdfSearchMatch[] = [];
            const matchesMap = new Map<number, IPdfPageMatches>();

            backendResults.forEach(result => {
                mergedResults.push({
                    pageIndex: result.pageNumber - 1,
                    matchIndex: result.matchIndex,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                    excerpt: buildExcerpt(result.text, result.startOffset, result.endOffset),
                    words: result.words,
                    pageWidth: result.pageWidth,
                    pageHeight: result.pageHeight,
                });

                // Build page matches for highlighting
                const pageIndex = result.pageNumber - 1;
                if (!matchesMap.has(pageIndex)) {
                    matchesMap.set(pageIndex, {
                        pageIndex,
                        matches: [],
                    });
                }

                matchesMap.get(pageIndex)?.matches.push({
                    start: result.startOffset,
                    end: result.endOffset,
                    words: result.words,
                    pageWidth: result.pageWidth,
                    pageHeight: result.pageHeight,
                });
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
        } finally {
            if (runId === searchRunId) {
                isSearching.value = false;
            }
        }
    }

    async function search(query: string, pdfPath: string): Promise<boolean> {
        searchQuery.value = query;
        if (!query.trim()) {
            clearSearch();
            return false;
        }

        cancelScheduledSearch();
        const runId = ++searchRunId;
        isSearching.value = true;
        results.value = [];
        pageMatches.value = new Map();
        currentResultIndex.value = -1;

        return new Promise<boolean>((resolve) => {
            scheduledResolve = resolve;
            scheduledTimeout = setTimeout(async () => {
                scheduledTimeout = null;
                scheduledResolve = null;
                try {
                    await performSearch(runId, query, pdfPath);
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
