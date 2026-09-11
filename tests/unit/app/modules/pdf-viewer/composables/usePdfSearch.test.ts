import { requireEpochMs } from '@contracts/timestamps';
import { requirePageIndex } from '@contracts/pageNumbers';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import type {
    IPdfSearchResponse, ISearchErrorEnvelope,
} from '@contracts/search';
import {
    ref,
    type Ref,
} from 'vue';
import type * as TimeoutConstants from '@app/constants/timeouts';
import { SEARCH_DEBOUNCE_MS } from '@app/constants/timeouts';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {
    createPlatformApiFixtureOperation,
    type IPlatformApiFixtureEventMethod,
} from '@tests/helpers/createDefaultPlatformApiFixtureMethod';
import type { usePdfSearch as TUsePdfSearch } from '@app/modules/pdf-viewer/runtime/composables/usePdfSearch';

interface IPdfSearchTestExcerpt {
    after: string;
    before: string;
    match: string;
}

interface IPdfSearchBackendMatch {
    endOffset: number;
    excerpt?: IPdfSearchTestExcerpt;
    matchIndex: number;
    pageMatchIndex: number;
    pageNumber: number;
    startOffset: number;
}

interface IPdfSearchTestProgress {
    processed: number;
    requestId: string;
    results?: IPdfSearchBackendMatch[];
    resultsStartIndex?: number;
    total: number;
    canceled?: boolean;
    truncated?: boolean;
}

interface IPdfSearchRunOptions {
    documentRevision?: string;
    pageCount?: number;
    requestId: string;
}

interface IPdfSearchRunResult {
    results: unknown[];
    truncated: boolean;
    canceled?: boolean;
}

const mockSearch = {
    onProgress: vi.fn<(listener: (progress: IPdfSearchTestProgress) => void) => () => void>(),
    run: vi.fn<(pdfPath: string, query: string, options: IPdfSearchRunOptions) => Promise<IPdfSearchRunResult>>(),
    cancel: vi.fn<() => void>(),
    resetCache: vi.fn<() => void>(),
};
vi.mock('@app/utils/getSearchCapability', () => ({ getSearchCapability: () => mockSearch }));
vi.mock('#imports', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));

/** Lets `search()` run past its internal awaits and reach its debounce filter. */
async function flushToScheduledSearch() {
    for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve();
    }
}

type TPdfSearchApi = ReturnType<typeof TUsePdfSearch>;

async function createPdfSearch(options?: { documentRevisionToken?: Ref<TDocumentRevisionToken | null> }): Promise<Omit<TPdfSearchApi, 'getMatchesForPage'> & {getMatchesForPage: (pageIndex: number) => ReturnType<TPdfSearchApi['getMatchesForPage']>;}> {
    const { usePdfSearch } = await import('@app/modules/pdf-viewer/runtime/composables/usePdfSearch');
    const search = usePdfSearch(options);
    return {
        ...search,
        getMatchesForPage: (pageIndex: number) => search.getMatchesForPage(requirePageIndex(pageIndex)),
    };
}

