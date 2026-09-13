import type {
    IDocumentPageSource,
    IDocumentSearchProvider,
    IDocumentTextProvider,
} from '@app/modules/document-viewer/source/documentPageSource';
import { searchDocumentTextProvider } from '@app/modules/document-viewer/providers/documentSearch';
import type { IDocumentSearchBackend } from '@app/modules/document-viewer/search/documentSearch';
import { DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';

let nextDocumentSourceSearchRequestId = 0;

function createProviderBackend(provider: IDocumentSearchProvider): IDocumentSearchBackend {
    return {
        minQueryLength: DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH,
        async search(request) {
            const response = await provider.search({
                ...request,
                requestId: `document-source-search-${String(++nextDocumentSourceSearchRequestId)}`,
                onProgress: progress => request.onProgress?.({
                    processed: progress.processed,
                    total: progress.total,
                }),
            });
            return {
                results: response.results.map(result => ({
                    pageIndex: Number(result.pageNumber) - 1,
                    pageMatchIndex: result.pageMatchIndex,
                    matchIndex: result.matchIndex,
                    startOffset: result.startOffset,
                    endOffset: result.endOffset,
                    excerpt: result.excerpt,
                    ...(result.words === undefined ? {} : {words: result.words}),
                    ...(result.pageWidth === undefined ? {} : {pageWidth: result.pageWidth}),
                    ...(result.pageHeight === undefined ? {} : {pageHeight: result.pageHeight}),
                    ...(result.rotation === undefined ? {} : {rotation: result.rotation}),
                })),
                truncated: response.truncated,
            };
        },
    };
}

function createDocumentTextProviderSearchBackend(options: {
    provider: IDocumentTextProvider;
    pageCount: number;
}): IDocumentSearchBackend {
    return {
        minQueryLength: DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH,
        search: request => searchDocumentTextProvider({
            provider: options.provider,
            pageCount: options.pageCount,
            query: request.query,
            matchOptions: request.matchOptions,
            signal: request.signal,
            onProgress: request.onProgress,
        }),
    };
}

/** Prefers a source's indexed/native search and falls back to page-text scanning. */
export function createDocumentPageSourceSearchBackend(
    source: IDocumentPageSource | null,
): IDocumentSearchBackend | null {
    if (source?.searchProvider) {
        return createProviderBackend(source.searchProvider);
    }
    if (source?.textProvider) {
        return createDocumentTextProviderSearchBackend({
            provider: source.textProvider,
            pageCount: source.pageCount,
        });
    }
    return null;
}
