import {
    effectScope,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';
import { useDocumentSearchSession } from '@app/modules/workspace-shell/composables/useDocumentSearchSession';
import type {
    IDocumentSearchBackend,
    IDocumentSearchRequest,
    IDocumentSearchResponse,
} from '@app/utils/document-viewer/search/documentSearch';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return {
        promise,
        resolve,
    };
}

function createMatch(pageIndex: number, matchIndex: number) {
    return {
        pageIndex,
        pageMatchIndex: matchIndex,
        matchIndex,
        startOffset: matchIndex,
        endOffset: matchIndex + 1,
    };
}

function withSession<T>(factory: () => T) {
    const scope = effectScope();
    const session = scope.run(factory);
    if (!session) throw new Error('Document search test session failed to initialize');
    return {
        session,
        stop: () => scope.stop(),
    };
}

describe('useDocumentSearchSession', () => {
    it('owns query, progress, result selection, and cyclic navigation', async () => {
        const onNavigate = vi.fn();
        const search = vi.fn(async (request: IDocumentSearchRequest) => {
            request.onProgress?.({
                processed: 2,
                total: 4,
            });
            return {
                results: [
                    createMatch(1, 0),
                    createMatch(3, 1),
                ],
                truncated: true,
            };
        });
        const backend: IDocumentSearchBackend = {
            minQueryLength: 2,
            search,
        };
        const harness = withSession(() => useDocumentSearchSession({
            backend,
            onNavigate,
        }));

        harness.session.setQuery('  word  ');
        await expect(harness.session.run()).resolves.toBe(true);

        expect(search).toHaveBeenCalledWith(expect.objectContaining({query: 'word'}));
        expect(harness.session.submittedQuery.value).toBe('word');
        expect(harness.session.progress.value).toEqual({
            processed: 2,
            total: 4,
        });
        expect(harness.session.results.value).toHaveLength(2);
        expect(harness.session.isTruncated.value).toBe(true);
        expect(harness.session.currentResultIndex.value).toBe(0);
        expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({pageIndex: 1}), 0);

        expect(harness.session.navigate('next')).toBe(true);
        expect(harness.session.currentResultIndex.value).toBe(1);
        expect(harness.session.navigate('next')).toBe(true);
        expect(harness.session.currentResultIndex.value).toBe(0);
        expect(harness.session.navigate('previous')).toBe(true);
        expect(harness.session.currentResultIndex.value).toBe(1);
        expect(harness.session.currentResultNavigationId.value).toBe(4);
        harness.stop();
    });

    it('aborts an older run and rejects its late result', async () => {
        const requests: IDocumentSearchRequest[] = [];
        const responses: Array<ReturnType<typeof createDeferred<IDocumentSearchResponse>>> = [];
        const backend: IDocumentSearchBackend = {
            minQueryLength: 1,
            search: vi.fn((request) => {
                requests.push(request);
                const response = createDeferred<IDocumentSearchResponse>();
                responses.push(response);
                return response.promise;
            }),
        };
        const harness = withSession(() => useDocumentSearchSession({backend}));

        harness.session.setQuery('first');
        const firstRun = harness.session.run();
        harness.session.setQuery('second');
        const secondRun = harness.session.run();

        expect(requests[0]?.signal.aborted).toBe(true);
        responses[0]?.resolve({
            results: [createMatch(0, 0)],
            truncated: false,
        });
        await expect(firstRun).resolves.toBe(false);
        expect(harness.session.results.value).toEqual([]);

        responses[1]?.resolve({
            results: [createMatch(4, 0)],
            truncated: false,
        });
        await expect(secondRun).resolves.toBe(true);
        expect(harness.session.results.value[0]?.pageIndex).toBe(4);
        harness.stop();
    });

    it('clears state and fences progress when the document backend changes', async () => {
        const staleResponse = createDeferred<IDocumentSearchResponse>();
        const staleRequest = {current: null as IDocumentSearchRequest | null};
        const firstBackend: IDocumentSearchBackend = {
            minQueryLength: 1,
            search: (request) => {
                staleRequest.current = request;
                return staleResponse.promise;
            },
        };
        const backend = ref<IDocumentSearchBackend | null>(firstBackend);
        const harness = withSession(() => useDocumentSearchSession({backend}));

        harness.session.setQuery('document one');
        const run = harness.session.run();
        backend.value = {
            minQueryLength: 3,
            search: vi.fn(),
        };

        expect(staleRequest.current?.signal.aborted).toBe(true);
        expect(harness.session.query.value).toBe('');
        expect(harness.session.results.value).toEqual([]);
        staleRequest.current?.onProgress?.({
            processed: 9,
            total: 10,
        });
        expect(harness.session.progress.value).toBeUndefined();
        staleResponse.resolve({
            results: [createMatch(8, 0)],
            truncated: false,
        });
        await expect(run).resolves.toBe(false);
        expect(harness.session.results.value).toEqual([]);
        expect(harness.session.minQueryLength.value).toBe(3);
        harness.stop();
    });

    it('clears state and fences results when the document revision changes', async () => {
        const staleResponse = createDeferred<IDocumentSearchResponse>();
        const staleRequest = {current: null as IDocumentSearchRequest | null};
        const backend: IDocumentSearchBackend = {
            minQueryLength: 1,
            search: request => {
                staleRequest.current = request;
                return staleResponse.promise;
            },
        };
        const documentRevision = ref<string | null>('revision-1');
        const harness = withSession(() => useDocumentSearchSession({
            backend,
            documentRevision,
        }));

        harness.session.setQuery('document');
        const run = harness.session.run();
        documentRevision.value = 'revision-2';

        expect(staleRequest.current?.signal.aborted).toBe(true);
        expect(harness.session.query.value).toBe('');
        expect(harness.session.results.value).toEqual([]);
        staleResponse.resolve({
            results: [createMatch(8, 0)],
            truncated: false,
        });

        await expect(run).resolves.toBe(false);
        expect(harness.session.results.value).toEqual([]);
        harness.stop();
    });

    it('submits short queries for presentation without invoking the backend', async () => {
        const backend: IDocumentSearchBackend = {
            minQueryLength: 3,
            search: vi.fn(),
        };
        const harness = withSession(() => useDocumentSearchSession({backend}));

        harness.session.setQuery('ab');
        await expect(harness.session.run()).resolves.toBe(false);

        expect(backend.search).not.toHaveBeenCalled();
        expect(harness.session.submittedQuery.value).toBe('ab');
        expect(harness.session.isSearching.value).toBe(false);
        harness.stop();
    });
    it('reports the document-source contract minimum while no backend is attached', async () => {
        const backend = ref<IDocumentSearchBackend | null>(null);
        const harness = withSession(() => useDocumentSearchSession({backend}));

        expect(harness.session.minQueryLength.value).toBe(DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH);

        harness.session.setQuery('a');
        await expect(harness.session.run()).resolves.toBe(false);

        const search = vi.fn(async () => ({
            results: [createMatch(0, 0)],
            truncated: false,
        }));
        backend.value = {
            minQueryLength: 4,
            search,
        };

        expect(harness.session.minQueryLength.value).toBe(4);

        harness.session.setQuery('abc');
        await expect(harness.session.run()).resolves.toBe(false);
        expect(search).not.toHaveBeenCalled();

        harness.session.setQuery('abcd');
        await expect(harness.session.run()).resolves.toBe(true);
        expect(search).toHaveBeenCalledTimes(1);
        harness.stop();
    });
});