describe('usePdfSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mockSearch.onProgress.mockReturnValue(vi.fn());
        mockSearch.run.mockResolvedValue({
            results: [],
            truncated: false,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.doUnmock('@app/constants/timeouts');
        vi.resetModules();
    });

    it('allows single-character queries', async () => {
        const search = await createPdfSearch();

        const promise = search.search('a', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(true);
        expect(search.results.value).toEqual([]);
        expect(search.currentResultIndex.value).toBe(-1);
        expect(search.isSearching.value).toBe(false);
        expect(search.submittedSearchQuery.value).toBe('a');
        expect(mockSearch.run).toHaveBeenCalledWith('/tmp/work.pdf', 'a', expect.any(Object));
    });

    it('preserves leading and trailing spaces inside an explicitly quoted query', async () => {
        const search = await createPdfSearch();

        const promise = search.search('  " a "  ', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await promise;

        expect(mockSearch.run).toHaveBeenCalledWith('/tmp/work.pdf', ' a ', expect.any(Object));
        expect(search.submittedSearchQuery.value).toBe(' a ');
    });

    it('passes a quoted single space to the search backend', async () => {
        const search = await createPdfSearch();

        const promise = search.search('" "', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await promise;

        expect(mockSearch.run).toHaveBeenCalledWith('/tmp/work.pdf', ' ', expect.any(Object));
        expect(search.submittedSearchQuery.value).toBe(' ');
    });

    it('keeps an unquoted whitespace-only query empty', async () => {
        const search = await createPdfSearch();

        const applied = await search.search(' \t\n', '/tmp/work.pdf');

        expect(applied).toBe(false);
        expect(mockSearch.run).not.toHaveBeenCalled();
        expect(search.submittedSearchQuery.value).toBe('');
    });

    it('replaces the previous submitted query with a single-character search', async () => {
        mockSearch.run.mockResolvedValue({
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
        });
        const search = await createPdfSearch();

        const firstSearch = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await firstSearch;

        expect(search.submittedSearchQuery.value).toBe('alpha');
        expect(search.results.value).toHaveLength(1);

        mockSearch.run.mockResolvedValue({
            results: [],
            truncated: false,
        });
        const nextSearch = search.search('a', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await nextSearch;

        expect(applied).toBe(true);
        expect(search.submittedSearchQuery.value).toBe('a');
        expect(search.results.value).toEqual([]);
    });

    it('maps backend matches to result and page match state', async () => {
        const progressUnsubscribe = vi.fn();
        let progressListener: ((progress: {
            requestId: string;
            processed: number;
            total: number;
        }) => void) | null = null;

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return progressUnsubscribe;
        });

        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            progressListener?.({
                requestId: options.requestId,
                processed: 3,
                total: 10,
            });

            return {
                results: [
                    {
                        pageNumber: 2,
                        pageMatchIndex: 1,
                        matchIndex: 11,
                        startOffset: 20,
                        endOffset: 24,
                        excerpt: {
                            before: 'before',
                            match: 'term',
                            after: 'after',
                        },
                    },
                    {
                        pageNumber: 2,
                        pageMatchIndex: 2,
                        matchIndex: 12,
                        startOffset: 30,
                        endOffset: 35,
                        excerpt: {
                            before: 'before2',
                            match: 'term',
                            after: 'after2',
                        },
                    },
                ],
                truncated: true,
            };
        });
        const search = await createPdfSearch();

        const promise = search.search('term', '/tmp/work.pdf', 10);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(true);
        expect(search.isSearching.value).toBe(false);
        expect(search.totalMatches.value).toBe(2);
        expect(search.currentMatch.value).toBe(1);
        expect(search.currentResultNavigationId.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 1,
            pageMatchIndex: 1,
            matchIndex: 11,
            startOffset: 20,
            endOffset: 24,
        }));
        expect(search.isTruncated.value).toBe(true);
        expect(search.searchProgress.value).toBeUndefined();
        expect(progressUnsubscribe).toHaveBeenCalledOnce();

        const matchesForPage = search.getMatchesForPage(1);
        expect(matchesForPage).not.toBeNull();
        expect(matchesForPage?.searchQuery).toBe('term');
        expect(matchesForPage?.matches).toEqual([
            {
                matchIndex: 11,
                start: 20,
                end: 24,
            },
            {
                matchIndex: 12,
                start: 30,
                end: 35,
            },
        ]);
    });

    it('shows streamed matches before the backend finishes the full document search', async () => {
        let progressListener: ((progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void) | null = null;
        let resolveSearch: (value: {
            results: unknown[];
            truncated: boolean;
        }) => void = () => {};

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => new Promise((resolve) => {
            progressListener?.({
                requestId: options.requestId,
                processed: 3,
                total: 928,
                results: [{
                    pageNumber: 3,
                    pageMatchIndex: 0,
                    matchIndex: 0,
                    startOffset: 8,
                    endOffset: 12,
                }],
                truncated: false,
            });
            resolveSearch = resolve;
        }));
        const search = await createPdfSearch();

        const promise = search.search('араб', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(search.isSearching.value).toBe(true);
        expect(search.hasPartialResults.value).toBe(true);
        expect(search.totalMatches.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 2,
            startOffset: 8,
            endOffset: 12,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [],
            truncated: false,
        });
        await promise;
        expect(search.isSearching.value).toBe(false);
        expect(search.hasPartialResults.value).toBe(false);
    });

    it('preserves explicit backend cancellation state', async () => {
        mockSearch.run.mockResolvedValueOnce({
            results: [],
            truncated: false,
            canceled: true,
        });
        const search = await createPdfSearch();

        const searchPromise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await expect(searchPromise).resolves.toBe(true);

        expect(search.wasSearchCanceled.value).toBe(true);
        expect(search.results.value).toEqual([]);
        expect(search.isTruncated.value).toBe(false);
        expect(search.isSearching.value).toBe(false);
    });

    it('clears stale cancellation state when the search is cleared', async () => {
        mockSearch.run.mockResolvedValueOnce({
            results: [],
            truncated: false,
            canceled: true,
        });
        const search = await createPdfSearch();
        const searchPromise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await searchPromise;
        expect(search.wasSearchCanceled.value).toBe(true);

        search.clearSearch();

        expect(search.wasSearchCanceled.value).toBe(false);
    });

    it('keeps match navigation stable while streamed result batches grow', async () => {
        let requestId = '';
        let progressListener: (progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};

        const firstResult = {
            pageNumber: 3,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 8,
            endOffset: 12,
        };
        const secondResult = {
            pageNumber: 9,
            pageMatchIndex: 0,
            matchIndex: 1,
            startOffset: 18,
            endOffset: 22,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        progressListener({
            requestId,
            processed: 3,
            total: 928,
            results: [firstResult],
            truncated: false,
        });

        expect(search.totalMatches.value).toBe(1);
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        progressListener({
            requestId,
            processed: 6,
            total: 928,
            results: [
                firstResult,
                secondResult,
            ],
            truncated: false,
        });

        expect(search.totalMatches.value).toBe(2);
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [
                firstResult,
                secondResult,
            ],
            truncated: false,
        });
        await promise;

        expect(search.currentResultNavigationId.value).toBe(1);
    });

    it('accumulates streamed result deltas by start index', async () => {
        let requestId = '';
        let progressListener: (progress: IPdfSearchTestProgress) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: IPdfSearchBackendMatch[];
            truncated: boolean;
        }) => void = () => {};
        const firstResult: IPdfSearchBackendMatch = {
            pageNumber: 2,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 10,
            endOffset: 15,
        };
        const secondResult: IPdfSearchBackendMatch = {
            pageNumber: 5,
            pageMatchIndex: 0,
            matchIndex: 1,
            startOffset: 30,
            endOffset: 35,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        progressListener({
            requestId,
            processed: 2,
            total: 928,
            results: [firstResult],
            resultsStartIndex: 0,
            truncated: false,
        });
        progressListener({
            requestId,
            processed: 5,
            total: 928,
            results: [secondResult],
            resultsStartIndex: 1,
            truncated: false,
        });

        expect(search.totalMatches.value).toBe(2);
        expect(search.results.value).toEqual([
            expect.objectContaining({
                pageIndex: 1,
                matchIndex: 0,
            }),
            expect.objectContaining({
                pageIndex: 4,
                matchIndex: 1,
            }),
        ]);
        expect(search.getMatchesForPage(1)?.matches).toEqual([{
            matchIndex: 0,
            start: 10,
            end: 15,
        }]);
        expect(search.getMatchesForPage(4)?.matches).toEqual([{
            matchIndex: 1,
            start: 30,
            end: 35,
        }]);

        resolveSearch({
            results: [
                firstResult,
                secondResult,
            ],
            truncated: false,
        });
        await promise;
    });

    it('preserves the active match target when streamed batches insert earlier results', async () => {
        let requestId = '';
        let progressListener: (progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated?: boolean;
        }) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};

        const initiallyVisibleResult = {
            pageNumber: 8,
            pageMatchIndex: 0,
            matchIndex: 3,
            startOffset: 40,
            endOffset: 45,
        };
        const earlierDiscoveredResult = {
            pageNumber: 6,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 12,
            endOffset: 17,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        progressListener({
            requestId,
            processed: 8,
            total: 928,
            results: [initiallyVisibleResult],
            truncated: false,
        });

        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 7,
            matchIndex: 3,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        progressListener({
            requestId,
            processed: 12,
            total: 928,
            results: [
                earlierDiscoveredResult,
                initiallyVisibleResult,
            ],
            truncated: false,
        });

        expect(search.currentResultIndex.value).toBe(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 7,
            matchIndex: 3,
        }));
        expect(search.currentResultNavigationId.value).toBe(1);

        resolveSearch({
            results: [
                earlierDiscoveredResult,
                initiallyVisibleResult,
            ],
            truncated: false,
        });
        await promise;

        expect(search.currentResultIndex.value).toBe(1);
        expect(search.currentResultNavigationId.value).toBe(1);
    });

    it('advances match navigation only for explicit result commands after initial selection', async () => {
        mockSearch.run.mockResolvedValue({
            results: [
                {
                    pageNumber: 2,
                    pageMatchIndex: 0,
                    matchIndex: 4,
                    startOffset: 10,
                    endOffset: 15,
                    excerpt: {
                        before: '',
                        match: 'alpha',
                        after: '',
                    },
                },
                {
                    pageNumber: 7,
                    pageMatchIndex: 0,
                    matchIndex: 9,
                    startOffset: 20,
                    endOffset: 25,
                    excerpt: {
                        before: '',
                        match: 'alpha',
                        after: '',
                    },
                },
            ],
            truncated: false,
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await promise;

        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(1);

        search.setResultIndex(1);
        expect(search.currentResult.value).toEqual(expect.objectContaining({
            pageIndex: 6,
            matchIndex: 9,
        }));
        expect(search.currentResultNavigationId.value).toBe(2);

        search.setResultIndex(1);
        expect(search.currentResultNavigationId.value).toBe(3);

        search.goToResult('next');
        expect(search.currentResultIndex.value).toBe(0);
        expect(search.currentResultNavigationId.value).toBe(4);
    });

    it('cancels active searches on clear and resets backend cache explicitly', async () => {
        let requestId = '';
        let resolveSearch: (value: {
            results: unknown[];
            truncated: boolean;
        }) => void = () => {};

        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise<{
                results: unknown[];
                truncated: boolean;
            }>((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const searchPromise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(mockSearch.run).toHaveBeenCalledOnce();
        expect(requestId).toContain('search-');

        search.clearSearch();

        expect(mockSearch.cancel).toHaveBeenCalledWith(requestId);
        expect(search.searchQuery.value).toBe('');
        expect(search.results.value).toEqual([]);

        resolveSearch({
            results: [],
            truncated: false,
        });
        await searchPromise;

        search.resetSearchCache();
        expect(mockSearch.resetCache).toHaveBeenCalledOnce();
    });

    it('invalidates the active run before awaiting backend cancellation', async () => {
        let firstRequestId = '';
        let resolveFirstSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};
        let resolveCancel: () => void = () => {};

        mockSearch.run.mockImplementation(async (_pdfPath, query, options) => {
            if (query === 'beta') {
                return {
                    results: [],
                    truncated: false,
                };
            }

            firstRequestId = options.requestId;
            return new Promise((resolve) => {
                resolveFirstSearch = resolve;
            });
        });
        mockSearch.cancel.mockImplementation(async () => new Promise<void>((resolve) => {
            resolveCancel = resolve;
        }));
        const search = await createPdfSearch();

        const firstSearch = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(mockSearch.run).toHaveBeenCalledOnce();

        const secondSearch = search.search('beta', '/tmp/work.pdf');
        await vi.waitFor(() => {
            expect(mockSearch.cancel).toHaveBeenCalledWith(firstRequestId);
        });

        resolveFirstSearch({
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 1,
                endOffset: 6,
            }],
            truncated: false,
        });
        await firstSearch;

        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(true);

        resolveCancel();
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await secondSearch;
    });

    it('settles three overlapping runs and schedules only the newest search after cancellation', async () => {
        let resolveFirstSearch: (value: IPdfSearchRunResult) => void = () => {};
        let resolveCancel: () => void = () => {};
        mockSearch.run.mockImplementation(async (_pdfPath, query) => {
            if (query === 'alpha') {
                return new Promise<IPdfSearchRunResult>((resolve) => {
                    resolveFirstSearch = resolve;
                });
            }
            return {
                results: [],
                truncated: false,
            };
        });
        mockSearch.cancel.mockImplementation(async () => new Promise<void>((resolve) => {
            resolveCancel = resolve;
        }));
        const search = await createPdfSearch();

        const firstSearch = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(mockSearch.run).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            'alpha',
            expect.any(Object),
        );

        const secondSearch = search.search('beta', '/tmp/work.pdf');
        await vi.waitFor(() => {
            expect(mockSearch.cancel).toHaveBeenCalledOnce();
        });
        const thirdSearch = search.search('gamma', '/tmp/work.pdf');
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        expect(mockSearch.run).toHaveBeenCalledTimes(2);
        expect(mockSearch.run).toHaveBeenLastCalledWith(
            '/tmp/work.pdf',
            'gamma',
            expect.any(Object),
        );

        resolveCancel();
        resolveFirstSearch({
            results: [],
            truncated: false,
        });

        await expect(firstSearch).resolves.toBe(false);
        await expect(secondSearch).resolves.toBe(false);
        await expect(thirdSearch).resolves.toBe(true);
        expect(mockSearch.run).not.toHaveBeenCalledWith(
            '/tmp/work.pdf',
            'beta',
            expect.any(Object),
        );
    });

    it('surfaces a localized search error when backend search fails', async () => {
        mockSearch.run.mockRejectedValue(new Error('ERR_BROWSER_SEARCH_TOO_LARGE'));
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const applied = await promise;

        expect(applied).toBe(false);
        expect(search.searchError.value).toBe('errors.search.browserTooLarge');
        expect(search.results.value).toEqual([]);
        expect(search.isSearching.value).toBe(false);
    });

    it('surfaces a typed search message from message-only IPC serialization', async () => {
        const envelope: ISearchErrorEnvelope = {
            code: 'SEARCH_PATH_DENIED',
            message: 'Search path denied',
            retryable: false,
            timestamp: requireEpochMs(123),
        };
        mockSearch.run.mockRejectedValue(new Error(encodeSerializableErrorEnvelope(envelope)));
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        await expect(promise).resolves.toBe(false);
        expect(search.searchError.value).toBe('Search path denied');
    });

    it.each([
        'EVB_SERIALIZABLE_ERROR:{malformed',
        encodeSerializableErrorEnvelope({
            code: 'SEARCH_UNKNOWN',
            message: 'Untrusted search error',
        }),
    ])('falls back for malformed or unknown search envelopes', async (message) => {
        mockSearch.run.mockRejectedValue(new Error(message));
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf');
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        await expect(promise).resolves.toBe(false);
        expect(search.searchError.value).toBe('errors.search.unavailable');
    });

    it('passes the current document revision and ignores stale progress and results', async () => {
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(requireDocumentRevisionToken('revision-a'));
        let requestId = '';
        let progressListener: (progress: {
            requestId: string;
            processed: number;
            total: number;
            results?: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
        }) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: {
            results: Array<{
                pageNumber: number;
                pageMatchIndex: number;
                matchIndex: number;
                startOffset: number;
                endOffset: number;
            }>;
            truncated: boolean;
        }) => void = () => {};

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return vi.fn();
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            expect(options.documentRevision).toBe('revision-a');
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch({documentRevisionToken});

        const searchPromise = search.search('alpha', '/tmp/work.pdf', 1);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        documentRevisionToken.value = requireDocumentRevisionToken('revision-b');
        progressListener({
            requestId,
            processed: 1,
            total: 1,
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
        });
        resolveSearch({
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
        });

        await expect(searchPromise).resolves.toBe(false);
        expect(search.results.value).toEqual([]);
        expect(search.searchProgress.value).toBeUndefined();
        expect(search.isSearching.value).toBe(false);
    });

    it('drops a scheduled search before it reaches the backend when the search tab is left', async () => {
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        search.cancelSearch();

        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        await expect(promise).resolves.toBe(false);
        expect(mockSearch.run).not.toHaveBeenCalled();
        expect(search.isSearching.value).toBe(false);
        expect(search.searchQuery.value).toBe('alpha');
    });

    it('clears the pending debounce timer instead of leaving it to fire', async () => {
        const timeouts = await vi.importActual<typeof TimeoutConstants>('@app/constants/timeouts');
        vi.doMock('@app/constants/timeouts', () => ({
            ...timeouts,
            SEARCH_DEBOUNCE_MS: 50,
        }));
        vi.resetModules();
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await flushToScheduledSearch();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        search.cancelSearch();

        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(50);
        await expect(promise).resolves.toBe(false);
        expect(mockSearch.run).not.toHaveBeenCalled();
    });

    it('cancels the in-flight backend request and ignores everything it reports afterwards', async () => {
        let requestId = '';
        let progressListener: (progress: IPdfSearchTestProgress) => void = () => {
            throw new Error('Progress listener was not registered');
        };
        let resolveSearch: (value: IPdfSearchRunResult) => void = () => {};
        const unsubscribeProgress = vi.fn();
        const match = {
            pageNumber: 3,
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 8,
            endOffset: 12,
        };

        mockSearch.onProgress.mockImplementation((listener) => {
            progressListener = listener;
            return unsubscribeProgress;
        });
        mockSearch.run.mockImplementation(async (_pdfPath, _query, options) => {
            requestId = options.requestId;
            return new Promise((resolve) => {
                resolveSearch = resolve;
            });
        });
        const search = await createPdfSearch();

        const promise = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        expect(search.isSearching.value).toBe(true);

        search.cancelSearch();

        expect(mockSearch.cancel).toHaveBeenCalledWith(requestId);
        expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
        expect(search.isSearching.value).toBe(false);

        progressListener({
            requestId,
            processed: 400,
            total: 928,
            results: [match],
            truncated: true,
        });

        expect(search.results.value).toEqual([]);
        expect(search.searchProgress.value).toBeUndefined();
        expect(search.isTruncated.value).toBe(false);

        resolveSearch({
            results: [match],
            truncated: true,
        });
        await expect(promise).resolves.toBe(false);

        expect(search.results.value).toEqual([]);
        expect(search.isTruncated.value).toBe(false);
        expect(search.isSearching.value).toBe(false);
        expect(search.submittedSearchQuery.value).toBe('alpha');
    });

    it('drives a real search consumer with replay, cancellation, late events and typed failure controls', async () => {
        const operation = createPlatformApiFixtureOperation<IPdfSearchResponse>();
        const fixture = createElectronPlatformApiFixture({search: {run: operation.method}});
        const event = fixture.search.onProgress as typeof fixture.search.onProgress & IPlatformApiFixtureEventMethod<IPdfSearchTestProgress>;
        mockSearch.onProgress.mockImplementation(listener => fixture.search.onProgress(progress => listener({
            requestId: String(progress.requestId),
            processed: progress.processed,
            total: progress.total,
            ...(progress.results === undefined ? {} : {results: progress.results.map(result => ({...result}))}),
            ...(progress.resultsStartIndex === undefined ? {} : {resultsStartIndex: progress.resultsStartIndex}),
            ...(progress.canceled === undefined ? {} : {canceled: progress.canceled}),
            ...(progress.truncated === undefined ? {} : {truncated: progress.truncated}),
        })));
        mockSearch.run.mockImplementation(async (pdfPath, query) => {
            const response = await fixture.search.run(pdfPath, query);
            return {
                ...response,
                results: [...response.results],
            };
        });
        mockSearch.cancel.mockImplementation(() => {
            operation.cancel();
        });
        const search = await createPdfSearch();

        const canceled = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        const requestId = mockSearch.run.mock.calls[0]?.[2]?.requestId;
        if (typeof requestId !== 'string') {
            throw new Error('Expected the fixture search request to have an ID');
        }

        event.replay({
            requestId,
            processed: 1,
            total: 928,
        });
        expect(search.searchProgress.value).toEqual({
            processed: 1,
            total: 928,
        });
        search.cancelSearch();
        event.emitLate({
            requestId,
            processed: 928,
            total: 928,
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
        });
        await expect(canceled).resolves.toBe(false);
        expect(search.results.value).toEqual([]);

        const failedOperation = createPlatformApiFixtureOperation<IPdfSearchResponse>();
        const failedFixture = createElectronPlatformApiFixture({search: {run: failedOperation.method}});
        mockSearch.onProgress.mockImplementation(listener => failedFixture.search.onProgress(progress => listener({
            requestId: String(progress.requestId),
            processed: progress.processed,
            total: progress.total,
            ...(progress.results === undefined ? {} : {results: progress.results.map(result => ({...result}))}),
            ...(progress.resultsStartIndex === undefined ? {} : {resultsStartIndex: progress.resultsStartIndex}),
            ...(progress.canceled === undefined ? {} : {canceled: progress.canceled}),
            ...(progress.truncated === undefined ? {} : {truncated: progress.truncated}),
        })));
        mockSearch.run.mockImplementation(async (pdfPath, query) => {
            const response = await failedFixture.search.run(pdfPath, query);
            return {
                ...response,
                results: [...response.results],
            };
        });
        const failed = search.search('beta', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
        failedOperation.reject(new Error('fixture search failure'));
        await expect(failed).resolves.toBe(false);
        expect(search.searchError.value).toBe('errors.search.unavailable');
    });

    it('keeps a canceled search restartable', async () => {
        const search = await createPdfSearch();
        const abandoned = search.search('alpha', '/tmp/work.pdf', 928);
        search.cancelSearch();
        await expect(abandoned).resolves.toBe(false);

        mockSearch.run.mockResolvedValueOnce({
            results: [{
                pageNumber: 2,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
        });
        const restarted = search.search('alpha', '/tmp/work.pdf', 928);
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

        await expect(restarted).resolves.toBe(true);
        expect(search.results.value).toHaveLength(1);
    });
});
