import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    DEFAULT_DOCUMENT_SEARCH_OPTIONS,
    searchDocumentTextProvider,
} from '@app/modules/document-viewer/providers/documentSearch';

describe('searchDocumentTextProvider', () => {
    it('uses the shared search matcher and returns every match with bounded context', async () => {
        const getPageText = vi.fn()
            .mockResolvedValueOnce('first page')
            .mockResolvedValueOnce('DjVu is searchable. Another DjVu appears here.');
        const onProgress = vi.fn();

        const response = await searchDocumentTextProvider({
            provider: {getPageText},
            pageCount: 2,
            query: 'djvu',
            matchOptions: DEFAULT_DOCUMENT_SEARCH_OPTIONS,
            signal: new AbortController().signal,
            onProgress,
        });

        expect(response.results).toHaveLength(2);
        expect(response.results.map(result => result.pageIndex)).toEqual([
            1,
            1,
        ]);
        expect(response.results[0]?.excerpt?.match).toBe('DjVu');
        expect(response.truncated).toBe(false);
        expect(getPageText).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenLastCalledWith({
            processed: 2,
            total: 2,
        });
    });

    it('stops before reading a page when cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const getPageText = vi.fn();

        await expect(searchDocumentTextProvider({
            provider: {getPageText},
            pageCount: 3,
            query: 'text',
            matchOptions: DEFAULT_DOCUMENT_SEARCH_OPTIONS,
            signal: controller.signal,
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(getPageText).not.toHaveBeenCalled();
    });
});
