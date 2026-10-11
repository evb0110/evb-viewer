import type * as TDjvuWorkerModule from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {matchPdfSearchPageWindow} from '@pdf-core/pdfSearchCore';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    TSearchResultOffset,
} from '@contracts/search';
import type {PdfCombineCapabilityError} from '@electron/image/pdfCombineErrors';
import type {TDocumentRef} from '@contracts/documentRef';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    searchWorkerText: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    searchDjvuWorkerText: mocks.searchWorkerText,
}));

const { browserDjvuTextSearchCapability } = await import(
    '@app/platform/browser-api/browserDjvuTextSearchCapability'
);

interface ISearchWorkerOptionsForTest {
    resultOffset?: TSearchResultOffset;
    onProgress?: (progress: IPdfSearchProgress) => void;
    requestId: ReturnType<typeof requireRequestId>;
    signal: AbortSignal;
}

interface IWorkerForTest {
    source: TDocumentRef;
    terminate: ReturnType<typeof vi.fn>;
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function createSearchOptions(requestId: ReturnType<typeof requireRequestId>) {
    return {
        requestId,
        pageCount: 1,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    };
}

interface ISearchWorkerRequestForTest {
    id: number;
    type: string;
    payload: {
        text: string;
        query: string;
        options: {
            matchCase: boolean;
            wholeWord: boolean;
            useRegex: boolean
        };
        maxMatches: number;
        resultOffset?: TSearchResultOffset;
    };
}

type TSearchWorkerResponder = (worker: FakeSearchWorker, request: ISearchWorkerRequestForTest) => void;

/**
 * The browser search worker's wire behavior: a `started` message, then the
 * outcome. The shared client keeps one worker between searches, so requests
 * and terminations are counted for the whole test rather than per instance.
 */
class FakeSearchWorker {
    static requests: ISearchWorkerRequestForTest[] = [];
    static responder: TSearchWorkerResponder | null = null;
    static terminations = 0;
    private readonly messageListeners = new Set<(event: MessageEvent) => void>();

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === 'message') this.messageListeners.add(listener);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === 'message') this.messageListeners.delete(listener);
    }

    postMessage(request: ISearchWorkerRequestForTest) {
        FakeSearchWorker.requests.push(request);
        FakeSearchWorker.responder?.(this, request);
    }

    terminate() {
        FakeSearchWorker.terminations += 1;
    }

    dispatch(data: unknown) {
        this.messageListeners.forEach(listener => listener({data} as MessageEvent));
    }
}

// A catastrophic expression runs after the worker reports its start, and never returns.
const stallingResponder: TSearchWorkerResponder = (worker, request) => {
    queueMicrotask(() => worker.dispatch({
        id: request.id,
        started: true,
    }));
};

const matchingResponder: TSearchWorkerResponder = (worker, request) => {
    queueMicrotask(() => {
        worker.dispatch({
            id: request.id,
            started: true,
        });
        const {
            text, query, options, maxMatches, resultOffset,
        } = request.payload;
        worker.dispatch({
            id: request.id,
            type: request.type,
            ok: true,
            data: {
                ...matchPdfSearchPageWindow(text, query, options, maxMatches, resultOffset),
                matchingMs: 0,
            },
        });
    });
};

function createDjvuTextWorkerForTest(pages: readonly string[]) {
    return {
        doc: {
            getPagesQuantity: () => ({run: async () => pages.length}),
            getPagesSizes: () => ({run: async () => pages.map(() => ({
                width: 612,
                height: 792,
            }))}),
            getPage: (pageNumber: number) => ({
                getText: () => ({run: async () => pages[pageNumber - 1] ?? ''}),
                getNormalizedTextZones: () => ({run: async () => null}),
            }),
        },
        terminate: vi.fn(),
    };
}

