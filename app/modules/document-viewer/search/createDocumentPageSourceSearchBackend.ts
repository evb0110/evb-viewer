import type {
    IDocumentPageSource,
    IDocumentSearchProvider,
} from '@app/modules/document-viewer/source/documentPageSource';
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
                    ...(progress.coverage ? {coverage: progress.coverage} : {}),
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
                ...(response.coverage ? {coverage: response.coverage} : {}),
            };
        },
    };
}

/** Uses the format's indexed/native search provider. */
export function createDocumentPageSourceSearchBackend(
    source: IDocumentPageSource | null,
): IDocumentSearchBackend | null {
    if (source?.searchProvider) {
        return createProviderBackend(source.searchProvider);
    }
    return null;
}
