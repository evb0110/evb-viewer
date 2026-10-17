import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as TDjvuWorkerModule from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {
    matchPdfSearchPageWindow,
    type IResolvedSearchMatchOptions,
} from '@pdf-core/pdfSearchCore';
import type { TSearchResultOffset } from '@contracts/search';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireRequestId } from '@contracts/shared';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_SEARCH_WORKER_FAILED',
    occurredAt: 1,
    severity: 'error',
};
const failureReporter = {capture: vi.fn(() => failureReceipt)};

vi.mock('@app/utils/failureReporter', () => ({captureRendererFailure: failureReporter.capture}));

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;
    public static instances: FakeWorker[] = [];
    public static responder: ((worker: FakeWorker, request: {
        id: number;
        type: string;
        payload: Record<string, unknown>;
    }) => void) | null = null;

    public readonly postMessageCalls: unknown[] = [];

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();

    private readonly errorHandlers = new Set<(event: ErrorEvent) => void>();

    public constructor(
        _scriptUrl: string | URL,
        _options?: WorkerOptions,
    ) {
        FakeWorker.lastInstance = this;
        FakeWorker.instances.push(this);
    }

    public addEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.add(handler as (event: MessageEvent) => void);
        }
        if (type === 'error') {
            this.errorHandlers.add(handler);
        }
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.delete(handler as (event: MessageEvent) => void);
        }
        if (type === 'error') {
            this.errorHandlers.delete(handler);
        }
    }

    public postMessage(message: unknown) {
        this.postMessageCalls.push(message);
        const request = message as {
            id: number;
            type: string;
            payload: Record<string, unknown>;
        };

        if (FakeWorker.responder) {
            FakeWorker.responder(this, request);
            return;
        }

        queueMicrotask(() => {
            this.dispatchMessage({
                id: request.id,
                type: request.type,
                ok: true,
                data: {
                    matches: [{
                        pageMatchIndex: 0,
                        startOffset: 0,
                        endOffset: 5,
                    }],
                    truncated: false,
                    matchCount: 1,
                    matchingMs: 0,
                },
            });
        });
    }

    public dispatchMessage(data: unknown) {
        const event = { data } as MessageEvent;
        this.messageHandlers.forEach((handler) => handler(event));
    }

    public dispatchError(error: Error) {
        const event = {
            error,
            message: error.message,
        } as ErrorEvent;
        this.errorHandlers.forEach((handler) => handler(event));
    }

    public dispatchEvent(_event: Event) {
        return false;
    }

    public terminate() {}
}