describe('browserDjvuTextSearchCapability', () => {
    const calls: Array<{
        deferred: ReturnType<typeof createDeferred<IPdfSearchResponse>>;
        options: ISearchWorkerOptionsForTest;
        worker: IWorkerForTest;
    }> = [];

    beforeEach(() => {
        calls.length = 0;
        vi.clearAllMocks();
        mocks.createWorker.mockImplementation(async (source: TDocumentRef) => ({
            source,
            terminate: vi.fn(),
        }));
        mocks.searchWorkerText.mockImplementation((
            worker: IWorkerForTest,
            options: ISearchWorkerOptionsForTest,
        ) => {
            const deferred = createDeferred<IPdfSearchResponse>();
            calls.push({
                deferred,
                options,
                worker,
            });
            return deferred.promise;
        });
    });

    it.each([
        500,
        'last',
    ] as const)('returns the requested DjVu window at %s', async resultOffset => {
        mocks.searchWorkerText.mockImplementation((_worker, options: ISearchWorkerOptionsForTest) => {
            const response = matchPdfSearchPageWindow('valve '.repeat(561), 'valve', {}, 500, options.resultOffset);
            return {
                results: response.matches.map(match => ({
                    ...match,
                    pageNumber: requirePageNumber(1),
                    matchIndex: match.pageMatchIndex,
                })),
                truncated: response.truncated,
            };
        });
        const response = await browserDjvuTextSearchCapability.searchText(requireDocumentRef('browser://documents/dense.djvu'), 'valve', {
            ...createSearchOptions(requireRequestId('window-request')),
            resultOffset,
        });
        expect(response.results).toHaveLength(resultOffset === 500 ? 61 : 500);
        expect(response.results[0]?.matchIndex).toBe(resultOffset === 500 ? 500 : 61);
        expect(response.results.at(-1)?.matchIndex).toBe(560);
        expect(response.truncated).toBe(false);
    });

    it('lets the same request ID run concurrently on different document sources and cancels all matches', async () => {
        const requestId = requireRequestId('shared-browser-search');
        const firstRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/first.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        const secondRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/second.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(2));

        expect(calls[0]!.options.signal.aborted).toBe(false);
        expect(calls[1]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[0]!.options.signal.aborted).toBe(true);
        expect(calls[1]!.options.signal.aborted).toBe(true);

        const replacementRun = browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('browser://documents/replacement.djvu'),
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[0]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        calls[1]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await Promise.all([
            firstRun,
            secondRun,
        ]);

        expect(calls[2]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[2]!.options.signal.aborted).toBe(true);
        calls[2]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await replacementRun;
        expect(calls.map(call => call.worker.terminate.mock.calls.length)).toEqual([
            1,
            1,
            1,
        ]);
    });

    it('supersedes only the same source generation and suppresses its late progress', async () => {
        const requestId = requireRequestId('same-source-browser-search');
        const progress: IPdfSearchProgress[] = [];
        const unsubscribe = browserDjvuTextSearchCapability.onTextSearchProgress((event) => {
            progress.push(event);
        });
        try {
            const firstRun = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/book.djvu'),
                'first',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const currentRun = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/book.djvu'),
                'current',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(2));

            expect(calls[0]!.options.signal.aborted).toBe(true);
            expect(calls[1]!.options.signal.aborted).toBe(false);
            calls[0]!.options.onProgress?.({
                requestId,
                processed: 99,
                total: 100,
                status: 'running',
            });
            calls[1]!.options.onProgress?.({
                requestId,
                processed: 1,
                total: 100,
                status: 'running',
            });

            calls[0]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            calls[1]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            await Promise.all([
                firstRun,
                currentRun,
            ]);
            expect(progress.map(event => event.processed)).toEqual([1]);
        } finally {
            unsubscribe();
        }
    });

    it('refuses an absolute path without a native DjVu bridge before creating a worker', async () => {
        const electronApi = createElectronPlatformApiFixture();
        Reflect.deleteProperty(electronApi.djvu, 'getInfo');
        vi.stubGlobal('window', {electronAPI: electronApi});
        mocks.createWorker.mockRejectedValue(new Error('browser DjVu worker must not be created'));

        await expect(browserDjvuTextSearchCapability.searchText(
            requireDocumentRef('/tmp/native.djvu'),
            'needle',
            createSearchOptions(requireRequestId('native-bridge-missing')),
        )).rejects.toMatchObject({
            code: 'native-unavailable',
            name: 'PdfCombineCapabilityError',
            operation: 'djvu-text-search',
        } satisfies Partial<PdfCombineCapabilityError>);

        expect(mocks.createWorker).not.toHaveBeenCalled();
    });

    describe('regex matching in the browser search worker', () => {
        beforeEach(async () => {
            FakeSearchWorker.requests = [];
            FakeSearchWorker.terminations = 0;
            const djvuWorkerModule = await vi.importActual<typeof TDjvuWorkerModule>(
                '@app/platform/browser-api/createDjvuWorkerFromPath',
            );
            mocks.searchWorkerText.mockImplementation(djvuWorkerModule.searchDjvuWorkerText);
            vi.stubGlobal('window', {});
            vi.stubGlobal('Worker', FakeSearchWorker);
        });

        afterEach(() => {
            FakeSearchWorker.responder = null;
            vi.unstubAllGlobals();
        });

        it('stops a catastrophic DjVu regex with the search budget error', async () => {
            FakeSearchWorker.responder = stallingResponder;
            mocks.createWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['a'.repeat(250_000) + '!']));
            const startedAt = performance.now();

            await expect(browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/catastrophic.djvu'),
                'a+$',
                {
                    ...createSearchOptions(requireRequestId('catastrophic-djvu-regex')),
                    useRegex: true,
                },
            )).rejects.toMatchObject({
                name: 'SearchRegexLimitError',
                code: 'SEARCH_REGEX_LIMIT',
            });
            expect(performance.now() - startedAt).toBeLessThan(5_000);
            expect(FakeSearchWorker.requests).toHaveLength(1);
        });

        it.each([
            500,
            'last',
        ] as const)('returns the DjVu regex window at %s from the search worker', async (resultOffset) => {
            FakeSearchWorker.responder = matchingResponder;
            mocks.createWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['valve '.repeat(561)]));

            const response = await browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/dense-regex.djvu'),
                'valve',
                {
                    ...createSearchOptions(requireRequestId('regex-window')),
                    resultOffset,
                    useRegex: true,
                },
            );

            expect(response.results).toHaveLength(resultOffset === 500 ? 61 : 500);
            expect(response.results[0]?.matchIndex).toBe(resultOffset === 500 ? 500 : 61);
            expect(response.results.at(-1)?.matchIndex).toBe(560);
            expect(response.truncated).toBe(false);
            expect(FakeSearchWorker.requests).toHaveLength(1);
        });

        it('keeps another document searching when a DjVu regex is canceled', async () => {
            const pending: Array<{
                worker: FakeSearchWorker;
                request: ISearchWorkerRequestForTest
            }> = [];
            FakeSearchWorker.responder = (worker, request) => pending.push({
                worker,
                request,
            });
            mocks.createWorker.mockImplementation(async (source: TDocumentRef) => createDjvuTextWorkerForTest([source.includes('first') ? 'a'.repeat(250_000) + '!' : 'hello']));
            const firstId = requireRequestId('isolated-first-regex');
            const first = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/first.djvu'), 'a+.a+$',
                {
                    ...createSearchOptions(firstId),
                    useRegex: true,
                },
            ).catch((error: unknown) => error);
            const second = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/second.djvu'), 'hello',
                {
                    ...createSearchOptions(requireRequestId('isolated-second-regex')),
                    useRegex: true,
                },
            );
            await vi.waitFor(() => expect(pending).toHaveLength(2));
            await browserDjvuTextSearchCapability.cancelTextSearch(firstId);
            expect(await first).toMatchObject({name: 'AbortError'});
            const sibling = pending.find(entry => entry.request.payload.query === 'hello')!;
            matchingResponder(sibling.worker, sibling.request);
            const response = await second;
            expect(response.results.map(result => result.excerpt.match)).toEqual(['hello']);
            expect(response.truncated).toBe(false);
        });

        it('cancels a stalled DjVu regex worker when its search is canceled', async () => {
            FakeSearchWorker.responder = stallingResponder;
            mocks.createWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['a'.repeat(250_000) + '!']));
            const requestId = requireRequestId('canceled-djvu-regex');
            const search = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/canceled-regex.djvu'),
                'a+$',
                {
                    ...createSearchOptions(requestId),
                    useRegex: true,
                },
            );
            await vi.waitFor(() => expect(FakeSearchWorker.requests).toHaveLength(1));

            const startedAt = performance.now();
            await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
                .resolves.toEqual({canceled: true});

            await expect(search).rejects.toMatchObject({name: 'AbortError'});
            expect(performance.now() - startedAt).toBeLessThan(1_000);
            expect(FakeSearchWorker.terminations).toBe(1);
        });
    });
});
