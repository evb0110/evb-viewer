import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createPdfDocumentSearchSession } from '@app/modules/pdf-viewer/search/createPdfDocumentSearchSession';
import { DEFAULT_DOCUMENT_SEARCH_OPTIONS } from '@app/modules/document-viewer/providers/documentSearch';
import { requirePageIndex } from '@contracts/pageNumbers';

describe('createPdfDocumentSearchSession', () => {
    it('projects the PDF engine through the shared search session contract', async () => {
        const run = vi.fn();
        const select = vi.fn();
        const navigate = vi.fn();
        const results = ref([{
            pageIndex: requirePageIndex(2),
            matchIndex: 0,
            startOffset: 4,
            endOffset: 8,
        }]);
        const session = createPdfDocumentSearchSession({
            query: ref('term'),
            submittedQuery: ref('term'),
            options: ref({...DEFAULT_DOCUMENT_SEARCH_OPTIONS}),
            results,
            currentResultIndex: ref(0),
            currentResultNavigationId: ref(1),
            isSearching: ref(false),
            error: ref(null),
            progress: ref(undefined),
            isTruncated: ref(false),
            minQueryLength: ref(1),
            setQuery: vi.fn(),
            setOptions: vi.fn(),
            run,
            clear: vi.fn(),
            cancel: vi.fn(),
            select,
            navigate,
        });

        expect(await session.run()).toBe(true);
        expect(session.select(0)).toBe(true);
        expect(session.navigate('next')).toBe(true);
        expect(run).toHaveBeenCalledOnce();
        expect(select).toHaveBeenCalledWith(0);
        expect(navigate).toHaveBeenCalledWith('next');
    });

    it('does not issue invalid result navigation', () => {
        const select = vi.fn();
        const navigate = vi.fn();
        const session = createPdfDocumentSearchSession({
            query: ref(''),
            submittedQuery: ref(''),
            options: ref({...DEFAULT_DOCUMENT_SEARCH_OPTIONS}),
            results: ref([]),
            currentResultIndex: ref(-1),
            currentResultNavigationId: ref(0),
            isSearching: ref(false),
            error: ref(null),
            progress: ref(undefined),
            isTruncated: ref(false),
            minQueryLength: ref(1),
            setQuery: vi.fn(),
            setOptions: vi.fn(),
            run: vi.fn(),
            clear: vi.fn(),
            cancel: vi.fn(),
            select,
            navigate,
        });

        expect(session.select(0)).toBe(false);
        expect(session.navigate('previous')).toBe(false);
        expect(select).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });
});