describe('browserSearchWorkerClient', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        FakeWorker.instances = [];
        FakeWorker.responder = null;
        failureReporter.capture.mockClear();
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        vi.stubGlobal('Worker', FakeWorker);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function pageMatchRequest(text: string, query = 'alpha') {
        return {
            text,
            query,
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            },
            maxMatches: 2,
        };
    }

    it('rejects a matching-id success response with invalid result data', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: {
                        matches: [{
                            pageMatchIndex: 0,
                            startOffset: 5,
                            endOffset: 5,
                        }],
                        truncated: false,
                        matchCount: 1,
                        matchingMs: 0,
                    },
                });
            });
        };
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('alpha')).promise)
            .rejects.toThrow('Browser search worker returned an invalid result');
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        FakeWorker.responder = () => {};
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const request = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('failing'));
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser search worker');
        }

        worker.dispatchError(new Error('search worker crashed'));
        const error = await request.promise.then(
            () => { throw new Error('Expected a worker failure'); },
            value => {
                if (!(value instanceof Error)) {
                    throw new Error('Expected a worker failure');
                }
                return value as Error & {failure?: unknown};
            },
        );

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'RENDERER_SEARCH_WORKER_FAILED',
            local: expect.objectContaining({source: 'browser-search-worker-parent'}),
        }));
        expect(error.failure).toBe(failureReceipt);
    });

    it('returns worker page matches and preserves the regex-limit error type', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                if (request.type === 'matchPageText' && request.payload.query === 'needle') {
                    worker.dispatchMessage({
                        id: request.id,
                        type: request.type,
                        ok: true,
                        data: {
                            matches: [{
                                pageMatchIndex: 0,
                                startOffset: 3,
                                endOffset: 9,
                            }],
                            truncated: false,
                            matchCount: 1,
                            matchingMs: 0,
                        },
                    });
                    return;
                }
                worker.dispatchMessage({
                    id: request.id,
                    ok: false,
                    error: 'Invalid search regex: pattern is too complex for document search',
                    errorCode: 'SEARCH_REGEX_LIMIT',
                });
            });
        };
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(createBrowserSearchWorkerRequest('matchPageText', {
            text: '😀 needle',
            query: 'needle',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: true,
            },
            maxMatches: 2,
        }).promise).resolves.toEqual({
            matches: [{
                pageMatchIndex: 0,
                startOffset: 3,
                endOffset: 9,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        });

        const failedRequest = createBrowserSearchWorkerRequest('matchPageText', {
            text: 'aaaa',
            query: '(a+)+$',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: true,
            },
            maxMatches: 2,
        }).promise;
        await expect(failedRequest).rejects.toMatchObject({
            name: 'SearchRegexLimitError',
            code: 'SEARCH_REGEX_LIMIT',
        });
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('bounds a match from its start signal without losing another document hits', async () => {
        vi.useFakeTimers();
        FakeWorker.responder = () => {};
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const matchRequest = createBrowserSearchWorkerRequest('matchPageText', {
            text: 'a'.repeat(80_000),
            query: '(a|aa)+b',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: true,
            },
            maxMatches: 2,
        }, {matchTimeoutMs: 25});
        const matchWorker = FakeWorker.lastInstance!;
        const siblingRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('sibling'));
        const siblingWorker = FakeWorker.lastInstance!;
        let matchSettled = false;
        void matchRequest.promise.catch(() => undefined).finally(() => {
            matchSettled = true;
        });

        // A cold worker has not started matching yet, so its start-up is not
        // counted against the match bound.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(matchSettled).toBe(false);
        expect(terminateSpy).not.toHaveBeenCalled();

        matchWorker.dispatchMessage({
            id: matchRequest.requestId,
            started: true,
        });
        const matchFailure = expect(matchRequest.promise)
            .rejects.toMatchObject({name: 'BrowserSearchWorkerTimeoutError'});
        const siblingResult = {
            matches: [{
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 7,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        };
        await vi.advanceTimersByTimeAsync(25);

        await matchFailure;
        siblingWorker.dispatchMessage({
            id: siblingRequest.requestId,
            type: 'matchPageText',
            ok: true,
            data: siblingResult,
        });
        await expect(siblingRequest.promise).resolves.toEqual(siblingResult);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('rejects a cancelled job and stops its engine before releasing admission', async () => {
        FakeWorker.responder = () => {};
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('pending'));
        const rejection = expect(workerRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        cancelBrowserSearchWorkerRequest(workerRequest.requestId);
        await rejection;
        expect(failureReporter.capture).not.toHaveBeenCalled();
        expect(FakeWorker.lastInstance?.postMessageCalls).toHaveLength(1);
        expect(terminateSpy).toHaveBeenCalledOnce();
    });

    it('ignores a late result from a canceled request before resolving its replacement', async () => {
        FakeWorker.responder = () => {};
        const {
            cancelBrowserSearchWorkerRequest,
            createBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const staleRequest = createBrowserSearchWorkerRequest('matchPageText', {
            text: 'stale',
            query: 'stale',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            },
            maxMatches: 2,
        });
        const staleFailure = expect(staleRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        cancelBrowserSearchWorkerRequest(staleRequest.requestId);
        await staleFailure;

        const replacementRequest = createBrowserSearchWorkerRequest('matchPageText', {
            text: 'replacement',
            query: 'replacement',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: false,
            },
            maxMatches: 2,
        });
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser search worker');
        }
        worker.dispatchMessage({
            id: staleRequest.requestId,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [{
                    pageMatchIndex: 0,
                    startOffset: 0,
                    endOffset: 5,
                }],
                truncated: false,
                matchCount: 1,
                matchingMs: 0,
            },
        });
        worker.dispatchMessage({
            id: replacementRequest.requestId,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [{
                    pageMatchIndex: 0,
                    startOffset: 0,
                    endOffset: 11,
                }],
                truncated: false,
                matchCount: 1,
                matchingMs: 0,
            },
        });

        await expect(replacementRequest.promise).resolves.toEqual({
            matches: [{
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 11,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        });
    });

    it('keeps other in-flight jobs alive when canceling one request', async () => {
        FakeWorker.responder = () => {};
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const canceledRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('canceled'));
        const otherRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('other'));
        const canceledRejection = expect(canceledRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        cancelBrowserSearchWorkerRequest(canceledRequest.requestId);

        await canceledRejection;
        FakeWorker.lastInstance?.dispatchMessage({
            id: otherRequest.requestId,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [],
                truncated: false,
                matchCount: 0,
                matchingMs: 0,
            },
        });
        await expect(otherRequest.promise).resolves.toEqual({
            matches: [],
            truncated: false,
            matchCount: 0,
            matchingMs: 0,
        });
    });

    it('returns known hits after another document terminates its running regex', async () => {
        FakeWorker.responder = () => {};
        const {
            createBrowserSearchWorkerRequest, cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const first = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('first'));
        const firstOutcome = first.promise.catch(error => error as Error);
        const second = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('other'));
        const secondOutcome = second.promise.catch(error => error as Error);
        const worker = FakeWorker.lastInstance!;
        cancelBrowserSearchWorkerRequest(first.requestId);
        const data = {
            matches: [{
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        };
        worker.dispatchMessage({
            id: second.requestId,
            type: 'matchPageText',
            ok: true,
            data,
        });
        expect(await firstOutcome).toMatchObject({message: 'ERR_BROWSER_SEARCH_CANCELED'});
        expect(await secondOutcome).toEqual(data);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('rejects a failed concurrent submission without losing the other search', async () => {
        let firstWorker: FakeWorker | undefined;
        FakeWorker.responder = worker => {
            if (!firstWorker) firstWorker = worker;
            else throw new Error('Second search could not be posted');
        };
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const first = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('first'));
        const second = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('other'));
        await expect(second.promise).rejects.toThrow('Second search could not be posted');
        const data = {
            matches: [{
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        };
        firstWorker!.dispatchMessage({
            id: first.requestId,
            type: 'matchPageText',
            ok: true,
            data,
        });
        await expect(first.promise).resolves.toEqual(data);
    });

    it('does not create a worker when canceling an unknown request', async () => {
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {cancelBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        cancelBrowserSearchWorkerRequest(12345);

        expect(FakeWorker.lastInstance).toBeNull();
        expect(terminateSpy).not.toHaveBeenCalled();
    });

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('alpha')).promise;
        vi.runAllTicks();
        const terminateCallsBeforeIdleTtl = terminateSpy.mock.calls.length;

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(terminateCallsBeforeIdleTtl + 1);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });
    it('bounds 48 independent searches and still returns every known hit', async () => {
        vi.useFakeTimers();
        FakeWorker.responder = () => {};
        const terminate = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const requests = Array.from({length: 48}, (_, index) => createBrowserSearchWorkerRequest(
            'matchPageText', pageMatchRequest(`document-${index}`),
        ));
        const peak = FakeWorker.instances.length;
        const data = {
            matches: [{
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            }],
            truncated: false,
            matchCount: 1,
            matchingMs: 0,
        };
        for (const request of requests) {
            for (const worker of FakeWorker.instances) {
                worker.dispatchMessage({
                    id: request.requestId,
                    type: 'matchPageText',
                    ok: true,
                    data,
                });
            }
            await request.promise;
        }
        expect((await Promise.all(requests.map(request => request.promise))).every(result => result.matchCount === 1)).toBe(true);
        expect(peak).toBeLessThanOrEqual(2);
        const reused = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('reused'));
        for (const worker of FakeWorker.instances) {
            worker.dispatchMessage({
                id: reused.requestId,
                type: 'matchPageText',
                ok: true,
                data,
            });
        }
        await reused.promise;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminate.mock.calls.length).toBe(FakeWorker.instances.length);
    });

    it('cancels a queued search before it reaches a worker and keeps admitted hits', async () => {
        FakeWorker.responder = () => {};
        const {
            createBrowserSearchWorkerRequest, cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const admitted = [
            createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('first')),
            createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('second')),
        ];
        const queued = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('queued'));
        const rejected = expect(queued.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        cancelBrowserSearchWorkerRequest(queued.requestId);
        await rejected;
        const data = {
            matches: [],
            truncated: false,
            matchCount: 0,
            matchingMs: 0,
        };
        for (const request of admitted) {
            for (const worker of FakeWorker.instances) {
                worker.dispatchMessage({
                    id: request.requestId,
                    type: 'matchPageText',
                    ok: true,
                    data,
                });
            }
        }
        await Promise.all(admitted.map(request => request.promise));
        expect(FakeWorker.instances).toHaveLength(2);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('rejects admitted and waiting requests on a page reset and admits a later search', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        FakeWorker.responder = () => {};
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const requests = Array.from({length: 4}, () => createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('waiting')));
        const outcomes = requests.map(request => request.promise.catch(error => error));
        target.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false}));
        for (const outcome of outcomes) {
            expect(await outcome).toMatchObject({
                name: 'AbortError',
                code: 'BROWSER_WORKER_RESET',
            });
        }
        expect(FakeWorker.instances).toHaveLength(2);
        const later = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('later'));
        FakeWorker.lastInstance?.dispatchMessage({
            id: later.requestId,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [],
                truncated: false,
                matchCount: 0,
                matchingMs: 0,
            },
        });
        await expect(later.promise).resolves.toMatchObject({matchCount: 0});
    });

    it('uses one admission on a two-core browser without losing a waiting result', async () => {
        vi.stubGlobal('navigator', {hardwareConcurrency: 2});
        FakeWorker.responder = () => {};
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const first = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('first'));
        const second = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('second'));
        expect(FakeWorker.instances).toHaveLength(1);
        const data = {
            matches: [],
            truncated: false,
            matchCount: 0,
            matchingMs: 0,
        };
        for (const request of [
            first,
            second,
        ]) {
            FakeWorker.lastInstance?.dispatchMessage({
                id: request.requestId,
                type: 'matchPageText',
                ok: true,
                data,
            });
            await expect(request.promise).resolves.toEqual(data);
        }
        expect(FakeWorker.instances).toHaveLength(1);
    });

    describe('DjVu regex search through the search worker', () => {
        const createDjvuWorker = vi.fn();

        // Each test's fresh module graph binds the DjVu adapter to that test's search client.
        beforeEach(() => {
            vi.doMock('@app/platform/browser-api/createDjvuWorkerFromPath', async importOriginal => ({
                ...await importOriginal<typeof TDjvuWorkerModule>(),
                createDjvuWorkerFromPath: createDjvuWorker,
            }));
        });

        afterEach(() => {
            vi.doUnmock('@app/platform/browser-api/createDjvuWorkerFromPath');
        });

        interface IPageMatchRequestForTest {
            id: number;
            type: string;
            payload: {
                text: string;
                query: string;
                options: IResolvedSearchMatchOptions;
                maxMatches: number;
                resultOffset?: TSearchResultOffset;
            };
        }

        // A catastrophic expression runs after the worker reports its start, and never returns.
        function respondStarted(worker: FakeWorker, request: {id: number}) {
            queueMicrotask(() => worker.dispatchMessage({
                id: request.id,
                started: true,
            }));
        }

        function respondWithMatches(worker: FakeWorker, request: {id: number}) {
            const {
                id, type, payload,
            } = request as IPageMatchRequestForTest;
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id,
                    started: true,
                });
                worker.dispatchMessage({
                    id,
                    type,
                    ok: true,
                    data: {
                        ...matchPdfSearchPageWindow(payload.text, payload.query, payload.options, payload.maxMatches, payload.resultOffset),
                        matchingMs: 0,
                    },
                });
            });
        }

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

        function regexSearchOptions(requestId: string) {
            return {
                requestId: requireRequestId(requestId),
                pageCount: 1,
                matchCase: false,
                wholeWord: false,
                useRegex: true,
            };
        }

        const postedRequests = () => FakeWorker.instances.flatMap(worker => worker.postMessageCalls);

        it('stops a catastrophic DjVu regex with the search budget error', async () => {
            FakeWorker.responder = respondStarted;
            createDjvuWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['a'.repeat(250_000) + '!']));
            const {browserDjvuTextSearchCapability} = await import('@app/platform/browser-api/browserDjvuTextSearchCapability');
            const startedAt = performance.now();

            await expect(browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/catastrophic.djvu'),
                'a+$',
                regexSearchOptions('catastrophic-djvu-regex'),
            )).rejects.toMatchObject({
                name: 'SearchRegexLimitError',
                code: 'SEARCH_REGEX_LIMIT',
            });
            expect(performance.now() - startedAt).toBeLessThan(5_000);
            expect(postedRequests()).toHaveLength(1);
        });

        it.each([
            500,
            'last',
        ] as const)('returns the DjVu regex window at %s from the search worker', async (resultOffset) => {
            FakeWorker.responder = respondWithMatches;
            createDjvuWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['valve '.repeat(561)]));
            const {browserDjvuTextSearchCapability} = await import('@app/platform/browser-api/browserDjvuTextSearchCapability');

            const response = await browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/dense-regex.djvu'),
                'valve',
                {
                    ...regexSearchOptions('regex-window'),
                    resultOffset,
                },
            );

            expect(response.results).toHaveLength(resultOffset === 500 ? 61 : 500);
            expect(response.results[0]?.matchIndex).toBe(resultOffset === 500 ? 500 : 61);
            expect(response.results.at(-1)?.matchIndex).toBe(560);
            expect(response.truncated).toBe(false);
            expect(postedRequests()).toHaveLength(1);
        });

        it('keeps another document searching when a DjVu regex is canceled', async () => {
            const pending: Array<{
                worker: FakeWorker;
                request: IPageMatchRequestForTest;
            }> = [];
            FakeWorker.responder = (worker, request) => pending.push({
                worker,
                request: request as IPageMatchRequestForTest,
            });
            createDjvuWorker.mockImplementation(async (source: TDocumentRef) => createDjvuTextWorkerForTest([source.includes('first') ? 'a'.repeat(250_000) + '!' : 'hello']));
            const {browserDjvuTextSearchCapability} = await import('@app/platform/browser-api/browserDjvuTextSearchCapability');
            const first = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/first.djvu'),
                'a+.a+$',
                regexSearchOptions('isolated-first-regex'),
            ).catch((error: unknown) => error);
            const second = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/second.djvu'),
                'hello',
                regexSearchOptions('isolated-second-regex'),
            );
            await vi.waitFor(() => expect(pending).toHaveLength(2));

            await browserDjvuTextSearchCapability.cancelTextSearch(requireRequestId('isolated-first-regex'));
            expect(await first).toMatchObject({name: 'AbortError'});
            const sibling = pending.find(entry => entry.request.payload.query === 'hello')!;
            respondWithMatches(sibling.worker, sibling.request);
            const response = await second;
            expect(response.results.map(result => result.excerpt.match)).toEqual(['hello']);
            expect(response.truncated).toBe(false);
        });

        it('cancels a stalled DjVu regex worker when its search is canceled', async () => {
            FakeWorker.responder = respondStarted;
            const terminate = vi.spyOn(FakeWorker.prototype, 'terminate');
            createDjvuWorker.mockImplementation(async () => createDjvuTextWorkerForTest(['a'.repeat(250_000) + '!']));
            const {browserDjvuTextSearchCapability} = await import('@app/platform/browser-api/browserDjvuTextSearchCapability');
            const requestId = requireRequestId('canceled-djvu-regex');
            const search = browserDjvuTextSearchCapability.searchText(
                requireDocumentRef('browser://documents/canceled-regex.djvu'),
                'a+$',
                regexSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(postedRequests()).toHaveLength(1));

            const startedAt = performance.now();
            await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
                .resolves.toEqual({canceled: true});

            await expect(search).rejects.toMatchObject({name: 'AbortError'});
            expect(performance.now() - startedAt).toBeLessThan(1_000);
            expect(terminate).toHaveBeenCalledOnce();
        });
    });
});
