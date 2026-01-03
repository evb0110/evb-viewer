import {
    computed,
    ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDebounceFn } from '@vueuse/core';

export interface IPdfSearchResult {
    pageIndex: number;
    matchIndex: number;
}

export type TSearchDirection = 'next' | 'previous';

export const usePdfSearch = () => {
    const searchQuery = ref('');
    const results = ref<IPdfSearchResult[]>([]);
    const currentResultIndex = ref(-1);
    const isSearching = ref(false);

    const totalMatches = computed(() => results.value.length);
    const currentMatch = computed(() => results.value.length > 0 ? currentResultIndex.value + 1 : 0);

    async function performSearch(query: string, pdfDocument: PDFDocumentProxy) {
        if (!query.trim()) {
            results.value = [];
            currentResultIndex.value = -1;
            return;
        }

        isSearching.value = true;
        const searchResults: IPdfSearchResult[] = [];
        const lowerQuery = query.toLowerCase();

        try {
            const numPages = pdfDocument.numPages;

            for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
                const page = await pdfDocument.getPage(pageIndex + 1);
                const textContent = await page.getTextContent();

                let pageText = '';
                for (const item of textContent.items) {
                    if ('str' in item) {
                        pageText += item.str;
                    }
                }

                const lowerPageText = pageText.toLowerCase();
                let matchIndex = 0;
                let position = 0;

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    searchResults.push({
                        pageIndex,
                        matchIndex,
                    });
                    matchIndex++;
                    position += lowerQuery.length;
                }
            }

            results.value = searchResults;
            currentResultIndex.value = searchResults.length > 0 ? 0 : -1;
        } finally {
            isSearching.value = false;
        }
    }

    const debouncedSearch = useDebounceFn(performSearch, 300);

    async function search(query: string, pdfDocument: PDFDocumentProxy) {
        searchQuery.value = query;
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

    function clearSearch() {
        searchQuery.value = '';
        results.value = [];
        currentResultIndex.value = -1;
    }

    return {
        searchQuery,
        results,
        currentResultIndex,
        isSearching,
        totalMatches,
        currentMatch,
        search,
        goToResult,
        clearSearch,
    };
};
