import type {
    IResolvedSearchMatchOptions, TSearchResultOffset,
} from '@contracts/search';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    SEARCH_QUERY_MAX_LENGTH,
    SEARCH_REGEX_QUERY_MAX_LENGTH,
} from '@contracts/search';
import {
    buildPdfSearchExcerpt,
    iteratePdfSearchMatches,
    validateSearchQuery,
    SearchRegexLimitError,
} from '@pdf-core/pdfSearchCore';
import type { IDocumentTextProvider } from '@app/modules/document-viewer/source/documentPageSource';
import type {
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchResponse,
} from '@app/modules/document-viewer/search/documentSearch';

export type {
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchResponse,
} from '@app/modules/document-viewer/search/documentSearch';

export const DEFAULT_DOCUMENT_SEARCH_OPTIONS: IResolvedSearchMatchOptions = Object.freeze({
    matchCase: false,
    wholeWord: false,
    useRegex: false,
});

/** UI quotes preserve intentional outer spaces; providers receive the literal query. */
export function resolveDocumentSearchQuery(query: string) {
    const trimmed = query.trim();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
}

/** Classify only input validation, before a backend operation can fail. */
export function getDocumentSearchQueryError(query: string, options: IResolvedSearchMatchOptions) {
    const count = options.useRegex ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > count) {
        return {
            key: 'searchResults.queryTooLong' as const,
            count,
        };
    }
    try {
        validateSearchQuery(query, options);
        return null;
    } catch (error) {
        return {
            key: error instanceof SearchRegexLimitError
                ? 'searchResults.regexTooComplex' as const
                : 'searchResults.invalidRegex' as const,
            count,
        };
    }
}

export async function searchDocumentTextProvider(options: {
    provider: IDocumentTextProvider;
    pageCount: number;
    query: string;
    matchOptions: IResolvedSearchMatchOptions;
    resultOffset?: TSearchResultOffset;
    signal: AbortSignal;
    onProgress?: ((progress: IDocumentSearchProgress) => void) | undefined;
}): Promise<IDocumentSearchResponse> {
    const query = options.query;
    if (!query) {
        return {
            results: [],
            truncated: false,
        };
    }

    validateSearchQuery(query, options.matchOptions);
    const results: IDocumentSearchMatch[] = [];
    const resultOffset = options.resultOffset ?? 0;
    let matchIndex = 0;

    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
        options.signal.throwIfAborted();
        const text = await options.provider.getPageText(pageNumber, options.signal);
        options.signal.throwIfAborted();
        let pageMatchIndex = 0;
        for (const match of iteratePdfSearchMatches(text, query, options.matchOptions)) {
            const currentMatchIndex = matchIndex++;
            const currentPageMatchIndex = pageMatchIndex++;
            if (typeof resultOffset === 'number' && currentMatchIndex < resultOffset) continue;
            if (resultOffset !== 'last' && results.length >= SEARCH_RESULT_LIMIT) {
                return {
                    results,
                    truncated: true,
                };
            }
            const result = {
                pageIndex: pageNumber - 1,
                pageMatchIndex: currentPageMatchIndex,
                matchIndex: currentMatchIndex,
                startOffset: match.startOffset,
                endOffset: match.endOffset,
                excerpt: buildPdfSearchExcerpt(
                    text,
                    match.startOffset,
                    match.endOffset,
                    SEARCH_EXCERPT_CONTEXT_CHARS,
                ),
            };
            if (resultOffset === 'last') results[currentMatchIndex % SEARCH_RESULT_LIMIT] = result;
            else results.push(result);
        }

        options.onProgress?.({
            processed: pageNumber,
            total: options.pageCount,
        });
    }

    results.sort((first, second) => first.matchIndex - second.matchIndex);
    return {
        results,
        truncated: false,
    };
}
