import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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
                        startOffset: 0,
                        endOffset: 5,
                    }],
                    truncated: false,
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
        FakeWorker.responder = null;
        failureReporter.capture.mockClear();
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
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
                            startOffset: 5,
                            endOffset: 5,
                        }],
                        truncated: false,
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
                                startOffset: 3,
                                endOffset: 9,
                            }],
                            truncated: false,
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
                startOffset: 3,
                endOffset: 9,
            }],
            truncated: false,
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

    it('terminates the shared worker when a bounded match request times out', async () => {
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
        }, {
            timeoutMs: 25,
            resetWorkerOnTimeout: true,
        });
        const siblingRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('sibling'));

        const matchFailure = expect(matchRequest.promise)
            .rejects.toMatchObject({name: 'BrowserSearchWorkerTimeoutError'});
        const siblingFailure = expect(siblingRequest.promise)
            .rejects.toMatchObject({name: 'BrowserSearchWorkerTimeoutError'});
        await vi.advanceTimersByTimeAsync(25);

        await matchFailure;
        await siblingFailure;
        expect(terminateSpy).toHaveBeenCalledOnce();
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('rejects a cancelled job and keeps the worker without messaging it', async () => {
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
        expect(terminateSpy).not.toHaveBeenCalled();
    });

    it('terminates the worker when a cancel asks to reset it', async () => {
        FakeWorker.responder = () => {};
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest('matchPageText', pageMatchRequest('long regex'));
        const rejection = expect(workerRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        cancelBrowserSearchWorkerRequest(workerRequest.requestId, {resetWorker: true});
        await rejection;
        expect(terminateSpy).toHaveBeenCalledOnce();
        expect(failureReporter.capture).not.toHaveBeenCalled();
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
                    startOffset: 0,
                    endOffset: 5,
                }],
                truncated: false,
            },
        });
        worker.dispatchMessage({
            id: replacementRequest.requestId,
            type: 'matchPageText',
            ok: true,
            data: {
                matches: [{
                    startOffset: 0,
                    endOffset: 11,
                }],
                truncated: false,
            },
        });

        await expect(replacementRequest.promise).resolves.toEqual({
            matches: [{
                startOffset: 0,
                endOffset: 11,
            }],
            truncated: false,
        });
    });

    it('keeps other in-flight jobs alive when canceling one shared-worker request', async () => {
        FakeWorker.responder = () => {};
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
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
            },
        });
        await expect(otherRequest.promise).resolves.toEqual({
            matches: [],
            truncated: false,
        });
        expect(terminateSpy).not.toHaveBeenCalled();
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
});
