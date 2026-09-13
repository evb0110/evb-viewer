import type { TTranslateFn } from '@i18n-app';

interface IDocumentSearchResultsSummaryOptions {
    isSearching: boolean;
    query: string;
    resultCount: number;
    t: TTranslateFn;
}

export function formatDocumentSearchResultsSummary(options: IDocumentSearchResultsSummaryOptions) {
    const {
        isSearching,
        query,
        resultCount,
        t,
    } = options;

    if (isSearching && resultCount === 0) {
        return t('searchResults.searching');
    }

    return `${t('searchResults.resultCount', { count: resultCount })} ${t('searchResults.forQuery', { query })}`;
}
