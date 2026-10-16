import type {IResolvedSearchMatchOptions} from '@contracts/search';
import {
    SEARCH_QUERY_MAX_LENGTH,
    SEARCH_REGEX_QUERY_MAX_LENGTH,
} from '@contracts/search';
import {
    validateSearchQuery,
    SearchRegexLimitError,
} from '@pdf-core/pdfSearchCore';
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
