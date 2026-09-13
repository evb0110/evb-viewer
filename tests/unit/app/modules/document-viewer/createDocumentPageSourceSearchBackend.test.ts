import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { parsePageNumber } from '@contracts/pageNumbers';
import { DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';
import { DEFAULT_DOCUMENT_SEARCH_OPTIONS } from '@app/modules/document-viewer/providers/documentSearch';
import { createDocumentPageSourceSearchBackend } from '@app/modules/document-viewer/search/createDocumentPageSourceSearchBackend';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';
import {requireRequestId} from '@contracts/shared';

function asSource(source: Partial<IDocumentPageSource>) {
    return source as IDocumentPageSource;
}

describe('createDocumentPageSourceSearchBackend', () => {
    it('prefers the source search provider and maps wire results to document matches', async () => {
        const search = vi.fn(async (request: Parameters<NonNullable<IDocumentPageSource['searchProvider']>['search']>[0]) => {
            request.onProgress?.({
                requestId: requireRequestId(request.requestId),
                processed: 1,
                total: 3,
            });
            return {
                results: [{
                    pageNumber: parsePageNumber(2)!,
                    pageMatchIndex: 0,
                    matchIndex: 0,
                    startOffset: 4,
                    endOffset: 8,
                    excerpt: {
                        prefix: false,
                        suffix: false,
                        before: '',
                        match: 'word',
                        after: '',
                    },
                    words: [{
                        text: 'word',
                        x: 10,
                        y: 20,
                        width: 30,
                        height: 40,
                    }],
                    pageWidth: 100,
                    pageHeight: 200,
                    rotation: 0 as const,
                }],
                truncated: false,
            };
        });
        const getPageText = vi.fn();
        const backend = createDocumentPageSourceSearchBackend(asSource({
            pageCount: 3,
            searchProvider: {search},
            textProvider: {getPageText},
        }));
        const onProgress = vi.fn();

        const response = await backend!.search({
            query: 'word',
            matchOptions: DEFAULT_DOCUMENT_SEARCH_OPTIONS,
            signal: new AbortController().signal,
            onProgress,
        });

        expect(search).toHaveBeenCalledWith(expect.objectContaining({
            query: 'word',
            requestId: expect.stringMatching(/^document-source-search-/u),
        }));
        expect(getPageText).not.toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalledWith({
            processed: 1,
            total: 3,
        });
        expect(response.results[0]).toEqual(expect.objectContaining({
            pageIndex: 1,
            startOffset: 4,
            endOffset: 8,
            words: [{
                text: 'word',
                x: 10,
                y: 20,
                width: 30,
                height: 40,
            }],
            pageWidth: 100,
            pageHeight: 200,
            rotation: 0,
        }));
    });

    it('falls back to the page text provider when indexed search is unavailable', async () => {
        const getPageText = vi.fn().mockResolvedValue('searchable word');
        const backend = createDocumentPageSourceSearchBackend(asSource({
            pageCount: 1,
            textProvider: {getPageText},
        }));

        const response = await backend!.search({
            query: 'word',
            matchOptions: DEFAULT_DOCUMENT_SEARCH_OPTIONS,
            signal: new AbortController().signal,
        });

        expect(getPageText).toHaveBeenCalledTimes(1);
        expect(response.results).toHaveLength(1);
    });

    it('publishes the shared document-source minimum query length on both backends', () => {
        const providerBackend = createDocumentPageSourceSearchBackend(asSource({
            pageCount: 3,
            searchProvider: {search: vi.fn()},
            textProvider: {getPageText: vi.fn()},
        }));
        const textBackend = createDocumentPageSourceSearchBackend(asSource({
            pageCount: 3,
            textProvider: {getPageText: vi.fn()},
        }));

        expect(DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH).toBe(2);
        expect(providerBackend?.minQueryLength).toBe(DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH);
        expect(textBackend?.minQueryLength).toBe(DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH);
    });
});
