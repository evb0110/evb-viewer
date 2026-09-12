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

vi.mock('@app/utils/failureReporter', () => ({
    detectRendererDiagnosticsHost: () => 'hosted-browser',
    getRendererFailureReporter: () => failureReporter,
    initializeRendererFailureReporter: () => failureReporter,
}));

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
            if (request.type === 'cancel') {
                this.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: { canceled: true },
                });
                return;
            }

            this.dispatchMessage({
                id: request.id,
                type: request.type,
                ok: true,
                progress: {
                    processed: 1,
                    total: 2,
                },
            });
            this.dispatchMessage({
                id: request.id,
                type: request.type,
                ok: true,
                data: {
                    pageCount: 2,
                    pageTexts: [
                        'alpha',
                        'beta',
                    ],
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

    it('returns extracted page text and forwards progress updates', async () => {
        const onProgress = vi.fn();
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/test.pdf' },
            { onProgress },
        );
        const result = await workerRequest.promise;

        expect(workerRequest.requestId).toBeGreaterThan(0);
        expect(result).toEqual({
            pageCount: 2,
            pageTexts: [
                'alpha',
                'beta',
            ],
        });
        expect(onProgress).toHaveBeenCalledWith({
            processed: 1,
            total: 2,
        });
    });

    it('accepts the legacy array response at the 1,024-page boundary', async () => {
        const pageTexts = new Array<string>(1_024).fill('alpha');
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: {
                        pageCount: 1_024,
                        pageTexts,
                    },
                });
            });
        };
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const result = await runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/1024.pdf'});

        expect(result.pageCount).toBe(1_024);
        expect(result.pageTexts).toHaveLength(1_024);
        expect(result.pageTexts[1_023]).toBe('alpha');
    });

    it('rejects the legacy array response at 1,025 pages before copying it', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: {
                        pageCount: 1_025,
                        pageTexts: ['alpha'],
                    },
                });
            });
        };
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/1025.pdf'}))
            .rejects.toThrow('Browser search worker returned an invalid result');
    });

    it('backpressures streamed worker pages and acknowledges only consumed records', async () => {
        FakeWorker.responder = () => {};
        const {createBrowserSearchWorkerPageStreamRequest} =
            await import('@app/platform/browser-api/browserSearchWorkerClient');
        const streamRequest = createBrowserSearchWorkerPageStreamRequest({pdfPath: '/tmp/stream.pdf'});
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser search worker');
        }
        const iterator = streamRequest.pages[Symbol.asyncIterator]();

        worker.dispatchMessage({
            id: streamRequest.requestId,
            type: 'streamDocumentText',
            ok: true,
            page: {
                pageNumber: 1,
                pageCount: 2,
                text: 'alpha',
            },
        });
        expect(worker.postMessageCalls).toHaveLength(1);

        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: {
                pageNumber: 1,
                pageCount: 2,
                text: 'alpha',
            },
        });
        expect(worker.postMessageCalls).toHaveLength(2);
        expect(worker.postMessageCalls[1]).toMatchObject({
            type: 'acknowledgePage',
            payload: {requestId: streamRequest.requestId},
        });

        worker.dispatchMessage({
            id: streamRequest.requestId,
            type: 'streamDocumentText',
            ok: true,
            page: {
                pageNumber: 2,
                pageCount: 2,
                text: 'beta',
            },
        });
        expect(worker.postMessageCalls).toHaveLength(2);

        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: {
                pageNumber: 2,
                pageCount: 2,
                text: 'beta',
            },
        });
        expect(worker.postMessageCalls).toHaveLength(3);
        expect(worker.postMessageCalls[2]).toMatchObject({
            type: 'acknowledgePage',
            payload: {requestId: streamRequest.requestId},
        });

        worker.dispatchMessage({
            id: streamRequest.requestId,
            type: 'streamDocumentText',
            ok: true,
            data: {pageCount: 2},
        });
        await expect(streamRequest.promise).resolves.toEqual({pageCount: 2});
        await expect(iterator.next()).resolves.toEqual({
            done: true,
            value: undefined,
        });
    });

    it('cancels a pending page stream without buffering later pages', async () => {
        FakeWorker.responder = () => {};
        const {
            cancelBrowserSearchWorkerRequest,
            createBrowserSearchWorkerPageStreamRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const streamRequest = createBrowserSearchWorkerPageStreamRequest({pdfPath: '/tmp/canceled-stream.pdf'});
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser search worker');
        }
        const nextPage = streamRequest.pages[Symbol.asyncIterator]().next();
        const streamFailure = expect(streamRequest.promise)
            .rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        cancelBrowserSearchWorkerRequest(streamRequest.requestId);

        await expect(nextPage).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        await streamFailure;
        expect(worker.postMessageCalls).toHaveLength(2);
        expect(worker.postMessageCalls[1]).toMatchObject({
            type: 'cancel',
            payload: {requestId: streamRequest.requestId},
        });
    });

    it('rejects a matching-id success response with invalid result data', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: {
                        pageCount: 1,
                        pageTexts: [123],
                    },
                });
            });
        };
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/test.pdf'}))
            .rejects.toThrow('Browser search worker returned an invalid result');
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        FakeWorker.responder = () => {};
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');
        const request = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            {pdfPath: '/tmp/failing.pdf'},
        );
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
            context: {},
            local: expect.objectContaining({source: 'browser-search-worker-parent'}),
        }), {runtime: 'browser-worker-parent'});
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('rejects a million-page legacy array response before copying it', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: {
                        pageCount: 1_000_000,
                        pageTexts: [],
                    },
                });
            });
        };
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/million.pdf'}))
            .rejects.toThrow('Browser search worker returned an invalid result');
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
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await expect(runBrowserSearchWorkerRequest('matchPageText', {
            text: '😀 needle',
            query: 'needle',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: true,
            },
            maxMatches: 2,
        })).resolves.toEqual({
            matches: [{
                startOffset: 3,
                endOffset: 9,
            }],
            truncated: false,
        });

        const failedRequest = runBrowserSearchWorkerRequest('matchPageText', {
            text: 'aaaa',
            query: '(a+)+$',
            options: {
                matchCase: true,
                wholeWord: false,
                useRegex: true,
            },
            maxMatches: 2,
        });
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
        const siblingRequest = createBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/sibling.pdf'});

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

    it('rejects the active job and sends a request-scoped worker cancel', async () => {
        FakeWorker.responder = () => {};
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/pending.pdf' },
        );
        const rejection = expect(workerRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        const terminateCallsBeforeCancel = terminateSpy.mock.calls.length;

        cancelBrowserSearchWorkerRequest(workerRequest.requestId);
        await rejection;
        expect(failureReporter.capture).not.toHaveBeenCalled();

        const postMessages = FakeWorker.lastInstance?.postMessageCalls ?? [];
        expect(postMessages).toHaveLength(2);
        expect(postMessages[1]).toMatchObject({
            type: 'cancel',
            payload: {requestId: workerRequest.requestId},
        });
        expect(terminateSpy).toHaveBeenCalledTimes(terminateCallsBeforeCancel);
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

        const canceledRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/canceled.pdf' },
        );
        const otherRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/other.pdf' },
        );
        const canceledRejection = expect(canceledRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');
        const terminateCallsBeforeCancel = terminateSpy.mock.calls.length;

        cancelBrowserSearchWorkerRequest(canceledRequest.requestId);

        await canceledRejection;
        FakeWorker.lastInstance?.dispatchMessage({
            id: otherRequest.requestId,
            type: 'extractDocumentText',
            ok: true,
            data: {
                pageCount: 1,
                pageTexts: ['other'],
            },
        });
        await expect(otherRequest.promise).resolves.toEqual({
            pageCount: 1,
            pageTexts: ['other'],
        });

        const postMessages = FakeWorker.lastInstance?.postMessageCalls ?? [];
        expect(postMessages).toHaveLength(3);
        expect(postMessages[2]).toMatchObject({
            type: 'cancel',
            payload: {requestId: canceledRequest.requestId},
        });
        expect(terminateSpy).toHaveBeenCalledTimes(terminateCallsBeforeCancel);
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
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/test.pdf'});
        vi.runAllTicks();
        const terminateCallsBeforeIdleTtl = terminateSpy.mock.calls.length;

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(terminateCallsBeforeIdleTtl + 1);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });
});
